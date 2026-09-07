import sunlit from '../../src/content/courses/sunlitShoals';
import type { SceneSnapshot } from '../../src/game/core/SceneRuntime';
import {
  PLAYER_RADIUS,
  SCENE_FISH_TUNING,
} from '../../src/game/core/sceneRuntimeTuning';
import type {
  CourseDefinition,
  Vector3,
} from '../../src/game/course/courseDefinition';
import type { InputFrame } from '../../src/game/input/InputFrame';
import { CurrentVolume } from '../../src/game/obstacles/CurrentVolume';
import {
  stepFishMotion,
  type FishState,
} from '../../src/game/player/stepFishMotion';
import {
  checkpointFraction,
  movementSegment,
  pickupFraction,
} from '../../src/game/race/raceGeometry';
import { scaleIntersection } from '../../src/game/race/raceIntersection';
import {
  compileSunlitPulseTopology,
  type SunlitPulsePath,
  type SunlitPulseTopology,
  type SunlitPulseTopologyWork,
} from './sunlitPulseTopology';
import { sunlitWaypoints } from './sunlitWaypointPolicy';

export type SunlitPulseKey = 'a' | 'd' | 'ArrowUp' | 'ArrowDown';

export interface SunlitPulseCommand {
  readonly brakeHeld: boolean;
  readonly pulse: SunlitPulseKey | null;
  readonly slowing?: boolean;
  readonly propel?: boolean;
  readonly accelerating?: boolean;
}

export interface SunlitPulseTiming {
  readonly onsetSteps: number;
  readonly holdSteps: number;
  readonly observationSteps: number;
  readonly skewSteps?: number;
  readonly releaseSkewSteps?: number;
}

export interface SunlitPulseEdge {
  readonly at: number;
  readonly key: SunlitPulseKey | 'Shift' | 's' | 'w';
  readonly type: 'keydown' | 'keyup';
}

export interface SunlitPulseObservation {
  readonly fish: SceneSnapshot['fish'];
  readonly steps: number;
  readonly previousSteps?: number;
  readonly brakeHeld: boolean;
  readonly slowing?: boolean;
  readonly accelerating?: boolean;
  readonly waypoint: number;
  readonly checkpointIndex: number;
  readonly collectedPearlIds: readonly string[];
  readonly approachingCheckpoint: boolean;
}

export type SunlitPulseForecast = ReturnType<typeof predictSunlitPulse>;
export type SunlitPulseWork = SunlitPulseTopologyWork;

export interface SunlitPulseMatrix {
  readonly candidates: readonly {
    readonly command: SunlitPulseCommand;
    readonly forecasts: readonly SunlitPulseForecast[];
  }[];
  readonly work: SunlitPulseWork;
}

export interface CompiledSunlitPulseEvaluator {
  readonly bounds: readonly (SunlitPulseWork & { readonly mask: number })[];
  evaluate(observed: SunlitPulseObservation): SunlitPulseMatrix;
}

interface PropagationState {
  fish: FishState;
  awarded: boolean[];
  awardAt: number[];
  contacts: Array<number | null>;
  clearance: number[];
  irreversibleMiss: number[];
  activeGoal: number;
}

interface PropagationContext {
  readonly goals: readonly SunlitPulseGoal[];
  readonly initiallyQualified: number;
  readonly waypoint: number;
  readonly brakeHeld: boolean;
  readonly slowing: boolean;
  readonly accelerating: boolean;
}

interface PulsePlan {
  readonly observeAt: number;
  readonly evaluationAt: number;
  readonly interventionAt: number;
}

interface PulseProgram {
  readonly topology: SunlitPulseTopology;
  readonly plans: readonly PulsePlan[];
}

interface GoalBase {
  readonly id: string;
  readonly position: Vector3;
  readonly steeringPosition: Vector3;
  readonly radius: number;
  readonly depth: number;
}

export type SunlitPulseGoal = GoalBase &
  (
    | {
        readonly kind: 'checkpoint';
        readonly definition: CourseDefinition['checkpoints'][number];
        readonly requiredCheckpoints: number;
        readonly terminal: boolean;
      }
    | { readonly kind: 'pearl' }
    | { readonly kind: 'recovery' }
  );

const currents = sunlit.objects
  .filter((object) => object.type === 'current')
  .map((definition) => {
    const volume = new CurrentVolume(definition);
    const { position, halfExtents } = volume.definition;
    // These authored volumes are uniform AABBs. Retain the authoritative sample
    // and inclusive faces instead of schema-parsing 17,000 forecast positions.
    const velocity = Object.freeze(volume.sampleCurrent(position));
    const minimum = position.map((value, axis) => value - halfExtents[axis]);
    const maximum = position.map((value, axis) => value + halfExtents[axis]);
    volume.dispose();
    return Object.freeze({ velocity, minimum, maximum });
  });
