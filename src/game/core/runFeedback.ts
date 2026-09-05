import type { AudioCue } from '../audio/AudioEngine';
import type { FishControllerEvent } from '../player/FishController';
import type { RaceEvent } from '../race/raceTypes';

export interface RunFeedback {
  readonly cue: AudioCue;
  readonly text: string;
  readonly announcement: string | null;
  readonly sequence: number;
}

const priority: Readonly<Record<AudioCue, number>> = {
  finish: 5,
  checkpoint: 4,
  pearl: 3,
  hazard: 2,
  collision: 2,
  dash: 1,
  breach: 1,
  splashdown: 1,
};
const labels: Readonly<Record<AudioCue, string>> = {
  finish: 'Finish reached',
  checkpoint: 'Checkpoint cleared',
  pearl: 'Pearl collected',
  hazard: 'Watch the reef',
  collision: 'A close brush',
  dash: 'Quick current',
  breach: 'Above the waves',
  splashdown: 'Back in the blue',
};

export function createRunFeedback() {
  let state: RunFeedback | null = null;
  let expiresAt = 0;
  let sequence = 0;
  function getState(now: number): RunFeedback | null {
    if (now >= expiresAt) state = null;
    return state;
  }
  return {
    consume(
      fish: readonly FishControllerEvent[],
      race: readonly RaceEvent[],
      now: number,
    ): AudioCue[] {
      const cues: AudioCue[] = [];
      function add(cue: AudioCue, text = labels[cue]) {
        cues.push(cue);
        const previous = getState(now);
        if (previous && priority[previous.cue] > priority[cue]) return;
        state = Object.freeze({
          cue,
          text,
          sequence: ++sequence,
          announcement: priority[cue] >= priority.pearl ? text : null,
        });
        expiresAt = now + 1800;
      }
      for (const event of fish) {
        switch (event.type) {
          case 'dash':
          case 'breach':
          case 'splashdown':
          case 'collision':
            add(event.type);
            break;
          case 'hazard-entered':
            add('hazard');
            break;
        }
      }
      for (const event of race) {
        add(
          event.type,
          event.type === 'checkpoint'
            ? `Checkpoint ${event.checkpointIndex} cleared`
            : labels[event.type],
        );
      }
      return cues;
    },
    getState,
    clear() {
      state = null;
      expiresAt = 0;
      sequence = 0;
    },
  };
}
