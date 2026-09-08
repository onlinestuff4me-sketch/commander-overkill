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
 * Five draw calls total at any troop count: one InstancedMesh for the body from
 * the hips up (all parts merged into one vertex-coloured geometry), ONE for
 * every leg in the army (two instances per unit, so it can walk), one for the
 * drop shadows, two for the HP bar. All per-unit state lives in preallocated
 * typed arrays and nothing in update()/render() allocates.
 */

import * as THREE from "three";
import { toyMaterial, attachInstanceAlpha } from "../core/look";
import { CORRIDOR_HALF_WIDTH, laneToX } from "../mechanics/lane";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";
import {
  MAX_TROOPS,
  WEAPON_FLAMER,
  WEAPON_FREEZE,
  WEAPON_MINIGUN,
  WEAPON_RIFLE,
  WEAPON_ROCKET,
} from "../core/types";
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
/** The lean is a roll about the axis pointing at the camera, so it reads as a
 *  soldier tipping sideways rather than forwards. */
const BANK_AXIS = new THREE.Vector3(0, 0, 1);
const IDENTITY_QUAT = new THREE.Quaternion();
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
const ELITE_SCALE = 1.5;

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
/** The two counter weapons. Warm for the flamer, cold for the freezer — the
 *  same warm/cold split the rounds themselves use, so a carrier and his fire
 *  are recognisably the same colour idea. */
const FLAMER_TINT = [1.22, 0.94, 0.72] as const;
const FREEZER_TINT = [0.8, 1.0, 1.22] as const;
/** Where a shouldered weapon sits, in unmodified unit space. Level with the
 *  helmet so it breaks the crowd's outline from above, which is the only angle
 *  this camera really has. */
const KIT_X = -0.26;
const KIT_Y = 1.3;
const KIT_Z = 0.02;
/**
 * Whole-kit size multiplier, and the standing instruction is to err big.
 *
 * The first pass sized the weapons realistically against a 1.4 m soldier, which
 * is correct and useless: at forty pixels a realistically-sized minigun is a
 * grey pixel on a shoulder, and playtest could not tell one carrier from
 * another. These are cartoon weapons on cartoon soldiers — the silhouette is the
 * whole message, so the weapon is allowed to be absurd next to the man holding
 * it.
 *
 * There is still a ceiling. At 1.9 the launchers were wider than the soldiers
 * carrying them and a crowd of them was a thicket of tubes with no visible men
 * underneath — past "obvious" and into "cannot see the game". 1.2 is comfortably
 * larger than realistic and still leaves the crowd readable.
 */
const KIT_SCALE = 1.2;

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
const SHADOW_RADIUS = 0.47;
const SHADOW_OPACITY = 0.52;
/** Slight offset toward camera-right. The scene key light would technically
 *  throw the shadow up-screen, where the unit's own body hides it — and a
 *  shadow you cannot see does not seat anything. This matches the reference
 *  frames instead.
 *
 *  THE WHOLE GAME USES THIS DIRECTION NOW. Measured off `frame_018`, every
 *  shadow in the reference falls to the lower right by roughly half a helmet
 *  width, and it is a big soft dark blob rather than a smudge — a crowd's
 *  shadows merging into one dark mass under it is most of what stops the crowd
 *  hovering. The enemy, barrel and boss modules were throwing theirs UP-LEFT,
 *  which is behind the object from this camera, so half the game was lit by one
 *  sun and half by another. */
const SHADOW_OFFSET_X = 0.22;
const SHADOW_OFFSET_Z = 0.26;

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
 * LEAN AND DRAG — what a swipe looks like in the frame it happens.
 *
 * The crowd's centre is capped at LATERAL_SPEED and ramped by LATERAL_ACCEL,
 * both deliberately: a big army is supposed to feel like a big army. But those
 * two together mean the first ~0.2 s of a swipe produces almost no movement on
 * screen, and 0.2 s is exactly the window in which a control either feels
 * connected to your thumb or does not. Mischa's note was that the game did not
 * feel responsive, and this is where that lived — not in the latency, which is
 * a tenth of a second, but in the fact that nothing VISIBLE happened during it.
 *
 * So the army answers the input with its posture instead of its position. Two
 * things, both driven off the centre's velocity and both free:
 *
 *   LEAN   every soldier rolls into the turn. Uniform across the crowd, so it
 *          is one quaternion per frame rather than one per unit.
 *   DRAG   the formation shears — the front rank leads and the rear rank trails,
 *          by an amount proportional to how far back it is standing.
 *
 * Neither moves the crowd's centre, so nothing about the strategy changes: the
 * gate maths reads `world.squadHalfWidth`, which is derived from the head count,
 * and the shear is symmetric about the centre. This is pure feel, and that is
 * the point — the weight was never the problem, the silence was.
 *
 * BANK_ANGLE is radians at full lateral speed; 0.2 is ~11°, which reads clearly
 * on a 40-pixel-tall soldier without tipping him over. DRAG_GAIN is metres of
 * lag per metre of depth at full speed: the rear of a deep crowd trails about a
 * third of a body width, which is a sweep rather than a smear.
 */
