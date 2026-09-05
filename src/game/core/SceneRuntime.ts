import { ColliderDesc } from '@dimforge/rapier3d-compat';
import { Euler, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { ChaseCamera } from '../camera/ChaseCamera';
import {
  parseCourseDefinition,
  type CourseDefinition,
} from '../course/courseDefinition';
import {
  createCourseRuntime,
  type CourseRuntime,
} from '../course/createCourseRuntime';
import { inputFrameSchema, type InputFrame } from '../input/InputFrame';
import { assertDeltaTime } from '../obstacles/Obstacle';
import { applyGameplayCollision } from '../physics/collisionGroups';
import {
  createPhysicsRuntime,
  type PhysicsRuntime,
} from '../physics/createPhysicsRuntime';
import {
  FishController,
  type FishControllerEvent,
} from '../player/FishController';
import type { FishState } from '../player/fishTypes';
import { RaceSession } from '../race/RaceSession';
import type { RaceEvent, RaceState } from '../race/raceTypes';
import {
  createGeneratedSceneVisuals,
  type GeneratedSceneVisuals,
} from '../rendering/createGeneratedSceneVisuals';
import { ConstructionCleanupError, releaseResources } from './resourceCleanup';
import {
  PLAYER_RADIUS,
  SCENE_CAMERA_TUNING,
  SCENE_FISH_TUNING,
} from './sceneRuntimeTuning';

/**
 * Physics step ceiling in seconds, matching FixedStepRunner's default frame cap.
 * Hosts should subdivide elapsed time (normally 1/60s steps), not pass large deltas.
 */
export const MAX_SCENE_STEP_SECONDS = 0.1;

export type SceneFishState = Readonly<
  Omit<FishState, 'position' | 'velocity'>
> & {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
};

export interface SceneSnapshot {
  readonly fish: SceneFishState;
  readonly race: RaceState;
  readonly collectedPearlIds: readonly string[];
}

export interface SceneStep {
  readonly snapshot: SceneSnapshot;
  readonly fishEvents: readonly FishControllerEvent[];
  readonly raceEvents: readonly RaceEvent[];
  readonly pauseRequested: boolean;
  readonly finished: boolean;
}

export interface SceneRuntimeDependencies {
  /** Transfers exclusive ownership of a fresh physics runtime to the scene. */
  readonly createPhysics?: () => Promise<PhysicsRuntime>;
  readonly createVisuals?: (
    scene: Scene,
    course: CourseRuntime,
  ) => GeneratedSceneVisuals;
}

export interface SceneRuntime {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly definition: CourseDefinition;
  getSnapshot(): SceneSnapshot;
  getDiagnostics(): Readonly<{
    lifecycle: 'active' | 'disposing' | 'disposed';
    bodies: number;
    colliders: number;
    geometries: number;
    materials: number;
  }>;
  start(): RaceState;
  pause(): RaceState;
  resume(): RaceState;
  /**
   * Requires normalized input and finite dt in [0, MAX_SCENE_STEP_SECONDS].
   * Rejects invalid arguments before pause handling or mutation, even at zero dt
   * or while paused/finished. Never clamps; valid inactive/zero steps do not advance.
   */
  step(input: InputFrame, dtSeconds: number): SceneStep;
  present(alpha: number, frameSeconds: number): void;
  dispose(): void;
}

export async function createSceneRuntime(
  inputDefinition: unknown,
  dependencies: SceneRuntimeDependencies = {},
): Promise<SceneRuntime> {
  const definition = parseCourseDefinition(inputDefinition);
  const scene = new Scene();
  const camera = new PerspectiveCamera(
    SCENE_CAMERA_TUNING.minFov,
    16 / 9,
    0.1,
    180,
  );
  const visualReleases: Array<() => void> = [];
  const physicsChildren: Array<() => void> = [];
  const physicsReleases: Array<() => void> = [];
  const constructionReleases: Array<() => void> = [];
  let lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  function cleanup(retryChild = true): unknown[] {
    const errors = releaseResources(visualReleases);
    if (retryChild) errors.push(...releaseResources(constructionReleases));
    errors.push(...releaseResources(physicsChildren));
    // Never free a world while a course, collider or failed constructor still owns it.
    if (physicsChildren.length === 0 && constructionReleases.length === 0) {
      errors.push(...releaseResources(physicsReleases));
    }
    return errors;
  }

  function dispose(): void {
    lifecycle = 'disposing';
    const errors = cleanup();
    if (errors.length > 0)
      throw new AggregateError(errors, 'Scene runtime cleanup failed.');
    lifecycle = 'disposed';
  }

  function assertLive(): void {
    if (lifecycle !== 'active') throw new Error('SceneRuntime is disposed.');
  }

  try {
    const physics = await (
      dependencies.createPhysics ?? createPhysicsRuntime
    )();
    physicsReleases.push(() => physics.dispose());
    const course = createCourseRuntime(physics, definition);
    physicsChildren.push(() => course.dispose());
    const collider = physics.world.createCollider(
      applyGameplayCollision(ColliderDesc.ball(PLAYER_RADIUS), 'player'),
    );
    physicsChildren.push(() => {
      if (collider.isValid()) physics.world.removeCollider(collider, false);
    });
    const controller = new FishController({
      runtime: physics,
      collider,
      tuning: SCENE_FISH_TUNING,
      initialState: {
        position: [...definition.spawn.position],
        velocity: [0, 0, 0],
        yaw: definition.spawn.yaw,
        pitch: 0,
        roll: 0,
        dashEnergy: 1,
        isSubmerged: definition.spawn.position[1] <= 0,
      },
    });
    const race = new RaceSession(definition, { playerRadius: PLAYER_RADIUS });
    const visuals = (dependencies.createVisuals ?? createGeneratedSceneVisuals)(
      scene,
      course,
    );
    visualReleases.push(() => visuals.dispose());
    visualReleases.push(() => camera.removeFromParent());
    scene.add(camera);
    const chase = new ChaseCamera(camera, SCENE_CAMERA_TUNING);
    let previous = controller.getState();
    let current = controller.getState();
    const position = new Vector3();
    const currentPosition = new Vector3();
    const orientation = new Quaternion();
    const previousOrientation = new Quaternion();
    const currentOrientation = new Quaternion();
    const euler = new Euler(0, 0, 0, 'YXZ');
    const forward = new Vector3();

    function getSnapshot(): SceneSnapshot {
      return Object.freeze({
        fish: Object.freeze({
          ...current,
          position: Object.freeze([...current.position] as [
            number,
            number,
            number,
          ]),
          velocity: Object.freeze([...current.velocity] as [
            number,
            number,
            number,
          ]),
        }),
        race: race.getState(),
        collectedPearlIds: race.getCollectedPearlIds(),
      });
    }

    function present(alpha: number, frameSeconds: number): void {
      assertLive();
      assertDeltaTime(frameSeconds);
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError('alpha must be finite and between 0 and 1.');
      }
      const poseAlpha = race.getState().status === 'running' ? alpha : 1;
      position
        .fromArray(previous.position)
        .lerp(currentPosition.fromArray(current.position), poseAlpha);
      previousOrientation.setFromEuler(
        euler.set(-previous.pitch, previous.yaw, previous.roll),
      );
      currentOrientation.setFromEuler(
        euler.set(-current.pitch, current.yaw, current.roll),
      );
      orientation.slerpQuaternions(
        previousOrientation,
        currentOrientation,
        poseAlpha,
      );
      visuals.present(
        position,
        orientation,
        race.getState(),
        race.getCollectedPearlIds(),
      );
      forward.set(0, 0, 1).applyQuaternion(orientation);
      chase.step(
        position.toArray(),
        forward.toArray(),
        [...current.velocity],
        frameSeconds,
      );
    }

    function step(input: InputFrame, dtSeconds: number): SceneStep {
      assertLive();
      assertDeltaTime(dtSeconds);
      if (dtSeconds > MAX_SCENE_STEP_SECONDS) {
        throw new RangeError(
          `dt must not exceed ${MAX_SCENE_STEP_SECONDS} seconds.`,
        );
      }
      const frame = inputFrameSchema.parse(input);
      const state = race.getState();
      if (state.status === 'ready')
        throw new Error('Cannot step a ready scene; call start first.');
      let fishEvents: FishControllerEvent[] = [];
      let raceEvents: readonly RaceEvent[] = [];
      let pauseRequested = false;
      if (state.status === 'running' && frame.pausePressed) {
        race.pause();
        pauseRequested = true;
        fishEvents = [{ type: 'pause-requested' }];
      } else if (state.status === 'running' && dtSeconds > 0) {
        course.update(dtSeconds);
        const result = controller.step(
          frame,
          {
            current: course.sampleCurrent(current.position),
            waterSurfaceY: 0,
          },
          dtSeconds,
        );
        const raceStep = race.step(
          current.position,
          result.state.position,
          dtSeconds,
        );
        previous = current;
        current = result.state;
        fishEvents = result.events;
        raceEvents = raceStep.events;
      }
      return Object.freeze({
        snapshot: getSnapshot(),
        fishEvents: Object.freeze(fishEvents),
        raceEvents,
        pauseRequested,
        finished: race.getState().status === 'finished',
      });
    }

    present(1, 0);
    return Object.freeze({
      scene,
      camera,
      definition,
      getSnapshot,
      step,
      present,
      dispose,
      getDiagnostics() {
        const counts =
          physicsChildren.length > 0
            ? {
                bodies: physics.world.bodies.len(),
                colliders: physics.world.colliders.len(),
              }
            : { bodies: 0, colliders: 0 };
        return Object.freeze({
          lifecycle,
          ...counts,
          ...visuals.getResourceCounts(),
        });
      },
      start() {
        assertLive();
        return race.start();
      },
      pause() {
        assertLive();
        return race.pause();
      },
      resume() {
        assertLive();
        return race.resume();
      },
    } satisfies SceneRuntime);
  } catch (cause) {
    if (cause instanceof ConstructionCleanupError) {
      constructionReleases.push(() => cause.retryCleanup());
    }
    // A failed child has already attempted rollback. Its first retry belongs to the caller.
    const errors = cleanup(false);
    if (errors.length > 0 || constructionReleases.length > 0) {
      throw new ConstructionCleanupError(
        cause,
        errors,
        [dispose],
        'Scene runtime creation and resource cleanup failed.',
      );
    }
    throw cause;
  }
}
