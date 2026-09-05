import type { Box3 } from 'three';
import type { z } from 'zod';
import type { CourseObject } from '../course/courseDefinition';

export interface StaticSolidExtras {
  readonly version: 1;
  readonly role: 'static-solid';
  readonly id: string;
  readonly category: 'environment' | 'hazard';
  readonly primitive:
    | {
        readonly type: 'box';
        readonly halfExtents: readonly [number, number, number];
      }
    | { readonly type: 'sphere'; readonly radius: number };
  readonly transform: {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
    readonly scale: readonly [number, number, number];
  };
}
export const staticSolidExtrasSchema: z.ZodType<StaticSolidExtras>;
export function close(a: number, b: number): boolean;
export function sameVector(a: readonly number[], b: readonly number[]): boolean;
export function colliderContract(
  solid: Extract<CourseObject, { type: 'box' | 'sphere' }>,
): StaticSolidExtras;
export function validateSolidSurface(
  mesh: {
    bounds: Box3;
    triangles: number;
    surfaces: readonly {
      position: { values: number[] };
      indices: { values: number[]; count: number };
    }[];
  },
  contract: StaticSolidExtras,
): void;
