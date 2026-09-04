import type {
  Collider,
  ColliderDesc,
  InteractionGroups,
} from '@dimforge/rapier3d-compat';

const MEMBERSHIP_BITS = {
  player: 1 << 0,
  environment: 1 << 1,
  hazard: 1 << 2,
  checkpoint: 1 << 3,
  pearl: 1 << 4,
  dynamicObstacle: 1 << 5,
} as const;

const PLAYER_SOLID_FILTER =
  MEMBERSHIP_BITS.environment |
  MEMBERSHIP_BITS.hazard |
  MEMBERSHIP_BITS.dynamicObstacle;

const PLAYER_GAMEPLAY_FILTER =
  PLAYER_SOLID_FILTER | MEMBERSHIP_BITS.checkpoint | MEMBERSHIP_BITS.pearl;

const SENSOR_KINDS = new Set<GameplayCollisionKind>(['checkpoint', 'pearl']);

export type GameplayCollisionKind =
  | 'player'
  | 'environment'
  | 'hazard'
  | 'checkpoint'
  | 'pearl'
  | 'dynamicObstacle';

export function createInteractionGroups(
  membership: number,
  filter: number,
): InteractionGroups {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export function doCollisionGroupsInteract(
  left: InteractionGroups,
  right: InteractionGroups,
): boolean {
  return ((left >>> 16) & right) !== 0 && ((right >>> 16) & left) !== 0;
}

export const COLLISION_GROUPS: Record<
  GameplayCollisionKind,
  InteractionGroups
> = {
  player: createInteractionGroups(
    MEMBERSHIP_BITS.player,
    PLAYER_GAMEPLAY_FILTER,
  ),
  environment: createInteractionGroups(
    MEMBERSHIP_BITS.environment,
    MEMBERSHIP_BITS.player | MEMBERSHIP_BITS.dynamicObstacle,
  ),
  hazard: createInteractionGroups(
    MEMBERSHIP_BITS.hazard,
    MEMBERSHIP_BITS.player,
  ),
  checkpoint: createInteractionGroups(
    MEMBERSHIP_BITS.checkpoint,
    MEMBERSHIP_BITS.player,
  ),
  pearl: createInteractionGroups(MEMBERSHIP_BITS.pearl, MEMBERSHIP_BITS.player),
  dynamicObstacle: createInteractionGroups(
    MEMBERSHIP_BITS.dynamicObstacle,
    MEMBERSHIP_BITS.player |
      MEMBERSHIP_BITS.environment |
      MEMBERSHIP_BITS.dynamicObstacle,
  ),
};

export const PLAYER_MOVEMENT_QUERY_GROUPS = createInteractionGroups(
  MEMBERSHIP_BITS.player,
  PLAYER_SOLID_FILTER,
);

export const PLAYER_GAMEPLAY_QUERY_GROUPS = createInteractionGroups(
  MEMBERSHIP_BITS.player,
  PLAYER_GAMEPLAY_FILTER,
);

export function applyGameplayCollision<T extends ColliderDesc>(
  desc: T,
  kind: GameplayCollisionKind,
): T {
  desc.setCollisionGroups(COLLISION_GROUPS[kind]);
  desc.setSolverGroups(COLLISION_GROUPS[kind]);
  desc.setSensor(SENSOR_KINDS.has(kind));
  return desc;
}

export function getGameplayCollisionKind(
  colliderOrGroups: Pick<Collider, 'collisionGroups'> | InteractionGroups,
): GameplayCollisionKind | null {
  const groups =
    typeof colliderOrGroups === 'number'
      ? colliderOrGroups
      : colliderOrGroups.collisionGroups();
  const membership = (groups >>> 16) & 0xffff;

  switch (membership) {
    case MEMBERSHIP_BITS.player:
      return 'player';
    case MEMBERSHIP_BITS.environment:
      return 'environment';
    case MEMBERSHIP_BITS.hazard:
      return 'hazard';
    case MEMBERSHIP_BITS.checkpoint:
      return 'checkpoint';
    case MEMBERSHIP_BITS.pearl:
      return 'pearl';
    case MEMBERSHIP_BITS.dynamicObstacle:
      return 'dynamicObstacle';
    default:
      return null;
  }
}
