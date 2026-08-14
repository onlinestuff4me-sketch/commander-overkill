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
  /**
   * Half-width of the squad blob in world units. Owned by the squad system.
   *
   * On the contract because a gate row has to know how much of the road the
   * crowd actually covers: a 5 m wide army straddles two or three segments of a
   * 6.8 m barrier, and resolving only the one under its centre was silently
   * throwing away most of what the player just drove through.
   */
  squadHalfWidth: number;
  /** Metres/second the world slides toward the camera. Owned by the game. */
  scrollSpeed: number;
  /** Seconds since the run began. Owned by the game. */
  elapsed: number;
  /** Owned by the game; bullets read it to pick tracer style. */
  weaponTier: WeaponTier;
  /** Squad health, 0..1. Owned by the game; drives the green bar. */
  health: number;
  /**
   * How many troops are carrying a MINIGUN and a ROCKET LAUNCHER.
   *
   * Counts, not multipliers, and that is the point. `firepower` and `fireRate`
   * below are still the numbers the weapon model runs on, but they are DERIVED
   * from these now — because a multiplier is a thing you read in a chip and a
   * count is a thing you can see. Ten rocketeers means ten soldiers in the crowd
   * carrying tubes and ten streams firing rockets; that is what a pickup is
   * supposed to buy.
   *
   * Owned by the game, never allowed to exceed `troops`, and disjoint from each
   * other and from `elites` — the squad hands out one special job per soldier.
   */
  gunners: number;
  rocketeers: number;
  /**
   * Damage multiplier on every round, from collected weapon pickups. 1 at the
   * start of a run.
   *
   * THE QUALITY AXIS. Crowd size is quantity and this is quality, and they are
   * separate on purpose: `tierFor(troops)` makes the weapon's LOOK a function of
   * how many troops you have, which meant there was no such thing as a big weak
   * army or a small elite one, and therefore nothing to balance. A rocket
   * pickup raises this; it is the only thing that does.
   *
   * Deliberately NOT fed into the barrel and enemy hit-point models. Those
   * derive from base damage, so an upgrade is a real advantage rather than
   * something the difficulty curve immediately eats.
   */
  firepower: number;
  /** Fire-rate multiplier from minigun pickups. Separate from `firepower`
   *  because more bullets and harder bullets should not look the same. */
  fireRate: number;
  /**
   * How many of the troops are ELITES — recruits pulled off a barrel, who are
   * bigger, gold, and shoot like several ordinary soldiers.
   *
   * A COUNT, NOT A SET OF SOLDIERS. Nothing tracks which specific body is an
   * elite; the squad simply paints this many of them, spread through the crowd.
   * That is what makes elites the last thing a red gate can take from you —
   * ordinary losses shrink the crowd around them and only bite here once
   * `troops` has fallen to the elite count itself. Investment survives; the
   * bodies around it are what get eaten.
   *
   * Owned by the game, and never allowed to exceed `troops`.
   */
  elites: number;
  /**
   * How far back the camera has stepped, as a multiple of its resting distance.
   * 1 at every troop count the crowd still fits on screen at. Owned by the game
   * (see core/zoom.ts); the squad reads it because the extra room the camera
   * buys is room the crowd is allowed to grow into.
   */
  zoom: number;
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
    squadHalfWidth: 0,
    // 9 m/s put barrels and gates past the player before there was time to
    // shoot them, so rewards went unearned — the decision arrived and left
    // before you could act on it. 6 stretches the approach from ~7s to ~11s.
    scrollSpeed: 6,
    elapsed: 0,
    weaponTier: 0,
    health: 1,
    firepower: 1,
    fireRate: 1,
    elites: 0,
    gunners: 0,
    rocketeers: 0,
    zoom: 1,
  };
}
