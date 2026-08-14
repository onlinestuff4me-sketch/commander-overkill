/**
 * PLAYER SQUAD — the crowd of troops, and the single most-looked-at thing on
 * screen.
 *
 * The reference (`docs/reference/REFERENCE.md`, frames 000/009/018/023/030/035)
 * is a LOOSE CLUMP, never a grid: a rough ellipse wider than it is deep, units
 * overlapping, the outline ragged because edge units drift out and trail. Every
 * layout decision below exists to reproduce that read, and the ones that are
 * not obvious are commented where they are made.
 *
 * ---------------------------------------------------------------------------
 * API — what the orchestrator drives and reads
 * ---------------------------------------------------------------------------
 *
 *   const squad = createSquad(stage.scene);
 *
 *   squad.update(dt, world)   // fixed 60Hz; syncs to world.troops, WRITES
 *                             // world.squadCenter (this system owns it)
 *   squad.render(alpha, world) // per frame; idempotent for a given alpha
 *   squad.dispose()
 *
 *   squad.setCount(n)   // clamped to [0, MAX_TROOPS]. Convenience for lil-gui
 *                       // and tests — `world.troops` is the real authority and
 *                       // re-asserts itself on the next update().
 *   squad.getCount()    // units currently alive (excludes ones fading out)
 *
 *   squad.center        // THREE.Vector3, live blob centre. Do not mutate.
 *   squad.radiusX       // half-width  of the clump ellipse, world units
 *   squad.radiusZ       // half-depth  of the clump ellipse, world units
 *   squad.radius        // max(radiusX, radiusZ) — for anyone who wants one number
 *
 *   squad.sampleShooters(out, max)  // fills preallocated Vector3s with muzzle
 *                                   // positions from the front rank, returns
 *                                   // how many were written. O(n), no alloc.
 *                                   // For the bullets/VFX systems.
 *
 * Growth: raise `world.troops`. New slots appear AT THE BLOB EDGE and pop in,
 * and every existing unit's target shifts inward, so the whole mass settles —
 * which is the beat `frame_023` is built around. The `+1` floaters are the
 * growth team's; the unit actually appearing is ours.
 *
 * ---------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------
 * Four draw calls total at any troop count: one InstancedMesh for the whole
 * body (all parts merged into one vertex-coloured geometry), one for the drop
 * shadows, two for the HP bar. 181 triangles per unit, so 1200 troops is
 * ~217k tris in a single instanced call — vertex work a phone eats for
 * breakfast. All per-unit state lives in preallocated typed arrays and nothing
 * in update()/render() allocates.
 */

import * as THREE from "three";
import { CORRIDOR_HALF_WIDTH, laneToX } from "../mechanics/lane";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";
import { MAX_TROOPS } from "../core/types";
import type { System, WorldState } from "../core/types";

// ---------------------------------------------------------------------------
// TUNABLES
// ---------------------------------------------------------------------------

/**
 * Whole-unit size multiplier. Calibrated against the road, not against taste:
 * `frame_000`'s lone soldier measures ~0.6 m wide and ~1.4 m tall on a 6.8 m
 * road, and the raw geometry below is 0.55 × 1.39. Get this wrong and a
 * 45-strong clump reads as ants no matter how good the layout is.
 */
const UNIT_SCALE = 1.05;

/**
 * Clump half-width grows with sqrt(count) because a crowd spreads over AREA,
 * not length.
 *
 * CALIBRATED FROM DENSITY, NOT FROM A SPAN. Two earlier cuts both calibrated
 * this against a measured WIDTH, and both were wrong, in opposite directions,
 * for the same reason: a span you read off a frame is not the ellipse's
 * semi-axis, and a span you read off a frame is not even a world measurement.
 * Density is the invariant worth matching, because it is what legibility
 * actually depends on.
 *
 * MEASURED ACROSS THE REFERENCE FRAMES (helmet diameter used as the ruler, so
 * the numbers are free of any assumption about the reference's camera):
 *   - Per-unit screen size is CONSTANT: helmets are ~45 px at ~20 troops
 *     (`frame_018`) and ~44 px at ~60 (`frame_035`). Units do not shrink to fit.
 *   - Nearest-neighbour spacing is CONSTANT at ~1.0–1.1 helmet diameters, i.e.
 *     one body width, i.e. ~0.58 m. It does NOT tighten as the army grows.
 *   - Constant density means area ∝ n, so BOTH axes grow as sqrt(n). The crowd
 *     does not grow width-first; it grows proportionally until the road stops it.
 *   - Widening stops at ~11 abreast, and the reference does not deepen past
 *     that — it SPLITS (see the divergence note on RADIUS_X_MAX).
 *
 * So this constant is set by the spacing it produces, not by a width:
 * spacing = SPREAD * sqrt(PI * DEPTH_RATIO / 0.866). At 0.28 with the depth
 * ratio below that is 0.67 m, converging to 0.61 m by 50 units as the width cap
 * bites — against the reference's 0.58 m. Slightly looser than the reference on
 * purpose: our camera is shallower (see DEPTH_RATIO), so the same world spacing
 * buys less visible separation and has to be paid for in metres.
 */
const SPREAD = 0.28;
/**
 * Extra width at tiny counts, decaying as 1/n. Three soldiers do not pack — the
 * reference's three (`frame_009`) stand ~1.2 m apart, twice the spacing its
 * 50-strong clump uses, so density is not constant at the bottom of the curve.
 * Applied to width only, so small squads read as a rank rather than a huddle.
 * Below 3% by 100 units.
 */
const SMALL_SQUAD_FLARE = 3.0;
/**
 * Depth:width of the ellipse, IN WORLD SPACE — and it is greater than 1, which
 * looks wrong next to "the silhouette is wider than it is deep" until you
 * account for the camera.
 *
 * Every "N deep by M wide" note taken off a reference frame, including this
 * project's own "~5 deep by 9 wide", is a SCREEN reading. This camera sits only
 * 22° above the horizon, so a metre of world depth covers 0.375 of the screen
 * that a metre of world width does. Measuring the reference's own crowds in
 * helmet diameters and dividing out its (much steeper, ~43°) camera puts its
 * blob at roughly 1:1 in world space — near circular, and "wider than deep"
 * purely as a projection artefact. To land the same ~1.5:1 on-screen read from
 * 22° we need the world ellipse to run about 1.6:1 the other way. Feeding a
 * screen ratio in here as a world ratio is what made the clump a flat rank.
 */
const DEPTH_RATIO = 1.6;
/** Hard cap on half-depth, derived from the framing budget rather than picked:
 *  the camera's bottom edge lands at z ≈ +2.8, and SQUAD_Z + rz*(1+jitter) +
 *  the edge-jitter and straggler budget has to stay inside it or the rear rank
 *  walks off the bottom of the screen. Solving that for rz gives 3.05. It used
 *  to read 3.2, which was already 0.15 over budget and only never showed
 *  because the old flat DEPTH_RATIO never reached it below ~330 units. */
const RADIUS_Z_MAX = 3.05;
/** Where the clump sits down the corridor. Bottom third of the frame. */
const SQUAD_Z = -1.6;

/** Per-unit target jitter, world units. This is what makes the edge ragged
 *  instead of a clean ellipse — the single biggest "is it a grid?" tell. */
const EDGE_JITTER = 0.26;
/** Peak-to-peak spread on a slot's radial position, as a fraction of its ring
 *  radius. Named rather than inlined because the containment maths below has to
 *  know how far past the ellipse a rim unit can be asked to stand. */
const RADIAL_JITTER = 0.34;
/** Share of that jitter the units at the very centre get. The reference clump
 *  is packed in the middle and loose at the rim, and applying jitter flat makes
 *  a solo soldier wander off the lane line for no reason. */
const CORE_TIGHTNESS = 0.35;
/** Fraction of units that are stragglers: pushed further out and trailing. */
const STRAGGLER_FRACTION = 0.18;
/** How far a straggler trails behind the clump (+Z is away from the enemy). */
const STRAGGLER_TRAIL = 0.55;

/**
 * Position spring — this is the steering feel, and it is worth being precise
 * about what it costs.
 *
 * Stiffness is an undamped frequency: w = sqrt(K), and a near-critically damped
 * spring settles to 2% in about 5.8/w. The first cut ran K=34, so w=5.8 rad/s
 * and the crowd took 0.77 s to arrive — most of a second of drifting after the
 * thumb had already stopped. That is the sluggishness; it was never the input
 * layer alone.
 *
 * K=620 puts w at 24.9 and the settle at 0.27 s, which is fast enough that the
 * lead units are visibly moving on the frame the input arrives. Stability is not
 * a concern at this stiffness: update() integrates semi-implicitly (velocity
 * first, then position from the new velocity), which is stable while w*dt < 2,
 * and the stiffest unit here sits at 0.5.
 */
