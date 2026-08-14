/**
 * CONTENT PACING — how hard the corridor is, as pure arithmetic.
 *
 * Nothing in here touches three.js or the scene, which is the point: it is the
 * one part of the difficulty curve that can be checked in plain Node, and the
 * numbers it produces are the ones a playtest complaint ("barrels are
 * unkillable", "barrels are pointless") actually lands on.
 *
 * Barrel hit points used to be `10 + rowIndex * 8` in main.ts — a placeholder
 * that scaled with the ROW and not with the squad, so it was simultaneously
 * impossible for a small army that had survived a while and irrelevant to a
 * large one. See `barrelHp` for what replaced it.
 */

import { damagePerPass } from "./bullets";
import type { BulletTuning } from "./bullets";
import type { WeaponTier } from "../core/types";

/**
 * AUTHORED difficulty ramp: what a barrel is worth being, ignoring who is
 * shooting it. Shaped to land near the reference's numerals — `frame_005` and
 * `frame_018` show 1, 10, 50 and 100 — so the face stays a one-to-three digit
 * number legible at arm's length, which is the whole reason it is painted on.
 */
export function barrelLadder(row: number): number {
  return Math.min(LADDER_MAX, 4 * Math.pow(Math.max(1, row), 1.5));
}

/**
 * Where the authored ramp stops climbing, reached around row 16 (~66 s in).
 *
 * Barrels are a speed bump, not the difficulty curve — the reference tops out
 * at a 100 on the face and lets a grown army delete it, putting the late-run
 * pressure on the gates instead. A ladder that kept climbing would also outgrow
 * the numeral: past 999 the face stops being readable at arm's length, which is
 * the one thing REFERENCE.md calls the most important rule for gate and barrel
 * text.
 */
const LADDER_MAX = 250;

/**
 * Numbers that look chosen rather than computed. 47 and 50 play identically;
 * only one of them looks authored, and the numeral is read at a glance.
 */
const NICE_STEPS: readonly number[] = [
  1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250,
];

/**
 * Largest authored-looking number not exceeding `v`, floored at 1.
 *
 * SNAPS DOWN, and that direction is load-bearing rather than cosmetic. Rounding
 * to the NEAREST step can land above the value it was given, and the value it is
 * given is the affordability cap in `barrelHp` — so snapping up would hand back
 * a barrel the squad demonstrably cannot kill, which is the exact failure this
 * whole curve exists to prevent.
 */
export function niceHp(v: number): number {
  let best = 1;
  for (const step of NICE_STEPS) {
    if (step > v) break;
    best = step;
  }
  return best;
}

/**
 * Fraction of ONE approach's damage a barrel may cost.
 *
 * Fire converges into a column (see `convergeDistance` in bullets.ts), so in
 * practice the squad's whole output goes into whichever barrel shares its lane.
 * At 0.55 you clear the one in front of you with room to spare and cannot also
 * clear its neighbours — which is what makes a barrel row a choice of lane
 * rather than a wall.
 */
export const BARREL_PASS_SHARE = 0.55;

/**
 * Hit points for a barrel spawning now.
 *
 * The ladder authors the intent; `damagePerPass` guarantees the result is
 * killable by the army that has to kill it. Taking the LOWER of the two is the
 * whole trick: a large army meets the authored number and melts it — the power
 * fantasy, and what the reference shows at `frame_035` — while a small army
 * meets a barrel scaled down to what it can actually chew through, instead of
 * one it can only watch go past.
 */
export function barrelHp(
  row: number,
  troops: number,
  tier: WeaponTier,
  tuning: BulletTuning,
  streamHalfWidth: number,
): number {
  const affordable =
    damagePerPass(tier, troops, tuning) * laneCoverage(streamHalfWidth) * BARREL_PASS_SHARE;
  return Math.max(1, niceHp(Math.min(barrelLadder(row), affordable)));
}

/** Half of a barrel's hittable face: BARREL_LENGTH/2 plus the collision pad the
 *  orchestrator tests with. Duplicated from entities/barrels.ts and main.ts
 *  rather than imported, because importing barrels.ts drags three.js into a
 *  module whose whole value is being runnable without it. */
const BARREL_HALF_FACE = 1.7 / 2 + 0.2;

/**
 * Share of the army's fire that lands on ONE barrel directly ahead of it.
 *
 * The fire is a parallel curtain as wide as the crowd, so a barrel is a 2.1 m
 * window cut out of a stream that can be over 5 m across — a big army spends
 * most of its output on whatever else is in the row, which is the point of
 * being wide and is exactly what the reference does.
 *
 * The crowd is a filled ellipse, so the sideways density of its muzzles follows
 * the semicircle law, √(1−(x/R)²), not a flat distribution — the middle lane is
 * denser than the flanks. Integrating that over the window gives the closed form
 * below. Measured against the browser probe (damage on a lane-centred barrel
 * ÷ total output): 0.69 at 20 troops against 0.79 predicted, 0.57 at 120
 * against 0.51. Within ~15%, in both directions, which is the accuracy the HP
 * curve needs — it decides whether a barrel is a speed bump or a wall, and both
 * of those survive a 15% error.
 */
export function laneCoverage(streamHalfWidth: number): number {
  const r = Math.max(1e-3, streamHalfWidth);
  const u = Math.min(1, BARREL_HALF_FACE / r);
  return (2 / Math.PI) * (Math.asin(u) + u * Math.sqrt(1 - u * u));
}

/**
 * Share of one approach's damage a single enemy is worth soaking.
 *
 * Enemies had FIXED hit points — 30 for an elite, 4 for a walker — chosen when
 * a big army did ~140 damage per pass. A 120-troop army now delivers thousands,
 * so every enemy died the instant it entered the 22 m bullet range, ~20 m from
 * the player. They never arrived, never threatened anything, and the whole
 * combat beat read as scenery dissolving at a distance.
 *
 * Scaling them off the same weapon model as barrels fixes that at every army
 * size at once. The shares look large next to `BARREL_PASS_SHARE` only because a
 * pack is eight bodies sharing one curtain: at 0.1 each, a full pack is 80% of
 * an approach's damage and therefore takes most of the approach to clear, which
 * is what lets a wave close the distance instead of evaporating at 20 m.
 */
export const WALKER_PASS_SHARE = 0.1;
export const ELITE_PASS_SHARE = 0.3;

/**
 * Hit points for one enemy, derived from what the army can actually deliver.
 *
 * Floored at 1 so a single soldier can still kill something, and floored again
 * at the old fixed values so early enemies never become weaker than they were —
 * this is meant to stop enemies evaporating, not to make the opening trivial.
 */
export function enemyHp(
  troops: number,
  tier: WeaponTier,
  tuning: BulletTuning,
  streamHalfWidth: number,
  share: number,
  floor: number,
): number {
  const perPass = damagePerPass(tier, troops, tuning) * laneCoverage(streamHalfWidth);
  return Math.max(floor, Math.round(perPass * share));
}

/**
 * Troops paid out for destroying a barrel worth `maxHp`.
 *
 * A barrel's numeral is its hit points, not its payout — paying it back 1:1
 * would make a 100-barrel worth more than every gate in the run combined. A
 * tenth keeps shooting cover worthwhile; the ceiling keeps it that way now that
 * HP climbs into the hundreds, because three late-run barrels at an uncapped
 * tenth would out-earn a whole row of gates and quietly turn a steering game
 * into a shooting gallery.
 */
export function barrelPayout(maxHp: number): number {
  const tenth = Math.round(maxHp * 0.1);
  return tenth < 1 ? 1 : tenth > 10 ? 10 : tenth;
}
