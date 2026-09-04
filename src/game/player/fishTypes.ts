export interface FishState {
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  roll: number;
  dashEnergy: number;
  isSubmerged: boolean;
}

export interface FishTuning {
  cruiseSpeed: number;
  maxSpeed: number;
  acceleration: number;
  turnRate: number;
  pitchRate: number;
  drag: number;
  brakeDrag: number;
  dashImpulse: number;
  dashCost: number;
  dashRechargePerSecond: number;
  surfaceY: number;
  breachGravity: number;
}

export interface MotionEnvironment {
  current: [number, number, number];
  waterSurfaceY: number;
}

export interface FishMotionResult {
  next: FishState;
  desiredDelta: [number, number, number];
  events: Array<'dash' | 'breach' | 'splashdown'>;
}
