import { z } from 'zod';

export const medalSchema = z.enum(['gold', 'silver', 'bronze']);
export type Medal = z.infer<typeof medalSchema>;

export const elapsedMsSchema = z.number().finite().nonnegative();
const positiveMs = z.number().finite().positive();
export const medalTimesMsSchema = z
  .strictObject({ gold: positiveMs, silver: positiveMs, bronze: positiveMs })
  .refine(
    ({ gold, silver, bronze }) => gold < silver && silver < bronze,
    'Medal times must satisfy gold < silver < bronze.',
  )
  .readonly();
export type MedalTimesMs = z.infer<typeof medalTimesMsSchema>;

export function awardMedal(
  elapsedMs: unknown,
  thresholds: unknown,
): Medal | null {
  const elapsed = elapsedMsSchema.parse(elapsedMs);
  const times = medalTimesMsSchema.parse(thresholds);
  for (const medal of medalSchema.options) {
    if (elapsed <= times[medal]) return medal;
  }
  return null;
}
