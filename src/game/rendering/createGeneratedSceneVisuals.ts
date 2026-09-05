import {
  BoxGeometry,
  ConeGeometry,
  Group,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
} from 'three';
import {
  releaseResources,
  rollbackConstruction,
} from '../core/resourceCleanup';
import type { CourseRuntime } from '../course/createCourseRuntime';
import type { SceneVisuals } from './SceneVisuals';
import { createRaceMarkers } from './createRaceMarkers';
import { createVisualResources } from './visualResources';
import { attachUnderwaterEnvironment } from './underwaterEnvironment';

export type GeneratedSceneVisuals = SceneVisuals;

export function createGeneratedSceneVisuals(
  scene: Scene,
  course: CourseRuntime,
): GeneratedSceneVisuals {
  const root = new Group();
  root.name = 'generated-course';
  const fish = new Group();
  fish.name = 'player-fish';
  const releases: Array<() => void> = [];
  const resources = createVisualResources(root, releases);
  const { geometry, material, mesh } = resources;
  let disposed = false;

  try {
    attachUnderwaterEnvironment(
      scene,
      root,
      course.definition.visuals,
      releases,
    );

    const box = geometry(new BoxGeometry(1, 1, 1));
    const sphere = geometry(new SphereGeometry(1, 20, 16));
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
      if (object.type !== 'box' && object.type !== 'sphere') continue;
      const value = mesh(
        object.id,
        object.type === 'sphere' ? sphere : box,
        solidMaterial(object.color),
        false,
      );
      value.position.fromArray(object.position);
      if (object.type === 'sphere') {
        value.scale.setScalar(object.radius);
      } else {
        value.scale.fromArray(object.halfExtents).multiplyScalar(2);
      }
      if (object.type === 'box') value.quaternion.fromArray(object.rotation);
    }
    const markers = createRaceMarkers(course, resources, box, sphere);

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
        markers.present(race, collectedPearlIds);
        root.updateMatrixWorld(true);
      },
      getResourceCounts() {
        return Object.freeze(resources.getResourceCounts());
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
