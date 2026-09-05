import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAudioEngine,
  type AudioCue,
} from '../../src/game/audio/AudioEngine';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { FakeContext } from '../fixtures/audioContext';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cues: readonly AudioCue[] = [
  'dash',
  'checkpoint',
  'pearl',
  'finish',
  'collision',
  'hazard',
  'breach',
  'splashdown',
];

async function playing(musicEnabled = false) {
  const fixture = setup();
  fixture.engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled });
  fixture.engine.setPhase('playing');
  await fixture.engine.unlock();
  return fixture;
}

describe('bounded original synthesis', () => {
  it.each(cues)(
    'emits one quiet, time-bounded %s voice and reclaims it on ended',
    async (cue) => {
      const { engine, context } = await playing();
      const before = engine.getSnapshot();
      expect(engine.play(cue)).toBe(true);
      expect(context.oscillators).toHaveLength(1);
      expect(context.gains).toHaveLength(2);
      const oscillator = context.oscillators[0];
      const envelope = context.gains[1];
      expect(oscillator.connections.has(envelope)).toBe(true);
      expect(envelope.connections.has(context.gains[0])).toBe(true);
      expect(context.gains[0].connections.has(context.destination)).toBe(true);
      expect(oscillator.starts).toEqual([context.currentTime]);
      expect(oscillator.stops[0]).toBeGreaterThan(context.currentTime);
      expect(oscillator.stops[0]).toBeLessThanOrEqual(context.currentTime + 1);
      expect(
        oscillator.frequency.events.filter((event) => event.kind === 'ramp')
          .length,
      ).toBeGreaterThan(0);
      for (const event of envelope.gain.events) {
        if (event.value !== undefined) {
          expect(event.value).toBeGreaterThanOrEqual(0);
          expect(event.value).toBeLessThanOrEqual(0.08);
        }
      }
      expect(envelope.gain.events.at(-1)?.value).toBe(0);
      expect(engine.getState()).toMatchObject({
        activeEffects: 1,
        activeAmbience: 0,
        ownedNodes: 3,
        emittedCount: 1,
        lastCue: cue,
      });
      expect(engine.getState().emittedCues[cue]).toBe(1);
      expect(before.emittedCues[cue]).toBe(0);
      const ended = oscillator.onended;
      oscillator.end();
      expect(engine.getState()).toMatchObject({
        activeEffects: 0,
        ownedNodes: 1,
        pendingCleanup: false,
      });
      expect(oscillator.disconnectCalls).toBe(1);
      expect(envelope.disconnectCalls).toBe(1);
      ended?.(new Event('ended'));
      expect(oscillator.disconnectCalls).toBe(1);
    },
  );

  it('ramps audible volume from the held value, but mutes and stops immediately', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    const master = context.gains[0].gain;
    expect(master.events).toContainEqual({ kind: 'set', value: 0, time: 1 });
    expect(master.events.at(-1)).toEqual({
      kind: 'ramp',
      value: 0.4,
      time: 1.03,
    });
    context.currentTime = 1.5;
    engine.setSettings({ ...DEFAULT_SETTINGS, masterVolume: 0.6 });
    expect(master.events.slice(-2)).toEqual([
      { kind: 'hold', time: 1.5 },
      { kind: 'ramp', value: 0.6, time: 1.53 },
    ]);
    engine.setSettings({ ...DEFAULT_SETTINGS, masterVolume: 0 });
    expect(master.events.slice(-2)).toEqual([
      { kind: 'cancel', time: 1.5 },
      { kind: 'set', value: 0, time: 1.5 },
    ]);
    expect(context.oscillators[0].stops.at(-1)).toBe(1.5);
    expect(engine.getState().activeEffects).toBe(0);
    engine.setSettings(DEFAULT_SETTINGS);
    expect(context.oscillators).toHaveLength(1);
  });

  it.each(['idle', 'paused'] as const)(
    'silences and releases all voices immediately on %s',
    async (phase) => {
      const { engine, context } = await playing(true);
      engine.play('dash');
      engine.setPhase(phase);
      expect(context.gains[0].gain.value).toBe(0);
      expect(engine.getState()).toMatchObject({
        activeEffects: 0,
        activeAmbience: 0,
        ownedNodes: 1,
      });
      for (const oscillator of context.oscillators) {
        expect(oscillator.stops.at(-1)).toBe(context.currentTime);
        expect(oscillator.connections.size).toBe(0);
      }
      expect(engine.play('dash')).toBe(false);
      expect(context.closeCalls).toBe(0);
    },
  );

  it('caps effects at eight, drops excess, and lets finish replace the oldest lower priority cue', async () => {
    const { engine, context } = await playing();
    for (let index = 0; index < 8; index++) {
      context.currentTime++;
      expect(engine.play('dash')).toBe(true);
    }
    context.currentTime++;
    expect(engine.play('pearl')).toBe(false);
    expect(engine.getState()).toMatchObject({
      activeEffects: 8,
      emittedCount: 8,
      droppedCount: 1,
      lastDropReason: 'capacity',
    });
    expect(engine.play('finish')).toBe(true);
    expect(context.oscillators[0].connections.size).toBe(0);
    expect(engine.getState()).toMatchObject({
      activeEffects: 8,
      emittedCount: 9,
      replacedCount: 1,
      droppedCount: 1,
    });
    expect(context.oscillators).toHaveLength(9);
  });

  it.each(['collision', 'hazard'] as const)(
    'throttles repeated %s without extending its cooldown on drops',
    async (cue) => {
      const { engine, context } = await playing();
      expect(engine.play(cue)).toBe(true);
      context.currentTime += 0.1;
      expect(engine.play(cue)).toBe(false);
      expect(engine.getState().lastDropReason).toBe('cooldown');
      context.currentTime += 0.16;
      expect(engine.play(cue)).toBe(true);
      expect(engine.getState().emittedCues[cue]).toBe(2);
      expect(engine.getState().droppedCount).toBe(1);
    },
  );

  it('never queues locked, paused, muted, or idle cues for later replay', async () => {
    const { engine, context } = setup();
    engine.setPhase('playing');
    engine.play('checkpoint');
    await engine.unlock();
    engine.setPhase('paused');
    engine.play('dash');
    engine.setPhase('playing');
    engine.setSettings({ ...DEFAULT_SETTINGS, masterVolume: 0 });
    engine.play('pearl');
    engine.setPhase('idle');
    engine.play('hazard');
    engine.setSettings(DEFAULT_SETTINGS);
    engine.setPhase('playing');
    expect(context.oscillators).toHaveLength(0);
    expect(engine.getState()).toMatchObject({
      droppedCount: 4,
      emittedCount: 0,
      lastCue: null,
    });
  });

  it('starts optional bounded ambience only while playing and renews through native ended', async () => {
    const { engine, context } = setup();
    engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
    await engine.unlock();
    expect(context.oscillators).toHaveLength(0);
    engine.setPhase('playing');
    expect(engine.getState().activeAmbience).toBe(1);
    const first = context.oscillators[0];
    expect(first.stops[0]).toBeLessThanOrEqual(context.currentTime + 5);
    first.end();
    expect(first.connections.size).toBe(0);
    expect(engine.getState()).toMatchObject({
      activeAmbience: 1,
      activeEffects: 0,
      ownedNodes: 3,
      emittedCount: 0,
    });
    expect(context.oscillators).toHaveLength(2);
    engine.setSettings({
      ...DEFAULT_SETTINGS,
      musicEnabled: true,
      sfxEnabled: false,
    });
    expect(engine.getState().activeAmbience).toBe(1);
    expect(engine.play('dash')).toBe(false);
    engine.setSettings(DEFAULT_SETTINGS);
    expect(engine.getState().activeAmbience).toBe(0);
  });

  it('results stop ambience and ordinary effects but preserve or accept a short finish', async () => {
    const { engine, context } = await playing(true);
    engine.play('dash');
    engine.play('finish');
    const finish = context.oscillators.at(-1)!;
    engine.setPhase('results');
    expect(engine.getState()).toMatchObject({
      activeEffects: 1,
      activeAmbience: 0,
    });
    expect(finish.connections.size).toBe(1);
    expect(engine.play('pearl')).toBe(false);
    finish.end();
    context.currentTime++;
    expect(engine.play('finish')).toBe(true);
    engine.setPhase('idle');
    expect(engine.getState().activeEffects).toBe(0);
  });

  it('selectively stops effects when sfx is disabled without stopping ambience', async () => {
    const { engine } = await playing(true);
    engine.play('dash');
    engine.setSettings({
      ...DEFAULT_SETTINGS,
      musicEnabled: true,
      sfxEnabled: false,
    });
    expect(engine.getState()).toMatchObject({
      activeEffects: 0,
      activeAmbience: 1,
    });
  });

  it.each(['pause', 'idle', 'mute', 'disable', 'dispose'] as const)(
    'does not start audio after pending unlock followed by %s',
    async (change) => {
      const { engine, context } = setup();
      engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
      engine.setPhase('playing');
      context.resumeGate = deferred();
      const unlocking = engine.unlock();
      if (change === 'pause') engine.setPhase('paused');
      if (change === 'idle') engine.setPhase('idle');
      if (change === 'mute')
        engine.setSettings({
          ...DEFAULT_SETTINGS,
          musicEnabled: true,
          masterVolume: 0,
        });
      if (change === 'disable')
        engine.setSettings({ ...DEFAULT_SETTINGS, sfxEnabled: false });
      if (change === 'dispose') await engine.dispose();
      context.resumeGate.resolve();
      await unlocking;
      expect(context.oscillators).toHaveLength(0);
      expect(engine.getState()).toMatchObject({
        activeEffects: 0,
        activeAmbience: 0,
      });
    },
  );

  it('a still-valid idle unlock starts desired ambience if playing when resume completes', async () => {
    const { engine, context } = setup();
    engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
    context.resumeGate = deferred();
    const unlocking = engine.unlock();
    engine.setPhase('playing');
    context.resumeGate.resolve();
    await unlocking;
    expect(engine.getState().activeAmbience).toBe(1);
  });

  it('releases resources before notifying reentrant ended subscribers', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    const oscillator = context.oscillators[0];
    const observations: number[] = [];
    const off = engine.subscribe(() => {
      observations.push(oscillator.connections.size);
      if (engine.getState().phase === 'playing') engine.setPhase('paused');
    });
    oscillator.end();
    off();
    expect(observations.every((connections) => connections === 0)).toBe(true);
    expect(engine.getState()).toMatchObject({ phase: 'paused', ownedNodes: 1 });
  });
});
function setup() {
  const context = new FakeContext();
  const construct = vi.fn(() => context);
  const gesture = vi.fn(() => true);
  const engine = createAudioEngine({
    createContext: construct,
    isUserGesture: gesture,
  });
  return { context, construct, gesture, engine };
}