const BANK_ANGLE = 0.2;
const DRAG_GAIN = 0.18;
/** How fast the lean follows the velocity, in 1/seconds. Faster than the crowd
 *  itself accelerates, or the posture would lag the thing it is reporting. */
const BANK_FOLLOW = 12;

/**
 * TURN DUST — the third thing a swipe does, and the only one that stays behind.
 *
 * Lean and drag are posture: they tell you the crowd is turning while it turns,
 * and they are gone the instant it stops. Dust is a TRAIL, and a trail is what
 * makes a movement feel like it had force. It is also the only cue in this game
 * that survives the moment it was made, which is what lets a player see how hard
 * they just cut without having been watching at the time.
 *
 * Emitted from the trailing edge of the crowd, proportional to how far over the
 * threshold the centre's speed is, so a lazy drift makes none and a full-tilt
 * cut across the road lays a visible streak. The threshold is what keeps it
 * meaningful — dust under a crowd that is barely moving is just fog.
 */
const DUST_CAPACITY = 48;
/** Metres/second the centre has to be doing before any is kicked up. Just under
 *  half the cap, so ordinary corrections stay clean and committed moves smoke. */
const DUST_SPEED_MIN = 3;
/** Puffs per second at full lateral speed. */
const DUST_RATE = 34;
const DUST_LIFE = 0.9;
const DUST_SIZE = 0.95;
const DUST_GROWTH = 1.8;
const DUST_ALPHA = 0.72;
/**
 * WARM TAN, AND DARKER THAN THE ROAD. The first version was pale grey-cream,
 * which is what dust actually looks like and which was invisible: the road
 * composites at about 0.73 grey, so a lighter-than-road puff at half alpha
 * changes the pixel by a couple of percent. Photographed, it was a smudge.
 *
 * Reading against the surface is the requirement, not being the right colour for
 * grit, so it is pulled warm and down — the same warm/cool split that makes the
 * bridge towers read as landmarks against the same road.
 */
const DUST_COLOR = 0xb0956b;

/**
 * Uniform, straight off the reference: blue helmet, cream shirt, navy trousers.
 * The cream/blue/navy contrast is the whole reason a player can tell their own
 * crowd from the tan/brown enemies at a glance, so the shirt is the one colour
 * on this unit that is not allowed to drift.
 *
 * WHY THE SHIRT IS AUTHORED HOTTER THAN THE CREAM IT IS MEANT TO BE. These are
 * vertex colours, so what lands on screen is albedo × irradiance, and the
 * scene's irradiance is not white: the key light is deliberately up-screen and
 * backlighting the crowd, so every surface the camera can see is carried by the
 * hemisphere fill. The shirt is therefore pre-divided by that fill rather than
 * authored at its target value.
 *
 * IT WAS PRE-DIVIDED BY THE WRONG FILL FOR MOST OF THIS PROJECT. The old value
 * (0xffe4c2) compensated for a GREEN ground bounce, from when the corridor ran
 * over a field; the bounce is grey now (see renderer.ts) and the compensation
 * went with it. Sampled on screen this renders #F1E5CD against the reference's
 * #CBBDAA-in-shade, which is the same cream in a brighter part of the day.
 *
 * Re-derive rather than hand-tweak if the lighting moves again: sample the
 * rendered pixel, sample the reference frame, and scale.
 */
/**
 * MEASURED against the footage rather than picked. Sampling a lit helmet in
 * `frame_018` gives #6FBCE9 — a light sky blue. Ours was rendering #2969AD, a
 * mid navy, which is the same hue at half the value and reads as a dark lump in
 * a crowd rather than as a bright plastic dome. The helmet is the single largest
 * area of colour on a unit and the thing the eye counts, so it has to be the
 * brightest thing on the figure after the shirt.
 */
const COLOR_HELMET = 0x62b0ea;
const COLOR_SHIRT = 0xf7ecd8;
const COLOR_TROUSERS = 0x2f52a8;
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
/** The flamer's fuel bottle and its pilot flame, and the freezer's tank. Both
 *  are the one saturated colour on their kit, for the same reason the rocket's
 *  warhead is: at forty pixels the silhouette says "big weapon" and the colour
 *  is what says WHICH big weapon. */