const horizon = 240;
const commands: readonly SunlitPulseCommand[] = Object.freeze(
  [
    { brakeHeld: false },
    { brakeHeld: false, accelerating: true },
    { brakeHeld: true },
    { brakeHeld: false, slowing: true },
    { brakeHeld: false, slowing: true, propel: true },
  ].flatMap((mode) =>
    ([null, 'a', 'd', 'ArrowUp', 'ArrowDown'] as const).map((pulse) =>
      Object.freeze({ ...mode, pulse }),
    ),
  ),
);
const symbolFrames: readonly Readonly<InputFrame>[] = Object.freeze(
  Array.from({ length: 108 }, (_, symbol) => {
    const frame = Math.floor(symbol / 2);
    return Object.freeze({
      steerY: (frame % 3) - 1,
      steerX: (Math.floor(frame / 3) % 3) - 1,
      throttle: (Math.floor(frame / 9) % 3) - 1,
      brakeHeld: frame >= 27,
      dashPressed: false,
      pausePressed: false,
    });
  }),
);

function currentAt(position: Vector3): [number, number, number] {
  const result: [number, number, number] = [0, 0, 0];
  for (const volume of currents) {
    if (
      position[0] < volume.minimum[0] ||
      position[0] > volume.maximum[0] ||
      position[1] < volume.minimum[1] ||
      position[1] > volume.maximum[1] ||
      position[2] < volume.minimum[2] ||
      position[2] > volume.maximum[2]
    )
      continue;
    for (let axis = 0; axis < 3; axis++) result[axis] += volume.velocity[axis];
  }
  return result;
}

function checkpointGoal(
  index: number,
  steeringPosition?: Vector3,
): SunlitPulseGoal {
  const definition = sunlit.checkpoints[index];
  if (!definition) throw new RangeError('Invalid Sunlit checkpoint.');
  return Object.freeze({
    kind: 'checkpoint',
    id: definition.id,
    position: definition.position,
    steeringPosition: steeringPosition ?? definition.position,
    depth: (steeringPosition ?? definition.position)[2],
    radius: definition.radius,
    definition,
    requiredCheckpoints: index + 1,
    terminal: index === sunlit.checkpoints.length - 1,
  });
}

export function sunlitPulseGoals(
  observed: SunlitPulseObservation,
  allRemaining = false,
): readonly SunlitPulseGoal[] {
  counter(observed.waypoint);
  counter(observed.checkpointIndex);
  if (
    observed.waypoint >= sunlitWaypoints.length ||
    observed.checkpointIndex > sunlit.checkpoints.length
  )
    throw new RangeError('Invalid Sunlit route observation.');
  if (observed.approachingCheckpoint) {
    const checkpoint = checkpointGoal(observed.checkpointIndex);
    const position: Vector3 = [
      checkpoint.position[0],
      checkpoint.position[1],
      checkpoint.position[2] - 6,
    ];
    return Object.freeze([
      Object.freeze({
        kind: 'recovery',
        id: `approach-${checkpoint.id}`,
        position,
        steeringPosition: position,
        depth: position[2],
        radius: 1,
      }),
      checkpoint,
      ...(allRemaining
        ? sunlitPulseGoals(
            { ...observed, approachingCheckpoint: false },
            true,
          ).slice(1)
        : []),
    ]);
  }
  return Object.freeze(
    sunlitWaypoints
      .slice(
        observed.waypoint,
        allRemaining ? undefined : observed.waypoint + 2,
      )
      .map((waypoint, offset): SunlitPulseGoal => {
        const index = observed.waypoint + offset;
        if (
          waypoint.checkpoints > (sunlitWaypoints[index - 1]?.checkpoints ?? 0)
        ) {
          return checkpointGoal(waypoint.checkpoints - 1, waypoint.position);
        }
        const pearl = sunlit.pearls[waypoint.pearls - 1];
        if (!pearl) throw new RangeError('Invalid Sunlit pearl waypoint.');
        return Object.freeze({
          kind: 'pearl',
          id: pearl.id,
          position: pearl.position,
          steeringPosition: waypoint.position,
          depth: waypoint.position[2],
          radius: pearl.radius + PLAYER_RADIUS,
        });
      }),
  );
}

function counter(value: number, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError('Pulse timing requires bounded integer counters.');
}

function pulseSkews(timing: SunlitPulseTiming) {
  const press = timing.skewSteps ?? 2;
  const release =
    timing.releaseSkewSteps === undefined ? press : timing.releaseSkewSteps;
  counter(press);
  counter(release);
  return { press, release };
}

