// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { COURSES } from '../../src/content/courses/courseIds';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import type { CourseRuntime } from '../../src/game/course/createCourseRuntime';
import { loadCourseDefinition } from '../../src/game/course/loadCourseDefinition';
import { CurrentVolume } from '../../src/game/obstacles/CurrentVolume';
import { RotatingGate } from '../../src/game/obstacles/RotatingGate';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import {
  courseWaypoints,
  TRAVERSAL_MAX_STEPS,
  traverseCourse,
  type TraversalProfile,
} from '../fixtures/courseTraversal';

const checkpoints = [
  ['smoker-entry', [0, -5, 16]],
  ['smoker-east-descent', [7, -7, 48]],
  ['smoker-deep-crossing', [-7, -9, 88]],
  ['smoker-updraft', [6, -6, 126]],
  ['smoker-last-turn', [-6, -8, 166]],
  ['smoker-finish', [0, -5, 208]],
] as const;
const pearls = [
  ['smoker-pearl-entry', [0, -5, 24]],
  ['smoker-pearl-east', [7, -7, 56]],
  ['smoker-pearl-deep', [-7, -9, 96]],
  ['smoker-pearl-rise', [6, -6, 134]],
  ['smoker-pearl-west', [-6, -8, 174]],
  ['smoker-pearl-home', [0, -5, 200]],
] as const;
const currentIds = [
  'smoker-west-updraft',
  'smoker-east-updraft',
  'smoker-home-updraft',
];
const gateIds = [
  'smoker-descent-gate',
  'smoker-updraft-gate',
  'smoker-home-gate',
];
const calibrated = {
  fast: {
    steps: 1473,
    elapsedMs: 24535.328771155422,
    medal: 'gold',
    dashes: 2,
    currentSteps: {
      'smoker-west-updraft': 154,
      'smoker-east-updraft': 149,
      'smoker-home-updraft': 104,
    },
    milestoneSteps: [
      110, 159, 331, 381, 611, 658, 883, 936, 1181, 1241, 1414, 1473,
    ],
  },
  conservative: {
    steps: 3152,
    elapsedMs: 52516.82827445285,
    medal: 'bronze',
    dashes: 0,
    currentSteps: {
      'smoker-west-updraft': 287,
      'smoker-east-updraft': 340,
      'smoker-home-updraft': 211,
    },
    milestoneSteps: [
      241, 344, 713, 818, 1297, 1402, 1882, 1988, 2555, 2666, 3029, 3152,
    ],
  },
} as const;
const scenes: SceneRuntime[] = [];
afterEach(() => {
  for (const runtime of scenes.splice(0)) runtime.dispose();
});

