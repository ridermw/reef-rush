import type { Group, Quaternion, Vector3 } from 'three';
import type { RaceState } from '../race/raceTypes';

export interface SceneVisuals {
  readonly root: Group;
  present(
    position: Vector3,
    orientation: Quaternion,
    race: RaceState,
    collectedPearlIds: readonly string[],
    frameSeconds?: number,
  ): void;
  getResourceCounts(): Readonly<{ geometries: number; materials: number }>;
  dispose(): void;
}
