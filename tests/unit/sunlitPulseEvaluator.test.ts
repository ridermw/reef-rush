import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import * as motion from '../../src/game/player/stepFishMotion';
import * as control from '../fixtures/sunlitPulsePolicy';
import {
  SUNLIT_PULSE_EVALUATOR_PROVENANCE,
  sunlitPulseEvaluatorInputs,
} from '../fixtures/sunlitPulseEvaluatorInputs';
import * as reference from '../fixtures/sunlitPulseScalarReference';
import type {
  SunlitPulseOperation,
  SunlitPulsePath,
  SunlitPulseTopology,
} from '../fixtures/sunlitPulseTopology';

const fourTimings = [
  { onsetSteps: 0, holdSteps: 6, observationSteps: 6 },
  { onsetSteps: 36, holdSteps: 12, observationSteps: 12 },
  { onsetSteps: 90, holdSteps: 18, observationSteps: 23 },
  { onsetSteps: 0, holdSteps: 18, observationSteps: 6 },
] satisfies control.SunlitPulseTiming[];
const courseTiming = {
  onsetSteps: 30,
  holdSteps: 10,
  observationSteps: 15,
  skewSteps: 11,
  releaseSkewSteps: 5,
};
const fiveTimings = [...fourTimings, courseTiming];
const masks = [0, 1, 2, 3, 4, 5, 6, 7];
const counts = [
  {
    name: 'four',
    timings: fourTimings,
    integrations: [13240, 13253, 13224, 13164, 13253, 13263, 13263, 13191],
    peak: [14, 18, 22, 16, 18, 17, 16, 15],
    expandedTicks: 16800,
    allocations: 276,
  },
  {
    name: 'five',
    timings: fiveTimings,
    integrations: [16958, 16964, 16924, 16859, 16964, 16981, 16981, 16889],
    peak: [17, 20, 29, 20, 23, 22, 20, 19],
    expandedTicks: 21275,
    allocations: 347,
  },
];

