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

// The cast supplies fixture inputs; the parsers must independently validate unknown data.
const raw = JSON.parse(
  await readFile(
    resolve('tests', 'fixtures', 'native-timing', 'sunlit-33991547417.json'),
    'utf8',
  ),
) as NativeTimingCorpus;

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
