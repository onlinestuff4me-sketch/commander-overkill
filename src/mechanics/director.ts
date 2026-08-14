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
 * The scheduler is separate from the RHYTHM. It guarantees spacing; `BEATS`
 * decides what phrase comes next. Changing the feel of a run means editing the
 * beat table, not this loop.
 */

/**
 * What the director can ask the orchestrator to put on the road.
 *
 * The last two are COMPOUND: two things at the same z, on opposite sides, placed
 * so they cannot overlap. That is the shape a genuine either/or has to take.
 *
 * A playtester's diagnosis, and it was right: "everything that comes at me is an
 * inevitability, and I can do little to move out of its way." Sequential content
 * cannot fix that on its own, because a crowd only has to be in one place at the
 * moment each row arrives — it can take the best of every row in turn. Two
 * prizes on the same plane is the one arrangement where taking one means not
 * taking the other, whatever the player's reflexes are.
 *
 *   blockade    a gate row on one side, an enemy pack standing in the gap
 *   crossroads  a barrel cluster on one side, a gate row on the other
 */
export type Placement = "gate" | "barrels" | "walkers" | "blockade" | "crossroads";

/**
 * A placement plus which side of the road it wants.
 *
 * `side` is −1 left, +1 right, 0 "anywhere". It is relative to the beat's own
 * phrase side, resolved by the director, so a beat can say "put the guard where
 * the prize is" (both +1) or "make them cross for it" (+1 then −1) without
 * knowing or caring which kerb that turns out to be.
 */
export interface Cue {
  readonly what: Placement;
  readonly side: number;
}

/**
 * BEATS — the corridor's rhythm, as data.
 *
 * A fixed cycle of placements got the spacing right and the SHAPE wrong: content
 * arrived at a constant rate forever, so there was nothing to feel relief from
 * and nothing to brace for. A beat is a short authored phrase of placements plus
 * the road that follows it, and stringing beats together is what gives a run a
 * pulse instead of a metronome.
 *
 * `rest` is the one that does the most work and is the easiest to cut. Empty
 * road feels like nothing is happening, which is exactly the point — a surge
 * only lands as a surge if something quieter came before it.
 */
export interface Beat {
  readonly name: string;
  /** What this beat puts on the road, in order. */
  readonly places: readonly Placement[];
  /**
   * Which side each placement wants, parallel to `places`. +1 is the beat's own
   * phrase side, −1 the other kerb, 0 anywhere. Omit for all-free.
   *
   * This is where a beat stops being a list of objects and becomes a shape. Two
   * +1s in a row is a guard standing in front of a prize; +1 then −1 is a
   * crossing that costs most of the gap between them (see LATERAL_SPEED in
   * entities/squad.ts — a full crossing is 1.7 s against a 1.8 s gap).
   */
  readonly sides?: readonly number[];
  /** Extra metres of clear road AFTER the beat, on top of the normal spacing. */
  readonly trail: number;
  /** Relative likelihood of being picked. Not a probability — normalised. */
  readonly weight: number;
}

export const BEATS: readonly Beat[] = [
  // The choice is the whole game, so it gets to happen on clear road with
  // nothing competing for the eye. The most common beat, deliberately.
  { name: "decision", places: ["gate"], trail: 0, weight: 4 },

  // Somewhere for the guns to matter, with no decision on top of it.
  { name: "combat", places: ["barrels", "walkers"], sides: [1, 1], trail: 4, weight: 2 },

  // The two mechanics interacting: shoot through the cover, then immediately
  // choose. This is the beat a fixed cycle could only produce by accident.
  { name: "gauntlet", places: ["barrels", "gate"], sides: [1, 1], trail: 2, weight: 2 },

  // Two decisions on OPPOSITE kerbs. Taking both is not physically available —
  // a full crossing eats the whole gap — so this is the beat that asks the
  // player to give one of them up on purpose.
  { name: "fork", places: ["gate", "gate"], sides: [1, -1], trail: 3, weight: 2 },

  // Nothing at all. Cheap to build, and it is what makes the rest read.
  { name: "rest", places: [], trail: 16, weight: 1 },

  // The either/or, on one plane: a gate row on one side and a pack of walkers
  // standing in the gap beside it. Threading the gap means fighting through
  // bodies; taking the row means paying whatever the row asks.
  { name: "blockade", places: ["blockade"], trail: 5, weight: 2 },

  // Growth or firepower, and only one of them. The barrels carry a pickup and
  // the row carries troops, on the same plane, on opposite kerbs.
  { name: "crossroads", places: ["crossroads"], trail: 6, weight: 2 },

  // Loud on purpose: cover, a wave, and a decision in quick succession, with
  // the wave planted where the cover was so the guns are already pointed at it.
  { name: "surge", places: ["walkers", "barrels", "gate"], sides: [1, 1, -1], trail: 6, weight: 1 },
];

/**
 * Beats that may not follow themselves, by name.
 *
 * Two rests in a row is fifty metres of empty road, and two surges is a wall.
 * Everything else is allowed to repeat — a run of decisions is a legitimate
 * phrase, and forbidding all repeats makes the sequence feel shuffled rather
 * than composed.
 */