export function sunlitPulseTimeline(
  oldBrake: boolean,
  command: SunlitPulseCommand,
  timing: SunlitPulseTiming,
  oldSlowing = false,
  oldAccelerating = false,
) {
  counter(timing.onsetSteps);
  counter(timing.holdSteps);
  counter(timing.observationSteps, 1);
  const { press, release } = pulseSkews(timing);
  if (
    typeof oldBrake !== 'boolean' ||
    typeof oldSlowing !== 'boolean' ||
    typeof oldAccelerating !== 'boolean' ||
    typeof command.brakeHeld !== 'boolean' ||
    (command.slowing !== undefined && typeof command.slowing !== 'boolean') ||
    (command.propel !== undefined && typeof command.propel !== 'boolean') ||
    (command.accelerating !== undefined &&
      typeof command.accelerating !== 'boolean') ||
    (command.accelerating &&
      (command.slowing || command.brakeHeld || command.propel)) ||
    (command.propel && (!command.slowing || command.brakeHeld)) ||
    (command.brakeHeld && command.slowing) ||
    (command.pulse !== null &&
      !['a', 'd', 'ArrowUp', 'ArrowDown'].includes(command.pulse))
  )
    throw new TypeError('Invalid native pulse command.');
  const age = Math.floor(timing.onsetSteps / 3);
  const budget = timing.onsetSteps - age;
  const before = new Set<SunlitPulseEdge['key']>([
    ...(oldBrake ? ['Shift' as const] : []),
    ...(oldSlowing ? ['s' as const] : []),
    ...(oldAccelerating ? ['w' as const] : []),
  ]);
  const after = new Set<SunlitPulseEdge['key']>([
    ...(command.brakeHeld ? ['Shift' as const] : []),
    ...(command.slowing ? ['s' as const] : []),
    ...(command.accelerating ? ['w' as const] : []),
  ]);
  const releases = [...before].filter((key) => !after.has(key));
  const presses = [...after].filter((key) => !before.has(key));
  const pulseKeys: SunlitPulseEdge['key'][] = [
    ...(command.propel ? ['w' as const] : []),
    ...(command.pulse === null ? [] : [command.pulse]),
  ];
  const phases =
    Number(releases.length > 0) +
    Number(presses.length > 0) +
    Number(pulseKeys.length > 0);
  const events: SunlitPulseEdge[] = [];
  let phase = 0;
  for (const [keys, type] of [
    [releases, 'keyup'],
    [presses, 'keydown'],
  ] as const) {
    if (keys.length) {
      const at = age + Math.floor((budget * ++phase) / phases);
      for (const key of keys) events.push({ at, key, type });
    }
  }
  for (const [index, key] of pulseKeys.entries()) {
    events.push({
      at: timing.onsetSteps + index * press,
      key,
      type: 'keydown',
    });
  }
  for (let index = pulseKeys.length - 1; index >= 0; index--) {
    events.push({
      at:
        timing.onsetSteps +
        (pulseKeys.length - 1) * press +
        timing.holdSteps +
        (pulseKeys.length - 1 - index) * release,
      key: pulseKeys[index],
      type: 'keyup',
    });
  }
  const observeAt = (events.at(-1)?.at ?? age) + timing.observationSteps;
  counter(observeAt, 1);
  return Object.freeze({
    age,
    events: Object.freeze(events.map((event) => Object.freeze(event))),
    observeAt,
  });
}

export function sunlitPulseScenarios(steps: number, previous?: number) {
  counter(steps);
  if (previous !== undefined) {
    counter(previous);
    if (previous > steps)
      throw new RangeError('Pulse observations must not decrease.');
  }
  // Observation cadence also includes commands (or none), so it is not a
  // transport measurement. Keep these declared synthetic cases independent.
  return Object.freeze([
    Object.freeze({ onsetSteps: 0, holdSteps: 6, observationSteps: 6 }),
    Object.freeze({ onsetSteps: 36, holdSteps: 12, observationSteps: 12 }),
    Object.freeze({ onsetSteps: 90, holdSteps: 18, observationSteps: 23 }),
  ]);
}

function distance(a: Vector3, b: Vector3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function checkpointClearance(
  from: Vector3,
  to: Vector3,
  goal: SunlitPulseGoal,
) {
  const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const radius = goal.radius - 0.15;
  const derivative = (at: number) => {
    const x = from[0] + delta[0] * at - goal.position[0];
    const y = from[1] + delta[1] * at - goal.position[1];
    const z = from[2] + delta[2] * at - goal.position[2];
    const radial = Math.hypot(x, y);
    return (
      z * delta[2] +
      (radial > radius
        ? (1 - radius / radial) * (x * delta[0] + y * delta[1])
        : 0)
    );
  };
  let at = 0;
  if (derivative(0) < 0) {
    at = 1;
    if (derivative(1) > 0) {
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 20; iteration++) {
        const middle = (low + high) / 2;
        if (derivative(middle) < 0) low = middle;
        else high = middle;
      }
      at = (low + high) / 2;
    }
  }
  const point = between(from, to, at);
  return Math.hypot(
    point[2] - goal.position[2],
    Math.max(
      0,
      Math.hypot(point[0] - goal.position[0], point[1] - goal.position[1]) -
        radius,
    ),
  );
}

function between(a: Vector3, b: Vector3, fraction: number): Vector3 {
  return [
    a[0] + (b[0] - a[0]) * fraction,
    a[1] + (b[1] - a[1]) * fraction,
    a[2] + (b[2] - a[2]) * fraction,
  ];
}

function segmentDistance(from: Vector3, to: Vector3, point: Vector3) {
  const segment = movementSegment(from, to);
  const square = segment.delta.reduce((sum, value) => sum + value * value, 0);
  const dot = segment.delta.reduce(
    (sum, value, axis) => sum + value * (point[axis] - from[axis]),
    0,
  );
  return distance(
    between(
      from,
      to,
      square === 0 ? 0 : Math.max(0, Math.min(1, dot / square)),
    ),
    point,
  );
}

function boundedGeometryCoordinate(value: number) {
  // Leave room for three-dimensional endpoint differences and their norms.
  return Math.abs(value) <= Number.MAX_VALUE / 8;
}

