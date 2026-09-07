import { expect, it } from 'vitest';
import sunlit from '../../src/content/courses/sunlitShoals';
import { createAssetCache } from '../../src/game/assets/AssetCache';
import { createSceneRuntime } from '../../src/game/core/SceneRuntime';
import { localAssetLoader } from '../fixtures/originalAssets';
import {
  predictSunlitPulse,
  type SunlitPulseCommand,
} from '../fixtures/sunlitPulsePolicy';
import * as simulation from '../fixtures/simulateSunlitPulses';

// Run 34009109366 / a61bff2, before its first native key. These anchors
// characterize late enrollment, not qualification of changed commands.
it.each([
  {
    name: 'passing Kelpworks',
    steps: 128,
    position: [0, -4, 11.34973],
    checkpoints: 0,
  },
  {
    name: 'late Blacksmoker',
    steps: 285,
    position: [0.45, -4, 29.29945],
    checkpoints: 1,
  },
  {
    name: 'missed second checkpoint before Course Medals enrollment',
    steps: 383,
    position: [0.72, -4, 40.449388],
    checkpoints: 1,
  },
])(
  'reproduces fifth-run unsteered startup in original physics: $name',
  async (sample) => {
    const result = await simulation.simulateSunlitPulses({
      initialSteps: sample.steps,
      maxDecisions: 1,
      timings: [{ onsetSteps: 0, holdSteps: 0, observationSteps: 1 }],
      policy: () => ({ brakeHeld: false, pulse: null }),
    });
    const observed = result.decisions[0].observation;
    expect(observed.steps).toBe(sample.steps);
    expect(
      Math.hypot(
        ...observed.fish.position.map(
          (value, axis) => value - sample.position[axis],
        ),
      ),
    ).toBeLessThan(0.001);
    expect(observed.checkpointIndex).toBe(sample.checkpoints);
    expect(observed.collectedPearlIds).toEqual(
      sample.checkpoints ? ['pearl-entry'] : [],
    );
    expect(result.remainingOwnedKeys).toEqual([]);
  },
);

function run() {
  expect(simulation.simulateSunlitPulses).toBeTypeOf('function');
  return simulation.simulateSunlitPulses;
}

it('rejects a delivery cycle beyond the total simulation budget', async () => {
  await expect(
    run()({
      initialSteps: 0,
      timings: [{ onsetSteps: 7200, holdSteps: 8, observationSteps: 6 }],
      maxDecisions: 1,
      policy: () => ({ brakeHeld: true, pulse: 'a' }),
    }),
  ).rejects.toThrow('Pulse delivery exceeds the simulation budget.');
});

const profiles = [
  {
    name: 'prompt',
    initialSteps: 0,
    timings: [{ onsetSteps: 0, holdSteps: 6, observationSteps: 1 }],
  },
  {
    name: 'local scale',
    initialSteps: 78,
    timings: [{ onsetSteps: 12, holdSteps: 8, observationSteps: 6 }],
  },
  {
    name: 'sustained delay',
    initialSteps: 150,
    timings: [{ onsetSteps: 36, holdSteps: 12, observationSteps: 12 }],
  },
  {
    name: 'early long and late short',
    initialSteps: 116,
    timings: [
      { onsetSteps: 0, holdSteps: 18, observationSteps: 4 },
      { onsetSteps: 48, holdSteps: 6, observationSteps: 10 },
      { onsetSteps: 12, holdSteps: 8, observationSteps: 8 },
      { onsetSteps: 24, holdSteps: 12, observationSteps: 6 },
    ],
  },
  {
    name: 'isolated long delay',
    initialSteps: 148,
    timings: [{ onsetSteps: 12, holdSteps: 8, observationSteps: 6 }],
    isolatedDelay: {
      decision: 12,
      timing: { onsetSteps: 66, holdSteps: 6, observationSteps: 12 },
    },
  },
];

