/**
 * THE COUNTER TABLE — what each weapon is worth against each kind of target.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The first three weapons were a STRAIGHT LINE. A minigun crew raised the whole
 * army's fire rate, a rocket crew raised the whole army's damage, and a
 * rocketeer was therefore just a rifleman who hit harder. Nothing on the road
 * cared which one you had picked up, so the upgrade card always had one right
 * answer — take the biggest number — and an upgrade path with one right answer
 * is a queue, not a decision.
 *
 * A counter table is the cheapest fix in the genre and every game in the Last
 * War family runs one (see docs/progression-research.md). It costs no new art
 * and no new content: the enemies already exist, they are simply worth different
 * amounts to different guns now.
 *
 * ---------------------------------------------------------------------------
 * Why it lives in core
 * ---------------------------------------------------------------------------
 * Both `entities/enemies.ts` and `entities/boss.ts` have to answer the same
 * question — "what was that round worth against me" — and an element module is
 * never allowed to import another element module. Core is the shared shelf.
 * The TARGET owns the lookup, not the shooter: bullets knows what it fired and
 * nothing else, which is why `weapon` rides on the bullet all the way to the
 * hit.
 *
 * ---------------------------------------------------------------------------
 * Why FLESH is a row of ones
 * ---------------------------------------------------------------------------
 * Barrels, gate panels and anything else that pays the economy are FLESH, and
 * FLESH is deliberately neutral to every weapon. Every hit-point number in this
 * project is DERIVED from `damagePerPass` — barrel toughness, enemy toughness,
 * the size of a gate's reward — and a weapon that hit barrels 40% harder would
 * silently rewrite all of it. The counters are a COMBAT layer; the economy is
 * not allowed to notice them.
 */

import type { WeaponKind } from "./types";
import {
  WEAPON_FLAMER,
  WEAPON_FREEZE,
  WEAPON_MINIGUN,
  WEAPON_RIFLE,
  WEAPON_ROCKET,
  WEAPON_SPLASH,
} from "./types";

/**
 * What a target is made of. Four classes, and four is the ceiling — a player
 * reading a plate at forty pixels while steering can hold three ideas, and the
 * fourth is "ordinary".
 */
export type ArmourClass = 0 | 1 | 2 | 3;
/** Barrels, panels, anything that is just a hit-point pool. Neutral to all. */
export const ARMOUR_FLESH = 0;
/** Plated and slow. Rockets open it; fire and bullets skid off. */
export const ARMOUR_ARMOURED = 1;
/** Many small bodies at once. Fire covers them all; a rocket kills one. */
export const ARMOUR_SWARM = 2;
/** One body moving quickly. Volume of fire catches it; a slow shell does not. */
export const ARMOUR_FAST = 3;

/**
 * Multipliers, indexed `[weapon][armour]`.
 *
 * The numbers are set by how much they need to change the ANSWER, not by any
 * simulation. A 3x is the smallest multiplier that makes a player who has the
 * right gun visibly finish a target sooner than one who does not; below about
 * 2x the difference disappears into how long the target was in the stream. The
 * penalties are harsher than the bonuses are generous (0.35 against 3) because a
 * weapon has to be a genuinely bad answer to something, or the optimal loadout
 * is one of everything and the composition question evaporates.
 *
 * FREEZE IS A ROW OF ONES ON PURPOSE. Its round is a third of a rifle round, and
 * multiplying a third by three would still be a rifle. What the weapon actually
 * does is CHILL — a speed multiplier that the enemies and the boss both read —
 * and a speed multiplier is not a damage term, so it cannot live in this table.
 * See `chill` in entities/enemies.ts and `CHILL_FLOOR` below.
 */
const TABLE: Readonly<Record<number, readonly [flesh: number, armoured: number, swarm: number, fast: number]>> = {
  [WEAPON_RIFLE]: [1, 1, 1, 1],
  [WEAPON_MINIGUN]: [1, 0.8, 1.4, 2],
  [WEAPON_ROCKET]: [1, 3, 0.35, 0.5],
  [WEAPON_FLAMER]: [1, 0.3, 5, 1.2],
  [WEAPON_FREEZE]: [1, 1, 1, 1],
  // THE BLAST, not the round. See WEAPON_SPLASH in core/types.ts for why it
  // needs a row of its own: `detonate()` applies it several times over, so
  // against a pack — one hit-point pool wearing eight bodies — an unpenalised
  // blast made rockets the best anti-swarm weapon in the game while the table
  // was busy saying they were the worst.
  [WEAPON_SPLASH]: [1, 2, 0.45, 0.4],
};

export function counterMultiplier(weapon: WeaponKind | number, armour: ArmourClass): number {
  const row = TABLE[weapon];
  if (row === undefined) return 1;
  return row[armour] ?? 1;
}

/**
 * The word that goes on a target's plate.
 *
 * The counter system is worthless if the player cannot see which class they are
 * looking at, and a plate is the only place this game has ever put a noun. FLESH
 * gets nothing — an ordinary target should not carry a label saying "ordinary".
 */
export function armourLabel(armour: ArmourClass): string {
  return armour === ARMOUR_ARMOURED
    ? "ARMOURED"
    : armour === ARMOUR_SWARM
      ? "SWARM"
      : armour === ARMOUR_FAST
        ? "FAST"
        : "";
}

/**
 * SLOWEST A CHILLED TARGET GETS, as a share of its own speed.
 *
 * Not zero. A freeze ray that stops something dead is a stun, and a stun on a
 * boss mid-charge is the player deleting an encounter rather than surviving one.
 * At 0.35 a charging boss still arrives — about three times slower, which is the
 * difference between "no time to react" and "time to get off the line".
 */
export const CHILL_FLOOR = 0.35;
/** Seconds a chill lasts with no further hits. Short: the ray is a stream, so
 *  holding something frozen has to mean holding the stream ON it. */
export const CHILL_TIME = 1.1;
/** Chill added per freeze round that connects. Two dozen rounds — about a third
 *  of a second of one freezer's fire — takes a target to the floor. */
export const CHILL_PER_HIT = 0.045;

/** Speed multiplier for a target carrying `chill` (0..1) of it. */
export function chillSpeed(chill: number): number {
  const c = chill < 0 ? 0 : chill > 1 ? 1 : chill;
  return 1 - (1 - CHILL_FLOOR) * c;
}
