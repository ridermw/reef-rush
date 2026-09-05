import { z } from 'zod';
import {
  parseCourseDefinition,
  vector3Schema,
  type CourseDefinition,
  type Vector3,
} from '../course/courseDefinition';
import { assertDeltaTime } from '../obstacles/Obstacle';
import { dyadic, exactIntegers, type ExactFraction } from './exactArithmetic';
import { medalSchema } from './medals';
import {
  checkpointFraction,
  movementSegment,
  pickupIntersection,
} from './raceGeometry';
import {
  compareIntersections,
  scaleIntersection,
  type RaceIntersection,
} from './raceIntersection';
import type {
  FinishedRaceResult,
  RaceEvent,
  RaceState,
  RaceStep,
} from './raceTypes';

const optionsSchema = z.strictObject({
  playerRadius: z.number().finite().nonnegative().default(0.35),
});

// Full dt*1000 and half-input-ULP*1000 are integers in 2^-1074 ms units.
// A fixed dyadic denominator bounds clock growth to the exponent range + log(steps).
const millisecondDenominator = 1n << 1074n;

export class RaceSession {
  private readonly course: CourseDefinition;
  private readonly playerRadius: number;
  private state: RaceState;
  private collectedPearls = new Set<string>();
  private elapsedUnitsMs = 0n;
  private inputUncertaintyUnitsMs = 0n;

  constructor(course: unknown, options: unknown = {}) {
    this.course = parseCourseDefinition(course);
    this.playerRadius = optionsSchema.parse(options).playerRadius;
    this.state = Object.freeze({
      status: 'ready',
      courseId: this.course.courseId,
      elapsedMs: 0,
      checkpointIndex: 0,
      checkpointCount: this.course.checkpoints.length,
      pearlCount: 0,
      totalPearls: this.course.pearls?.length ?? 0,
      result: null,
    });
  }

  getState(): RaceState {
    return this.state;
  }

  start(): RaceState {
    return this.transition('ready', 'running');
  }

  pause(): RaceState {
    return this.transition('running', 'paused');
  }

  resume(): RaceState {
    return this.transition('paused', 'running');
  }

  step(from: Vector3, to: Vector3, dtSeconds: number): RaceStep {
    assertDeltaTime(dtSeconds);
    const start = vector3Schema.parse(from);
    const end = vector3Schema.parse(to);
    if (this.state.status === 'ready') {
      throw new Error('Cannot step a ready race; call start first.');
    }
    if (this.state.status === 'running' && dtSeconds > 0) {
      return this.advance(start, end, dtSeconds);
    }
    return Object.freeze({
      state: this.state,
      events: Object.freeze([]),
    });
  }

  getCollectedPearlIds(): readonly string[] {
    return Object.freeze([...this.collectedPearls]);
  }