function outsidePickupBounds(
  from: Vector3,
  to: Vector3,
  goal: SunlitPulseGoal,
) {
  // Keep the authoritative overflow/error path for extreme coordinates.
  if (
    !from.every(boundedGeometryCoordinate) ||
    !to.every(boundedGeometryCoordinate) ||
    !goal.position.every(boundedGeometryCoordinate) ||
    !boundedGeometryCoordinate(goal.radius) ||
    goal.radius < 0
  )
    return false;
  for (let axis = 0; axis < 3; axis++) {
    // Strict comparisons also retain contacts on rounded box faces. Both
    // endpoints on one side exclude every point of the exact segment.
    if (
      Math.max(from[axis], to[axis]) < goal.position[axis] - goal.radius ||
      Math.min(from[axis], to[axis]) > goal.position[axis] + goal.radius
    )
      return true;
  }
  return false;
}

function potential(
  fish: FishState,
  goals: readonly SunlitPulseGoal[],
  first: number,
  awarded: readonly boolean[],
  routeStart: number,
) {
  // Awards relax a vertex from required to optional. Keep even past vertices:
  // squared leg costs do not satisfy triangle inequality, so deleting one can
  // lose a cheaper feasible route. The route cursor must not change this graph.
  const vertices = [
    ...sunlitWaypoints.slice(0, routeStart).map((goal) => ({
      position: goal.position,
      required: false,
    })),
    ...goals.map((goal, index) => ({
      position: goal.steeringPosition,
      required: index >= first && (goal.kind === 'recovery' || !awarded[index]),
    })),
  ];
  const costs: number[] = [];
  let lastRequired = -1;
  for (const [index, vertex] of vertices.entries()) {
    let cost =
      lastRequired < 0
        ? distance(fish.position, vertex.position) ** 2
        : Infinity;
    for (
      let previous = Math.max(0, lastRequired);
      previous < index;
      previous++
    ) {
      cost = Math.min(
        cost,
        costs[previous] +
          distance(vertices[previous].position, vertex.position) ** 2,
      );
    }
    costs.push(cost);
    if (vertex.required) lastRequired = index;
  }
  const aims = goals.slice(first).flatMap((next, offset) => {
    const index = first + offset;
    if (
      index < goals.length - 1 &&
      (next.kind === 'checkpoint' || awarded[index])
    )
      return [];
    return [next.steeringPosition];
  });
  const current = currentAt(fish.position);
  let yaw = fish.yaw;
  let pitch = fish.pitch;
  let velocity: readonly number[] = fish.velocity;
  let yawDistance = 0;
  let pitchDistance = 0;
  let velocityDistance = 0;
  // The following orientation is already an obligation before collection.
  // Removing an earned intermediate aim cannot increase these path lengths.
  for (const aim of aims) {
    const delta = aim.map((value, axis) => value - fish.position[axis]);
    const length = Math.hypot(...delta);
    const speed = Math.min(6, Math.max(2, 2 * length));
    const body = delta.map(
      (value, axis) => (length ? (value * speed) / length : 0) - current[axis],
    );
    const nextYaw =
      Math.hypot(...body) === 0 ? yaw : Math.atan2(body[0], body[2]);
    const nextPitch =
      Math.hypot(...body) === 0
        ? pitch
        : Math.atan2(body[1], Math.hypot(body[0], body[2]));
    yawDistance += Math.abs(
      Math.atan2(Math.sin(nextYaw - yaw), Math.cos(nextYaw - yaw)),
    );
    pitchDistance += Math.abs(nextPitch - pitch);
    velocityDistance += Math.hypot(
      ...body.map((value, axis) => value - velocity[axis]),
    );
    yaw = nextYaw;
    pitch = nextPitch;
    velocity = body;
  }
  return Object.freeze({
    distance: lastRequired < 0 ? 0 : 0.25 * costs[lastRequired],
    heading: 0.5 * (yawDistance ** 2 + pitchDistance ** 2),
    velocity: 0.1 * velocityDistance ** 2,
  });
}

export function predictSunlitPulse(
  observed: SunlitPulseObservation,
  command: SunlitPulseCommand,
  timing: SunlitPulseTiming,
) {
  const plan = validatePrediction(observed, command, timing);
  const { state, context } = createPropagation(observed);
  let boundaryFish = state.fish;
  let evaluationFish = state.fish;
  let brakeHeld = observed.brakeHeld;
  let slowing = observed.slowing ?? false;
  let propelling = observed.accelerating ?? false;
  let steerX = 0;
  let steerY = 0;
  let nextEvent = 0;
  for (let tick = 0; tick < horizon; tick++) {
    while (plan.timeline.events[nextEvent]?.at === tick) {
      const event = plan.timeline.events[nextEvent++];
      const down = event.type === 'keydown';
      if (event.key === 'Shift') brakeHeld = down;
      else if (event.key === 's') slowing = down;
      else if (event.key === 'w') propelling = down;
      else if (event.key === 'a' || event.key === 'd')
        steerX = down ? (event.key === 'a' ? 1 : -1) : 0;
      else steerY = down ? (event.key === 'ArrowUp' ? 1 : -1) : 0;
    }
    const completed = tick + 1;
    advanceOwned(
      state,
      context,
      {
        steerX,
        steerY,
        brakeHeld,
        throttle: Number(propelling) - Number(slowing),
        dashPressed: false,
        pausePressed: false,
      },
      completed,
      completed === plan.observeAt,
      completed <= plan.interventionAt,
    );
    if (completed === plan.observeAt) boundaryFish = state.fish;
    if (completed === plan.evaluationAt) evaluationFish = state.fish;
  }
  return finalizePulse(
    state,
    context,
    command,
    plan,
    horizon,
    boundaryFish,
    evaluationFish,
  );
}

