import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  loadNativeTimingCorpus,
  parseNativeTimingCorpus,
  parseNativeTimingData,
  type NativeTimingCorpus,
} from '../fixtures/nativeTimingCorpus';
import type { NativeTimingData } from '../fixtures/nativeInputRecorder';
import * as timingPrefix from '../fixtures/nativeTimingCorpus';
import * as chordWitness from '../fixtures/sunlitChordWitness';

// The cast supplies fixture inputs; the parsers must independently validate unknown data.
const raw = JSON.parse(
  await readFile(
    resolve('tests', 'fixtures', 'native-timing', 'sunlit-33991547417.json'),
    'utf8',
  ),
) as NativeTimingCorpus;

const rawChord = JSON.parse(
  await readFile(
    resolve(
      'tests',
      'fixtures',
      'native-timing',
      'sunlit-34013534603-prefix-964.json',
    ),
    'utf8',
  ),
) as NativeTimingData;

function prefixParser() {
  expect(timingPrefix.parseNativeTimingPrefix).toBeTypeOf('function');
  return timingPrefix.parseNativeTimingPrefix;
}

it('loads the pinned asymmetric prefix frozen with exact provenance and retained S', async () => {
  expect(chordWitness.loadSunlitChordWitness).toBeTypeOf('function');
  const data = await chordWitness.loadSunlitChordWitness();
  expect(chordWitness.SUNLIT_CHORD_PROVENANCE).toEqual({
    repository: 'ridermw/reef-rush',
    revision: '3875ba6034b1021587b122a28198ba3cfc2d866f',
    runId: 34013534603,
    jobId: 101433321625,
    eventCount: 47,
    fullSha256:
      'ae658f6a3fe320a6ebaa1314bc18870d8d81990cd557cc7a2046308504bb1cc5',
    prefixSha256:
      'af2f2da6e28032d0a5ccdec4d838266f99fd5f83c18b066b47193766338b0d83',
  });
  expect(Object.isFrozen(chordWitness.SUNLIT_CHORD_PROVENANCE)).toBe(true);
  expect(data.events).toHaveLength(47);
  expect(data.events[0]).toMatchObject({
    sequence: 0,
    steps: 50,
    kind: 'observation',
  });
  expect(data.events[41]).toMatchObject({
    sequence: 41,
    steps: 893,
    kind: 'observation',
  });
  expect(data.events[46]).toMatchObject({
    sequence: 46,
    steps: 964,
    kind: 'observation',
  });
  expect(Object.isFrozen(data)).toBe(true);
  expect(Object.isFrozen(data.events)).toBe(true);
  expect(Object.isFrozen(data.events[41])).toBe(true);
  expect(Object.isFrozen(observation(data).anchor.player?.position)).toBe(true);
  const held = new Set<string>();
  for (const event of data.events) {
    if (event.kind !== 'key') continue;
    if (event.type === 'keydown') held.add(event.code);
    else held.delete(event.code);
  }
  expect([...held]).toEqual(['KeyS']);
  expect(chordWitness.parseSunlitChordWitness(rawChord)).toEqual(data);
  expect(prefixParser()(rawChord)).toEqual(data);
});

it('accepts the running prefix only through its explicit parser', () => {
  expect(prefixParser()(rawChord).events).toHaveLength(47);
  expect(() => parseNativeTimingData(rawChord)).toThrow(
    'Native timing lacks a complete terminal observation or key cleanup.',
  );
});

it('rejects complete and key-ended tapes as prefixes', () => {
  const parse = prefixParser();
  expect(() => parse(raw.cases[0].data)).toThrow(
    'Native timing prefix must end at a running observation.',
  );
  expect(() =>
    parse({ ...rawChord, events: rawChord.events.slice(0, -1) }),
  ).toThrow('Native timing prefix must end at a running observation.');
});

it('accepts all eight distinct supported keys in a generic running prefix', () => {
  const parse = prefixParser();
  const first = rawChord.events[0];
  const template = key(rawChord);
  const codes = [
    'KeyW',
    'KeyS',
    'KeyA',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ShiftLeft',
    'ShiftRight',
  ];
  const events = [
    first,
    ...codes.map((code, index) => ({
      ...template,
      code,
      steps: first.steps,
      rendered: first.rendered,
      time: first.time,
      sequence: index + 1,
    })),
    { ...first, sequence: 9 },
  ];
  expect(parse({ version: 1, failure: null, events }).events).toHaveLength(10);
});