const NO_REPEAT: ReadonlySet<string> = new Set(["rest", "surge", "blockade", "crossroads"]);

/**
 * Does this placement put a DECISION on the road?
 *
 * Both spacing and the dry-streak limiter care about decisions rather than
 * objects, and the compound placements each contain a gate row. Answering "is it
 * literally the string 'gate'" would give a blockade the scenery gap and let a
 * corridor of nothing but blockades count as dry.
 */
function hasGate(p: Placement): boolean {
  return p === "gate" || p === "blockade" || p === "crossroads";
}

/**
 * Most placements the corridor may run without a gate before the next beat is
 * forced to contain one.
 *
 * `surge` alone puts two non-gates down before its decision, and two combat
 * beats back to back put four. Without this the mix can legitimately roll six
 * or seven placements of scenery, which is a long time to hold a thumb still in
 * a game whose entire input is choosing a lane.
 */
const DRY_LIMIT = 3;

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
  advance(metres: number): Cue | null;
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
  const totalWeight = BEATS.reduce((a, b) => a + b.weight, 0);

  let beat: Beat = BEATS[0]!;
  let step = 0;
  /** Which kerb the current beat's "+1" resolves to. Re-rolled per beat, so the
   *  corridor does not develop a handedness a player can lean on. */
  let phraseSide = 1;
  let lastName = "";
  let count = 0;
  let pending = 0;
  let gap = 0;
  /** Trail owed by beats already finished, folded into the next gap. */
  let trail = 0;
  /** Placements since the last gate. Gates are the game; see DRY_LIMIT. */
  let sinceGate = 0;

  /**
   * Weighted pick, with two structural refusals.
   *
   * `rest` and `surge` may not repeat — two rests is fifty metres of nothing and
   * two surges is a wall. And once the corridor has gone DRY_LIMIT placements
   * without a decision, only beats containing a gate are eligible: the mix is
   * allowed to wander, but never so far that the player is just watching.
   */
  function pickBeat(): Beat {
    const neededGate = sinceGate >= DRY_LIMIT;
    for (let attempt = 0; attempt < 12; attempt++) {
      let roll = rng() * totalWeight;
      for (const b of BEATS) {
        roll -= b.weight;
        if (roll > 0) continue;
        if (b.name === lastName && NO_REPEAT.has(b.name)) break;
        // Leads with a gate, not merely contains one: `surge` puts two
        // placements down before its decision, so accepting it here would let
        // the dry streak run two past the limit it is supposed to enforce.
        if (neededGate && !hasGate(b.places[0] ?? "barrels")) break;
        return b;
      }
    }
    // Fall back to the plainest beat that satisfies the constraint rather than
    // to BEATS[0] blindly, so the guarantee holds even on an unlucky streak.
    return neededGate
      ? (BEATS.find((b) => hasGate(b.places[0] ?? "barrels")) ?? BEATS[0]!)
      : BEATS[0]!;
  }

  /**
   * Make `beat.places[step]` a real placement, walking past any beat with
   * nothing left in it and banking its trail. This is how `rest` works: it
   * places nothing and contributes only empty road.
   */
  function ensureReady(): void {
    for (let guard = 0; guard < 16 && step >= beat.places.length; guard++) {
      trail += beat.trail;
      lastName = beat.name;
      beat = pickBeat();
      step = 0;
      phraseSide = rng() < 0.5 ? -1 : 1;
    }
  }

  /**
   * Distance from the placement just made to the one after it. Depends on both,
   * because separating two decisions matters more than separating a decision
   * from scenery — and `to` is resolved ACROSS the beat boundary, or a beat
   * ending on a gate followed by one starting on a gate would get the narrow
   * gap and put two decisions 8 m apart.
   */
  function nextGap(from: Placement, to: Placement): number {
    const base = hasGate(from) && hasGate(to) ? GATE_TO_GATE_SPACING : SPACING;
    const jitter = (rng() * 2 - 1) * SPACING_JITTER;
    const owed = trail;
    trail = 0;
    return Math.max(SPACING / 3, base + jitter) + owed;
  }

  return {
    advance(metres) {
      pending += metres;
      if (pending < gap) return null;
      pending -= gap;

      ensureReady();
      const placement = beat.places[step];
      if (!placement) return null;
      const side = (beat.sides?.[step] ?? 0) * phraseSide;
      step++;
      count++;
      // A compound placement contains a gate, so it resets the dry streak too —
      // otherwise a run of blockades would read as "no decisions" to the limiter
      // while being nothing but decisions on screen.
      sinceGate = hasGate(placement) ? 0 : sinceGate + 1;

      // Resolve the FOLLOWING placement before measuring the gap, so the
      // spacing rule sees across the beat boundary.
      ensureReady();
      gap = nextGap(placement, beat.places[step] ?? "barrels");
      return { what: placement, side };
    },

    reset() {
      beat = BEATS[0]!;
      step = 0;
      phraseSide = 1;
      lastName = "";
      count = 0;
      pending = 0;
      gap = 0;
      trail = 0;
      sinceGate = 0;
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