function root(mask = 0) {
  return {
    fish: {
      position: [0, -4, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      roll: 0,
      dashEnergy: 1,
      isSubmerged: true,
    } satisfies motion.FishState,
    steps: 0,
    waypoint: 0,
    checkpointIndex: 0,
    collectedPearlIds: [],
    approachingCheckpoint: false,
    brakeHeld: Boolean(mask & 4),
    slowing: Boolean(mask & 2),
    accelerating: Boolean(mask & 1),
  } satisfies control.SunlitPulseObservation;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const children: readonly unknown[] = Object.values(value);
    for (const child of children) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function captureArenas<T>(arenas: unknown[][], evaluate: () => T): T {
  const NativeArray = globalThis.Array;
  let evaluating = false;
  vi.stubGlobal(
    'Array',
    new Proxy(NativeArray, {
      construct(target, argumentsList, newTarget) {
        const created: unknown = Reflect.construct(
          target,
          argumentsList,
          newTarget,
        );
        if (!NativeArray.isArray(created))
          throw new Error('Native Array construction did not return an array.');
        const array: unknown[] = created;
        if (
          evaluating &&
          argumentsList.length === 1 &&
          typeof argumentsList[0] === 'number'
        )
          arenas.push(array);
        return array;
      },
    }),
  );
  try {
    evaluating = true;
    return evaluate();
  } finally {
    evaluating = false;
    vi.unstubAllGlobals();
  }
}

function assertClearedArena(arenas: readonly unknown[][], capacity: number) {
  expect(arenas).toHaveLength(1);
  expect(arenas[0]).toHaveLength(capacity);
  expect(Object.keys(arenas[0])).toHaveLength(capacity);
  expect(arenas[0].every((entry) => entry === undefined)).toBe(true);
}

function compile(timings: readonly control.SunlitPulseTiming[]) {
  expect(control).toHaveProperty(
    'compileSunlitPulseEvaluator',
    expect.any(Function),
  );
  return control.compileSunlitPulseEvaluator(timings);
}

function compileInvalid(value: unknown): void {
  expect(control).toHaveProperty(
    'compileSunlitPulseEvaluator',
    expect.any(Function),
  );
  Reflect.apply(control.compileSunlitPulseEvaluator, undefined, [value]);
}

function referenceMatrix(
  observed: control.SunlitPulseObservation,
  timings: readonly control.SunlitPulseTiming[],
) {
  return reference.referenceCommands.map((command) => ({
    command,
    forecasts: timings.map((timing) =>
      reference.referenceTruncated(observed, command, timing),
    ),
  }));
}

function assertAliases(
  actual: control.SunlitPulseForecast,
  expected: control.SunlitPulseForecast,
) {
  for (const [left, right] of [
    ['fish', 'boundaryFish'],
    ['fish', 'evaluationFish'],
    ['boundaryFish', 'evaluationFish'],
  ] as const) {
    expect(actual[left] === actual[right]).toBe(
      expected[left] === expected[right],
    );
  }
}

function assertMatrix(
  actual: control.SunlitPulseMatrix,
  expected: ReturnType<typeof referenceMatrix>,
) {
  expect(actual.candidates).toStrictEqual(expected);
  expect(actual.candidates.map((candidate) => candidate.command)).toStrictEqual(
    reference.referenceCommands,
  );
  for (const [candidate, row] of actual.candidates.entries()) {
    for (const [scenario, forecast] of row.forecasts.entries())
      assertAliases(forecast, expected[candidate].forecasts[scenario]);
  }
}

function referencePaths(
  timings: readonly control.SunlitPulseTiming[],
  mask: number,
): SunlitPulsePath[] {
  return reference.referenceCommands.flatMap((command) =>
    timings.map((timing) => {
      const held = root(mask);
      const timeline = reference.sunlitPulseTimeline(
        held.brakeHeld,
        command,
        timing,
        held.slowing,
        held.accelerating,
      );
      const press = timing.skewSteps ?? 2;
      const release = timing.releaseSkewSteps ?? press;
      const evaluationAt =
        timing.onsetSteps +
        timing.holdSteps +
        press +
        release +
        timing.observationSteps;
      let brake = held.brakeHeld;
      let w = held.accelerating;
      let s = held.slowing;
      let x = 0;
      let y = 0;
      let cursor = 0;
      const symbols: number[] = [];
      for (let tick = 0; tick < Math.min(240, evaluationAt + 108); tick++) {
        while (timeline.events[cursor]?.at === tick) {
          const edge = timeline.events[cursor++];
          const down = edge.type === 'keydown';
          if (edge.key === 'Shift') brake = down;
          else if (edge.key === 'w') w = down;
          else if (edge.key === 's') s = down;
          else if (edge.key === 'a' || edge.key === 'd')
            x = down ? (edge.key === 'a' ? 1 : -1) : 0;
          else y = down ? (edge.key === 'ArrowUp' ? 1 : -1) : 0;
        }
        const frame =
          ((Number(brake) * 3 + Number(w) - Number(s) + 1) * 3 + x + 1) * 3 +
          y +
          1;
        symbols.push(frame * 2 + Number(tick + 1 === timeline.observeAt));
      }
      return { symbols, observeAt: timeline.observeAt, evaluationAt };
    }),
  );
}

type LogicalOperation =
  | {
      kind: 'advance';
      node: number;
      parent: number;
      depth: number;
      symbol: number;
      takeParent: boolean;
      retire: readonly number[];
    }
  | {
      kind: 'finish';
      row: number;
      leaf: number;
      boundary: number;
      evaluation: number;
      retire: readonly number[];
    };

function logicalProjection(operation: SunlitPulseOperation): LogicalOperation {
  if (operation.kind === 'advance') {
    const { kind, node, parent, depth, symbol, takeParent, retire } = operation;
    return { kind, node, parent, depth, symbol, takeParent, retire };
  }
  const { kind, row, leaf, boundary, evaluation, retire } = operation;
  return { kind, row, leaf, boundary, evaluation, retire };
}

function referenceLogicalSchedule(
  paths: readonly SunlitPulsePath[],
): LogicalOperation[] {
  const prefixes = new Map<string, number>();
  const operations: LogicalOperation[] = [];
  for (const [row, path] of paths.entries()) {
    const nodes = [0];
    for (const [tick, symbol] of path.symbols.entries()) {
      const parent = nodes[tick];
      const key = `${parent}:${symbol}`;
      let node = prefixes.get(key);
      if (node === undefined) {
        node = prefixes.size + 1;
        prefixes.set(key, node);
        operations.push({
          kind: 'advance',
          node,
          parent,
          depth: tick + 1,
          symbol,
          takeParent: false,
          retire: [],
        });
      }
      nodes.push(node);
    }
    operations.push({
      kind: 'finish',
      row,
      leaf: nodes[path.symbols.length],
      boundary: nodes[path.observeAt],
      evaluation: nodes[path.evaluationAt],
      retire: [],
    });
  }
  const lastReader = new Map<number, number>();
  for (const [index, operation] of operations.entries()) {
    const reads =
      operation.kind === 'advance'
        ? [operation.parent]
        : [operation.leaf, operation.boundary, operation.evaluation];
    for (const node of reads) lastReader.set(node, index);
  }
  const retire = operations.map((): number[] => []);
  for (let node = 0; node <= prefixes.size; node++) {
    const reader = lastReader.get(node);
    if (reader === undefined) throw new Error('Reference node has no reader.');
    retire[reader].push(node);
  }
  return operations.map((operation, index) => {
    if (operation.kind === 'finish')
      return { ...operation, retire: retire[index] };
    const takeParent = lastReader.get(operation.parent) === index;
    return {
      ...operation,
      takeParent,
      retire: takeParent
        ? retire[index].filter((node) => node !== operation.parent)
        : retire[index],
    };
  });
}

function assertSlotSchedule(
  topology: SunlitPulseTopology,
  paths: readonly SunlitPulsePath[],
) {
  expect(topology.operations.map(logicalProjection)).toStrictEqual(
    referenceLogicalSchedule(paths),
  );
  const nodeSlots = new Map([[0, 0]]);
  const owners = new Map([[0, 0]]);
  const retiredOwners = new Map<number, number>();
  const freeSlots: number[] = [];
  const reusedAdvances: Array<{
    ordinal: number;
    node: number;
    slot: number;
    retiredNode: number;
  }> = [];
  let nextSlot = 1;
  let peak = 1;
  let ordinal = 0;
  function checkSlot(slot: number) {
    expect(Number.isSafeInteger(slot)).toBe(true);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(topology.work.stateIndexSlots);
  }
  function read(node: number, slot: number) {
    checkSlot(slot);
    expect(nodeSlots.get(node)).toBe(slot);
    expect(owners.get(slot)).toBe(node);
  }
  for (const operation of topology.operations) {
    if (operation.kind === 'advance') {
      ordinal++;
      read(operation.parent, operation.parentSlot);
      const expectedSlot = operation.takeParent
        ? operation.parentSlot
        : (freeSlots.pop() ?? nextSlot++);
      expect(operation.nodeSlot).toBe(expectedSlot);
      checkSlot(operation.nodeSlot);
      if (operation.takeParent) {
        expect(operation.retire).not.toContain(operation.parent);
        expect(operation.retireSlots).not.toContain(operation.parentSlot);
        owners.delete(operation.parentSlot);
        nodeSlots.delete(operation.parent);
      } else {
        expect(operation.nodeSlot).not.toBe(operation.parentSlot);
        const retiredNode = retiredOwners.get(expectedSlot);
        if (retiredNode !== undefined) {
          reusedAdvances.push({
            ordinal,
            node: operation.node,
            slot: expectedSlot,
            retiredNode,
          });
          retiredOwners.delete(expectedSlot);
        }
      }
      expect(owners.has(operation.nodeSlot)).toBe(false);
      owners.set(operation.nodeSlot, operation.node);
      nodeSlots.set(operation.node, operation.nodeSlot);
      peak = Math.max(peak, owners.size);
    } else {
      read(operation.leaf, operation.leafSlot);
      read(operation.boundary, operation.boundarySlot);
      read(operation.evaluation, operation.evaluationSlot);
    }
    const expectedRetireSlots = operation.retire.map((node) => {
      const slot = nodeSlots.get(node);
      if (slot === undefined)
        throw new Error('Retiring a non-live reference node.');
      read(node, slot);
      return slot;
    });
    expect(operation.retireSlots).toStrictEqual(expectedRetireSlots);
    expect(Object.isFrozen(operation.retireSlots)).toBe(true);
    if (operation.retire.length === 0)
      expect(operation.retireSlots).toBe(operation.retire);
    for (const [index, node] of operation.retire.entries()) {
      const slot = expectedRetireSlots[index];
      owners.delete(slot);
      nodeSlots.delete(node);
      freeSlots.push(slot);
      retiredOwners.set(slot, node);
    }
    expect(owners.size).toBe(nodeSlots.size);
    expect(new Set(nodeSlots.values()).size).toBe(nodeSlots.size);
  }
  expect(owners.size).toBe(0);
  expect(nodeSlots.size).toBe(0);
  expect(nextSlot).toBe(topology.work.stateIndexSlots);
  expect(peak).toBe(topology.work.peakOwnedStates);
  expect(nextSlot).toBe(peak);
  expect(ordinal).toBe(topology.work.integrations);
  expect(topology.operations).toHaveLength(ordinal + paths.length);
  expect(topology.work.expandedTicks).toBe(
    paths.reduce((sum, path) => sum + path.symbols.length, 0),
  );
  expect(topology.work.finalLiveStates).toBe(0);
  return { reusedAdvances, peak };
}

async function topologyModule() {
  expect(control).toHaveProperty(
    'compileSunlitPulseEvaluator',
    expect.any(Function),
  );
  return vi.importActual<typeof import('../fixtures/sunlitPulseTopology')>(
    '../fixtures/sunlitPulseTopology',
  );
}

it('exposes the exact shared prefix evaluator', () => {
  expect(compile(fourTimings)).toHaveProperty('evaluate', expect.any(Function));
});

it('sizes the actual five-case arena to the owned-state peak', () => {
  const evaluator = compile(fiveTimings);
  const observed = deepFreeze(root());
  const NativeArray = globalThis.Array;
  const arenas: unknown[][] = [];
  const matrix = captureArenas(arenas, () => evaluator.evaluate(observed));
  expect(globalThis.Array).toBe(NativeArray);
  expect(arenas).toHaveLength(1);
  expect(arenas[0].constructor).toBe(NativeArray);
  assertMatrix(matrix, referenceMatrix(observed, fiveTimings));
  expect(arenas[0].every((entry) => entry === undefined)).toBe(true);
  console.info(
    JSON.stringify({
      actualArenaLength: arenas[0].length,
      bound: evaluator.bounds[0].stateIndexSlots,
      work: matrix.work.stateIndexSlots,
      peakOwnedStates: matrix.work.peakOwnedStates,
    }),
  );
  expect(arenas[0]).toHaveLength(17);
  expect(evaluator.bounds[0].stateIndexSlots).toBe(arenas[0].length);
  expect(matrix.work.stateIndexSlots).toBe(arenas[0].length);
  expect(matrix.work.peakOwnedStates).toBe(arenas[0].length);
});

it('pins the complete frozen source and the portable 152 observations', async () => {
  const text = await readFile(
    join('tests', 'fixtures', 'sunlitPulseScalarReference.ts'),
    'utf8',
  );
  const source = text
    .replaceAll('\r\n', '\n')
    .split('// BEGIN FROZEN SCALAR SOURCE\n')[1]
    .split('// END FROZEN SCALAR SOURCE')[0];
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  expect(Buffer.byteLength(source)).toBe(29701);
  expect(sha256(source)).toBe(
    reference.SUNLIT_PULSE_SCALAR_PROVENANCE.sourceSha256,
  );
  expect(sha256(source)).toBe(
    '985c791c1fec0c8db7e4f56830e2ce7f26a348289995e0dc4768ce31ebeecd3f',
  );
  expect(sunlitPulseEvaluatorInputs).toHaveLength(152);
  expect(sha256(JSON.stringify(sunlitPulseEvaluatorInputs))).toBe(
    'e71815813d77acfe9647f931e76361293c6a2874fa611715a87d761b27845337',
  );
  expect(SUNLIT_PULSE_EVALUATOR_PROVENANCE).toMatchObject({
    runId: '34013534603',
    sourceRevision: '3875ba6034b1021587b122a28198ba3cfc2d866f',
    capturedConsumers: 3,
  });
});

it('independently observes 21275 scalar integrations for five timings', () => {
  const step = vi.spyOn(motion, 'stepFishMotion');
  try {
    const expected = referenceMatrix(deepFreeze(root()), fiveTimings);
    expect(expected).toHaveLength(25);
    expect(expected.flatMap((row) => row.forecasts)).toHaveLength(125);
    expect(step).toHaveBeenCalledTimes(21275);
    expect(
      expected
        .flatMap((row) => row.forecasts)
        .reduce((sum, forecast) => sum + forecast.motionSteps, 0),
    ).toBe(21275);
  } finally {
    step.mockRestore();
  }
});

describe.each(counts)('$name timing actual work', (profile) => {
  it.each(masks)(
    'matches the immutable bound and actual calls for mask %i',
    (mask) => {
      const observed = deepFreeze(root(mask));
      const step = vi.spyOn(motion, 'stepFishMotion');
      const arenas: unknown[][] = [];
      let matrix: control.SunlitPulseMatrix;
      try {
        const evaluator = compile(deepFreeze(structuredClone(profile.timings)));
        expect(step).not.toHaveBeenCalled();
        expect(Object.isFrozen(evaluator.bounds)).toBe(true);
        expect(evaluator.bounds).toHaveLength(8);
        for (const [heldMask, bound] of evaluator.bounds.entries()) {
          expect(Object.isFrozen(bound)).toBe(true);
          expect(bound).toStrictEqual({
            mask: heldMask,
            integrations: profile.integrations[heldMask],
            expandedTicks: profile.expandedTicks,
            propagationStateAllocations: profile.allocations,
            peakOwnedStates: profile.peak[heldMask],
            stateIndexSlots: profile.peak[heldMask],
            finalLiveStates: 0,
          });
        }
        matrix = captureArenas(arenas, () => evaluator.evaluate(observed));
        expect(step).toHaveBeenCalledTimes(profile.integrations[mask]);
        expect(matrix.work).toStrictEqual({
          integrations: profile.integrations[mask],
          expandedTicks: profile.expandedTicks,
          propagationStateAllocations: profile.allocations,
          peakOwnedStates: profile.peak[mask],
          stateIndexSlots: profile.peak[mask],
          finalLiveStates: 0,
        });
        expect(Object.isFrozen(matrix.work)).toBe(true);
      } finally {
        step.mockRestore();
      }
      assertClearedArena(arenas, profile.peak[mask]);
      assertMatrix(matrix, referenceMatrix(observed, profile.timings));
    },
  );

  it.each(masks)(
    'preserves the logical schedule and exclusive physical owners for mask %i',
    async (mask) => {
      const { compileSunlitPulseTopology } = await topologyModule();
      const paths = deepFreeze(referencePaths(profile.timings, mask));
      const topology = compileSunlitPulseTopology(paths);
      const modeled = assertSlotSchedule(topology, paths);
      expect(modeled.peak).toBe(profile.peak[mask]);
      expect(modeled.reusedAdvances.length).toBeGreaterThan(0);
    },
  );
});

let fourEvaluator: control.CompiledSunlitPulseEvaluator | undefined;
let fiveEvaluator: control.CompiledSunlitPulseEvaluator | undefined;

it.each(
  sunlitPulseEvaluatorInputs.map((observed, index) => ({ observed, index })),
)(
  'preserves both complete matrices, policy and public forecasts for input $index',
  ({ observed }) => {
    fourEvaluator ??= compile(fourTimings);
    fiveEvaluator ??= compile(fiveTimings);
    deepFreeze(observed);
    assertMatrix(
      fourEvaluator.evaluate(observed),
      referenceMatrix(observed, fourTimings),
    );
    assertMatrix(
      fiveEvaluator.evaluate(observed),
      referenceMatrix(observed, fiveTimings),
    );
    expect(control.sunlitPulsePolicy(observed)).toStrictEqual(
      reference.sunlitPulsePolicy(observed),
    );
    for (const command of reference.referenceCommands) {
      for (const timing of fourTimings) {
        const actual = control.predictSunlitPulse(observed, command, timing);
        const expected = reference.predictSunlitPulse(
          observed,
          command,
          timing,
        );
        expect(actual).toStrictEqual(expected);
        assertAliases(actual, expected);
        expect(actual.motionSteps).toBe(240);
      }
    }
  },
);

describe.each(['normal', 'recovery', 'current boundary', 'completed route'])(
  '%s observation',
  (kind) => {
    it.each(masks)(
      'preserves both complete matrices with held mask %i',
      (mask) => {
        const observed = root(mask);
        if (kind === 'recovery') {
          observed.fish.position[2] = 4.5;
          observed.fish.velocity[2] = 6;
          Object.assign(observed, { approachingCheckpoint: true });
        } else if (kind === 'current boundary') {
          const current = sunlit.objects.find(
            (object) => object.type === 'current',
          );
          if (!current) throw new Error('Missing authored Sunlit current.');
          observed.fish.position = [...current.position];
          observed.fish.position[0] += current.halfExtents[0];
          observed.fish.velocity = [0, -0, 6];
        } else if (kind === 'completed route') {
          observed.fish.position[2] = 95;
          Object.assign(observed, {
            waypoint: 7,
            checkpointIndex: 4,
            collectedPearlIds: sunlit.pearls.map((pearl) => pearl.id),
          });
        }
        deepFreeze(observed);
        fourEvaluator ??= compile(fourTimings);
        fiveEvaluator ??= compile(fiveTimings);
        assertMatrix(
          fourEvaluator.evaluate(observed),
          referenceMatrix(observed, fourTimings),
        );
        assertMatrix(
          fiveEvaluator.evaluate(observed),
          referenceMatrix(observed, fiveTimings),
        );
      },
    );
  },
);

it('distinguishes recovery observation branches and detaches every returned row', () => {
  const early = { onsetSteps: 0, holdSteps: 6, observationSteps: 10 };
  const late = { ...early, observationSteps: 30 };
  const timings = deepFreeze([early, late, early]);
  const observed = root();
  observed.fish.position[2] = 4.5;
  observed.fish.velocity[2] = 6;
  Object.assign(observed, { approachingCheckpoint: true });
  deepFreeze(observed);
  const evaluator = compile(timings);
  const matrix = evaluator.evaluate(observed);
  assertMatrix(matrix, referenceMatrix(observed, timings));
  expect(
    matrix.candidates[0].forecasts.map((forecast) => forecast.contacts[0]),
  ).toEqual([10, null, 10]);
  const allFish = new Set<object>();
  const allArrays = new Set<object>();
  for (const row of matrix.candidates) {
    for (const forecast of row.forecasts) {
      for (const fish of new Set([
        forecast.fish,
        forecast.boundaryFish,
        forecast.evaluationFish,
      ])) {
        expect(allFish.has(fish)).toBe(false);
        allFish.add(fish);
        for (const vector of [fish.position, fish.velocity]) {
          expect(allArrays.has(vector)).toBe(false);
          allArrays.add(vector);
        }
      }
      for (const array of [
        forecast.contacts,
        forecast.minimumClearance,
        forecast.missPenalties,
      ]) {
        expect(Object.isFrozen(array)).toBe(true);
        expect(allArrays.has(array)).toBe(false);
        allArrays.add(array);
      }
    }
  }
  const saved = structuredClone(matrix);
  const next = root(7);
  next.fish.position[0] = 1.25;
  assertMatrix(
    evaluator.evaluate(deepFreeze(next)),
    referenceMatrix(next, timings),
  );
  expect(matrix).toStrictEqual(saved);
  matrix.candidates[0].forecasts[0].fish.position[0] = 123;
  expect(matrix.candidates[0].forecasts[2]).toStrictEqual(
    saved.candidates[0].forecasts[2],
  );
  assertMatrix(
    evaluator.evaluate(observed),
    referenceMatrix(observed, timings),
  );
});

it('snapshots caller timings instead of retaining mutable configuration', () => {
  const timings = structuredClone(fourTimings);
  const evaluator = compile(timings);
  const expected = referenceMatrix(root(), fourTimings);
  timings[0].holdSteps = 100;
  timings.reverse();
  assertMatrix(evaluator.evaluate(root()), expected);
});

it('compiles exact prefixes, depths and last-reader retirements independently of physics', async () => {
  const { compileSunlitPulseTopology } = await topologyModule();
  const step = vi.spyOn(motion, 'stepFishMotion');
  try {
    const paths = deepFreeze([
      { symbols: [26, 26, 27], observeAt: 3, evaluationAt: 2 },
      { symbols: [26, 26, 27], observeAt: 3, evaluationAt: 2 },
      { symbols: [26, 28, 27], observeAt: 3, evaluationAt: 2 },
    ]);
    const topology = compileSunlitPulseTopology(paths);
    expect(step).not.toHaveBeenCalled();
    expect(topology.operations.map(logicalProjection)).toStrictEqual([
      {
        kind: 'advance',
        node: 1,
        parent: 0,
        depth: 1,
        symbol: 26,
        takeParent: true,
        retire: [],
      },
      {
        kind: 'advance',
        node: 2,
        parent: 1,
        depth: 2,
        symbol: 26,
        takeParent: false,
        retire: [],
      },
      {
        kind: 'advance',
        node: 3,
        parent: 2,
        depth: 3,
        symbol: 27,
        takeParent: false,
        retire: [],
      },
      {
        kind: 'finish',
        row: 0,
        leaf: 3,
        boundary: 3,
        evaluation: 2,
        retire: [],
      },
      {
        kind: 'finish',
        row: 1,
        leaf: 3,
        boundary: 3,
        evaluation: 2,
        retire: [2, 3],
      },
      {
        kind: 'advance',
        node: 4,
        parent: 1,
        depth: 2,
        symbol: 28,
        takeParent: true,
        retire: [],
      },
      {
        kind: 'advance',
        node: 5,
        parent: 4,
        depth: 3,
        symbol: 27,
        takeParent: false,
        retire: [],
      },
      {
        kind: 'finish',
        row: 2,
        leaf: 5,
        boundary: 5,
        evaluation: 4,
        retire: [4, 5],
      },
    ]);
    expect(topology.work).toStrictEqual({
      integrations: 5,
      expandedTicks: 9,
      propagationStateAllocations: 4,
      peakOwnedStates: 3,
      stateIndexSlots: 3,
      finalLiveStates: 0,
    });
    expect(Object.isFrozen(topology.operations)).toBe(true);
    for (const operation of topology.operations) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.retire)).toBe(true);
    }
    assertSlotSchedule(topology, paths);
  } finally {
    step.mockRestore();
  }
});

