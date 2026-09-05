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
import {
  emptyProgress,
  unlockedCourseIds,
  updateProgress,
} from '../../src/game/progression/progress';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import {
  advanceKelpworksWaypoint,
  KELPWORKS_MAX_STEPS,
  kelpworksSteeringTarget,
  kelpworksWaypoints,
  traverseKelpworks,
} from '../fixtures/kelpworksTraversal';
import { generatedSunlit, traverseSunlit } from '../fixtures/sunlitTraversal';

const scenes: SceneRuntime[] = [];
afterEach(() => {
  for (const runtime of scenes.splice(0)) runtime.dispose();
});

async function setup() {
  const definition = await loadCourseDefinition('kelpworks');
  let course: CourseRuntime | undefined;
  const runtime = await createSceneRuntime(definition, {
    createVisuals(scene, observedCourse) {
      course = observedCourse;
      return createGeneratedSceneVisuals(scene, observedCourse);
    },
  });
  scenes.push(runtime);
  if (!course) throw new Error('Missing observed Kelpworks course');
  return { runtime, course };
}

it('authors the five-checkpoint slalom, five pearls and seven primitive solids', async () => {
  const course = await loadCourseDefinition('kelpworks');
  expect(course.spawn).toEqual({ position: [0, -4, 0], yaw: 0 });
  expect(course.checkpoints.map(({ position }) => position)).toEqual([
    [0, -4, 14],
    [-6, -4.5, 40],
    [6, -6, 72],
    [-5, -3.5, 108],
    [0, -4, 144],
  ]);
  for (const checkpoint of course.checkpoints) {
    expect(checkpoint.radius).toBe(3.5);
    expect(checkpoint.direction).toEqual([0, 0, 1]);
  }
  expect(course.pearls?.map(({ position }) => position)).toEqual([
    [0, -4, 22],
    [-6, -4.5, 48],
    [6, -6, 80],
    [-5, -3.5, 116],
    [0, -4, 136],
  ]);
  expect(course.pearls?.every(({ radius }) => radius === 0.4)).toBe(true);
  const solids = course.objects.filter(
    (object) => object.type === 'box' || object.type === 'sphere',
  );
  expect(solids).toHaveLength(7);
  expect(solids.filter(({ collision }) => collision === 'hazard')).toHaveLength(
    1,
  );
  expect(solids.map(({ id }) => id)).toEqual([
    'kelp-seabed',
    'kelp-west-bank',
    'kelp-east-bank',
    'kelp-west-roots',
    'kelp-east-roots',
    'kelp-urchin',
    'kelp-channel-rock',
  ]);
  const ids = [
    ...course.checkpoints,
    ...(course.pearls ?? []),
    ...course.objects,
  ].map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
});

it('advances only on actual milestone awards and retains an upstream checkpoint recovery target', async () => {
  const { runtime } = await setup();
  const goals = kelpworksWaypoints(runtime.definition);
  const ready = runtime.getSnapshot();
  const downstream = {
    ...ready,
    fish: { ...ready.fish, position: [0, -4, 25] as const },
  };
  expect(advanceKelpworksWaypoint(goals, 0, downstream)).toBe(0);
  expect(advanceKelpworksWaypoint(goals, 1, downstream)).toBe(1);
  expect(kelpworksSteeringTarget(goals[0], downstream)).toEqual({
    target: [0, -4, 8],
    approachingCheckpoint: true,
  });
  const stillApproaching = {
    ...downstream,
    fish: { ...ready.fish, position: [0, -4, 13] as const },
  };
  expect(kelpworksSteeringTarget(goals[0], stillApproaching, true)).toEqual({
    target: [0, -4, 8],
    approachingCheckpoint: true,
  });
  expect(
    kelpworksSteeringTarget(
      goals[0],
      {
        ...ready,
        fish: { ...ready.fish, position: [0, -4, 8] },
      },
      true,
    ),
  ).toEqual({ target: goals[0].position, approachingCheckpoint: false });
  expect(
    advanceKelpworksWaypoint(goals, 1, {
      ...downstream,
      collectedPearlIds: [goals[3].id],
    }),
  ).toBe(1);
  expect(
    advanceKelpworksWaypoint(goals, 1, {
      ...downstream,
      collectedPearlIds: [goals[1].id],
    }),
  ).toBe(2);
});