afterEach(() => vi.unstubAllGlobals());

describe('native failures and retained ownership', () => {
  it('reports synchronous close exceptions with the original cause', async () => {
    const { engine, context } = await playing();
    const cause = new Error('synchronous close');
    vi.spyOn(context, 'close').mockImplementationOnce(() => {
      throw cause;
    });
    await expect(engine.dispose()).rejects.toMatchObject({ cause });
    expect(engine.getState()).toMatchObject({
      cause,
      ownsContext: true,
      pendingCleanup: true,
    });
    await engine.retryCleanup();
    expect(engine.getState().status).toBe('disposed');
  });

  it('retries every failed owner without re-releasing successful nodes', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    engine.play('pearl');
    const first = new Error('first oscillator');
    const second = new Error('second envelope');
    context.oscillators[0].disconnectError = first;
    context.gains[2].disconnectError = second;
    await expect(engine.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(engine.getState()).toMatchObject({
      ownedNodes: 2,
      ownsContext: false,
      cleanupErrors: [first, second],
    });
    const releasedOscillator = context.oscillators[1];
    expect(releasedOscillator.disconnectCalls).toBe(1);
    context.oscillators[0].disconnectError = null;
    context.gains[2].disconnectError = null;
    await engine.retryCleanup();
    expect(releasedOscillator.disconnectCalls).toBe(1);
    expect(engine.getState().ownedNodes).toBe(0);
  });

  it('stops all existing cues if a new cue fails', async () => {
    const { engine, context } = await playing(true);
    expect(engine.play('pearl')).toBe(true);
    const cause = new Error('start');
    context.configureOscillator = (oscillator) => {
      oscillator.startError = cause;
    };
    expect(engine.play('dash')).toBe(false);
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      emittedCount: 1,
      activeEffects: 0,
      activeAmbience: 0,
      ownedNodes: 1,
    });
    expect(context.gains[0].gain.value).toBe(0);
  });

  it('retains ownership if scheduling a bounded stop fails after start', async () => {
    const { engine, context } = await playing();
    const cause = new Error('schedule stop');
    context.configureOscillator = (oscillator) => {
      oscillator.stopError = cause;
    };
    expect(engine.play('dash')).toBe(false);
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      emittedCount: 0,
      pendingCleanup: true,
      ownedNodes: 2,
    });
    const oscillator = context.oscillators[0];
    expect(oscillator.starts).toHaveLength(1);
    expect(oscillator.disconnectCalls).toBe(1);
    oscillator.stopError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      pendingCleanup: false,
      ownedNodes: 1,
    });
  });

  it('coalesces unlock reentrancy from a synchronous native state callback', async () => {
    const { engine, context } = setup();
    const pending = deferred();
    let nested: ReturnType<typeof engine.unlock> | undefined;
    let callbacks = 0;
    engine.subscribe(() => {
      if (callbacks++ === 0) nested = engine.unlock();
    });
    const resume = vi.spyOn(context, 'resume').mockImplementation(() => {
      context.onstatechange?.(new Event('statechange'));
      return pending.promise.then(() => {
        context.state = 'running';
      });
    });
    const first = engine.unlock();
    expect(nested).toBe(first);
    expect(resume).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
    expect(engine.getState().status).toBe('ready');
  });

  it('allows a native state callback to dispose during resume without losing the close owner', async () => {
    const { engine, context } = setup();
    let closing: Promise<void> | undefined;
    const off = engine.subscribe(() => {
      if (!closing) closing = engine.dispose();
    });
    vi.spyOn(context, 'resume').mockImplementation(() => {
      context.onstatechange?.(new Event('statechange'));
      return Promise.resolve();
    });
    await engine.unlock();
    off();
    await closing;
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      ownsContext: false,
    });
    expect(context.closeCalls).toBe(1);
  });

  it.each(['mute', 'disable'] as const)(
    'fences pending %s then reenable until a fresh gesture',
    async (change) => {
      const { engine, context } = setup();
      engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
      engine.setPhase('playing');
      context.resumeGate = deferred();
      const unlocking = engine.unlock();
      engine.setSettings({
        ...DEFAULT_SETTINGS,
        ...(change === 'mute' ? { masterVolume: 0 } : { sfxEnabled: false }),
      });
      engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
      context.resumeGate.resolve();
      await unlocking;
      expect(engine.getState()).toMatchObject({
        status: 'locked',
        activeAmbience: 0,
      });
      await engine.unlock();
      expect(engine.getState().activeAmbience).toBe(1);
    },
  );

  it('keeps rejected close visible when a pending resume completes later', async () => {
    const { engine, context } = setup();
    context.resumeGate = deferred();
    const unlocking = engine.unlock();
    const cause = new Error('close failed');
    context.closeError = cause;
    await expect(engine.dispose()).rejects.toMatchObject({ cause });
    context.resumeGate.resolve();
    await unlocking;
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      ownsContext: true,
      pendingCleanup: true,
      pendingUnlock: false,
    });
    context.closeError = null;
    await engine.retryCleanup();
  });

  it('does not ramp results master volume when only ambience is enabled', async () => {
    const { engine, context } = await playing(true);
    engine.setSettings({
      ...DEFAULT_SETTINGS,
      sfxEnabled: false,
      musicEnabled: true,
    });
    engine.setPhase('results');
    expect(context.gains[0].gain.value).toBe(0);
    expect(engine.getState()).toMatchObject({
      activeAmbience: 0,
      activeEffects: 0,
    });
  });

  it('starts final close immediately even when a live cleanup attempt is still settling', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    context.oscillators[0].disconnectError = new Error('disconnect');
    context.oscillators[0].end();
    context.oscillators[0].disconnectError = null;
    const retry = engine.retryCleanup();
    const disposal = engine.dispose();
    expect(context.closeCalls).toBe(1);
    await Promise.all([retry, disposal]);
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      ownsContext: false,
      ownedNodes: 0,
      pendingCleanup: false,
    });
  });

  it('surfaces throwing native-event subscribers without an uncaught callback error', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    const cause = new Error('subscriber');
    const off = engine.subscribe(() => {
      throw cause;
    });
    const notified = vi.fn();
    const offHealthy = engine.subscribe(notified);
    expect(() => context.oscillators[0].end()).not.toThrow();
    expect(engine.getState()).toMatchObject({
      status: 'ready',
      cause: null,
      observerErrors: [cause],
      pendingCleanup: false,
      activeEffects: 0,
    });
    expect(engine.getState().notice).toBeTruthy();
    expect(notified).toHaveBeenCalledOnce();
    expect(Object.isFrozen(engine.getState().observerErrors)).toBe(true);
    off();
    offHealthy();
    await engine.dispose();
  });

  it.each(['disposing', 'disposed'] as const)(
    'preserves successful disposal when a %s observer throws',
    async (phase) => {
      const { engine, context } = await playing(true);
      engine.play('dash');
      const cause = new Error('disposal observer');
      const off = engine.subscribe(() => {
        if (engine.getState().status === phase) throw cause;
      });
      const disposal = engine.dispose();
      await expect(disposal).resolves.toBeUndefined();
      expect(engine.getState()).toMatchObject({
        status: 'disposed',
        cause: null,
        observerErrors: [cause],
        ownsContext: false,
        ownedNodes: 0,
        pendingCleanup: false,
        cleanupErrors: [],
      });
      expect(engine.getState().notice).toBeTruthy();
      off();
      expect(engine.dispose()).toBe(disposal);
      await engine.retryCleanup();
      expect(engine.getState().status).toBe('disposed');
      expect(context.closeCalls).toBe(1);
    },
  );

  it('retains the cleanup outcome separately from the latest observer failure', async () => {
    const { engine, context } = await playing();
    const close = new Error('close');
    const firstObserver = new Error('first observer');
    const lastObserver = new Error('last observer');
    context.closeError = close;
    const offFirst = engine.subscribe(() => {
      throw firstObserver;
    });
    const offLast = engine.subscribe(() => {
      throw lastObserver;
    });
    await expect(engine.dispose()).rejects.toMatchObject({
      cause: close,
      errors: [close],
    });
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause: close,
      observerErrors: [lastObserver],
      cleanupErrors: [close],
      pendingCleanup: true,
      ownsContext: true,
    });
    offFirst();
    offLast();
    context.closeError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      cause: null,
      observerErrors: [lastObserver],
      pendingCleanup: false,
      ownsContext: false,
    });
  });

  it('observes context state changes without resuming or creating audio implicitly', async () => {
    const { engine, context } = await playing(true);
    expect(context.onstatechange).not.toBeNull();
    context.state = 'suspended';
    context.onstatechange?.(new Event('statechange'));
    expect(engine.getState()).toMatchObject({
      status: 'blocked',
      contextState: 'suspended',
      activeAmbience: 0,
    });
    context.state = 'running';
    context.onstatechange?.(new Event('statechange'));
    expect(engine.getState().activeAmbience).toBe(0);
    expect(context.resumeCalls).toBe(1);
    await engine.unlock();
    expect(engine.getState().activeAmbience).toBe(1);
    await engine.dispose();
    expect(context.onstatechange).toBeNull();
  });

  it('silences existing voices if an untrusted unlock request changes status to blocked', async () => {
    const { engine, context, gesture } = await playing(true);
    engine.play('dash');
    gesture.mockReturnValue(false);
    expect((await engine.unlock()).status).toBe('blocked');
    expect(context.gains[0].gain.value).toBe(0);
    expect(engine.getState()).toMatchObject({
      activeEffects: 0,
      activeAmbience: 0,
    });
  });

  it('retries retained silence cleanup after a blocked resume before unlocking again', async () => {
    const { engine, context, construct } = await playing();
    engine.play('dash');
    const denied = new DOMException('Autoplay blocked', 'NotAllowedError');
    const silence = new Error('cancel automation');
    context.state = 'suspended';
    context.resumeError = denied;
    context.gains[0].gain.cancelError = silence;
    await engine.unlock();
    expect(engine.getState()).toMatchObject({
      status: 'blocked',
      cause: denied,
      cleanupErrors: [silence],
      pendingCleanup: true,
      activeEffects: 0,
    });

    context.resumeError = null;
    context.gains[0].gain.cancelError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'locked',
      cause: null,
      cleanupErrors: [],
      pendingCleanup: false,
    });
    expect(context.gains[0].gain.value).toBe(0);
    expect((await engine.unlock()).status).toBe('ready');
    expect(context.resumeCalls).toBe(3);
    expect(construct).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });

  it('preserves secondary silence failures and retries them explicitly', async () => {
    const { engine, context } = await playing();
    const cause = new Error('create oscillator');
    const silence = new Error('cancel automation');
    context.oscillatorError = cause;
    context.gains[0].gain.cancelError = silence;
    engine.play('dash');
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      cleanupErrors: [silence],
      pendingCleanup: true,
    });
    await expect(engine.retryCleanup()).rejects.toBeInstanceOf(AggregateError);
    context.gains[0].gain.cancelError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'locked',
      cause: null,
      pendingCleanup: false,
      cleanupErrors: [],
    });
    expect(context.gains[0].gain.value).toBe(0);
  });

  it.each([
    'gain',
    'oscillator',
    'gain-connect',
    'oscillator-connect',
    'start',
  ] as const)(
    'reports %s failures without emitting or leaking partially allocated voices',
    async (operation) => {
      const { engine, context } = await playing();
      const cause = new Error(operation);
      if (operation === 'gain') context.gainError = cause;
      if (operation === 'oscillator') context.oscillatorError = cause;
      if (operation === 'gain-connect')
        context.configureGain = (node) => {
          node.connectError = cause;
        };
      if (operation === 'oscillator-connect')
        context.configureOscillator = (node) => {
          node.connectError = cause;
        };
      if (operation === 'start')
        context.configureOscillator = (node) => {
          node.startError = cause;
        };
      expect(engine.play('dash')).toBe(false);
      expect(engine.getState()).toMatchObject({
        status: 'failed',
        cause,
        emittedCount: 0,
        droppedCount: 1,
        lastDropReason: 'failed',
        activeEffects: 0,
        ownedNodes: 1,
        pendingCleanup: false,
      });
      expect(engine.getState().notice).toBeTruthy();
      expect(context.closeCalls).toBe(0);
    },
  );

  it('retains a master allocated before a failed connection and failed rollback', async () => {
    const { engine, context, construct } = setup();
    const cause = new Error('connect');
    const cleanup = new Error('disconnect');
    context.configureGain = (node) => {
      node.connectError = cause;
      node.disconnectError = cleanup;
    };
    await engine.unlock();
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      cleanupErrors: [cleanup],
      ownedNodes: 1,
      pendingCleanup: true,
      ownsContext: true,
    });
    await engine.unlock();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(context.gains).toHaveLength(1);
    context.gains[0].disconnectError = null;
    context.configureGain = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'locked',
      ownedNodes: 0,
      pendingCleanup: false,
    });
    await engine.unlock();
    expect(engine.getState()).toMatchObject({ status: 'ready', ownedNodes: 1 });
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it('retains failed partial-allocation cleanup until explicit retry without losing the original cause', async () => {
    const { engine, context } = await playing();
    const cause = new Error('oscillator allocation');
    const cleanup = new Error('gain disconnect');
    context.oscillatorError = cause;
    context.configureGain = (node) => {
      node.disconnectError = cleanup;
    };
    engine.play('dash');
    expect(engine.getState()).toMatchObject({
      cause,
      cleanupErrors: [cleanup],
      pendingCleanup: true,
      ownedNodes: 2,
    });
    expect(context.gains[1].disconnectCalls).toBe(1);
    await expect(engine.retryCleanup()).rejects.toBeInstanceOf(AggregateError);
    expect(engine.getState().cause).toBe(cause);
    expect(context.gains[1].disconnectCalls).toBe(2);
    context.gains[1].disconnectError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'locked',
      pendingCleanup: false,
      ownedNodes: 1,
      cause: null,
    });
    expect(context.closeCalls).toBe(0);
  });

  it('native ended cleanup failures do not throw and are not silently retried by phase changes', async () => {
    const { engine, context } = await playing();
    expect(engine.play('dash')).toBe(true);
    const oscillator = context.oscillators[0];
    const cause = new Error('ended disconnect');
    oscillator.disconnectError = cause;
    expect(() => oscillator.end()).not.toThrow();
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      activeEffects: 0,
      pendingCleanup: true,
      ownedNodes: 2,
      cleanupErrors: [cause],
    });
    engine.setPhase('paused');
    engine.setPhase('playing');
    await engine.unlock();
    expect(oscillator.disconnectCalls).toBe(1);
    await expect(engine.retryCleanup()).rejects.toBeInstanceOf(AggregateError);
    await expect(engine.retryCleanup()).rejects.toBeInstanceOf(AggregateError);
    expect(oscillator.disconnectCalls).toBe(3);
    oscillator.disconnectError = null;
    await engine.retryCleanup();
    expect(oscillator.disconnectCalls).toBe(4);
    expect(context.gains[1].disconnectCalls).toBe(1);
    await engine.unlock();
    expect(engine.play('pearl')).toBe(true);
  });

  it('retains a failed immediate stop even if disconnection succeeded, and retries only failed work', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    const oscillator = context.oscillators[0];
    const cause = new Error('stop');
    oscillator.stopError = cause;
    engine.setPhase('paused');
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      pendingCleanup: true,
      ownedNodes: 2,
    });
    expect(oscillator.disconnectCalls).toBe(1);
    oscillator.stopError = null;
    await engine.retryCleanup();
    expect(oscillator.disconnectCalls).toBe(1);
    expect(oscillator.stops).toHaveLength(3);
    expect(engine.getState().ownedNodes).toBe(1);
  });

  it('safely handles synchronous ended reentrancy during stop and ignores stale callbacks', async () => {
    const { engine, context } = await playing(true);
    engine.play('dash');
    const callbacks = context.oscillators.map(
      (oscillator) => oscillator.onended,
    );
    for (const oscillator of context.oscillators) oscillator.endOnStop = true;
    expect(() => engine.setPhase('paused')).not.toThrow();
    for (const callback of callbacks) callback?.(new Event('ended'));
    expect(engine.getState()).toMatchObject({
      status: 'ready',
      activeEffects: 0,
      activeAmbience: 0,
      ownedNodes: 1,
    });
    expect(context.oscillators).toHaveLength(2);
    for (const oscillator of context.oscillators) {
      expect(oscillator.disconnectCalls).toBe(1);
    }
  });

  it('closes once across concurrent disposal/retry and stays inert afterward', async () => {
    const { engine, context } = await playing(true);
    engine.play('dash');
    context.closeGate = deferred();
    const first = engine.dispose();
    const second = engine.dispose();
    const retry = engine.retryCleanup();
    expect(first).toBe(second);
    expect(retry).toBe(first);
    expect(context.closeCalls).toBe(1);
    expect(context.gains[0].gain.value).toBe(0);
    expect(engine.getState()).toMatchObject({
      status: 'disposing',
      activeEffects: 0,
      activeAmbience: 0,
      pendingCleanup: true,
      ownsContext: true,
      ownedNodes: 0,
    });
    context.closeGate.resolve();
    await first;
    await engine.dispose();
    await engine.retryCleanup();
    engine.setPhase('playing');
    engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
    expect(engine.play('finish')).toBe(false);
    await engine.unlock();
    expect(context.closeCalls).toBe(1);
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      ownsContext: false,
      pendingCleanup: false,
    });
    for (const node of [...context.gains, ...context.oscillators]) {
      expect(node.disconnectCalls).toBe(1);
    }
  });

  it('retains rejected context close and requires an explicit retry, not another dispose', async () => {
    const { engine, context, construct } = await playing();
    const cause = new Error('close rejected');
    context.closeError = cause;
    await expect(engine.dispose()).rejects.toMatchObject({ cause });
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      cause,
      pendingCleanup: true,
      ownsContext: true,
      cleanupErrors: [cause],
      ownedNodes: 0,
    });
    await expect(engine.dispose()).rejects.toMatchObject({ cause });
    expect(context.closeCalls).toBe(1);
    await engine.unlock();
    expect(construct).toHaveBeenCalledTimes(1);
    await expect(engine.retryCleanup()).rejects.toMatchObject({ cause });
    expect(context.closeCalls).toBe(2);
    context.closeError = null;
    await engine.retryCleanup();
    expect(context.closeCalls).toBe(3);
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      pendingCleanup: false,
      ownsContext: false,
      cause: null,
    });
  });

  it('retains failed nodes after context close and does not close a successfully closed context again', async () => {
    const { engine, context } = await playing();
    engine.play('dash');
    const cleanup = new Error('disconnect');
    context.oscillators[0].disconnectError = cleanup;
    await expect(engine.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(context.state).toBe('closed');
    expect(engine.getState()).toMatchObject({
      status: 'failed',
      ownsContext: false,
      pendingCleanup: true,
      ownedNodes: 1,
    });
    context.oscillators[0].disconnectError = null;
    await engine.retryCleanup();
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      ownedNodes: 0,
    });
    expect(context.closeCalls).toBe(1);
  });

  it('handles a late resume rejection after disposal without overriding final state', async () => {
    const { engine, context } = setup();
    context.resumeGate = deferred();
    const unlocking = engine.unlock();
    await engine.dispose();
    context.resumeGate.reject(new Error('late resume'));
    await unlocking;
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      cause: null,
      pendingUnlock: false,
      ownsContext: false,
    });
  });

  it('fences a pending unlock cancelled by pause even if playing is selected again before completion', async () => {
    const { engine, context } = setup();
    engine.setSettings({ ...DEFAULT_SETTINGS, musicEnabled: true });
    engine.setPhase('playing');
    context.resumeGate = deferred();
    const unlocking = engine.unlock();
    engine.setPhase('paused');
    engine.setPhase('playing');
    context.resumeGate.resolve();
    await unlocking;
    expect(engine.getState()).toMatchObject({
      status: 'locked',
      activeAmbience: 0,
    });
    await engine.unlock();
    expect(engine.getState().activeAmbience).toBe(1);
  });

  it('does not emit into an externally suspended context or implicitly resume it', async () => {
    const { engine, context } = await playing();
    context.state = 'suspended';
    expect(engine.play('dash')).toBe(false);
    expect(engine.getState()).toMatchObject({
      status: 'blocked',
      contextState: 'suspended',
    });
    expect(context.resumeCalls).toBe(1);
    expect(context.oscillators).toHaveLength(0);
  });
});

