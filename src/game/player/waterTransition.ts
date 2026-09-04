import type { FishState } from './fishTypes';

const SURFACE_EPSILON = 1e-6;
type WaterState = Pick<FishState, 'position' | 'isSubmerged'>;

export function isEffectivelySubmerged(
  state: WaterState,
  surfaceY: number,
): boolean {
  return state.isSubmerged || state.position[1] <= surfaceY + SURFACE_EPSILON;
}

export function resolveWaterTransition(
  state: WaterState,
  nextPosition: FishState['position'],
  surfaceY: number,
): { isSubmerged: boolean; event: 'breach' | 'splashdown' | null } {
  const wasSubmerged = isEffectivelySubmerged(state, surfaceY);
  const above = nextPosition[1] > surfaceY + SURFACE_EPSILON;
  const below = nextPosition[1] < surfaceY - SURFACE_EPSILON;
  const deltaY = nextPosition[1] - state.position[1];
  let event: 'breach' | 'splashdown' | null = null;

  if (
    wasSubmerged &&
    state.position[1] <= surfaceY + SURFACE_EPSILON &&
    above &&
    deltaY > 0
  ) {
    event = 'breach';
  } else if (
    !wasSubmerged &&
    state.position[1] >= surfaceY - SURFACE_EPSILON &&
    below &&
    deltaY < 0
  ) {
    event = 'splashdown';
  }

  return {
    isSubmerged: above ? false : below ? true : wasSubmerged,
    event,
  };
}
