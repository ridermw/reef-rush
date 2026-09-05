import { MeshBasicMaterial, MeshStandardMaterial, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function assertThreeLibraryTypes(renderer: WebGLRenderer) {
  const material = new MeshStandardMaterial({ roughness: 0.7 });
  material.color.set('#208eaa');
  const loader = new GLTFLoader();
  // @ts-expect-error Material opacity is numeric, not arbitrary configuration.
  new MeshBasicMaterial({ opacity: 'opaque' });
  return { material, loader, geometries: renderer.info.memory.geometries };
}
