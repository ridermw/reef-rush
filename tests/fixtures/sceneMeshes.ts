import { type BufferGeometry, type Material, Mesh, type Object3D } from 'three';

export function isSceneMesh(
  object: Object3D | undefined,
): object is Mesh<BufferGeometry, Material | Material[]> {
  return object instanceof Mesh;
}
