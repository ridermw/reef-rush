import { BufferGeometry, Group, type Mesh } from 'three';
import type {
  CourseDefinition,
  CurrentVolumeDefinition,
} from '../course/courseDefinition';
import type { VisualResources } from './visualResources';

/** Fixed-size, deterministic presentation only. No emitters or per-frame spawning. */
export function createWaterEffects(
  root: Group,
  definition: CourseDefinition,
  resources: VisualResources,
  sphere: BufferGeometry,
) {
  const ambient = new Group();
  ambient.name = 'ambient-bubbles';
  const current = new Group();
  current.name = 'current-particles';
  root.add(ambient, current);
  const bubbleMaterial = resources.material('#c5f5ed', 0.22);
  const currentMaterial = resources.material('#b2fff0', 0.38);
  const bubbles: Mesh[] = [];
  const particles: Array<{ mesh: Mesh; volume: CurrentVolumeDefinition }> = [];
  for (let i = 0; i < 32; i++) {
    const mesh = resources.mesh(
      `bubble-${i}`,
      sphere,
      bubbleMaterial,
      true,
      ambient,
    );
    mesh.scale.setScalar(0.035 + (i % 4) * 0.012);
    bubbles.push(mesh);
  }
  const volumes = definition.objects.filter(
    (object) => object.type === 'current',
  );
  for (let i = 0; i < (volumes.length ? 24 : 0); i++) {
    const mesh = resources.mesh(
      `current-particle-${i}`,
      sphere,
      currentMaterial,
      true,
      current,
    );
    mesh.scale.set(0.035, 0.035, 0.12);
    particles.push({ mesh, volume: volumes[i % volumes.length] });
  }
  let time = 0;
  function present(seconds: number) {
    // Reduce before adding: even Number.MAX_VALUE must not overflow this clock.
    time = (time + (seconds % 60)) % 60;
    for (let i = 0; i < bubbles.length; i++) {
      bubbles[i].position.set(
        (i % 2 ? -1 : 1) * (5 + ((i * 7) % 13)),
        -7.5 + ((i * 0.73 + time * 0.35) % 7),
        -5 + ((i * 37) % 110),
      );
    }
    for (let i = 0; i < particles.length; i++) {
      const { mesh, volume } = particles[i];
      for (let axis = 0; axis < 3; axis++) {
        const width = volume.halfExtents[axis] * 2;
        const offset =
          (i * (axis + 3) * 0.731 + time * volume.velocity[axis]) % width;
        mesh.position.setComponent(
          axis,
          volume.position[axis] - width / 2 + ((offset + width) % width),
        );
      }
    }
  }
  present(0);
  return {
    present,
    setReducedMotion(reduced: boolean) {
      ambient.visible = !reduced;
      current.visible = !reduced;
    },
  };
}
