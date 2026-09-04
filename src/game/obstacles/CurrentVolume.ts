import {
  currentVolumeSchema,
  vector3Schema,
  type CurrentVolumeDefinition,
  type Vector3,
} from '../course/courseDefinition';
import { assertDeltaTime, type Obstacle } from './Obstacle';

export class CurrentVolume implements Obstacle {
  readonly definition: CurrentVolumeDefinition;
  private disposed = false;

  constructor(input: unknown) {
    this.definition = currentVolumeSchema.parse(input);
  }

  update(dt: number): void {
    this.assertLive();
    assertDeltaTime(dt);
  }

  sampleCurrent(position: Vector3): [number, number, number] {
    this.assertLive();
    const point = vector3Schema.parse(position);
    const { position: center, halfExtents, velocity } = this.definition;
    // Compare authored bounds directly so fractional faces stay inclusive.
    const inside = point.every(
      (coordinate, index) =>
        coordinate >= center[index] - halfExtents[index] &&
        coordinate <= center[index] + halfExtents[index],
    );
    return inside ? [...velocity] : [0, 0, 0];
  }

  dispose(): void {
    this.disposed = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('CurrentVolume is disposed.');
  }
}
