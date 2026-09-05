import type { ChaseCameraTuning } from '../camera/ChaseCamera';
import type { FishTuning } from '../player/fishTypes';

export const PLAYER_RADIUS = 0.35;

export const SCENE_FISH_TUNING: Readonly<FishTuning> = Object.freeze({
  cruiseSpeed: 6,
  maxSpeed: 12,
  acceleration: 5,
  turnRate: 2.8,
  pitchRate: 5,
  drag: 4,
  brakeDrag: 8,
  dashImpulse: 6,
  dashCost: 0.35,
  dashRechargePerSecond: 0.16,
  surfaceY: 0,
  breachGravity: 9.8,
});

export const SCENE_CAMERA_TUNING: Readonly<ChaseCameraTuning> = Object.freeze({
  distance: 7,
  height: 2,
  positionHalfLife: 0.16,
  rotationHalfLife: 0.12,
  lookAheadSeconds: 0.2,
  minFov: 55,
  maxFov: 68,
  collisionRadius: 0.3,
});