it('rejects asymmetric prefix timestamp corruption before schema projection', () => {
  expect(chordWitness.parseSunlitChordWitness).toBeTypeOf('function');
  const changed = structuredClone(rawChord);
  Object.assign(changed.events[42], { time: changed.events[42].time + 1 });
  expect(() => chordWitness.parseSunlitChordWitness(changed)).toThrow(
    'Sunlit chord prefix checksum mismatch.',
  );
  expect(() => chordWitness.parseSunlitChordWitness(undefined)).toThrow(
    'Sunlit chord prefix checksum mismatch.',
  );
});

function parsers() {
  expect(parseNativeTimingData).toBeTypeOf('function');
  expect(parseNativeTimingCorpus).toBeTypeOf('function');
  expect(loadNativeTimingCorpus).toBeTypeOf('function');
  if (
    !parseNativeTimingData ||
    !parseNativeTimingCorpus ||
    !loadNativeTimingCorpus
  )
    throw new Error('Missing timing corpus implementation.');
  return {
    data: parseNativeTimingData,
    corpus: parseNativeTimingCorpus,
    load: loadNativeTimingCorpus,
  };
}

function observation(data: NativeTimingData) {
  const value = data.events.find((event) => event.kind === 'observation');
  if (!value || value.kind !== 'observation')
    throw new Error('Missing fixture observation.');
  return value;
}

function key(data: NativeTimingData) {
  const value = data.events.find(
    (event) =>
      event.kind === 'key' &&
      event.type === 'keydown' &&
      event.screen === 'playing',
  );
  if (!value || value.kind !== 'key') throw new Error('Missing fixture key.');
  return value;
}

it('loads all three pinned actual failures with their complete immutable timelines', async () => {
  const p = parsers();
  const corpus = await p.load();
  expect(corpus.source).toEqual({
    repository: 'ridermw/reef-rush',
    revision: '87ef5f47a73b642d52078ebf7dbd1baef7734aae',
    runId: 33991547417,
    artifactId: 9977067136,
  });
  expect(corpus.cases.map((entry) => entry.scenario)).toEqual([
    'blacksmoker.spec.ts',
    'course-medals.spec.ts',
    'kelpworks.spec.ts',
  ]);
  expect(corpus.cases.map((entry) => entry.data.events.length)).toEqual([
    224, 299, 236,
  ]);
  expect(corpus.cases.map((entry) => entry.data.events[0].steps)).toEqual([
    148, 116, 150,
  ]);
  expect(corpus.cases.map((entry) => entry.data.events.at(-1)?.steps)).toEqual([
    2051, 2894, 2083,
  ]);
  expect(Object.isFrozen(corpus.cases)).toBe(true);
  expect(
    Object.isFrozen(observation(corpus.cases[0].data).anchor.player?.position),
  ).toBe(true);
  expect(() => Object.assign(corpus.source, { runId: 0 })).toThrow();
  expect(p.corpus(raw)).toEqual(corpus);
});

it.each(['revision', 'runId', 'artifactId', 'repository'])(
  'rejects mismatched source %s before loading a scene',
  (field) => {
    const p = parsers();
    const changed = structuredClone(raw);
    Object.assign(changed.source, { [field]: 'wrong' });
    expect(() => p.corpus(changed)).toThrow();
  },
);

it.each(['duplicate', 'missing', 'unknown field', 'hash', 'body'])(
  'rejects %s corpus corruption',
  (kind) => {
    const p = parsers();
    const changed = structuredClone(raw);
    if (kind === 'duplicate')
      Object.assign(changed.cases, { 1: changed.cases[0] });
    if (kind === 'missing')
      Object.assign(changed, { cases: changed.cases.slice(1) });
    if (kind === 'unknown field')
      Object.assign(changed, { secret: 'not allowed' });
    if (kind === 'hash')
      Object.assign(changed.cases[0], { bodySha256: '0'.repeat(64) });
    if (kind === 'body')
      Object.assign(changed.cases[0].data.events[0], { time: 1 });
    expect(() => p.corpus(changed)).toThrow();
  },
);

it('accepts the actual late terminal deliveries without treating them as gameplay', () => {
  const data = parsers().data(raw.cases[1].data);
  expect(data.events.slice(290, 293)).toMatchObject([
    { code: 'KeyD', steps: 2894, screen: 'results', defaultPrevented: false },
    { code: 'KeyS', steps: 2894, screen: 'results', defaultPrevented: false },
    {
      code: 'ShiftLeft',
      steps: 2894,
      screen: 'results',
      defaultPrevented: false,
    },
  ]);
  expect(data.events.slice(-2)).toMatchObject([
    { type: 'keydown', code: 'KeyW', screen: 'results' },
    { type: 'keyup', code: 'KeyW', screen: 'results' },
  ]);
});

