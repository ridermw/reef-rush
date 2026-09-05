import { z } from 'zod';

const legacySettingsSchema = z.strictObject({
  version: z.literal(1),
  masterVolume: z.number().finite().min(0).max(1),
  sfxEnabled: z.boolean(),
  musicEnabled: z.boolean(),
  mouseSteering: z.boolean(),
  mouseSensitivity: z.number().finite().min(0.25).max(2),
  invertMouseY: z.boolean(),
  reducedMotion: z.boolean(),
});

export const renderQualitySchema = z.enum(['low', 'medium', 'high']);
export type RenderQuality = z.infer<typeof renderQualitySchema>;

const settingsObjectSchema = legacySettingsSchema.extend({
  version: z.literal(2),
  renderQuality: renderQualitySchema,
});

export const settingsSchema = settingsObjectSchema.readonly();
export type Settings = z.infer<typeof settingsSchema>;

export const settingsReadSchema = z.union([
  settingsSchema,
  legacySettingsSchema.transform((legacy) =>
    settingsSchema.parse({ ...legacy, version: 2, renderQuality: 'high' }),
  ),
]);

export const settingsPatchSchema = settingsObjectSchema
  .omit({ version: true })
  .partial()
  .refine(
    (patch) => Object.values(patch).every((value) => value !== undefined),
    'Supplied settings must not be undefined.',
  )
  .readonly();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const inputPreferencesSchema = settingsObjectSchema
  .pick({ mouseSteering: true, mouseSensitivity: true, invertMouseY: true })
  .readonly();
export type InputPreferences = z.infer<typeof inputPreferencesSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({
  version: 2,
  masterVolume: 0.4,
  sfxEnabled: true,
  musicEnabled: false,
  mouseSteering: true,
  mouseSensitivity: 1,
  invertMouseY: false,
  reducedMotion: false,
  renderQuality: 'high',
});

export const DEFAULT_INPUT_PREFERENCES: InputPreferences =
  inputPreferencesSchema.parse({
    mouseSteering: DEFAULT_SETTINGS.mouseSteering,
    mouseSensitivity: DEFAULT_SETTINGS.mouseSensitivity,
    invertMouseY: DEFAULT_SETTINGS.invertMouseY,
  });

export function parseSettings(input: unknown): Settings {
  return settingsReadSchema.parse(input);
}