it('reuses retired slot zero in LIFO order without retiring a transferred parent', async () => {
  const { compileSunlitPulseTopology } = await topologyModule();
  const paths = deepFreeze([
    { symbols: [26, 27], observeAt: 2, evaluationAt: 1 },
    { symbols: [29], observeAt: 1, evaluationAt: 1 },
    { symbols: [26, 31], observeAt: 2, evaluationAt: 1 },
  ]);
  const topology = compileSunlitPulseTopology(paths);
  const modeled = assertSlotSchedule(topology, paths);
  expect(topology.work.stateIndexSlots).toBe(3);
  expect(modeled.reusedAdvances).toStrictEqual([
    { ordinal: 4, node: 4, slot: 0, retiredNode: 3 },
  ]);
});

it('uses the computed 32-slot peak for another valid five-timing input', async () => {
  const timings = [0, 3, 6, 9, 12].map((onsetSteps) => ({
    onsetSteps,
    holdSteps: 6,
    observationSteps: 6,
  }));
  const evaluator = compile(timings);
  const observed = deepFreeze(root(2));
  const arenas: unknown[][] = [];
  const step = vi.spyOn(motion, 'stepFishMotion');
  let matrix: control.SunlitPulseMatrix;
  try {
    matrix = captureArenas(arenas, () => evaluator.evaluate(observed));
    expect(step).toHaveBeenCalledTimes(15462);
  } finally {
    step.mockRestore();
  }
  assertClearedArena(arenas, 32);
  expect(evaluator.bounds[2].stateIndexSlots).toBe(32);
  expect(matrix.work.stateIndexSlots).toBe(32);
  expect(matrix.work.peakOwnedStates).toBe(32);
  assertMatrix(matrix, referenceMatrix(observed, timings));
  const { compileSunlitPulseTopology } = await topologyModule();
  const paths = deepFreeze(referencePaths(timings, 2));
  assertSlotSchedule(compileSunlitPulseTopology(paths), paths);
});