const KIT_FUEL = 0xe8622c;
const KIT_ICE = 0x66d8f0;

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
  /** Both legs of every unit: instance 2i is the left, 2i+1 the right. */
  #legs: THREE.InstancedMesh;
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
  #flamers = 0;
  #freezers = 0;
  /** Slots `0, stride, 2·stride, …` hold the specials. See the note in update(). */
  #eliteStride = 1;
  /** Weapon meshes, drawn at the carriers' shoulders. */
  #gunnerKit: THREE.InstancedMesh;
  #rocketKit: THREE.InstancedMesh;
  #flamerKit: THREE.InstancedMesh;
  #freezerKit: THREE.InstancedMesh;

  // --- centre steering ---
  #centerX = 0;
  #prevCenterX = 0;
  /** Metres/second the centre is sliding at. Integrated rather than derived so
   *  the speed cap and the acceleration ramp have something to act on. */
  #centerVel = 0;
  /** Lean, −1..1, smoothed from the centre's velocity. Its own state rather than
   *  a function of `#centerVel` so it can settle at its own rate. */
  #bank = 0;
  #prevBank = 0;

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
  /** Leg swing angle, radians. Interpolated in render like the bob, so a walk
   *  cycle running at 60 Hz still looks smooth on a 120 Hz screen. */
  #swing = new Float32Array(MAX_TROOPS);
  #prevSwing = new Float32Array(MAX_TROOPS);
  #pop = new Float32Array(MAX_TROOPS);
  #prevPop = new Float32Array(MAX_TROOPS);
  #popVel = new Float32Array(MAX_TROOPS);
  #live = new Uint8Array(MAX_TROOPS);

  // --- scratch, reused every frame; nothing here is ever reallocated ---
  #m = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scl = new THREE.Vector3();
  /** Leg scratch. Preallocated with everything else — render() allocates
   *  nothing, and at 1200 units this runs 2400 times a frame. */
  #legQuat = new THREE.Quaternion();
  #bankQuat = new THREE.Quaternion();

  // --- turn dust: a fixed pool, oldest recycled ---
  readonly #dust: THREE.InstancedMesh;
  readonly #dustAlpha: THREE.InstancedBufferAttribute;
  readonly #dustTexture: THREE.CanvasTexture;
  #dustX = new Float32Array(DUST_CAPACITY);
  #dustZ = new Float32Array(DUST_CAPACITY);
  #dustVX = new Float32Array(DUST_CAPACITY);
  #dustLife = new Float32Array(DUST_CAPACITY);
  #dustNext = 0;
  /** Fractional puffs owed. Carried across ticks so the emission rate is honest
   *  at any frame rate rather than rounding down to zero every tick. */
  #dustOwed = 0;
  #hip = new THREE.Vector3();

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
      toyMaterial({ vertexColors: true }),
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

    // --- legs: one mesh, two instances per unit ---
    this.#legs = new THREE.InstancedMesh(
      buildLegGeometry(),
      toyMaterial({ vertexColors: true }),
      MAX_TROOPS * 2,
    );
    this.#legs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#legs.frustumCulled = false;
    this.#legs.count = 0;
    for (let i = 0; i < MAX_TROOPS * 2; i++) this.#legs.setColorAt(i, white);
    this.#legs.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.#legs);

    // One instanced mesh per weapon kind, drawn at its carriers' shoulders. Two
    // draw calls for every carrier on screen, and only when there are any.
    const kitMat = toyMaterial({ vertexColors: true });
    this.#gunnerKit = new THREE.InstancedMesh(buildMinigunKit(), kitMat, MAX_TROOPS);
    this.#rocketKit = new THREE.InstancedMesh(buildRocketKit(), kitMat, MAX_TROOPS);
    this.#flamerKit = new THREE.InstancedMesh(buildFlamerKit(), kitMat, MAX_TROOPS);
    this.#freezerKit = new THREE.InstancedMesh(buildFreezerKit(), kitMat, MAX_TROOPS);
    for (const kit of [this.#gunnerKit, this.#rocketKit, this.#flamerKit, this.#freezerKit]) {
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

    // --- turn dust ---
    this.#dustTexture = buildDustTexture();
    const dustGeo = new THREE.PlaneGeometry(1, 1);
    // Lying in the road plane, like the shadows. Dust that billows upward would
    // have to be a billboard, and a billboard at the crowd's feet reads as smoke
    // coming off the soldiers rather than off the ground.
    dustGeo.rotateX(-Math.PI / 2);
    const dustMat = new THREE.MeshBasicMaterial({
      map: this.#dustTexture,
      color: DUST_COLOR,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.#dustAlpha = attachInstanceAlpha(dustGeo, dustMat, DUST_CAPACITY);
    this.#dust = new THREE.InstancedMesh(dustGeo, dustMat, DUST_CAPACITY);
    this.#dust.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#dust.frustumCulled = false;
    this.#dust.count = 0;
    // Over the road and under the shadows, so a soldier's own shadow still
    // reads on top of the dust he is kicking up.
    this.#dust.renderOrder = -2;
    scene.add(this.#dust);

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
    // The same shear render applies, or a hard turn would leave every tracer
    // starting a third of a body width off the soldier firing it.
    const drag = -this.#bank * DRAG_GAIN;
    let written = 0;
    for (let k = 0; k < limit; k++) {
      const i = Math.min(this.#count - 1, Math.floor(k * stride));
      const v = out[written];
      if (v === undefined) break;
      const z = this.#posZ[i]!;
      v.set(
        this.#posX[i]! + drag * (z - SQUAD_Z) + MUZZLE_X * UNIT_SCALE,
        MUZZLE_Y * UNIT_SCALE + this.#bob[i]!,
        z - MUZZLE_Z * UNIT_SCALE,
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
    const flamers = this.#flamers;
    const freezers = this.#freezers;
    for (let k = 0; k < limit; k++) {
      const i = Math.min(this.#count - 1, Math.floor(k * stride));
      // These ARE the WEAPON_* values from core/types.ts — an elite fires an
      // ordinary rifle round, so he lands on 0 with everyone else.
      let kind = WEAPON_RIFLE;
      if (i % specialStride === 0) {
        const rank = i / specialStride;
        const afterElites = rank - elites;
        if (afterElites >= 0) {
          if (afterElites < gunners) kind = WEAPON_MINIGUN;
          else if (afterElites < gunners + rocketeers) kind = WEAPON_ROCKET;
          else if (afterElites < gunners + rocketeers + flamers) kind = WEAPON_FLAMER;
          else if (afterElites < gunners + rocketeers + flamers + freezers) kind = WEAPON_FREEZE;
        }
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
    // Every tick, and after the cached reshape: the squeeze is a live value.
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
    this.#flamers = Math.min(
      room - this.#elites - this.#gunners - this.#rocketeers,
      Math.max(0, Math.floor(world.flamers)),
    );
    this.#freezers = Math.min(
      room - this.#elites - this.#gunners - this.#rocketeers - this.#flamers,
      Math.max(0, Math.floor(world.freezers)),
    );
    const specials =
      this.#elites + this.#gunners + this.#rocketeers + this.#flamers + this.#freezers;
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
    this.#prevBank = this.#bank;
    const wantBank = clamp(this.#centerVel / LATERAL_SPEED, -1, 1);
    this.#bank += (wantBank - this.#bank) * Math.min(1, BANK_FOLLOW * dt);
    this.#updateDust(dt, world.scrollSpeed);
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
      this.#prevSwing[i] = this.#swing[i]!;
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

      // --- run-in-place bob, and the stride that goes with it ---
      const gait = t * this.#slotBobRate[i]! + this.#slotBobPhase[i]!;
      this.#bob[i] = Math.abs(Math.sin(gait)) * BOB_HEIGHT;
      this.#swing[i] = Math.cos(gait) * LEG_SWING;

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

    // The lean is uniform across the crowd, so it is built once here rather than
    // per unit — a thousand soldiers cost one setFromAxisAngle. The drag is a
    // single multiply inside the loop for the same reason.
    const bank = lerp(this.#prevBank, this.#bank, alpha);
    const banked = bank !== 0;
    if (banked) this.#bankQuat.setFromAxisAngle(BANK_AXIS, -bank * BANK_ANGLE);
    const drag = -bank * DRAG_GAIN;

    const elites = this.#elites;
    const gunners = this.#gunners;
    const rocketeers = this.#rocketeers;
    const flamers = this.#flamers;
    const freezers = this.#freezers;
    const stride = this.#eliteStride;
    let gunnerCount = 0;
    let rocketCount = 0;
    let flamerCount = 0;
    let freezerCount = 0;
    const tint = this.#body.instanceColor!;
    const tints = tint.array as Float32Array;
    const legTint = this.#legs.instanceColor!;
    const legTints = legTint.array as Float32Array;
    let tintDirty = false;

    for (let i = 0; i < n; i++) {
      const fall = this.#fall[i]!;
      const z = lerp(this.#prevZ[i]!, this.#posZ[i]!, alpha);
      // DRAG. Depth from the blob's centre line decides how far a unit lags, so
      // the front rank leads the turn and the back rank is still catching up.
      // Symmetric about the centre, so the crowd's extent is unchanged.
      const x = lerp(this.#prevX[i]!, this.#posX[i]!, alpha) + drag * (z - SQUAD_Z);
      const y = lerp(this.#prevBob[i]!, this.#bob[i]!, alpha);
      const p = lerp(this.#prevPop[i]!, this.#pop[i]!, alpha);
      // Which job, if any, this slot holds. One strided sequence, banded:
      // elites take the first `elites` special slots, gunners the next, and
      // rocketeers the rest. `job` is 0 none, 1 elite, 2 gunner, 3 rocketeer.
      // 0 none, 1 elite, 2 gunner, 3 rocketeer, 4 flamer, 5 freezer. Bands in
      // that order so a soldier can only ever hold one, and so adding a weapon
      // never renumbers the ones before it.
      let job = 0;
      if (i % stride === 0) {
        const rank = i / stride;
        if (rank < elites) job = 1;
        else if (rank < elites + gunners) job = 2;
        else if (rank < elites + gunners + rocketeers) job = 3;
        else if (rank < elites + gunners + rocketeers + flamers) job = 4;
        else if (rank < elites + gunners + rocketeers + flamers + freezers) job = 5;
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
        const tint =
          job === 1
            ? ELITE_TINT
            : job === 2
              ? GUNNER_TINT
              : job === 3
                ? ROCKETEER_TINT
                : job === 4
                  ? FLAMER_TINT
                  : FREEZER_TINT;
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
        // The legs carry the same tint, or a gold elite would be gold from the
        // waist up and a dying soldier would go red above blue trousers.
        const lo = i * 6;
        legTints[lo] = cr;
        legTints[lo + 1] = cg;
        legTints[lo + 2] = cb;
        legTints[lo + 3] = cr;
        legTints[lo + 4] = cg;
        legTints[lo + 5] = cb;
        tintDirty = true;
      }

      if (fall > 0) {
        // Topple away from the camera and sink. Eased so the first part of the
        // fall is quick and the landing settles.
        const e = fall * fall;
        quat.setFromAxisAngle(FALL_AXIS, -e * FALL_ANGLE);
        pos.set(x, y - e * FALL_SINK, z);
      } else {
        // A falling unit keeps its topple; everyone still standing leans.
        if (banked) quat.copy(this.#bankQuat);
        else quat.identity();
        pos.set(x, y, z);
      }
      scl.set(s, s, s);
      m.compose(pos, quat, scl);
      this.#body.setMatrixAt(i, m);

      // --- legs ---------------------------------------------------------
      // Each hangs from its own hip and swings the opposite way, and both
      // inherit the body's rotation so a toppling unit's legs go over with it.
      // A dying unit stops walking: the swing is scaled out over the fall, or
      // the corpse marches into the road.
      const gait = fall > 0 ? 0 : lerp(this.#prevSwing[i]!, this.#swing[i]!, alpha);
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? -1 : 1;
        this.#legQuat.setFromAxisAngle(LEG_AXIS, dir * gait);
        this.#legQuat.premultiply(quat);
        this.#hip.set(dir * LEG_X * s, HIP_Y * s, 0).applyQuaternion(quat);
        this.#hip.x += pos.x;
        this.#hip.y += pos.y;
        this.#hip.z += pos.z;
        m.compose(this.#hip, this.#legQuat, scl);
        this.#legs.setMatrixAt(i * 2 + side, m);
      }

      // The weapon rides the same transform as its carrier, offset to the
      // shoulder in unit space so it inherits the bob, the pop and the topple
      // for free.
      if (job >= 2 && fall === 0) {
        pos.set(x + KIT_X * s, y + KIT_Y * s, z + KIT_Z * s);
        const ks = s * KIT_SCALE;
        scl.set(ks, ks, ks);
        m.compose(pos, quat, scl);
        if (job === 2) this.#gunnerKit.setMatrixAt(gunnerCount++, m);
        else if (job === 3) this.#rocketKit.setMatrixAt(rocketCount++, m);
        else if (job === 4) this.#flamerKit.setMatrixAt(flamerCount++, m);
        else this.#freezerKit.setMatrixAt(freezerCount++, m);
      }

      // The shadow stays welded to the ground and shrinks as the unit rises —
      // that gap is the only cue that tells the eye the bob is a jump and not
      // the whole road moving.
      const sh =
        SHADOW_RADIUS * 2 * p * (elite ? ELITE_SCALE : 1) * (1 - (y / BOB_HEIGHT) * 0.3);
      pos.set(x + SHADOW_OFFSET_X, SHADOW_Y, z + SHADOW_OFFSET_Z);
      scl.set(sh, 1, sh);
      // NOT `quat`. The lean is a roll about the view axis, and a shadow that
      // rolls with it lifts off the road — the disc is authored lying in the
      // ground plane and the rotation would stand it up. A topple still applies,
      // because that one is about the X axis and keeps the disc flat.
      m.compose(pos, fall > 0 ? quat : IDENTITY_QUAT, scl);
      this.#shadow.setMatrixAt(i, m);
    }

    this.#renderDust();

    this.#body.count = n;
    this.#legs.count = n * 2;
    this.#shadow.count = n;
    this.#body.instanceMatrix.needsUpdate = true;
    this.#legs.instanceMatrix.needsUpdate = true;
    this.#shadow.instanceMatrix.needsUpdate = true;
    if (tintDirty) {
      tint.needsUpdate = true;
      legTint.needsUpdate = true;
    }
    this.#gunnerKit.count = gunnerCount;
    this.#rocketKit.count = rocketCount;
    this.#flamerKit.count = flamerCount;
    this.#freezerKit.count = freezerCount;
    this.#gunnerKit.instanceMatrix.needsUpdate = true;
    this.#rocketKit.instanceMatrix.needsUpdate = true;
    this.#flamerKit.instanceMatrix.needsUpdate = true;
    this.#freezerKit.instanceMatrix.needsUpdate = true;

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

  /**
   * Age the live puffs, slide them back down the road, and emit new ones if the
   * crowd is cutting hard enough to earn them.
   *
   * The pool is a ring: past DUST_CAPACITY live puffs the oldest is overwritten
   * rather than the newest dropped, because a trail that stops appearing at the
   * front is a trail that looks like it broke.
   */
  #updateDust(dt: number, scrollSpeed: number): void {
    for (let i = 0; i < DUST_CAPACITY; i++) {
      const life = this.#dustLife[i]!;
      if (life <= 0) continue;
      this.#dustLife[i] = Math.max(0, life - dt);
      this.#dustX[i]! += this.#dustVX[i]! * dt;
      // Dust is ON the road, so it travels with the road — otherwise it hangs in
      // the air behind a crowd that is supposed to be running forward.
      this.#dustZ[i]! += scrollSpeed * dt;
    }

    const speed = Math.abs(this.#centerVel);
    if (speed <= DUST_SPEED_MIN) {
      // Half of any fractional puff is kept, so a stuttering swipe still emits
      // rather than resetting its credit every time it dips under the threshold.
      this.#dustOwed *= 0.5;
      return;
    }
    const drive = Math.min(1, (speed - DUST_SPEED_MIN) / Math.max(0.001, LATERAL_SPEED - DUST_SPEED_MIN));
    this.#dustOwed += DUST_RATE * drive * dt;
    const sign = this.#centerVel > 0 ? 1 : -1;
    while (this.#dustOwed >= 1) {
      this.#dustOwed -= 1;
      const i = this.#dustNext;
      this.#dustNext = (i + 1) % DUST_CAPACITY;
      // OUTSIDE the trailing edge, not under it. A crowd moving right kicks its
      // grit up on the left, and at this camera the road under the crowd is the
      // one place nothing is visible — the bodies and their shadows cover it,
      // and the strip behind the rear rank is off the bottom of the frame. The
      // clear road is the flank the turn is leaving, which is also where the
      // eye already is during a swipe.
      this.#dustX[i] = this.#centerX - sign * this.#radiusX * (0.95 + Math.random() * 0.7);
      this.#dustZ[i] = SQUAD_Z + (Math.random() - 0.35) * 2 * this.#radiusZ;
      this.#dustVX[i] = -sign * (0.8 + Math.random() * 1.4);
      this.#dustLife[i] = DUST_LIFE;
    }
  }

  /** Write the puff matrices and alphas. Ages are read straight off the sim —
   *  a puff lives half a second, so interpolating it would cost more than it
   *  could possibly be worth. */
  #renderDust(): void {
    const m = this.#m;
    const pos = this.#pos;
    const scl = this.#scl;
    const alphas = this.#dustAlpha.array as Float32Array;
    let drawn = 0;
    for (let i = 0; i < DUST_CAPACITY; i++) {
      const life = this.#dustLife[i]!;
      if (life <= 0) continue;
      // t runs 0 at birth to 1 at death: the puff spreads out and thins.
      const t = 1 - life / DUST_LIFE;
      const size = DUST_SIZE * (1 + DUST_GROWTH * t);
      alphas[drawn] = DUST_ALPHA * (1 - t) * (1 - t);
      pos.set(this.#dustX[i]!, DUST_Y, this.#dustZ[i]!);
      scl.set(size, 1, size);
      m.compose(pos, IDENTITY_QUAT, scl);
      this.#dust.setMatrixAt(drawn, m);
      drawn++;
    }
    this.#dust.count = drawn;
    if (drawn > 0) {
      this.#dust.instanceMatrix.needsUpdate = true;
      this.#dustAlpha.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#scene.remove(
      this.#body,
      this.#shadow,
      this.#barGroup,
      this.#gunnerKit,
      this.#rocketKit,
      this.#flamerKit,
      this.#freezerKit,
    );
    for (const kit of [this.#gunnerKit, this.#rocketKit, this.#flamerKit, this.#freezerKit]) {
      kit.geometry.dispose();
      kit.dispose();
    }
    (this.#gunnerKit.material as THREE.Material).dispose();
    this.#body.geometry.dispose();
    (this.#body.material as THREE.Material).dispose();
    this.#body.dispose();
    this.#legs.geometry.dispose();
    (this.#legs.material as THREE.Material).dispose();
    this.#legs.dispose();
    this.#shadow.geometry.dispose();
    (this.#shadow.material as THREE.Material).dispose();
    this.#shadow.dispose();
    this.#shadowTexture.dispose();
    this.#dustTexture.dispose();
    this.#dust.geometry.dispose();
    (this.#dust.material as THREE.Material).dispose();
    this.#dust.dispose();
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
/** Under the shadows, still clear of the road plane. */
const DUST_Y = 0.008;

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/**
 * THE LEGS ARE NOT PART OF THE BODY MESH ANY MORE — they walk.
 *
 * The stride used to be BAKED into the merged figure: one leg forward, one back,
 * frozen, on the theory that the bob carried the run. It does not. A crowd
 * bouncing in place with rigid legs reads as a row of bollards on a conveyor,
 * and at the start of a run — one soldier, alone, on an empty bridge — there is
 * nothing else on screen to distract from it.
 *
 * So a leg is its own instanced mesh, authored around the hip so a rotation is
 * a plain angle, and it swings against the bob it already had. ONE mesh serves
 * both legs: instance 2i is the left, 2i+1 the right, mirrored by an x offset
 * and an opposite swing. That is one extra draw call for the whole army rather
 * than two, and a leg is symmetric so no geometry has to be mirrored.
 *
 * COSINE, NOT SINE, and the phase matters: the bob is `abs(sin)`, so it touches
 * zero at each footfall. Cosine puts the legs at full spread exactly there and
 * brings them together at the top of the bounce, which is what walking is. Sine
 * would plant both feet together at the bottom of every step.
 */
const LEG_SWING = 0.44;
/** Legs swing about X: rotating a downward leg by +θ throws the foot to −Z,
 *  which is down-road, away from the camera. */
const LEG_AXIS = new THREE.Vector3(1, 0, 0);
/** Hip height in unit space — the top of the thigh, which is where it pivots. */
const HIP_Y = 0.455;
/** Half the distance between the legs. */
const LEG_X = 0.105;
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

  // Legs are a separate mesh so they can walk — see LEG_SWING and
  // buildLegGeometry(). Everything from the hips up lives here.

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
  const yoke = new THREE.BoxGeometry(0.46, 0.15, 0.30);
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
  const brim = new THREE.CircleGeometry(0.275, 14);
  brim.rotateX(-Math.PI / 2);
  brim.rotateX(BODY_LEAN);
  brim.translate(0, 1.15, -0.13);
  parts.push({ geo: brim, color: COLOR_HELMET });

  // 16 segments AROUND, only 3 down. From a camera 34° above the crowd you read
  // the helmet's circular outline, not its profile, so the width segments are
  // what buy smoothness and the height segments are what waste triangles — and
  // the highlight is per-fragment, so it stays round however coarse the mesh is.
  // 14×6 looked identical to this and cost 112 triangles a unit instead of 64,
  // which is 60k triangles at a full army for nothing.
  const dome = new THREE.SphereGeometry(0.235, 16, 3, 0, Math.PI * 2, 0, Math.PI * 0.62);
  dome.translate(0, 1.15, -0.13);
  parts.push({ geo: dome, color: COLOR_HELMET });

  const merged = mergeParts(parts);
  // Lean pivots about the feet so the soles stay on the shadow.
  merged.rotateX(-BODY_LEAN);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * One leg, hanging from a hip at the origin.
 *
 * Authored downward from y=0 so the instance matrix can rotate it about the hip
 * with no pivot arithmetic at all. The boot is the important half: in a packed
 * clump the near-black boots are the only thing separating one unit's legs from
 * the next one's, and they are what the eye tracks when the crowd is walking.
 */
function buildLegGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const leg = new THREE.BoxGeometry(0.145, 0.44, 0.19);
  leg.translate(0, -0.22, 0);
  parts.push({ geo: leg, color: COLOR_TROUSERS });

  // Overlapping the bottom of the trouser, not hanging below it: the sole has to
  // land exactly on HIP_Y below the hip or the whole army walks on stilts a
  // centimetre above its own shadows.
  const boot = new THREE.BoxGeometry(0.17, 0.14, 0.27);
  boot.translate(0, -0.385, 0.04);
  parts.push({ geo: boot, color: COLOR_BOOT });

  const merged = mergeParts(parts);
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

  // Blue receiver — the pickup's own colour, so the object on the barrel and the
  // object on the shoulder are recognisably the same thing.
  const body = new THREE.BoxGeometry(0.24, 0.24, 0.34);
  body.translate(0, 0, 0.1);
  parts.push({ geo: body, color: COLOR_HELMET });

  // Brass drum, fat enough to read as the ammunition it is.
  const drum = new THREE.CylinderGeometry(0.15, 0.15, 0.18, 10);
  drum.rotateX(Math.PI / 2);
  drum.translate(0, 0, 0.02);
  parts.push({ geo: drum, color: KIT_BRASS });

  // SIX BARRELS IN A RING, and long. The rotary cluster is the entire read —
  // one tube is the rifle every other soldier already carries, and a short one
  // is a stub. This is what a playtester meant by "make the machine guns look
  // like machine guns".
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.CylinderGeometry(0.035, 0.035, 0.62, 5);
    b.rotateX(Math.PI / 2);
    b.translate(Math.cos(a) * 0.07, Math.sin(a) * 0.07, -0.42);
    parts.push({ geo: b, color: KIT_STEEL });
  }

  // Muzzle ring binding the barrels at the front — the detail that turns six
  // separate tubes into one gun.
  const ring = new THREE.CylinderGeometry(0.12, 0.12, 0.07, 10);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0, -0.7);
  parts.push({ geo: ring, color: KIT_GUNMETAL });

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
  const tube = new THREE.CylinderGeometry(0.1, 0.1, 0.86, 7);
  tube.rotateX(Math.PI / 2);
  parts.push({ geo: tube, color: KIT_GUNMETAL });

  // The warhead is the read: the only saturated red on a friendly unit, and
  // deliberately oversized against the tube it sits on.
  const head = new THREE.ConeGeometry(0.16, 0.34, 8);
  head.rotateX(-Math.PI / 2);
  head.translate(0, 0, -0.54);
  parts.push({ geo: head, color: KIT_WARHEAD });

  // Blast cone at the back, so the tube has a front and a back at a glance.
  const cone = new THREE.CylinderGeometry(0.15, 0.09, 0.2, 7);
  cone.rotateX(Math.PI / 2);
  cone.translate(0, 0, 0.5);
  parts.push({ geo: cone, color: KIT_GUNMETAL });

  const sight = new THREE.BoxGeometry(0.05, 0.11, 0.14);
  sight.translate(0, 0.14, -0.06);
  parts.push({ geo: sight, color: KIT_STEEL });

  const grip = new THREE.BoxGeometry(0.08, 0.16, 0.1);
  grip.translate(0, -0.14, 0.12);
  parts.push({ geo: grip, color: KIT_GUNMETAL });
  const merged = mergeParts(parts);
  // Pitched up and swung out for the same reason the rifle is — see RIFLE_PITCH.
  merged.rotateX(0.34);
  merged.rotateY(-0.42);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A shouldered FLAMETHROWER — a stubby wide nozzle and a fat fuel bottle.
 *
 * The read is SHORT AND WIDE, which is exactly what the weapon does. Every other
 * gun on this crowd is a long thin tube pointing down the road; this one is a
 * fat cylinder with a flared bell on the end, so a flamer carrier is
 * identifiable in a crowd of a hundred by silhouette alone. The pilot flame is
 * the giveaway detail — a small orange nub that burns whether or not the weapon
 * is firing, which is what says "fire" before a single round leaves it.
 */
function buildFlamerKit(): THREE.BufferGeometry {
  const parts: Part[] = [];

  // Fuel bottle on the back, oversized on purpose. It is the largest single
  // volume on the kit and it is what reads at distance.
  const tank = new THREE.CylinderGeometry(0.17, 0.17, 0.44, 9);
  tank.rotateX(Math.PI / 2);
  tank.translate(0, 0.02, 0.3);
  parts.push({ geo: tank, color: KIT_FUEL });

  // Cap and strap band, so the bottle reads as a pressure vessel rather than a
  // lozenge.
  const cap = new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8);
  cap.rotateX(Math.PI / 2);
  cap.translate(0, 0.02, 0.54);
  parts.push({ geo: cap, color: KIT_GUNMETAL });

  // The barrel: short, fat, and finished with a bell. Half the length of the
  // minigun's cluster, because the range is half as well.
  const barrel = new THREE.CylinderGeometry(0.075, 0.075, 0.4, 8);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, 0, -0.22);
  parts.push({ geo: barrel, color: KIT_GUNMETAL });

  const bell = new THREE.CylinderGeometry(0.17, 0.08, 0.19, 9);
  bell.rotateX(Math.PI / 2);
  bell.translate(0, 0, -0.5);
  parts.push({ geo: bell, color: KIT_STEEL });

  // The pilot flame. Small, saturated, and always lit.
  const pilot = new THREE.ConeGeometry(0.055, 0.15, 6);
  pilot.rotateX(-Math.PI / 2);
  pilot.translate(0, 0.11, -0.5);
  parts.push({ geo: pilot, color: KIT_FUEL });

  const grip = new THREE.BoxGeometry(0.08, 0.15, 0.1);
  grip.translate(0, -0.13, 0.06);
  parts.push({ geo: grip, color: KIT_GUNMETAL });

  const merged = mergeParts(parts);
  merged.rotateX(0.22);
  merged.rotateY(-0.38);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A shouldered FREEZE RAY — a slim emitter with a glowing coil.
 *
 * Built as the flamethrower's opposite in every axis that reads: long where the
 * flamer is short, thin where it is fat, and pale blue where it is orange. A
 * player who has seen one of these two knows what the other one is without being
 * told, which is the whole reason they were designed as a pair.
 */
function buildFreezerKit(): THREE.BufferGeometry {
  const parts: Part[] = [];

  const body = new THREE.BoxGeometry(0.16, 0.18, 0.36);
  body.translate(0, 0, 0.16);
  parts.push({ geo: body, color: KIT_GUNMETAL });

  // Long thin emitter tube.
  const tube = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 7);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, 0.02, -0.34);
  parts.push({ geo: tube, color: KIT_STEEL });

  // THREE COIL RINGS DOWN THE TUBE, and they are the whole identity. A single
  // pale tube is a rifle with the colour turned down; rings say the thing is
  // charged, and stacking three of them says it in a silhouette.
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.CylinderGeometry(0.105, 0.105, 0.055, 9);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.02, -0.16 - i * 0.19);
    parts.push({ geo: ring, color: KIT_ICE });
  }

  // Emitter dish on the nose, the one place the ice colour is allowed to be a
  // solid mass rather than a stripe.
  const dish = new THREE.CylinderGeometry(0.13, 0.07, 0.12, 9);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 0.02, -0.72);
  parts.push({ geo: dish, color: KIT_ICE });

  const grip = new THREE.BoxGeometry(0.075, 0.15, 0.1);
  grip.translate(0, -0.12, 0.14);
  parts.push({ geo: grip, color: KIT_GUNMETAL });

  const merged = mergeParts(parts);
  merged.rotateX(0.3);
  merged.rotateY(-0.4);
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

/** Softer and wider than the shadow's falloff — grit thrown up off a road has
 *  no edge to it, and a hard-edged disc reads as a decal. */
function buildDustTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.4, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
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
