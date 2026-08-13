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
): number {
  const affordable = damagePerPass(tier, troops, tuning) * BARREL_PASS_SHARE;
  return Math.max(1, niceHp(Math.min(barrelLadder(row), affordable)));
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
