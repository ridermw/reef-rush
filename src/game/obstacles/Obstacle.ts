import type { CourseObject } from '../course/courseDefinition';

export interface Obstacle {
  readonly definition: CourseObject;
  update(dt: number): void;
  dispose(): void;
}

export function assertDeltaTime(dt: number): void {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new RangeError('dt must be finite and nonnegative.');
  }
}