it.each(profiles)(
  'earns every original Sunlit milestone and bronze under $name',
  async (profile) => {
    const result = await run()({ ...profile, maxSteps: 2400 });
    console.info(
      JSON.stringify({
        profile: profile.name,
        steps: result.steps,
        decisions: result.decisions.length,
        elapsedMs: result.snapshot.race.elapsedMs,
        status: result.snapshot.race.status,
        checkpoints: result.snapshot.race.checkpointIndex,
        pearlIds: result.snapshot.collectedPearlIds,
        waypoint: result.waypoint,
        fish: result.snapshot.fish,
        last: result.decisions.slice(-3),
        history:
          result.snapshot.race.elapsedMs > 30_000
            ? result.decisions.map((decision, index) => {
                const next = result.decisions[index + 1];
                const prediction = predictSunlitPulse(
                  decision.observation,
                  decision.command,
                  decision.timing,
                );
                return {
                  ...decision,
                  positionError: next
                    ? Math.hypot(
                        ...next.position.map(
                          (value, axis) =>
                            value - prediction.boundaryFish.position[axis],
                        ),
                      )
                    : null,
                  predictedBoundary: prediction.boundaryFish,
                };
              })
            : undefined,
        approach:
          result.snapshot.race.status === 'finished'
            ? undefined
            : result.decisions
                .filter(
                  (decision) =>
                    decision.waypoint === 2 || decision.waypoint === 3,
                )
                .slice(0, 12),
      }),
    );
    expect(result.snapshot.race.status).toBe('finished');
    expect(result.snapshot.race.elapsedMs).toBeLessThanOrEqual(30_000);
    expect(result.snapshot.race.checkpointIndex).toBe(4);
    expect([...result.snapshot.collectedPearlIds].sort()).toEqual(
      sunlit.pearls.map((pearl) => pearl.id).sort(),
    );

    expect(
      result.events
        .filter((event) => event.type === 'checkpoint')
        .map((event) => event.checkpointIndex),
    ).toEqual([0, 1, 2, 3]);
    expect(result.remainingOwnedKeys).toEqual([]);
    expect(result.released.lifecycle).toBe('disposed');
    expect(
      Object.values(result.assetOwnership).every((count) => count === 0),
    ).toBe(true);
    expect([...result.loadedAssets].sort()).toEqual(
      [
        'courses/sunlit-shoals.visual.glb',
        'courses/sunlit-shoals.collision.glb',
        'fish/sunfin.glb',
      ].sort(),
    );
  },
  60_000,
);

it('calibrates generated brake and pulse delivery against independent literal original physics', async () => {
  const commands: SunlitPulseCommand[] = [
    { brakeHeld: true, pulse: null },
    { brakeHeld: false, pulse: 'a' },
  ];
  let commandIndex = 0;
  const result = await run()({
    initialSteps: 0,
    timings: [{ onsetSteps: 12, holdSteps: 8, observationSteps: 6 }],
    maxDecisions: 2,
    policy: () => {
      const command = commands[commandIndex++];
      if (!command) throw new Error('Unexpected calibration command.');
      return command;
    },
  });
  const runtime = await createSceneRuntime(sunlit, {
    assetCache: createAssetCache({ loader: localAssetLoader }),
  });
  try {
    runtime.start();
    const frames = [
      ...Array.from({ length: 12 }, () => ({ brakeHeld: false, steerX: 0 })),
      ...Array.from({ length: 14 }, () => ({ brakeHeld: true, steerX: 0 })),
      ...Array.from({ length: 4 }, () => ({ brakeHeld: false, steerX: 0 })),
      ...Array.from({ length: 8 }, () => ({ brakeHeld: false, steerX: 1 })),
      ...Array.from({ length: 6 }, () => ({ brakeHeld: false, steerX: 0 })),
    ];
    for (const frame of frames) {
      runtime.step(
        {
          ...frame,
          steerY: 0,
          throttle: 0,
          dashPressed: false,
          pausePressed: false,
        },
        1 / 60,
      );
    }
    expect(result.steps).toBe(44);
    expect(result.snapshot).toEqual(runtime.getSnapshot());
    expect(result.remainingOwnedKeys).toEqual([]);
  } finally {
    runtime.dispose();
  }
});
