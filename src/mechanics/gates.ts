/**
 * GATES — the segmented barrier rows, and the whole upgrade presentation.
 *
 * This is the screen's most important read. Per the reference teardown, a
 * player must name the good segment from COLOUR alone before they can read the
 * number, and read the number itself at arm's length on a phone. Everything
 * below is subordinate to that: the red/blue split carries the decision, the
 * white-on-thick-black numeral carries the amount, and the posts carry the
 * "this is a physical barrier you are about to smash" read.
 *
 * ---------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------------
 *
 *   const gates = createGates(scene);            // auto-spawns rows by default
 *   gates.onResolve((hit) => { world.troops += hit.value; });
 *   loop: gates.update(dt, world); gates.render(alpha, world);
 *
 * `GateSystem` is a `System` (src/core/types.ts) plus:
 *
 *   setAutoSpawn(on)            Turn the built-in pacing off when the
 *                               orchestrator wants to drive spawns itself.
 *                               Do not mix the two. Switching it back ON
 *                               mid-run resumes pacing but does NOT re-prime
 *                               the corridor — no wall of rows appears at once.
 *   spawnRow(segments, z?)      Place a row. `segments` is 1–4 entries, each a
 *                               plain number (negative = red penalty, positive
 *                               = blue reward) or a GateSegmentSpec for custom
 *                               width / climb. Returns false if the pool is
 *                               full — back off and retry next tick.
 *   onResolve(cb)               Fires once per row, the tick the squad centre
 *                               crosses it, with the segment it was inside.
 *                               Returns an unsubscribe closure.
 *                               THIS MODULE NEVER TOUCHES world.troops — the
 *                               orchestrator owns the count.
 *                               The GateHit payload is a REUSED object (the no-
 *                               allocation-in-update rule). Read it or copy it
 *                               inside the handler; never stash the reference.
 *   activeRows                  Rows currently in the corridor.
 *   nextGateZ()                 World Z of the nearest unresolved row (largest
 *                               z, since rows travel toward the camera), or
 *                               -Infinity when none is pending.
 *   reset()                     Recycle everything. Listeners survive.
 *
 * Frames of record: docs/reference/part1/frame_009 (-1 / -4 / +2),
 * frame_013 (same gate, now +9), frame_018 (all-red -20 / -5 / -10).
 */

import * as THREE from "three";
import type { System } from "../core/types";
import { CORRIDOR_HALF_WIDTH } from "./lane";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Barrier height in metres. Roughly chest-high on a unit, as in the reference. */
const GATE_HEIGHT = 1.15;
/** Panel floats a hair above the road so the bottom rail's glow spills onto it. */
const GATE_BASE_Y = 0.1;
/** Posts stand slightly proud of the panel — that overhang is what reads as structure. */
const POST_OVERSHOOT = 0.16;

/**
 * Widest a numeral may be, as a fraction of its segment. 0.82 leaves 0.2m of
 * clearance each side on a three-segment row, which clears the divider posts'
 * 0.15m half-width — a numeral touching a post is the first thing that makes
 * the row look like mush at distance.
 */
const NUMERAL_WIDTH_FRAC = 0.82;
/** Numeral quad height as a fraction of gate height. The glyph fills ~60% of that. */
const NUMERAL_FILL = 0.92;
/** How hard the numeral pops when a climbing value ticks over. */
const TICK_POP = 0.22;
/** Seconds the tick pop takes to settle. */
const TICK_POP_DECAY = 7;

/**
 * Rows are pooled; this is the ceiling on rows alive at once. The corridor
 * holds SPAWN_Z..RECYCLE_Z / ROW_GAP ≈ 4.5 rows, so 6 leaves headroom for a
 * still-bursting row to finish without starving the next spawn.
 */
const MAX_ROWS = 6;
/** Reference rows run 2–4 segments. Four is the hard structural limit. */
const MAX_SEGMENTS = 4;
const MAX_POSTS = MAX_SEGMENTS + 1;

/** Where rows appear. Just inside the fog's far edge so they haze in. */
const SPAWN_Z = -58;
/** Metres between rows. At 9 m/s that stacks 3–4 decisions up the corridor. */
const ROW_GAP = 16;
/** Rows placed up-front so the run never opens on an empty road. */
const PRIME_ROWS = 3;
/** Recycled once safely behind the camera (which sits at z = 9.5). */
const RECYCLE_Z = 15;

/**
 * THE CLIMB IS DRIVEN BY YOUR FIRE.
 *
 * Reference: the same gate reads +2 at 3.75 s and +9 at 5.33 s. That was first
 * built as a pure timer gated on Z, which produced a gate sitting frozen for
 * seven seconds while the player's bullets visibly poured over it, and then
 * suddenly climbing once it was 15 m out. Playtest read that as broken, and
 * fairly — a number that ignores the thing obviously hitting it is a number that
 * looks disconnected from the game.
 *
 * So a blue segment climbs when it is SHOT, starting the instant rounds can
 * reach it. That also makes the climb a decision: fire is a curtain the width of
 * the crowd (mechanics/bullets.ts), so the segment you steer under is the one
 * that grows fastest, and jumping between rewards splits your fire between them.
 *
 * A slow baseline remains so a one-soldier squad still sees a gate grow.
 */
const REWARD_CLIMB_RATE = 0.9;

/**
 * Troops added per point of bullet damage landed on a blue segment.
 *
 * Calibrated against the reference beat rather than taste: a mid-size army puts
 * ~250 damage/second into one segment, and the reference climbs +7 in ~1.6 s, so
 * ~400 damage should buy the whole span. 1/55 lands a full span in ~1.5 s for a
 * ~20-troop squad and faster for a bigger one, which is the intended reward for
 * having grown.
 */
const CLIMB_PER_DAMAGE = 1 / 55;
/**
 * How high a blue may climb, in troops.
 *
 * WAS A FLAT +7, and that was the whole problem with the reward beat: a gate
 * started at +3 and stopped at +10, so it ticked over seven numbers and paid
 * about a tenth of a mid-size army. Nothing about that is worth chasing. The
 * satisfying version is a number that keeps climbing while you hold your fire on
 * it and then pays a slab of troops, and a fixed span can never be that at both
 * ten troops and three hundred.
 *
 * SUB-LINEAR IN THE ARMY, and the exponent is the whole tuning. The first fix
 * for the flat span made it PROPORTIONAL — nine-tenths of the crowd — which is
 * compound interest by another name: every reward multiplied the army by ~1.9,
 * so a measured run passed 680 troops inside 60 seconds against a 300–500 target
 * at 120. An exponent below 1 keeps the early jumps enormous in relative terms
 * (the power fantasy the opening levels are supposed to be) while the late game
 * settles into something a difficulty curve can actually track.
 *
 *   troops     1      10     50    100    300    500
 *   span       8*     10     29     47     99    142
 *   ×army     ×9    ×2.0   ×1.6   ×1.5   ×1.3   ×1.3      (* the floor)
 *
 * The floor is what keeps a one-soldier squad's first gate meaningful.
 */
const REWARD_SPAN_BASE = 2.2;
const REWARD_SPAN_EXPONENT = 0.6;
const REWARD_SPAN_MIN = 8;

