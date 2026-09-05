import { releaseResources } from '../core/resourceCleanup';
import type {
  AudioContextPort,
  AudioCue,
  AudioGainPort,
  AudioNodePort,
  AudioOscillatorPort,
} from './AudioEngine';

type VoiceCue = AudioCue | 'ambience';
interface Pattern {
  readonly pitches: readonly number[];
  readonly duration: number;
  readonly peak: number;
  readonly type: OscillatorType;
}
const patterns: Record<VoiceCue, Pattern> = {
  dash: { pitches: [180, 360], duration: 0.14, peak: 0.045, type: 'sine' },
  checkpoint: {
    pitches: [440, 554, 660],
    duration: 0.24,
    peak: 0.05,
    type: 'sine',
  },
  pearl: { pitches: [660, 880], duration: 0.16, peak: 0.035, type: 'sine' },
  finish: {
    pitches: [330, 440, 550, 660],
    duration: 0.6,
    peak: 0.06,
    type: 'sine',
  },
  collision: {
    pitches: [130, 65],
    duration: 0.12,
    peak: 0.045,
    type: 'triangle',
  },
  hazard: {
    pitches: [170, 110, 80],
    duration: 0.18,
    peak: 0.045,
    type: 'triangle',
  },
  breach: { pitches: [220, 390], duration: 0.25, peak: 0.04, type: 'sine' },
  splashdown: { pitches: [300, 95], duration: 0.2, peak: 0.04, type: 'sine' },
  ambience: { pitches: [84, 88, 84], duration: 4, peak: 0.012, type: 'sine' },
};

interface NodeOwner {
  releases: Array<() => void>;
  errors: unknown[];
}
interface Voice {
  readonly cue: VoiceCue;
  readonly nodes: NodeOwner[];
  oscillator: AudioOscillatorPort | null;
  active: boolean;
  started: boolean;
  ended: boolean;
}

function own(node: AudioNodePort): NodeOwner {
  return { releases: [() => node.disconnect()], errors: [] };
}
function release(owner: NodeOwner): unknown[] {
  owner.errors = releaseResources(owner.releases);
  return owner.errors;
}

/** Synchronous graph ownership only. The director owns asynchronous context.close. */
export class AudioGraph {
  private master: AudioGainPort | null = null;
  private masterOwner: NodeOwner | null = null;
  private volume = 0;
  private readonly voices: Voice[] = [];

  constructor(
    private readonly context: AudioContextPort,
    private readonly onEnded: () => void,
    private readonly onFailure: (cause: unknown) => void,
  ) {}

  get activeEffects(): number {
    return this.voices.filter(
      (voice) => voice.active && voice.cue !== 'ambience',
    ).length;
  }
  get activeAmbience(): number {
    return this.voices.filter(
      (voice) => voice.active && voice.cue === 'ambience',
    ).length;
  }
  get ownedNodes(): number {
    return this.owners.filter((owner) => owner.releases.length > 0).length;
  }
  get cleanupErrors(): unknown[] {
    return this.owners.flatMap((owner) => owner.errors);
  }
  get pendingCleanup(): boolean {
    return this.cleanupErrors.length > 0;
  }
  private get owners(): NodeOwner[] {
    return [
      ...(this.masterOwner ? [this.masterOwner] : []),
      ...this.voices.flatMap((voice) => voice.nodes),
    ];
  }

  initialize(): void {
    if (this.master) return;
    const master = this.context.createGain();
    this.masterOwner = own(master);
    try {
      master.gain.setValueAtTime(0, this.context.currentTime);
      master.connect(this.context.destination);
      this.master = master;
      this.volume = 0;
    } catch (cause) {
      release(this.masterOwner);
      throw cause;
    }
  }

  setVolume(value: number): void {
    if (!this.master || this.volume === value) return;
    const { gain } = this.master;
    const now = this.context.currentTime;
    if (value === 0) {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(0, now);
    } else {
      gain.cancelAndHoldAtTime(now);
      gain.linearRampToValueAtTime(value, now + 0.03);
    }
    this.volume = value;
  }

  start(cue: VoiceCue): void {
    if (!this.master) throw new Error('Audio graph is not initialized.');
    const voice: Voice = {
      cue,
      nodes: [],
      oscillator: null,
      active: false,
      started: false,
      ended: false,
    };
    this.voices.push(voice);
    try {
      const envelope = this.context.createGain();
      voice.nodes.push(own(envelope));
      const oscillator = this.context.createOscillator();
      voice.oscillator = oscillator;
      const owner = own(oscillator);
      owner.releases.push(() => {
        if (voice.started && !voice.ended)
          oscillator.stop(this.context.currentTime);
      });
      voice.nodes.push(owner);
      const pattern = patterns[cue];
      const now = this.context.currentTime;
      oscillator.type = pattern.type;
      oscillator.frequency.setValueAtTime(pattern.pitches[0], now);
      pattern.pitches.slice(1).forEach((pitch, index) => {
        oscillator.frequency.linearRampToValueAtTime(
          pitch,
          now + (pattern.duration * (index + 1)) / (pattern.pitches.length - 1),
        );
      });
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(
        pattern.peak,
        now + Math.min(0.02, pattern.duration / 4),
      );
      envelope.gain.setValueAtTime(pattern.peak, now + pattern.duration * 0.6);
      envelope.gain.linearRampToValueAtTime(0, now + pattern.duration);
      oscillator.connect(envelope);
      envelope.connect(this.master);
      oscillator.onended = () => {
        if (!voice.active) return;
        voice.ended = true;
        const errors = this.retire(voice);
        if (errors.length > 0) this.onFailure(errors[0]);
        else this.onEnded();
      };
      oscillator.start(now);
      voice.started = true;
      voice.active = true;
      oscillator.stop(now + pattern.duration);
    } catch (cause) {
      this.retire(voice);
      throw cause;
    }
  }

  private retire(voice: Voice): unknown[] {
    voice.active = false;
    if (voice.oscillator) voice.oscillator.onended = null;
    const errors = voice.nodes.flatMap(release);
    if (voice.nodes.every((node) => node.releases.length === 0)) {
      const index = this.voices.indexOf(voice);
      if (index !== -1) this.voices.splice(index, 1);
    }
    return errors;
  }

  stopWhere(predicate: (cue: VoiceCue) => boolean): unknown[] {
    return [...this.voices]
      .filter((voice) => voice.active && predicate(voice.cue))
      .flatMap((voice) => this.retire(voice));
  }

  replaceOldestEffect(): boolean {
    const oldest = this.voices.find(
      (voice) =>
        voice.active && voice.cue !== 'ambience' && voice.cue !== 'finish',
    );
    if (!oldest) return false;
    const errors = this.retire(oldest);
    if (errors.length > 0) throw errors[0];
    return true;
  }

  silence(): unknown[] {
    const errors: unknown[] = [];
    try {
      this.setVolume(0);
    } catch (cause) {
      errors.push(cause);
    }
    return [...errors, ...this.stopWhere(() => true)];
  }

  cleanup(final: boolean): unknown[] {
    const errors: unknown[] = [];
    for (const voice of [...this.voices]) {
      if (final || !voice.active) errors.push(...this.retire(voice));
    }
    if (this.masterOwner && (final || !this.master)) {
      this.master = null;
      errors.push(...release(this.masterOwner));
    }
    return errors;
  }
}
