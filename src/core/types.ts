/**
 * SHARED CONTRACT.
 *
 * Every element module (squad, bullets, gates, barrels, growth VFX) reads this
 * and nothing else about the rest of the game. That constraint is what lets
 * five of them be built in parallel and then dropped into one scene without a
 * merge argument — and it is the same seam the Unity port will cut along.
 */

import type * as THREE from "three";

/** Hard ceiling on player units alive at once. Sizes every InstancedMesh. */
export const MAX_TROOPS = 1200;

/** Weapon tiers observed in the reference: orange tracers → dense cyan darts. */
export type WeaponTier = 0 | 1 | 2;

/**
 * The mutable world every system reads each tick. Systems MUST NOT write to
 * fields they do not own — ownership is noted per field.
 */
export interface WorldState {
  /** Logical troop count. Owned by the game; squad renders to match. */
  troops: number;
  /** Steering target, normalised [-1, 1]. Owned by input. */
  squadLane: number;
  /** World-space centre of the squad blob. Owned by the squad system. */
  squadCenter: THREE.Vector3;
  /** Metres/second the world slides toward the camera. Owned by the game. */
  scrollSpeed: number;
  /** Seconds since the run began. Owned by the game. */
  elapsed: number;
  /** Owned by the game; bullets read it to pick tracer style. */
  weaponTier: WeaponTier;
  /** Squad health, 0..1. Owned by the game; drives the green bar. */
  health: number;
}

/**
 * A drop-in element. `update` runs at a fixed 60Hz; `render` runs once per
 * frame with `alpha` as the interpolation factor between the last two ticks.
 * Keep all randomness and state mutation in `update` so the sim stays
 * reproducible — `render` must be safe to call twice with the same alpha.
 */
export interface System {
  update(dt: number, world: WorldState): void;
  render(alpha: number, world: WorldState): void;
  /** Release GPU resources. Called on teardown; must be idempotent. */
  dispose?(): void;
}

export function createWorld(center: THREE.Vector3): WorldState {
  return {
    troops: 1,
    squadLane: 0,
    squadCenter: center,
    scrollSpeed: 9,
    elapsed: 0,
    weaponTier: 0,
    health: 1,
  };
}
