import { ratio, scaledRatio, type ExactFraction } from './exactArithmetic';

export interface SphereRoot {
  readonly a: bigint;
  readonly b: bigint;
  readonly c: bigint;
  readonly discriminant: bigint;
}

// A sphere root is the earliest root of a*t^2 - 2*b*t + c, not its display value.
export type RaceIntersection = ExactFraction | SphereRoot;

export function scaleIntersection(
  intersection: RaceIntersection,
  scale: number,
  unitScale = 1,
  offset?: ExactFraction,
): number {
  if (!('discriminant' in intersection)) {
    return scaledRatio(intersection, scale, unitScale, 1, offset);
  }
  const { b, c, discriminant } = intersection;
  // Both root-factor operations are bounded: D/b^2 is in [0, 1].
  // Fold the dyadic unit conversion and divisor into the final ratio: neither
  // scale*c/b nor scale*unitScale needs to be representable on its own.
  const divisor = 1 + Math.sqrt(ratio(discriminant, b * b));
  return scaledRatio(
    { numerator: c, denominator: b },
    scale,
    unitScale,
    divisor,
    offset,
  );
}

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSphereToFraction(
  root: SphereRoot,
  fraction: ExactFraction,
): number {
  const { numerator, denominator } = fraction;
  const difference = root.b * denominator - root.a * numerator;
  if (difference < 0n) return -1;
  return compare(
    difference * difference,
    root.discriminant * denominator * denominator,
  );
}

export function compareIntersections(
  left: RaceIntersection,
  right: RaceIntersection,
): number {
  if (!('discriminant' in left)) {
    return 'discriminant' in right
      ? -compareSphereToFraction(right, left)
      : compare(
          left.numerator * right.denominator,
          right.numerator * left.denominator,
        );
  }
  if (!('discriminant' in right)) {
    return compareSphereToFraction(left, right);
  }
  // Compare k + sqrt(q) - sqrt(p). Establish signs before squaring, so
  // chronological order remains exact even when both output times underflow.
  const k = left.b * right.a - right.b * left.a;
  if (k < 0n) return -compareIntersections(right, left);
  const p = right.a * right.a * left.discriminant;
  const q = left.a * left.a * right.discriminant;
  if (p <= q) return k === 0n ? compare(q, p) : 1;
  const difference = p - q - k * k;
  return difference < 0n ? 1 : compare(4n * k * k * q, difference * difference);
}