/**
 * THE JACKPOT — because "climb to a big number" and "grow at a sane rate" are
 * only compatible if the big numbers are rare.
 *
 * Playtest asked for barriers that climb and climb and then pay a slab, and the
 * honest tension is that a slab every row IS the runaway curve above. So the
 * ordinary blue is deliberately modest and roughly one in five runs to nearly
 * three times as far. Those are the rows worth committing to and holding fire
 * on, and the rest is the spacing that makes them land.
 *
 * Rolled from the module's own seeded stream, so a given seed lays out the same
 * jackpots every run; the span itself is `rewardSpan()`, which is pure and
 * tested.
 */
const JACKPOT_CHANCE = 0.2;
const JACKPOT_MULTIPLE = 2.8;

/**
 * Where a row of `count` segments sits on the road, and how wide it is.
 *
 * Pure and exported so the layout rules can be checked without a GPU — the same
 * reason `composeAutoRow` is. `bias` steers the row toward one side when the
 * director wants a guard lined up with a prize (see mechanics/director.ts);
 * pass 0 for a free roll.
 */
export interface RowPlacement {
  /** World X of the row's middle. */
  centerX: number;
  /** Half the row's total width, in metres. */
  halfSpan: number;
}

export function rowPlacement(rng: () => number, count: number, bias = 0): RowPlacement {
  const halfSpan = Math.min(CORRIDOR_HALF_WIDTH, (count * SEGMENT_WIDTH) / 2);
  // How far the row's middle may sit from the centreline without any of it
  // hanging off the road. A four-wide row barely moves; a two-wide row can be
  // anywhere, which is what makes narrow rows the ones worth steering for.
  const reach = Math.max(0, CORRIDOR_HALF_WIDTH - halfSpan);
  if (reach <= 1e-3) return { centerX: 0, halfSpan };

  // The bias is a REQUEST, not a command: it picks the side, and the roll still
  // decides how committed the row is to it. A director that could place rows
  // exactly would produce a corridor that reads as a pattern within a minute.
  const side = bias !== 0 ? Math.sign(bias) : rng() < 0.5 ? -1 : 1;
  const flush = rng() < ROW_FLUSH_CHANCE || bias !== 0;
  const centerX = flush ? side * reach * (0.65 + rng() * 0.35) : (rng() - 0.5) * reach * 0.5;
  return { centerX, halfSpan };
}

/**
 * How far a blue segment may climb above where it started, for an army of
 * `troops`. Pure so the growth curve can be checked without a GPU.
 */
export function rewardSpan(troops: number, jackpot = false): number {
  const n = Math.max(1, troops);
  const span = REWARD_SPAN_BASE * Math.pow(n, REWARD_SPAN_EXPONENT);
  return Math.max(REWARD_SPAN_MIN, Math.round(span * (jackpot ? JACKPOT_MULTIPLE : 1)));
}

/** Burst velocities, metres/sec. The barrier must visibly come apart, not vanish. */
const BURST_OUT = 2.2;
const BURST_UP = 2.9;
const BURST_TOWARD = 1.5;
const BURST_SPIN = 5.5;
const BURST_GRAVITY = 13;
/**
 * Seconds a broken row survives. At the default scroll speed the Z recycle
 * would fire first anyway; this is the backstop for a slowed or stopped world,
 * where debris would otherwise hang in frame forever.
 */
const BURST_LIFE = 1.6;

/**
 * Auto-spawn: chance a row contains a blue segment at all (frame_018 has none).
 *
 * Lowered from 0.72 now that a blue can climb into the hundreds. A big reward
 * every row would be a ramp rather than a decision — the payoff has to be
 * spaced out by rows that only cost, or there is nothing to weigh it against.
 */
const REWARD_ROW_CHANCE = 0.58;

/**
 * THE OPENING IS AUTHORED, NOT ROLLED.
 *
 * Below this many troops every auto row is guaranteed a blue segment, and the
 * penalties stay in the mildest pool no matter how long the run has been going.
 *
 * The reference opens on a SINGLE soldier, and it gets away with that because
 * its first rows always offer somewhere survivable to stand. Ours rolled every
 * row independently at `REWARD_ROW_CHANCE`, so roughly one in four was all-red —
 * unavoidable death for a small squad, and the reason the prototype had to open
 * at eight troops instead of one. Guaranteeing the option is what buys the
 * reference's opening beat back.
 *
 * This is a floor on survivability, not on difficulty: crossing a red segment
 * still costs, the blue still has to be steered to, and the guarantee lapses the
 * moment the squad is big enough to eat a bad row.
 */
export const MERCY_TROOPS = 10;
/**
 * How much of a segment the crowd must cover to count as having smashed it.
 *
 * A THIRD, not a touch and not all of it. Clipping the corner of a barrier at
 * the edge of the crowd should not cost its full value, and requiring full
 * coverage would mean a wide army never pays anything. At a third, a crowd
 * steered to the road edge takes one segment, and a crowd sitting in the middle
 * of a three-segment row takes all three — which is the real cost of being wide
 * and the real reason to commit to a side.
 */
const CROSS_FRACTION = 1 / 3;

/** Half-depth of a gate's bullet-collision slab. The panel is flat, so this is
 *  a tolerance rather than a thickness — wide enough that a round travelling
 *  44 m/s cannot step over the plane between two ticks. */
const GATE_HIT_DEPTH = 0.9;

/**
 * A ROW DOES NOT SPAN THE ROAD ANY MORE, and this is the single change that
 * makes the game strategic rather than merely reactive.
 *
 * Rows used to be stretched from kerb to kerb and divided into `count` segments,
 * which meant every row was a wall: the only question a gate could ask was
 * "which part of this do you want", never "do you want this at all". A
 * playtester put it exactly right — everything coming at you is an
 * inevitability, and you can do little to move out of its way.
 *
 * So a segment now has a roughly FIXED PHYSICAL WIDTH and the row is however
 * wide its segments add up to, placed somewhere on an 11.2 m road. The width of
 * a row therefore carries information the player can read from a long way off:
 *
 *   2 segments   4.7 m   42% of the road   6.5 m of clear road — easily dodged
 *   3 segments   7.0 m   63%               4.2 m — threadable by a small crowd
 *   4 segments   9.4 m   84%               1.8 m — effectively unavoidable
 *
 * `composeAutoRow`'s existing shape roll (18% two, 68% three, 14% four) was
 * cosmetic before and is now the difficulty of the row. Combined with the
 * crowd's lateral speed cap (see LATERAL_SPEED in entities/squad.ts), a narrow
 * row on the far kerb is a real decision: going for it means not being anywhere
 * else for the next second and a half.
 */
const SEGMENT_WIDTH = 2.35;
/**
 * Chance a row is pushed flush against a kerb rather than centred.
 *
 * Flush leaves ONE continuous gap, which is the clearest possible read at
 * distance: the barrier covers this much, the rest is open. Centred leaves two
 * narrower gaps and is the harder shape, so it is the minority.
 */
const ROW_FLUSH_CHANCE = 0.72;

/** Candidate positions `bestLane` scores across the road. 24 puts them ~0.47 m
 *  apart, finer than the tolerance any single decision turns on. */
const LANE_SAMPLES = 24;

/**
 * Chance of a 2-wide and a 3-wide row, per difficulty tier; the remainder is
 * 4-wide. Indexed by the same tier that selects `PENALTY_BANDS`.
 *
 * Read down the table and it is the whole difficulty curve in one place: at tier
 * 0 nearly every row can be walked around, at tier 2 four in ten cannot.
 */