it('earns gold and conservative bronze through real controls, with stable ownership across three runs each', async () => {
  const sunlit = await createSceneRuntime(generatedSunlit);
  scenes.push(sunlit);
  traverseSunlit(sunlit);
  const sunlitResult = sunlit.getSnapshot().race.result;
  expect(sunlitResult?.medal).toBe('bronze');
  const eligible = updateProgress(emptyProgress(), sunlitResult);
  sunlit.dispose();
  expect(unlockedCourseIds(eligible)).toEqual(['sunlit-shoals', 'kelpworks']);

  let active: ReturnType<SceneRuntime['getDiagnostics']> | undefined;
  const elapsed: Record<'fast' | 'conservative', number[]> = {
    fast: [],
    conservative: [],
  };
  for (const profile of ['fast', 'conservative'] as const) {
    for (let cycle = 0; cycle < 3; cycle++) {
      const { runtime, course } = await setup();
      const counts = runtime.getDiagnostics();
      active ??= counts;
      expect(counts).toEqual(active);
      expect(counts).toMatchObject({
        lifecycle: 'active',
        bodies: 2,
        colliders: 10,
      });
      const gates = course.obstacles.filter(
        (object) => object instanceof RotatingGate,
      );
      const currents = course.obstacles.filter(
        (object) => object instanceof CurrentVolume,
      );
      expect(gates).toHaveLength(2);
      expect(currents).toHaveLength(2);
      expect(
        gates.every((gate) => gate.body.isValid() && gate.collider.isValid()),
      ).toBe(true);
      const rotations = gates.map((gate) => gate.body.rotation());
      const movedGates = new Set<string>();
      const currentSteps = new Map(
        currents.map((current) => [current.definition.id, 0]),
      );
      let pivotClearance = Infinity;
      const traversal = traverseKelpworks(runtime, profile, ({ fish }) => {
        for (const current of currents) {
          if (Math.hypot(...current.sampleCurrent(fish.position)) > 0) {
            currentSteps.set(
              current.definition.id,
              currentSteps.get(current.definition.id)! + 1,
            );
          }
        }
        for (const [index, gate] of gates.entries()) {
          const current = gate.body.rotation();
          const initial = rotations[index];
          const alignment = Math.abs(
            initial.x * current.x +
              initial.y * current.y +
              initial.z * current.z +
              initial.w * current.w,
          );
          if (alignment < 1 - 1e-6) movedGates.add(gate.definition.id);
          pivotClearance = Math.min(
            pivotClearance,
            Math.hypot(
              ...gate.definition.position.map(
                (value, axis) => value - fish.position[axis],
              ),
            ),
          );
        }
      });
      const { snapshot, events, steps, collisions, dashes } = traversal;
      console.info(
        `Kelpworks ${profile} cycle ${cycle + 1}: ${JSON.stringify({
          steps,
          elapsedMs: snapshot.race.elapsedMs,
          medal: snapshot.race.result?.medal,
          milestones: traversal.milestones,
          collisions,
          dashes,
          currentSteps: Object.fromEntries(currentSteps),
          pivotClearance,
          resources: counts,
        })}`,
      );
      expect(snapshot.race.status, JSON.stringify(traversal)).toBe('finished');
      expect(steps).toBeLessThan(KELPWORKS_MAX_STEPS);
      expect(traversal.steeringSteps).toBeGreaterThan(100);
      expect(
        events
          .filter((event) => event.type === 'checkpoint')
          .map((event) => event.checkpointId),
      ).toEqual(runtime.definition.checkpoints.map(({ id }) => id));
      expect(
        events
          .filter((event) => event.type === 'pearl')
          .map((event) => event.pearlId),
      ).toEqual(runtime.definition.pearls?.map(({ id }) => id));
      expect(traversal.milestones.map(({ id }) => id)).toEqual(
        kelpworksWaypoints(runtime.definition).map(({ id }) => id),
      );
      expect(events.map(({ elapsedMs }) => elapsedMs)).toEqual(
        events.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b),
      );
      expect(events.filter(({ type }) => type === 'finish')).toEqual([
        expect.objectContaining({ result: snapshot.race.result }),
      ]);
      expect(snapshot.race.result).toMatchObject({
        courseId: 'kelpworks',
        pearlCount: 5,
        totalPearls: 5,
      });
      expect(snapshot.collectedPearlIds).toEqual(
        runtime.definition.pearls?.map(({ id }) => id),
      );
      expect(snapshot.race.elapsedMs).toBeLessThanOrEqual(
        runtime.definition.medalTimesMs[profile === 'fast' ? 'gold' : 'bronze'],
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
      expect([...currentSteps.values()].every((count) => count > 0)).toBe(true);
      for (const gate of gates)
        expect(movedGates.has(gate.definition.id), gate.definition.id).toBe(
          true,
        );
      expect(pivotClearance).toBeGreaterThan(0.6);
      const progress = updateProgress(eligible, snapshot.race.result);
      expect(progress.courses.kelpworks).toEqual({
        bestElapsedMs: snapshot.race.elapsedMs,
        bestMedal: snapshot.race.result?.medal,
        bestPearlCount: 5,
      });
      expect(unlockedCourseIds(progress)).toEqual([
        'sunlit-shoals',
        'kelpworks',
        'blacksmoker-run',
      ]);
      expect(
        unlockedCourseIds(
          updateProgress(emptyProgress(), snapshot.race.result),
        ),
      ).toEqual(['sunlit-shoals']);
      expect(COURSES.find(({ id }) => id === 'kelpworks')?.available).toBe(
        true,
      );
      expect(
        COURSES.find(({ id }) => id === 'blacksmoker-run')?.available,
      ).toBe(false);
      elapsed[profile].push(snapshot.race.elapsedMs);
      expect(runtime.getDiagnostics()).toEqual(counts);
      runtime.dispose();
      runtime.dispose();
      expect(runtime.getDiagnostics()).toEqual({
        lifecycle: 'disposed',
        bodies: 0,
        colliders: 0,
        geometries: 0,
        materials: 0,
      });
    }
  }
  expect(new Set(elapsed.fast).size).toBe(1);
  expect(new Set(elapsed.conservative).size).toBe(1);
  expect(elapsed.fast[0]).toBeLessThan(elapsed.conservative[0]);
});
