export function courseFixture() {
  return {
    version: 1,
    courseId: 'sunlit-shoals',
    name: 'Sunlit Shoals',
    summary: 'Generated course fixture.',
    medalTimesMs: { gold: 12_000, silver: 18_000, bronze: 30_000 },
    visuals: {
      kind: 'generated',
      waterColor: '#137e91',
      seabedColor: '#e5d6a0',
    },
    spawn: { position: [0, -3, 0], yaw: 0 },
    checkpoints: [
      { id: 'start', position: [0, -3, 2], radius: 2, direction: [0, 0, 1] },
      { id: 'finish', position: [0, -3, 20], radius: 2, direction: [0, 0, 1] },
    ],
    pearls: [{ id: 'pearl-one', position: [0, -3, 8], radius: 0.3 }],
    objects: [
      {
        type: 'box',
        id: 'floor',
        position: [0, -6, 10],
        halfExtents: [10, 1, 15],
        rotation: [0, 0, 0, 1],
        collision: 'environment',
        color: '#d8ccab',
      },
      {
        type: 'sphere',
        id: 'rock',
        position: [5, -3, 10],
        radius: 1,
        collision: 'hazard',
        color: '#bb6655',
      },
      {
        type: 'current',
        id: 'flow',
        position: [0, -3, 8],
        halfExtents: [2, 2, 3],
        velocity: [0, 0, 2],
        color: '#5fcccc',
      },
      {
        type: 'rotating-gate',
        id: 'gate',
        position: [0, -3, 14],
        halfExtents: [3, 0.2, 0.2],
        axis: [0, 0, 1],
        phase: 0,
        angularSpeed: Math.PI / 2,
        color: '#dfa650',
      },
    ],
  } as const;
}
