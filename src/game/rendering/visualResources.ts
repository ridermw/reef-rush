import {
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';

export function createVisualResources(
  root: Group,
  releases: Array<() => void>,
) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<MeshStandardMaterial>();
  return {
    geometry<T extends BufferGeometry>(this: void, value: T): T {
      geometries.add(value);
      releases.push(() => {
        value.dispose();
        geometries.delete(value);
      });
      return value;
    },
    material(this: void, color: string, opacity = 1): MeshStandardMaterial {
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
    },
    mesh(
      this: void,
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
    },
    getResourceCounts() {
      return { geometries: geometries.size, materials: materials.size };
    },
  };
}

export type VisualResources = ReturnType<typeof createVisualResources>;
