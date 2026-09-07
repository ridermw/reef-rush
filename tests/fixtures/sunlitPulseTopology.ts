export interface SunlitPulsePath {
  readonly symbols: readonly number[];
  readonly observeAt: number;
  readonly evaluationAt: number;
}

export type SunlitPulseOperation =
  | {
      readonly kind: 'advance';
      readonly node: number;
      readonly parent: number;
      readonly depth: number;
      readonly symbol: number;
      readonly takeParent: boolean;
      readonly parentSlot: number;
      readonly nodeSlot: number;
      readonly retire: readonly number[];
      readonly retireSlots: readonly number[];
    }
  | {
      readonly kind: 'finish';
      readonly row: number;
      readonly leaf: number;
      readonly boundary: number;
      readonly evaluation: number;
      readonly leafSlot: number;
      readonly boundarySlot: number;
      readonly evaluationSlot: number;
      readonly retire: readonly number[];
      readonly retireSlots: readonly number[];
    };

export type SunlitPulseTopologyWork = Readonly<{
  integrations: number;
  expandedTicks: number;
  propagationStateAllocations: number;
  peakOwnedStates: number;
  stateIndexSlots: number;
  finalLiveStates: number;
}>;

export interface SunlitPulseTopology {
  readonly operations: readonly SunlitPulseOperation[];
  readonly work: SunlitPulseTopologyWork;
}

type PendingOperation =
  | Omit<
      Extract<SunlitPulseOperation, { kind: 'advance' }>,
      'takeParent' | 'parentSlot' | 'nodeSlot' | 'retire' | 'retireSlots'
    >
  | Omit<
      Extract<SunlitPulseOperation, { kind: 'finish' }>,
      'leafSlot' | 'boundarySlot' | 'evaluationSlot' | 'retire' | 'retireSlots'
    >;

export function compileSunlitPulseTopology(
  paths: readonly SunlitPulsePath[],
): SunlitPulseTopology {
  const prefixes = new Map<number, number>();
  const pending: PendingOperation[] = [];
  const lastReads = [-1];
  let expandedTicks = 0;
  for (const [row, path] of paths.entries()) {
    let parent = 0;
    let boundary = 0;
    let evaluation = 0;
    for (const [tick, symbol] of path.symbols.entries()) {
      const depth = tick + 1;
      const key = parent * 108 + symbol;
      let node = prefixes.get(key);
      if (node === undefined) {
        node = lastReads.length;
        if (node > 18000)
          throw new RangeError('Pulse evaluator exceeds 18000 motion calls.');
        prefixes.set(key, node);
        lastReads.push(-1);
        lastReads[parent] = pending.length;
        pending.push({ kind: 'advance', node, parent, depth, symbol });
      }
      parent = node;
      if (depth === path.observeAt) boundary = node;
      if (depth === path.evaluationAt) evaluation = node;
    }
    if (!boundary || !evaluation)
      throw new RangeError('Pulse prefix path is missing a sample.');
    lastReads[parent] = pending.length;
    lastReads[boundary] = pending.length;
    lastReads[evaluation] = pending.length;
    pending.push({ kind: 'finish', row, leaf: parent, boundary, evaluation });
    expandedTicks += path.symbols.length;
  }

  const retire: number[][] = Array.from({ length: pending.length }, () => []);
  for (const [node, reader] of lastReads.entries()) {
    if (reader < 0) throw new Error('Pulse prefix state has no reader.');
    retire[reader].push(node);
  }
  let live = 1;
  let peakOwnedStates = 1;
  let propagationStateAllocations = 1;
  const nodeSlots = new Array<number | undefined>(lastReads.length);
  nodeSlots[0] = 0;
  const freeSlots: number[] = [];
  let nextSlot = 1;
  function slotOf(node: number): number {
    const slot = nodeSlots[node];
    if (slot === undefined)
      throw new Error('Pulse prefix state has no live slot.');
    return slot;
  }
  function releaseSlots(nodes: readonly number[]): readonly number[] {
    if (nodes.length === 0) return nodes;
    const slots = nodes.map(slotOf);
    for (const [index, node] of nodes.entries()) {
      nodeSlots[node] = undefined;
      freeSlots.push(slots[index]);
    }
    return Object.freeze(slots);
  }
  const operations = pending.map((operation, index): SunlitPulseOperation => {
    if (operation.kind === 'advance') {
      const takeParent = lastReads[operation.parent] === index;
      // A transferred parent is consumed before the advance, not retired twice.
      const released = takeParent
        ? retire[index].filter((node) => node !== operation.parent)
        : retire[index];
      const parentSlot = slotOf(operation.parent);
      const nodeSlot = takeParent
        ? parentSlot
        : (freeSlots.pop() ?? nextSlot++);
      if (takeParent) nodeSlots[operation.parent] = undefined;
      nodeSlots[operation.node] = nodeSlot;
      if (!takeParent) {
        propagationStateAllocations++;
        live++;
        peakOwnedStates = Math.max(peakOwnedStates, live);
      }
      live -= released.length;
      const logicalRetire = Object.freeze(released);
      return Object.freeze({
        ...operation,
        takeParent,
        parentSlot,
        nodeSlot,
        retire: logicalRetire,
        retireSlots: releaseSlots(logicalRetire),
      });
    }
    const leafSlot = slotOf(operation.leaf);
    const boundarySlot = slotOf(operation.boundary);
    const evaluationSlot = slotOf(operation.evaluation);
    live -= retire[index].length;
    const logicalRetire = Object.freeze(retire[index]);
    return Object.freeze({
      ...operation,
      leafSlot,
      boundarySlot,
      evaluationSlot,
      retire: logicalRetire,
      retireSlots: releaseSlots(logicalRetire),
    });
  });
  if (nextSlot !== peakOwnedStates)
    throw new Error(
      'Pulse prefix slot capacity differs from its ownership peak.',
    );
  return Object.freeze({
    operations: Object.freeze(operations),
    work: Object.freeze({
      integrations: lastReads.length - 1,
      expandedTicks,
      propagationStateAllocations,
      peakOwnedStates,
      stateIndexSlots: nextSlot,
      finalLiveStates: live,
    }),
  });
}
