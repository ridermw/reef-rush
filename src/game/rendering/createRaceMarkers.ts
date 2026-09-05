import { BufferGeometry, Mesh, TorusGeometry, Vector3 } from 'three';
import type { CourseRuntime } from '../course/createCourseRuntime';
import { RotatingGate } from '../obstacles/RotatingGate';
import type { RaceState } from '../race/raceTypes';
import type { VisualResources } from './visualResources';

/** Runtime route feedback and live obstacles, independent of terrain artwork. */
export function createRaceMarkers(
  course: CourseRuntime,
  { mesh, material, geometry }: VisualResources,
  box: BufferGeometry,
  sphere: BufferGeometry,
) {
  const rings: Mesh[] = [];
  const pearls = new Map<string, Mesh>();
  const gates: Array<{ mesh: Mesh; gate: RotatingGate }> = [];
  for (const object of course.definition.objects) {
    if (object.type !== 'current' && object.type !== 'rotating-gate') continue;
    const value = mesh(
      object.id,
      box,
      material(object.color, object.type === 'current' ? 0.12 : 1),
      object.type === 'current',
    );
    value.position.fromArray(object.position);
    value.scale.fromArray(object.halfExtents).multiplyScalar(2);
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
  const ring = geometry(new TorusGeometry(1, 0.035, 8, 48));
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
    value.userData.finish = index === course.definition.checkpoints.length - 1;
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
  return {
    present(race: RaceState, collectedPearlIds: readonly string[]) {
      for (const { mesh, gate } of gates) {
        mesh.position.copy(gate.body.translation());
        mesh.quaternion.copy(gate.body.rotation());
      }
      for (let index = 0; index < rings.length; index++) {
        const ring = rings[index];
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
      for (const [id, pearl] of pearls)
        pearl.visible = !collectedPearlIds.includes(id);
    },
  };
}