it('finalizes each forecast before advancing later candidates and preserves error order', () => {
  const timings = [courseTiming, fourTimings[0]];
  const evaluator = compile(timings);
  const observed = root();
  observed.fish.position[0] = 1e155;
  const original = motion.stepFishMotion;
  const sentinel = new Error('A later steering candidate must not run.');
  const arenas: unknown[][] = [];
  const step = vi
    .spyOn(motion, 'stepFishMotion')
    .mockImplementation((...args) => {
      if (args[1].steerX !== 0) throw sentinel;
      return original(...args);
    });
  try {
    expect(() =>
      captureArenas(arenas, () => evaluator.evaluate(observed)),
    ).toThrow(new RangeError('Pulse prediction cost overflow.'));
    expect(step).toHaveBeenCalledTimes(179);
  } finally {
    step.mockRestore();
  }
  assertClearedArena(arenas, evaluator.bounds[0].peakOwnedStates);
  assertMatrix(evaluator.evaluate(root()), referenceMatrix(root(), timings));
});

it.each([
  { kind: 'fork', takeParent: false },
  { kind: 'last-reader transfer', takeParent: true },
])(
  'clears ownership after an injected $kind advance error',
  async ({ kind, takeParent }) => {
    const { compileSunlitPulseTopology } = await topologyModule();
    const schedule = compileSunlitPulseTopology(referencePaths(fiveTimings, 2));
    let ordinal = 0;
    let finished = false;
    let selected:
      { ordinal: number; kind: 'advance'; takeParent: boolean } | undefined;
    for (const operation of schedule.operations) {
      if (operation.kind === 'finish') finished = true;
      else {
        ordinal++;
        if (finished && operation.takeParent === takeParent) {
          selected = {
            ordinal,
            kind: operation.kind,
            takeParent: operation.takeParent,
          };
          break;
        }
      }
    }
    if (!selected)
      throw new Error('Missing the declared ownership injection point.');
    expect(selected).toMatchObject({ kind: 'advance', takeParent });
    expect(selected.ordinal).toBe(takeParent ? 126 : 125);
    console.info(JSON.stringify({ ownershipInjection: kind, ...selected }));
    const evaluator = compile(fiveTimings);
    const old = evaluator.evaluate(deepFreeze(root()));
    const saved = structuredClone(old);
    const sentinel = new Error(`Injected ${kind} failure.`);
    const original = motion.stepFishMotion;
    let calls = 0;
    const step = vi
      .spyOn(motion, 'stepFishMotion')
      .mockImplementation((...args) => {
        if (++calls === selected.ordinal) throw sentinel;
        return original(...args);
      });
    let returned: control.SunlitPulseMatrix | undefined;
    let thrown: unknown;
    const observed = deepFreeze(root(2));
    const arenas: unknown[][] = [];
    try {
      returned = captureArenas(arenas, () => evaluator.evaluate(observed));
    } catch (error) {
      thrown = error;
    } finally {
      step.mockRestore();
    }
    expect(thrown).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(calls).toBe(selected.ordinal);
    assertClearedArena(arenas, 29);
    const next = root(5);
    next.fish.position[0] = -1.75;
    assertMatrix(
      evaluator.evaluate(deepFreeze(next)),
      referenceMatrix(next, fiveTimings),
    );
    expect(old).toStrictEqual(saved);
  },
);

