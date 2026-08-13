/**
 * The weapon model and the barrel curve it feeds.
 *
 * The point of these is not that the arithmetic is hard — it is that the
 * arithmetic is CALIBRATED. `damagePerPass` claims to predict what a barrel
 * really loses on one approach, and that claim was established by driving the
 * actual game in a browser (`__overkill.damageCurve()`), not by algebra. The
 * measured table is pinned here so a later change to a fire rate, the bullet
 * range or the scroll speed fails loudly instead of silently invalidating every
 * barrel in the game — which is exactly how the placeholder curve survived as
 * long as it did.
 */

import { describe, expect, it } from "vitest";
import {
  damagePerPass,
  liveBullets,
  totalShotsPerSecond,
  EFFECTIVE_PASS_SECONDS,
} from "./bullets";
import type { BulletTuning } from "./bullets";
import {
  barrelHp,
  barrelLadder,
  barrelPayout,
  laneCoverage,
  niceHp,
  BARREL_PASS_SHARE,
} from "./pacing";
import type { WeaponTier } from "../core/types";

/** Mirrors main.ts's `tierFor`. Kept local so the table below is self-contained. */
function tierFor(troops: number): WeaponTier {
  if (troops < 4) return 0;
  if (troops < 40) return 1;
  return 2;
}

/**
 * The shipped defaults, reconstructed. `createBullets` needs a WebGL context and
 * a DOM, neither of which exists in Node, so the tuning is restated rather than
 * read off a live system — only the fields the rate model actually touches.
 */
const TUNING: BulletTuning = {
  tier0RatePerShooter: 5,
  tier1RatePerShooter: 7,
  tier2RatePerShooter: 5,
  maxLiveBullets: 620,
  saturationKnee: 3,
  maxStreams: 96,
  tracerSpeed: 44,
  dartSpeed: 34,
  speedJitter: 0.14,
  range: 22,
  tracerLength: 0.28,
  tracerWidth: 0.055,
  dartLength: 0.47,
  dartWidth: 0.18,
  tier01Spread: 0.012,
  tier2Spread: 0.03,
  shotJitterFraction: 0.25,
  convergeDistance: 0,
  convergeMaxAngle: 0.209,
  riseJitter: 0.5,
  muzzleY: 1.0,
  muzzleRateCap: 220,
  muzzleLength: 0.5,
  muzzleWidth: 0.22,
  muzzleLife: 0.09,
  impactSize: 0.95,
  impactLife: 0.18,
  fadeTime: 0.1,
  hotBoost: 0.5,
  hotTime: 0.05,
  brightness: 1,
  tracerDamage: 1,
  dartDamage: 2,
};

/**
 * MEASURED IN A REAL BROWSER, not computed. `__overkill.damageCurve()` spawns a
 * barrel with effectively infinite hit points, runs the real update order for a
 * full approach and reports what it lost. If you change the weapon model,
 * re-measure and update this table — do not adjust the tolerance.
 *
 * These were re-taken after tier 2 went to half rate and double damage, and the
 * model predicted the new tier 2 figures to better than 1% before they were
 * measured (2112 vs 2116 at 50 troops, 4740 vs 4782 at 120). That is the reason
 * to trust it as a model rather than as a curve fitted to eleven points.
 */
const MEASURED: readonly (readonly [troops: number, damage: number])[] = [
  [1, 22],
  [2, 42],
  [3, 65],
  [5, 150],
  [8, 242],
  [12, 355],
  [20, 584],
  [30, 857],
  [50, 2116],
  [80, 3352],
  [120, 4782],
];

/**
 * Squad half-width at a given troop count, MEASURED off the running game
 * (`__overkill.stats().radiusX`) rather than re-deriving the squad's spiral
 * here. Interpolated between samples; flat past the cap, which is where the
 * crowd stops widening and starts only deepening.
 */
const HALF_WIDTH: readonly (readonly [troops: number, halfWidth: number])[] = [
  [1, 1.12],
  [8, 1.09],
  [20, 1.71],
  [40, 1.82],
  [80, 2.55],
  [120, 2.57],
  [1200, 2.57],
];

function halfWidthFor(troops: number): number {
  let prev = HALF_WIDTH[0]!;
  for (const point of HALF_WIDTH) {
    if (troops <= point[0]) {
      if (point === prev) return point[1];
      const t = (troops - prev[0]) / (point[0] - prev[0]);
      return prev[1] + (point[1] - prev[1]) * t;
    }
    prev = point;
  }
  return prev[1];
}