const SPRING_K = 620;
/**
 * Just under critical. At 0.98 the theoretical overshoot is e^-15, i.e. none —
 * the crowd cannot bounce past the target and oscillate. The jostle and the
 * spread below supply the life that underdamping used to; bounce is not the
 * same thing as life, and at this stiffness it would read as a wobble.
 */
const SPRING_DAMPING_RATIO = 0.98;
/**
 * Per-unit stiffness spread, and the thing that keeps the mass DEFORMING rather
 * than translating as a slab now that everyone is fast. At ±50% the settle time
 * runs 0.37 s for the laziest unit against 0.23 s for the keenest, so the blob
 * still visibly stretches on the way and gathers up on arrival — the character
 * the low stiffness used to buy, at a third of the delay.
 */
const SPRING_K_SPREAD = 0.5;

/** Slow lateral/forward wander so the mass never looks frozen when standing still. */
const JOSTLE_AMPLITUDE = 0.07;
const JOSTLE_RATE = 1.3;
/** Slack the containment maths leaves for the spring. At damping ratio 0.86 the
 *  step overshoot is only ~0.5%, but the centre moves continuously, so units
 *  settle from behind and can tick a little past their target on arrival. */
const SPRING_SLACK = 0.06;

/** Seconds a dying soldier takes to topple and sink out of sight. Long enough
 *  to read as a body falling, short enough that a big loss does not leave the
 *  road littered while the next decision arrives. */
const FALL_TIME = 0.7;
/** Fraction of the fall spent at full size before the unit starts shrinking. */
const FALL_HOLD = 0.55;
/** Radians the body rotates as it goes down. Slightly past flat, so it lands
 *  rather than balancing on its face. */
const FALL_ANGLE = Math.PI * 0.62;
/** Metres it sinks, which is what removes it once it is flat. */
const FALL_SINK = 1.1;
/** Topple about world X — away from the camera, so the fall is legible at this
 *  shallow angle instead of happening edge-on. */
const FALL_AXIS = new THREE.Vector3(1, 0, 0);
/** Ceiling on queued spawn/death reports between drains. Matches the floater
 *  burst cap: past this the eye cannot follow individual units anyway. */
const MAX_QUEUE = 64;

/**
 * PER-INSTANCE TINT, and why the topple alone was not enough.
 *
 * A dying unit already fell over and sank. Playtesting said it still read as
 * "the crowd shuffled" rather than "I lost men", and the reason is arithmetic
 * rather than animation: a body toppling among sixty identical bodies changes
 * about one part in sixty of the silhouette, over half a second, at a camera
 * angle that foreshortens the fall. Nothing about the motion is wrong — there is
 * simply not enough of it to see.
 *
 * Colour is the one channel that is still free. `instanceColor` MULTIPLIES the
 * baked vertex colours, so one float3 per unit repaints a whole soldier without
 * a second material, a second draw call or a shader of our own. A dying man goes
 * crimson within a sixth of a second and then falls; the flash is what you
 * notice, and the fall is what tells you what the flash meant.
 *
 * These are multipliers, not colours. The cream shirt (the biggest bright area
 * on a unit) is what carries each of them; the helmet goes along for the ride.
 */
const DEATH_TINT = [1.9, 0.25, 0.2] as const;
/** How fast the death tint arrives, as a multiple of the fall's own rate. 4 puts
 *  full crimson at 0.18 s — before the body has visibly started to lean, so the
 *  flash leads the motion instead of confirming it. */
const DEATH_TINT_RAMP = 4;

/**
 * ELITES — the recruits pulled off barrels, and the first troops in this game
 * that are not interchangeable with every other troop.
 *
 * Two cues, because either alone is ambiguous at 40 px: gold, and BIGGER. Size
 * on its own reads as "nearer" from a camera this shallow, and colour on its own
 * gets lost when the crowd is deep. Together they are unmistakable, and both are
 * free — the tint rides the instance colour and the scale rides the matrix that
 * was already being composed.
 *
 * The tint DARKENS as well as warms, which is not the obvious choice. The shirt
 * is already a near-white cream, so a bright gold multiplier clips it straight
 * to acid yellow and the unit loses all its shading — six of them at the centre
 * of the blob read as one flat yellow slab rather than as six soldiers. Pulling
 * the multiplier under 1 on green and hard down on blue lands an amber that
 * still has form in it.
 */
const ELITE_TINT = [1.22, 0.86, 0.3] as const;
const ELITE_SCALE = 1.34;

/**
 * CARRIERS — troops wearing a minigun or a rocket launcher.
 *
 * A weapon pickup used to be a multiplier on a chip and nothing else, which
 * Mischa put plainly: getting a rocket launcher with a 10 on it should mean ten
 * soldiers are carrying rocket launchers and firing rockets. So the weapon is
 * drawn, on those soldiers, as its own instanced mesh riding the carrier's
 * shoulder — the body underneath is an ordinary soldier, which keeps it to one
 * extra draw call per weapon kind instead of a second body geometry per type.
 *
 * The tints are multipliers on the baked vertex colours (see DEATH_TINT); they
 * are subtler than the elite gold because the weapon on the shoulder is already
 * doing the identifying, and three loud colours in one crowd is mush.
 */
const GUNNER_TINT = [0.86, 0.96, 1.18] as const;
const ROCKETEER_TINT = [1.16, 0.9, 0.78] as const;
/** Where a shouldered weapon sits, in unmodified unit space. Level with the
 *  helmet so it breaks the crowd's outline from above, which is the only angle
 *  this camera really has. */
const KIT_X = -0.2;
const KIT_Y = 1.16;
const KIT_Z = 0.06;

/** Run-in-place bob. abs(sin) doubles the rate, so ~2.7 footfalls/second. */
const BOB_HEIGHT = 0.105;
const BOB_RATE = 8.5;
/** Per-unit rate spread — without it the whole mass pulses in sync and reads as
 *  one breathing object rather than a crowd. */
const BOB_RATE_SPREAD = 0.22;

/** Pop-in spring for newly added units. Underdamped on purpose: it overshoots
 *  ~10% so the unit lands with a snap instead of inflating. */
const POP_K = 260;
const POP_C = 26;

/** The gradient fades to nothing at the rim, so the disc that actually reads is
 *  ~70% of this — sized to land just under a soldier's shoulders. */
const SHADOW_RADIUS = 0.4;
const SHADOW_OPACITY = 0.4;
/** Slight offset toward camera-right. The scene key light would technically
 *  throw the shadow up-screen, where the unit's own body hides it — and a
 *  shadow you cannot see does not seat anything. This matches the reference
 *  frames instead; flip the signs here if the art direction ever settles. */
const SHADOW_OFFSET_X = 0.11;
const SHADOW_OFFSET_Z = 0.1;

/** No bar on a handful of troops — `frame_009` (3 units) has none, `frame_023`
 *  (45) does. */
const HP_BAR_MIN_TROOPS = 10;
const HP_BAR_WIDTH = 1.25;
const HP_BAR_HEIGHT = 0.15;
const HP_BAR_Y = 2.05;

/** How fast the blob centre chases the steering input. This is a first-order
 *  lag stacked on top of the per-unit springs, so its cost is additive: at 12 it
 *  spent 0.30 s reaching a new lane before a single soldier had finished
 *  arriving. At 30 that is 0.10 s and the centre is effectively tracking the
 *  thumb, which leaves ALL the visible lag where it belongs — in the units, who
 *  deform as they follow. */
const CENTER_FOLLOW = 30;

/**
 * TOP LATERAL SPEED, and the reason strategy exists in this game at all.
 *
 * The lag above is a TIME CONSTANT, not a speed limit, so the crowd reached any
 * point on the road in about a tenth of a second no matter how far away it was.
 * Position therefore cost nothing, and anything that costs nothing cannot be
 * traded against anything else: with rows 11–16 m apart (1.8–2.7 s at the
 * default scroll) the player could take the best segment of every row on the
 * board, on both kerbs, in any order. That — not the road's width — is why a
 * playtester reported having no meaningful decisions to make. Widening the road
 * alone would only have given them a bigger free-travel area.
 *
 * A speed cap turns the road into a distance again. At 7 m/s a full crossing of
 * the 11.2 m road takes 1.6 s, which is most of the gap between two placements:
 * two prizes on opposite kerbs one row apart are now genuinely exclusive, and
 * two on the same side are still free. That ratio — crossing time against
 * placement spacing — is the dial the whole strategic layer turns on. If either
 * `SPACING` in mechanics/director.ts or `scrollSpeed` moves, this moves with it.
 *
 * AND A BIG ARMY IS A JUGGERNAUT. A thousand men do not change lanes like three,
 * and making that literal gives crowd size its first real cost: past
 * `MASS_TROOPS` the cap eases down toward `MASS_SPEED`, so the late game is
 * played by committing early rather than by darting. Kept mild — this is meant
 * to add weight, not to take the controls away.
 */