function pulseEvaluationAt(timing: SunlitPulseTiming, observeAt: number) {
  const { press, release } = pulseSkews(timing);
  const evaluationAt =
    timing.onsetSteps +
    timing.holdSteps +
    press +
    release +
    timing.observationSteps;
  if (observeAt > horizon || evaluationAt > horizon)
    throw new RangeError('Pulse observation exceeds the prediction horizon.');
  return evaluationAt;
}

function validatePrediction(
  observed: SunlitPulseObservation,
  command: SunlitPulseCommand,
  timing: SunlitPulseTiming,
) {
  counter(observed.steps);
  const original = observed.fish;
  if (
    ![
      ...original.position,
      ...original.velocity,
      original.yaw,
      original.pitch,
      original.roll,
      original.dashEnergy,
    ].every(Number.isFinite)
  )
    throw new RangeError('Pulse prediction requires finite motion.');
  const timeline = sunlitPulseTimeline(
    observed.brakeHeld,
    command,
    timing,
    observed.slowing,
    observed.accelerating,
  );
  // Value every candidate at the longest supported command cycle, not its own
  // earlier or later observation. Actual observations keep their original times.
  const evaluationAt = pulseEvaluationAt(timing, timeline.observeAt);
  // The next delivery is independent of this one; a prompt observation cannot
  // promise a prompt correction. This is a synthetic stress case, not a bound.
  const correctionSteps = Math.max(
    ...sunlitPulseScenarios(observed.steps, observed.previousSteps).map(
      (next) => next.onsetSteps + next.holdSteps,
    ),
  );
  const interventionAt = Math.min(horizon, evaluationAt + correctionSteps);
  return {
    timeline,
    observeAt: timeline.observeAt,
    evaluationAt,
    interventionAt,
  };
}

function copyFish(fish: SceneSnapshot['fish']): FishState {
  return {
    ...fish,
    position: [...fish.position],
    velocity: [...fish.velocity],
  };
}

function createPropagation(observed: SunlitPulseObservation): {
  context: PropagationContext;
  state: PropagationState;
} {
  const original = observed.fish;
  const goals = sunlitPulseGoals(observed, true);
  const awarded = goals.map((goal) =>
    goal.kind === 'checkpoint'
      ? observed.checkpointIndex >= goal.requiredCheckpoints
      : goal.kind === 'pearl' && observed.collectedPearlIds.includes(goal.id),
  );
  const awardAt = awarded.map((value) => (value ? 0 : Infinity));
  const contacts: Array<number | null> = goals.map(() => null);
  const clearance = goals.map(() => Infinity);
  const irreversibleMiss = goals.map(() => 0);
  let initiallyQualified = 0;
  for (let index = 0; index < goals.length; index++) {
    const goal = goals[index];
    if (index && contacts[index - 1] === null) break;
    if (
      (goal.kind === 'recovery' &&
        distance(original.position, goal.position) <= goal.radius) ||
      (awarded[index] &&
        (original.position[2] >= goal.depth ||
          (goal.kind === 'checkpoint' && goal.terminal)))
    ) {
      contacts[index] = 0;
      clearance[index] = 0;
      initiallyQualified++;
    }
  }
  return {
    context: Object.freeze({
      goals,
      initiallyQualified,
      waypoint: observed.waypoint,
      brakeHeld: observed.brakeHeld,
      slowing: observed.slowing ?? false,
      accelerating: observed.accelerating ?? false,
    }),
    state: {
      fish: copyFish(original),
      awarded,
      awardAt,
      contacts,
      clearance,
      irreversibleMiss,
      activeGoal: initiallyQualified,
    },
  };
}

function forkState(parent: PropagationState): PropagationState {
  return {
    ...parent,
    awarded: parent.awarded.slice(),
    awardAt: parent.awardAt.slice(),
    contacts: parent.contacts.slice(),
    clearance: parent.clearance.slice(),
    irreversibleMiss: parent.irreversibleMiss.slice(),
  };
}