it.each([false, true])(
  'clears fresh arenas after actual slot reuse (throw after reuse: %s)',
  async (throwAfterReuse) => {
    const { compileSunlitPulseTopology } = await topologyModule();
    const paths = deepFreeze(referencePaths(fiveTimings, 2));
    const topology = compileSunlitPulseTopology(paths);
    const modeled = assertSlotSchedule(topology, paths);
    const reuse = modeled.reusedAdvances.find(
      (advance) => advance.ordinal > 126,
    );
    if (!reuse) throw new Error('Missing a later retired-slot reuse.');
    const afterReuseOrdinal = reuse.ordinal + 1;
    const advances = topology.operations.filter(
      (operation) => operation.kind === 'advance',
    );
    expect(afterReuseOrdinal).toBeLessThanOrEqual(advances.length);
    expect(advances[reuse.ordinal - 1]).toMatchObject({
      kind: 'advance',
      takeParent: false,
      node: reuse.node,
      nodeSlot: reuse.slot,
    });
    console.info(
      JSON.stringify({ slotReuse: reuse, afterReuseOrdinal, throwAfterReuse }),
    );

    const evaluator = compile(fiveTimings);
    const oldArenas: unknown[][] = [];
    const oldObserved = deepFreeze(root());
    const old = captureArenas(oldArenas, () => evaluator.evaluate(oldObserved));
    const saved = structuredClone(old);
    const observed = deepFreeze(root(2));
    const arenas: unknown[][] = [];
    const NativeArray = globalThis.Array;
    const sentinel = new Error('Failure after a retired slot was reused.');
    const original = motion.stepFishMotion;
    let calls = 0;
    let completedReuse = false;
    const step = vi
      .spyOn(motion, 'stepFishMotion')
      .mockImplementation((...args) => {
        calls++;
        if (throwAfterReuse && calls === afterReuseOrdinal) throw sentinel;
        const result = original(...args);
        if (calls === reuse.ordinal) completedReuse = true;
        return result;
      });
    let returned: control.SunlitPulseMatrix | undefined;
    let thrown: unknown;
    try {
      returned = captureArenas(arenas, () => evaluator.evaluate(observed));
    } catch (error) {
      thrown = error;
    } finally {
      step.mockRestore();
    }
    expect(globalThis.Array).toBe(NativeArray);
    expect(completedReuse).toBe(true);
    expect(calls).toBe(throwAfterReuse ? afterReuseOrdinal : 16924);
    assertClearedArena(oldArenas, 17);
    assertClearedArena(arenas, 29);
    expect(arenas[0]).not.toBe(oldArenas[0]);
    if (throwAfterReuse) {
      expect(thrown).toBe(sentinel);
      expect(returned).toBeUndefined();
    } else {
      expect(thrown).toBeUndefined();
      if (!returned) throw new Error('Successful reuse returned no matrix.');
      assertMatrix(returned, referenceMatrix(observed, fiveTimings));
    }
    const returnedBeforeNext = structuredClone(returned);
    const next = root(5);
    next.fish.position[0] = 1.25;
    deepFreeze(next);
    const nextArenas: unknown[][] = [];
    const nextMatrix = captureArenas(nextArenas, () =>
      evaluator.evaluate(next),
    );
    assertClearedArena(nextArenas, 22);
    expect(nextArenas[0]).not.toBe(oldArenas[0]);
    expect(nextArenas[0]).not.toBe(arenas[0]);
    assertMatrix(nextMatrix, referenceMatrix(next, fiveTimings));
    expect(old).toStrictEqual(saved);
    expect(returned).toStrictEqual(returnedBeforeNext);
  },
);

