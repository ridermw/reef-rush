import { z } from 'zod';

const axisSchema = z.number().finite().min(-1).max(1);

/** Normalized input only: validation never clamps axes or coerces actions. */
export const inputFrameSchema = z.object({
  steerX: axisSchema,
  steerY: axisSchema,
  throttle: axisSchema,
  dashPressed: z.boolean(),
  brakeHeld: z.boolean(),
  pausePressed: z.boolean(),
});

export type InputFrame = z.infer<typeof inputFrameSchema>;
