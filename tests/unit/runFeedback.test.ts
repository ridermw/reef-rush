import { describe, expect, it } from 'vitest';
import { createRunFeedback } from '../../src/game/core/runFeedback';
import type { FishControllerEvent } from '../../src/game/player/FishController';
import type { RaceEvent } from '../../src/game/race/raceTypes';

const result = {
  courseId: 'sunlit-shoals',
  elapsedMs: 12_345.678,
  medal: 'gold',
  pearlCount: 1,
  totalPearls: 1,
} as const;
const checkpoint: RaceEvent = {
  type: 'checkpoint',
  checkpointId: 'gate',
  checkpointIndex: 0,
  elapsedMs: 10,
  fraction: 0.5,
};
const pearl: RaceEvent = {
  type: 'pearl',
  pearlId: 'pearl',
  elapsedMs: 11,
  fraction: 0.6,
};

describe('bounded run feedback', () => {
  it.each([
    [0, 'Checkpoint 1 cleared'],
    [2, 'Checkpoint 3 cleared'],
    [4, 'Checkpoint 5 cleared'],
  ] as const)(
    'presents zero-based checkpoint event %s using human numbering',
    (checkpointIndex, text) => {
      const feedback = createRunFeedback();
      feedback.consume([], [{ ...checkpoint, checkpointIndex }], 0);
      expect(feedback.getState(0)).toMatchObject({
        cue: 'checkpoint',
        text,
        announcement: text,
      });
    },
  );

  it('maps every authoritative event once, without duplicating trigger contacts', () => {
    const feedback = createRunFeedback();
    const fish: FishControllerEvent[] = [
      { type: 'dash' },
      { type: 'breach' },
      { type: 'splashdown' },
      { type: 'collision', colliderHandle: 1, normal: [0, 1, 0] },
      { type: 'hazard-entered', colliderHandle: 2 },
      { type: 'checkpoint-entered', colliderHandle: 3 },
      { type: 'pearl-entered', colliderHandle: 4 },
      { type: 'pause-requested' },
    ];
    expect(feedback.consume(fish, [checkpoint, pearl], 0)).toEqual([
      'dash',
      'breach',
      'splashdown',
      'collision',
      'hazard',
      'checkpoint',
      'pearl',
    ]);
    expect(feedback.getState(0)).toMatchObject({
      cue: 'checkpoint',
      announcement: 'Checkpoint 1 cleared',
    });
  });

  it('retains the highest priority across catchup steps, including the terminal step', () => {
    const feedback = createRunFeedback();
    feedback.consume([], [pearl], 0);
    feedback.consume([], [checkpoint], 1);
    feedback.consume([{ type: 'dash' }], [], 2);
    const before = feedback.getState(2);
    expect(before?.cue).toBe('checkpoint');
    expect(
      feedback.consume(
        [],
        [{ type: 'finish', result, fraction: 1, elapsedMs: result.elapsedMs }],
        3,
      ),
    ).toEqual(['finish']);
    expect(feedback.getState(3)).toMatchObject({ cue: 'finish' });
    expect(before?.cue).toBe('checkpoint');
    expect(Object.isFrozen(before)).toBe(true);
    feedback.consume([{ type: 'breach' }], [], 4);
    expect(feedback.getState(4)?.cue).toBe('finish');
  });

  it('expires a single cue, never announces contact/movement, and clears replay state', () => {
    const feedback = createRunFeedback();
    feedback.consume([{ type: 'hazard-entered', colliderHandle: 1 }], [], 0);
    expect(feedback.getState(0)).toMatchObject({
      cue: 'hazard',
      announcement: null,
    });
    for (let i = 1; i < 100; i++) {
      feedback.consume(
        [{ type: 'collision', colliderHandle: 1, normal: [0, 1, 0] }],
        [],
        i,
      );
    }
    expect(feedback.getState(100)?.announcement).toBeNull();
    expect(feedback.getState(3000)).toBeNull();
    feedback.consume([], [pearl], 4000);
    expect(feedback.getState(4000)?.announcement).toBe('Pearl collected');
    feedback.clear();
    expect(feedback.getState(4000)).toBeNull();
  });
});
