import { z } from 'zod';

const axisSchema = z.number().finite().min(-1).max(1);

/**
 * Normalized mathematical axes, not screen-space directions:
 * steerX > 0 increases right-handed yaw (+Z forward turns camera-left);
 * steerY > 0 increases pitch (nose up); throttle > 0 accelerates.
 * Validation never clamps axes or coerces actions.
 */
export const inputFrameSchema = z.object({
  steerX: axisSchema,
  steerY: axisSchema,
  throttle: axisSchema,
  dashPressed: z.boolean(),
  brakeHeld: z.boolean(),
  pausePressed: z.boolean(),
});

export type InputFrame = z.infer<typeof inputFrameSchema>;