describe("shot rate", () => {
  it("is zero with nobody left to fire", () => {
    expect(totalShotsPerSecond(0, 0, TUNING)).toBe(0);
  });

  it("is one stream per soldier before the governor bites", () => {
    expect(totalShotsPerSecond(0, 1, TUNING)).toBeCloseTo(5, 2);
    expect(totalShotsPerSecond(1, 10, TUNING)).toBeCloseTo(70, 0);
  });

  it("never falls as the army grows", () => {
    // The soft clip's whole justification is that it is strictly increasing —
    // "more troops is always more bullets" is a promise to the player, not an
    // implementation detail.
    let prev = -1;
    for (let n = 1; n <= 1200; n += 7) {
      const total = totalShotsPerSecond(2, n, TUNING);
      expect(total).toBeGreaterThan(prev);
      prev = total;
    }
  });

  it("holds the live population under the pool at any troop count", () => {
    for (const tier of [0, 1, 2] as const) {
      expect(liveBullets(tier, 1200, TUNING)).toBeLessThanOrEqual(TUNING.maxLiveBullets);
    }
  });
});

describe("damagePerPass", () => {
  it("reproduces the browser-measured curve where the whole curtain lands", () => {
    // Only the counts whose stream is narrower than a barrel face, because
    // `damagePerPass` is now TOTAL output and only those put all of it on one
    // target. The wider counts are covered by the `laneCoverage` suite below.
    for (const [troops, measured] of MEASURED) {
      if (laneCoverage(halfWidthFor(troops)) < 0.99) continue;
      const predicted = damagePerPass(tierFor(troops), troops, TUNING);
      const error = Math.abs(predicted - measured) / measured;
      expect(
        error,
        `${troops} troops: predicted ${predicted.toFixed(0)}, measured ${measured}`,
      ).toBeLessThan(0.1);
    }
  });

  it("tracks the per-bullet damage, so raising damage raises the curve", () => {
    // The lever the handoff calls for: more damage without more rounds on
    // screen. If this ever stops holding, barrel HP silently decouples.
    const hotter: BulletTuning = { ...TUNING, tracerDamage: 2 };
    expect(damagePerPass(1, 20, hotter)).toBeCloseTo(damagePerPass(1, 20, TUNING) * 2, 5);
  });

  it("is the shot rate times damage times the measured window", () => {
    expect(damagePerPass(1, 20, TUNING)).toBeCloseTo(
      totalShotsPerSecond(1, 20, TUNING) * TUNING.tracerDamage * EFFECTIVE_PASS_SECONDS,
      5,
    );
  });
});

