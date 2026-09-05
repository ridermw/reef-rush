import type {
  AudioContextPort,
  AudioGainPort,
  AudioNodePort,
  AudioOscillatorPort,
  AudioParamPort,
} from '../../src/game/audio/AudioEngine';

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
}

export class FakeParam implements AudioParamPort {
  value = 1;
  cancelError: Error | null = null;
  events: Array<{ kind: string; value?: number; time: number }> = [];
  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ kind: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ kind: 'ramp', value, time });
    return this;
  }
  cancelAndHoldAtTime(time: number) {
    this.events.push({ kind: 'hold', time });
    return this;
  }
  cancelScheduledValues(time: number) {
    if (this.cancelError) throw this.cancelError;
    this.events.push({ kind: 'cancel', time });
    return this;
  }
}

export class FakeNode implements AudioNodePort {
  connections = new Set<AudioNodePort>();
  disconnectCalls = 0;
  connectError: Error | null = null;
  disconnectError: Error | null = null;
  connect(destination: AudioNodePort) {
    if (this.connectError) throw this.connectError;
    this.connections.add(destination);
    return destination;
  }
  disconnect() {
    this.disconnectCalls++;
    if (this.disconnectError) throw this.disconnectError;
    this.connections.clear();
  }
}

export class FakeGain extends FakeNode implements AudioGainPort {
  gain = new FakeParam();
}

export class FakeOscillator extends FakeNode implements AudioOscillatorPort {
  type: OscillatorType = 'sine';
  frequency = new FakeParam();
  onended: ((event: Event) => void) | null = null;
  starts: number[] = [];
  stops: number[] = [];
  startError: Error | null = null;
  stopError: Error | null = null;
  endOnStop = false;
  start(when = 0) {
    if (this.startError) throw this.startError;
    this.starts.push(when);
  }
  stop(when = 0) {
    this.stops.push(when);
    if (this.stopError) throw this.stopError;
    if (this.endOnStop) this.end();
  }
  end() {
    this.onended?.(new Event('ended'));
  }
}

export class FakeContext implements AudioContextPort {
  currentTime = 1;
  state: AudioContextState = 'suspended';
  onstatechange: ((event: Event) => void) | null = null;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  resumeGate: Gate | null = null;
  closeGate: Gate | null = null;
  resumeError: Error | null = null;
  closeError: Error | null = null;
  gainError: Error | null = null;
  oscillatorError: Error | null = null;
  configureGain: ((gain: FakeGain) => void) | null = null;
  configureOscillator: ((oscillator: FakeOscillator) => void) | null = null;
  createGain() {
    if (this.gainError) throw this.gainError;
    const gain = new FakeGain();
    this.gains.push(gain);
    this.configureGain?.(gain);
    return gain;
  }
  createOscillator() {
    if (this.oscillatorError) throw this.oscillatorError;
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    this.configureOscillator?.(oscillator);
    return oscillator;
  }
  async resume() {
    this.resumeCalls++;
    if (this.resumeError) throw this.resumeError;
    await this.resumeGate?.promise;
    if (this.state !== 'closed') this.state = 'running';
  }
  async close() {
    this.closeCalls++;
    if (this.closeError) throw this.closeError;
    await this.closeGate?.promise;
    this.state = 'closed';
  }
}
