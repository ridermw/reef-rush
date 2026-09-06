import { describe, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import { SCENE_FISH_TUNING } from '../../src/game/core/sceneRuntimeTuning';
import { InputController } from '../../src/game/input/InputController';
import { CurrentVolume } from '../../src/game/obstacles/CurrentVolume';
import {
  stepFishMotion,
  type FishState,
} from '../../src/game/player/stepFishMotion';
import * as raceGeometry from '../../src/game/race/raceGeometry';
import * as control from '../fixtures/sunlitPulsePolicy';
import {
  advanceSunlitWaypoint,
  sunlitWaypoints,
} from '../fixtures/sunlitWaypointPolicy';

function timeline() {
  expect(control.sunlitPulseTimeline).toBeTypeOf('function');
  return control.sunlitPulseTimeline;
}

function scenarios() {
  expect(control.sunlitPulseScenarios).toBeTypeOf('function');
  return control.sunlitPulseScenarios;
}

const timing = { onsetSteps: 12, holdSteps: 8, observationSteps: 6 };

const recordedChord = {
  brakeHeld: false,
  slowing: true,
  propel: true,
  pulse: 'ArrowDown',
} as const;
const asymmetricTiming = {
  onsetSteps: 30,
  holdSteps: 10,
  observationSteps: 15,
  skewSteps: 11,
  releaseSkewSteps: 5,
};

describe('asymmetric release skew', () => {
  it('represents the recorded chord with S retained', () => {
    expect(
      control.sunlitPulseTimeline(false, recordedChord, asymmetricTiming, true),
    ).toEqual({
      age: 10,
      events: [
        { at: 30, key: 'w', type: 'keydown' },
        { at: 41, key: 'ArrowDown', type: 'keydown' },
        { at: 51, key: 'ArrowDown', type: 'keyup' },
        { at: 56, key: 'w', type: 'keyup' },
      ],
      observeAt: 71,
    });
  });

  it('uses completion for common valuation and risk truncation, not no-op observation', () => {
    const start = { ...observation(), slowing: true };
    const predicted = control.predictSunlitPulse(
      start,
      recordedChord,
      asymmetricTiming,
    );
    expect([predicted.evaluationAt, predicted.interventionAt]).toEqual([
      71, 179,
    ]);
    expect(predicted.boundaryFish).toBe(predicted.evaluationFish);
    const idle = { brakeHeld: false, slowing: true, pulse: null };
    expect(
      control.sunlitPulseTimeline(false, idle, asymmetricTiming, true),
    ).toEqual({ age: 10, events: [], observeAt: 25 });
    const noOp = control.predictSunlitPulse(start, idle, asymmetricTiming);
    expect(noOp.evaluationAt).toBe(71);
    expect(noOp.boundaryFish).not.toEqual(noOp.evaluationFish);
  });

  it.each([
    { brakeHeld: false, slowing: true, propel: true, pulse: null },
    { brakeHeld: false, slowing: true, pulse: 'ArrowDown' as const },
  ])('does not invent a second key for $pulse/$propel', (command) => {
    const delivered = control.sunlitPulseTimeline(
      false,
      command,
      asymmetricTiming,
      true,
    );
    expect(delivered.events.map((edge) => edge.at)).toEqual([30, 40]);
    expect(delivered.observeAt).toBe(55);
    expect(
      control.predictSunlitPulse(
        { ...observation(), slowing: true },
        command,
        asymmetricTiming,
      ).evaluationAt,
    ).toBe(71);
  });

  it('accepts zero release skew while preserving reverse release order', () => {
    const value = { ...asymmetricTiming, releaseSkewSteps: 0 };
    const delivered = control.sunlitPulseTimeline(
      false,
      recordedChord,
      value,
      true,
    );
    expect(delivered.events.slice(-2)).toEqual([
      { at: 51, key: 'ArrowDown', type: 'keyup' },
      { at: 51, key: 'w', type: 'keyup' },
    ]);
    expect(delivered.observeAt).toBe(66);
  });

  it('keeps all zero-length chord edges ordered at zero', () => {
    const value = {
      onsetSteps: 0,
      holdSteps: 0,
      observationSteps: 1,
      skewSteps: 0,
      releaseSkewSteps: 0,
    };
    expect(
      control.sunlitPulseTimeline(false, recordedChord, value, true),
    ).toEqual({
      age: 0,
      events: [
        { at: 0, key: 'w', type: 'keydown' },
        { at: 0, key: 'ArrowDown', type: 'keydown' },
        { at: 0, key: 'ArrowDown', type: 'keyup' },
        { at: 0, key: 'w', type: 'keyup' },
      ],
      observeAt: 1,
    });
    expect(
      control.predictSunlitPulse(
        { ...observation(), slowing: true },
        recordedChord,
        value,
      ).evaluationAt,
    ).toBe(1);
  });

  it.each([
    null,
    '5',
    true,
    false,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid release skew %s even without operations',
    (releaseSkewSteps) => {
      const value: control.SunlitPulseTiming = { ...timing };
      Object.assign(value, { releaseSkewSteps });
      for (const command of [
        recordedChord,
        { brakeHeld: false, slowing: true, pulse: null },
      ]) {
        expect(() =>
          control.sunlitPulseTimeline(false, command, value, true),
        ).toThrow(
          new RangeError('Pulse timing requires bounded integer counters.'),
        );
      }
    },
  );

  it('accepts the exact prediction horizon without capping general timelines', () => {
    const value = {
      onsetSteps: 0,
      holdSteps: 0,
      observationSteps: 1,
      skewSteps: 0,
      releaseSkewSteps: 239,
    };
    const start = { ...observation(), slowing: true };
    const predicted = control.predictSunlitPulse(start, recordedChord, value);
    expect([
      predicted.evaluationAt,
      predicted.interventionAt,
      predicted.motionSteps,
    ]).toEqual([240, 240, 240]);
    const beyond = { ...value, releaseSkewSteps: 240 };
    expect(
      control.sunlitPulseTimeline(false, recordedChord, beyond, true).observeAt,
    ).toBe(241);
    expect(() =>
      control.predictSunlitPulse(start, recordedChord, beyond),
    ).toThrow(
      new RangeError('Pulse observation exceeds the prediction horizon.'),
    );
  });

  it('rejects unsafe completion without clamping', () => {
    const value = {
      onsetSteps: 0,
      holdSteps: 0,
      observationSteps: 1,
      skewSteps: 0,
      releaseSkewSteps: Number.MAX_SAFE_INTEGER,
    };
    expect(() =>
      control.sunlitPulseTimeline(false, recordedChord, value, true),
    ).toThrow(
      new RangeError('Pulse timing requires bounded integer counters.'),
    );
    expect(
      control.sunlitPulseTimeline(
        false,
        recordedChord,
        {
          ...value,
          releaseSkewSteps: Number.MAX_SAFE_INTEGER - 1,
        },
        true,
      ).observeAt,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('retains no-op time with valid huge unused skews but rejects its forecast horizon', () => {
    const idle = { brakeHeld: false, slowing: true, pulse: null };
    const value = {
      ...asymmetricTiming,
      skewSteps: Number.MAX_SAFE_INTEGER,
      releaseSkewSteps: Number.MAX_SAFE_INTEGER,
    };
    expect(control.sunlitPulseTimeline(false, idle, value, true)).toEqual({
      age: 10,
      events: [],
      observeAt: 25,
    });
    expect(() =>
      control.predictSunlitPulse(
        { ...observation(), slowing: true },
        idle,
        value,
      ),
    ).toThrow(
      new RangeError('Pulse observation exceeds the prediction horizon.'),
    );
  });

  it('retains legacy nullish press skew behavior', () => {
    const legacy: control.SunlitPulseTiming = { ...timing };
    Object.assign(legacy, { skewSteps: null });
    expect(
      control.sunlitPulseTimeline(false, recordedChord, legacy, true),
    ).toEqual(control.sunlitPulseTimeline(false, recordedChord, timing, true));
  });

  it('preserves complete default forecasts for all 25 commands and four timings', () => {
    const start = observation();
    const declared = control.sunlitPulseScenarios(start.steps);
    const timings: readonly control.SunlitPulseTiming[] = [
      ...declared,
      { ...declared[0], holdSteps: 18 },
    ];
    let checked = 0;
    for (const mode of [
      { brakeHeld: false },
      { brakeHeld: false, accelerating: true },
      { brakeHeld: true },
      { brakeHeld: false, slowing: true },
      { brakeHeld: false, slowing: true, propel: true },
    ]) {
      for (const pulse of [null, 'a', 'd', 'ArrowUp', 'ArrowDown'] as const) {
        const command = { ...mode, pulse };
        for (const value of timings) {
          const expected = control.predictSunlitPulse(start, command, value);
          expect(
            control.predictSunlitPulse(start, command, {
              ...value,
              releaseSkewSteps: undefined,
            }),
          ).toEqual(expected);
          expect(
            control.predictSunlitPulse(start, command, {
              ...value,
              releaseSkewSteps: value.skewSteps ?? 2,
            }),
          ).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(100);
  });
});

it('does not solve pearl intersections for disjoint movement boxes', () => {
  const start = {
    ...observation(),
    waypoint: 1,
    checkpointIndex: 1,
    slowing: true,
    fish: {
      ...observation().fish,
      position: [100, -4, 0],
      velocity: [0, 0, 0],
    } satisfies FishState,
  };
  const pickup = vi.spyOn(raceGeometry, 'pickupFraction');
  try {
    const result = control.predictSunlitPulse(
      start,
      { brakeHeld: false, slowing: true, pulse: null },
      timing,
    );
    expect(result.completedGoals).toBe(0);
    expect(result.contacts.every((at) => at === null)).toBe(true);
    expect(pickup.mock.calls.length).toBe(0);
  } finally {
    pickup.mockRestore();
  }
});

it('does not allocate goal iterators on every motion tick', () => {
  const start = observation();
  const entries = vi.spyOn(Array.prototype, 'entries');
  let count: number;
  try {
    control.predictSunlitPulse(
      start,
      { brakeHeld: false, pulse: null },
      timing,
    );
    count = entries.mock.calls.length;
  } finally {
    entries.mockRestore();
  }
  expect(count).toBeLessThanOrEqual(3);
});

const pickupFaces = [0, 1, 2].flatMap((axis) =>
  [-1, 1].flatMap((side) =>
    [-1, 0, 1].map((offset) => ({ axis, side, offset })),
  ),
);

it.each(pickupFaces)(
  'retains the exact pearl predicate at face $axis/$side offset $offset',
  ({ axis, side, offset }) => {
    const start = {
      ...observation(),
      waypoint: 3,
      checkpointIndex: 2,
      collectedPearlIds: ['pearl-entry'],
      slowing: true,
    };
    const goal = control.sunlitPulseGoals(start)[0];
    start.fish.position = [...goal.position];
    start.fish.velocity = [0, 0, 0];
    const face = goal.position[axis] + side * goal.radius;
    start.fish.position[axis] =
      face + side * offset * Math.max(1, Math.abs(face)) * Number.EPSILON;
    const contact = raceGeometry.pickupFraction(
      raceGeometry.movementSegment(start.fish.position, start.fish.position),
      goal.position,
      goal.radius,
    );
    const command = { brakeHeld: false, slowing: true, pulse: null };
    const result = control.predictSunlitPulse(start, command, timing);
    if (contact !== null) {
      const earned = control.predictSunlitPulse(
        { ...start, collectedPearlIds: [...start.collectedPearlIds, goal.id] },
        command,
        timing,
      );
      const firstClearance = Math.max(
        0,
        goal.depth - start.fish.position[2],
        Math.hypot(
          ...start.fish.position.map(
            (value, index) => value - goal.position[index],
          ),
        ) -
          (goal.radius - 0.15),
      );
      expect(result).toEqual({
        ...earned,
        minimumClearance: [firstClearance, ...earned.minimumClearance.slice(1)],
      });
    } else {
      expect(result.contacts.every((at) => at === null)).toBe(true);
      expect(result.completedGoals).toBe(0);
      expect(result.boundaryGoalIndex).toBe(0);
    }
  },
);

it.each([
  { scale: 1, message: 'Race movement geometry overflow.' },
  { scale: 0.5, message: 'Pulse prediction cost overflow.' },
])(
  'retains authoritative overflow errors at coordinate scale $scale',
  ({ scale, message }) => {
    const value = Number.MAX_VALUE * scale;
    const start = {
      ...observation(),
      waypoint: 3,
      checkpointIndex: 2,
      collectedPearlIds: ['pearl-entry'],
      slowing: true,
      fish: {
        ...observation().fish,
        position: [value, -value, value],
        velocity: [0, 0, 0],
      } satisfies FishState,
    };
    expect(() =>
      control.predictSunlitPulse(
        start,
        { brakeHeld: false, slowing: true, pulse: null },
        timing,
      ),
    ).toThrow(new RangeError(message));
  },
);

it('does not revalidate a uniform authored current for every forecast step', () => {
  const sample = vi.spyOn(CurrentVolume.prototype, 'sampleCurrent');
  try {
    policy()(observation());
    expect(sample.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    sample.mockRestore();
  }
});

const warmCurrent = sunlit.objects.find((object) => object.type === 'current');
if (!warmCurrent) throw new Error('Missing original Sunlit current.');
const currentFaces = [0, 1, 2].flatMap((axis) =>
  [-1, 1].flatMap((side) =>
    [-1e-8, 0, 1e-8].map((offset) => ({ axis, side, offset })),
  ),
);

it.each(currentFaces)(
  'matches the authoritative current volume at face $axis/$side offset $offset',
  ({ axis, side, offset }) => {
    const volume = new CurrentVolume(warmCurrent);
    try {
      const start = observation();
      start.fish.position = [...warmCurrent.position];
      start.fish.position[axis] +=
        side * warmCurrent.halfExtents[axis] + offset;
      const expected = stepFishMotion(
        start.fish,
        {
          throttle: 0,
          steerX: 0,
          steerY: 0,
          brakeHeld: false,
          dashPressed: false,
          pausePressed: false,
        },
        SCENE_FISH_TUNING,
        {
          current: volume.sampleCurrent(start.fish.position),
          waterSurfaceY: 0,
        },
        1 / 60,
      ).next;
      expect(
        forecast()(
          start,
          { brakeHeld: false, pulse: null },
          { onsetSteps: 0, holdSteps: 6, observationSteps: 1 },
        ).boundaryFish,
      ).toEqual(expected);
    } finally {
      volume.dispose();
    }
  },
);

it('warms the pure planner once without native inputs or changing authored state', async () => {
  const motion = await import('../../src/game/player/stepFishMotion');
  const step = vi.spyOn(motion, 'stepFishMotion');
  const event = vi.spyOn(window, 'dispatchEvent');
  const original = structuredClone(sunlit);
  try {
    control.prepareSunlitPulsePolicy();
    expect(step).toHaveBeenCalledTimes(16_800);
    control.prepareSunlitPulsePolicy();
    expect(step).toHaveBeenCalledTimes(16_800);
    expect(event).not.toHaveBeenCalled();
    expect(sunlit).toEqual(original);
  } finally {
    step.mockRestore();
    event.mockRestore();
  }
});

it('does not trade a recoverable aligned approach for an irreversible delayed pearl miss', () => {
  const start = {
    ...observation(),
    steps: 258,
    previousSteps: 198,
    waypoint: 2,
    checkpointIndex: 1,
    collectedPearlIds: ['pearl-entry'],
    fish: {
      ...observation().fish,
      position: [0.7022493791405922, -4, 29.661112405667495],
      velocity: [1.884103201774156, 0, 6.0997124796982005],
      yaw: 0.4619209802049582,
      roll: -0.12385902986832177,
    } satisfies FishState,
  };
  const command = policy()(start);
  for (const timing of scenarios()(start.steps)) {
    expect(
      forecast()(
        start,
        { brakeHeld: false, pulse: null },
        timing,
      ).missPenalties.every((penalty) => penalty === 0),
    ).toBe(true);
    expect(
      forecast()(start, command, timing).missPenalties.every(
        (penalty) => penalty === 0,
      ),
    ).toBe(true);
  }
});

it('does not buy extra progress credit by steering away from the two aligned opening goals', () => {
  let fish: FishState = { ...observation().fish, velocity: [0, 0, 0] };
  for (let step = 0; step < 116; step++) {
    fish = stepFishMotion(
      fish,
      {
        throttle: 0,
        steerX: 0,
        steerY: 0,
        brakeHeld: false,
        dashPressed: false,
        pausePressed: false,
      },
      SCENE_FISH_TUNING,
      { current: [0, 0, 0], waterSurfaceY: 0 },
      1 / 60,
    ).next;
  }
  expect(policy()({ ...observation(), steps: 116, fish }).pulse).toBeNull();
});

it('values different command durations at one physical time without delaying their observations', () => {
  const start = observation();
  const straight = forecast()(start, { brakeHeld: false, pulse: null }, timing);
  const turned = forecast()(start, { brakeHeld: false, pulse: 'a' }, timing);
  expect(straight.evaluationAt).toBe(30);
  expect(turned.evaluationAt).toBe(30);
  expect(straight.boundaryFish.position[2]).toBeCloseTo(1, 10);
  expect(turned.boundaryFish.position[2]).toBeGreaterThan(2);
});

it('does not assume the following correction shares the current fast delivery', () => {
  const start = observation();
  start.fish.position = [4.67, -4, 37.23];
  start.fish.velocity = [-0.6, 0, 5.64];
  start.fish.yaw = -0.15;
  start.waypoint = 3;
  start.checkpointIndex = 2;
  start.collectedPearlIds = ['pearl-entry'];
  const prediction = forecast()(
    start,
    { brakeHeld: false, pulse: 'd' },
    scenarios()(0)[0],
  );
  expect(prediction.interventionAt).toBeGreaterThanOrEqual(
    prediction.evaluationAt + 90,
  );
  expect(prediction.missPenalties[0]).toBeGreaterThan(0);
});

it('values local distance progress without multiplying it by unrelated downstream route length', () => {
  const start = { ...observation(), slowing: true };
  start.fish.velocity = [0, 0, 0];
  const command = { brakeHeld: false, slowing: true, pulse: null };
  const before = forecast()(start, command, timing);
  start.fish.position = [0, -4, 1];
  const after = forecast()(start, command, timing);
  expect(
    before.evaluationPotentialTerms.distance -
      after.evaluationPotentialTerms.distance,
  ).toBeCloseTo(0.25 * (12 ** 2 - 11 ** 2), 10);
});

it('protects the opening pearl when a long hold arrives early rather than late', () => {
  const start = {
    ...observation(),
    steps: 228,
    previousSteps: 198,
    waypoint: 1,
    checkpointIndex: 1,
  };
  start.fish.position = [0, -4, 13.358306329521854];
  start.fish.velocity = [0, 0, 2.1939135237526255];
  const earlyLong = { onsetSteps: 0, holdSteps: 18, observationSteps: 6 };
  const straight = forecast()(
    start,
    { brakeHeld: false, pulse: null },
    earlyLong,
  );
  expect(straight.missPenalties[0]).toBe(0);
  expect(forecast()(start, policy()(start), earlyLong).missPenalties[0]).toBe(
    0,
  );
});

it('does not promote an earned pearl after an unseen depth crossing that reverses before observation', () => {
  const start = {
    ...observation(),
    waypoint: 3,
    checkpointIndex: 2,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [5.6, -4, 39.998];
  start.fish.velocity = [6, 0, 0.5];
  start.fish.yaw = 1.68;
  const result = forecast()(
    start,
    { brakeHeld: false, pulse: null },
    {
      onsetSteps: 36,
      holdSteps: 12,
      observationSteps: 12,
    },
  );
  expect(result.boundaryFish.position[2]).toBeLessThan(40);
  const actual = advanceSunlitWaypoint(start.waypoint, {
    position: result.boundaryFish.position,
    checkpointIndex: start.checkpointIndex,
    pearlCount: start.collectedPearlIds.length,
  });
  expect(actual).toBe(3);
  expect(result.boundaryGoalIndex).toBe(actual - start.waypoint);
});

it('retains route advancement that genuinely qualified at the earlier returned observation', () => {
  const start = {
    ...observation(),
    waypoint: 3,
    checkpointIndex: 2,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [5.6, -4, 39.998];
  start.fish.velocity = [6, 0, 0.5];
  start.fish.yaw = 1.68;
  const result = forecast()(
    start,
    { brakeHeld: false, pulse: null },
    {
      onsetSteps: 0,
      holdSteps: 18,
      observationSteps: 1,
    },
  );
  expect(result.boundaryFish.position[2]).toBeGreaterThan(40);
  expect(result.evaluationFish.position[2]).toBeLessThan(40);
  expect(result.boundaryGoalIndex).toBe(1);
  // Exhaustively retain or bypass the four earned vertices. This independent
  // oracle checks that the earlier qualified depth stays optional, not revoked.
  const remaining = Math.min(
    ...Array.from({ length: 16 }, (_, mask) => {
      const route = [
        result.evaluationFish.position,
        ...sunlitWaypoints
          .filter((_, index) => index >= 4 || (mask & (1 << index)) !== 0)
          .map((waypoint) => waypoint.position),
      ];
      return route
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum +
            Math.hypot(
              ...point.map((value, axis) => value - route[index][axis]),
            ) **
              2,
          0,
        );
    }),
  );
  expect(result.evaluationPotentialTerms.distance).toBeCloseTo(
    0.25 * remaining,
    10,
  );
});

it.each(['heading', 'velocity', 'clearance'] as const)(
  'does not increase remaining %s obligations merely because a pearl was earned',
  (component) => {
    const start = {
      ...observation(),
      waypoint: 3,
      checkpointIndex: 2,
      slowing: true,
      collectedPearlIds: ['pearl-entry'],
    };
    start.fish.position = [5, -4, 39];
    start.fish.velocity = [0, 0, 0];
    const command = { brakeHeld: false, slowing: true, pulse: null };
    const before = forecast()(start, command, timing);
    const after = forecast()(
      {
        ...start,
        collectedPearlIds: ['pearl-entry', 'pearl-bend'],
      },
      command,
      timing,
    );

    const value = (result: typeof before) =>
      component === 'clearance'
        ? result.minimumClearance[0]
        : result.evaluationPotentialTerms[component];
    expect(value(after)).toBeLessThanOrEqual(value(before) + 1e-10);
  },
);

it.each([
  { name: 'reviewed offset', x: 5.65, z: 39, yaw: 0, current: false },
  { name: 'opposite offset', x: 4.35, z: 39, yaw: 0, current: false },
  {
    name: 'positive wrap',
    x: 5.65,
    z: 39,
    yaw: Math.PI - 1e-6,
    current: false,
  },
  {
    name: 'negative wrap',
    x: 5.65,
    z: 39,
    yaw: -Math.PI + 1e-6,
    current: false,
  },
  {
    name: 'current positive wrap',
    x: 3,
    z: 27,
    yaw: Math.PI - 1e-6,
    current: true,
  },
  {
    name: 'current negative wrap',
    x: 3,
    z: 27,
    yaw: -Math.PI + 1e-6,
    current: true,
  },
])(
  'never increases any route term or the whole score on an award: $name',
  (pose) => {
    const start = {
      ...observation(),
      waypoint: pose.current ? 1 : 3,
      checkpointIndex: pose.current ? 1 : 2,
      slowing: true,
      collectedPearlIds: pose.current ? [] : ['pearl-entry'],
    };
    start.fish.position = [pose.x, -4, pose.z];
    start.fish.velocity = [0, 0, 0];
    start.fish.yaw = pose.yaw;
    const command = { brakeHeld: false, slowing: true, pulse: null };
    const before = forecast()(start, command, timing);
    const after = forecast()(
      {
        ...start,
        collectedPearlIds: [
          ...start.collectedPearlIds,
          pose.current ? 'pearl-entry' : 'pearl-bend',
        ],
      },
      command,
      timing,
    );
    expect(after.evaluationFish).toEqual(before.evaluationFish);
    for (const component of ['distance', 'heading', 'velocity'] as const) {
      expect(
        after.evaluationPotentialTerms[component],
        component,
      ).toBeLessThanOrEqual(before.evaluationPotentialTerms[component] + 1e-10);
    }
    expect(after.score).toBeLessThanOrEqual(before.score + 1e-10);
  },
);

it('keeps terminal value unchanged when the observed waypoint rolls the prediction window forward', () => {
  const start = {
    ...observation(),
    waypoint: 4,
    checkpointIndex: 3,
    slowing: true,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [-4, -5, 60.1];
  start.fish.velocity = [0, 0, 0];
  const command = { brakeHeld: false, slowing: true, pulse: null };
  const before = forecast()(start, command, timing);
  const after = forecast()({ ...start, waypoint: 5 }, command, timing);
  expect(before.boundaryGoalIndex).toBe(1);
  expect(after.boundaryGoalIndex).toBe(0);
  for (const component of ['distance', 'heading', 'velocity'] as const) {
    expect(after.evaluationPotentialTerms[component]).toBeCloseTo(
      before.evaluationPotentialTerms[component],
      10,
    );
  }
  expect(after.score).toBeCloseTo(before.score, 10);
});

it('keeps an earned spatial vertex available even after the observed route cursor advances', () => {
  const start = {
    ...observation(),
    waypoint: 3,
    checkpointIndex: 2,
    slowing: true,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [5.65, -4, 40.1];
  start.fish.velocity = [0, 0, 0];
  const command = { brakeHeld: false, slowing: true, pulse: null };
  const before = forecast()(start, command, timing);
  const after = forecast()({ ...start, waypoint: 4 }, command, timing);
  const direct = [
    start.fish.position,
    ...sunlitWaypoints.slice(4).map((goal) => goal.position),
  ];
  const directEnergy = direct
    .slice(1)
    .reduce(
      (sum, point, index) =>
        sum +
        Math.hypot(
          ...point.map((value, axis) => value - direct[index][axis]),
        ) **
          2,
      0,
    );
  expect(after.evaluationPotentialTerms.distance).toBeLessThan(
    0.25 * directEnergy,
  );
  expect(after.evaluationPotentialTerms.distance).toBeCloseTo(
    before.evaluationPotentialTerms.distance,
    10,
  );
  expect(after.score).toBeCloseTo(before.score, 10);
});

it('does not call a valid sphere pickup a miss for occurring after its center depth', () => {
  const start = {
    ...observation(),
    waypoint: 5,
    checkpointIndex: 3,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [-5.8, -5, 63.9];
  start.fish.velocity = [6, 0, 1];
  start.fish.yaw = Math.atan2(6, 1);
  const result = forecast()(
    start,
    { brakeHeld: false, pulse: null },
    {
      onsetSteps: 0,
      holdSteps: 6,
      observationSteps: 40,
    },
  );
  expect(result.contacts[0]).not.toBeNull();
  expect(result.missPenalties[0]).toBe(0);
});

it('measures checkpoint clearance to its disk rather than a sphere extending ahead of the plane', () => {
  const start = {
    ...observation(),
    waypoint: 4,
    checkpointIndex: 2,
    brakeHeld: true,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [-4, -5, 59];
  start.fish.velocity = [0, 0, 0];
  const result = forecast()(
    start,
    { brakeHeld: true, pulse: null },
    {
      onsetSteps: 0,
      holdSteps: 6,
      observationSteps: 1,
    },
  );
  expect(result.contacts).toEqual([null, null, null, null]);
  // A disk one unit ahead is not a contact, even inside its bounding sphere.
  expect(result.minimumClearance[0]).toBe(1);
  expect(result.minimumClearance[1]).toBe(Infinity);
  expect(result.boundaryGoalIndex).toBe(0);
  expect(result.evaluationGoalIndex).toBe(0);
});

it('does not increase steering or velocity potential merely for crossing a checkpoint', () => {
  const start = {
    ...observation(),
    waypoint: 4,
    checkpointIndex: 2,
    slowing: true,
    collectedPearlIds: ['pearl-entry', 'pearl-bend'],
  };
  start.fish.position = [-3.5489540100097656, -5.008729457855225, 59.999];
  start.fish.velocity = [0, 0, 0];
  start.fish.yaw = -1.3133928759750635;
  const timing = { onsetSteps: 0, holdSteps: 6, observationSteps: 1 };
  const command = { brakeHeld: false, slowing: true, pulse: null };
  const before = forecast()(start, command, timing);
  start.fish.position = [-3.5489540100097656, -5.008729457855225, 60.001];
  const after = forecast()({ ...start, checkpointIndex: 3 }, command, timing);
  for (const component of ['heading', 'velocity'] as const) {
    expect(
      Math.abs(
        after.boundaryPotentialTerms[component] -
          before.boundaryPotentialTerms[component],
      ),
    ).toBeLessThan(0.01);
  }
  expect(after.score).toBeLessThanOrEqual(before.score + 0.1);
});

it('holds native W acceleration independently of a steering pulse', () => {
  expect(
    timeline()(
      false,
      {
        brakeHeld: false,
        accelerating: true,
        pulse: 'a',
      },
      timing,
    ),
  ).toEqual({
    age: 4,
    events: [
      { at: 8, key: 'w', type: 'keydown' },
      { at: 12, key: 'a', type: 'keydown' },
      { at: 20, key: 'a', type: 'keyup' },
    ],
    observeAt: 26,
  });
  const start = observation();
  let fish: FishState = start.fish;
  for (let step = 0; step < 6; step++) {
    fish = stepFishMotion(
      fish,
      {
        throttle: 1,
        steerX: 0,
        steerY: 0,
        brakeHeld: false,
        dashPressed: false,
        pausePressed: false,
      },
      SCENE_FISH_TUNING,
      { current: [0, 0, 0], waterSurfaceY: 0 },
      1 / 60,
    ).next;
  }
  expect(
    forecast()(
      start,
      {
        brakeHeld: false,
        accelerating: true,
        pulse: null,
      },
      { onsetSteps: 0, holdSteps: 6, observationSteps: 6 },
    ).boundaryFish,
  ).toEqual(fish);
});

it('uses the real keyboard cancellation rule for a finite cruise stroke while S remains held', () => {
  const input = new InputController();
  try {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }));
    expect(input.readFrame().throttle).toBe(-1);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.readFrame().throttle).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    expect(input.readFrame().throttle).toBe(-1);
  } finally {
    input.destroy();
  }
});

it('preserves ordered propulsion chord edges and their separate hold intervals', () => {
  expect(
    timeline()(
      false,
      {
        brakeHeld: false,
        slowing: true,
        propel: true,
        pulse: 'ArrowUp',
      },
      { ...timing, skewSteps: 2 },
      true,
    ),
  ).toEqual({
    age: 4,
    events: [
      { at: 12, key: 'w', type: 'keydown' },
      { at: 14, key: 'ArrowUp', type: 'keydown' },
      { at: 22, key: 'ArrowUp', type: 'keyup' },
      { at: 24, key: 'w', type: 'keyup' },
    ],
    observeAt: 30,
  });
});

it('allocates one budget across brake release, S press and a propulsion pulse', () => {
  expect(
    timeline()(
      true,
      {
        brakeHeld: false,
        slowing: true,
        propel: true,
        pulse: null,
      },
      timing,
    ),
  ).toEqual({
    age: 4,
    events: [
      { at: 6, key: 'Shift', type: 'keyup' },
      { at: 9, key: 's', type: 'keydown' },
      { at: 12, key: 'w', type: 'keydown' },
      { at: 20, key: 'w', type: 'keyup' },
    ],
    observeAt: 26,
  });
});

it('calibrates a bounded propulsion stroke followed by genuine S deceleration', () => {
  const start = { ...observation(), slowing: true };
  start.fish.velocity = [0, 0, 0];
  let fish: FishState = start.fish;
  for (let step = 0; step < 120; step++) {
    fish = stepFishMotion(
      fish,
      {
        throttle: step < 6 ? 0 : -1,
        steerX: 0,
        steerY: 0,
        brakeHeld: false,
        dashPressed: false,
        pausePressed: false,
      },
      SCENE_FISH_TUNING,
      { current: [0, 0, 0], waterSurfaceY: 0 },
      1 / 60,
    ).next;
  }
  const result = forecast()(
    start,
    {
      brakeHeld: false,
      slowing: true,
      propel: true,
      pulse: null,
    },
    { onsetSteps: 0, holdSteps: 6, observationSteps: 114 },
  );
  expect(result.boundaryFish).toEqual(fish);
  expect(result.boundaryFish.position[2]).toBeGreaterThan(0);
  expect(result.boundaryFish.position[2]).toBeLessThan(1);
  expect(Math.hypot(...result.boundaryFish.velocity)).toBeLessThan(0.001);
});

function observation() {
  return {
    fish: {
      position: [0, -4, 0],
      velocity: [0, 0, 6],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    } satisfies FishState,
    steps: 0,
    brakeHeld: false,
    waypoint: 0,
    checkpointIndex: 0,
    collectedPearlIds: [] as string[],
    approachingCheckpoint: false,
  };
}

function forecast() {
  expect(control.predictSunlitPulse).toBeTypeOf('function');
  return control.predictSunlitPulse;
}

function goals() {
  expect(control.sunlitPulseGoals).toBeTypeOf('function');
  return control.sunlitPulseGoals;
}

function policy() {
  expect(control.sunlitPulsePolicy).toBeTypeOf('function');
  return control.sunlitPulsePolicy;
}

describe('generated native pulse timeline', () => {
  it('keeps age, brake delivery, pulse edges and the next sample distinct', () => {
    expect(timeline()(false, { brakeHeld: true, pulse: 'a' }, timing)).toEqual({
      age: 4,
      events: [
        { at: 8, key: 'Shift', type: 'keydown' },
        { at: 12, key: 'a', type: 'keydown' },
        { at: 20, key: 'a', type: 'keyup' },
      ],
      observeAt: 26,
    });
  });

  it('releases the old brake before the pulse without treating age as neutral input', () => {
    expect(
      timeline()(true, { brakeHeld: false, pulse: 'ArrowDown' }, timing).events,
    ).toEqual([
      { at: 8, key: 'Shift', type: 'keyup' },
      { at: 12, key: 'ArrowDown', type: 'keydown' },
      { at: 20, key: 'ArrowDown', type: 'keyup' },
    ]);
  });

  it('allocates the command budget to the brake when no pulse is generated', () => {
    expect(timeline()(false, { brakeHeld: true, pulse: null }, timing)).toEqual(
      {
        age: 4,
        events: [{ at: 12, key: 'Shift', type: 'keydown' }],
        observeAt: 18,
      },
    );
  });

  it('does not generate a redundant brake edge', () => {
    expect(timeline()(true, { brakeHeld: true, pulse: 'd' }, timing)).toEqual({
      age: 4,
      events: [
        { at: 12, key: 'd', type: 'keydown' },
        { at: 20, key: 'd', type: 'keyup' },
      ],
      observeAt: 26,
    });
  });

  it('omits all command phases for an unchanged cruise or brake', () => {
    for (const brakeHeld of [false, true]) {
      expect(timeline()(brakeHeld, { brakeHeld, pulse: null }, timing)).toEqual(
        { age: 4, events: [], observeAt: 10 },
      );
    }
  });

  it('preserves edge order at equal ticks, including a zero step pulse', () => {
    expect(
      timeline()(
        false,
        { brakeHeld: true, pulse: 'ArrowUp' },
        { onsetSteps: 0, holdSteps: 0, observationSteps: 1 },
      ),
    ).toEqual({
      age: 0,
      events: [
        { at: 0, key: 'Shift', type: 'keydown' },
        { at: 0, key: 'ArrowUp', type: 'keydown' },
        { at: 0, key: 'ArrowUp', type: 'keyup' },
      ],
      observeAt: 1,
    });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects an invalid or overflowing onset %s',
    (onsetSteps) => {
      expect(() =>
        timeline()(
          false,
          { brakeHeld: true, pulse: 'a' },
          {
            ...timing,
            onsetSteps,
          },
        ),
      ).toThrow(RangeError);
    },
  );

  it('requires a positive observation gap and nonnegative hold', () => {
    for (const invalid of [
      { ...timing, observationSteps: 0 },
      { ...timing, holdSteps: -1 },
    ]) {
      expect(() =>
        timeline()(false, { brakeHeld: false, pulse: 'a' }, invalid),
      ).toThrow(RangeError);
    }
  });

  it('returns immutable generated events without changing inputs', () => {
    const command = { brakeHeld: true, pulse: 'a' as const };
    const before = structuredClone({ command, timing });
    const result = timeline()(false, command, timing);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(result.events.every(Object.isFrozen)).toBe(true);
    expect({ command, timing }).toEqual(before);
  });
});

describe('explicit predictor timing scenarios', () => {
  it('keeps declared transport uncertainty independent of observation cadence', () => {
    expect(scenarios()(538, 514)).toEqual(scenarios()(514, 454));
    const expected = [
      { onsetSteps: 0, holdSteps: 6, observationSteps: 6 },
      { onsetSteps: 36, holdSteps: 12, observationSteps: 12 },
      { onsetSteps: 90, holdSteps: 18, observationSteps: 23 },
    ];
    for (const [steps, previous] of [
      [150],
      [150, 150],
      [150, 0],
      [514, 454],
      [538, 514],
    ]) {
      expect(scenarios()(steps, previous)).toEqual(expected);
    }
  });

  describe('pulse physics and goal semantics', () => {
    it('matches an independent literal old brake, neutral, left and neutral sequence', () => {
      const start = observation();
      const frames = [
        ...Array.from({ length: 8 }, () => ({ brakeHeld: true, steerX: 0 })),
        ...Array.from({ length: 4 }, () => ({ brakeHeld: false, steerX: 0 })),
        ...Array.from({ length: 8 }, () => ({ brakeHeld: false, steerX: 1 })),
        ...Array.from({ length: 6 }, () => ({ brakeHeld: false, steerX: 0 })),
      ];
      let fish: FishState = start.fish;
      for (const frame of frames) {
        fish = stepFishMotion(
          fish,
          {
            ...frame,
            steerY: 0,
            throttle: 0,
            dashPressed: false,
            pausePressed: false,
          },
          SCENE_FISH_TUNING,
          { current: [0, 0, 0], waterSurfaceY: 0 },
          1 / 60,
        ).next;
      }
      const result = forecast()(
        { ...start, brakeHeld: true },
        { brakeHeld: false, pulse: 'a' },
        timing,
      );
      expect(result.boundaryFish).toEqual(fish);
      expect(result.motionSteps).toBe(240);
    });

    it('does not apply a pulse whose down and up share a completed step', () => {
      const start = observation();
      const frame = {
        brakeHeld: false,
        steerX: 0,
        steerY: 0,
        throttle: 0,
        dashPressed: false,
        pausePressed: false,
      };
      const result = forecast()(
        start,
        { brakeHeld: false, pulse: 'a' },
        {
          onsetSteps: 0,
          holdSteps: 0,
          observationSteps: 1,
        },
      );
      expect(result.boundaryFish).toEqual(
        stepFishMotion(
          start.fish,
          frame,
          SCENE_FISH_TUNING,
          { current: [0, 0, 0], waterSurfaceY: 0 },
          1 / 60,
        ).next,
      );
    });

    it('samples the original warm current rather than predicting still water', () => {
      const start = observation();
      start.fish.position = [0, -4, 24];
      const result = forecast()(
        start,
        { brakeHeld: false, pulse: null },
        {
          onsetSteps: 0,
          holdSteps: 6,
          observationSteps: 1,
        },
      );
      expect(result.boundaryFish.position[0]).toBeCloseTo(0.3 / 60, 12);
      expect(result.boundaryFish.position[2]).toBeCloseTo(24 + 7.5 / 60, 12);
    });

    it('keeps actual finish geometry separate from the final steering target', () => {
      expect(
        goals()({ ...observation(), waypoint: 7, checkpointIndex: 3 })[0],
      ).toMatchObject({
        kind: 'checkpoint',
        position: [0, -4, 92],
        steeringPosition: [0, -4, 93],
        terminal: true,
      });
    });

    it('places the missed checkpoint after sampled recovery, not its following pearl', () => {
      const start = {
        ...observation(),
        waypoint: 4,
        checkpointIndex: 2,
        approachingCheckpoint: true,
      };
      expect(goals()(start)).toMatchObject([
        { kind: 'recovery', position: [-4, -5, 54], radius: 1 },
        { kind: 'checkpoint', position: [-4, -5, 60], id: 'sway-passage' },
      ]);
      start.fish.position = [-4, -5, 52];
      const result = forecast()(
        start,
        { brakeHeld: false, pulse: null },
        {
          onsetSteps: 0,
          holdSteps: 6,
          observationSteps: 40,
        },
      );
      expect(result.contacts).toEqual([null, null, null, null, null]);
      expect(result.boundaryGoalIndex).toBe(0);
    });

    it('does not let later tail contacts erase the next observation potential', () => {
      const start = observation();
      start.fish.position = [0, -4, 9];
      const result = forecast()(
        start,
        { brakeHeld: false, pulse: null },
        {
          onsetSteps: 0,
          holdSteps: 6,
          observationSteps: 5,
        },
      );
      expect(result.completedGoals).toBe(2);
      expect(result.boundaryGoalIndex).toBe(0);
      expect(result.boundaryPotential).toBeGreaterThan(0);
      expect(result.score).toBeCloseTo(
        result.evaluationPotential + 0.003 * result.evaluationAt,
        10,
      );
    });
  });

  describe('interception candidate', () => {
    it('does not freeze while an earned pearl is only millimeters short of observed depth advancement', () => {
      const start = {
        ...observation(),
        waypoint: 3,
        checkpointIndex: 2,
        brakeHeld: true,
        steps: 2394,
        previousSteps: 2370,
        collectedPearlIds: ['pearl-entry', 'pearl-bend'],
      };
      start.fish.position = [6.6541852951049805, -4, 39.99786376953125];
      start.fish.velocity = [0, 0, 0];
      start.fish.yaw = -1.5226759272956034;
      const decision = policy()(start);
      expect(decision.brakeHeld && decision.pulse === null).toBe(false);
    });

    it('keeps route potential and remaining clearance continuous across earned waypoint depth', () => {
      const start = {
        ...observation(),
        waypoint: 3,
        checkpointIndex: 2,
        brakeHeld: true,
        collectedPearlIds: ['pearl-entry', 'pearl-bend'],
      };
      start.fish.velocity = [0, 0, 0];
      start.fish.yaw = -1.5226759272956034;
      const timing = { onsetSteps: 0, holdSteps: 6, observationSteps: 1 };
      let previous: number[] | undefined;
      for (const epsilon of [0.002, 0.0002, 0.00002]) {
        start.fish.position = [6.6541852951049805, -4, 40 - epsilon];
        const before = forecast()(
          start,
          { brakeHeld: true, pulse: null },
          timing,
        );
        start.fish.position = [6.6541852951049805, -4, 40 + epsilon];
        const after = forecast()(
          start,
          { brakeHeld: true, pulse: null },
          timing,
        );
        expect(before.boundaryGoalIndex).toBe(0);
        expect(after.boundaryGoalIndex).toBe(1);
        const differences = [
          Math.abs(after.boundaryPotential - before.boundaryPotential),
          Math.abs(after.score - before.score),
          ...(['distance', 'heading', 'velocity'] as const).map((component) =>
            Math.abs(
              after.boundaryPotentialTerms[component] -
                before.boundaryPotentialTerms[component],
            ),
          ),
        ];
        if (previous) {
          for (const [index, difference] of differences.entries()) {
            expect(difference).toBeLessThanOrEqual(
              previous[index] * 0.2 + 1e-10,
            );
            expect(difference).toBeLessThan(0.1);
          }
        }
        previous = differences;
      }
    });

    it('slows before a pearl that the next observed command would reach too late', () => {
      const start = {
        ...observation(),
        waypoint: 2,
        checkpointIndex: 1,
        steps: 318,
        previousSteps: 258,
        collectedPearlIds: ['pearl-entry'],
      };
      start.fish.position = [2.892047697125554, -4, 32.97006310787475];
      start.fish.velocity = [0.7224183689761059, 0, 5.8677574197507285];
      start.fish.yaw = 0.00015729067667002994;
      start.fish.roll = 0.0899038527972815;
      const decision = policy()(start);
      expect(decision.brakeHeld || decision.slowing).toBe(true);
    });

    it('makes sampled recovery progress without requiring arrival in the very next observation', () => {
      const start = {
        ...observation(),
        waypoint: 4,
        checkpointIndex: 2,
        brakeHeld: true,
        steps: 2358,
        previousSteps: 2298,
        collectedPearlIds: ['pearl-entry', 'pearl-bend'],
        approachingCheckpoint: true,
      };
      start.fish.position = [-4.7353, -4, 57.6816];
      start.fish.velocity = [0, 0, 0];
      start.fish.yaw = Math.atan2(0.7353, -3.6816);
      start.fish.pitch = -0.24695;
      expect(policy()(start).brakeHeld).toBe(false);
    });

    it('does not reward parking near a later checkpoint before collecting the pearl behind it', () => {
      const start = {
        ...observation(),
        waypoint: 3,
        checkpointIndex: 2,
        brakeHeld: true,
        steps: 2382,
        previousSteps: 2358,
        collectedPearlIds: ['pearl-entry'],
      };
      start.fish.position = [3.6, -4, 44.7];
      start.fish.velocity = [0, 0, 0];
      start.fish.yaw = Math.atan2(1.4, -4.7);
      const decision = policy()(start);
      expect(decision.brakeHeld).toBe(false);
      expect(decision.worstCost).toBeLessThan(decision.stationaryCost);
    });

    it('prepares pitch or moves instead of choosing a stationary yaw aligned brake by tie order', () => {
      const start = {
        ...observation(),
        waypoint: 5,
        checkpointIndex: 3,
        brakeHeld: true,
        steps: 100,
        collectedPearlIds: ['pearl-entry', 'pearl-bend'],
      };
      start.fish.position = [-4, -4, 56];
      start.fish.velocity = [0, 0, 0];
      const decision = policy()(start);
      expect(decision.brakeHeld && decision.pulse === null).toBe(false);
      expect(decision.worstCost).toBeLessThan(decision.stationaryCost);
      expect(decision.motionSteps).toBeLessThanOrEqual(18000);
    });

    it('makes progress when the next goal lies beyond the prediction horizon', () => {
      const start = { ...observation(), brakeHeld: true };
      start.fish.position = [0, -4, -20];
      start.fish.velocity = [0, 0, 0];
      expect(policy()(start).brakeHeld).toBe(false);
    });

    it('is repeatable, preserves copied state and rejects nonfinite motion', () => {
      const start = observation();
      const before = structuredClone(start);
      expect(policy()(start)).toEqual(policy()(start));
      expect(start).toEqual(before);
      expect(() =>
        policy()({
          ...start,
          fish: { ...start.fish, yaw: NaN },
        }),
      ).toThrow(RangeError);
    });
  });

  it('rejects nonfinite, negative and decreasing observation counters', () => {
    for (const [steps, previous] of [
      [1, 2],
      [-1, 0],
      [NaN, 0],
      [1, -1],
    ]) {
      expect(() => scenarios()(steps, previous)).toThrow(RangeError);
    }
  });
});