it.each(masks)(
  'retains ordered zero-length edges and 436 actual calls for mask %i',
  (mask) => {
    const timing = {
      onsetSteps: 0,
      holdSteps: 0,
      observationSteps: 1,
      skewSteps: 0,
      releaseSkewSteps: 0,
    };
    const observed = deepFreeze(root(mask));
    const command = reference.referenceCommands[24];
    expect(
      control.sunlitPulseTimeline(false, command, timing, true).events,
    ).toStrictEqual([
      { at: 0, key: 'w', type: 'keydown' },
      { at: 0, key: 'ArrowDown', type: 'keydown' },
      { at: 0, key: 'ArrowDown', type: 'keyup' },
      { at: 0, key: 'w', type: 'keyup' },
    ]);
    const evaluator = compile([timing]);
    const step = vi.spyOn(motion, 'stepFishMotion');
    const arenas: unknown[][] = [];
    let actual: control.SunlitPulseMatrix;
    try {
      actual = captureArenas(arenas, () => evaluator.evaluate(observed));
      expect(step).toHaveBeenCalledTimes(436);
      expect(actual.work.integrations).toBe(436);
      for (const row of actual.candidates) {
        expect(row.forecasts[0]).toMatchObject({
          evaluationAt: 1,
          interventionAt: 109,
          motionSteps: 109,
        });
        expect(row.forecasts[0].boundaryFish).toBe(
          row.forecasts[0].evaluationFish,
        );
      }
    } finally {
      step.mockRestore();
    }
    assertClearedArena(arenas, 3);
    expect(evaluator.bounds[mask].stateIndexSlots).toBe(3);
    expect(actual.work.stateIndexSlots).toBe(3);
    expect(actual.work.peakOwnedStates).toBe(3);
    assertMatrix(actual, referenceMatrix(observed, [timing]));
  },
);