  private advance(from: Vector3, to: Vector3, dtSeconds: number): RaceStep {
    const segment = movementSegment(from, to);
    const intersections: {
      crossing: RaceIntersection;
      event: RaceEvent;
    }[] = [];
    let checkpointIndex = this.state.checkpointIndex;
    let previousCrossing: ExactFraction | undefined;
    const duration = dyadic(dtSeconds);
    const shift = BigInt(duration.exponent + 1074);
    const durationUnitsMs = (duration.significand * 1000n) << shift;
    const inputUncertaintyUnitsMs = 500n << shift;
    const elapsedBase: ExactFraction = {
      numerator: this.elapsedUnitsMs,
      denominator: millisecondDenominator,
    };
    const timeAt = (
      crossing: RaceIntersection,
      maximumElapsedMs = Infinity,
    ) => {
      // Geometry proves contact before finish; cap only its display timestamp.
      const elapsedMs = Math.min(
        scaleIntersection(crossing, dtSeconds, 1000, elapsedBase),
        maximumElapsedMs,
      );
      if (!Number.isFinite(elapsedMs)) {
        throw new RangeError('Race elapsed time overflow.');
      }
      return elapsedMs;
    };

    while (checkpointIndex < this.course.checkpoints.length) {
      const checkpoint = this.course.checkpoints[checkpointIndex];
      const crossing = checkpointFraction(segment, checkpoint);
      if (
        crossing === null ||
        (previousCrossing &&
          compareIntersections(crossing, previousCrossing) < 0)
      ) {
        break;
      }
      intersections.push({
        crossing,
        event: {
          type: 'checkpoint',
          checkpointId: checkpoint.id,
          checkpointIndex,
          fraction: scaleIntersection(crossing, 1),
          elapsedMs: timeAt(crossing),
        },
      });
      previousCrossing = crossing;
      checkpointIndex++;
    }

    const finished = checkpointIndex === this.course.checkpoints.length;
    const endCrossing =
      finished && previousCrossing
        ? previousCrossing
        : { numerator: 1n, denominator: 1n };
    const endFraction = scaleIntersection(endCrossing, 1);
    const elapsedMs = timeAt(endCrossing);
    for (const pearl of this.course.pearls ?? []) {
      if (this.collectedPearls.has(pearl.id)) continue;
      const contact = pickupIntersection(
        segment,
        pearl.position,
        pearl.radius + this.playerRadius,
        finished ? previousCrossing : undefined,
      );
      if (contact !== null) {
        // Geometry has already proved contact before the finish plane. Keep
        // independently rounded display fractions in chronological order.
        const fraction = Math.min(scaleIntersection(contact, 1), endFraction);
        intersections.push({
          crossing: contact,
          event: {
            type: 'pearl',
            pearlId: pearl.id,
            fraction,
            elapsedMs: timeAt(contact, elapsedMs),
          },
        });
      }
    }
    // Stable sorting preserves route order and authored pearl order on ties.
    intersections.sort((a, b) => compareIntersections(a.crossing, b.crossing));
    const events = intersections.map(({ event }) => event);
    const collected = new Set(this.collectedPearls);
    for (const event of events) {
      if (event.type === 'pearl') collected.add(event.pearlId);
    }
    let result: FinishedRaceResult | null = null;
    if (finished) {
      // Only input-duration quantization widens the inclusive boundary.
      // Compare its exact lower endpoint, never the rounded public timestamp.
      const earliestFinishMs: ExactFraction = {
        numerator:
          (this.elapsedUnitsMs - this.inputUncertaintyUnitsMs) *
            endCrossing.denominator +
          (durationUnitsMs - inputUncertaintyUnitsMs) * endCrossing.numerator,
        denominator: millisecondDenominator * endCrossing.denominator,
      };
      const medal =
        medalSchema.options.find((candidate) => {
          const [threshold] = exactIntegers([
            this.course.medalTimesMs[candidate],
            Number.MIN_VALUE,
          ]);
          return (
            compareIntersections(earliestFinishMs, {
              numerator: threshold,
              denominator: millisecondDenominator,
            }) <= 0
          );
        }) ?? null;
      result = Object.freeze({
        courseId: this.course.courseId,
        elapsedMs,
        medal,
        pearlCount: collected.size,
        totalPearls: this.state.totalPearls,
      });
    }
    if (result) {
      events.push({ type: 'finish', fraction: endFraction, elapsedMs, result });
    }
    const state: RaceState = Object.freeze({
      ...this.state,
      status: finished ? 'finished' : 'running',
      checkpointIndex,
      elapsedMs,
      pearlCount: collected.size,
      result,
    });
    const step = Object.freeze({
      state,
      events: Object.freeze(events.map((event) => Object.freeze(event))),
    });
    // Commit only after every geometry, timing and result calculation succeeds.
    // A finish is terminal; only full active steps extend the dyadic clock.
    if (!finished) {
      this.elapsedUnitsMs += durationUnitsMs;
      this.inputUncertaintyUnitsMs += inputUncertaintyUnitsMs;
    }
    this.collectedPearls = collected;
    this.state = state;
    return step;
  }

  private transition(
    from: RaceState['status'],
    to: RaceState['status'],
  ): RaceState {
    if (this.state.status !== from) {
      throw new Error(
        `Cannot transition race from ${this.state.status} to ${to}.`,
      );
    }
    this.state = Object.freeze({ ...this.state, status: to });
    return this.state;
  }
}
