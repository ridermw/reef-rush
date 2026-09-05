import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import {
  releaseResources,
  rollbackConstruction,
} from '../core/resourceCleanup';
import type { CourseRuntime } from '../course/createCourseRuntime';
import { RotatingGate } from '../obstacles/RotatingGate';
import type { RaceState } from '../race/raceTypes';

export interface GeneratedSceneVisuals {
  readonly root: Group;
  present(
    position: Vector3,
    orientation: Quaternion,
    race: RaceState,
    collectedPearlIds: readonly string[],
  ): void;
  getResourceCounts(): Readonly<{ geometries: number; materials: number }>;
  dispose(): void;
}

export function createGeneratedSceneVisuals(
  scene: Scene,
  course: CourseRuntime,
): GeneratedSceneVisuals {
  const root = new Group();
  root.name = 'generated-course';
  const fish = new Group();
  fish.name = 'player-fish';
  const releases: Array<() => void> = [];
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<MeshStandardMaterial>();
  const rings: Mesh[] = [];
  const pearls = new Map<string, Mesh>();
  const gates: Array<{ mesh: Mesh; gate: RotatingGate }> = [];
  let disposed = false;

  function geometry<T extends BufferGeometry>(value: T): T {
    geometries.add(value);
    releases.push(() => {
      value.dispose();
      geometries.delete(value);
    });
    return value;
  }

  function material(color: string, opacity = 1): MeshStandardMaterial {
    const value = new MeshStandardMaterial({
      color,
      roughness: 0.75,
      metalness: 0,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity === 1,
      side: DoubleSide,
    });
    materials.add(value);
    releases.push(() => {
      value.dispose();
      materials.delete(value);
    });
    return value;
  }

  function mesh(
    name: string,
    shape: BufferGeometry,
    surface: MeshStandardMaterial,
    decorative: boolean,
    parent = root,
  ): Mesh {
    const value = new Mesh(shape, surface);
    value.name = name;
    if (decorative) value.userData.ignoreChaseCameraCollision = true;
    parent.add(value);
    return value;
  }

  try {
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    releases.push(() => {
      scene.background = previousBackground;
      scene.fog = previousFog;
      root.removeFromParent();
    });
    scene.background = new Color(course.definition.visuals.waterColor);
    scene.fog = new Fog(course.definition.visuals.waterColor, 25, 130);
    root.add(
      new HemisphereLight(
        '#d1f7f4',
        course.definition.visuals.seabedColor,
        2.4,
      ),
    );
    const sunlight = new DirectionalLight('#fff3d6', 2.5);
    sunlight.position.set(-15, 25, -10);
    root.add(sunlight);

    const box = geometry(new BoxGeometry(1, 1, 1));
    const sphere = geometry(new SphereGeometry(1, 20, 16));
    const ring = geometry(new TorusGeometry(1, 0.035, 8, 48));
    const fin = geometry(new ConeGeometry(1, 1, 3));
    const solidMaterials = new Map<string, MeshStandardMaterial>();
    function solidMaterial(color: string): MeshStandardMaterial {
      let value = solidMaterials.get(color);
      if (!value) {
        value = material(color);
        solidMaterials.set(color, value);
      }
      return value;
    }
    for (const object of course.definition.objects) {
      const value = mesh(
        object.id,
        object.type === 'sphere' ? sphere : box,
        object.type === 'current'
          ? material(object.color, 0.12)
          : solidMaterial(object.color),
        object.type === 'current',
      );
      value.position.fromArray(object.position);
      if (object.type === 'sphere') {
        value.scale.setScalar(object.radius);
      } else {
        value.scale.fromArray(object.halfExtents).multiplyScalar(2);
      }
      if (object.type === 'box') value.quaternion.fromArray(object.rotation);
      if (object.type === 'rotating-gate') {
        const gate = course.obstacles.find(
          (obstacle): obstacle is RotatingGate =>
            obstacle instanceof RotatingGate &&
            obstacle.definition.id === object.id,
        );
        if (!gate) throw new Error(`Missing live rotating gate: ${object.id}`);
        gates.push({ mesh: value, gate });
        value.quaternion.copy(gate.body.rotation());
      }
    }

    const ringMaterials = {
      upcoming: material('#a8fff1'),
      future: material('#4b9fac', 0.5),
      completed: material('#50bd8c', 0.35),
      finish: material('#ffda79'),
    };
    ringMaterials.upcoming.emissive.set('#28675f');
    ringMaterials.finish.emissive.set('#674010');
    for (const [index, checkpoint] of course.definition.checkpoints.entries()) {
      const value = mesh(checkpoint.id, ring, ringMaterials.future, true);
      value.position.fromArray(checkpoint.position);
      value.scale.setScalar(checkpoint.radius);
      value.quaternion.setFromUnitVectors(
        new Vector3(0, 0, 1),
        new Vector3(...checkpoint.direction),
      );
      value.userData.finish =
        index === course.definition.checkpoints.length - 1;
      rings.push(value);
    }
    const pearlMaterial = material('#fff0cc');
    pearlMaterial.emissive.set('#60543a');
    for (const pearl of course.definition.pearls ?? []) {
      const value = mesh(pearl.id, sphere, pearlMaterial, true);
      value.position.fromArray(pearl.position);
      value.scale.setScalar(pearl.radius);
      pearls.set(pearl.id, value);
    }

    root.add(fish);
    const fishMaterial = material('#f29148');
    const paleMaterial = material('#fff1c9');
    const eyeMaterial = material('#193e49');
    mesh('fish-body', sphere, fishMaterial, true, fish).scale.set(
      0.3,
      0.36,
      0.65,
    );
    const tail = mesh('fish-tail', fin, fishMaterial, true, fish);
    tail.position.z = -0.72;
    tail.rotation.x = Math.PI / 2;
    tail.scale.set(0.4, 0.45, 0.18);
    for (const side of [-1, 1]) {
      const eye = mesh(`fish-eye-${side}`, sphere, paleMaterial, true, fish);
      eye.position.set(side * 0.23, 0.12, 0.36);
      eye.scale.setScalar(0.1);
      const pupil = mesh(`fish-pupil-${side}`, sphere, eyeMaterial, true, fish);
      pupil.position.set(side * 0.29, 0.13, 0.4);
      pupil.scale.setScalar(0.05);
      const sideFin = mesh(`fish-fin-${side}`, fin, fishMaterial, true, fish);
      sideFin.position.set(side * 0.34, -0.08, -0.12);
      sideFin.rotation.z = (side * Math.PI) / 3;
      sideFin.scale.set(0.2, 0.4, 0.08);
    }
    scene.add(root);

    return Object.freeze({
      root,
      present(position, orientation, race, collectedPearlIds): void {
        if (disposed) throw new Error('GeneratedSceneVisuals is disposed.');
        fish.position.copy(position);
        fish.quaternion.copy(orientation);
        for (const { mesh, gate } of gates) {
          mesh.position.copy(gate.body.translation());
          mesh.quaternion.copy(gate.body.rotation());
        }
        for (const [index, ring] of rings.entries()) {
          const state =
            index < race.checkpointIndex
              ? 'completed'
              : index === race.checkpointIndex
                ? 'upcoming'
                : 'future';
          ring.userData.checkpointState = state;
          ring.material =
            ring.userData.finish && state !== 'completed'
              ? ringMaterials.finish
              : ringMaterials[state];
        }
        const collected = new Set(collectedPearlIds);
        for (const [id, pearl] of pearls) pearl.visible = !collected.has(id);
        root.updateMatrixWorld(true);
      },
      getResourceCounts() {
        return Object.freeze({
          geometries: geometries.size,
          materials: materials.size,
        });
      },
      dispose(): void {
        disposed = true;
        const errors = releaseResources(releases);
        if (errors.length > 0)
          throw new AggregateError(errors, 'Generated visual cleanup failed.');
      },
    } satisfies GeneratedSceneVisuals);
  } catch (cause) {
    rollbackConstruction(
      cause,
      releases,
      'Generated scene creation and resource cleanup failed.',
    );
  }
}
