/**
 * Gate pacing — specifically, that the opening is survivable.
 *
 * `START_TROOPS` is 1 because of the guarantee asserted here. If these tests go
 * red the correct response is to raise `START_TROOPS` again, not to relax the
 * assertions: a one-soldier opening on top of rows that can all be red is a run
 * that ends in three seconds through no fault of the player.
 */

import { describe, expect, it } from "vitest";
import { composeAutoRow, MERCY_TROOPS } from "./gates";

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