describe('bounded compilation and scalar validation order', () => {
  it.each([undefined, null, false, 0, 'timings', {}])(
    'rejects nonarray container %s',
    (value) => {
      expect(() => compileInvalid(value)).toThrow(TypeError);
    },
  );

  it.each([
    { timings: [] },
    { timings: Array.from({ length: 6 }, () => fourTimings[0]) },
  ])('rejects an out-of-range timing array', ({ timings }) => {
    expect(() => compileInvalid(timings)).toThrow(RangeError);
  });

  it.each(
    [null, undefined, false, 1, 'timing', []].map((value) => ({ value })),
  )('rejects nonobject timing $value', ({ value }) => {
    expect(() => compileInvalid([value])).toThrow(TypeError);
  });

  it.each([
    'onsetSteps',
    'holdSteps',
    'observationSteps',
    'skewSteps',
    'releaseSkewSteps',
  ])('rejects malformed %s counters', (field) => {
    for (const invalid of [
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '2',
      true,
    ]) {
      const timing = { ...fourTimings[0] };
      Object.assign(timing, { [field]: invalid });
      expect(() => compile([timing])).toThrow(
        new RangeError('Pulse timing requires bounded integer counters.'),
      );
    }
  });

  it('rejects zero observation and null release without changing nullish press defaults', () => {
    expect(() => compile([{ ...fourTimings[0], observationSteps: 0 }])).toThrow(
      new RangeError('Pulse timing requires bounded integer counters.'),
    );
    const malformed = { ...fourTimings[0] };
    Object.assign(malformed, { releaseSkewSteps: null });
    expect(() => compile([malformed])).toThrow(RangeError);
    const nullish = { ...fourTimings[0] };
    Object.assign(nullish, { skewSteps: null });
    assertMatrix(
      compile([nullish]).evaluate(root()),
      referenceMatrix(root(), [nullish]),
    );
  });

  it('checks each timing in order, including canonical completion and horizon', () => {
    expect(() =>
      compileInvalid([{ ...fourTimings[0], onsetSteps: -1 }, null]),
    ).toThrow(
      new RangeError('Pulse timing requires bounded integer counters.'),
    );
    expect(() =>
      compileInvalid([null, { ...fourTimings[0], onsetSteps: -1 }]),
    ).toThrow(TypeError);
    expect(() =>
      compile([
        {
          onsetSteps: Number.MAX_SAFE_INTEGER,
          holdSteps: 0,
          observationSteps: Number.MAX_SAFE_INTEGER,
        },
      ]),
    ).toThrow(
      new RangeError('Pulse timing requires bounded integer counters.'),
    );
    expect(() =>
      compileInvalid([{ ...fourTimings[0], holdSteps: 241 }, null]),
    ).toThrow(
      new RangeError('Pulse observation exceeds the prediction horizon.'),
    );
  });

  it('rejects a sparse timing at its own index before validating later timings', () => {
    const timings = new Array<control.SunlitPulseTiming>(2);
    timings[1] = { ...fourTimings[0], onsetSteps: -1 };
    expect(() => compile(timings)).toThrow(TypeError);
  });

  it('accepts evaluation 240 and rejects 241 before any integration', () => {
    const timing = {
      onsetSteps: 0,
      holdSteps: 0,
      observationSteps: 1,
      skewSteps: 0,
      releaseSkewSteps: 239,
    };
    const evaluator = compile([timing]);
    const actual = evaluator.evaluate(root(2));
    assertMatrix(actual, referenceMatrix(root(2), [timing]));
    for (const row of actual.candidates) {
      expect(row.forecasts[0].evaluationAt).toBe(240);
      expect(row.forecasts[0].motionSteps).toBe(240);
      expect(row.forecasts[0].fish).toBe(row.forecasts[0].evaluationFish);
    }
    const step = vi.spyOn(motion, 'stepFishMotion');
    try {
      expect(() => compile([{ ...timing, releaseSkewSteps: 240 }])).toThrow(
        new RangeError('Pulse observation exceeds the prediction horizon.'),
      );
      expect(step).not.toHaveBeenCalled();
    } finally {
      step.mockRestore();
    }
  });

  it('rejects the 29260-prefix expansion before allocation of integration 18001', () => {
    const timings = [0, 3, 6, 9, 12].map((onsetSteps) => ({
      onsetSteps,
      holdSteps: 200,
      observationSteps: 1,
    }));
    const prefixes = new Map<number, number>();
    for (const path of referencePaths(timings, 0)) {
      let parent = 0;
      for (const symbol of path.symbols) {
        const key = parent * 108 + symbol;
        if (!prefixes.has(key)) prefixes.set(key, prefixes.size + 1);
        parent = prefixes.get(key)!;
      }
    }
    expect(prefixes.size).toBe(29260);
    const step = vi.spyOn(motion, 'stepFishMotion');
    try {
      expect(() => compile(timings)).toThrow(
        new RangeError('Pulse evaluator exceeds 18000 motion calls.'),
      );
      expect(step).not.toHaveBeenCalled();
    } finally {
      step.mockRestore();
    }
  });

  it('preserves motion-before-history evaluation and history-first policy validation', () => {
    const evaluator = compile(fourTimings);
    const observed = { ...root(), steps: 2, previousSteps: 3 };
    observed.fish.position[0] = NaN;
    expect(() => evaluator.evaluate(observed)).toThrow(
      new RangeError('Pulse prediction requires finite motion.'),
    );
    expect(() => control.sunlitPulsePolicy(observed)).toThrow(
      new RangeError('Pulse observations must not decrease.'),
    );
    Object.assign(observed, { steps: -1 });
    expect(() => evaluator.evaluate(observed)).toThrow(
      new RangeError('Pulse timing requires bounded integer counters.'),
    );
  });

  it.each(['brakeHeld', 'slowing', 'accelerating'])(
    'validates %s before previous history and goals',
    (flag) => {
      const evaluator = compile(fourTimings);
      for (const value of [null, 0, 'false']) {
        const observed = {
          ...root(),
          steps: 2,
          previousSteps: 3,
          waypoint: 100,
        };
        Object.assign(observed, { [flag]: value });
        expect(() => evaluator.evaluate(observed)).toThrow(
          new TypeError('Invalid native pulse command.'),
        );
      }
      const observed = { ...root(), steps: 2, previousSteps: 3, waypoint: 100 };
      expect(() => evaluator.evaluate(observed)).toThrow(
        new RangeError('Pulse observations must not decrease.'),
      );
      Object.assign(observed, { previousSteps: 1 });
      expect(() => evaluator.evaluate(observed)).toThrow(
        new RangeError('Invalid Sunlit route observation.'),
      );
    },
  );
});
