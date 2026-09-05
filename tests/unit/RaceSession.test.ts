import { describe, expect, it } from 'vitest';
import { RaceSession } from '../../src/game/race/RaceSession';
import { awardMedal } from '../../src/game/race/medals';
import type {
  CourseDefinition,
  Vector3,
} from '../../src/game/course/courseDefinition';
import { courseFixture } from '../fixtures/courseDefinition';

const origin: Vector3 = [0, -3, 0];
const beforeStart: Vector3 = [0, -3, 1];
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

function running() {
  const race = new RaceSession(courseFixture());
  race.start();
  return race;
}

function gate(id: string, z: number, direction: Vector3 = [0, 0, 1]) {
  return { id, position: [0, -3, z] as const, radius: 2, direction };
}

function pearl(id: string, z: number, radius = 0.3, x = 0) {
  return { id, position: [x, -3, z] as const, radius };
}

function configuredRace(
  changes: Partial<
    Pick<CourseDefinition, 'checkpoints' | 'pearls' | 'medalTimesMs'>
  >,
  playerRadius = 0,
) {
  const race = new RaceSession(
    { ...courseFixture(), ...changes },
    { playerRadius },
  );
  race.start();
  return race;
}

describe('exact elapsed intervals at medal boundaries', () => {
  const finish = {
    id: 'finish',
    position: [0, 0, 0] as const,
    direction: [1, 0, 0] as const,
    radius: 1,
  };

  it.each([
    { hz: 24, seconds: 30, split: false, medal: null },
    { hz: 75, seconds: 12, split: true, medal: 'silver' },
    { hz: 144, seconds: 12, split: false, medal: 'silver' },
    { hz: 144, seconds: 18, split: false, medal: 'bronze' },
  ])(
    'rejects nominal boundary coordinates outside the exact dt interval: $hz Hz, $seconds seconds, split $split',
    ({ hz, seconds, split, medal }) => {
      const race = running();
      const leadIn = 1 / (2 * hz);
      const movementSeconds = seconds - leadIn;
      race.step(origin, origin, leadIn);
      if (split) {
        for (let index = 0; index < seconds * hz; index++) {
          race.step(
            [0, -3, (20 * (index / hz)) / movementSeconds],
            [0, -3, (20 * ((index + 1) / hz)) / movementSeconds],
            1 / hz,
          );
        }
      } else {
        race.step(origin, [0, -3, (20 * seconds) / movementSeconds], seconds);
      }
      // Rounded coordinates move these finishes above the intended boundary
      // by more than the total half-input-dt-ULP uncertainty.
      expect(race.getState().status).toBe('finished');
      expect(race.getState().elapsedMs).toBeGreaterThan(seconds * 1000);
      expect(race.getState().result?.medal).toBe(medal);
    },
  );

  it.each(
    [1, 2, 4, 8, 16, 2 ** 52, 2 ** 1022].flatMap((scale) =>
      [3, 8].map((bronzeUnits) => ({ scale, bronzeUnits })),
    ),
  )(
    'rejects a slower exact interval despite subnormal budgets or rounded equality: scale $scale bronze $bronzeUnits units',
    ({ scale, bronzeUnits }) => {
      const unit = Number.MIN_VALUE * scale;
      const thresholds = {
        gold: unit,
        silver: 2 * unit,
        bronze: bronzeUnits * unit,
      };
      const race = configuredRace({
        checkpoints: [finish],
        pearls: [],
        medalTimesMs: thresholds,
      });
      const step = race.step([-0.1, 0, 0], [1e308, 0, 0], 4e-17 * scale);
      // Exact duration, even minus half the input dt ULP, is > 8.096 units.
      expect.soft(step.state.result?.medal).toBeNull();
      expect.soft(step.events.at(-1)).toMatchObject({
        type: 'finish',
        result: { medal: null },
      });
      expect(step.state.elapsedMs).toBeGreaterThanOrEqual(8 * unit);
      expect(step.state.elapsedMs).toBeLessThan(9 * unit);
      if (scale <= 4) {
        expect(step.state.elapsedMs).toBe(8 * unit);
        if (bronzeUnits === 8) {
          expect(awardMedal(step.state.elapsedMs, thresholds)).toBe('bronze');
        }
      }
      const finishedState = race.getState();
      expect(race.step([-0.1, 0, 0], [1e308, 0, 0], Number.MAX_VALUE)).toEqual({
        state: finishedState,
        events: [],
      });
      expect(race.getState()).toBe(finishedState);
    },
  );

  it.each([2 ** 64, 2 ** 1022])(
    'rejects equivalent representable endpoint durations at scale %s',
    (scale) => {
      const unit = Number.MIN_VALUE * scale;
      const changes = {
        checkpoints: [finish],
        pearls: [],
        medalTimesMs: { gold: unit, silver: 2 * unit, bronze: 8 * unit },
      };
      const seconds = 4e-17 * scale;
      const endpointSeconds = (seconds / 1e308) * 0.1;
      expect(endpointSeconds).toBeGreaterThan(0);
      const whole = configuredRace(changes).step(
        [-0.1, 0, 0],
        [1e308, 0, 0],
        seconds,
      );
      const endpoint = configuredRace(changes).step(
        [-0.1, 0, 0],
        [0, 0, 0],
        endpointSeconds,
      );
      expect.soft(whole.state.result?.medal).toBeNull();
      expect.soft(endpoint.state.result?.medal).toBeNull();
      expect(
        Math.abs(whole.state.elapsedMs / endpoint.state.elapsedMs - 1),
      ).toBeLessThanOrEqual(2 * Number.EPSILON);
    },
  );

  it.each(
    [
      { hz: 60, divisor: 4, expected: 20.833333333333332 },
      { hz: 90, divisor: 5, expected: 13.333333333333334 },
    ].flatMap((example) =>
      [false, true].map((finished) => ({ ...example, finished })),
    ),
  )(
    'rounds the exact active base plus rational event duration only once: $hz Hz divisor $divisor finished $finished',
    ({ hz, divisor, expected, finished }) => {
      const race = configuredRace({
        checkpoints: finished
          ? [finish]
          : [finish, { ...finish, id: 'later', position: [divisor, 0, 0] }],
        pearls: [{ id: 'tangent', position: [0, 1, 0], radius: 1 }],
      });
      race.step([-1, 0, 0], [-1, 0, 0], 1 / hz);
      const step = race.step([-1, 0, 0], [divisor - 1, 0, 0], 1 / hz);
      // (binary64(1/hz) * 1000) * (1 + 1/divisor), rounded after addition.
      for (const event of step.events) {
        expect.soft(event.elapsedMs).toBe(expected);
      }
      expect(step.events.map((event) => event.type)).toEqual(
        finished ? ['checkpoint', 'pearl', 'finish'] : ['checkpoint', 'pearl'],
      );
      if (finished) expect.soft(step.state.elapsedMs).toBe(expected);
    },
  );
});

