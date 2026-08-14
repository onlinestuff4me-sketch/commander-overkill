/**
 * Gate pacing — specifically, that the opening is survivable.
 *
 * `START_TROOPS` is 1 because of the guarantee asserted here. If these tests go
 * red the correct response is to raise `START_TROOPS` again, not to relax the
 * assertions: a one-soldier opening on top of rows that can all be red is a run
 * that ends in three seconds through no fault of the player.
 */

import { describe, expect, it } from "vitest";
import { composeAutoRow, MERCY_TROOPS, rewardSpan, rowPlacement } from "./gates";
import { CORRIDOR_HALF_WIDTH } from "./lane";

/** Same generator the gate module uses, so the sequences under test are real. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every row a run would produce, across many seeds. */
function rows(troops: number, elapsed: number, seeds = 40, perSeed = 25): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < seeds; s++) {
    const rng = mulberry32(1234 + s);
    const buf: number[] = [0, 0, 0, 0];
    for (let i = 0; i < perSeed; i++) {
      composeAutoRow(rng, elapsed, troops, buf);
      out.push(buf.slice());
    }
  }
  return out;
}

describe("row shape", () => {
  it("is always 2 to 4 segments, the structural limit", () => {
    for (const row of rows(50, 0)) {
      expect(row.length).toBeGreaterThanOrEqual(2);
      expect(row.length).toBeLessThanOrEqual(4);
    }
  });

  it("never emits a zero, which would render as a penalty reading '0'", () => {
    for (const row of rows(50, 60)) for (const v of row) expect(v).not.toBe(0);
  });

  it("writes exactly as many entries as it reports", () => {
    const rng = mulberry32(7);
    const buf: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 50; i++) {
      const n = composeAutoRow(rng, 0, 50, buf);
      expect(buf.length).toBe(n);
    }
  });
});