const LATERAL_SPEED = 7;
const MASS_TROOPS = 400;
const MASS_SPEED = 5;
/**
 * Metres/second² the centre gains and sheds speed at. Without it the cap is a
 * hard clamp, so the crowd snaps from stationary to full speed and back and the
 * weight the cap is supposed to add never reads. At 34 the crowd is at full
 * lateral speed in ~0.2 s — a lean into the turn, not a delay.
 */
const LATERAL_ACCEL = 34;

/**
 * Uniform, straight off the reference: blue helmet, cream shirt, navy trousers.
 * The cream/blue/navy contrast is the whole reason a player can tell their own
 * crowd from the tan/brown enemies at a glance, so the shirt is the one colour
 * on this unit that is not allowed to drift.
 *
 * WHY THE SHIRT IS AUTHORED AS A PEACH AND NOT AS A CREAM. These are vertex
 * colours on a Lambert material, so what lands on screen is albedo × irradiance,
 * and the scene's irradiance is not white. `renderer.ts` fills with
 * `HemisphereLight(0xcfefff, 0x4a7a3a, 1.5)` — a GREEN ground bounce — and
 * deliberately puts the key light up-screen so it backlights the crowd. Every
 * surface the camera can see therefore gets sky+ground fill and, on the up-facing
 * shoulders that carry the read, irradiance works out to roughly
 * (0.84, 0.95, 1.02): 14% greener and 21% bluer than neutral. An honest cream
 * albedo (the old 0xe8dcbc) comes out the far side at #D7D7BE — the grey-green
 * olive that was on screen. Pre-dividing the target cream by that irradiance is
 * what gives 0xffe4c2, which renders as #ECE0C4. If the lighting in
 * `renderer.ts` ever loses its green ground bounce, re-derive this — do not
 * hand-tweak it.
 */
const COLOR_HELMET = 0x3f8ede;
const COLOR_SHIRT = 0xffe4c2;
const COLOR_TROUSERS = 0x242f57;
/** The only near-black on the unit. In a packed clump the boots are what tell
 *  one pair of legs from the next. */
const COLOR_BOOT = 0x15171d;
const COLOR_SKIN = 0xe8b98c;
/** The reference's rifles read pale, but the reference draws a dark outline
 *  around every weapon and we do not. Without that outline the only thing
 *  separating a rifle from what is behind it is value — and what is behind it,
 *  from this camera, is mostly the cream shoulders of the rank in front. A pale
 *  barrel on a cream shoulder is invisible. This renders #667385 against the
 *  shoulders' #ecdfc4, which reads against cream, against the blue helmets and
 *  against the road. Wood stock behind it for the reference's two-tone. */
const COLOR_RIFLE_METAL = 0x6f7684;
const COLOR_RIFLE_WOOD = 0x7a4f2c;

/** Carried-weapon palette. Matched to the pickups that grant them so the object
 *  you shot off a barrel is recognisably the object now on a soldier's back. */
const KIT_GUNMETAL = 0x4a5568;
const KIT_STEEL = 0x9aa6ba;
const KIT_BRASS = 0xd8a13a;
const KIT_WARHEAD = 0xd8452f;

/** Baked-in forward lean. Costs nothing at runtime (it is part of the merged
 *  geometry) and does most of the work of selling "running" that a vertical bob
 *  alone cannot. */
const BODY_LEAN = 0.12;

// ---------------------------------------------------------------------------
// CONTAINMENT — what the crowd is allowed to overflow
//
// This used to enforce "no unit stands on the grass", derived from three
// margins: the blob's own reach, the unit's body width, and the perspective
// error that puts a standing soldier's shoulders further from the centreline
// than his boots. It was correct, and it produced a crowd that could not grow
// and could not steer — at 50 troops the centre had ±0.50 m of a 6.8 m road.
//
// `reference-media/reference-clip-1a.mov` settles it: that crowd is as wide as
// its carriageway, is frequently cut off by the edge of the SCREEN, and steers
// by moving its centre to the very edge of the road with half the army hanging
// over the shoulder. Overflow is the design, not a defect to be clamped out.
//
// What survives is a backstop (`UNIT_OVERHANG_LIMIT`) that stops a spring from
// throwing a unit clear of the world during a hard steer.
// ---------------------------------------------------------------------------

/** Raw-geometry half-width of the widest part of a unit, and how high that
 *  widest part sits. Both are the shoulder yoke's top corners, and the geometry
 *  below is built FROM these rather than measured against them, so the two
 *  cannot drift apart.
 *
 *  0.29 puts a soldier at 0.609 m across once UNIT_SCALE is applied, which is
 *  the 0.58–0.60 m `REFERENCE.md` measures and the number its "~11 fit abreast
 *  on a 6.8 m road" figure is built on. The first pass at this geometry drifted
 *  to 0.672 m while fitting a rifle and arms on, and 12% of extra width costs
 *  23% of the packing capacity — enough on its own to turn a legible crowd into
 *  a slab. The rifle is deliberately NOT in this number: angled out for
 *  legibility its muzzle reaches 0.49 m from a soldier's centre, 1.7x his own
 *  half-width, and it is a weapon overhanging a crowd rather than part of the
 *  body being packed. */
const UNIT_HALF_WIDTH = 0.29;
const UNIT_SHOULDER_Y = 1.07;

/**
 * Hard cap on half-width: the crowd may grow until it spans the whole road.
 *
 * ~2.5, i.e. ~8 abreast in the ellipse's core and past 13 across the widest
 * rank once jitter is counted — reached at ~120 units instead of ~30. It was
 * ~1.63, because it used to be "whatever is left of the road after reserving
 * steering room and keeping every body inside the kerb". Both of those
 * reservations are gone (see the CONTAINMENT note above), so this is now set by
 * the road itself, minus only the jitter that sits on top of the ellipse.
 *
 * WIDTH IS NOW A WEAPON, not just a silhouette. Fire travels as a parallel
 * curtain (`convergeDistance` is 0 in mechanics/bullets.ts), so a crowd this
 * wide covers several barrel lanes at once while a small one drills a single
 * hole. Growing the army visibly widens what it can shoot, which is the
 * mechanic `reference-clip-1a.mov` is built on.
 *
 * DEPTH IS THE ONE THAT IS STILL PINNED. `RADIUS_Z_MAX` is a framing budget,
 * not a road budget: the camera's bottom edge lands at z ≈ +2.8 and the rear
 * rank walks off the screen past that. So the crowd grows both ways until ~120
 * units and then can only grow backwards into a wall it has already reached.
 * That is precisely why the camera has to step back — see `core/zoom.ts`.
 */
const RADIUS_X_MAX =
  (CORRIDOR_HALF_WIDTH - EDGE_JITTER - JOSTLE_AMPLITUDE - SPRING_SLACK) /
  (1 + RADIAL_JITTER / 2);

/**
 * How far the crowd's CENTRE may travel from the centreline.
 *
 * The full road half-width, so the player can put the middle of the army on the
 * kerb and let half of it hang over the shoulder — which is exactly what the
 * reference clip does, repeatedly and on purpose, and what "move the group all
 * the way to the edge" means. The previous rule (`UNIT_X_LIMIT` minus the
 * crowd's own half-extent) meant a big crowd could barely move at all: at 50
 * troops the centre had ±0.50 m of a 6.8 m road, which reads as a broken
 * control rather than as a heavy army.
 *
 * The overhang is bounded by the crowd's own width rather than by a clamp, so
 * "how much army is off the road" stays a consequence of how big it is.
 */
const CENTER_X_LIMIT = CORRIDOR_HALF_WIDTH;

/**
 * How far a single unit may end up from the centreline — the centre at full
 * lock, plus the crowd's own reach on top. Bodies past the kerb are now
 * expected rather than prevented (`UNIT_X_LIMIT` is what "inside the kerb"
 * would have meant, and is kept for the shadow and containment maths), so this
 * is only a backstop against a spring flinging a unit off the world during a
 * hard steer.
 */
const UNIT_OVERHANG_LIMIT =
  CENTER_X_LIMIT + RADIUS_X_MAX * (1 + RADIAL_JITTER / 2) + EDGE_JITTER + JOSTLE_AMPLITUDE;

/** Vogel/sunflower spiral. Consecutive slots land ~137.5° apart, so any prefix
 *  of the slot order is already spatially spread — which is what makes
 *  `sampleShooters` cheap and what stops new units clustering on one side. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * Warps the spiral's angles toward ±X, so slots cluster left-and-right rather
 * than fore-and-aft. Squashing the ellipse alone only produces a wide
 * silhouette once there are enough units to fill it — at three troops the shape
 * is whatever three samples happened to land on. This biases the sampling
 * itself, so "wider than deep" holds from the very first reinforcement.
 * Negative = denser near 0° and 180°. Precomputed, so it costs nothing.
 */
const ANGLE_WIDTH_BIAS = -0.35;

// ---------------------------------------------------------------------------

