import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import sunlit from '../../src/content/courses/sunlitShoals';
import { TRAVERSAL_MAX_STEPS } from './courseTraversal';
import type { NativeTimingData } from './nativeInputRecorder';

export interface NativeTimingCase {
  readonly scenario: string;
  readonly bodySha256: string;
  readonly data: NativeTimingData;
}

export interface NativeTimingCorpus {
  readonly version: 1;
  readonly source: {
    readonly repository: 'ridermw/reef-rush';
    readonly revision: '87ef5f47a73b642d52078ebf7dbd1baef7734aae';
    readonly runId: 33991547417;
    readonly artifactId: 9977067136;
  };
  readonly cases: readonly NativeTimingCase[];
}

const bodyHashes = {
  'blacksmoker.spec.ts':
    'bba346916363f925c83db2f82b9d5a617f66bf692cd34fec3ba0c6c2190d5f53',
  'course-medals.spec.ts':
    '8cbec4060277ca10c08509dbe9cfe9389753594676fea9ed627557e3834c8366',
  'kelpworks.spec.ts':
    'd1696dd8af4fbd9f4ad0164438295c21558baac3d4d4316f50e99d8832f77d2a',
} as const;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]).readonly();
const player = z
  .object({
    position: vector,
    velocity: vector,
    yaw: finite,
    pitch: finite,
    roll: finite,
    dashEnergy: finite.min(0).max(1),
    isSubmerged: z.boolean(),
  })
  .strict()
  .readonly();
const anchor = z
  .object({
    player,
    courseId: z.literal('sunlit-shoals'),
    elapsedMs: finite.nonnegative(),
    checkpointIndex: counter.max(sunlit.checkpoints.length),
    pearlCount: counter.max(sunlit.pearls.length),
    status: z.enum(['running', 'finished']),
    collectedPearlIds: z.array(z.string()).max(sunlit.pearls.length).readonly(),
    mouseSteering: z.literal(false),
  })
  .strict()
  .readonly();
const stamp = {
  screen: z.enum(['playing', 'results']),
  steps: counter.max(TRAVERSAL_MAX_STEPS),
  rendered: counter,
  settingsOpen: z.literal(false),
  graphicsLost: z.literal(false),
  inputResets: counter,
  sequence: counter,
  time: finite.nonnegative(),
};
const event = z
  .discriminatedUnion('kind', [
    z.object({ ...stamp, kind: z.literal('observation'), anchor }).strict(),
    z
      .object({
        ...stamp,
        kind: z.literal('key'),
        type: z.enum(['keydown', 'keyup']),
        code: z.enum([
          'KeyW',
          'KeyS',
          'KeyA',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ShiftLeft',
          'ShiftRight',
        ]),
        repeat: z.boolean(),
        isTrusted: z.literal(true),
        defaultPrevented: z.boolean(),
        canvasTarget: z.boolean(),
        altKey: z.boolean(),
        ctrlKey: z.boolean(),
        metaKey: z.boolean(),
      })
      .strict(),
  ])
  .readonly();
const dataSchema = z
  .object({
    version: z.literal(1),
    events: z.array(event).min(3).max(32_768).readonly(),
    failure: z.null(),
  })
  .strict()
  .readonly();
const corpusSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        repository: z.literal('ridermw/reef-rush'),
        revision: z.literal('87ef5f47a73b642d52078ebf7dbd1baef7734aae'),
        runId: z.literal(33991547417),
        artifactId: z.literal(9977067136),
      })
      .strict()
      .readonly(),
    cases: z
      .array(
        z
          .object({
            scenario: z.enum([
              'blacksmoker.spec.ts',
              'course-medals.spec.ts',
              'kelpworks.spec.ts',
            ]),
            bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
            data: z.unknown(),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

export function parseNativeTimingData(input: unknown): NativeTimingData {
  return parseTimingData(input, false);
}

export function parseNativeTimingPrefix(input: unknown): NativeTimingData {
  return parseTimingData(input, true);
}

function parseTimingData(input: unknown, prefix: boolean): NativeTimingData {
  const data = dataSchema.parse(input);
  const first = data.events[0];
  if (first.kind !== 'observation' || first.screen !== 'playing')
    throw new Error('Native timing must start with a playing observation.');
  const owned = new Set<string>();
  const pearlIds = new Set(sunlit.pearls.map((pearl) => pearl.id));
  let previous: (typeof data.events)[number] | undefined;
  let terminal: (typeof data.events)[number] | undefined;
  let observations = 0;
  for (const [index, current] of data.events.entries()) {
    if (current.sequence !== index)
      throw new Error(`Native timing sequence mismatch at ${index}.`);
    if (previous) {
      if (
        current.steps < previous.steps ||
        current.rendered < previous.rendered ||
        current.time < previous.time
      )
        throw new Error(
          `Native timing counters or clock decreased at ${index}.`,
        );
      if (previous.screen === 'results' && current.screen !== 'results')
        throw new Error(`Native timing returned from results at ${index}.`);
      const finish =
        previous.screen === 'playing' && current.screen === 'results';
      if (current.inputResets - previous.inputResets !== (finish ? 1 : 0))
        throw new Error(`Native timing reset history mismatch at ${index}.`);
      if (previous.screen === 'results' && current.steps !== previous.steps)
        throw new Error(`Native timing advanced finished physics at ${index}.`);
    }
    if (current.kind === 'observation') {
      observations++;
      const sample = current.anchor;
      if (
        sample.collectedPearlIds.length !== sample.pearlCount ||
        new Set(sample.collectedPearlIds).size !== sample.pearlCount ||
        sample.collectedPearlIds.some((id) => !pearlIds.has(id))
      )
        throw new Error(`Native timing pearl identities mismatch at ${index}.`);
      if ((current.screen === 'results') !== (sample.status === 'finished'))
        throw new Error(`Native timing race state mismatch at ${index}.`);
      if (current.screen === 'results') {
        if (terminal || sample.checkpointIndex !== 4 || sample.pearlCount !== 4)
          throw new Error(
            `Native timing terminal milestones mismatch at ${index}.`,
          );
        terminal = current;
      }
    } else {
      if (current.type === 'keydown') {
        if (
          current.screen === 'playing' &&
          (!current.defaultPrevented ||
            !current.canvasTarget ||
            current.altKey ||
            current.ctrlKey ||
            current.metaKey)
        )
          throw new Error(`Native timing ignored playing keydown at ${index}.`);
        if (current.screen === 'results' && current.defaultPrevented)
          throw new Error(
            `Native timing accepted a results keydown at ${index}.`,
          );
        if (owned.has(current.code))
          throw new Error(`Native timing duplicate ownership at ${index}.`);
        owned.add(current.code);
      } else if (!owned.delete(current.code)) {
        throw new Error(`Native timing release without ownership at ${index}.`);
      }
    }
    previous = current;
  }
  if (prefix) {
    const last = data.events.at(-1);
    if (
      terminal ||
      observations < 2 ||
      last?.kind !== 'observation' ||
      last.screen !== 'playing'
    ) {
      throw new Error(
        'Native timing prefix must end at a running observation.',
      );
    }
    return data;
  }
  if (!terminal || observations < 2 || owned.size)
    throw new Error(
      'Native timing lacks a complete terminal observation or key cleanup.',
    );
  const down = data.events.at(-2);
  const up = data.events.at(-1);
  if (
    down?.kind !== 'key' ||
    up?.kind !== 'key' ||
    down.type !== 'keydown' ||
    up.type !== 'keyup' ||
    down.code !== 'KeyW' ||
    up.code !== 'KeyW' ||
    down.screen !== 'results' ||
    up.screen !== 'results' ||
    down.sequence <= terminal.sequence
  )
    throw new Error('Native timing lacks the recorded results probe.');
  return data;
}

export function parseNativeTimingCorpus(input: unknown): NativeTimingCorpus {
  const envelope = corpusSchema.parse(input);
  if (new Set(envelope.cases.map((entry) => entry.scenario)).size !== 3)
    throw new Error('Duplicate native timing scenarios.');
  const cases = envelope.cases.map((entry) => {
    // Validate original serialization before wire-schema projection reorders fields.
    const body = JSON.stringify(entry.data);
    if (
      !body ||
      entry.bodySha256 !== bodyHashes[entry.scenario] ||
      createHash('sha256').update(body).digest('hex') !== entry.bodySha256
    )
      throw new Error(`Native timing checksum mismatch: ${entry.scenario}.`);
    return Object.freeze({
      scenario: entry.scenario,
      bodySha256: entry.bodySha256,
      data: parseNativeTimingData(entry.data),
    });
  });
  return Object.freeze({
    version: envelope.version,
    source: envelope.source,
    cases: Object.freeze(cases),
  });
}

export async function loadNativeTimingCorpus(): Promise<NativeTimingCorpus> {
  const input: unknown = JSON.parse(
    await readFile(
      resolve('tests', 'fixtures', 'native-timing', 'sunlit-33991547417.json'),
      'utf8',
    ),
  );
  return parseNativeTimingCorpus(input);
}