describe('millisecond precision before the first duration rounding', () => {
  const cases = [
    {
      mode: 'subnormal dt',
      dt: Number.MIN_VALUE,
      from: [-1, 0, 0] as const,
      to: [3, 0, 0] as const,
      elapsedMs: Number.MIN_VALUE * 250,
      irrationalCenterX: 0,
      irrationalMs: Number.MIN_VALUE * 33,
    },
    {
      mode: 'normal dt with an under-resolved intersection',
      dt: 1e-15,
      from: [-0.1, 0, 0] as const,
      to: [1e308, 0, 0] as const,
      // The exact dyadic duration rounds to 202 subnormal millisecond units.
      elapsedMs: Number.MIN_VALUE * 202,
      irrationalCenterX: 0.8,
      irrationalMs: Number.MIN_VALUE * 69,
    },
  ];
  const finish = {
    id: 'finish',
    position: [0, 0, 0] as const,
    direction: [1, 0, 0] as const,
    radius: 1,
  };
  const medalTimesMs = { gold: 1e-322, silver: 2e-322, bronze: 4e-322 };

  it.each(
    cases.flatMap((example) =>
      [false, true].map((finished) => ({ ...example, finished })),
    ),
  )(
    'retains checkpoint and sphere event milliseconds: $mode, finished $finished',
    ({
      dt,
      from,
      to,
      elapsedMs,
      irrationalCenterX,
      irrationalMs,
      finished,
    }) => {
      const race = configuredRace({
        checkpoints: finished
          ? [finish]
          : [
              finish,
              {
                ...finish,
                id: 'return',
                position: [4, 0, 0],
                direction: [-1, 0, 0],
              },
            ],
        pearls: [
          { id: 'tangent', position: [0, 1, 0], radius: 1 },
          { id: 'axial', position: [1, 0, 0], radius: 1 },
          { id: 'rational', position: [4, 3, 0], radius: 5 },
          {
            id: 'irrational',
            position: [irrationalCenterX, 0.5, 0],
            radius: 1,
          },
        ],
        medalTimesMs,
      });
      if (!finished) {
        race.pause();
        expect(race.step(from, to, Number.MAX_VALUE).events).toEqual([]);
        race.resume();
      }
      const step = race.step(from, to, dt);
      const finishEvent = step.events.find(
        (event) =>
          event.type === 'checkpoint' && event.checkpointId === 'finish',
      );
      expect.soft(finishEvent?.elapsedMs).toBe(elapsedMs);
      for (const id of ['tangent', 'axial', 'rational', 'irrational']) {
        const event = step.events.find(
          (event) => event.type === 'pearl' && event.pearlId === id,
        );
        expect
          .soft(event?.elapsedMs)
          .toBe(id === 'irrational' ? irrationalMs : elapsedMs);
      }
      expect(step.state.pearlCount).toBe(4);
      if (finished) {
        expect.soft(step.state.elapsedMs).toBe(elapsedMs);
        expect.soft(step.events.at(-1)).toMatchObject({
          type: 'finish',
          elapsedMs,
        });
        expect.soft(step.state.result?.medal).toBeNull();
      } else {
        expect(step.state.status).toBe('running');
        expect(step.state.elapsedMs).toBe(dt * 1000);
      }
    },
  );

  it.each(cases)(
    'does not turn a clearly slower positive finish into zero/gold: $mode',
    ({ dt, from, to, elapsedMs }) => {
      const step = configuredRace({
        checkpoints: [finish],
        pearls: [],
        medalTimesMs,
      }).step(from, to, dt);
      expect.soft(step.state.result?.medal).toBeNull();
      expect.soft(step.state.elapsedMs).toBe(elapsedMs);
      expect.soft(step.state.elapsedMs).toBeGreaterThan(medalTimesMs.bronze);
    },
  );

  it('does not overflow the millisecond error bound for a finite maximum duration', () => {
    const step = configuredRace({
      checkpoints: [finish],
      pearls: [],
    }).step([-1, 0, 0], [999, 0, 0], Number.MAX_VALUE);
    expect(step.state.elapsedMs).toBe(Number.MAX_VALUE);
    expect(step.state.result?.medal).toBeNull();
  });
});

describe('intersection duration independent of display fractions', () => {
  const span = 1e308;
  const checkpoint = (id: string, x: number) => ({
    id,
    position: [x, 0, 0] as const,
    direction: [1, 0, 0] as const,
    radius: 1,
  });

  it.each([0.1, 1e-20])(
    'matches endpoint timing and medals when a %s second finish fraction loses precision',
    (seconds) => {
      const elapsedMs = seconds * 1000;
      const changes = {
        checkpoints: [checkpoint('finish', 0)],
        pearls: [],
        medalTimesMs: {
          gold: elapsedMs / 4,
          silver: elapsedMs / 2,
          bronze: elapsedMs,
        },
      };
      const whole = configuredRace(changes).step(
        [-seconds, 0, 0],
        [span, 0, 0],
        span,
      );
      const endpoint = configuredRace(changes).step(
        [-seconds, 0, 0],
        [0, 0, 0],
        seconds,
      );
      expect.soft(whole.state).toEqual(endpoint.state);
      expect.soft(whole.state.result?.medal).toBe('bronze');
      expect.soft(whole.state.elapsedMs).toBe(elapsedMs);
      for (const event of whole.events) {
        expect.soft(event.elapsedMs).toBe(elapsedMs);
        if (seconds === 0.1) {
          expect(event.fraction).toBeGreaterThan(0);
          expect(event.fraction).toBeLessThan(2 ** -1022);
        } else {
          expect(event.fraction).toBe(0);
        }
      }
    },
  );

  it.each([0.1, 1e-20])(
    'times nonfinal checkpoints before rounding a %s-scale fraction',
    (seconds) => {
      const changes = {
        checkpoints: [checkpoint('first', 0), checkpoint('finish', seconds)],
        pearls: [],
      };
      const whole = configuredRace(changes).step(
        [-seconds, 0, 0],
        [span, 0, 0],
        span,
      );
      const split = configuredRace(changes);
      const first = split.step([-seconds, 0, 0], [0, 0, 0], seconds);
      const last = split.step([0, 0, 0], [seconds, 0, 0], seconds);
      expect.soft(whole.events[0].elapsedMs).toBe(first.events[0].elapsedMs);
      expect.soft(whole.state).toEqual(last.state);
      expect
        .soft(whole.events.map((event) => event.elapsedMs))
        .toEqual([seconds * 1000, 2 * seconds * 1000, 2 * seconds * 1000]);
    },
  );

  it.each(
    [0.1, 1e-20].flatMap((scale) =>
      [false, true].flatMap((clipped) =>
        (['tangent', 'axial', 'rational', 'irrational'] as const).map(
          (kind) => ({
            scale,
            clipped,
            kind,
          }),
        ),
      ),
    ),
  )(
    'scales $kind pearl time before rounding: scale $scale clipped $clipped',
    ({ scale, clipped, kind }) => {
      const secondsPerUnit = clipped ? 1 : 1e-4;
      const start = -scale;
      const y = kind === 'irrational' ? scale : 0;
      const sphere =
        kind === 'rational'
          ? { position: [4, 3, 0] as const, radius: 5 }
          : kind === 'tangent'
            ? { position: [0, 1, 0] as const, radius: 1 }
            : { position: [1, 0, 0] as const, radius: 1 };
      const changes = {
        checkpoints: clipped
          ? [checkpoint('finish', scale)]
          : courseFixture().checkpoints,
        pearls: [{ id: 'contact', ...sphere }],
      };
      const whole = configuredRace(changes).step(
        [start, y, 0],
        [span, y, 0],
        clipped ? span : 1e304,
      );
      const endpoint = configuredRace(changes).step(
        [start, y, 0],
        [scale, y, 0],
        2 * scale * secondsPerUnit,
      );
      const expected =
        (kind === 'irrational'
          ? scale + (scale * scale) / (1 + Math.sqrt(1 - scale * scale))
          : scale) *
        secondsPerUnit *
        1000;
      const pickup = whole.events.find((event) => event.type === 'pearl');
      const endpointPickup = endpoint.events.find(
        (event) => event.type === 'pearl',
      );
      expect(pickup).toBeDefined();
      expect(endpointPickup).toBeDefined();
      expect
        .soft(Math.abs(pickup!.elapsedMs / expected - 1))
        .toBeLessThanOrEqual(4 * Number.EPSILON);
      expect
        .soft(Math.abs(pickup!.elapsedMs / endpointPickup!.elapsedMs - 1))
        .toBeLessThanOrEqual(4 * Number.EPSILON);
      expect(pickup!.fraction).toBeLessThan(2 ** -1022);
      if (scale === 1e-20) expect(pickup!.fraction).toBe(0);
      expect(whole.state.pearlCount).toBe(1);
    },
  );

  it.each(
    [1e-300, 1e308].flatMap((dt) =>
      (['tangent', 'irrational'] as const).map((kind) => ({ dt, kind })),
    ),
  )(
    'orders $kind contacts internally when display fractions tie at zero, dt $dt',
    ({ dt, kind }) => {
      const gap = 1e-20;
      const race = configuredRace({
        checkpoints: [checkpoint('middle', gap), checkpoint('finish', 4 * gap)],
        pearls: [2, 1].map((index) => ({
          id: index === 1 ? 'early' : 'late',
          position:
            kind === 'tangent'
              ? ([index === 1 ? gap / 2 : 2 * gap, 1, 0] as const)
              : ([1, index * 1e-10, 0] as const),
          radius: 1,
        })),
      });
      const step = race.step([-gap, 0, 0], [span, 0, 0], dt);
      expect(step.events.every((event) => event.fraction === 0)).toBe(true);
      expect(
        step.events.map((event) =>
          event.type === 'pearl'
            ? event.pearlId
            : event.type === 'checkpoint'
              ? event.checkpointId
              : event.type,
        ),
      ).toEqual(['early', 'middle', 'late', 'finish', 'finish']);
      expect(race.getCollectedPearlIds()).toEqual(['early', 'late']);
    },
  );

  it.each([0.1, 1e-20])(
    'rejects genuinely slower scaled finishes at %s seconds without widening medals',
    (seconds) => {
      const elapsedMs = seconds * 1000;
      const changes = {
        checkpoints: [checkpoint('finish', 0)],
        pearls: [],
        medalTimesMs: {
          gold: elapsedMs / 4,
          silver: elapsedMs / 2,
          bronze: elapsedMs,
        },
      };
      const slowFactor = 1 + 1e-8;
      const whole = configuredRace(changes).step(
        [-seconds, 0, 0],
        [span, 0, 0],
        span * slowFactor,
      );
      const endpoint = configuredRace(changes).step(
        [-seconds, 0, 0],
        [0, 0, 0],
        seconds * slowFactor,
      );
      expect.soft(whole.state.result?.medal).toBeNull();
      expect(endpoint.state.result?.medal).toBeNull();
      expect
        .soft(Math.abs(whole.state.elapsedMs / endpoint.state.elapsedMs - 1))
        .toBeLessThanOrEqual(4 * Number.EPSILON);
    },
  );
});