it('authors the generated trench, six ordered checkpoints and pearls, nine solids, three currents and gates', async () => {
  const course = await loadCourseDefinition('blacksmoker-run');
  const metadata = COURSES.find(({ id }) => id === 'blacksmoker-run');
  expect(course).toMatchObject({
    version: 1,
    courseId: 'blacksmoker-run',
    name: metadata?.name,
    summary: metadata?.summary,
    visuals: {
      kind: 'generated',
      waterColor: '#102b3a',
      seabedColor: '#293c46',
    },
    spawn: { position: [0, -5, 0], yaw: 0 },
    medalTimesMs: { gold: 34_000, silver: 52_000, bronze: 75_000 },
  });
  expect(metadata?.available).toBe(false);
  expect(course.checkpoints).toEqual(
    checkpoints.map(([id, position]) => ({
      id,
      position,
      radius: 3.5,
      direction: [0, 0, 1],
    })),
  );
  expect(course.pearls).toEqual(
    pearls.map(([id, position]) => ({ id, position, radius: 0.4 })),
  );
  const solids = course.objects.filter(
    (object) => object.type === 'box' || object.type === 'sphere',
  );
  expect(
    solids.map((object) => [
      object.id,
      object.type,
      object.position,
      object.type === 'box' ? object.halfExtents : object.radius,
      object.collision,
      object.color,
    ]),
  ).toEqual([
    [
      'smoker-seabed',
      'box',
      [0, -16, 106],
      [27, 3, 116],
      'environment',
      '#293c46',
    ],
    [
      'smoker-west-wall',
      'box',
      [-17, -9, 70],
      [3, 4, 34],
      'environment',
      '#1e303b',
    ],
    [
      'smoker-east-wall',
      'box',
      [17, -9, 154],
      [3, 4, 34],
      'environment',
      '#1e303b',
    ],
    [
      'smoker-west-root',
      'sphere',
      [-13, -10, 36],
      2.5,
      'environment',
      '#394d54',
    ],
    [
      'smoker-east-root',
      'sphere',
      [13, -10, 184],
      2.5,
      'environment',
      '#394d54',
    ],
    [
      'smoker-west-chimney',
      'box',
      [-13, -9, 84],
      [1.5, 4, 1.5],
      'environment',
      '#354049',
    ],
    [
      'smoker-east-chimney',
      'box',
      [13, -9, 142],
      [1.5, 4, 1.5],
      'environment',
      '#354049',
    ],
    ['smoker-hot-vent', 'sphere', [3, -11, 110], 1.2, 'hazard', '#d46f4e'],
    ['smoker-cinder-vent', 'sphere', [-3, -10, 174], 1.2, 'hazard', '#d46f4e'],
  ]);
  for (const solid of solids) {
    if (solid.type === 'box') expect(solid.rotation).toEqual([0, 0, 0, 1]);
  }
  const currents = course.objects.filter((object) => object.type === 'current');
  expect(
    currents.map(({ id, position, halfExtents, velocity }) => [
      id,
      position,
      halfExtents,
      velocity,
    ]),
  ).toEqual([
    ['smoker-west-updraft', [0, -8, 72], [7, 4, 11], [-1.3, 0.5, 0.2]],
    ['smoker-east-updraft', [0, -7, 149], [7, 4, 10], [1.4, 0.4, -0.1]],
    ['smoker-home-updraft', [0, -6, 192], [5, 4, 8], [0, 0.6, 0.5]],
  ]);
  for (const current of currents) expect(current.color).toBe('#7da9b4');
  const gates = course.objects.filter(
    (object) => object.type === 'rotating-gate',
  );
  expect(
    gates.map(({ id, position, halfExtents, phase, angularSpeed }) => [
      id,
      position,
      halfExtents,
      phase,
      angularSpeed,
    ]),
  ).toEqual([
    ['smoker-descent-gate', [-8, -8, 74], [3.5, 0.2, 0.2], 0.9, 0.6],
    ['smoker-updraft-gate', [8, -7, 149], [4, 0.2, 0.2], 1.4, -0.45],
    ['smoker-home-gate', [-5, -6, 191], [3.25, 0.2, 0.2], 0.3, 0.35],
  ]);
  for (const gate of gates) {
    expect(gate.axis).toEqual([0, 0, 1]);
    expect(gate.color).toBe('#c69058');
  }
  expect(course.objects).toHaveLength(15);
  const ids = [
    ...course.checkpoints,
    ...(course.pearls ?? []),
    ...course.objects,
  ].map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
});

