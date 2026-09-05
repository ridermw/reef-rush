import type { Vector3 } from '../course/courseDefinition';
import { exactIntegers, type ExactFraction } from './exactArithmetic';
import type { RaceIntersection } from './raceIntersection';

function integerSquareRoot(value: bigint): bigint {
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  let next = (root + value / root) / 2n;
  while (next < root) {
    root = next;
    next = (root + value / root) / 2n;
  }
  return root;
}

/**
 * Adaptive predicate fallback, not a contact tolerance: binary64 coordinates
 * are dyadic rationals, so the quadratic signs can be evaluated exactly.
 * This also retains subtraction bits lost when forming a floating delta.
 */
export function exactSphereEntry(
  from: Vector3,
  to: Vector3,
  center: Vector3,
  radius: number,
  finish?: ExactFraction,
): RaceIntersection | null {
  const integers = exactIntegers([...from, ...to, ...center, radius]);
  let a = 0n;
  let b = 0n;
  let c = -(integers[9] * integers[9]);
  const { numerator: limitNumerator, denominator: limitDenominator } =
    finish ?? { numerator: 1n, denominator: 1n };
  for (let axis = 0; axis < 3; axis++) {
    const delta = integers[axis + 3] - integers[axis];
    const offset = integers[axis + 6] - integers[axis];
    a += delta * delta;
    b += offset * delta;
    c += offset * offset;
  }
  if (
    limitDenominator <= 0n ||
    limitNumerator < 0n ||
    limitNumerator > limitDenominator
  ) {
    throw new RangeError(
      'Race finish plane does not cross the movement segment.',
    );
  }
  if (c <= 0n) return { numerator: 0n, denominator: 1n };
  if (a === 0n || b <= 0n) return null;
  const discriminant = b * b - a * c;
  // Evaluate the clipped endpoint as a rational, without first rounding a
  // contact fraction or world-space endpoint. Near-before tangents stay out.
  const endDistance =
    a * limitNumerator * limitNumerator -
    2n * b * limitNumerator * limitDenominator +
    c * limitDenominator * limitDenominator;
  const vertexAfterEnd = b * limitDenominator > a * limitNumerator;
  if (discriminant < 0n || (vertexAfterEnd && endDistance > 0n)) return null;
  if (discriminant === 0n) return { numerator: b, denominator: a };
  if (endDistance === 0n && vertexAfterEnd) {
    return { numerator: limitNumerator, denominator: limitDenominator };
  }

  const root = integerSquareRoot(discriminant);
  return root * root === discriminant
    ? { numerator: c, denominator: b + root }
    : { a, b, c, discriminant };
}