describe('race lifecycle and atomic input validation', () => {
  it('starts ready with route and pearl counts and an isolated frozen snapshot', () => {
    const race = new RaceSession(courseFixture());
    const state = race.getState();
    expect(state).toEqual({
      status: 'ready',
      courseId: 'sunlit-shoals',
      elapsedMs: 0,
      checkpointIndex: 0,
      checkpointCount: 2,
      pearlCount: 0,
      totalPearls: 1,
      result: null,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(race.start().status).toBe('running');
    expect(state.status).toBe('ready');
  });

  describe('ordered forward disk crossings', () => {
    it('sweeps multiple gates and clips time to the finish fraction', () => {
      const race = configuredRace({
        checkpoints: [gate('a', 2), gate('b', 4), gate('finish', 8)],
        pearls: [],
        medalTimesMs: { gold: 800, silver: 900, bronze: 1000 },
      });
      const step = race.step(origin, [0, -3, 10], 1);
      expect(step.state).toMatchObject({
        status: 'finished',
        checkpointIndex: 3,
        elapsedMs: 800,
        result: {
          courseId: 'sunlit-shoals',
          elapsedMs: 800,
          medal: 'gold',
          pearlCount: 0,
          totalPearls: 0,
        },
      });
      expect(step.events).toEqual([
        {
          type: 'checkpoint',
          checkpointId: 'a',
          checkpointIndex: 0,
          fraction: 0.2,
          elapsedMs: 200,
        },
        {
          type: 'checkpoint',
          checkpointId: 'b',
          checkpointIndex: 1,
          fraction: 0.4,
          elapsedMs: 400,
        },
        {
          type: 'checkpoint',
          checkpointId: 'finish',
          checkpointIndex: 2,
          fraction: 0.8,
          elapsedMs: 800,
        },
        {
          type: 'finish',
          fraction: 0.8,
          elapsedMs: 800,
          result: step.state.result,
        },
      ]);
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(step.events)).toBe(true);
      expect(step.events.every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(step.state.result)).toBe(true);
    });

    it.each([
      ['reverse', [0, -3, 10], [0, -3, 0]],
      ['parallel', [-1, -3, 2], [1, -3, 2]],
      ['stationary on plane', [0, -3, 2], [0, -3, 2]],
      ['starts on plane', [0, -3, 2], [0, -3, 3]],
      ['endpoint overlap without crossing', [0, -3, 0], [0, -3, 1]],
      ['outside disk', [2.000000001, -3, 0], [2.000000001, -3, 10]],
    ] satisfies [string, Vector3, Vector3][])('rejects %s', (_, from, to) => {
      const race = configuredRace(
        { checkpoints: [gate('finish', 2)], pearls: [] },
        10,
      );
      expect(race.step(from, to, 1).events).toEqual([]);
      expect(race.getState()).toMatchObject({
        status: 'running',
        checkpointIndex: 0,
      });
      // A later valid crossing establishes that rejecting a sweep did not finish the race.
      expect(race.step(origin, [0, -3, 4], 1).state.status).toBe('finished');
    });

    it('includes the exact disk aperture and arrival endpoint, without double counting', () => {
      const race = configuredRace({
        checkpoints: [gate('a', 2), gate('finish', 4)],
        pearls: [],
      });
      expect(race.step([2, -3, 0], [2, -3, 2], 1).state.checkpointIndex).toBe(
        1,
      );
      expect(race.step([2, -3, 2], [2, -3, 3], 1).events).toEqual([]);
      expect(
        race.step([2, -3, 3], [2, -3, 4], 1).events.map((event) => event.type),
      ).toEqual(['checkpoint', 'finish']);
    });

    it('handles tiny positive crossings without a world-space epsilon', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 0)],
        pearls: [],
      });
      const result = race.step([0, -3, -1e-12], [0, -3, 1e-12], 1);
      expect(result.state).toMatchObject({
        status: 'finished',
        elapsedMs: 500,
      });
    });

    it('uses the oriented plane rather than the world z axis', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 0, [Math.SQRT1_2, 0, Math.SQRT1_2])],
        pearls: [],
      });
      expect(race.step([-2, -3, -2], [2, -3, 2], 1).state).toMatchObject({
        status: 'finished',
        elapsedMs: 500,
      });
    });

    it.each(
      permutations.flatMap((axes) =>
        [1 / 16, 1, 16].map((scale) => ({ axes, scale })),
      ),
    )(
      'preserves exact checkpoint aperture across partitions: axes $axes scale $scale',
      ({ axes, scale }) => {
        const permute = (point: Vector3): Vector3 => [
          point[axes[0]],
          point[axes[1]],
          point[axes[2]],
        ];
        const transform = (point: Vector3): Vector3 =>
          permute([point[0] * scale, point[1] * scale, point[2] * scale]);
        for (const directionScale of [1 - 2 ** -22, 1, 1 + 2 ** -22]) {
          for (const shift of [0, -1e-9, 1e-9]) {
            const component = directionScale / Math.sqrt(2);
            const changes = {
              checkpoints: [
                {
                  id: 'finish',
                  position: [0, 0, 0] as const,
                  direction: permute([component, component, 0]),
                  radius: 3 * scale,
                },
              ],
              pearls: [],
            };
            const from = transform([-4, -8, -29 + shift]);
            const middle = transform([-1, -5, -14 + shift]);
            const contact = transform([2, -2, 1 + shift]);
            const to = transform([3, -1, 6 + shift]);
            const whole = configuredRace(changes);
            const split = configuredRace(changes);
            const endpoint = configuredRace(changes);
            const sweep = whole.step(from, to, 7);
            expect(split.step(from, middle, 3).events).toEqual([]);
            const remainder = split.step(middle, to, 4);
            const arrival = endpoint.step(from, contact, 6);
            const count = shift > 0 ? 0 : 1;
            for (const step of [sweep, remainder, arrival]) {
              expect(step.state.checkpointIndex).toBe(count);
              expect(step.state.status).toBe(count ? 'finished' : 'running');
              expect(step.events).toHaveLength(count * 2);
              if (count) expect(step.state.elapsedMs).toBe(6000);
            }
            if (count) {
              expect(sweep.events[0].fraction).toBe(6 / 7);
              expect(remainder.events[0].fraction).toBe(3 / 4);
              expect(arrival.events[0].fraction).toBe(1);
              expect(split.getState()).toEqual(whole.getState());
              expect(endpoint.getState()).toEqual(whole.getState());
            }
            expect(endpoint.step(contact, to, 1).events).toEqual([]);
          }
        }
      },
    );

    it.each(permutations)(
      'retains nonzero plane sides below binary64 product range: axes %s %s %s',
      (x, y, z) => {
        const permute = (point: Vector3): Vector3 => [
          point[x],
          point[y],
          point[z],
        ];
        const race = configuredRace({
          checkpoints: [
            {
              id: 'finish',
              position: [0, 0, 0],
              direction: permute([0.5, Math.sqrt(0.75), 0]),
              radius: 1,
            },
          ],
          pearls: [],
        });
        expect(
          race.step(
            permute([-Number.MIN_VALUE, 0, 0]),
            permute([Number.MIN_VALUE, 0, 0]),
            1,
          ).state,
        ).toMatchObject({ status: 'finished', elapsedMs: 500 });
      },
    );

    it.each([1 - 2 ** -22, 1 + 2 ** -22])(
      'includes arrival on the raw direction plane at scale %s',
      (scale) => {
        const direction: Vector3 = [0.6 * scale, 0.8 * scale, 0];
        const contact: Vector3 = [direction[1], -direction[0], 0];
        const race = configuredRace({
          checkpoints: [
            { id: 'finish', position: [0, 0, 0], direction, radius: 2 },
          ],
          pearls: [{ id: 'at-plane', position: contact, radius: 0.25 }],
        });
        const step = race.step([-1, -1, 0], contact, 1);
        expect(step.state).toMatchObject({
          status: 'finished',
          elapsedMs: 1000,
          pearlCount: 1,
        });
        expect(step.events.at(-1)).toMatchObject({
          type: 'finish',
          fraction: 1,
        });
      },
    );

    it.each([1 - 2 ** -22, 1 + 2 ** -22])(
      'excludes departure from the raw direction plane at scale %s',
      (scale) => {
        const direction: Vector3 = [0.6 * scale, 0.8 * scale, 0];
        const race = configuredRace({
          checkpoints: [
            { id: 'finish', position: [0, 0, 0], direction, radius: 2 },
          ],
          pearls: [],
        });
        expect(
          race.step([direction[1], -direction[0], 0], [1, 1, 0], 1).events,
        ).toEqual([]);
        expect(race.getState().checkpointIndex).toBe(0);
      },
    );

    it('compares checkpoint order before distinct rational fractions round to a tie', () => {
      const checkpoint = (id: string, x: number) => ({
        id,
        position: [x, 0, 0] as const,
        direction: [1, 0, 0] as const,
        radius: 1,
      });
      const race = configuredRace({
        checkpoints: [checkpoint('first', 2 ** -52), checkpoint('finish', 0)],
        pearls: [],
      });
      const step = race.step([-1e100, 0, 0], [1e100, 0, 0], 1);
      expect(step.state).toMatchObject({
        status: 'running',
        checkpointIndex: 1,
        elapsedMs: 1000,
      });
      expect(step.events).toEqual([
        {
          type: 'checkpoint',
          checkpointId: 'first',
          checkpointIndex: 0,
          fraction: 0.5,
          elapsedMs: 500,
        },
      ]);
      expect(race.step([-1, 0, 0], [1, 0, 0], 1).state).toMatchObject({
        status: 'finished',
        elapsedMs: 1500,
      });
    });

    it('keeps coincident raw planes in route order with differently scaled directions', () => {
      const race = configuredRace({
        checkpoints: [1 - 2 ** -22, 1, 1 + 2 ** -22].map((scale, index) => ({
          id: `gate-${index}`,
          position: [0, 0, 0] as const,
          direction: [scale / Math.sqrt(2), scale / Math.sqrt(2), 0] as const,
          radius: 3,
        })),
        pearls: [],
      });
      const step = race.step([-4, -8, -29], [3, -1, 6], 7);
      expect(step.events.map((event) => event.type)).toEqual([
        'checkpoint',
        'checkpoint',
        'checkpoint',
        'finish',
      ]);
      expect(step.events.every((event) => event.fraction === 6 / 7)).toBe(true);
    });

    it('does not skip a missed prerequisite to award a later gate', () => {
      const race = configuredRace({
        checkpoints: [gate('first', 2), gate('finish', 4)],
        pearls: [],
      });
      expect(race.step([0, -3, 3], [0, -3, 5], 1).state.checkpointIndex).toBe(
        0,
      );
      expect(race.step(origin, [0, -3, 5], 1).state.checkpointIndex).toBe(2);
    });

    it('never retroactively awards a gate crossed earlier than its prerequisite', () => {
      const race = configuredRace({
        checkpoints: [gate('first', 8), gate('finish', 4)],
        pearls: [],
      });
      const first = race.step(origin, [0, -3, 10], 1);
      expect(first.state).toMatchObject({
        status: 'running',
        checkpointIndex: 1,
        elapsedMs: 1000,
      });
      expect(first.events).toHaveLength(1);
      expect(race.step([0, -3, 10], origin, 1).events).toEqual([]);
      expect(race.step(origin, [0, -3, 8], 1).state).toMatchObject({
        status: 'finished',
        elapsedMs: 2500,
      });
    });

    it('allows coincident gates in route order at the same fraction', () => {
      const race = configuredRace({
        checkpoints: [gate('first', 2), gate('finish', 2)],
        pearls: [],
      });
      expect(
        race.step(origin, [0, -3, 4], 1).events.map((event) => event.type),
      ).toEqual(['checkpoint', 'checkpoint', 'finish']);
    });

    it('never repeats completed checkpoints when retracing the route', () => {
      const race = configuredRace({
        checkpoints: [gate('first', 2), gate('finish', 8)],
        pearls: [],
      });
      expect(race.step(origin, [0, -3, 4], 1).events).toHaveLength(1);
      expect(race.step([0, -3, 4], origin, 1).events).toEqual([]);
      expect(race.step(origin, [0, -3, 4], 1).events).toEqual([]);
      expect(race.getState().checkpointIndex).toBe(1);
    });

    it('guards a finished race and never emits another finish or changes its result', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 2)],
        pearls: [],
      });
      const final = race.step(origin, [0, -3, 4], 1).state;
      expect(final.status).toBe('finished');
      expect(race.step(origin, [0, -3, 100], 30)).toEqual({
        state: final,
        events: [],
      });
      for (const action of ['start', 'pause', 'resume'] as const) {
        expect(() => race[action]()).toThrow(/finished/);
      }
      expect(() => race.step(origin, [0, NaN, 0], 1)).toThrow();
      expect(race.getState()).toEqual(final);
    });

    it('rejects overflowing movement without partial checkpoint or timing updates', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 2)],
        pearls: [],
      });
      const before = race.getState();
      expect(() =>
        race.step([-Number.MAX_VALUE, -3, 0], [Number.MAX_VALUE, -3, 4], 1),
      ).toThrow(RangeError);
      expect(race.getState()).toEqual(before);
      expect(race.getCollectedPearlIds()).toEqual([]);
    });
  });

  describe('swept pearls and clipped chronological results', () => {
    it.each(
      [false, true].flatMap((reverseAuthoredOrder) =>
        [false, true].map((clipped) => ({ reverseAuthoredOrder, clipped })),
      ),
    )(
      'orders nonzero-subnormal roots: reversed $reverseAuthoredOrder clipped $clipped',
      ({ reverseAuthoredOrder, clipped }) => {
        const radius = 1 / 64;
        const gaps = [2 ** -47, 3 * 2 ** -48];
        const pearls = gaps.map((gap, index) => ({
          id: index === 0 ? 'earlier' : 'later',
          position: [-radius - gap, 0, 0] as const,
          radius,
        }));
        const race = configuredRace({
          checkpoints: clipped
            ? [
                {
                  id: 'finish',
                  position: [-0.25, 0, 0],
                  direction: [-1, 0, 0],
                  radius: 1,
                },
              ]
            : courseFixture().checkpoints,
          pearls: reverseAuthoredOrder ? pearls.toReversed() : pearls,
        });
        const step = race.step([0, 0, 0], [-1e154, 0, 0], 1);
        const pickups = step.events.filter((event) => event.type === 'pearl');
        expect(pickups.map((event) => event.pearlId)).toEqual([
          'earlier',
          'later',
        ]);
        expect(race.getCollectedPearlIds()).toEqual(['earlier', 'later']);
        expect(pickups[0].fraction).toBeLessThan(pickups[1].fraction);
        for (let index = 0; index < gaps.length; index++) {
          const expected = gaps[index] / 1e154;
          expect(
            Math.abs(pickups[index].fraction / expected - 1),
          ).toBeLessThanOrEqual(4 * Number.EPSILON);
          expect(
            Math.abs(pickups[index].elapsedMs / (expected * 1000) - 1),
          ).toBeLessThanOrEqual(4 * Number.EPSILON);
        }
        expect(step.state.status).toBe(clipped ? 'finished' : 'running');
        expect(step.state.pearlCount).toBe(2);
        expect(step.events.map((event) => event.type)).toEqual(
          clipped
            ? ['pearl', 'pearl', 'checkpoint', 'finish']
            : ['pearl', 'pearl'],
        );
      },
    );

    it.each([2 ** -52, 2 ** -51, 2 ** -40])(
      'retains the earliest entry for a symmetric %s radial boundary crossing',
      (distance) => {
        const race = configuredRace({
          pearls: [{ id: 'boundary', position: [0, 0, 0], radius: 1 }],
        });
        expect(
          race.step([1 + distance, 0, 0], [1 - distance, 0, 0], 1).events,
        ).toEqual([
          { type: 'pearl', pearlId: 'boundary', fraction: 0.5, elapsedMs: 500 },
        ]);
      },
    );

    it.each([1e-300, 1e-150, 1, 1e150, 1e200])(
      'classifies tangency without squared underflow or overflow at span %s',
      (span) => {
        for (const shift of [0, -1e-9, 1e-9]) {
          const race = configuredRace({
            pearls: [{ id: 'tangent', position: [0, 0, 0], radius: 1 }],
          });
          const step = race.step(
            [-span, -5 * span, 1 + shift],
            [span, 5 * span, 1 + shift],
            1,
          );
          expect(step.state.pearlCount).toBe(shift > 0 ? 0 : 1);
          if (shift === 0) {
            expect(step.events[0]).toMatchObject({
              fraction: 0.5,
              elapsedMs: 500,
            });
          } else if (shift < 0) {
            expect(step.events[0].fraction).toBeLessThanOrEqual(0.5);
          }
        }
      },
    );

    it.each([1, 16, 2 ** 20, 2 ** 24])(
      'resolves cancellation and a finish just before 3D contact over a %s-length scale',
      (span) => {
        const from: Vector3 = [1 - 12 * span, 2 - 6 * span, 2 + 12 * span];
        const to: Vector3 = [1 + 2 * span, 2 + span, 2 - 2 * span];
        for (const finishShift of [0, -1e-9, 1e-9]) {
          const race = configuredRace({
            checkpoints: [
              {
                id: 'finish',
                position: [1 + finishShift, 2, 2],
                direction: [1, 0, 0],
                radius: 3,
              },
            ],
            pearls: [{ id: 'tangent', position: [0, 0, 0], radius: 3 }],
          });
          const step = race.step(from, to, 7);
          expect(step.state.status).toBe('finished');
          expect(step.state.result?.pearlCount).toBe(finishShift < 0 ? 0 : 1);
          if (finishShift === 0) {
            expect(
              step.events.map((event) => [event.type, event.fraction]),
            ).toEqual([
              ['checkpoint', 6 / 7],
              ['pearl', 6 / 7],
              ['finish', 6 / 7],
            ]);
          }
        }
      },
    );

    it.each([1, 16, 2 ** 20, 2 ** 24])(
      'retains tiny normal offsets lost by floating subtraction over a %s-length scale',
      (span) => {
        const from: Vector3 = [1 - 12 * span, 2 - 6 * span, 2 + 12 * span];
        const tangent: Vector3 = [1, 2, 2];
        const to: Vector3 = [1 + 2 * span, 2 + span, 2 - 2 * span];
        for (const shift of [0, -1e-9, 1e-9]) {
          const changes = {
            pearls: [
              {
                id: 'tangent',
                position: [
                  -shift / 3,
                  (-2 * shift) / 3,
                  (-2 * shift) / 3,
                ] as const,
                radius: 3,
              },
            ],
          };
          const whole = configuredRace(changes);
          const split = configuredRace(changes);
          const events = whole.step(from, to, 7).events;
          split.step(from, tangent, 6);
          split.step(tangent, to, 1);
          expect(whole.getState().pearlCount).toBe(shift > 0 ? 0 : 1);
          expect(split.getState().pearlCount).toBe(shift > 0 ? 0 : 1);
          if (shift === 0) {
            expect(events[0]).toMatchObject({
              fraction: 6 / 7,
              elapsedMs: 6000,
            });
          } else if (shift < 0) {
            expect(events[0].fraction).toBeLessThan(6 / 7);
          }
        }
      },
    );

    const tangentCases = [5, 8].flatMap((slope) =>
      permutations.flatMap((axes) =>
        [1 / 16, 1, 16, 64].map((scale) => ({
          slope,
          axes,
          scale,
        })),
      ),
    );

    it.each(tangentCases)(
      'includes 3D tangency, splits and endpoints: slope $slope axes $axes scale $scale',
      ({ slope, axes, scale }) => {
        const transform = (point: Vector3): Vector3 => [
          point[axes[0]] * scale,
          point[axes[1]] * scale,
          point[axes[2]] * scale,
        ];
        for (const shift of [0, -1e-9, 1e-9]) {
          const from = transform([-1, -slope, 1 + shift]);
          const tangent = transform([0, 0, 1 + shift]);
          const to = transform([1, slope, 1 + shift]);
          const changes = {
            checkpoints: [
              {
                id: 'unreached',
                position: transform([10, 0, 0]),
                direction: transform([1 / scale, 0, 0]),
                radius: scale,
              },
            ],
            pearls: [
              { id: 'tangent', position: [0, 0, 0] as const, radius: scale },
            ],
          };
          const whole = configuredRace(changes);
          const split = configuredRace(changes);
          const endpoint = configuredRace(changes);
          const events = whole.step(from, to, 1).events;
          const splitEvents = [
            ...split.step(from, tangent, 0.5).events,
            ...split.step(tangent, to, 0.5).events,
          ];
          const arrival = endpoint.step(from, tangent, 0.5);
          const count = shift > 0 ? 0 : 1;
          for (const race of [whole, split, endpoint]) {
            expect(race.getState().pearlCount).toBe(count);
          }
          expect(events).toHaveLength(count);
          expect(splitEvents).toHaveLength(count);
          expect(arrival.events).toHaveLength(count);
          if (shift === 0) {
            expect(events[0]).toMatchObject({ fraction: 0.5, elapsedMs: 500 });
            expect(splitEvents[0]).toMatchObject({
              fraction: 1,
              elapsedMs: 500,
            });
            expect(arrival.events[0]).toMatchObject({
              fraction: 1,
              elapsedMs: 500,
            });
          } else if (shift < 0) {
            const entry =
              0.5 - Math.sqrt((1 - (1 + shift) ** 2) / (4 * (1 + slope ** 2)));
            expect(events[0].fraction).toBeCloseTo(entry, 10);
            expect(events[0].fraction).toBeLessThan(0.5);
            expect(splitEvents[0].elapsedMs).toBeCloseTo(
              events[0].elapsedMs,
              8,
            );
          }
        }
      },
    );

    it.each(tangentCases)(
      'orders 3D tangent contact at the finish without widening it: slope $slope axes $axes scale $scale',
      ({ slope, axes, scale }) => {
        const transform = (point: Vector3): Vector3 => [
          point[axes[0]] * scale,
          point[axes[1]] * scale,
          point[axes[2]] * scale,
        ];
        for (const finishShift of [0, -1e-9, 1e-9]) {
          const race = configuredRace({
            checkpoints: [
              {
                id: 'finish',
                position: transform([finishShift, 0, 1]),
                direction: transform([1 / scale, 0, 0]),
                radius: scale,
              },
            ],
            pearls: [{ id: 'tangent', position: [0, 0, 0], radius: scale }],
          });
          const step = race.step(
            transform([-1, -slope, 1]),
            transform([1, slope, 1]),
            1,
          );
          expect(step.state.status).toBe('finished');
          expect(step.state.result?.pearlCount).toBe(finishShift < 0 ? 0 : 1);
          if (finishShift === 0) {
            expect(
              step.events.map((event) => [
                event.type,
                event.fraction,
                event.elapsedMs,
              ]),
            ).toEqual([
              ['checkpoint', 0.5, 500],
              ['pearl', 0.5, 500],
              ['finish', 0.5, 500],
            ]);
          }
        }
      },
    );

    it.each([
      ['exact tangent', 0, 1],
      ['outward normal', 1e-9, 0],
      ['inward normal', -1e-9, 1],
    ] as const)(
      'classifies a rotated %s identically for whole and partitioned sweeps',
      (_, shift, count) => {
        const translate = (x: number, y: number): Vector3 => [
          x - (12 / 13) * shift,
          y + (5 / 13) * shift,
          0,
        ];
        const from = translate(-10.125, -22.1875);
        const tangent = translate(-0.75, 0.3125);
        const to = translate(0.8125, 4.0625);
        const changes = {
          pearls: [
            { id: 'rotated', position: [0, 0, 0] as const, radius: 0.8125 },
          ],
        };
        const whole = configuredRace(changes);
        const split = configuredRace(changes);
        const wholeEvents = whole.step(from, to, 1).events;
        const splitEvents = [
          ...split.step(from, tangent, 6 / 7).events,
          ...split.step(tangent, to, 1 / 7).events,
        ];
        expect(whole.getState().status).toBe('running');
        expect(split.getState().status).toBe('running');
        expect(whole.getState().pearlCount).toBe(count);
        expect(split.getState().pearlCount).toBe(count);
        expect(whole.getCollectedPearlIds()).toEqual(
          split.getCollectedPearlIds(),
        );
        expect(wholeEvents).toHaveLength(count);
        expect(splitEvents).toHaveLength(count);
        if (count) {
          // The inward control must report entry, not the closest point.
          const distance = 0.8125 + shift;
          const halfChord = Math.sqrt(
            (0.8125 - distance) * (0.8125 + distance),
          );
          const entry = 6 / 7 - halfChord / 28.4375;
          expect(wholeEvents[0].fraction).toBeCloseTo(entry, 11);
          expect(wholeEvents[0].elapsedMs).toBeCloseTo(entry * 1000, 8);
          expect(splitEvents[0].elapsedMs).toBeCloseTo(entry * 1000, 8);
        }
      },
    );

    it('handles a very large valid radius without squaring it', () => {
      const race = configuredRace(
        { pearls: [{ id: 'large', position: [0, 0, 0], radius: 1 }] },
        1e200,
      );
      const step = race.step([-2e200, 0, 0], [2e200, 0, 0], 1);
      expect(step.events).toEqual([
        { type: 'pearl', pearlId: 'large', fraction: 0.25, elapsedMs: 250 },
      ]);
    });

    it.each([
      ['at the tangent', 0, 1],
      ['just before the tangent', -1e-9, 0],
    ] as const)(
      'clips a rotated pickup with the finish %s',
      (_, shift, count) => {
        const race = configuredRace({
          checkpoints: [
            {
              id: 'finish',
              position: [-0.75 + shift, 0.3125, 0],
              direction: [1, 0, 0],
              radius: 2,
            },
          ],
          pearls: [{ id: 'rotated', position: [0, 0, 0], radius: 0.8125 }],
        });
        const step = race.step([-10.125, -22.1875, 0], [0.8125, 4.0625, 0], 1);
        expect(step.state.result?.pearlCount).toBe(count);
        if (count) {
          expect(step.events.map((event) => event.type)).toEqual([
            'checkpoint',
            'pearl',
            'finish',
          ]);
          expect(step.events.every((event) => event.fraction === 6 / 7)).toBe(
            true,
          );
        } else {
          expect(step.events.map((event) => event.type)).toEqual([
            'checkpoint',
            'finish',
          ]);
        }
      },
    );

    it('sweeps pickups at high speed and collects each ID only once', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 20)],
        pearls: [pearl('first', 3), pearl('second', 7)],
      });
      expect(race.step(origin, [0, -3, 10], 1).state.pearlCount).toBe(2);
      expect(race.step([0, -3, 10], origin, 1).events).toEqual([]);
      expect(race.getCollectedPearlIds()).toEqual(['first', 'second']);
      expect(Object.isFrozen(race.getCollectedPearlIds())).toBe(true);
    });

    it('uses the default player radius and respects a zero override', () => {
      const course = {
        ...courseFixture(),
        pearls: [pearl('pickup', 5, 0.3, 0.6)],
      };
      const normal = new RaceSession(course);
      const point = new RaceSession(course, { playerRadius: 0 });
      normal.start();
      point.start();
      expect(normal.step(origin, [0, -3, 10], 1).state.pearlCount).toBe(1);
      expect(point.step(origin, [0, -3, 10], 1).state.pearlCount).toBe(0);
    });

    it('includes exact tangent contact but excludes points just outside the sphere', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 20)],
        pearls: [
          pearl('tangent', 5, 1, 1),
          pearl('outside', 5, 1, 1.000000001),
        ],
      });
      const step = race.step(origin, [0, -3, 10], 1);
      expect(step.events).toEqual([
        { type: 'pearl', pearlId: 'tangent', fraction: 0.5, elapsedMs: 500 },
      ]);
      expect(step.state.pearlCount).toBe(1);
    });

    it('collects a stationary fish inside or on a pickup only on active positive time', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 20)],
        pearls: [
          pearl('inside', 0),
          pearl('boundary', 0, 1, 1),
          pearl('outside', 0, 1, 1.000000001),
        ],
      });
      expect(race.step(origin, origin, 0).state.pearlCount).toBe(0);
      race.pause();
      expect(race.step(origin, origin, 1).state.pearlCount).toBe(0);
      race.resume();
      expect(race.step(origin, origin, 1).events).toEqual([
        { type: 'pearl', pearlId: 'inside', fraction: 0, elapsedMs: 0 },
        { type: 'pearl', pearlId: 'boundary', fraction: 0, elapsedMs: 0 },
      ]);
      expect(race.step(origin, origin, 1).events).toEqual([]);
    });

    it('orders events by contact fraction, processes tied pickups before finish, and excludes later pickups', () => {
      const race = configuredRace({
        checkpoints: [gate('start', 2), gate('finish', 8)],
        pearls: [
          pearl('after', 9.01, 1),
          pearl('at-finish', 9, 1),
          pearl('early', 4, 1),
        ],
        medalTimesMs: { gold: 800, silver: 900, bronze: 1000 },
      });
      const step = race.step(origin, [0, -3, 10], 1);
      expect(step.events.map((event) => [event.type, event.fraction])).toEqual([
        ['checkpoint', 0.2],
        ['pearl', 0.3],
        ['checkpoint', 0.8],
        ['pearl', 0.8],
        ['finish', 0.8],
      ]);
      expect(step.state.result).toEqual({
        courseId: 'sunlit-shoals',
        elapsedMs: 800,
        medal: 'gold',
        pearlCount: 2,
        totalPearls: 3,
      });
      expect(race.getCollectedPearlIds()).toEqual(['early', 'at-finish']);
      expect(step.events.at(-1)).toMatchObject({ result: step.state.result });
    });

    it('does not collect beyond the finish on later steps', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 2)],
        pearls: [pearl('late', 8)],
      });
      expect(race.step(origin, [0, -3, 10], 1).state.status).toBe('finished');
      expect(race.step([0, -3, 7], [0, -3, 9], 1).state.pearlCount).toBe(0);
      expect(race.getCollectedPearlIds()).toEqual([]);
    });

    it('preserves complete race results when a sweep is split at gate and pickup boundaries', () => {
      const changes = {
        checkpoints: [gate('first', 2), gate('middle', 4), gate('finish', 8)],
        pearls: [
          pearl('a', 3, 1),
          pearl('b', 6, 1),
          pearl('c', 9, 1),
          pearl('late', 10),
        ],
      };
      const whole = configuredRace(changes);
      const split = configuredRace(changes);
      const wholeStep = whole.step(origin, [0, -3, 10], 1);
      const events = [];
      for (let z = 0; z < 10; z++) {
        events.push(...split.step([0, -3, z], [0, -3, z + 1], 0.1).events);
      }
      expect(wholeStep.state.status).toBe('finished');
      expect(split.getState()).toEqual(wholeStep.state);
      expect(split.getCollectedPearlIds()).toEqual(
        whole.getCollectedPearlIds(),
      );
      expect(events.map((event) => ({ ...event, fraction: 0 }))).toEqual(
        wholeStep.events.map((event) => ({ ...event, fraction: 0 })),
      );
    });

    it('retains previous snapshots and collected ID lists without freezing caller input', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 20)],
        pearls: [pearl('a', 3)],
      });
      const before = race.getState();
      const ids = race.getCollectedPearlIds();
      const from: [number, number, number] = [0, -3, 0];
      race.step(from, [0, -3, 10], 1);
      from[0] = 99;
      expect(before.pearlCount).toBe(0);
      expect(ids).toEqual([]);
      expect(race.getState().pearlCount).toBe(1);
    });

    it('rejects time overflow after candidate collections without leaking any awards', () => {
      const race = configuredRace({
        checkpoints: [gate('finish', 8)],
        pearls: [pearl('a', 3)],
      });
      race.step(origin, origin, 1e305);
      const before = race.getState();
      expect(() => race.step(origin, [0, -3, 10], 1e305)).toThrow(RangeError);
      expect(race.getState()).toEqual(before);
      expect(race.getCollectedPearlIds()).toEqual([]);
    });
  });
  it('requires start before a step', () => {
    const race = new RaceSession(courseFixture());
    expect(() => race.step(origin, beforeStart, 1)).toThrow(/ready/);
    expect(race.getState().elapsedMs).toBe(0);
  });

  it('accumulates fractional milliseconds only while running', () => {
    const race = running();
    expect(race.step(origin, beforeStart, 1 / 60).state.elapsedMs).toBeCloseTo(
      1000 / 60,
      12,
    );
    expect(race.pause().status).toBe('paused');
    const paused = race.getState();
    expect(race.step(origin, [0, -3, 30], 100)).toEqual({
      state: paused,
      events: [],
    });
    expect(race.resume().status).toBe('running');
    expect(race.step(origin, beforeStart, 1 / 60).state.elapsedMs).toBeCloseTo(
      2000 / 60,
      12,
    );
  });

  it.each([
    ['ready', 'pause'],
    ['ready', 'resume'],
    ['running', 'start'],
    ['running', 'resume'],
    ['paused', 'start'],
    ['paused', 'pause'],
  ] as const)('rejects %s -> %s without mutation', (status, action) => {
    const race = new RaceSession(courseFixture());
    if (status !== 'ready') race.start();
    if (status === 'paused') race.pause();
    const before = race.getState();
    expect(() => race[action]()).toThrow(new RegExp(status));
    expect(race.getState()).toEqual(before);
  });

  it('ignores zero time even when movement crosses the entire race', () => {
    const race = running();
    const before = race.getState();
    expect(race.step(origin, [0, -3, 30], 0)).toEqual({
      state: before,
      events: [],
    });
    expect(race.getCollectedPearlIds()).toEqual([]);
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects invalid dt %s before changing state',
    (dt) => {
      const race = running();
      const before = race.getState();
      expect(() => race.step(origin, [0, -3, 30], dt)).toThrow(
        'dt must be finite and nonnegative.',
      );
      expect(race.getState()).toEqual(before);
    },
  );

  it.each([
    [NaN, 0, 0],
    [0, Infinity, 0],
    [0, 0, -Infinity],
  ] satisfies Vector3[])(
    'rejects invalid coordinates %s/%s/%s on either endpoint',
    (...invalid) => {
      const race = running();
      const before = race.getState();
      expect(() => race.step(invalid, beforeStart, 1)).toThrow();
      expect(() => race.step(origin, invalid, 1)).toThrow();
      expect(race.getState()).toEqual(before);
    },
  );

  it('validates paused and zero-time inputs rather than hiding bad data', () => {
    const race = running();
    expect(() => race.step([NaN, 0, 0], origin, 0)).toThrow();
    race.pause();
    expect(() => race.step(origin, beforeStart, NaN)).toThrow();
    expect(() => race.step(origin, [0, Infinity, 0], 1)).toThrow();
  });

  it.each([-1, NaN, Infinity])(
    'rejects invalid player radius %s',
    (playerRadius) => {
      expect(
        () => new RaceSession(courseFixture(), { playerRadius }),
      ).toThrow();
    },
  );

  it('validates the course and keeps its own immutable copy', () => {
    expect(() => new RaceSession({})).toThrow();
    const checkpoints = [...courseFixture().checkpoints];
    const source = { ...courseFixture(), checkpoints };
    const race = new RaceSession(source);
    checkpoints.pop();
    expect(race.getState().checkpointCount).toBe(2);
  });

  it('rejects time overflow atomically, including accumulated overflow', () => {
    const race = running();
    const before = race.getState();
    expect(() => race.step(origin, origin, Number.MAX_VALUE)).toThrow(
      RangeError,
    );
    expect(race.getState()).toEqual(before);
    race.step(origin, origin, 1e305);
    const huge = race.getState();
    expect(huge.elapsedMs).toBe(1e308);
    expect(() => race.step(origin, origin, 1e305)).toThrow(RangeError);
    expect(race.getState()).toEqual(huge);
  });

  it('preserves elapsed time across equivalent subdivisions', () => {
    const whole = running();
    const split = running();
    whole.step(origin, beforeStart, 0.1);
    for (let index = 0; index < 6; index++)
      split.step(origin, beforeStart, 1 / 60);
    expect(split.getState().elapsedMs).toBeCloseTo(
      whole.getState().elapsedMs,
      10,
    );
    expect(whole.getState().elapsedMs).toBe(100);
  });

  describe('partition-independent medal timing', () => {
    it.each([
      [60, 30000, 'bronze'],
      [75, 30000.000000000004, null],
    ] as const)(
      'keeps unsnapped %s Hz millisecond measurements while standalone awards remain strict',
      (hz, elapsedMs, strictMedal) => {
        const race = running();
        const frames = 30 * hz;
        for (let index = 0; index < frames; index++) {
          race.step(
            [0, -3, (20 * index) / frames],
            [0, -3, (20 * (index + 1)) / frames],
            1 / hz,
          );
        }
        // Round the exact dyadic sum in milliseconds once, without snapping.
        expect(race.getState().elapsedMs).toBe(elapsedMs);
        expect(race.getState().result?.medal).toBe('bronze');
        expect(
          awardMedal(race.getState().elapsedMs, courseFixture().medalTimesMs),
        ).toBe(strictMedal);
      },
    );

    it.each([{ weights: [1, 2, 4] }, { weights: [1, 7, 2, 3] }])(
      'preserves boundaries and slower controls across unequal frame weights $weights',
      ({ weights }) => {
        const rate = weights.reduce((sum, weight) => sum + weight, 0) * 75;
        for (const [seconds, boundaryMedal, slowerMedal] of [
          [12, 'gold', 'silver'],
          [18, 'silver', 'bronze'],
          [30, 'bronze', null],
        ] as const) {
          for (const clipped of [false, true]) {
            const leadUnits = clipped ? weights[weights.length - 1] / 2 : 0;
            const movementUnits = seconds * rate - leadUnits;
            for (const delayMs of [0, 1e-9, 0.001]) {
              const race = running();
              race.step(origin, origin, leadUnits / rate);
              race.step(origin, origin, delayMs / 1000);
              let units = 0;
              for (let cycle = 0; cycle < seconds * 75; cycle++) {
                for (const weight of weights) {
                  race.step(
                    [0, -3, (20 * units) / movementUnits],
                    [0, -3, (20 * (units + weight)) / movementUnits],
                    weight / rate,
                  );
                  units += weight;
                }
              }
              expect(race.getState().status).toBe('finished');
              expect(race.getState().result?.medal).toBe(
                delayMs === 0 ? boundaryMedal : slowerMedal,
              );
              expect(race.getState().elapsedMs).toBeCloseTo(
                seconds * 1000 + delayMs,
                9,
              );
            }
          }
        }
      },
    );

    it.each([false, true])(
      'does not retain a failed or paused duration error budget before a clipped=%s finish',
      (clipped) => {
        const race = running();
        const control = running();
        for (const session of [race, control]) {
          session.step(origin, origin, 1e-12);
          for (let index = 0; index < 7; index++) {
            session.step(origin, origin, 1 / 75);
          }
        }
        const before = race.getState();
        const far: Vector3 = [Number.MAX_VALUE, Number.MAX_VALUE, 0];
        expect(() => race.step(far, far, 1e12)).toThrow(RangeError);
        expect(race.getState()).toBe(before);
        race.pause();
        race.step(origin, origin, 1e12);
        race.resume();
        for (const session of [race, control]) {
          for (let index = 7; index < 899; index++) {
            session.step(origin, origin, 1 / 75);
          }
        }
        const to: Vector3 = [0, -3, clipped ? 40 : 20];
        const dt = (clipped ? 2 : 1) / 75;
        const result = race.step(origin, to, dt);
        expect(result).toEqual(control.step(origin, to, dt));
        expect(result.state.result?.medal).toBe('silver');
        expect(result.state.elapsedMs).toBeCloseTo(12_000 + 1e-9, 10);
      },
    );

    it.each([24, 30, 60, 75, 90, 120, 144, 165, 240])(
      'preserves all medal boundaries and slower controls for full/clipped %s Hz finishes',
      (hz) => {
        for (const [seconds, boundaryMedal, slowerMedal] of [
          [12, 'gold', 'silver'],
          [18, 'silver', 'bronze'],
          [30, 'bronze', null],
        ] as const) {
          for (const clipped of [false, true]) {
            for (const delayMs of [0, 1e-9, 0.001]) {
              const whole = running();
              const split = running();
              const leadIn = clipped ? 1 / (2 * hz) : 0;
              // Integer coordinates make the last crossing exactly 1 or 1/2;
              // coordinate rounding must not contaminate input-dt boundary tests.
              const startZ = 20 - 2 * seconds * hz + (clipped ? 1 : 0);
              const start: Vector3 = [0, -3, startZ];
              for (const race of [whole, split]) {
                race.step(start, start, leadIn);
                race.pause();
                race.step(start, [0, -3, 40], 100_000);
                race.resume();
                race.step(start, start, delayMs / 1000);
              }
              whole.step(start, [0, -3, clipped ? 21 : 20], seconds);
              let last;
              for (let index = 0; index < seconds * hz; index++) {
                last = split.step(
                  [0, -3, startZ + 2 * index],
                  [0, -3, startZ + 2 * (index + 1)],
                  1 / hz,
                );
              }
              for (const race of [whole, split]) {
                expect(race.getState().status).toBe('finished');
                expect(race.getState().result?.medal).toBe(
                  delayMs === 0 ? boundaryMedal : slowerMedal,
                );
                expect(race.getState().elapsedMs).toBeCloseTo(
                  seconds * 1000 + delayMs,
                  9,
                );
              }
              expect(last?.events.at(-1)).toMatchObject({
                type: 'finish',
                elapsedMs: split.getState().elapsedMs,
                result: split.getState().result,
              });
              expect(last?.events.at(-1)?.fraction).toBeCloseTo(
                clipped ? 0.5 : 1,
                9,
              );
            }
          }
        }
      },
    );

    it.each([
      [12, 'gold', 'silver'],
      [18, 'silver', 'bronze'],
      [30, 'bronze', null],
    ] as const)(
      'preserves the %s second boundary and a 0.001 ms slower control',
      (seconds, boundaryMedal, slowerMedal) => {
        for (const delay of [0, 0.000001]) {
          const whole = running();
          const split = running();
          for (const race of [whole, split]) {
            race.step(origin, origin, delay);
          }
          const wholeStep = whole.step(origin, [0, -3, 20], seconds);
          const frames = seconds * 60;
          for (let index = 0; index < frames; index++) {
            split.step(
              [0, -3, (20 * index) / frames],
              [0, -3, (20 * (index + 1)) / frames],
              1 / 60,
            );
          }
          const expectedMs = seconds * 1000 + delay * 1000;
          for (const race of [whole, split]) {
            expect(
              Math.abs(race.getState().elapsedMs / expectedMs - 1),
            ).toBeLessThanOrEqual(Number.EPSILON);
            expect(race.getState().result?.medal).toBe(
              delay === 0 ? boundaryMedal : slowerMedal,
            );
          }
          const splitState = split.getState();
          expect(splitState).toEqual({
            ...wholeStep.state,
            elapsedMs: splitState.elapsedMs,
            result: {
              ...wholeStep.state.result,
              elapsedMs: splitState.elapsedMs,
            },
          });
        }
      },
    );

    it.each([
      [12, 'gold', 'silver'],
      [18, 'silver', 'bronze'],
      [30, 'bronze', null],
    ] as const)(
      'clips a partial final frame at %s seconds without awarding slower runs',
      (seconds, boundaryMedal, slowerMedal) => {
        for (const delay of [0, 0.000001, 0.000000000001]) {
          const whole = running();
          const split = running();
          const leadIn = 1 / 120;
          const movementSeconds = seconds - leadIn;
          for (const race of [whole, split]) {
            race.step(origin, origin, leadIn);
            race.pause();
            race.step(origin, [0, -3, 100], 100);
            race.resume();
            race.step(origin, origin, delay);
          }
          whole.step(
            origin,
            [0, -3, (20 * seconds) / movementSeconds],
            seconds,
          );
          let finalStep;
          for (let index = 0; index < seconds * 60; index++) {
            finalStep = split.step(
              [0, -3, (20 * (index / 60)) / movementSeconds],
              [0, -3, (20 * ((index + 1) / 60)) / movementSeconds],
              1 / 60,
            );
          }
          for (const race of [whole, split]) {
            expect(race.getState().result?.elapsedMs).toBeCloseTo(
              seconds * 1000 + delay * 1000,
              9,
            );
            expect(race.getState().result?.medal).toBe(
              delay === 0 ? boundaryMedal : slowerMedal,
            );
          }
          expect(finalStep?.events.at(-1)).toMatchObject({
            type: 'finish',
            elapsedMs: split.getState().elapsedMs,
            result: split.getState().result,
          });
          expect(finalStep?.events.at(-1)?.fraction).toBeCloseTo(0.5, 10);
        }
      },
    );

    it.each(['invalid input', 'time overflow', 'late geometry overflow'])(
      'keeps hidden time accumulation atomic after %s',
      (failure) => {
        const race = running();
        const control = running();
        for (let index = 0; index < 7; index++) {
          race.step(origin, origin, 1 / 60);
          control.step(origin, origin, 1 / 60);
        }
        const before = race.getState();
        const fail = () => {
          if (failure === 'invalid input') {
            race.step(origin, origin, NaN);
          } else if (failure === 'time overflow') {
            race.step(origin, origin, Number.MAX_VALUE);
          } else {
            const far: Vector3 = [Number.MAX_VALUE, Number.MAX_VALUE, 0];
            race.step(far, far, 0.1);
          }
        };
        expect(fail).toThrow();
        expect(race.getState()).toBe(before);
        expect(race.getCollectedPearlIds()).toEqual([]);
        for (let index = 7; index < 720; index++) {
          race.step(origin, origin, 1 / 60);
          control.step(origin, origin, 1 / 60);
        }
        const result = race.step(origin, [0, -3, 40], 0.000002);
        const expected = control.step(origin, [0, -3, 40], 0.000002);
        expect(result).toEqual(expected);
        expect(result.state.elapsedMs).toBe(12_000 + 0.001);
        expect(result.state.result?.medal).toBe('silver');
      },
    );
  });
});
