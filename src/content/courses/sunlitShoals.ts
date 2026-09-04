import type { CourseDefinition } from '../../game/course/courseDefinition';
import { COURSES } from './courseIds';

const summary = COURSES.find((course) => course.id === 'sunlit-shoals');
if (!summary) throw new Error('Missing Sunlit Shoals course metadata.');

// Original generated blockout; not a calibrated gameplay or art-quality claim.
const sunlitShoals = {
  version: 1,
  courseId: summary.id,
  name: summary.name,
  summary: summary.summary,
  visuals: {
    kind: 'generated',
    waterColor: '#208eaa',
    seabedColor: '#e4d2a2',
  },
  spawn: { position: [0, -4, 0], yaw: 0 },
  checkpoints: [
    {
      id: 'shoals-entry',
      position: [0, -4, 12],
      radius: 4,
      direction: [0, 0, 1],
    },
    {
      id: 'coral-bend',
      position: [5, -4, 36],
      radius: 4,
      direction: [0, 0, 1],
    },
    {
      id: 'sway-passage',
      position: [-4, -5, 60],
      radius: 4,
      direction: [0, 0, 1],
    },
    {
      id: 'shoals-finish',
      position: [0, -4, 92],
      radius: 4,
      direction: [0, 0, 1],
    },
  ],
  pearls: [
    { id: 'pearl-entry', position: [0, -4, 18], radius: 0.35 },
    { id: 'pearl-bend', position: [5, -4, 40], radius: 0.35 },
    { id: 'pearl-passage', position: [-4, -5, 64], radius: 0.35 },
    { id: 'pearl-home', position: [0, -4, 84], radius: 0.35 },
  ],
  objects: [
    {
      type: 'box',
      id: 'sand-bed',
      position: [0, -10, 45],
      halfExtents: [22, 2, 60],
      rotation: [0, 0, 0, 1],
      collision: 'environment',
      color: '#e4d2a2',
    },
    {
      type: 'box',
      id: 'west-ledge',
      position: [-13, -6, 24],
      halfExtents: [3, 2, 14],
      rotation: [0, 0, 0, 1],
      collision: 'environment',
      color: '#ccbd91',
    },
    {
      type: 'sphere',
      id: 'coral-mound-east',
      position: [13, -7, 38],
      radius: 4,
      collision: 'environment',
      color: '#d58270',
    },
    {
      type: 'sphere',
      id: 'coral-mound-west',
      position: [-12, -7, 70],
      radius: 3,
      collision: 'environment',
      color: '#bd827f',
    },
    {
      type: 'sphere',
      id: 'urchin-outcrop',
      position: [8, -6, 75],
      radius: 1.2,
      collision: 'hazard',
      color: '#665d88',
    },
    {
      type: 'current',
      id: 'warm-current',
      position: [3, -4, 27],
      halfExtents: [6, 3, 9],
      velocity: [0.3, 0, 1.5],
      color: '#7ed9d1',
    },
    {
      type: 'rotating-gate',
      id: 'sway-beam',
      position: [-4, -4, 53],
      halfExtents: [4, 0.25, 0.25],
      axis: [0, 0, 1],
      phase: Math.PI / 4,
      angularSpeed: 0.45,
      color: '#dca660',
    },
  ],
} satisfies CourseDefinition;

export default sunlitShoals;