async function observeTraversal(profile: TraversalProfile, cycle: number) {
  const definition = await loadCourseDefinition('blacksmoker-run');
  let course: CourseRuntime | undefined;
  const runtime = await createSceneRuntime(definition, {
    createVisuals(scene, observedCourse) {
      course = observedCourse;
      return createGeneratedSceneVisuals(scene, observedCourse);
    },
  });
  scenes.push(runtime);
  if (!course) throw new Error('Missing observed Blacksmoker course');
  const resources = runtime.getDiagnostics();
  const gates = course.obstacles.filter(
    (object) => object instanceof RotatingGate,
  );
  const currents = course.obstacles.filter(
    (object) => object instanceof CurrentVolume,
  );
  const validGates = gates.every(
    (gate) => gate.body.isValid() && gate.collider.isValid(),
  );
  const gateRotations = new Map(
    gates.map((gate) => [
      gate.definition.id,
      {
        initial: gate.body.rotation(),
        minimumAbsDot: 1,
        nearestPass: {
          elapsedMs: 0,
          position: definition.spawn.position,
          rotation: gate.body.rotation(),
          zDistance: Math.abs(
            definition.spawn.position[2] - gate.definition.position[2],
          ),
        },
      },
    ]),
  );
  const movedGates = new Set<string>();
  const currentSteps = new Map(
    currents.map((current) => [current.definition.id, 0]),
  );
  const traversal = traverseCourse(runtime, profile, ({ fish, race }) => {
    for (const current of currents) {
      if (Math.hypot(...current.sampleCurrent(fish.position)) > 0) {
        currentSteps.set(
          current.definition.id,
          currentSteps.get(current.definition.id)! + 1,
        );
      }
    }
    for (const gate of gates) {
      const evidence = gateRotations.get(gate.definition.id)!;
      const { initial } = evidence;
      const rotation = gate.body.rotation();
      const alignment = Math.abs(
        initial.x * rotation.x +
          initial.y * rotation.y +
          initial.z * rotation.z +
          initial.w * rotation.w,
      );
      evidence.minimumAbsDot = Math.min(evidence.minimumAbsDot, alignment);
      if (alignment < 1 - 1e-6) movedGates.add(gate.definition.id);
      const zDistance = Math.abs(
        fish.position[2] - gate.definition.position[2],
      );
      if (zDistance < evidence.nearestPass.zDistance) {
        evidence.nearestPass = {
          elapsedMs: race.elapsedMs,
          position: fish.position,
          rotation,
          zDistance,
        };
      }
    }
  });
  const finalResources = runtime.getDiagnostics();
  runtime.dispose();
  runtime.dispose();
  const disposedResources = runtime.getDiagnostics();
  const observation = {
    profile,
    cycle,
    definition,
    traversal,
    currentSteps: Object.fromEntries(currentSteps),
    gateRotations: Object.fromEntries(gateRotations),
    movedGates: [...movedGates],
    validGates,
    resources,
    finalResources,
    disposedResources,
  };
  console.info(
    `Blacksmoker ${profile} cycle ${cycle + 1}: ${JSON.stringify({
      steps: traversal.steps,
      elapsedMs: traversal.snapshot.race.elapsedMs,
      medal: traversal.snapshot.race.result?.medal,
      checkpointIndex: traversal.snapshot.race.checkpointIndex,
      pearlIds: traversal.snapshot.collectedPearlIds,
      events: cycle === 0 ? traversal.events : undefined,
      // Milestone positions are post-step endpoints, not crossing coordinates.
      milestones: cycle === 0 ? traversal.milestones : undefined,
      collisions: traversal.collisions,
      dashes: traversal.dashes,
      currentSteps: observation.currentSteps,
      gateRotations: cycle === 0 ? observation.gateRotations : undefined,
      movedGates: observation.movedGates,
      resources,
      finalResources,
      disposedResources,
    })}`,
  );
  return observation;
}

