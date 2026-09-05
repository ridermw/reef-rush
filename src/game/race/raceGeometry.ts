import type { CourseDefinition, Vector3 } from '../course/courseDefinition';
import { exactIntegers, type ExactFraction } from './exactArithmetic';
import { exactSphereEntry } from './exactSphereEntry';
import { scaleIntersection, type RaceIntersection } from './raceIntersection';

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('Race movement geometry overflow.');
  }
  return value;
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return [finite(a[0] - b[0]), finite(a[1] - b[1]), finite(a[2] - b[2])];
}

function dot(a: Vector3, b: Vector3): number {
  return finite(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

function scaledVector(value: Vector3, scale: number): Vector3 {
  return [value[0] / scale, value[1] / scale, value[2] / scale];
}

export function movementSegment(from: Vector3, to: Vector3) {
  const delta = subtract(to, from);
  const length = finite(Math.hypot(...delta));
  return { from, to, delta, length };
}

type Segment = ReturnType<typeof movementSegment>;

export function checkpointFraction(
  segment: Segment,
  checkpoint: CourseDefinition['checkpoints'][number],
): ExactFraction | null {
  const integers = exactIntegers([
    ...segment.from,
    ...segment.to,
    ...checkpoint.position,
    ...checkpoint.direction,
    checkpoint.radius,
  ]);
  let numerator = 0n;
  let denominator = 0n;
  for (let axis = 0; axis < 3; axis++) {
    const normal = integers[axis + 9];
    numerator += (integers[axis + 6] - integers[axis]) * normal;
    denominator += (integers[axis + 3] - integers[axis]) * normal;
  }
  // Raw direction defines the plane. Arrival counts; departure does not.
  if (numerator <= 0n || numerator > denominator) return null;

  // The rational intersection lies exactly on the plane, so its full squared
  // distance is radial. Compare before rounding either the fraction or point.
  let distanceSquared = 0n;
  for (let axis = 0; axis < 3; axis++) {
    const hit =
      (integers[axis] - integers[axis + 6]) * denominator +
      (integers[axis + 3] - integers[axis]) * numerator;
    distanceSquared += hit * hit;
  }
  const radius = integers[12] * denominator;
  return distanceSquared <= radius * radius ? { numerator, denominator } : null;
}

export function pickupFraction(
  segment: Segment,
  center: Vector3,
  radius: number,
  finish?: ExactFraction,
): number | null {
  const contact = pickupIntersection(segment, center, radius, finish);
  return contact === null
    ? null
    : Math.min(
        scaleIntersection(contact, 1),
        finish ? scaleIntersection(finish, 1) : 1,
      );
}

export function pickupIntersection(
  segment: Segment,
  center: Vector3,
  radius: number,
  finish?: ExactFraction,
): RaceIntersection | null {
  finite(radius);
  const offset = subtract(center, segment.from);
  finite(Math.hypot(...offset));
  if (finish) {
    return exactSphereEntry(segment.from, segment.to, center, radius, finish);
  }
  const largest = Math.max(
    radius,
    ...offset.map(Math.abs),
    ...segment.delta.map(Math.abs),
  );
  const scale = 2 ** Math.min(1023, Math.floor(Math.log2(largest)));
  const direction = scaledVector(segment.delta, scale);
  const relative = scaledVector(offset, scale);
  const r = radius / scale;
  const a = dot(direction, direction);
  const b = dot(relative, direction);
  const offsetSquared = dot(relative, relative);
  const c = offsetSquared - r * r;
  const cross: Vector3 = [
    relative[1] * direction[2] - relative[2] * direction[1],
    relative[2] * direction[0] - relative[0] * direction[2],
    relative[0] * direction[1] - relative[1] * direction[0],
  ];
  const discriminant = a * (r * r) - dot(cross, cross);
  const end = scaledVector(subtract(center, segment.to), scale);
  const endSquared = dot(end, end);
  const endDistance = endSquared - r * r;

  // Each polynomial path has <= 12 rounded operations, including coordinate
  // subtraction. gamma(32) also covers the positive error-bound arithmetic.
  // The absolute monomial sums bound cancellation; uncertain signs go to an
  // exact dyadic predicate instead of admitting a world-space radius epsilon.
  const u = Number.EPSILON / 2;
  const gamma = (32 * u) / (1 - 32 * u);
  const error = (permanent: number) =>
    gamma * permanent + 32 * Number.MIN_VALUE;
  const cError = error(offsetSquared + r * r);
  if (c < -cError) return { numerator: 0n, denominator: 1n };
  const bError = error((a + offsetSquared) / 2);
  const discriminantError = error(a * (r * r + 2 * offsetSquared));
  if (
    c > cError &&
    (segment.length === 0 ||
      b < -bError ||
      discriminant < -discriminantError ||
      (b - a > error((a + offsetSquared) / 2 + a) &&
        endDistance > error(endSquared + r * r)))
  ) {
    return null;
  }
  // Uncertain predicates and candidate hits need exact coefficients: even a
  // sign-correct difference of squared distances can lose contact-time bits.
  return exactSphereEntry(segment.from, segment.to, center, radius);
}