describe('lazy ownership and unlock', () => {
  it('treats invalid phases and cues as programming errors before mutation', () => {
    const { engine } = setup();
    const before = engine.getSnapshot();
    expect(() => {
      // @ts-expect-error Test an untyped host boundary.
      engine.setPhase('hidden');
    }).toThrow();
    expect(engine.getSnapshot()).toBe(before);
    expect(() => {
      // @ts-expect-error Test an untyped host boundary.
      engine.play('toString');
    }).toThrow();
    expect(engine.getSnapshot()).toBe(before);
  });

  it('does not publish when validated settings have no effective change', () => {
    const { engine } = setup();
    const before = engine.getSnapshot();
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.setSettings({ ...DEFAULT_SETTINGS });
    expect(engine.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not create a context through construction, settings, phase or play', () => {
    const { engine, construct } = setup();
    const initial = engine.getSnapshot();
    expect(initial).toMatchObject({
      status: 'locked',
      phase: 'idle',
      settings: DEFAULT_SETTINGS,
      ownsContext: false,
      ownedNodes: 0,
      pendingUnlock: false,
      pendingCleanup: false,
    });
    expect(engine.getState()).toBe(initial);
    engine.setSettings({ ...DEFAULT_SETTINGS, masterVolume: 0.7 });
    engine.setPhase('playing');
    expect(engine.play('dash')).toBe(false);
    expect(construct).not.toHaveBeenCalled();
  });

  it('rejects settings before any mutation, including after disposal', async () => {
    const { engine } = setup();
    for (const invalid of [
      { ...DEFAULT_SETTINGS, masterVolume: NaN },
      { ...DEFAULT_SETTINGS, sfxEnabled: 'true' },
      { ...DEFAULT_SETTINGS, unexpected: true },
      {},
      null,
    ]) {
      const before = engine.getState();
      expect(() => engine.setSettings(invalid)).toThrow();
      expect(engine.getState()).toBe(before);
    }
    await engine.dispose();
    const disposed = engine.getState();
    expect(() => engine.setSettings({ masterVolume: -1 })).toThrow();
    expect(engine.getState()).toBe(disposed);
  });

  it('publishes stable immutable snapshots and supports unsubscribe', () => {
    const { engine } = setup();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const initial = engine.getSnapshot();
    engine.setPhase('playing');
    const playing = engine.getSnapshot();
    expect(playing).not.toBe(initial);
    expect(Object.isFrozen(playing)).toBe(true);
    expect(Object.isFrozen(playing.settings)).toBe(true);
    expect(Object.isFrozen(playing.emittedCues)).toBe(true);
    expect(Object.isFrozen(playing.cleanupErrors)).toBe(true);
    expect(initial.phase).toBe('idle');
    expect(engine.getSnapshot()).toBe(playing);
    engine.setPhase('playing');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    engine.setPhase('paused');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('blocks untrusted unlock with a notice without allocation', async () => {
    const { engine, gesture, construct } = setup();
    gesture.mockReturnValue(false);
    expect(await engine.unlock()).toMatchObject({ status: 'blocked' });
    expect(engine.getState().notice).toBeTruthy();
    expect(construct).not.toHaveBeenCalled();
  });

  it.each([{ masterVolume: 0 }, { sfxEnabled: false, musicEnabled: false }])(
    'does not allocate for disabled audio %j',
    async (patch) => {
      const { engine, construct } = setup();
      engine.setSettings({ ...DEFAULT_SETTINGS, ...patch });
      await engine.unlock();
      expect(construct).not.toHaveBeenCalled();
      expect(engine.getState().status).toBe('locked');
    },
  );

  it('coalesces pending unlocks and reuses a healthy context across replays', async () => {
    const { engine, context, construct } = setup();
    context.resumeGate = deferred();
    const first = engine.unlock();
    const second = engine.unlock();
    expect(second).toBe(first);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(context.resumeCalls).toBe(1);
    expect(engine.getState()).toMatchObject({
      status: 'unlocking',
      pendingUnlock: true,
      ownsContext: true,
    });
    context.resumeGate.resolve();
    expect(await first).toMatchObject({
      status: 'ready',
      pendingUnlock: false,
    });
    for (let index = 0; index < 3; index++) {
      engine.setPhase('playing');
      engine.setPhase('results');
      engine.setPhase('idle');
      await engine.unlock();
    }
    expect(construct).toHaveBeenCalledTimes(1);
    expect(context.resumeCalls).toBe(1);
  });

  it('uses the default constructor path with a real-shaped injected constructor', async () => {
    const instances: FakeContext[] = [];
    class ContextConstructor extends FakeContext {
      constructor() {
        super();
        instances.push(this);
      }
    }
    const engine = createAudioEngine({
      AudioContext: ContextConstructor,
      isUserGesture: () => true,
    });
    expect(instances).toHaveLength(0);
    await engine.unlock();
    expect(instances).toHaveLength(1);
    expect(instances[0].state).toBe('running');
    expect(engine.getState().status).toBe('ready');
  });

  it('uses native browser activation and the global AudioContext by default', async () => {
    const context = new FakeContext();
    const construct = vi.fn(function () {
      return context;
    });
    const activation = { isActive: false, hasBeenActive: true };
    vi.stubGlobal('AudioContext', construct);
    vi.stubGlobal('navigator', { userActivation: activation });
    const engine = createAudioEngine();
    expect((await engine.unlock()).status).toBe('blocked');
    expect(construct).not.toHaveBeenCalled();
    activation.isActive = true;
    expect((await engine.unlock()).status).toBe('ready');
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it('fails closed when transient activation cannot be observed', async () => {
    vi.stubGlobal('navigator', {});
    const { context } = setup();
    const construct = vi.fn(() => context);
    const engine = createAudioEngine({ createContext: construct });
    expect((await engine.unlock()).status).toBe('blocked');
    expect(construct).not.toHaveBeenCalled();
  });

  it('reports unavailable and constructor errors with their causes', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const unavailable = createAudioEngine({ isUserGesture: () => true });
    expect(await unavailable.unlock()).toMatchObject({
      status: 'unavailable',
      ownsContext: false,
    });
    expect(unavailable.getState().notice).toBeTruthy();
    const cause = new Error('constructor failed');
    const failed = createAudioEngine({
      isUserGesture: () => true,
      createContext: () => {
        throw cause;
      },
    });
    expect(await failed.unlock()).toMatchObject({
      status: 'failed',
      cause,
      ownsContext: false,
    });
  });

  it('reports denied resume and retries the same context on a fresh gesture', async () => {
    const { engine, context, construct } = setup();
    const cause = new DOMException('Autoplay denied', 'NotAllowedError');
    context.resumeError = cause;
    expect(await engine.unlock()).toMatchObject({
      status: 'blocked',
      cause,
      ownsContext: true,
    });
    context.resumeError = null;
    expect((await engine.unlock()).status).toBe('ready');
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it('closes without waiting for an unresolved resume and fences its completion', async () => {
    const { engine, context, construct } = setup();
    context.resumeGate = deferred();
    const unlocking = engine.unlock();
    const disposing = engine.dispose();
    expect(context.closeCalls).toBe(1);
    await disposing;
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      ownsContext: false,
      ownedNodes: 0,
      pendingUnlock: true,
    });
    context.resumeGate.resolve();
    await unlocking;
    expect(engine.getState()).toMatchObject({
      status: 'disposed',
      pendingUnlock: false,
      activeEffects: 0,
      activeAmbience: 0,
    });
    await engine.unlock();
    expect(construct).toHaveBeenCalledTimes(1);
  });
});