it('finishes both normalized profiles with every award, moving gate and current, no contacts and stable three-cycle ownership', async () => {
  const observations: Awaited<ReturnType<typeof observeTraversal>>[] = [];
  for (const profile of ['fast', 'conservative'] as const) {
    for (let cycle = 0; cycle < 3; cycle++) {
      observations.push(await observeTraversal(profile, cycle));
    }
  }
  for (const observation of observations) {
    const {
      profile,
      definition,
      traversal,
      currentSteps,
      gateRotations,
      movedGates,
      resources,
    } = observation;
    const { snapshot, events, steps, collisions, dashes } = traversal;
    const baseline = calibrated[profile];
    expect(snapshot.race.status, JSON.stringify(traversal)).toBe('finished');
    expect(steps).toBeLessThan(TRAVERSAL_MAX_STEPS);
    expect(steps).toBe(baseline.steps);
    expect(snapshot.race.elapsedMs).toBe(baseline.elapsedMs);
    expect(snapshot.race.result?.medal).toBe(baseline.medal);
    expect(dashes).toBe(baseline.dashes);
    expect(traversal.steeringSteps).toBeGreaterThan(100);
    expect(
      events
        .filter((event) => event.type === 'checkpoint')
        .map((event) => [event.checkpointId, event.checkpointIndex]),
    ).toEqual(checkpoints.map(([id], index) => [id, index]));
    expect(
      events
        .filter((event) => event.type === 'pearl')
        .map((event) => event.pearlId),
    ).toEqual(pearls.map(([id]) => id));
    expect(traversal.milestones.map(({ id }) => id)).toEqual(
      courseWaypoints(definition).map(({ id }) => id),
    );
    expect(traversal.milestones.map(({ step }) => step)).toEqual(
      baseline.milestoneSteps,
    );
    expect(traversal.milestones.slice(-2).map(({ id }) => id)).toEqual([
      'smoker-pearl-home',
      'smoker-finish',
    ]);
    expect(events.map(({ elapsedMs }) => elapsedMs)).toEqual(
      events.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b),
    );
    expect(events.filter(({ type }) => type === 'finish')).toEqual([
      expect.objectContaining({ result: snapshot.race.result }),
    ]);
    expect(events.at(-1)?.type).toBe('finish');
    expect(snapshot.race).toMatchObject({
      checkpointIndex: 6,
      checkpointCount: 6,
      pearlCount: 6,
      totalPearls: 6,
      result: {
        courseId: 'blacksmoker-run',
        elapsedMs: snapshot.race.elapsedMs,
        pearlCount: 6,
        totalPearls: 6,
      },
    });
    expect(snapshot.collectedPearlIds).toEqual(pearls.map(([id]) => id));
    expect(snapshot.race.elapsedMs).toBeLessThanOrEqual(
      definition.medalTimesMs[profile === 'fast' ? 'gold' : 'bronze'],
    );
    if (profile === 'fast') {
      expect(snapshot.race.result?.medal).toBe('gold');
      expect(dashes).toBeGreaterThan(0);
    } else {
      expect(['bronze', 'silver', 'gold']).toContain(
        snapshot.race.result?.medal,
      );
      expect(dashes).toBe(0);
    }
    expect(collisions).toEqual([]);
    expect(Object.keys(currentSteps)).toEqual(currentIds);
    expect(currentSteps).toEqual(baseline.currentSteps);
    for (const id of currentIds)
      expect(currentSteps[id], id).toBeGreaterThan(0);
    expect(observation.validGates).toBe(true);
    expect(Object.keys(gateRotations)).toEqual(gateIds);
    expect([...movedGates].sort()).toEqual([...gateIds].sort());
    for (const id of gateIds)
      expect(gateRotations[id].minimumAbsDot, id).toBeLessThan(1 - 1e-6);
    expect(resources).toEqual({
      lifecycle: 'active',
      bodies: 3,
      colliders: 13,
      geometries: 4,
      materials: 19,
    });
    expect(resources).toEqual(observations[0].resources);
    expect(observation.finalResources).toEqual(resources);
    expect(observation.disposedResources).toEqual({
      lifecycle: 'disposed',
      bodies: 0,
      colliders: 0,
      geometries: 0,
      materials: 0,
    });
    const first = observations.find((run) => run.profile === profile)!;
    expect(traversal).toEqual(first.traversal);
    expect(currentSteps).toEqual(first.currentSteps);
    expect(gateRotations).toEqual(first.gateRotations);
  }
  const fast = observations.find(({ profile }) => profile === 'fast')!;
  const conservative = observations.find(
    ({ profile }) => profile === 'conservative',
  )!;
  expect(fast.traversal.snapshot.race.elapsedMs).toBeLessThan(
    conservative.traversal.snapshot.race.elapsedMs,
  );
});