function advanceOwned(
  state: PropagationState,
  context: PropagationContext,
  input: Readonly<InputFrame>,
  completed: number,
  observeRecovery: boolean,
  riskActive: boolean,
) {
  const { goals } = context;
  const { awarded, awardAt, contacts, clearance, irreversibleMiss } = state;
  const previous = state.fish.position;
  state.fish = stepFishMotion(
    state.fish,
    input,
    SCENE_FISH_TUNING,
    { current: currentAt(state.fish.position), waterSurfaceY: 0 },
    1 / 60,
  ).next;
  const fish = state.fish;
  const tick = completed - 1;
  for (let index = state.activeGoal; index < goals.length; index++) {
    if (contacts[index] !== null) {
      state.activeGoal = index + 1;
      continue;
    }
    const eligible = index === 0 ? 0 : contacts[index - 1];
    if (eligible === null || eligible > completed) break;
    const goal = goals[index];
    const fraction = Math.max(0, eligible - tick);
    const from = between(previous, fish.position, fraction);
    if (goal.kind === 'recovery') {
      if (observeRecovery) {
        const remaining = distance(fish.position, goal.position);
        clearance[index] = Math.max(0, remaining - (goal.radius - 0.15));
        if (remaining <= goal.radius) contacts[index] = completed;
      }
      continue;
    }
    clearance[index] = Math.min(
      clearance[index],
      awarded[index]
        ? Math.max(0, goal.depth - Math.max(from[2], fish.position[2]))
        : goal.kind === 'checkpoint'
          ? checkpointClearance(from, fish.position, goal)
          : Math.max(
              0,
              goal.depth - Math.max(from[2], fish.position[2]),
              segmentDistance(from, fish.position, goal.position) -
                (goal.radius - 0.15),
            ),
    );
    const crossing =
      from[2] < goal.position[2] && fish.position[2] >= goal.position[2];
    if (!awarded[index]) {
      const segment = movementSegment(from, fish.position);
      let contact: number | null = null;
      if (goal.kind === 'pearl') {
        if (!outsidePickupBounds(from, fish.position, goal))
          contact = pickupFraction(segment, goal.position, goal.radius);
      } else if (crossing) {
        const exact = checkpointFraction(segment, goal.definition);
        if (exact) contact = scaleIntersection(exact, 1);
      }
      if (contact !== null) {
        awarded[index] = true;
        awardAt[index] = tick + fraction + contact * (1 - fraction);
      }
    }
    const missDepth =
      goal.position[2] + (goal.kind === 'pearl' ? goal.radius : 0);
    const passed = from[2] < missDepth && fish.position[2] >= missDepth;
    if (passed && !awarded[index] && riskActive) {
      const at = (missDepth - from[2]) / (fish.position[2] - from[2]);
      const miss =
        goal.kind === 'pearl'
          ? clearance[index]
          : Math.max(
              0,
              distance(between(from, fish.position, at), goal.position) -
                (goal.radius - 0.15),
            );
      irreversibleMiss[index] = Math.max(
        irreversibleMiss[index],
        16 * (1 + miss) ** 2,
      );
    }
    if (awarded[index]) {
      if (goal.kind === 'checkpoint' && goal.terminal)
        contacts[index] = awardAt[index];
      else if (fish.position[2] >= goal.depth) {
        const depthAt =
          from[2] >= goal.depth
            ? tick + fraction
            : tick +
              fraction +
              ((1 - fraction) * (goal.depth - from[2])) /
                (fish.position[2] - from[2]);
        contacts[index] = Math.max(awardAt[index], depthAt);
      }
    }
  }
}

function finalizePulse(
  state: PropagationState,
  context: PropagationContext,
  command: SunlitPulseCommand,
  plan: PulsePlan,
  motionSteps: number,
  boundaryFish: FishState,
  evaluationFish: FishState,
) {
  const { fish, awardAt, contacts, irreversibleMiss, clearance } = state;
  const { goals, initiallyQualified, waypoint } = context;
  const { observeAt, evaluationAt, interventionAt } = plan;
  function firstPending(
    sample: FishState,
    at: number,
    previouslyQualified: number,
  ) {
    return goals.findIndex((goal, index) => {
      if (index < previouslyQualified) return false;
      if (goal.kind === 'recovery')
        return contacts[index] === null || contacts[index] > at;
      // Awards persist, but an unseen depth crossing does not qualify a sample.
      return (
        awardAt[index] > at ||
        (!(goal.kind === 'checkpoint' && goal.terminal) &&
          sample.position[2] < goal.depth)
      );
    });
  }
  const boundaryGoalIndex = firstPending(
    boundaryFish,
    observeAt,
    initiallyQualified,
  );
  const boundaryAwards = awardAt.map((at) => at <= observeAt);
  const boundaryPotentialTerms =
    boundaryGoalIndex === -1
      ? Object.freeze({ distance: 0, heading: 0, velocity: 0 })
      : potential(
          boundaryFish,
          goals,
          boundaryGoalIndex,
          boundaryAwards,
          waypoint,
        );
  const boundaryPotential = Object.values(boundaryPotentialTerms).reduce(
    (sum, value) => sum + value,
    0,
  );
  const evaluationGoalIndex = firstPending(
    evaluationFish,
    evaluationAt,
    boundaryGoalIndex === -1 ? goals.length : boundaryGoalIndex,
  );
  const evaluationPotentialTerms =
    evaluationGoalIndex === -1
      ? Object.freeze({ distance: 0, heading: 0, velocity: 0 })
      : potential(
          evaluationFish,
          goals,
          evaluationGoalIndex,
          awardAt.map((at) => at <= evaluationAt),
          waypoint,
        );
  const evaluationPotential = Object.values(evaluationPotentialTerms).reduce(
    (sum, value) => sum + value,
    0,
  );
  // Contacts in the uncontrolled tail are diagnostics, not credit for a plan
  // that was never issued. Only the common evaluation state earns progress.
  const arrival =
    evaluationGoalIndex === -1
      ? (contacts.at(-1) ?? evaluationAt)
      : evaluationAt;
  const score =
    evaluationPotential +
    0.003 * arrival +
    (context.brakeHeld === command.brakeHeld ? 0 : 0.05) +
    (context.slowing === Boolean(command.slowing) ? 0 : 0.05) +
    (context.accelerating === Boolean(command.accelerating) ? 0 : 0.05);
  if (!Number.isFinite(score))
    throw new RangeError('Pulse prediction cost overflow.');
  const terminal = copyFish(fish);
  const boundary = boundaryFish === fish ? terminal : copyFish(boundaryFish);
  const evaluation =
    evaluationFish === fish
      ? terminal
      : evaluationFish === boundaryFish
        ? boundary
        : copyFish(evaluationFish);
  return Object.freeze({
    score,
    interventionAt,
    boundaryFish: boundary,
    fish: terminal,
    boundaryPotential,
    boundaryPotentialTerms,
    evaluationAt,
    evaluationFish: evaluation,
    evaluationPotential,
    evaluationPotentialTerms,
    evaluationGoalIndex:
      evaluationGoalIndex === -1 ? goals.length : evaluationGoalIndex,
    missPenalties: Object.freeze(irreversibleMiss.slice()),
    minimumClearance: Object.freeze(clearance.slice()),
    boundaryGoalIndex:
      boundaryGoalIndex === -1 ? goals.length : boundaryGoalIndex,
    completedGoals: contacts.filter((at) => at !== null).length,
    contacts: Object.freeze(contacts.slice()),
    motionSteps,
  });
}