export interface SquadSystem extends System {
  /** Live blob centre in world space. Read-only — mutating it desyncs the sim. */
  readonly center: THREE.Vector3;
  /** Half-width of the clump ellipse, world units. */
  readonly radiusX: number;
  /** Half-depth of the clump ellipse, world units. */
  readonly radiusZ: number;
  /** Whichever of the two is larger, for callers that want a single number. */
  readonly radius: number;
  /** Units currently alive. Excludes units still fading out. */
  getCount(): number;
  /** Clamped to [0, MAX_TROOPS]. `world.troops` re-asserts on the next update(). */
  setCount(n: number): void;
  /**
   * Muzzle positions sampled evenly across the WHOLE blob — one per soldier up
   * to `max`, strided so the sample spans the full ellipse rather than its
   * innermost units. Writes into the caller's preallocated vectors and returns
   * how many were filled. O(n), no allocation.
   *
   * Index `k` maps to a stable soldier for a given count, so callers may treat
   * `k` as a persistent stream identity.
   */
  sampleShooters(out: THREE.Vector3[], max: number): number;

  /**
   * What each sampled shooter is CARRYING, written into `kinds` alongside the
   * positions `sampleShooters` wrote: 0 rifle, 1 minigun, 2 rocket launcher.
   *
   * On the API because a rocketeer has to fire rockets, and the bullet system
   * has no way to know which of its streams belongs to one. The index matches
   * `sampleShooters` exactly — same `k`, same soldier — so the two calls can be
   * made back to back against the same buffers.
   */
  sampleShooterKinds(kinds: Uint8Array, max: number): number;

  /**
   * Positions of units that APPEARED since the last call, drained.
   *
   * So a `+1` can be drawn over the soldier it is counting rather than
   * scattered somewhere plausible. The two were unrelated before, which made
   * the payout read as a particle effect that happened to coincide with the
   * crowd getting bigger — the point of one floater per unit is that you can
   * follow each one to a body.
   */
  takeSpawns(out: THREE.Vector3[], max: number): number;
  /** Positions of units that STARTED DYING since the last call, drained. */
  takeDeaths(out: THREE.Vector3[], max: number): number;
}

export function createSquad(scene: THREE.Scene): SquadSystem {
  return new Squad(scene);
}

class Squad implements SquadSystem {
  readonly center = new THREE.Vector3(0, 0, SQUAD_Z);

  #scene: THREE.Scene;
  #disposed = false;

  // --- meshes ---
  #body: THREE.InstancedMesh;
  #shadow: THREE.InstancedMesh;
  #barGroup: THREE.Group;
  #barFill: THREE.Mesh;
  #shadowTexture: THREE.CanvasTexture;

  // --- counts ---
  #count = 0;
  /** Highest slot index that still needs drawing, including units fading out. */
  #high = 0;

  // --- clump shape, recomputed only when the count changes ---
  #radiusX = 0;
  #radiusZ = 0;
  #shapedFor = -1;
  #shapedAtZoom = 1;
  /** 0 alive, ramping to 1 as a dying unit topples. Drives the fall in render. */
  #fall = new Float32Array(MAX_TROOPS);
  /** Slots that appeared / began dying this tick, drained by the orchestrator. */
  #spawnQueue: number[] = [];
  #deathQueue: number[] = [];
  /**
   * Live counts of each special job, clamped so they fit the crowd.
   *
   * They share ONE strided sequence of slots — elites first, then gunners, then
   * rocketeers — so no soldier is ever handed two jobs and the three groups stay
   * mixed evenly through the crowd rather than clumping by type.
   */
  #elites = 0;
  #gunners = 0;
  #rocketeers = 0;
  /** Slots `0, stride, 2·stride, …` hold the specials. See the note in update(). */
  #eliteStride = 1;
  /** Weapon meshes, drawn at the carriers' shoulders. */
  #gunnerKit: THREE.InstancedMesh;
  #rocketKit: THREE.InstancedMesh;

  // --- centre steering ---
  #centerX = 0;
  #prevCenterX = 0;
  /** Metres/second the centre is sliding at. Integrated rather than derived so
   *  the speed cap and the acceleration ramp have something to act on. */
  #centerVel = 0;

  /** Own clock rather than world.elapsed. The bob is the one thing that must
   *  never stop, and it should not depend on another system remembering to
   *  advance a shared field. */
  #time = 0;

  // --- per-slot constants, seeded once so unit identity is stable ---
  #slotAngle = new Float32Array(MAX_TROOPS);
  #slotRadialJitter = new Float32Array(MAX_TROOPS);
  #slotJitterX = new Float32Array(MAX_TROOPS);
  #slotJitterZ = new Float32Array(MAX_TROOPS);
  #slotTrail = new Float32Array(MAX_TROOPS);
  #slotSpringK = new Float32Array(MAX_TROOPS);
  #slotBobPhase = new Float32Array(MAX_TROOPS);
  #slotBobRate = new Float32Array(MAX_TROOPS);
  #slotJostlePhase = new Float32Array(MAX_TROOPS);

  // --- per-slot sim state (double-buffered for render interpolation) ---
  #posX = new Float32Array(MAX_TROOPS);
  #posZ = new Float32Array(MAX_TROOPS);
  #prevX = new Float32Array(MAX_TROOPS);
  #prevZ = new Float32Array(MAX_TROOPS);
  #velX = new Float32Array(MAX_TROOPS);
  #velZ = new Float32Array(MAX_TROOPS);
  #bob = new Float32Array(MAX_TROOPS);
  #prevBob = new Float32Array(MAX_TROOPS);
  #pop = new Float32Array(MAX_TROOPS);
  #prevPop = new Float32Array(MAX_TROOPS);
  #popVel = new Float32Array(MAX_TROOPS);
  #live = new Uint8Array(MAX_TROOPS);

  // --- scratch, reused every frame; nothing here is ever reallocated ---
  #m = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scl = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.#scene = scene;

    const rand = mulberry32(0x5eed);
    for (let i = 0; i < MAX_TROOPS; i++) {
      // Golden-angle base, warped toward the road's width, plus a wide jitter:
      // the pure spiral is beautifully even, and "beautifully even" is exactly
      // the grid look we are avoiding.
      const spiral = i * GOLDEN_ANGLE;
      this.#slotAngle[i] =
        spiral + ANGLE_WIDTH_BIAS * Math.sin(2 * spiral) + (rand() - 0.5) * 1.1;
      this.#slotRadialJitter[i] = (rand() - 0.5) * RADIAL_JITTER;
      this.#slotJitterX[i] = (rand() - 0.5) * 2 * EDGE_JITTER;
      this.#slotJitterZ[i] = (rand() - 0.5) * 2 * EDGE_JITTER;
      this.#slotTrail[i] = rand() < STRAGGLER_FRACTION ? rand() * STRAGGLER_TRAIL : 0;
      this.#slotSpringK[i] = SPRING_K * (1 + (rand() - 0.5) * 2 * SPRING_K_SPREAD);
      this.#slotBobPhase[i] = rand() * Math.PI * 2;
      this.#slotBobRate[i] = BOB_RATE * (1 + (rand() - 0.5) * 2 * BOB_RATE_SPREAD);
      this.#slotJostlePhase[i] = rand() * Math.PI * 2;
    }

