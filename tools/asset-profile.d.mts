export type Vector3Tuple = readonly [number, number, number];
export type QuaternionTuple = readonly [number, number, number, number];

export type StaticSolidSource = {
  readonly id: string;
  readonly position: Vector3Tuple;
  readonly collision: 'environment' | 'hazard';
} & (
  | {
      readonly type: 'box';
      readonly halfExtents: Vector3Tuple;
      readonly rotation: QuaternionTuple;
    }
  | { readonly type: 'sphere'; readonly radius: number }
);

/** node.extras.reefRush; all transforms are in game/glTF meters, +Y up/+Z forward. */
export interface StaticSolidExtras {
  readonly version: 1;
  readonly role: 'static-solid';
  readonly id: string;
  readonly category: 'environment' | 'hazard';
  readonly primitive:
    | { readonly type: 'box'; readonly halfExtents: Vector3Tuple }
    | { readonly type: 'sphere'; readonly radius: number };
  readonly transform: {
    readonly position: Vector3Tuple;
    readonly rotation: QuaternionTuple;
    readonly scale: readonly [1, 1, 1];
  };
}

export interface NoncollidingExtras {
  readonly version: 1;
  readonly role: 'decoration' | 'fish-part';
  readonly collides: false;
}

export interface AssetReport {
  readonly asset: string;
  readonly bytes: number;
  /** Instantiated triangles, counting every node sharing a mesh. */
  readonly triangles: number;
  readonly meshNodes: number;
  readonly meshes: number;
  readonly materials: number;
  /** Primitive instances; a multi-material node can need multiple draws. */
  readonly drawCalls: number;
  readonly colliders: readonly StaticSolidExtras[];
}

export const ASSET_PATHS: readonly [
  'fish/sunfin.glb',
  'props/reef-kit.glb',
  'courses/sunlit-shoals.visual.glb',
  'courses/sunlit-shoals.collision.glb',
];
export function colliderContract(solid: StaticSolidSource): StaticSolidExtras;
export function validateGlb(
  input: Uint8Array,
  asset: (typeof ASSET_PATHS)[number],
  solids?: readonly StaticSolidSource[],
): AssetReport;
export function validateAssetSet(
  assetRoot: string,
  sourceFile: string,
): Promise<AssetReport[]>;
export function validateProject(
  projectRoot: string,
  assetRoot?: string,
): Promise<AssetReport[]>;