export function compileSunlitPulseEvaluator(
  timings: readonly SunlitPulseTiming[],
): CompiledSunlitPulseEvaluator {
  if (!Array.isArray(timings))
    throw new TypeError('Pulse evaluator requires a timing array.');
  if (timings.length < 1 || timings.length > 5)
    throw new RangeError('Pulse evaluator requires one to five timings.');
  const canonical = Array.from(timings, (timing: SunlitPulseTiming) => {
    if (timing === null || typeof timing !== 'object' || Array.isArray(timing))
      throw new TypeError('Pulse evaluator requires timing objects.');
    const copy = Object.freeze({
      onsetSteps: timing.onsetSteps,
      holdSteps: timing.holdSteps,
      observationSteps: timing.observationSteps,
      skewSteps: timing.skewSteps,
      releaseSkewSteps: timing.releaseSkewSteps,
    });
    const timeline = sunlitPulseTimeline(false, commands[0], copy);
    const evaluationAt = pulseEvaluationAt(copy, timeline.observeAt);
    return {
      timing: copy,
      evaluationAt,
      interventionAt: Math.min(horizon, evaluationAt + 108),
    };
  });
  const programs: PulseProgram[] = [];
  for (let mask = 0; mask < 8; mask++) {
    const paths: SunlitPulsePath[] = [];
    for (const command of commands) {
      for (const { timing, evaluationAt, interventionAt } of canonical) {
        let brakeHeld = Boolean(mask & 4);
        let slowing = Boolean(mask & 2);
        let propelling = Boolean(mask & 1);
        let steerX = 0;
        let steerY = 0;
        let cursor = 0;
        const timeline = sunlitPulseTimeline(
          brakeHeld,
          command,
          timing,
          slowing,
          propelling,
        );
        const symbols: number[] = [];
        for (let tick = 0; tick < interventionAt; tick++) {
          while (timeline.events[cursor]?.at === tick) {
            const event = timeline.events[cursor++];
            const down = event.type === 'keydown';
            if (event.key === 'Shift') brakeHeld = down;
            else if (event.key === 's') slowing = down;
            else if (event.key === 'w') propelling = down;
            else if (event.key === 'a' || event.key === 'd')
              steerX = down ? (event.key === 'a' ? 1 : -1) : 0;
            else steerY = down ? (event.key === 'ArrowUp' ? 1 : -1) : 0;
          }
          const throttle = Number(propelling) - Number(slowing);
          const frame =
            ((Number(brakeHeld) * 3 + throttle + 1) * 3 + steerX + 1) * 3 +
            steerY +
            1;
          symbols.push(frame * 2 + Number(tick + 1 === timeline.observeAt));
        }
        paths.push({ symbols, observeAt: timeline.observeAt, evaluationAt });
      }
    }
    programs.push(
      Object.freeze({
        topology: compileSunlitPulseTopology(paths),
        plans: Object.freeze(
          paths.map((path) =>
            Object.freeze({
              observeAt: path.observeAt,
              evaluationAt: path.evaluationAt,
              interventionAt: path.symbols.length,
            }),
          ),
        ),
      }),
    );
  }
  return compiledEvaluator(
    Object.freeze(programs),
    canonical[0].timing,
    canonical.length,
  );
}

function compiledEvaluator(
  programs: readonly PulseProgram[],
  firstTiming: SunlitPulseTiming,
  scenarioCount: number,
): CompiledSunlitPulseEvaluator {
  return Object.freeze({
    bounds: Object.freeze(
      programs.map((program, mask) =>
        Object.freeze({ ...program.topology.work, mask }),
      ),
    ),
    evaluate(observed: SunlitPulseObservation): SunlitPulseMatrix {
      validatePrediction(observed, commands[0], firstTiming);
      const mask =
        Number(observed.brakeHeld) * 4 +
        Number(observed.slowing ?? false) * 2 +
        Number(observed.accelerating ?? false);
      return evaluateProgram(programs[mask], observed, scenarioCount);
    },
  });
}

function readState(
  arena: readonly (PropagationState | undefined)[],
  slot: number,
): PropagationState {
  const state = arena[slot];
  if (!state)
    throw new Error('Pulse prefix state retired before its final reader.');
  return state;
}