const ROW_WIDTHS: readonly (readonly [two: number, three: number])[] = [
  [0.45, 0.5],
  [0.25, 0.55],
  [0.1, 0.5],
];

/**
 * PENALTIES ARE A SHARE OF THE ARMY, painted as an absolute number.
 *
 * They used to be a fixed table (-1 to -20) while the army grows exponentially,
 * which made them the exact inverse of what the difficulty curve wants: a -5 is
 * 62% of an eight-troop squad and 1.2% of a four-hundred-troop one. Brutal where
 * the design wants forgiveness, irrelevant where it wants teeth.
 *
 * Both reference clips scale them the same way — Part1 shows -1 to -20 against
 * an army of 1 to 60, clip1a shows a -300 against an army in the hundreds. The
 * magnitudes always tracked the crowd.
 *
 * Bands are per difficulty tier, and the tier still escalates with run time.
 */
const PENALTY_BANDS: readonly (readonly [lo: number, hi: number])[] = [
  [0.06, 0.14],
  [0.12, 0.22],
  [0.18, 0.32],
];
/**
 * Most of the army a SINGLE segment may take, whatever the band rolls.
 *
 * This is what makes "a bad row costs you, a bad row does not end you" true by
 * construction rather than by luck. At 0.35 it takes several consecutive
 * worst-case rows with no rewards in between to wipe out.
 */
const PENALTY_CAP = 0.35;
/**
 * Most of the army a WHOLE ROW may take, and the fix for the one way this game
 * could kill you out of nowhere.
 *
 * `PENALTY_CAP` bounds a single segment, which was fine when a crowd stood in
 * one lane. It stopped being fine when the crowd grew to span the road: a wide
 * army covers a third of every segment in the row, so it smashes ALL of them and
 * pays all of them. Three segments at the cap is 105% of the army — a full wipe,
 * from one barrier, with no read on screen that said so. A 120 s autopilot run
 * hit exactly that at 680 troops and went to zero on a single row.
 *
 * The wide crowd taking every segment is the mechanic, not the bug, so the fix
 * is here rather than there: a row's penalties are scaled down together until
 * they sum inside this budget. They stay proportional to each other, so the
 * "which of these is least bad" decision is unchanged — the row simply cannot
 * ask for more than the army can survive.
 *
 * 0.45 means the worst possible row costs a little under half of everything, and
 * two of them back to back with no reward between is a genuine emergency rather
 * than an execution.
 */
const ROW_PENALTY_CAP = 0.42;
/** Floor, so a penalty is never a no-op at small counts. */
const PENALTY_MIN = 1;

/**
 * Where a blue STARTS, as a share of the army. The climb is the interesting
 * part now, so the opening number is deliberately modest — it is the promise,
 * not the payout.
 */
const REWARD_START_FRACTION = 0.06;
const REWARD_START_MIN = 1;
/** Numerals pre-baked at init so a spawn never stalls on a canvas draw. */
const PREWARM: readonly number[] = [
  -1, -2, -3, -4, -5, -10, -15, -20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
];

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface GateSegmentSpec {
  /** Negative = red penalty, positive = blue reward. Zero is treated as a penalty. */
  value: number;
  /** Share of the road width. Defaults to an even split across the row. */
  weight?: number;
  /** Troops per second this reward grows by while approaching. Penalties ignore it. */
  climbRate?: number;
  /** Absolute ceiling for the climb. Defaults to `value + REWARD_CLIMB_SPAN`. */
  climbMax?: number;
}

export interface GateHit {
  /** The integer that was ON SCREEN when the squad crossed. Never the raw float. */
  value: number;
  /**
   * Troops to pay. Identical to `value` — a segment you smash through costs
   * exactly the number painted on it. Kept as a separate field because the
   * orchestrator should not have to know that, and because a future powerup that
   * halves penalties has an obvious place to live.
   */
  troops: number;
  /** Always 1. Retained so the payload shape is stable for callers. */
  share: number;
  /** True for a blue segment. Equivalent to `value > 0`, kept explicit for clarity. */
  reward: boolean;
  /** Index within the row, left to right. */
  segmentIndex: number;
  /** World X of the segment's centre — the anchor for the growth VFX burst. */
  x: number;
  /** World Z the row was at when it resolved. */
  z: number;
}

export interface GateSystem extends System {
  setAutoSpawn(enabled: boolean): void;
  /** `placement` decides where on the road the row sits and how wide it is.
   *  Omit it for a free roll — see `rowPlacement`. */
  spawnRow(
    segments: readonly (number | GateSegmentSpec)[],
    z?: number,
    placement?: RowPlacement,
  ): boolean;
  onResolve(handler: (hit: GateHit) => void): () => void;
  /**
   * Register a bullet hit against any BLUE segment overlapping (x, z), raising
   * its value. Returns true if a segment took it.
   *
   * Rounds are NOT consumed by a gate: the reference plainly shows fire passing
   * over a barrier to reach what is behind it, and a barrier that ate the stream
   * would make every gate a wall the army has to chew through.
   */
  shootAt(x: number, z: number, pad: number, amount: number): boolean;
  /**
   * Lane [-1, 1] of the highest-value segment in the nearest unresolved row, or
   * NaN when the corridor holds no decision.
   *
   * For the dev autopilot: measuring a failure rate or a growth curve needs a
   * player, and "steer at the best number" is the simplest one that is not
   * obviously worse than a human. It is not AI and is not shipped behaviour.
   */
  bestLane(): number;
  /** Face values of every live unresolved segment. Diagnostics only. */
  debugValues(): number[];
  readonly activeRows: number;
  nextGateZ(): number;
  reset(): void;
}

export interface GateOptions {
  /** Default true: the module paces its own rows so it is useful standalone. */
  autoSpawn?: boolean;
  /** Seed for spawn variety and burst jitter. Fixed by default — runs must repeat. */
  seed?: number;
}

/**
 * The segment values for one procedurally-shaped row, written into `out`.
 *
 * Pure, exported and free of three.js on purpose: this is the whole of the
 * game's difficulty pacing, and it is the one part of the gate module that can
 * be checked without a GPU. `out` is a caller-owned scratch array so the live
 * path allocates nothing; its length is set to the segment count.
 *
 * Penalty magnitude escalates in tiers with run time, and roughly one row in
 * four carries no reward at all — which is what makes an all-red row
 * (`frame_018`) land as a genuine "pick your loss" moment rather than as a bug.
 * Below `MERCY_TROOPS` neither of those applies; see the note there.
 */
