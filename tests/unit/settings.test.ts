import { expect, it } from 'vitest';
import {
  DEFAULT_INPUT_PREFERENCES,
  DEFAULT_SETTINGS,
  inputPreferencesSchema,
  parseSettings,
  settingsPatchSchema,
  settingsSchema,
} from '../../src/settings/settings';

it('exports validated immutable flat v1 defaults', () => {
  expect(DEFAULT_SETTINGS).toEqual({
    version: 1,
    masterVolume: 0.4,
    sfxEnabled: true,
    musicEnabled: false,
    mouseSteering: true,
    mouseSensitivity: 1,
    invertMouseY: false,
    reducedMotion: false,
  });
  expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  const source = { ...DEFAULT_SETTINGS, masterVolume: 0.7 };
  const parsed = parseSettings(source);
  source.masterVolume = 0.2;
  expect(parsed.masterVolume).toBe(0.7);
  expect(Object.isFrozen(parsed)).toBe(true);
});

it.each([
  { masterVolume: 0 },
  { masterVolume: 1 },
  { mouseSensitivity: 0.25 },
  { mouseSensitivity: 2 },
])('accepts inclusive bounds %j', (patch) => {
  expect(parseSettings({ ...DEFAULT_SETTINGS, ...patch })).toMatchObject(patch);
  expect(settingsPatchSchema.parse(patch)).toEqual(patch);
});

const invalidValues = [
  { masterVolume: -0.001 },
  { masterVolume: 1.001 },
  { masterVolume: NaN },
  { masterVolume: Infinity },
  { masterVolume: -Infinity },
  { masterVolume: '0.4' },
  { masterVolume: null },
  { mouseSensitivity: 0.249 },
  { mouseSensitivity: 2.001 },
  { mouseSensitivity: NaN },
  { mouseSensitivity: Infinity },
  { mouseSensitivity: -Infinity },
  { mouseSensitivity: '1' },
  { mouseSensitivity: null },
  ...[
    'sfxEnabled',
    'musicEnabled',
    'mouseSteering',
    'invertMouseY',
    'reducedMotion',
  ].flatMap((field) =>
    [0, 1, 'true', 'false', null, undefined].map((value) => ({
      [field]: value,
    })),
  ),
  { unexpected: true },
  { masterVolume: undefined },
  { mouseSensitivity: undefined },
];

it.each(invalidValues)(
  'rejects invalid complete values AND patches %#',
  (patch) => {
    expect(() => parseSettings({ ...DEFAULT_SETTINGS, ...patch })).toThrow();
    expect(() => settingsPatchSchema.parse(patch)).toThrow();
  },
);

it.each([null, [], {}, { version: 1 }, { ...DEFAULT_SETTINGS, version: 2 }])(
  'rejects incomplete or unsupported settings %#',
  (input) => {
    expect(() => parseSettings(input)).toThrow();
  },
);

it('allows immutable partial patches, but never a version or coerced object', () => {
  expect(settingsPatchSchema.parse({})).toEqual({});
  const patch = settingsPatchSchema.parse({ musicEnabled: true });
  expect(patch).toEqual({ musicEnabled: true });
  expect(Object.isFrozen(patch)).toBe(true);
  for (const invalid of [{ version: 1 }, { version: 2 }, null, [], false]) {
    expect(() => settingsPatchSchema.parse(invalid)).toThrow();
  }
});

it('derives strict immutable input preferences and defaults from settings', () => {
  expect(DEFAULT_INPUT_PREFERENCES).toEqual({
    mouseSteering: DEFAULT_SETTINGS.mouseSteering,
    mouseSensitivity: DEFAULT_SETTINGS.mouseSensitivity,
    invertMouseY: DEFAULT_SETTINGS.invertMouseY,
  });
  expect(Object.isFrozen(DEFAULT_INPUT_PREFERENCES)).toBe(true);
  const parsed = inputPreferencesSchema.parse(DEFAULT_INPUT_PREFERENCES);
  expect(Object.isFrozen(parsed)).toBe(true);
  for (const patch of [
    { mouseSensitivity: 0.24 },
    { mouseSensitivity: 2.01 },
    { mouseSensitivity: NaN },
    { mouseSteering: 1 },
    { invertMouseY: 'true' },
    { version: 1 },
    { masterVolume: 0.5 },
  ]) {
    expect(() =>
      inputPreferencesSchema.parse({ ...DEFAULT_INPUT_PREFERENCES, ...patch }),
    ).toThrow();
  }
  expect(() => inputPreferencesSchema.parse({ mouseSteering: true })).toThrow();
});
