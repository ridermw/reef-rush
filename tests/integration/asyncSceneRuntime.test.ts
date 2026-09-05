// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  createSceneRuntime,
  type SceneRuntime,
} from '../../src/game/core/SceneRuntime';
import { ConstructionCleanupError } from '../../src/game/core/resourceCleanup';
import { createPhysicsRuntime } from '../../src/game/physics/createPhysicsRuntime';
import { createGeneratedSceneVisuals } from '../../src/game/rendering/createGeneratedSceneVisuals';
import { courseFixture } from '../fixtures/courseDefinition';
import { deferred } from '../fixtures/originalAssets';

const owners: Array<{ dispose(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0).reverse()) owner.dispose();
});

it('awaits asynchronous visual construction before initial presentation', async () => {
  const gate = deferred<void>();
  let runtime: SceneRuntime | undefined;
  let entered = false;
  const pending = createSceneRuntime(courseFixture(), {
    createVisuals: async (scene, course) => {
      entered = true;
      await gate.promise;
      return createGeneratedSceneVisuals(scene, course);
    },
  }).then((value) => {
    runtime = value;
    owners.push(value);
    return value;
  });
  const outcome = pending.catch((error: unknown) => error);
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(runtime).toBeUndefined();
  gate.resolve();
  expect(await outcome).not.toBeInstanceOf(Error);
  expect(typeof runtime?.present).toBe('function');
});

it('retains an async child owner and its dependent world without implicit retry', async () => {
  const physics = await createPhysicsRuntime();
  owners.push(physics);
  const worldFree = vi.spyOn(physics.world, 'free');
  const cleanup = vi.fn();
  const child = new ConstructionCleanupError(
    new Error('async construction'),
    [],
    [cleanup],
    'child owner',
  );
  const error: unknown = await createSceneRuntime(courseFixture(), {
    createPhysics: () => Promise.resolve(physics),
    createVisuals: () => Promise.reject(child),
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConstructionCleanupError);
  if (!(error instanceof ConstructionCleanupError)) throw error;
  owners.push(error);
  expect(cleanup).not.toHaveBeenCalled();
  expect(worldFree).not.toHaveBeenCalled();
  error.retryCleanup();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(worldFree).toHaveBeenCalledTimes(1);
});
