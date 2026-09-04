import type { InputFrame } from '../input/InputFrame';
import type {
  FishMotionResult,
  FishState,
  FishTuning,
  MotionEnvironment,
} from './fishTypes';

export type {
  FishMotionResult,
  FishState,
  FishTuning,
  MotionEnvironment,
} from './fishTypes';

const MAX_PITCH = Math.PI / 3;
const MAX_ROLL = Math.PI / 4;
const SURFACE_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampPositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampUnit(value: number): number {
  return clamp(value, -1, 1);
}

function wrapAngle(angle: number): number {
  const wrapped =
    (((angle + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return wrapped - Math.PI;
}

function approach(
  current: number,
  target: number,
  rate: number,
  dt: number,
): number {
  const alpha = 1 - Math.exp(-clampPositive(rate) * dt);
  return current + (target - current) * alpha;
}

function length(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

export function stepFishMotion(
  state: FishState,
  input: InputFrame,
  tuning: FishTuning,
  environment: MotionEnvironment,
  dt: number,
): FishMotionResult {
  const stepSeconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const nextPosition: [number, number, number] = [
    state.position[0],
    state.position[1],
    state.position[2],
  ];
  const nextVelocity: [number, number, number] = [
    state.velocity[0],
    state.velocity[1],
    state.velocity[2],
  ];
  const desiredDelta: [number, number, number] = [0, 0, 0];
  const events: Array<'dash' | 'breach' | 'splashdown'> = [];

  if (stepSeconds === 0) {
    return {
      next: {
        position: nextPosition,
        velocity: nextVelocity,
        yaw: state.yaw,
        pitch: state.pitch,
        roll: state.roll,
        dashEnergy: clamp(state.dashEnergy, 0, 1),
        isSubmerged: state.isSubmerged,
      },
      desiredDelta,
      events,
    };
  }

  const steerX = clampUnit(input.steerX);
  const steerY = clampUnit(input.steerY);
  const throttle = clampUnit(input.throttle);
  const surfaceY = environment.waterSurfaceY + tuning.surfaceY;
  const effectiveSubmerged =
    state.isSubmerged || state.position[1] <= surfaceY + SURFACE_EPSILON;
  const swimSpeed = clampPositive(
    length(state.velocity[0], state.velocity[1], state.velocity[2]),
  );
  const speedFactor = clamp(
    swimSpeed / Math.max(1, clampPositive(tuning.maxSpeed)),
    0,
    1,
  );

  const nextYaw = wrapAngle(
    state.yaw +
      steerX * tuning.turnRate * (0.5 + speedFactor * 0.5) * stepSeconds,
  );
  const targetPitch = steerY * MAX_PITCH;
  const nextPitch = clamp(
    approach(state.pitch, targetPitch, tuning.pitchRate, stepSeconds),
    -MAX_PITCH,
    MAX_PITCH,
  );
  const targetRoll = -steerX * speedFactor * MAX_ROLL;
  const nextRoll = clamp(
    approach(state.roll, targetRoll, tuning.turnRate, stepSeconds),
    -MAX_ROLL,
    MAX_ROLL,
  );

  const cosPitch = Math.cos(nextPitch);
  const forwardX = Math.sin(nextYaw) * cosPitch;
  const forwardY = Math.sin(nextPitch);
  const forwardZ = Math.cos(nextYaw) * cosPitch;

  const targetSpeed = effectiveSubmerged
    ? input.brakeHeld
      ? 0
      : throttle >= 0
        ? lerp(
            clampPositive(tuning.cruiseSpeed),
            clampPositive(tuning.maxSpeed),
            throttle,
          )
        : lerp(clampPositive(tuning.cruiseSpeed), 0, -throttle)
    : 0;
  const responseRate = input.brakeHeld
    ? (Math.abs(throttle) > 0 ? tuning.acceleration : tuning.drag) +
      tuning.brakeDrag
    : Math.abs(throttle) > 0
      ? tuning.acceleration
      : tuning.drag;

  const targetVelocityX = forwardX * targetSpeed;
  const targetVelocityY = forwardY * targetSpeed;
  const targetVelocityZ = forwardZ * targetSpeed;

  nextVelocity[0] = approach(
    nextVelocity[0],
    targetVelocityX,
    responseRate,
    stepSeconds,
  );
  nextVelocity[1] = approach(
    nextVelocity[1],
    targetVelocityY,
    responseRate,
    stepSeconds,
  );
  nextVelocity[2] = approach(
    nextVelocity[2],
    targetVelocityZ,
    responseRate,
    stepSeconds,
  );

  const dashEnergy = clamp(state.dashEnergy, 0, 1);
  let nextDashEnergy = dashEnergy;
  const canDash = input.dashPressed && dashEnergy >= tuning.dashCost;
  if (canDash) {
    nextVelocity[0] += forwardX * tuning.dashImpulse;
    nextVelocity[1] += forwardY * tuning.dashImpulse;
    nextVelocity[2] += forwardZ * tuning.dashImpulse;
    nextDashEnergy = dashEnergy - tuning.dashCost;
    events.push('dash');
  } else {
    nextDashEnergy = clamp(
      dashEnergy + tuning.dashRechargePerSecond * stepSeconds,
      0,
      1,
    );
  }

  const maxSpeed = clampPositive(tuning.maxSpeed);
  const nextSpeed = length(nextVelocity[0], nextVelocity[1], nextVelocity[2]);
  if (nextSpeed > maxSpeed && nextSpeed > 0) {
    const scale = maxSpeed / nextSpeed;
    nextVelocity[0] *= scale;
    nextVelocity[1] *= scale;
    nextVelocity[2] *= scale;
  }

  let worldVelocityX = nextVelocity[0];
  let worldVelocityY = nextVelocity[1];
  let worldVelocityZ = nextVelocity[2];

  if (effectiveSubmerged) {
    worldVelocityX += environment.current[0];
    worldVelocityY += environment.current[1];
    worldVelocityZ += environment.current[2];
  } else {
    nextVelocity[1] -= tuning.breachGravity * stepSeconds;
    worldVelocityY = nextVelocity[1];
  }

  desiredDelta[0] = worldVelocityX * stepSeconds;
  desiredDelta[1] = worldVelocityY * stepSeconds;
  desiredDelta[2] = worldVelocityZ * stepSeconds;

  nextPosition[0] = state.position[0] + desiredDelta[0];
  nextPosition[1] = state.position[1] + desiredDelta[1];
  nextPosition[2] = state.position[2] + desiredDelta[2];

  const crossedUpward =
    effectiveSubmerged &&
    state.position[1] <= surfaceY + SURFACE_EPSILON &&
    nextPosition[1] > surfaceY + SURFACE_EPSILON &&
    worldVelocityY > 0;
  const crossedDownward =
    !effectiveSubmerged &&
    state.position[1] >= surfaceY - SURFACE_EPSILON &&
    nextPosition[1] < surfaceY - SURFACE_EPSILON &&
    worldVelocityY < 0;

  let nextIsSubmerged = effectiveSubmerged;
  if (nextPosition[1] > surfaceY + SURFACE_EPSILON) {
    nextIsSubmerged = false;
  } else if (nextPosition[1] < surfaceY - SURFACE_EPSILON) {
    nextIsSubmerged = true;
  }

  if (crossedUpward) {
    events.push('breach');
  } else if (crossedDownward) {
    events.push('splashdown');
  }

  return {
    next: {
      position: nextPosition,
      velocity: nextVelocity,
      yaw: nextYaw,
      pitch: nextPitch,
      roll: nextRoll,
      dashEnergy: nextDashEnergy,
      isSubmerged: nextIsSubmerged,
    },
    desiredDelta,
    events,
  };
}