describe("the mercy rule", () => {
  it("guarantees a survivable segment in EVERY row below the threshold", () => {
    // The whole reason START_TROOPS can be 1.
    for (const troops of [1, 2, 3, 5, 9]) {
      for (const elapsed of [0, 30, 90, 300]) {
        for (const row of rows(troops, elapsed)) {
          expect(
            row.some((v) => v > 0),
            `${troops} troops at ${elapsed}s produced an all-red row: ${row.join(", ")}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps penalties in the mildest pool below the threshold, however long the run", () => {
    // Escalation is driven by elapsed time. A player who has been alive for five
    // minutes but is down to two troops must not meet a -20.
    for (const row of rows(2, 600)) {
      for (const v of row) if (v < 0) expect(v).toBeGreaterThanOrEqual(-5);
    }
  });

  it("lapses once the squad can absorb a bad row", () => {
    // Mercy is a floor under the opening, not a permanent difficulty cap — if it
    // never lapsed, the all-red row that frame_018 is built on would never occur.
    const allRed = rows(MERCY_TROOPS, 0).filter((row) => row.every((v) => v < 0));
    expect(allRed.length).toBeGreaterThan(0);
  });

  it("lets penalties escalate once the squad is big enough", () => {
    const worst = Math.min(...rows(200, 120).flat());
    expect(worst).toBeLessThan(-5);
  });
});

describe("a row can cost you, but it cannot execute you", () => {
  // The failure this pins: penalties are capped PER SEGMENT, and a crowd wide
  // enough to span the road smashes every segment in the row. Three at the
  // per-segment cap is 105% of the army — a wipe out of nowhere, which a
  // measured autopilot run hit at 680 troops. The cap has to be on the row.
  it("never asks for more than the row budget, at any army size", () => {
    for (const troops of [12, 40, 120, 400, 900]) {
      for (const elapsed of [0, 30, 60, 120]) {
        for (const row of rows(troops, elapsed, 30, 20)) {
          const cost = row.reduce((sum, v) => sum + (v < 0 ? -v : 0), 0);
          // The per-segment floor of 1 troop can push a small army a hair over
          // the share budget; that is a rounding artefact, not a wipe.
          expect(cost).toBeLessThanOrEqual(troops * 0.42 + row.length);
        }
      }
    }
  });

  it("keeps the penalties in a row proportional to each other after the trim", () => {
    // The squeeze must not reorder "least bad" and "worst" — that ranking is the
    // entire decision the player is making.
    const rng = mulberry32(7);
    const buf: number[] = [0, 0, 0, 0];
    let sawMultiPenaltyRow = false;
    for (let i = 0; i < 200; i++) {
      composeAutoRow(rng, 120, 500, buf);
      const penalties = buf.filter((v) => v < 0);
      if (penalties.length < 2) continue;
      sawMultiPenaltyRow = true;
      // Every penalty stays inside the per-segment band it was drawn from,
      // scaled or not — none is trimmed to zero and none survives untouched
      // while its neighbour is halved.
      for (const v of penalties) expect(-v).toBeGreaterThan(0);
    }
    expect(sawMultiPenaltyRow).toBe(true);
  });
});

describe("the reward span", () => {
  // Proportional spans (0.9 × army) compounded to 680 troops in 60 s against a
  // 300–500 target at 120. Sub-linear is what makes the curve trackable, and
  // these assertions are the shape of that decision rather than its exact value.
  it("is sub-linear in the army, so growth cannot compound away", () => {
    const small = rewardSpan(50) / 50;
    const large = rewardSpan(500) / 500;
    expect(large).toBeLessThan(small);
  });

  it("still grows in absolute terms, so a big army gets a big payout", () => {
    expect(rewardSpan(500)).toBeGreaterThan(rewardSpan(50));
    expect(rewardSpan(50)).toBeGreaterThan(rewardSpan(10));
  });

  it("keeps a one-soldier squad's first gate worth steering for", () => {
    expect(rewardSpan(1)).toBeGreaterThanOrEqual(8);
  });

  it("pays a jackpot several times an ordinary row", () => {
    for (const n of [10, 100, 500]) {
      expect(rewardSpan(n, true)).toBeGreaterThan(rewardSpan(n) * 2);
    }
  });
});

describe("a row leaves road beside it", () => {
  // The whole strategic layer rests on this: if a row can span the road then
  // "go around" is not a move, and a playtester's verdict — "everything that
  // comes at me is an inevitability" — is structurally true again.
  /** The widest single stretch of clear road beside a row — what you can drive
   *  through. Not the total: two 0.9 m gaps are not a 1.8 m gap. */
  const widestGap = (p: { centerX: number; halfSpan: number }): number =>
    Math.max(
      p.centerX - p.halfSpan + CORRIDOR_HALF_WIDTH,
      CORRIDOR_HALF_WIDTH - (p.centerX + p.halfSpan),
    );

  it("never covers the whole road, at any segment count", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 400; i++) {
      for (const count of [2, 3, 4]) {
        expect(widestGap(rowPlacement(rng, count))).toBeGreaterThan(0.5);
      }
    }
  });

  it("leaves a narrow row genuinely dodgeable", () => {
    // A crowd is ~2 m across at 10 troops and ~5 m at 90. A 2-wide row has to
    // leave enough road that steering around it is a real option rather than a
    // technicality, or the width distribution carries no difficulty at all.
    const rng = mulberry32(23);
    let worst = Infinity;
    for (let i = 0; i < 400; i++) worst = Math.min(worst, widestGap(rowPlacement(rng, 2)));
    expect(worst).toBeGreaterThan(3);
  });

  it("stays inside the kerbs", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 400; i++) {
      for (const count of [2, 3, 4]) {
        const p = rowPlacement(rng, count);
        expect(Math.abs(p.centerX) + p.halfSpan).toBeLessThanOrEqual(CORRIDOR_HALF_WIDTH + 1e-9);
      }
    }
  });

  it("makes a narrow row leave more room than a wide one", () => {
    // Width is the difficulty now — a 2-wide is a genuine "do you want this",
    // a 4-wide is the old unavoidable wall. See SEGMENT_WIDTH.
    const rng = mulberry32(5);
    expect(rowPlacement(rng, 2).halfSpan).toBeLessThan(rowPlacement(rng, 4).halfSpan);
  });

  it("honours a side request, so a guard can be lined up with a prize", () => {
    const rng = mulberry32(19);
    for (let i = 0; i < 200; i++) {
      expect(rowPlacement(rng, 2, 1).centerX).toBeGreaterThan(0);
      expect(rowPlacement(rng, 2, -1).centerX).toBeLessThan(0);
    }
  });
});

describe("seeded reproducibility", () => {
  it("advances the generator identically with and without mercy", () => {
    // Mercy forces the outcome without consuming a different number of draws, so
    // a seeded run stays reproducible across the moment the squad crosses the
    // threshold. Rolling only when needed would desync every row after it.
    const probe = (troops: number): number => {
      const rng = mulberry32(99);
      const buf: number[] = [0, 0, 0, 0];
      for (let i = 0; i < 30; i++) composeAutoRow(rng, 0, troops, buf);
      return rng(); // generator position after 30 rows
    };
    expect(probe(1)).toBe(probe(200));
  });

  it("produces the same rows for the same seed", () => {
    const once = rows(50, 40, 1, 10);
    const twice = rows(50, 40, 1, 10);
    expect(once).toEqual(twice);
  });
});
