/**
 * The conductor's one promise: nothing ever lands on top of anything else.
 *
 * That promise is the entire reason this module exists, so it is asserted
 * directly against the metres of road between consecutive placements rather
 * than against any of the machinery that produces them.
 */

import { describe, expect, it } from "vitest";
import {
  createDirector,
  createRng,
  DIRECTOR_CYCLE,
  DIRECTOR_GATE_SPACING,
  DIRECTOR_SPACING,
  DIRECTOR_SPACING_JITTER,
} from "./director";
import type { Placement } from "./director";

/** Run the corridor for `metres` and report where each placement landed. */
function run(metres: number, seed = 1, step = 0.1): { at: number; what: Placement }[] {
  const director = createDirector(seed);
  const out: { at: number; what: Placement }[] = [];
  for (let d = 0; d < metres; d += step) {
    const due = director.advance(step);
    if (due) out.push({ at: d, what: due });
  }
  return out;
}

function gaps(placed: { at: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < placed.length; i++) out.push(placed[i]!.at - placed[i - 1]!.at);
  return out;
}

describe("spacing", () => {
  it("never places two things within the minimum gap, over a long run", () => {
    // The bug: 25.2 m and 16 m cadences coming back into phase and spawning on
    // the same plane. A gap of zero is exactly what must be impossible now.
    const floor = DIRECTOR_SPACING - DIRECTOR_SPACING_JITTER;
    for (let seed = 1; seed <= 25; seed++) {
      for (const g of gaps(run(3000, seed))) {
        // step granularity costs up to one step of precision
        expect(g, `seed ${seed}`).toBeGreaterThan(floor - 0.2);
      }
    }
  });

  it("keeps gaps inside the jitter band, so spacing stays authored", () => {
    const lo = DIRECTOR_SPACING - DIRECTOR_SPACING_JITTER - 0.2;
    const hi = DIRECTOR_GATE_SPACING + DIRECTOR_SPACING_JITTER + 0.2;
    for (const g of gaps(run(3000, 7))) {
      expect(g).toBeGreaterThan(lo);
      expect(g).toBeLessThan(hi);
    }
  });

  it("gives two consecutive DECISIONS more room than a decision and scenery", () => {
    // 11 m between gates is 1.8 s to read the first, act, and read the second.
    // What needs separating is decisions, not objects.
    const placed = run(4000, 13);
    let gateGaps = 0;
    for (let i = 1; i < placed.length; i++) {
      if (placed[i]!.what !== "gate" || placed[i - 1]!.what !== "gate") continue;
      gateGaps++;
      const g = placed[i]!.at - placed[i - 1]!.at;
      expect(g).toBeGreaterThan(DIRECTOR_GATE_SPACING - DIRECTOR_SPACING_JITTER - 0.2);
    }
    expect(gateGaps, "the cycle should actually contain back-to-back gates").toBeGreaterThan(10);
  });

  it("does not place on a metronome — the gaps actually vary", () => {
    // Perfectly even spacing is as much a tell as no spacing at all.
    const set = new Set(gaps(run(2000, 3)).map((g) => g.toFixed(1)));
    expect(set.size).toBeGreaterThan(5);
  });

  it("averages the spacing the cycle actually asks for", () => {
    // Derived from the cycle rather than hardcoded, so reordering CYCLE or
    // changing either spacing keeps this honest instead of needing a new magic
    // number. Gate-to-gate pairs pull the mean above the base spacing.
    let want = 0;
    for (let i = 0; i < DIRECTOR_CYCLE.length; i++) {
      const from = DIRECTOR_CYCLE[i]!;
      const to = DIRECTOR_CYCLE[(i + 1) % DIRECTOR_CYCLE.length]!;
      want += from === "gate" && to === "gate" ? DIRECTOR_GATE_SPACING : DIRECTOR_SPACING;
    }
    want /= DIRECTOR_CYCLE.length;

    const g = gaps(run(8000, 11));
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    expect(Math.abs(mean - want), `mean ${mean.toFixed(2)} vs ${want.toFixed(2)}`).toBeLessThan(
      0.4,
    );
  });
});

describe("content mix", () => {
  it("opens on a placement rather than on empty road", () => {
    expect(run(50, 5)[0]!.at).toBeLessThan(0.2);
  });

  it("holds the cycle's ratios over a long run", () => {
    const placed = run(5000, 2);
    const counts: Record<string, number> = {};
    for (const p of placed) counts[p.what] = (counts[p.what] ?? 0) + 1;

    const expected: Record<string, number> = {};
    for (const c of DIRECTOR_CYCLE) expected[c] = (expected[c] ?? 0) + 1;

    for (const kind of Object.keys(expected)) {
      const share = counts[kind]! / placed.length;
      const want = expected[kind]! / DIRECTOR_CYCLE.length;
      expect(Math.abs(share - want), `${kind} share ${share.toFixed(3)} vs ${want}`).toBeLessThan(
        0.02,
      );
    }
  });

  it("never leaves the player without a decision for long", () => {
    // Gates are the game. Two non-gate placements in a row is the most the
    // cycle permits; three would be a stretch of road with nothing to decide.
    let sinceGate = 0;
    for (const p of run(4000, 4)) {
      sinceGate = p.what === "gate" ? 0 : sinceGate + 1;
      expect(sinceGate).toBeLessThanOrEqual(2);
    }
  });
});

describe("determinism", () => {
  it("gives the same corridor for the same seed", () => {
    expect(run(1200, 42)).toEqual(run(1200, 42));
  });

  it("gives a different corridor for a different seed", () => {
    expect(run(1200, 42)).not.toEqual(run(1200, 43));
  });

  it("resets to the start of the cycle", () => {
    const director = createDirector(9);
    for (let i = 0; i < 500; i++) director.advance(0.5);
    expect(director.count).toBeGreaterThan(0);
    director.reset();
    expect(director.count).toBe(0);
    expect(director.advance(0)).toBe(DIRECTOR_CYCLE[0]);
  });
});

describe("advance", () => {
  it("places at most one thing per call, however far the world jumps", () => {
    // A resumed tab must not empty the whole cycle onto one plane.
    const director = createDirector(6);
    expect(director.advance(10_000)).not.toBeNull();
    expect(director.count).toBe(1);
  });

  it("reports how far the next placement is", () => {
    const director = createDirector(8);
    director.advance(0); // consume the immediate opening placement
    const before = director.untilNext;
    expect(before).toBeGreaterThan(0);
    director.advance(before / 2);
    expect(director.untilNext).toBeCloseTo(before / 2, 6);
  });
});

describe("createRng", () => {
  it("is reproducible and stays in [0, 1)", () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 500; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
