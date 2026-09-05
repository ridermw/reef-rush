export interface ExactFraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const bits = new DataView(new ArrayBuffer(8));

export function dyadic(value: number) {
  bits.setFloat64(0, value);
  const word = bits.getBigUint64(0);
  const exponent = Number((word >> 52n) & 2047n);
  const significand =
    (word & ((1n << 52n) - 1n)) | (exponent === 0 ? 0n : 1n << 52n);
  return {
    significand: word >> 63n ? -significand : significand,
    exponent: exponent === 0 ? -1074 : exponent - 1075,
  };
}

// Finite binary64 values represented exactly in a shared power-of-two unit.
export function exactIntegers(values: readonly number[]): bigint[] {
  const parts = values.map(dyadic);
  const exponent = Math.min(
    0,
    ...parts
      .filter((value) => value.significand !== 0n)
      .map((value) => value.exponent),
  );
  return parts.map(
    (value) => value.significand << BigInt(value.exponent - exponent),
  );
}

// Combine finite dyadic factors before division, even when an intermediate
// product or the unscaled fraction is outside binary64's representable range.
export function scaledRatio(
  fraction: ExactFraction,
  scale: number,
  unitScale = 1,
  divisor = 1,
  offset?: ExactFraction,
): number {
  const multiplier = dyadic(scale);
  const units = dyadic(unitScale);
  const divider = dyadic(divisor);
  const exponent = multiplier.exponent + units.exponent - divider.exponent;
  const numerator =
    fraction.numerator * multiplier.significand * units.significand;
  const denominator = fraction.denominator * divider.significand;
  const n = exponent > 0 ? numerator << BigInt(exponent) : numerator;
  const d = exponent < 0 ? denominator << BigInt(-exponent) : denominator;
  // Include the active clock before the one public timestamp rounding.
  return offset
    ? ratio(
        n * offset.denominator + offset.numerator * d,
        d * offset.denominator,
      )
    : ratio(n, d);
}

// Round a nonnegative rational once, including ties-to-even and subnormals.
export function ratio(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (
    exponent >= 0
      ? numerator < denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) < denominator
  ) {
    exponent--;
  }
  const unitExponent = Math.max(-1074, exponent - 52);
  const n = unitExponent < 0 ? numerator << BigInt(-unitExponent) : numerator;
  const d =
    unitExponent > 0 ? denominator << BigInt(unitExponent) : denominator;
  let quotient = n / d;
  const remainder = (n % d) * 2n;
  if (remainder > d || (remainder === d && quotient % 2n !== 0n)) quotient++;
  return Number(quotient) * 2 ** unitExponent;
}
