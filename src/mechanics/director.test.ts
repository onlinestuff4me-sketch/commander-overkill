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
  BEATS,
  DIRECTOR_GATE_SPACING,
  DIRECTOR_SPACING,
  DIRECTOR_SPACING_JITTER,
} from "./director";
import type { Placement } from "./director";

/** Run the corridor for `metres` and report where each placement landed. */
function run(
  metres: number,
  seed = 1,
  step = 0.1,
): { at: number; what: Placement; side: number }[] {
  const director = createDirector(seed);
  const out: { at: number; what: Placement; side: number }[] = [];
  for (let d = 0; d < metres; d += step) {
    const due = director.advance(step);
    if (due) out.push({ at: d, what: due.what, side: due.side });
  }
  return out;
}

/** Placements that put a decision on the road. Mirrors hasGate() in the module. */
function decides(what: Placement): boolean {
  return what === "gate" || what === "blockade" || what === "crossroads";
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

  it("keeps every gap at or above the floor, whatever the beat", () => {
    const lo = DIRECTOR_SPACING - DIRECTOR_SPACING_JITTER - 0.2;
    for (const g of gaps(run(6000, 7))) expect(g).toBeGreaterThan(lo);
  });

  it("gives two consecutive DECISIONS more room than a decision and scenery", () => {
    // 11 m between gates is 1.8 s to read the first, act, and read the second.
    // What needs separating is decisions, not objects.
    const placed = run(4000, 13);
    let gateGaps = 0;
    for (let i = 1; i < placed.length; i++) {
      // A blockade and a crossroads each contain a gate row, so they are
      // decisions for spacing purposes too — see hasGate() in director.ts.
      if (!decides(placed[i]!.what) || !decides(placed[i - 1]!.what)) continue;
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

  it("averages a sane spacing across the whole beat table", () => {
    const g = gaps(run(20000, 11));
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    // Above the base gap because of gate-to-gate pairs and beat trails, but
    // nowhere near the empty-road end — the corridor must still be busy.
    expect(mean).toBeGreaterThan(DIRECTOR_SPACING);
    expect(mean).toBeLessThan(DIRECTOR_GATE_SPACING + 8);
  });
});

describe("content mix", () => {
  it("opens on a placement rather than on empty road", () => {
    expect(run(50, 5)[0]!.at).toBeLessThan(0.2);
  });

  it("uses every beat over a long run", () => {
    // A beat that never fires is a beat that does not exist. Weights make some
    // rare, but none of them may be unreachable.
    const placed = run(20000, 2);
    expect(placed.length).toBeGreaterThan(100);
    const kinds = new Set(placed.map((p) => p.what));
    for (const beat of BEATS) {
      for (const place of beat.places) {
        expect(kinds.has(place), `${beat.name} places ${place}, never seen`).toBe(true);
      }
    }
  });

  it("gives the corridor a pulse — some stretches are much emptier", () => {
    // The whole point of beats over a metronome. `rest` contributes only road,
    // so the gap distribution must have a long tail rather than one cluster.
    const g = gaps(run(20000, 15)).sort((a, b) => a - b);
    const median = g[Math.floor(g.length / 2)]!;
    const longest = g[g.length - 1]!;
    expect(longest, `longest ${longest} vs median ${median}`).toBeGreaterThan(median * 1.8);
  });

  it("never leaves the player without a decision for long", () => {
    // Gates are the game. `surge` is the longest run of non-gates any beat
    // contains, and two of those cannot land back to back.
    let sinceGate = 0;
    for (const p of run(20000, 4)) {
      sinceGate = decides(p.what) ? 0 : sinceGate + 1;
      // DRY_LIMIT is 3, and the streak can reach 4 because the limit is only
      // checked when a new beat is picked — a beat already in flight finishes.
      // Measured worst case over 20 km of corridor is exactly 4.
      expect(sinceGate).toBeLessThanOrEqual(4);
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
    expect(director.advance(0)?.what).toBe(BEATS[0]!.places[0]);
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