export function composeAutoRow(
  rng: () => number,
  elapsed: number,
  troops: number,
  out: number[],
  /** Ceiling on segments, so a caller that needs road left over beside the row
   *  can ask for a narrow one. A compound placement (see `blockade` in
   *  mechanics/director.ts) puts a second thing in the gap, and a four-wide row
   *  covers 84% of the road — there would be no gap to put it in. */
  maxCount = MAX_SEGMENTS,
): number {
  // A squad this small cannot absorb a wrong answer, so it is not asked one:
  // the penalties stay mild and a blue segment is always on the board.
  const mercy = troops < MERCY_TROOPS;
  const tier = mercy ? 0 : Math.min(PENALTY_BANDS.length - 1, Math.floor(elapsed / 25));
  const band = PENALTY_BANDS[tier] ?? PENALTY_BANDS[0]!;
  const army = Math.max(1, troops);

  /** One penalty as a SHARE of the army. Kept as a share until the whole row has
   *  been rolled, because the row budget below can only be applied once every
   *  segment's appetite is known. `roll` is passed in rather than drawn here so
   *  that every segment consumes exactly one draw whichever branch it takes —
   *  see the loop below. */
  const penaltyShare = (roll: number): number =>
    Math.min(PENALTY_CAP, band[0] + roll * (band[1] - band[0]));

  // WIDTH IS THE DIFFICULTY, now that a row can be dodged. A two-wide row leaves
  // 6.5 m of clear road and is a genuine "do you even want this"; a four-wide
  // leaves 1.8 m and is the old unavoidable wall. Escalating the mix with the
  // penalty tier is what turns Mischa's brief into geometry: early levels are
  // about missed opportunity — the cost of a bad read is a reward you did not
  // take — and late ones are about damage, because by then there is nowhere to
  // stand that is free.
  const widths = ROW_WIDTHS[tier] ?? ROW_WIDTHS[0]!;
  const shape = rng();
  const count = Math.max(
    2,
    Math.min(maxCount, shape < widths[0] ? 2 : shape < widths[0] + widths[1] ? 3 : 4),
  );
  // Both draws happen unconditionally so the seeded stream advances by the same
  // amount either way — mercy forces the OUTCOME without shifting the sequence,
  // which is what keeps a seeded run reproducible across the threshold. Rolling
  // only when needed would desync every row after the squad crossed it.
  const rolled = rng() < REWARD_ROW_CHANCE;
  const pick = Math.floor(rng() * count);
  const rewardAt = rolled || mercy ? pick : -1;

  // Two passes: gather the row's appetite in shares, then spend the budget.
  let wanted = 0;
  for (let i = 0; i < count; i++) {
    // ONE DRAW PER SEGMENT, whichever branch it takes. The reward branch used to
    // pick from a table and the penalty branch from another, so both consumed a
    // draw; a reward computed without one would desync every later row the
    // moment mercy forced a blue that would not otherwise have been there.
    const roll = rng();
    const share = i === rewardAt ? 0 : penaltyShare(roll);
    out[i] = share;
    wanted += share;
  }

  // Scale the whole row down together if it asks for more than a run can
  // survive. Proportional, so the ranking between "least bad" and "worst" that
  // the player is actually reading survives the squeeze intact.
  const trim = wanted > ROW_PENALTY_CAP ? ROW_PENALTY_CAP / wanted : 1;

  for (let i = 0; i < count; i++) {
    out[i] =
      i === rewardAt
        ? Math.max(REWARD_START_MIN, Math.round(army * REWARD_START_FRACTION))
        : -Math.max(PENALTY_MIN, Math.round(army * out[i]! * trim));
  }
  out.length = count;
  return count;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Segment {
  group: THREE.Group;
  panel: THREE.Mesh;
  numeral: THREE.Mesh;
  sparkle: THREE.Mesh;
  numeralMat: THREE.MeshBasicMaterial;
  reward: boolean;
  /** Set when the crowd smashed through this segment. Only crossed segments
   *  burst, and only crossed segments charge — see `resolve`. */
  crossed: boolean;
  /**
   * Set when this segment is gone: either the crowd drove through it, or a blue
   * one was shot until it hit its ceiling and paid out early.
   *
   * A segment that is not broken BLOCKS BULLETS. That is the whole reason this
   * is per-segment rather than per-row: fire is a curtain the width of the
   * crowd, so one lane can be walled off by a red while the lanes either side
   * of it shoot clean through to whatever is behind.
   */
  broken: boolean;
  /** Seconds since this segment broke, so debris from an early break does not
   *  share the row's timer. */
  burst: number;
  /** Float. Rewards climb; the displayed value is `Math.floor` of this. */
  value: number;
  /** Integer currently baked into the numeral texture. -Infinity = none yet. */
  shown: number;
  climbRate: number;
  climbMax: number;
  centerX: number;
  halfWidth: number;
  numeralW: number;
  numeralH: number;
  pop: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
}

interface Post {
  x: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wz: number;
  px: number;
  py: number;
  pz: number;
  rx: number;
  rz: number;
}

interface Row {
  group: THREE.Group;
  segments: Segment[];
  posts: THREE.InstancedMesh;
  postState: Post[];
  count: number;
  postCount: number;
  /** Where the row sits on the road and how much of it it covers. Kept on the
   *  row so `bestLane` can point the autopilot at the gap as well as at a
   *  segment — "go around" is now a move, so a player has to be able to pick it. */
  centerX: number;
  halfSpan: number;
  z: number;
  prevZ: number;
  active: boolean;
  resolved: boolean;
  /** True when the crowd actually hit something in this row. A row the crowd
   *  drove AROUND is resolved but not smashed: it stays standing, its posts do
   *  not fly, and it sails off the end of the corridor intact — which is what
   *  "you avoided it" has to look like. */
  smashed: boolean;
  /** Seconds since the barrier broke; negative while intact. */
  burst: number;
}

const WHITE = new THREE.Color(0xffffff);

export function createGates(scene: THREE.Scene, options?: GateOptions): GateSystem {
  const rng = mulberry32(options?.seed ?? 0x0c0ffee);
  /** Troop count as of the last update. `spawnRow` needs it to size a blue's
   *  ceiling and does not otherwise see the world. */
  let lastTroops = 1;
  /** The crowd's real half-width, mirrored off the last update. `bestLane` needs
   *  it to score a position the way `resolve` will actually judge it, and it has
   *  no world to read. */
  let lastHalfWidth = 0.3;
  let autoSpawn = options?.autoSpawn ?? true;

  const root = new THREE.Group();
  scene.add(root);

  // ---- shared GPU resources -------------------------------------------------
  // One unit quad backs every panel, numeral and sparkle in the game; the mesh
  // scale carries the size. Same for the post geometry across every row.
  const quad = new THREE.PlaneGeometry(1, 1);
  const postGeom = buildPostGeometry();

  const penaltyTex = panelTexture(false);
  const rewardTex = panelTexture(true);
  const sparkleTex = sparkleTexture();

  const panelMats: Record<"penalty" | "reward", THREE.MeshBasicMaterial> = {
    // depthWrite off because these are translucent slabs that must not occlude
    // each other; three's back-to-front sort of transparent objects then puts
    // the numeral (parked 3cm nearer camera) on top of its own panel for free.
    penalty: new THREE.MeshBasicMaterial({
      map: penaltyTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
    reward: new THREE.MeshBasicMaterial({
      map: rewardTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  };

  // Lambert, not Basic: the posts are the only part of the gate that takes the
  // scene lighting, and that shading is what stops the barrier reading as a
  // flat decal pasted on the road.
  const postMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sparkleMat = new THREE.MeshBasicMaterial({
    map: sparkleTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });

  const numeralCache = new Map<string, THREE.CanvasTexture>();
  for (const v of PREWARM) numeralTexture(numeralCache, v);

  // ---- pool -----------------------------------------------------------------
  const rows: Row[] = [];
  for (let i = 0; i < MAX_ROWS; i++) rows.push(buildRow());

  const handlers = new Set<(hit: GateHit) => void>();
  const hit: GateHit = {
    value: 0,
    troops: 0,
    share: 0,
    reward: false,
    segmentIndex: 0,
    x: 0,
    z: 0,
  };
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  let spawnCarry = 0;
  let primed = false;
  let liveRows = 0;

  function buildRow(): Row {
    const group = new THREE.Group();
    group.visible = false;
    root.add(group);

    const segments: Segment[] = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const segGroup = new THREE.Group();
      segGroup.visible = false;
      group.add(segGroup);

      const panel = new THREE.Mesh(quad, panelMats.penalty);
      segGroup.add(panel);

      const numeralMat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        // Fog deliberately OFF. Fog is doing real work on the panels — it hazes
        // distant rows the way the reference does — but hazing the numeral is
        // exactly the readability failure we cannot ship. Numbers stay white.
        fog: false,
      });
      const numeral = new THREE.Mesh(quad, numeralMat);
      numeral.position.z = 0.03;
      segGroup.add(numeral);

      const sparkle = new THREE.Mesh(quad, sparkleMat);
      sparkle.position.z = 0.06;
      sparkle.visible = false;
      segGroup.add(sparkle);

      segments.push({
        group: segGroup,
        panel,
        numeral,
        sparkle,
        numeralMat,
        reward: false,
        crossed: false,
        broken: false,
        burst: 0,
        value: 0,
        shown: Number.NEGATIVE_INFINITY,
        climbRate: 0,
        climbMax: 0,
        centerX: 0,
        halfWidth: 0,
        numeralW: 1,
        numeralH: 0.5,
        pop: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        wz: 0,
      });
    }

    const posts = new THREE.InstancedMesh(postGeom, postMat, MAX_POSTS);
    // Instance transforms are not in the bounding sphere, so three would cull
    // this against a sphere sized for a single post. Cheaper to skip the test.
    posts.frustumCulled = false;
    posts.count = 0;
    group.add(posts);
    // Touch every instance colour once so `instanceColor` exists before spawn.
    for (let i = 0; i < MAX_POSTS; i++) posts.setColorAt(i, WHITE);

    const postState: Post[] = [];
    for (let i = 0; i < MAX_POSTS; i++) {
      postState.push({ x: 0, vx: 0, vy: 0, vz: 0, wx: 0, wz: 0, px: 0, py: 0, pz: 0, rx: 0, rz: 0 });
    }

    return {
      group,
      segments,
      posts,
      postState,
      count: 0,
      postCount: 0,
      centerX: 0,
      halfSpan: CORRIDOR_HALF_WIDTH,
      z: SPAWN_Z,
      prevZ: SPAWN_Z,
      active: false,
      resolved: false,
      smashed: false,
      burst: -1,
    };
  }

  function spawnRow(
    specs: readonly (number | GateSegmentSpec)[],
    z: number = SPAWN_Z,
    placement?: RowPlacement,
  ): boolean {
    let row: Row | undefined;
    for (const r of rows) {
      if (!r.active) {
        row = r;
        break;
      }
    }
    if (!row) return false;

    const count = Math.max(1, Math.min(MAX_SEGMENTS, specs.length));

    // One roll per ROW, not per segment: a jackpot is the row's character, and
    // two of them side by side would just be a bigger ramp. Drawn unconditionally
    // so a row with no blue in it still advances the stream by the same amount.
    const climbSpan = rewardSpan(lastTroops, rng() < JACKPOT_CHANCE);

    // Normalise weights into world widths across the row's own span — which is
    // a slice of the road, not the whole of it. See SEGMENT_WIDTH.
    let weightSum = 0;
    for (let i = 0; i < count; i++) weightSum += weightOf(specs[i]);
    const placed = placement ?? rowPlacement(rng, count);
    const span = placed.halfSpan * 2;
    let cursor = placed.centerX - placed.halfSpan;
    row.centerX = placed.centerX;
    row.halfSpan = placed.halfSpan;

    for (let i = 0; i < count; i++) {
      const spec = specs[i];
      const seg = row.segments[i];
      if (!seg || spec === undefined) continue;

      const width = (span * weightOf(spec)) / weightSum;
      const value = typeof spec === "number" ? spec : spec.value;
      const reward = value > 0;

      seg.reward = reward;
      seg.crossed = false;
      seg.broken = false;
      seg.burst = 0;
      seg.value = value;
      seg.shown = Number.NEGATIVE_INFINITY;
      seg.pop = 0;
      seg.centerX = cursor + width / 2;
      seg.halfWidth = width / 2;
      seg.climbRate = typeof spec === "number" ? REWARD_CLIMB_RATE : (spec.climbRate ?? REWARD_CLIMB_RATE);
      seg.climbMax =
        typeof spec === "number" ? value + climbSpan : (spec.climbMax ?? value + climbSpan);
      cursor += width;

      seg.group.visible = true;
      seg.group.position.set(seg.centerX, 0, 0);
      seg.group.rotation.set(0, 0, 0);

      seg.panel.material = reward ? panelMats.reward : panelMats.penalty;
      seg.panel.position.set(0, GATE_BASE_Y + GATE_HEIGHT / 2, 0);
      seg.panel.scale.set(width, GATE_HEIGHT, 1);

      // Cap the numeral against the segment AND against the gate height, so a
      // narrow segment shrinks its number rather than letting it bleed past a post.
      const nw = Math.min(width * NUMERAL_WIDTH_FRAC, GATE_HEIGHT * NUMERAL_FILL * 2);
      seg.numeralW = nw;
      seg.numeralH = nw / 2;
      seg.numeral.position.set(0, GATE_BASE_Y + GATE_HEIGHT / 2, 0.03);
      seg.numeral.scale.set(nw, nw / 2, 1);

      // Sparkle rides the reward segment's outer-bottom corner, as in frame_013.
      seg.sparkle.visible = reward;
      const outer = seg.centerX >= 0 ? 1 : -1;
      seg.sparkle.position.set(outer * width * 0.4, GATE_BASE_Y + 0.16, 0.06);

      applyValue(seg, true);
    }

    for (let i = count; i < MAX_SEGMENTS; i++) {
      const seg = row.segments[i];
      if (seg) seg.group.visible = false;
    }

    // Posts: one per boundary including both ends. Colour follows the segment on
    // the post's LEFT (the leftmost takes the segment on its right) — that is the
    // pattern in frame_009, where only the far-right cap turns blue for the +2.
    row.postCount = count + 1;
    let edge = placed.centerX - placed.halfSpan;
    for (let i = 0; i < row.postCount; i++) {
      const post = row.postState[i];
      if (!post) continue;
      post.x = edge;
      resetPost(post);

      const source = row.segments[i === 0 ? 0 : i - 1];
      tint.setHex(source && source.reward ? 0x63c8ff : 0xff5350);
      row.posts.setColorAt(i, tint);

      const seg = row.segments[i];
      if (seg && i < count) edge = seg.centerX + seg.halfWidth;
    }
    row.posts.count = row.postCount;
    if (row.posts.instanceColor) row.posts.instanceColor.needsUpdate = true;
    writePosts(row);

    row.count = count;
    row.z = z;
    row.prevZ = z;
    row.active = true;
    row.resolved = false;
    row.smashed = false;
    row.burst = -1;
    row.group.visible = true;
    row.group.position.set(0, 0, z);
    liveRows++;
    return true;
  }

  /** Re-bake the numeral only when the integer on screen actually changes. */
  function applyValue(seg: Segment, force: boolean): void {
    const shown = Math.floor(seg.value);
    if (!force && shown === seg.shown) return;
    if (!force) seg.pop = 1;
    seg.shown = shown;
    seg.numeralMat.map = numeralTexture(numeralCache, shown);
    seg.numeralMat.needsUpdate = true;
  }

  function resetPost(post: Post): void {
    post.px = post.x;
    post.py = 0;
    // Nudged toward camera so the post's front face wins the depth test against
    // the panel plane it straddles, instead of z-fighting with it.
    post.pz = 0.06;
    post.rx = 0;
    post.rz = 0;
    post.vx = 0;
    post.vy = 0;
    post.vz = 0;
    post.wx = 0;
    post.wz = 0;
  }

  function writePosts(row: Row): void {
    for (let i = 0; i < row.postCount; i++) {
      const post = row.postState[i];
      if (!post) continue;
      dummy.position.set(post.px, post.py, post.pz);
      dummy.rotation.set(post.rx, 0, post.rz);
      dummy.updateMatrix();
      row.posts.setMatrixAt(i, dummy.matrix);
    }
    row.posts.instanceMatrix.needsUpdate = true;
  }

  /**
   * Resolve a row against the crowd that just drove through it.
   *
   * EVERY SEGMENT THE CROWD OVERLAPS PAYS, in proportion to how much of the army
   * went through it. This used to pick the single segment under the squad's
   * CENTRE, which was defensible when a squad was ~1.6 m wide and a segment was
   * 2.3 m — the centre was the crowd. It stopped being true when the crowd grew
   * to span the road: at 5 m wide it straddles two or three segments of a 6.8 m
   * barrier, so most of what the player drove through was being discarded. A red
   * segment that three-quarters of the army walked into charged nothing at all
   * as long as the middle man was over the blue.
   *
   * Full value per touched segment was the other option and it is worse: a wide
   * army overlaps everything, so it would collect every reward and every penalty
   * in every row and the choice would evaporate. Weighting by overlap keeps the
   * decision — steering changes the MIX, and a narrow squad still takes one
   * segment whole.
   */
  /**
   * Blow one segment apart and pay what it is worth.
   *
   * Called from two places that used to be one: the crowd driving through, and
   * a blue segment being SHOT until it reaches its ceiling. The second is the
   * new one — a reward you have poured enough fire into should pay out where it
   * stands, not wait to be walked into, and breaking it is what opens the lane
   * for the rest of the stream.
   */
  function breakSegment(row: Row, i: number, fromX: number, loud: boolean): void {
    const seg = row.segments[i];
    if (!seg || seg.broken) return;
    seg.broken = true;
    seg.burst = 0;

    const value = Math.floor(seg.value);
    if (value !== 0) {
      hit.value = value;
      hit.troops = value;
      hit.share = 1;
      hit.reward = seg.reward;
      hit.segmentIndex = i;
      hit.x = seg.centerX;
      hit.z = row.z;
      // Copy before iterating: a handler is allowed to unsubscribe itself.
      for (const handler of [...handlers]) handler(hit);
    }

    const dir = seg.centerX >= fromX ? 1 : -1;
    const away = Math.abs(seg.centerX - fromX) * 0.35;
    seg.vx = dir * (BURST_OUT + away + rng() * 1.2);
    seg.vy = BURST_UP + rng() * 1.4;
    seg.vz = BURST_TOWARD + rng() * 0.9;
    seg.wx = (rng() - 0.5) * BURST_SPIN;
    seg.wy = (rng() - 0.5) * BURST_SPIN * 0.6;
    seg.wz = (rng() - 0.5) * BURST_SPIN;
    if (loud) seg.pop = 1.6;
  }

  function resolve(row: Row, crossX: number, halfWidth: number): void {
    row.resolved = true;

    const half = Math.max(0.15, halfWidth);
    const left = crossX - half;
    const right = crossX + half;

    let anyCrossed = false;
    let dominant = 0;
    let dominantOverlap = -1;
    for (let i = 0; i < row.count; i++) {
      const seg = row.segments[i];
      if (!seg) continue;
      const lo = Math.max(left, seg.centerX - seg.halfWidth);
      const hi = Math.min(right, seg.centerX + seg.halfWidth);
      const over = Math.max(0, hi - lo);
      // CROSSED IS BINARY. A segment is either smashed through or it is not,
      // and what it costs is the number painted on it — see the note above.
      seg.crossed = over >= seg.halfWidth * 2 * CROSS_FRACTION;
      if (seg.crossed) anyCrossed = true;
      if (over > dominantOverlap) {
        dominantOverlap = over;
        dominant = i;
      }
    }

    // GOING AROUND IS FREE, and that is the point of the whole layout change.
    //
    // This used to charge the nearest segment whenever nothing was properly
    // crossed, on the reasoning that a row spanned the road and so overhanging
    // the kerb must not buy a free pass. Rows no longer span the road (see
    // SEGMENT_WIDTH), so a crowd clear of the barrier is genuinely clear of it —
    // and making that pay nothing is what turns a gate from a toll into a
    // decision. Keeping the fallback would have made the wider road cosmetic.
    if (!anyCrossed) return;

    row.smashed = true;
    row.burst = 0;

    for (let i = 0; i < row.count; i++) {
      const seg = row.segments[i];
      // A segment the crowd did not smash through stays standing and sails past
      // intact, and one already shot to pieces is not charged twice.
      if (!seg || !seg.crossed || seg.broken) continue;
      breakSegment(row, i, crossX, i === dominant);
    }

    for (let i = 0; i < row.postCount; i++) {
      const post = row.postState[i];
      if (!post) continue;
      const dir = post.x >= crossX ? 1 : -1;
      post.vx = dir * (BURST_OUT * 0.8 + rng() * 1.4);
      post.vy = BURST_UP * 0.7 + rng() * 1.2;
      post.vz = BURST_TOWARD * 0.6 + rng() * 0.8;
      post.wx = (rng() - 0.5) * BURST_SPIN * 1.4;
      post.wz = (rng() - 0.5) * BURST_SPIN * 1.4;
    }
  }

  function recycle(row: Row): void {
    row.active = false;
    row.group.visible = false;
    row.posts.count = 0;
    for (const seg of row.segments) seg.group.visible = false;
    liveRows--;
  }

  // Reused every spawn so auto-pacing never allocates inside update().
  const autoBuffer: number[] = [0, 0, 0, 0];

  function autoRow(elapsed: number, z: number, troops: number): void {
    composeAutoRow(rng, elapsed, troops, autoBuffer);
    spawnRow(autoBuffer, z);
  }

  const system: GateSystem = {
    update(dt, world) {
      lastTroops = world.troops;
      lastHalfWidth = world.squadHalfWidth;
      const speed = world.scrollSpeed;
      const crossZ = world.squadCenter.z;
      const crossX = world.squadCenter.x;

      if (autoSpawn && !primed) {
        primed = true;
        // Open with the corridor already stacked, the way frame_000 does — the
        // first decision should never be the only thing on screen.
        for (let i = 0; i < PRIME_ROWS; i++)
          autoRow(world.elapsed, SPAWN_Z + i * ROW_GAP, world.troops);
      }

      if (autoSpawn) {
        spawnCarry += speed * dt;
        if (spawnCarry >= ROW_GAP) {
          spawnCarry -= ROW_GAP;
          autoRow(world.elapsed, SPAWN_Z, world.troops);
        }
      }

      for (const row of rows) {
        if (!row.active) continue;
        row.prevZ = row.z;
        row.z += speed * dt;

        if (!row.resolved) {
          // Climb, then resolve — so a gate crossed on the same tick it ticks
          // over pays the number the player just saw, never the stale one.
          for (let i = 0; i < row.count; i++) {
            const seg = row.segments[i];
            if (!seg || !seg.reward || seg.broken) continue;
            if (seg.value < seg.climbMax) {
              seg.value = Math.min(seg.climbMax, seg.value + seg.climbRate * dt);
              applyValue(seg, false);
            }
            // AT THE CEILING IT BREAKS ITSELF. A reward you have poured enough
            // fire into pays out where it stands rather than waiting to be
            // walked into — and breaking it is what unblocks the lane, so the
            // stream flows on to whatever is behind.
            if (seg.value >= seg.climbMax) breakSegment(row, i, seg.centerX, true);
          }
          if (row.z >= crossZ) resolve(row, crossX, world.squadHalfWidth);
        }

        // Debris moves per SEGMENT now, not per row: a blue can break on its own
        // while its neighbours are still standing and still blocking.
        let standing = 0;
        for (let i = 0; i < row.count; i++) {
          const seg = row.segments[i];
          if (!seg) continue;
          if (!seg.broken) {
            standing++;
            continue;
          }
          seg.burst += dt;
          seg.vy -= BURST_GRAVITY * dt;
          seg.group.position.x += seg.vx * dt;
          seg.group.position.y += seg.vy * dt;
          seg.group.position.z += seg.vz * dt;
          seg.group.rotation.x += seg.wx * dt;
          seg.group.rotation.y += seg.wy * dt;
          seg.group.rotation.z += seg.wz * dt;
          if (seg.burst > BURST_LIFE) seg.group.visible = false;
        }

        if (row.smashed) {
          row.burst += dt;
          for (let i = 0; i < row.postCount; i++) {
            const post = row.postState[i];
            if (!post) continue;
            post.vy -= BURST_GRAVITY * dt;
            post.px += post.vx * dt;
            post.py += post.vy * dt;
            post.pz += post.vz * dt;
            post.rx += post.wx * dt;
            post.rz += post.wz * dt;
          }
          writePosts(row);
        } else if (standing === 0) {
          // Every segment shot away before the crowd arrived: nothing left to
          // charge, so retire the row rather than resolving an empty barrier.
          row.resolved = true;
          row.smashed = true;
          row.burst = 0;
        }

        for (let i = 0; i < row.count; i++) {
          const seg = row.segments[i];
          if (seg && seg.pop > 0) seg.pop = Math.max(0, seg.pop - TICK_POP_DECAY * dt);
        }

        if (row.z > RECYCLE_Z || (row.smashed && row.burst > BURST_LIFE)) recycle(row);
      }
    },

    render(alpha, world) {
      const t = world.elapsed;
      for (const row of rows) {
        if (!row.active) continue;
        row.group.position.z = row.prevZ + (row.z - row.prevZ) * alpha;
        for (let i = 0; i < row.count; i++) {
          const seg = row.segments[i];
          if (!seg) continue;
          if (seg.pop > 0) {
            const s = 1 + TICK_POP * seg.pop;
            seg.numeral.scale.set(seg.numeralW * s, seg.numeralH * s, 1);
          } else if (seg.numeral.scale.x !== seg.numeralW) {
            seg.numeral.scale.set(seg.numeralW, seg.numeralH, 1);
          }
          // Twinkle, not spin: a slow counter-rotation plus a breath keeps the
          // reward segment alive without competing with the numeral for the eye.
          if (seg.sparkle.visible) {
            const pulse = 0.42 + 0.16 * Math.sin(t * 6.2 + seg.centerX);
            seg.sparkle.scale.set(pulse, pulse, 1);
            seg.sparkle.rotation.z = t * 1.1;
          }
        }
      }
    },

    setAutoSpawn(enabled) {
      autoSpawn = enabled;
      if (enabled) primed = true;
    },

    spawnRow,

    onResolve(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    shootAt(x, z, pad, amount) {
      let blocked = false;
      for (const row of rows) {
        if (!row.active || row.resolved) continue;
        const dz = z - row.z;
        if (dz > pad + GATE_HIT_DEPTH || dz < -pad - GATE_HIT_DEPTH) continue;
        for (let i = 0; i < row.count; i++) {
          const seg = row.segments[i];
          // A broken segment is a hole in the barrier and lets fire through.
          if (!seg || seg.broken) continue;
          if (x < seg.centerX - seg.halfWidth - pad) continue;
          if (x > seg.centerX + seg.halfWidth + pad) continue;

          // ANY standing segment stops the round, red or blue. A barrier is a
          // physical thing: the stream should visibly end at the nearest one and
          // only reach what is behind it once that has come apart. Fire is a
          // curtain the width of the crowd, so a red walls off ITS lane while
          // the columns either side shoot clean past.
          blocked = true;
          if (!seg.reward) continue;

          if (seg.value < seg.climbMax) {
            seg.value = Math.min(seg.climbMax, seg.value + amount * CLIMB_PER_DAMAGE);
            applyValue(seg, false);
            if (seg.value >= seg.climbMax) breakSegment(row, i, seg.centerX, true);
          }
        }
      }
      return blocked;
    },

    debugValues() {
      const out: number[] = [];
      for (const row of rows) {
        if (!row.active || row.resolved) continue;
        for (let i = 0; i < row.count; i++) {
          const seg = row.segments[i];
          if (seg) out.push(Math.floor(seg.value));
        }
      }
      return out;
    },

    bestLane() {
      let bestZ = -Infinity;
      let target = NaN;
      for (const row of rows) {
        if (!row.active || row.resolved) continue;
        // Rows travel toward the camera, so the nearest pending decision is the
        // one with the largest z.
        if (row.z <= bestZ) continue;

        // SCORE POSITIONS, NOT SEGMENTS.
        //
        // This used to walk the segments and aim at the highest number, which is
        // not how the row resolves and therefore measured a player who does not
        // exist: a crowd is metres wide, it smashes everything it overlaps, and
        // the +9 next to a −14 is a trap. Sweeping candidate positions and
        // scoring each one with the SAME rule `resolve` uses gets both real
        // options — the best segment, and the gap beside the row — out of one
        // loop, and gets them right for the crowd's actual width.
        const half = Math.max(0.15, lastHalfWidth);
        let bestScore = -Infinity;
        let bestX = 0;
        for (let s = 0; s <= LANE_SAMPLES; s++) {
          const x = -CORRIDOR_HALF_WIDTH + (s / LANE_SAMPLES) * CORRIDOR_HALF_WIDTH * 2;
          let score = 0;
          for (let i = 0; i < row.count; i++) {
            const seg = row.segments[i];
            if (!seg || seg.broken) continue;
            const lo = Math.max(x - half, seg.centerX - seg.halfWidth);
            const hi = Math.min(x + half, seg.centerX + seg.halfWidth);
            if (hi - lo >= seg.halfWidth * 2 * CROSS_FRACTION) score += seg.value;
          }
          if (score > bestScore) {
            bestScore = score;
            bestX = x;
          }
        }

        bestZ = row.z;
        target = bestX / CORRIDOR_HALF_WIDTH;
      }
      return target;
    },

    get activeRows() {
      return liveRows;
    },

    nextGateZ() {
      // Rows travel from SPAWN_Z toward the camera, so "nearest" is the LARGEST
      // z. -Infinity means nothing is pending — read it as "infinitely far up".
      let nearest = Number.NEGATIVE_INFINITY;
      for (const row of rows) {
        if (!row.active || row.resolved) continue;
        if (row.z > nearest) nearest = row.z;
      }
      return nearest;
    },

    reset() {
      for (const row of rows) if (row.active) recycle(row);
      spawnCarry = 0;
      primed = false;
    },

    dispose() {
      root.removeFromParent();
      for (const row of rows) {
        row.posts.dispose();
        for (const seg of row.segments) seg.numeralMat.dispose();
      }
      quad.dispose();
      postGeom.dispose();
      postMat.dispose();
      sparkleMat.dispose();
      panelMats.penalty.dispose();
      panelMats.reward.dispose();
      penaltyTex.dispose();
      rewardTex.dispose();
      sparkleTex.dispose();
      for (const tex of numeralCache.values()) tex.dispose();
      numeralCache.clear();
      handlers.clear();
    },
  };

  return system;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A divider post: twin uprights on a footplate, merged into one geometry so an
 * entire row's posts cost a single instanced draw call. Built with its base at
 * y = 0 so an instance transform is just "where on the road".
 */
function buildPostGeometry(): THREE.BufferGeometry {
  const h = GATE_HEIGHT + POST_OVERSHOOT;
  const bar = 0.085;

  const left = new THREE.BoxGeometry(bar, h, 0.16);
  left.translate(-0.105, h / 2, 0);
  const right = new THREE.BoxGeometry(bar, h, 0.16);
  right.translate(0.105, h / 2, 0);
  const foot = new THREE.BoxGeometry(0.46, 0.1, 0.38);
  foot.translate(0, 0.05, 0);

  return concat([left, right, foot]);
}

/**
 * Minimal position/normal/uv concatenation. BufferGeometryUtils would do this,
 * but it lives under three/examples and this is twenty lines — not worth the
 * extra module in the bundle for three boxes merged once at boot.
 */
function concat(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => p.toNonIndexed());
  let verts = 0;
  for (const p of flat) verts += p.getAttribute("position").count;

  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);

  let offset = 0;
  for (const p of flat) {
    const pa = p.getAttribute("position");
    const na = p.getAttribute("normal");
    const ua = p.getAttribute("uv");
    position.set(pa.array as ArrayLike<number>, offset * 3);
    normal.set(na.array as ArrayLike<number>, offset * 3);
    uv.set(ua.array as ArrayLike<number>, offset * 2);
    offset += pa.count;
    p.dispose();
  }
  for (const p of parts) p.dispose();

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.computeBoundingSphere();
  return geom;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/**
 * The barrier's vertical profile, 8×64, stretched across whatever width the
 * segment turns out to be. One texture per colour rather than one per segment:
 * nothing about the look varies horizontally, so the panel is a gradient strip
 * with solid rails top and bottom, and the whole gate costs two textures.
 *
 * Blue is deliberately more opaque than red. In the reference you can read the
 * road through a penalty panel but not through a reward one, and that alone
 * makes the good segment pop before any number is parsed.
 */
function panelTexture(reward: boolean): THREE.CanvasTexture {
  const w = 8;
  const h = 64;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;

  // Spill above and below the rails. Without a bloom pass we cannot afford,
  // this soft bleed onto the road is what actually reads as "glowing".
  ctx.fillStyle = reward ? "rgba(130,215,255,0.34)" : "rgba(255,95,95,0.28)";
  ctx.fillRect(0, 0, w, 3);
  ctx.fillRect(0, h - 3, w, 3);

  const body = ctx.createLinearGradient(0, 3, 0, h - 3);
  if (reward) {
    body.addColorStop(0, "rgba(104,184,255,0.96)");
    body.addColorStop(0.55, "rgba(40,116,238,0.92)");
    body.addColorStop(1, "rgba(28,84,214,0.95)");
  } else {
    body.addColorStop(0, "rgba(244,72,78,0.74)");
    body.addColorStop(0.55, "rgba(214,34,46,0.58)");
    body.addColorStop(1, "rgba(228,50,58,0.72)");
  }
  ctx.fillStyle = body;
  ctx.fillRect(0, 3, w, h - 6);

  ctx.fillStyle = reward ? "#7fd8ff" : "#ff4a4a";
  ctx.fillRect(0, 3, w, 7);
  ctx.fillRect(0, h - 9, w, 6);

  // A single bright line under the top rail. At phone scale a proper bevel is
  // sub-pixel; one lit edge survives minification and still reads as metal.
  ctx.fillStyle = reward ? "rgba(226,248,255,0.85)" : "rgba(255,196,196,0.72)";
  ctx.fillRect(0, 10, w, 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * THE READABILITY RULE, in one function. White fill, thick black outline, heavy
 * weight, shrink-to-fit so a three-character value never overruns its segment.
 *
 * The white stroke between the outline and the fill is deliberate: 'Arial
 * Black' does not exist on iOS, and a plain 900-weight fallback comes out
 * noticeably thinner than the reference. Stroking white on top of the black
 * outline fattens the glyph back up on every platform.
 */
function numeralTexture(cache: Map<string, THREE.CanvasTexture>, value: number): THREE.CanvasTexture {
  const label = value > 0 ? `+${value}` : `${value}`;
  const cached = cache.get(label);
  if (cached) return cached;

  const w = 256;
  const h = 128;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;

  let size = 100;
  const font = (px: number): string =>
    `900 ${px}px "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.font = font(size);
  const maxWidth = 208;
  while (ctx.measureText(label).width > maxWidth && size > 40) {
    size -= 4;
    ctx.font = font(size);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.lineWidth = Math.max(16, size * 0.24);
  ctx.strokeStyle = "#0a0a10";
  ctx.strokeText(label, w / 2, h / 2 + 2);

  ctx.lineWidth = Math.max(6, size * 0.09);
  ctx.strokeStyle = "#ffffff";
  ctx.strokeText(label, w / 2, h / 2 + 2);

  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, w / 2, h / 2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Mipmaps ON, unlike the panel strip. A far-corridor numeral is minified hard
  // and unfiltered text shimmers — which is the readability failure, one row up.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  cache.set(label, tex);
  return tex;
}

/** Four-point star for the reward segment's corner accent. */
function sparkleTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d")!;

  const core = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 3.4);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.35, "rgba(190,238,255,0.6)");
  core.addColorStop(1, "rgba(120,200,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, s, s);

  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate((i * Math.PI) / 2);
    ctx.beginPath();
    ctx.moveTo(0, -s / 2 + 2);
    ctx.lineTo(4.5, 0);
    ctx.lineTo(-4.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weightOf(spec: number | GateSegmentSpec | undefined): number {
  if (spec === undefined) return 1;
  if (typeof spec === "number") return 1;
  return spec.weight ?? 1;
}

/**
 * Seeded PRNG. Spawn variety and burst jitter both run through it so the whole
 * module obeys loop.ts's rule: the same run pays the same on any device.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