function evaluateProgram(
  program: PulseProgram,
  observed: SunlitPulseObservation,
  scenarioCount: number,
): SunlitPulseMatrix {
  const { context, state: root } = createPropagation(observed);
  const arena = new Array<PropagationState | undefined>(
    program.topology.work.stateIndexSlots,
  );
  arena[0] = root;
  let integrations = 0;
  let expandedTicks = 0;
  let propagationStateAllocations = 1;
  let peakOwnedStates = 1;
  let live = 1;
  const candidates: Array<{
    command: SunlitPulseCommand;
    forecasts: SunlitPulseForecast[];
  }> = commands.map((command) => ({
    command,
    forecasts: [],
  }));
  try {
    const operations = program.topology.operations;
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      if (operation.kind === 'advance') {
        let state = readState(arena, operation.parentSlot);
        if (operation.takeParent) {
          arena[operation.parentSlot] = undefined;
          live--;
        } else {
          state = forkState(state);
          propagationStateAllocations++;
        }
        arena[operation.nodeSlot] = state;
        live++;
        peakOwnedStates = Math.max(peakOwnedStates, live);
        integrations++;
        advanceOwned(
          state,
          context,
          symbolFrames[operation.symbol],
          operation.depth,
          operation.symbol % 2 === 1,
          true,
        );
      } else {
        const candidate = candidates[Math.floor(operation.row / scenarioCount)];
        const plan = program.plans[operation.row];
        candidate.forecasts.push(
          finalizePulse(
            readState(arena, operation.leafSlot),
            context,
            candidate.command,
            plan,
            plan.interventionAt,
            readState(arena, operation.boundarySlot).fish,
            readState(arena, operation.evaluationSlot).fish,
          ),
        );
        expandedTicks += plan.interventionAt;
      }
      for (const slot of operation.retireSlots) {
        readState(arena, slot);
        arena[slot] = undefined;
        live--;
      }
    }
    return Object.freeze({
      candidates: Object.freeze(
        candidates.map(({ command, forecasts }) =>
          Object.freeze({ command, forecasts: Object.freeze(forecasts) }),
        ),
      ),
      work: Object.freeze({
        integrations,
        expandedTicks,
        propagationStateAllocations,
        peakOwnedStates,
        stateIndexSlots: arena.length,
        finalLiveStates: live,
      }),
    });
  } finally {
    arena.fill(undefined);
  }
}

let prepared = false;
let policyEvaluator: CompiledSunlitPulseEvaluator | undefined;

export function prepareSunlitPulsePolicy(): void {
  if (prepared) return;
  // Exercise the pure planner before native course activation, not while the
  // unobserved race advances. This synthetic state never reaches the game.
  sunlitPulsePolicy({
    fish: {
      position: sunlit.spawn.position,
      velocity: [0, 0, 0],
      yaw: sunlit.spawn.yaw,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    },
    steps: 0,
    waypoint: 0,
    approachingCheckpoint: false,
    brakeHeld: false,
    checkpointIndex: 0,
    collectedPearlIds: [],
  });
  prepared = true;
}

export function sunlitPulsePolicy(observed: SunlitPulseObservation) {
  const declared = sunlitPulseScenarios(observed.steps, observed.previousSteps);
  // The declared samples correlate onset and hold. Exercise the demonstrated
  // early/long interaction too; these four samples are still not timing bounds.
  const timings = [
    ...declared,
    {
      ...declared[0],
      holdSteps: Math.max(...declared.map((value) => value.holdSteps)),
    },
  ];
  const candidates: Array<{
    command: SunlitPulseCommand;
    costs: number[];
    worstMiss: number;
  }> = [];
  policyEvaluator ??= compileSunlitPulseEvaluator(timings);
  const matrix = policyEvaluator.evaluate(observed);
  const motionSteps = matrix.work.expandedTicks;
  for (const { command, forecasts: predictions } of matrix.candidates) {
    candidates.push({
      command,
      costs: predictions.map((prediction) => prediction.score),
      worstMiss: Math.max(
        ...predictions.flatMap((prediction) => prediction.missPenalties),
      ),
    });
  }
  // Each timing has its own physical evaluation time. Compare lost opportunity
  // within that timing, not raw remaining distance across unequal clocks.
  const idealCosts = timings.map((_, index) =>
    Math.min(...candidates.map((candidate) => candidate.costs[index])),
  );
  let best:
    | (SunlitPulseCommand & {
        worstCost: number;
        meanCost: number;
        worstMiss: number;
      })
    | undefined;
  let stationaryCost = Infinity;
  for (const { command, costs, worstMiss } of candidates) {
    const regrets = costs.map((cost, index) => cost - idealCosts[index]);
    const worstCost = Math.max(...regrets);
    const meanCost =
      regrets.reduce((sum, value) => sum + value, 0) / regrets.length;
    if (command.brakeHeld && command.pulse === null) stationaryCost = worstCost;
    if (
      !best ||
      worstMiss < best.worstMiss ||
      (worstMiss === best.worstMiss &&
        (worstCost < best.worstCost ||
          (worstCost === best.worstCost && meanCost < best.meanCost)))
    ) {
      best = { ...command, worstCost, meanCost, worstMiss };
    }
  }
  if (!best) throw new Error('Pulse prediction produced no command.');
  return Object.freeze({ ...best, stationaryCost, motionSteps });
}