    // --- body: every part merged into one vertex-coloured geometry ---
    this.#body = new THREE.InstancedMesh(
      buildSoldierGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
      MAX_TROOPS,
    );
    this.#body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances are spread across the road; the base geometry's bounding sphere
    // sits at the origin, so three would cull the whole crowd on a hard turn.
    this.#body.frustumCulled = false;
    this.#body.count = 0;
    // Allocate the tint buffer up front and fill it with the identity (white =
    // multiply by 1). Doing it here rather than on the first death matters: the
    // attribute's existence is what compiles USE_INSTANCING_COLOR into the
    // shader, and a material recompile mid-run is a frame hitch on a phone.
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAX_TROOPS; i++) this.#body.setColorAt(i, white);
    this.#body.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.#body);

    // One instanced mesh per weapon kind, drawn at its carriers' shoulders. Two
    // draw calls for every carrier on screen, and only when there are any.
    const kitMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.#gunnerKit = new THREE.InstancedMesh(buildMinigunKit(), kitMat, MAX_TROOPS);
    this.#rocketKit = new THREE.InstancedMesh(buildRocketKit(), kitMat, MAX_TROOPS);
    for (const kit of [this.#gunnerKit, this.#rocketKit]) {
      kit.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      kit.frustumCulled = false;
      kit.count = 0;
      scene.add(kit);
    }

    // --- drop shadows ---
    this.#shadowTexture = buildShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    this.#shadow = new THREE.InstancedMesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({
        map: this.#shadowTexture,
        transparent: true,
        opacity: SHADOW_OPACITY,
        // Overlapping discs would z-fight and punch holes in each other.
        depthWrite: false,
        fog: false,
      }),
      MAX_TROOPS,
    );
    this.#shadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#shadow.frustumCulled = false;
    this.#shadow.count = 0;
    this.#shadow.renderOrder = -1;
    scene.add(this.#shadow);

    // --- HP bar ---
    this.#barGroup = new THREE.Group();
    const barMat = (color: number): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color,
        // Must read over the helmets it floats above, at any troop count.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        fog: false,
      });

    const backing = new THREE.Mesh(
      new THREE.PlaneGeometry(HP_BAR_WIDTH + 0.07, HP_BAR_HEIGHT + 0.07),
      barMat(0x14171f),
    );
    backing.renderOrder = 20;
    this.#barGroup.add(backing);

    // Origin shifted to the plane's left edge so scale.x drains the bar from the
    // right, the way every HP bar in the genre does.
    const fillGeo = new THREE.PlaneGeometry(HP_BAR_WIDTH, HP_BAR_HEIGHT);
    fillGeo.translate(HP_BAR_WIDTH / 2, 0, 0.001);
    this.#barFill = new THREE.Mesh(fillGeo, barMat(0x6ddc3a));
    this.#barFill.renderOrder = 21;
    this.#barGroup.add(this.#barFill);

    // The camera never rotates, so one fixed tilt faces the bar at it forever —
    // cheaper and steadier than billboarding per frame.
    this.#barGroup.rotation.x = -cameraPitch();
    this.#barGroup.visible = false;
    scene.add(this.#barGroup);
  }

  // -------------------------------------------------------------------------
  // public surface
  // -------------------------------------------------------------------------

  get radiusX(): number {
    return this.#radiusX;
  }

  get radiusZ(): number {
    return this.#radiusZ;
  }

  get radius(): number {
    return this.#radiusX > this.#radiusZ ? this.#radiusX : this.#radiusZ;
  }

  getCount(): number {
    return this.#count;
  }

  setCount(n: number): void {
    const next = n < 0 ? 0 : n > MAX_TROOPS ? MAX_TROOPS : Math.floor(n);
    this.#count = next;
    if (next > this.#high) this.#high = next;
  }

  sampleShooters(out: THREE.Vector3[], max: number): number {
    // EVERY SOLDIER FIRES. This returned the leading rank only, on the theory
    // that muzzle flashes inside the mass would be buried. The reference gives
    // each soldier its own stream, and a front-band filter cannot express that:
    // at 3 troops the band can hold a single man, so a 3-troop squad would
    // report one shooter and produce one stream where there should be three.
    const limit = Math.min(max, out.length, this.#count);
    if (limit <= 0) return 0;

    // STRIDE, DO NOT TAKE A PREFIX. Slot order is a Vogel spiral with
    // r = sqrt(i / (n-1)), so the first N slots are the INNERMOST N units. A
    // prefix would collapse every stream onto the middle of the blob at high
    // counts; striding samples the whole ellipse.
    //
    // The index is a pure function of (k, count), so stream k keeps the same
    // soldier frame to frame. That stability is load-bearing: bullets treats k
    // as a persistent stream identity and holds most of its aim error for the
    // stream's life, so a reshuffle would visibly teleport the stream.
    const stride = this.#count / limit;
    let written = 0;
    for (let k = 0; k < limit; k++) {
      const i = Math.min(this.#count - 1, Math.floor(k * stride));
      const v = out[written];
      if (v === undefined) break;
      v.set(
        this.#posX[i]! + MUZZLE_X * UNIT_SCALE,
        MUZZLE_Y * UNIT_SCALE + this.#bob[i]!,
        this.#posZ[i]! - MUZZLE_Z * UNIT_SCALE,
      );
      written++;
    }
    return written;
  }

  sampleShooterKinds(kinds: Uint8Array, max: number): number {
    const limit = Math.min(max, kinds.length, this.#count);
    if (limit <= 0) return 0;
    // Identical index arithmetic to `sampleShooters`, deliberately duplicated
    // rather than shared: the two are read together and a divergence between
    // them would put a rocket in an ordinary soldier's hands, which is precisely
    // the kind of bug that is invisible until someone films it.
    const stride = this.#count / limit;
    const specialStride = this.#eliteStride;
    const elites = this.#elites;
    const gunners = this.#gunners;
    const rocketeers = this.#rocketeers;
    for (let k = 0; k < limit; k++) {
      const i = Math.min(this.#count - 1, Math.floor(k * stride));
      let kind = 0;
      if (i % specialStride === 0) {
        const rank = i / specialStride;
        if (rank >= elites && rank < elites + gunners) kind = 1;
        else if (rank >= elites + gunners && rank < elites + gunners + rocketeers) kind = 2;
      }
      kinds[k] = kind;
    }
    return limit;
  }

  takeSpawns(out: THREE.Vector3[], max: number): number {
    return this.#drain(this.#spawnQueue, out, max);
  }

  takeDeaths(out: THREE.Vector3[], max: number): number {
    return this.#drain(this.#deathQueue, out, max);
  }

  /** Empties `queue` into `out` as world positions. Always drains fully, even
   *  past `max`, or a burst bigger than the caller's buffer would leak stale
   *  slots into the next beat. */
  #drain(queue: number[], out: THREE.Vector3[], max: number): number {
    let written = 0;
    for (const slot of queue) {
      if (written >= max || written >= out.length) break;
      const v = out[written];
      if (!v) break;
      v.set(this.#posX[slot]!, MUZZLE_Y * UNIT_SCALE, this.#posZ[slot]!);
      written++;
    }
    queue.length = 0;
    return written;
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  update(dt: number, world: WorldState): void {
    this.#time += dt;
    this.setCount(world.troops);
    this.#reshape(world.zoom);
    // Clamped here rather than trusted: an elite is a slot index, and a slot
    // index past the live count would paint a body that is already falling.
    // One job per soldier: each kind takes what is left after the ones before
    // it, so the three can never overlap however the orchestrator clamps them.
    const room = this.#count;
    this.#elites = Math.min(room, Math.max(0, Math.floor(world.elites)));
    this.#gunners = Math.min(room - this.#elites, Math.max(0, Math.floor(world.gunners)));
    this.#rocketeers = Math.min(
      room - this.#elites - this.#gunners,
      Math.max(0, Math.floor(world.rocketeers)),
    );
    const specials = this.#elites + this.#gunners + this.#rocketeers;
    // SPREAD, NOT STACKED. Slot order is a Vogel spiral with r = sqrt(i/(n-1)),
    // so slots 0..E-1 are the innermost E units — six elites landed on top of
    // each other in the middle of the blob and read as one gold platform. Taking
    // every `stride`-th slot instead walks them from the centre out to the rim,
    // which is what makes them look like veterans mixed through a crowd.
    this.#eliteStride = specials > 0 ? Math.max(1, Math.floor(this.#count / specials)) : 1;

    // The centre travels the whole road at every size. A crowd wider than the
    // road overhangs it, which is what the reference does and what keeps a big
    // army steerable — see CENTER_X_LIMIT. The per-unit clamp below is now the
    // only containment, and it deliberately permits the overhang.
    const targetX = clamp(laneToX(world.squadLane), -CENTER_X_LIMIT, CENTER_X_LIMIT);

    this.#prevCenterX = this.#centerX;
    // The lag says how eagerly the crowd wants to be somewhere; the cap says how
    // fast it is physically able to get there. Both are needed — the lag alone
    // is a time constant, so it arrives just as quickly from across the road as
    // from next door, which is what made position free. See LATERAL_SPEED.
    const want = (targetX - this.#centerX) * CENTER_FOLLOW;
    const top = this.#topLateralSpeed();
    const goal = clamp(want, -top, top);
    const step = LATERAL_ACCEL * dt;
    this.#centerVel = clamp(goal - this.#centerVel, -step, step) + this.#centerVel;
    // Never overshoot the target inside one tick — at 60 Hz the cap alone would
    // let a crowd 1 cm from its goal sail 12 cm past it and buzz.
    const travel = clamp(this.#centerVel * dt, -Math.abs(targetX - this.#centerX), Math.abs(targetX - this.#centerX));
    this.#centerX += travel;
    this.center.set(this.#centerX, 0, SQUAD_Z);
    world.squadCenter.copy(this.center);
    // NOT `radiusX`. That is the ellipse the crowd is LAID OUT in, and at small
    // counts it is deliberately inflated by SMALL_SQUAD_FLARE so three men read
    // as a rank rather than a huddle. A gate asks a different question — how
    // much road do these bodies actually cover — and answering it with the
    // layout radius made a single soldier 2.2 m wide, so he straddled a segment
    // boundary and paid half of a reward AND half of a penalty at once.
    //
    // n bodies packed at roughly one body-width apart cover 0.3·sqrt(n) either
    // side, so that is the honest extent, capped by the layout radius once the
    // crowd is big enough for the road to be the binding constraint.
    world.squadHalfWidth = Math.min(
      this.#radiusX,
      UNIT_HALF_WIDTH * UNIT_SCALE * Math.sqrt(Math.max(1, this.#count)),
    );

    const count = this.#count;
    const n = Math.max(count, this.#high);
    const rx = this.#radiusX;
    const rz = this.#radiusZ;
    // r = sqrt(i / (count-1)) is the area-uniform radial CDF for a disc, and it
    // pins slot 0 at the centre and the NEWEST slot at the rim — which is both
    // "no grid" and "new units appear at the edge" from one expression.
    const rDenom = count > 1 ? count - 1 : 1;
    const t = this.#time;

    for (let i = 0; i < n; i++) {
      const alive = i < count;
      if (!alive && this.#live[i] === 0) continue;

      this.#prevX[i] = this.#posX[i]!;
      this.#prevZ[i] = this.#posZ[i]!;
      this.#prevBob[i] = this.#bob[i]!;
      this.#prevPop[i] = this.#pop[i]!;

      // --- target slot in the clump ellipse ---
      const rNorm = count > 1 ? Math.sqrt(i / rDenom) : 0;
      const r = Math.max(0, rNorm + this.#slotRadialJitter[i]! * rNorm);
      const a = this.#slotAngle[i]!;
      const jostle = Math.sin(t * JOSTLE_RATE + this.#slotJostlePhase[i]!) * JOSTLE_AMPLITUDE;
      const loose = CORE_TIGHTNESS + (1 - CORE_TIGHTNESS) * rNorm;

      const tx = this.#centerX + Math.cos(a) * r * rx + this.#slotJitterX[i]! * loose + jostle;
      const tz =
        SQUAD_Z + Math.sin(a) * r * rz + this.#slotJitterZ[i]! * loose + this.#slotTrail[i]! * rNorm;

      if (alive && this.#live[i] === 0) {
        // Pop in slightly outside the rim, then let the spring pull it in. The
        // growth team's +1 floater fires over the top of this.
        this.#live[i] = 1;
        this.#fall[i] = 0;
        if (this.#spawnQueue.length < MAX_QUEUE) this.#spawnQueue.push(i);
        // Clamped like any other position, against the same overhang backstop —
        // the 1.18 overshoot is the one place a unit is deliberately placed
        // OUTSIDE the blob's own reach, so it is the one place that could throw
        // a body clear of the crowd entirely.
        this.#posX[i] = clamp(
          this.#centerX + (tx - this.#centerX) * 1.18,
          -UNIT_OVERHANG_LIMIT,
          UNIT_OVERHANG_LIMIT,
        );
        this.#posZ[i] = SQUAD_Z + (tz - SQUAD_Z) * 1.18;
        this.#prevX[i] = this.#posX[i]!;
        this.#prevZ[i] = this.#posZ[i]!;
        this.#velX[i] = 0;
        this.#velZ[i] = 0;
        this.#pop[i] = 0;
        this.#prevPop[i] = 0;
        this.#popVel[i] = 0;
      }

      // --- position spring ---
      const k = this.#slotSpringK[i]!;
      const c = 2 * Math.sqrt(k) * SPRING_DAMPING_RATIO;
      const vx = this.#velX[i]! + ((tx - this.#posX[i]!) * k - this.#velX[i]! * c) * dt;
      const vz = this.#velZ[i]! + ((tz - this.#posZ[i]!) * k - this.#velZ[i]! * c) * dt;
      this.#velZ[i] = vz;
      this.#posZ[i] = this.#posZ[i]! + vz * dt;

      // The only containment gate left, and it now sits at the OVERHANG limit
      // rather than at the kerb: a crowd steered hard to one side is supposed to
      // hang over the shoulder, and clamping every rim unit to the kerb turned
      // that into a visible wall the whole flank piled up against. What this
      // still prevents is a unit being flung to the horizon by a hard steer
      // while its spring is mid-flight. Kill the outward velocity too, or a unit
      // parks on the limit with stored momentum and snaps when released.
      const nx = this.#posX[i]! + vx * dt;
      if (nx > UNIT_OVERHANG_LIMIT) {
        this.#posX[i] = UNIT_OVERHANG_LIMIT;
        this.#velX[i] = vx < 0 ? vx : 0;
      } else if (nx < -UNIT_OVERHANG_LIMIT) {
        this.#posX[i] = -UNIT_OVERHANG_LIMIT;
        this.#velX[i] = vx > 0 ? vx : 0;
      } else {
        this.#posX[i] = nx;
        this.#velX[i] = vx;
      }

      // --- death topple ---
      // A unit that dies FALLS OVER and drops through the road rather than
      // shrinking where it stood. Shrinking reads as "removed from a count";
      // toppling reads as "that soldier died", which is the whole difference
      // between a number going down and a loss the player feels.
      if (!alive && this.#live[i] === 1 && this.#fall[i] === 0) {
        this.#fall[i] = 1e-4;
        if (this.#deathQueue.length < MAX_QUEUE) this.#deathQueue.push(i);
      }
      if (this.#fall[i]! > 0) {
        this.#fall[i] = Math.min(1, this.#fall[i]! + dt / FALL_TIME);
      }

      // --- pop scale ---
      // Dying units hold their size until the topple is most of the way done,
      // so the body is visible falling instead of vanishing as it tips.
      const goal = alive ? 1 : this.#fall[i]! < FALL_HOLD ? 1 : 0;
      const pv = this.#popVel[i]! + ((goal - this.#pop[i]!) * POP_K - this.#popVel[i]! * POP_C) * dt;
      this.#popVel[i] = pv;
      const p = this.#pop[i]! + pv * dt;
      this.#pop[i] = p < 0 ? 0 : p;

      // --- run-in-place bob ---
      this.#bob[i] = Math.abs(Math.sin(t * this.#slotBobRate[i]! + this.#slotBobPhase[i]!)) * BOB_HEIGHT;

      // Zero it outright on the way out, or the slot freezes mid-shrink and
      // leaves a sliver of a soldier standing on the road forever.
      if (!alive && this.#fall[i]! >= 1 && this.#pop[i]! < 0.01) {
        this.#live[i] = 0;
        this.#fall[i] = 0;
        this.#pop[i] = 0;
        this.#prevPop[i] = 0;
      }
    }

    this.#high = n;
    while (this.#high > count && this.#live[this.#high - 1] === 0) this.#high--;
  }

  render(alpha: number, world: WorldState): void {
    const n = this.#high;
    const m = this.#m;
    const pos = this.#pos;
    const quat = this.#quat;
    const scl = this.#scl;
    quat.identity();

    const elites = this.#elites;
    const gunners = this.#gunners;
    const rocketeers = this.#rocketeers;
    const stride = this.#eliteStride;
    let gunnerCount = 0;
    let rocketCount = 0;
    const tint = this.#body.instanceColor!;
    const tints = tint.array as Float32Array;
    let tintDirty = false;

    for (let i = 0; i < n; i++) {
      const fall = this.#fall[i]!;
      const x = lerp(this.#prevX[i]!, this.#posX[i]!, alpha);
      const z = lerp(this.#prevZ[i]!, this.#posZ[i]!, alpha);
      const y = lerp(this.#prevBob[i]!, this.#bob[i]!, alpha);
      const p = lerp(this.#prevPop[i]!, this.#pop[i]!, alpha);
      // Which job, if any, this slot holds. One strided sequence, banded:
      // elites take the first `elites` special slots, gunners the next, and
      // rocketeers the rest. `job` is 0 none, 1 elite, 2 gunner, 3 rocketeer.
      let job = 0;
      if (i % stride === 0) {
        const rank = i / stride;
        if (rank < elites) job = 1;
        else if (rank < elites + gunners) job = 2;
        else if (rank < elites + gunners + rocketeers) job = 3;
      }
      const elite = job === 1;
      const s = p * UNIT_SCALE * (elite ? ELITE_SCALE : 1);

      // Dying beats elite: a gold soldier going down still has to flash red, or
      // the one loss the player most wants to see is the one that hides.
      let cr = 1;
      let cg = 1;
      let cb = 1;
      if (fall > 0) {
        const f = Math.min(1, fall * DEATH_TINT_RAMP);
        cr = 1 + f * (DEATH_TINT[0] - 1);
        cg = 1 + f * (DEATH_TINT[1] - 1);
        cb = 1 + f * (DEATH_TINT[2] - 1);
      } else if (job !== 0) {
        const tint = job === 1 ? ELITE_TINT : job === 2 ? GUNNER_TINT : ROCKETEER_TINT;
        cr = tint[0];
        cg = tint[1];
        cb = tint[2];
      }
      const o = i * 3;
      // Compared rather than written blind: the whole buffer re-uploads on any
      // change, and in the common frame nothing is dying and nothing is new.
      if (tints[o] !== cr || tints[o + 1] !== cg || tints[o + 2] !== cb) {
        tints[o] = cr;
        tints[o + 1] = cg;
        tints[o + 2] = cb;
        tintDirty = true;
      }

      if (fall > 0) {
        // Topple away from the camera and sink. Eased so the first part of the
        // fall is quick and the landing settles.
        const e = fall * fall;
        quat.setFromAxisAngle(FALL_AXIS, -e * FALL_ANGLE);
        pos.set(x, y - e * FALL_SINK, z);
      } else {
        quat.identity();
        pos.set(x, y, z);
      }
      scl.set(s, s, s);
      m.compose(pos, quat, scl);
      this.#body.setMatrixAt(i, m);

      // The weapon rides the same transform as its carrier, offset to the
      // shoulder in unit space so it inherits the bob, the pop and the topple
      // for free.
      if (job >= 2 && fall === 0) {
        pos.set(x + KIT_X * s, y + KIT_Y * s, z + KIT_Z * s);
        scl.set(s, s, s);
        m.compose(pos, quat, scl);
        if (job === 2) this.#gunnerKit.setMatrixAt(gunnerCount++, m);
        else this.#rocketKit.setMatrixAt(rocketCount++, m);
      }

      // The shadow stays welded to the ground and shrinks as the unit rises —
      // that gap is the only cue that tells the eye the bob is a jump and not
      // the whole road moving.
      const sh =
        SHADOW_RADIUS * 2 * p * (elite ? ELITE_SCALE : 1) * (1 - (y / BOB_HEIGHT) * 0.3);
      pos.set(x + SHADOW_OFFSET_X, SHADOW_Y, z + SHADOW_OFFSET_Z);
      scl.set(sh, 1, sh);
      m.compose(pos, quat, scl);
      this.#shadow.setMatrixAt(i, m);
    }

    this.#body.count = n;
    this.#shadow.count = n;
    this.#body.instanceMatrix.needsUpdate = true;
    this.#shadow.instanceMatrix.needsUpdate = true;
    if (tintDirty) tint.needsUpdate = true;
    this.#gunnerKit.count = gunnerCount;
    this.#rocketKit.count = rocketCount;
    this.#gunnerKit.instanceMatrix.needsUpdate = true;
    this.#rocketKit.instanceMatrix.needsUpdate = true;

    const showBar = this.#count >= HP_BAR_MIN_TROOPS;
    this.#barGroup.visible = showBar;
    if (showBar) {
      const cx = lerp(this.#prevCenterX, this.#centerX, alpha);
      this.#barGroup.position.set(cx, HP_BAR_Y, SQUAD_Z);
      const health = clamp(world.health, 0, 1);
      this.#barFill.scale.x = health;
      this.#barFill.position.x = -HP_BAR_WIDTH / 2;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#scene.remove(this.#body, this.#shadow, this.#barGroup, this.#gunnerKit, this.#rocketKit);
    for (const kit of [this.#gunnerKit, this.#rocketKit]) {
      kit.geometry.dispose();
      kit.dispose();
    }
    (this.#gunnerKit.material as THREE.Material).dispose();
    this.#body.geometry.dispose();
    (this.#body.material as THREE.Material).dispose();
    this.#body.dispose();
    this.#shadow.geometry.dispose();
    (this.#shadow.material as THREE.Material).dispose();
    this.#shadow.dispose();
    this.#shadowTexture.dispose();
    for (const child of this.#barGroup.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  // -------------------------------------------------------------------------


  /**
   * Top lateral speed for the current army. Eases from `LATERAL_SPEED` down to
   * `MASS_SPEED` as the crowd passes `MASS_TROOPS`, on a curve rather than a
   * cliff so no single reward is the moment the controls got heavier.
   */
  #topLateralSpeed(): number {
    const t = Math.min(1, this.#count / MASS_TROOPS);
    return LATERAL_SPEED + (MASS_SPEED - LATERAL_SPEED) * t * t;
  }

  /** Clump ellipse from troop count. Only runs when the count actually moves. */
  #reshape(zoom: number): void {
    if (this.#shapedFor === this.#count && this.#shapedAtZoom === zoom) return;
    this.#shapedFor = this.#count;
    this.#shapedAtZoom = zoom;

    const root = Math.sqrt(this.#count);
    const idealX = SPREAD * root * (1 + SMALL_SQUAD_FLARE / Math.max(1, this.#count));
    this.#radiusX = Math.min(RADIUS_X_MAX, idealX);

    // Once the road stops the clump getting wider, the area it wanted has to go
    // somewhere — so it goes backwards, and density only starts climbing after
    // the depth cap too. This is the reference's behaviour past ~50 units.
    const squeeze = idealX > 0 ? idealX / Math.max(this.#radiusX, 1e-4) : 1;
    // The depth cap is a FRAMING budget, not a road one — it is where the rear
    // rank reaches the bottom of the screen. Pulling the camera back is exactly
    // the thing that buys more of it, so it scales with the zoom. Width does
    // not: the road does not get wider just because you are looking from
    // further away, and letting the crowd widen with the zoom would walk it out
    // over the water.
    this.#radiusZ = Math.min(RADIUS_Z_MAX * zoom, SPREAD * DEPTH_RATIO * root * squeeze);
  }
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------


/** Rifle muzzle in unmodified unit space; scaled by UNIT_SCALE at the call site.
 *  Read straight off the rifle's front face after the pitch, yaw and body lean
 *  below — if the rifle moves, these move with it. */
const MUZZLE_X = 0.428;
const MUZZLE_Y = 1.185;
const MUZZLE_Z = 0.841;
/** Just clear of the road plane at y=0, without needing polygonOffset. */
const SHADOW_Y = 0.012;

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/** How far each leg swings out of the stride. Both legs at z=0 is what made the
 *  lower body read as one block. */
const LEG_STRIDE = 0.16;
/**
 * Rifle attitude, and it is set by where the barrel lands ON SCREEN rather than
 * by what looks right in a modelling view.
 *
 * The first pass held it forward and barely canted, which is anatomically fine
 * and completely invisible: projected, only 12% of the barrel escaped the
 * soldier's OWN helmet and the muzzle cleared it by 3 px. The rifle was being
 * eaten by the head in front of it — nothing to do with neighbours, it happened
 * at three troops as readily as at fifty.
 *
 * Pitching it up and swinging it out to +X puts 62% of the barrel outside the
 * helmet's screen disc with the tip clearing by 31 px — about one helmet radius,
 * which is the protrusion `frame_009` and `frame_018` show. It lands at 28° off
 * vertical on screen, the diagonal the reference reads as. Note the screen angle
 * is not the world angle: 34° of world yaw becomes 28° of screen tilt because
 * this camera compresses the forward axis.
 */
const RIFLE_PITCH = 0.65;
const RIFLE_YAW = -0.6;
const RIFLE_X = 0.21;
const RIFLE_Y = 0.99;
const RIFLE_Z = -0.33;
const RIFLE_LENGTH = 0.9;

/**
 * One soldier as a single vertex-coloured geometry, 181 triangles.
 *
 * WHAT THIS IS BUILT TO SURVIVE. A unit is ~40 px tall in a 50-strong clump and
 * the camera sits 34° above it, so this is a silhouette problem, not a modelling
 * one. Four things carry the read, in order:
 *
 *   1. THE RIFLE. A long pale diagonal breaking out of the blob's outline. It is
 *      the only part of the unit that is not a rounded lump, so it is the whole
 *      difference between "soldiers" and "marbles" — see the crowd in
 *      `frame_023`, where the rifles are the only straight lines on screen.
 *   2. THE HELMET, dome plus a brim that overhangs it. From above the crowd is a
 *      field of blue discs; the brim is what makes each disc a helmet rather than
 *      a ball, and it costs nine triangles.
 *   3. THE CREAM SHOULDERS behind the helmet. The head sits forward of the body,
 *      so a wide yoke shows as a bright crescent — and it is deliberately built
 *      as an UP-FACING slab, because with this scene's backlighting a vertical
 *      face gets nothing but green ground bounce and goes olive no matter what
 *      colour it is authored. Cream that has to read must face the sky.
 *   4. TWO LEGS AND TWO BOOTS in a stride. In a packed clump the near-black boots
 *      are the only thing separating one unit's legs from the next one's.
 *
 * Segment counts are as low as they go before the helmet stops reading as a dome
 * from directly above. At 1200 instances every extra triangle here costs 1200 on
 * the GPU, so everything that is not the helmet is a box, the head is a
 * 6×2 sphere that barely peeks out from under the brim, and nobody will ever be
 * able to tell.
 */
function buildSoldierGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];

  // --- legs and boots ------------------------------------------------------
  // Proportions are stubby on purpose. The reference unit is roughly as wide as
  // it is half-tall — chunky cartoon, not a realistic figure.
  //
  // The stride is baked, not animated: the bob already carries the run, and two
  // boxes offset in Z read as legs from above where two boxes side by side read
  // as one slab. side -1 swings forward, side +1 trails.
  for (const side of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.145, 0.44, 0.19);
    leg.rotateX(-side * LEG_STRIDE);
    leg.translate(side * 0.105, 0.235, side * 0.05);
    parts.push({ geo: leg, color: COLOR_TROUSERS });

    const boot = new THREE.BoxGeometry(0.16, 0.13, 0.26);
    boot.translate(side * 0.105, 0.07, side * 0.085);
    parts.push({ geo: boot, color: COLOR_BOOT });
  }

  // --- torso and shoulder yoke ---------------------------------------------
  const torso = new THREE.BoxGeometry(0.38, 0.54, 0.32);
  torso.translate(0, 0.7, 0.02);
  parts.push({ geo: torso, color: COLOR_SHIRT });

  // The yoke is pre-rotated by +BODY_LEAN so the whole-body lean applied at the
  // end cancels out and its top face ends up dead level. That is worth doing for
  // two reasons at once: a level face catches the most sky and key light (the
  // brightest cream on the unit), and it presents the most area to a camera that
  // is looking down. It is also wider than the helmet, so it shows at the sides
  // as well as behind.
  const yoke = new THREE.BoxGeometry(UNIT_HALF_WIDTH * 2, 0.17, 0.44);
  yoke.rotateX(BODY_LEAN);
  yoke.translate(0, UNIT_SHOULDER_Y - 0.085, 0.06);
  parts.push({ geo: yoke, color: COLOR_SHIRT });

  // --- arms ----------------------------------------------------------------
  // Two, not one bar. They are only a few pixels each, but without them the
  // rifle floats in front of the chest with nothing holding it, and a floating
  // rifle reads as a bug rather than as a weapon. The left arm crosses the body
  // to the fore-grip; the right stays out at the trigger.
  const armL = new THREE.BoxGeometry(0.115, 0.115, 0.5);
  armL.rotateX(-0.14);
  armL.rotateY(-0.62);
  armL.translate(-0.02, 0.94, -0.2);
  parts.push({ geo: armL, color: COLOR_SHIRT });

  const armR = new THREE.BoxGeometry(0.115, 0.115, 0.4);
  armR.rotateX(-0.3);
  armR.rotateY(-0.2);
  armR.translate(0.19, 0.95, -0.18);
  parts.push({ geo: armR, color: COLOR_SHIRT });

  // --- rifle ---------------------------------------------------------------
  // Built along -Z, then pitched, yawed and carried into place as one piece so
  // the two boxes cannot drift apart. Length is cartoon-long on purpose: the
  // muzzle has to clear the helmet on screen or the diagonal never breaks the
  // blob's outline, which is the entire point of drawing it.
  const barrel = new THREE.BoxGeometry(0.05, 0.055, RIFLE_LENGTH);
  barrel.translate(0, 0, -0.06);
  const stock = new THREE.BoxGeometry(0.062, 0.1, 0.22);
  stock.translate(0, -0.012, RIFLE_LENGTH / 2 - 0.1);
  for (const g of [barrel, stock]) {
    g.rotateX(RIFLE_PITCH);
    g.rotateY(RIFLE_YAW);
    g.translate(RIFLE_X, RIFLE_Y, RIFLE_Z);
  }
  parts.push({ geo: barrel, color: COLOR_RIFLE_METAL });
  parts.push({ geo: stock, color: COLOR_RIFLE_WOOD });

  // --- head and helmet -----------------------------------------------------
  // Head sits forward of the torso: that offset is what uncovers the shoulder
  // yoke behind the helmet and gives the cream crescent the reference has.
  const head = new THREE.SphereGeometry(0.15, 6, 2);
  head.translate(0, 1.11, -0.1);
  parts.push({ geo: head, color: COLOR_SKIN });

  // Brim: a flat disc overhanging the dome by ~0.05 all round, levelled against
  // the body lean the same way the yoke is. Nine triangles for the single
  // cheapest "that is a helmet, not a ball" cue available.
  const brim = new THREE.CircleGeometry(0.262, 9);
  brim.rotateX(-Math.PI / 2);
  brim.rotateX(BODY_LEAN);
  brim.translate(0, 1.15, -0.13);
  parts.push({ geo: brim, color: COLOR_HELMET });

  const dome = new THREE.SphereGeometry(0.215, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.55);
  dome.translate(0, 1.14, -0.13);
  parts.push({ geo: dome, color: COLOR_HELMET });

  const merged = mergeParts(parts);
  // Lean pivots about the feet so the soles stay on the shadow.
  merged.rotateX(-BODY_LEAN);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A shouldered MINIGUN — a rotary barrel cluster on a blocky receiver.
 *
 * Deliberately the same silhouette language as the pickup that grants it
 * (`entities/pickups.ts`), because the whole job of this mesh is to connect "the
 * thing I shot off that barrel" to "that soldier is now carrying it". Six
 * barrels rather than one: at 40 px the cluster is the only part that reads, and
 * a single tube would just be the rifle every other soldier already has.
 */
function buildMinigunKit(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const body = new THREE.BoxGeometry(0.17, 0.17, 0.26);
  body.translate(0, 0, 0.06);
  parts.push({ geo: body, color: COLOR_HELMET });
  const drum = new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8);
  drum.rotateX(Math.PI / 2);
  drum.translate(0, 0, -0.06);
  parts.push({ geo: drum, color: KIT_BRASS });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.CylinderGeometry(0.022, 0.022, 0.34, 4);
    b.rotateX(Math.PI / 2);
    b.translate(Math.cos(a) * 0.042, Math.sin(a) * 0.042, -0.26);
    parts.push({ geo: b, color: KIT_STEEL });
  }
  const merged = mergeParts(parts);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A shouldered ROCKET LAUNCHER — a long tube with a fat red warhead.
 *
 * The warhead is the read: it is the one saturated red on a friendly unit, and
 * it is what tells you at a glance which of your soldiers is about to put a
 * rocket downrange. Angled up so the tube breaks the crowd's outline the same
 * way the rifle does.
 */
function buildRocketKit(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const tube = new THREE.CylinderGeometry(0.06, 0.06, 0.56, 6);
  tube.rotateX(Math.PI / 2);
  parts.push({ geo: tube, color: KIT_GUNMETAL });
  const head = new THREE.ConeGeometry(0.095, 0.22, 6);
  head.rotateX(-Math.PI / 2);
  head.translate(0, 0, -0.34);
  parts.push({ geo: head, color: KIT_WARHEAD });
  const grip = new THREE.BoxGeometry(0.06, 0.11, 0.08);
  grip.translate(0, -0.09, 0.1);
  parts.push({ geo: grip, color: KIT_GUNMETAL });
  const merged = mergeParts(parts);
  // Pitched up and swung out for the same reason the rifle is — see RIFLE_PITCH.
  merged.rotateX(0.34);
  merged.rotateY(-0.42);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Minimal position/normal/index merge with a flat colour baked per part.
 *
 * Rolled by hand rather than pulled from BufferGeometryUtils because the only
 * thing we need beyond concatenation is the colour attribute, and this keeps
 * the module free of addon imports.
 */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.geo.getAttribute("position").count;
    const index = part.geo.getIndex();
    indexCount += index ? index.count : part.geo.getAttribute("position").count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint16Array(indexCount);

  const c = new THREE.Color();
  let vOffset = 0;
  let iOffset = 0;

  for (const part of parts) {
    const src = part.geo;
    const pos = src.getAttribute("position");
    const nrm = src.getAttribute("normal");
    const n = pos.count;

    positions.set(pos.array as Float32Array, vOffset * 3);
    normals.set(nrm.array as Float32Array, vOffset * 3);

    // setHex runs the sRGB → working-space conversion, so these match the hex
    // colours the rest of the project hands straight to material constructors.
    c.setHex(part.color);
    for (let i = 0; i < n; i++) {
      colors[(vOffset + i) * 3] = c.r;
      colors[(vOffset + i) * 3 + 1] = c.g;
      colors[(vOffset + i) * 3 + 2] = c.b;
    }

    const index = src.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices[iOffset + i] = index.getX(i) + vOffset;
      iOffset += index.count;
    } else {
      for (let i = 0; i < n; i++) indices[iOffset + i] = i + vOffset;
      iOffset += n;
    }

    vOffset += n;
    src.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

/** Soft radial falloff. 64px is plenty — it is never more than ~40 screen px. */
function buildShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(20,24,34,1)");
  g.addColorStop(0.55, "rgba(20,24,34,0.85)");
  g.addColorStop(1, "rgba(20,24,34,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radians the fixed camera looks down by. Drives the HP bar's tilt. */
function cameraPitch(): number {
  const dx = CAMERA_LOOK.x - CAMERA_POS.x;
  const dy = CAMERA_LOOK.y - CAMERA_POS.y;
  const dz = CAMERA_LOOK.z - CAMERA_POS.z;
  return Math.asin(-dy / Math.sqrt(dx * dx + dy * dy + dz * dz));
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Seeded PRNG so a unit's jitter, phase and lag are the same every run. */
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
