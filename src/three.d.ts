declare module 'three' {
  export class Vector3 {
    x: number;
    y: number;
    z: number;

    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    copy(vector: Vector3): this;
    clone(): Vector3;
    addScaledVector(vector: Vector3, scale: number): this;
    sub(vector: Vector3): this;
    lerp(vector: Vector3, alpha: number): this;
    length(): number;
    lengthSq(): number;
    normalize(): this;
    distanceTo(vector: Vector3): number;
    toArray(): [number, number, number];
  }

  export class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    copy(quaternion: Quaternion): this;
    slerp(quaternion: Quaternion, alpha: number): this;
  }

  export class Object3D {
    parent: Object3D | null;
    children: Object3D[];
    position: Vector3;
    quaternion: Quaternion;
    userData: Record<string, unknown>;

    add(...objects: Object3D[]): this;
    lookAt(target: Vector3): void;
    updateMatrixWorld(force?: boolean): void;
  }

  export class Scene extends Object3D {}

  export class PerspectiveCamera extends Object3D {
    fov: number;

    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    updateProjectionMatrix(): void;
    getWorldDirection(target: Vector3): Vector3;
  }

  export class BoxGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }

  export class MeshBasicMaterial {
    constructor(parameters?: Record<string, unknown>);
  }

  export class Mesh<
    TGeometry extends object = BoxGeometry,
    TMaterial extends object = MeshBasicMaterial,
  > extends Object3D {
    constructor(geometry: TGeometry, material: TMaterial);
  }

  export interface Intersection<TObject extends Object3D = Object3D> {
    distance: number;
    object: TObject;
  }

  export class Raycaster {
    far: number;

    constructor();
    set(origin: Vector3, direction: Vector3): void;
    intersectObjects(
      objects: Object3D[],
      recursive?: boolean,
    ): Array<Intersection>;
  }
}
