import {
  renderQualitySchema,
  type RenderQuality,
} from '../../settings/settings';

const scales: Readonly<Record<RenderQuality, number>> = {
  low: 0.5,
  medium: 0.75,
  high: 1,
};

export function renderPixelRatio(dpr: number, quality: RenderQuality): number {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new RangeError('Invalid render pixel ratio.');
  }
  const ratio = Math.min(2, dpr) * scales[renderQualitySchema.parse(quality)];
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError('Invalid scaled render pixel ratio.');
  }
  return ratio;
}