const mutations: Array<[string, (data: NativeTimingData) => void]> = [
  ['sequence', (data) => Object.assign(data.events[1], { sequence: 7 })],
  ['decreased steps', (data) => Object.assign(data.events[1], { steps: 0 })],
  [
    'decreased render count',
    (data) => Object.assign(data.events[1], { rendered: 0 }),
  ],
  ['negative clock', (data) => Object.assign(data.events[1], { time: -1 })],
  [
    'nonfinite counter',
    (data) => Object.assign(data.events[1], { steps: NaN }),
  ],
  ['step budget', (data) => Object.assign(data.events[1], { steps: 7201 })],
  ['unknown field', (data) => Object.assign(data.events[1], { extra: true })],
  [
    'reset interruption',
    (data) => Object.assign(data.events[1], { inputResets: 8 }),
  ],
  [
    'settings interruption',
    (data) => Object.assign(data.events[1], { settingsOpen: true }),
  ],
  [
    'graphics interruption',
    (data) => Object.assign(data.events[1], { graphicsLost: true }),
  ],
  ['untrusted key', (data) => Object.assign(key(data), { isTrusted: false })],
  [
    'ignored playing key',
    (data) => Object.assign(key(data), { defaultPrevented: false }),
  ],
  ['modified key', (data) => Object.assign(key(data), { ctrlKey: true })],
  ['wrong target', (data) => Object.assign(key(data), { canvasTarget: false })],
  ['unknown key', (data) => Object.assign(key(data), { code: 'Space' })],
  [
    'bad motion',
    (data) =>
      Object.assign(observation(data).anchor.player!, { yaw: Infinity }),
  ],
  [
    'short tuple',
    (data) =>
      Object.assign(observation(data).anchor.player!, { position: [0, 1] }),
  ],
  [
    'mouse steering',
    (data) => Object.assign(observation(data).anchor, { mouseSteering: true }),
  ],
  [
    'wrong course',
    (data) =>
      Object.assign(observation(data).anchor, { courseId: 'kelpworks' }),
  ],
  [
    'wrong pearl count',
    (data) => Object.assign(observation(data).anchor, { pearlCount: 4 }),
  ],
  [
    'unknown pearl',
    (data) =>
      Object.assign(observation(data).anchor, {
        pearlCount: 1,
        collectedPearlIds: ['invented'],
      }),
  ],
  [
    'duplicate pearls',
    (data) =>
      Object.assign(observation(data).anchor, {
        pearlCount: 2,
        collectedPearlIds: ['pearl-entry', 'pearl-entry'],
      }),
  ],
  [
    'wrong race state',
    (data) => Object.assign(observation(data).anchor, { status: 'finished' }),
  ],
  [
    'capture failure',
    (data) => Object.assign(data, { failure: 'owner changed' }),
  ],
  [
    'missing probe',
    (data) => Object.assign(data, { events: data.events.slice(0, -2) }),
  ],
  [
    'missing terminal',
    (data) =>
      Object.assign(data, {
        events: data.events.filter((event) => event.screen === 'playing'),
      }),
  ],
  ['empty recording', (data) => Object.assign(data, { events: [] })],
];

it.each(mutations)(
  'direct wire validation rejects %s independently of checksums',
  (_name, mutate) => {
    const p = parsers();
    const data = structuredClone(raw.cases[0].data);
    mutate(data);
    expect(() => p.data(data)).toThrow();
  },
);

it.each(
  mutations.filter(
    ([name]) => name !== 'missing probe' && name !== 'missing terminal',
  ),
)('prefix wire validation rejects %s without a checksum', (_name, mutate) => {
  const parse = prefixParser();
  const data = structuredClone(rawChord);
  mutate(data);
  expect(() => parse(data)).toThrow();
});

it.each(['duplicate', 'unowned release'])(
  'rejects %s prefix ownership without imposing a smaller key cap',
  (kind) => {
    const parse = prefixParser();
    const data = structuredClone(rawChord);
    const down = key(data);
    if (kind === 'unowned release') Object.assign(down, { type: 'keyup' });
    else {
      const events = [...data.events];
      events.splice(down.sequence + 1, 0, { ...down });
      Object.assign(data, {
        events: events.map((event, sequence) => ({ ...event, sequence })),
      });
    }
    expect(() => parse(data)).toThrow(/ownership/);
  },
);

it('rejects extra terminal clears before the first terminal observation', () => {
  const p = parsers();
  const data = structuredClone(raw.cases[1].data);
  for (const event of data.events.filter((entry) => entry.screen === 'results'))
    Object.assign(event, { inputResets: 7 });
  expect(() => p.data(data)).toThrow(/reset/i);
});

it('rejects an unowned release even when sequence numbers are valid', () => {
  const p = parsers();
  const data = structuredClone(raw.cases[0].data);
  const down = key(data);
  Object.assign(down, { type: 'keyup', defaultPrevented: false });
  expect(() => p.data(data)).toThrow(/ownership/i);
});
