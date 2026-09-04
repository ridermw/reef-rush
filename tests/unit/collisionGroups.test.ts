import * as RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import {
  COLLISION_GROUPS,
  PLAYER_GAMEPLAY_QUERY_GROUPS,
  PLAYER_MOVEMENT_QUERY_GROUPS,
  applyGameplayCollision,
  getGameplayCollisionKind,
} from '../../src/game/physics/collisionGroups';

function groupsInteract(a: number, b: number): boolean {
  return ((a >>> 16) & b) !== 0 && ((b >>> 16) & a) !== 0;
}

function createDecorativeGroups(): number {
  const decorationLayer = 1 << 10;
  return (decorationLayer << 16) | decorationLayer;
}

describe('collision groups', () => {
  it('lets player movement casts see solid gameplay blockers only', () => {
    expect(
      groupsInteract(
        PLAYER_MOVEMENT_QUERY_GROUPS,
        COLLISION_GROUPS.environment,
      ),
    ).toBe(true);
    expect(
      groupsInteract(PLAYER_MOVEMENT_QUERY_GROUPS, COLLISION_GROUPS.hazard),
    ).toBe(true);
    expect(
      groupsInteract(
        PLAYER_MOVEMENT_QUERY_GROUPS,
        COLLISION_GROUPS.dynamicObstacle,
      ),
    ).toBe(true);
    expect(
      groupsInteract(PLAYER_MOVEMENT_QUERY_GROUPS, COLLISION_GROUPS.checkpoint),
    ).toBe(false);
    expect(
      groupsInteract(PLAYER_MOVEMENT_QUERY_GROUPS, COLLISION_GROUPS.pearl),
    ).toBe(false);
  });

  it('marks checkpoints and pearls as sensors while leaving hazards solid', () => {
    const checkpoint = applyGameplayCollision(
      RAPIER.ColliderDesc.ball(1),
      'checkpoint',
    );
    const pearl = applyGameplayCollision(RAPIER.ColliderDesc.ball(1), 'pearl');
    const hazard = applyGameplayCollision(
      RAPIER.ColliderDesc.ball(1),
      'hazard',
    );

    expect(checkpoint.isSensor).toBe(true);
    expect(pearl.isSensor).toBe(true);
    expect(hazard.isSensor).toBe(false);
  });

  it('keeps decorative colliders out of gameplay queries', () => {
    expect(
      groupsInteract(PLAYER_GAMEPLAY_QUERY_GROUPS, createDecorativeGroups()),
    ).toBe(false);
  });

  it('round-trips gameplay collision kinds from collider groups', () => {
    expect(getGameplayCollisionKind(COLLISION_GROUPS.player)).toBe('player');
    expect(getGameplayCollisionKind(COLLISION_GROUPS.environment)).toBe(
      'environment',
    );
    expect(getGameplayCollisionKind(COLLISION_GROUPS.hazard)).toBe('hazard');
    expect(getGameplayCollisionKind(COLLISION_GROUPS.checkpoint)).toBe(
      'checkpoint',
    );
    expect(getGameplayCollisionKind(COLLISION_GROUPS.pearl)).toBe('pearl');
    expect(getGameplayCollisionKind(COLLISION_GROUPS.dynamicObstacle)).toBe(
      'dynamicObstacle',
    );
  });
});