describe("barrel hit points", () => {
  it("is always killable in one pass by the army that meets it", () => {
    // The bug this replaces: hp scaled with the row, so a small squad that had
    // survived a while met barrels it could not dent.
    for (let row = 1; row <= 40; row++) {
      for (const troops of [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 400, 1200]) {
        const hp = barrelHp(row, troops, tierFor(troops), TUNING, halfWidthFor(troops));
        const pass = damagePerPass(tierFor(troops), troops, TUNING);
        expect(hp, `row ${row} at ${troops} troops`).toBeLessThanOrEqual(pass);
      }
    }
  });

  it("leaves headroom rather than consuming the whole pass", () => {
    // A barrel that costs the entire approach leaves nothing for the enemies
    // standing behind it, and nothing for its neighbours in the row.
    for (const troops of [8, 20, 50, 120]) {
      const hp = barrelHp(30, troops, tierFor(troops), TUNING, halfWidthFor(troops));
      const pass = damagePerPass(tierFor(troops), troops, TUNING);
      expect(hp / pass).toBeLessThanOrEqual(BARREL_PASS_SHARE + 0.01);
    }
  });

  it("gets harder as the run goes on, at a fixed army size", () => {
    let prev = 0;
    for (let row = 1; row <= 12; row++) {
      const hp = barrelHp(row, 400, tierFor(400), TUNING, halfWidthFor(400));
      expect(hp).toBeGreaterThanOrEqual(prev);
      prev = hp;
    }
    expect(prev).toBeGreaterThan(barrelHp(1, 400, tierFor(400), TUNING, halfWidthFor(400)));
  });

  it("never asks a single soldier for more than a single soldier can do", () => {
    // START_TROOPS is 1. This is the opening beat, and it has to be winnable.
    const hp = barrelHp(1, 1, 0, TUNING, halfWidthFor(1));
    expect(hp).toBeGreaterThan(0);
    expect(hp).toBeLessThanOrEqual(damagePerPass(0, 1, TUNING) * BARREL_PASS_SHARE + 1);
  });

  it("always paints a readable numeral", () => {
    for (let row = 1; row <= 60; row++) {
      const hp = barrelHp(row, 1200, tierFor(1200), TUNING, halfWidthFor(1200));
      expect(String(hp).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("laneCoverage", () => {
  it("puts everything on target when the crowd is narrower than a barrel", () => {
    expect(laneCoverage(0.4)).toBe(1);
    expect(laneCoverage(1.0)).toBe(1);
  });

  it("falls as the crowd widens, because the curtain widens with it", () => {
    let prev = Infinity;
    for (let r = 1.05; r < 6; r += 0.1) {
      const c = laneCoverage(r);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it("is never more than all of the fire, nor less than none", () => {
    for (let r = 0.01; r < 20; r += 0.13) {
      const c = laneCoverage(r);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("matches the browser probe within 12% at the counts it was measured at", () => {
    // Probe: damage on a lane-centred barrel / total output, against the squad
    // half-width measured at the same count.
    //   20 troops   413 / 595  = 0.69   model 0.73   +6%
    //   120 troops 2036 / 3550 = 0.57   model 0.51  -12%
    // It errs in both directions, which is what a model does and a fit does not.
    for (const [troops, measured] of [
      [20, 0.69],
      [120, 0.57],
    ] as const) {
      const model = laneCoverage(halfWidthFor(troops));
      const error = Math.abs(model - measured) / measured;
      expect(error, `${troops} troops: model ${model.toFixed(3)} vs ${measured}`).toBeLessThan(
        0.12,
      );
    }
  });
});

describe("niceHp", () => {
  it("snaps down to an authored-looking number", () => {
    expect(niceHp(47)).toBe(40);
    expect(niceHp(6.6)).toBe(5);
    expect(niceHp(1)).toBe(1);
    expect(niceHp(94)).toBe(75);
    expect(niceHp(100)).toBe(100);
  });

  it("is monotonic, so a harder row never paints a smaller number", () => {
    let prev = 0;
    for (let v = 0.5; v < 400; v += 0.5) {
      const snapped = niceHp(v);
      expect(snapped).toBeGreaterThanOrEqual(prev);
      prev = snapped;
    }
  });

  it("NEVER exceeds the value it was given", () => {
    // This is the property that keeps the affordability cap in `barrelHp` real.
    // Snapping up would hand back a barrel the squad cannot kill.
    for (let v = 1; v < 400; v += 0.5) expect(niceHp(v)).toBeLessThanOrEqual(v);
  });

  it("floors at 1 rather than returning nothing", () => {
    expect(niceHp(0)).toBe(1);
    expect(niceHp(0.4)).toBe(1);
  });
});

describe("barrelLadder", () => {
  it("lands near the reference's numerals over the first rows", () => {
    // frame_005 / frame_018 show 1, 10, 50, 100 on barrel faces.
    expect(niceHp(barrelLadder(1))).toBeLessThanOrEqual(5);
    expect(niceHp(barrelLadder(3))).toBeLessThanOrEqual(25);
    expect(niceHp(barrelLadder(8))).toBeLessThanOrEqual(100);
  });

  it("stops climbing, so the numeral stays readable however long the run is", () => {
    expect(barrelLadder(10_000)).toBe(barrelLadder(1000));
    expect(String(niceHp(barrelLadder(10_000))).length).toBeLessThanOrEqual(3);
  });
});

describe("barrelPayout", () => {
  it("pays at least one troop, so a kill is never worthless", () => {
    expect(barrelPayout(1)).toBe(1);
    expect(barrelPayout(4)).toBe(1);
  });

  it("is capped so late barrels cannot out-earn the gates", () => {
    expect(barrelPayout(250)).toBe(10);
    expect(barrelPayout(10_000)).toBe(10);
  });

  it("is a tenth in between", () => {
    expect(barrelPayout(50)).toBe(5);
    expect(barrelPayout(100)).toBe(10);
  });
});
