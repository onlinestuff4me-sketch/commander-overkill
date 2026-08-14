/**
 * THE CONDUCTOR — the one thing that decides what enters the corridor, and when.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to kill
 * ---------------------------------------------------------------------------
 * There used to be two spawners and they did not know about each other:
 *
 *   main.ts  `spawnRow()`      3 barrels + riders, every 4.2 s (25.2 m at 6 m/s)
 *   gates.ts  auto-spawn       one gate row,       every 16 m
 *
 * Both dropped content at z = −58. Every time 25.2 m and 16 m came back into
 * phase, a barrel row and a gate row spawned *on the same plane* — the overlap
 * in the shipped build. It was never a rendering fault; it was two schedules
 * with no conductor.
 *
 * ---------------------------------------------------------------------------
 * What replaced them
 * ---------------------------------------------------------------------------
 * One cursor walking one cycle. The director is handed the metres of road that
 * scrolled past this tick and answers, at most once per call, "place this now".
 * Because a single cursor decides everything, **two things cannot occupy the
 * same stretch of road by construction** — there is no interleaving left to get
 * wrong.
 *
 * Three independent timers were also unschedulable in principle, which is worth
 * recording: their combined demand was 1/16 + 1/25.2 + 1/50.4 = 0.122 placements
 * per metre, i.e. one every 8.2 m on average. Ask for a legible gap of 11 m
 * between things and that demand simply does not fit. Something had to give,
 * and a fixed cycle makes the trade explicit instead of resolving it by
 * collision.
 *
 * ---------------------------------------------------------------------------
 * Deliberately not here
 * ---------------------------------------------------------------------------
 * No three.js, no scene, no spawning. This module decides WHAT and WHERE; the
 * orchestrator executes it. That is what keeps the corridor's pacing — the part
 * a playtest complaint actually lands on — checkable in plain Node.
 *
 * It is also deliberately still a fixed cycle. Beats (rest, build, surge) are
 * the next step and they replace `CYCLE`, not this scheduler.
 */

/** What the director can ask the orchestrator to put on the road. */
export type Placement = "gate" | "barrels" | "walkers";

/**
 * The repeating pattern, one entry per placement.
 *
 * Ratios matter more than the literal order: 5 gates to 2 barrel rows to 1
 * walker pack. Gates are the game — they get the majority of the slots and
 * never sit more than two non-gates apart, so the corridor always has a
 * decision on it.
 *
 * One cycle runs 98 m (six gaps at `SPACING`, two at `GATE_TO_GATE_SPACING`),
 * so gates land every ~19.6 m on average against the 16 m the gate module used
 * to run at alone. Slightly sparser, and the road is no longer shared with a
 * barrel row landing on the same plane.
 *
 * Note the wrap: the last two entries and the first are all gates, so a cycle
 * boundary produces a run of three decisions at the wider gate spacing. That
 * reads as a deliberate cluster rather than a fault, but it is a side effect of
 * the ordering rather than something chosen — worth authoring properly when
 * beats replace this.
 */
const CYCLE: readonly Placement[] = [
  "gate",
  "barrels",
  "gate",
  "walkers",
  "gate",
  "barrels",
  "gate",
  "gate",
];

/**
 * Metres of road between one placement and the next.
 *
 * 11 m is ~1.8 s at the default 6 m/s. It is the smallest gap at which a gate
 * row and a barrel row still read as two separate decisions rather than one
 * cluttered one: at this camera's 22° a metre of depth covers about 0.375 of
 * the screen that a metre of width does, so 11 m of road reads roughly as 4 m
 * of apparent separation on a 6.8 m wide road.
 */
const SPACING = 11;

/**
 * Gap between two GATE rows specifically, which is wider than the base.
 *
 * A gate is a decision, and two decisions 11 m apart is 1.8 s to read the
 * first, act on it, and read the second — the player is still watching their
 * army grow from the first when the second is already on them. 16 m is the gap
 * the gate module ran at on its own, derived from the reference's stacking, and
 * it is the right number for gate-to-gate even though 11 m is right for a gate
 * following a barrel row (which asks nothing of the player's thumb).
 *
 * This is why the gap is a function of the PAIR rather than a constant: what
 * needs separating is decisions, not objects.
 */
const GATE_TO_GATE_SPACING = 16;

/**
 * Metres of random slack on that gap, ±. Without it the corridor is a
 * metronome — perfectly even spacing is as unnatural as no spacing at all, and
 * it is the tell that makes procedural content feel generated.
 *
 * Kept below SPACING/3 so the minimum gap never falls under ~7 m.
 */
const SPACING_JITTER = 3;

export interface DirectorState {
  /**
   * Advance the corridor by `metres` of scrolled road.
   *
   * Returns what to place now, or null. At most one placement per call, which
   * is correct rather than a limitation: if the world ever steps far enough to
   * owe two, spacing them across the next few ticks is exactly what should
   * happen — the alternative is dropping both on the same plane, which is the
   * bug this module exists to prevent.
   */
  advance(metres: number): Placement | null;
  /** Back to the start of the cycle. For a run restart. */
  reset(): void;
  /** Placements made since the last reset. Diagnostics and tests. */
  readonly count: number;
  /** Metres still to travel before the next placement is due. */
  readonly untilNext: number;
}

/**
 * Seeded, so a run is reproducible. Same generator as gates.ts and bullets.ts —
 * duplicated rather than shared because a single shared RNG would couple the
 * modules' sequences, and then changing gate variety would silently reshuffle
 * the corridor's pacing. Exported so the orchestrator can take its OWN stream
 * for the same reason.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDirector(seed = 0x5eed): DirectorState {
  const rng = createRng(seed);
  let index = 0;
  let count = 0;
  let pending = 0;

  /**
   * Distance from the placement just made to the one after it, jittered.
   * Depends on both, because separating two decisions matters more than
   * separating a decision from scenery.
   */
  function nextGap(from: Placement, to: Placement): number {
    const base = from === "gate" && to === "gate" ? GATE_TO_GATE_SPACING : SPACING;
    return Math.max(SPACING / 3, base + (rng() * 2 - 1) * SPACING_JITTER);
  }

  // The first placement is due immediately, so the run never opens on empty
  // road while the cursor walks up to its first gap.
  let gap = 0;

  return {
    advance(metres) {
      pending += metres;
      if (pending < gap) return null;
      pending -= gap;
      const placement = CYCLE[index % CYCLE.length]!;
      index++;
      count++;
      gap = nextGap(placement, CYCLE[index % CYCLE.length]!);
      return placement;
    },

    reset() {
      index = 0;
      count = 0;
      pending = 0;
      gap = 0;
    },

    get count() {
      return count;
    },

    get untilNext() {
      return Math.max(0, gap - pending);
    },
  };
}

/** Exported for the tests and for anyone reasoning about corridor density. */
export const DIRECTOR_SPACING = SPACING;
export const DIRECTOR_GATE_SPACING = GATE_TO_GATE_SPACING;
export const DIRECTOR_SPACING_JITTER = SPACING_JITTER;
export const DIRECTOR_CYCLE = CYCLE;
