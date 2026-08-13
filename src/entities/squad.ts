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
 * CALIBRATION, AND THE BUG THAT WAS IN IT. `frame_023` measures ~5.2 m across
 * at ~45 units, and the first cut turned that into `SPREAD = 2.6/sqrt(50)`.
 * That equated a MEASURED SPAN with the ellipse's SEMI-AXIS, which are not the
 * same number: the span a camera sees is the semi-axis plus the radial jitter
 * (×1.17 at the rim), plus the edge jitter and jostle, plus a whole unit's
 * half-width of body hanging off the outermost soldier. Those extras are worth
 * ~1.0 m per side, so the old constant produced a clump ~7.6 m across — wider
 * than the 6.8 m road, which is exactly why the rim units were standing on the
 * grass. Solving the same 5.2 m measurement for the semi-axis instead gives
 * 1.61 at 50 units, i.e. 1.61/sqrt(50).
 */
const SPREAD = 0.224;
/**
 * Extra width at tiny counts, decaying as 1/n. Three soldiers do not pack —
 * they stand shoulder to shoulder, and `frame_009` measures ~1.7 m across where
 * the sqrt law alone predicts 1.3. Applied to width only, so small squads read
 * as a rank rather than a huddle. Below 1% by 100 units.
 */
const SMALL_SQUAD_FLARE = 1.0;
/** Depth:width of the silhouette. The reference reads ~5 deep by 9 wide. */
const DEPTH_RATIO = 0.556;
/** Hard cap on half-depth. The camera's bottom edge lands at z ≈ +2.8, and
 *  SQUAD_Z + this + the jitter and straggler budget has to stay inside it or
 *  the rear rank walks off the bottom of the screen. */
const RADIUS_Z_MAX = 3.2;
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

/** Position spring. Low enough that individuals visibly lag the blob when the
 *  lane changes, then catch up — a rigid translation reads as a decal. */
const SPRING_K = 34;
/** <1 is underdamped, so units overshoot slightly and jostle on arrival. */
const SPRING_DAMPING_RATIO = 0.86;
/** Per-unit stiffness spread. Uniform stiffness = everyone lags identically =
 *  rigid again, just delayed. */
const SPRING_K_SPREAD = 0.45;

/** Slow lateral/forward wander so the mass never looks frozen when standing still. */
const JOSTLE_AMPLITUDE = 0.07;
const JOSTLE_RATE = 1.3;
/** Slack the containment maths leaves for the spring. At damping ratio 0.86 the
 *  step overshoot is only ~0.5%, but the centre moves continuously, so units
 *  settle from behind and can tick a little past their target on arrival. */
const SPRING_SLACK = 0.06;

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

/** How fast the blob centre chases the steering input. Matches the Commander's
 *  follow so the two read as one vehicle. */
const CENTER_FOLLOW = 12;

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
/** The rifle reads LIGHT in the reference, not dark — the barrel catches the sky
 *  and shows up as a pale sliver between the helmets. A gunmetal rifle vanishes
 *  under this backlighting. Wood stock behind it for the two-tone the reference
 *  weapons have. */
const COLOR_RIFLE_METAL = 0xd8c8b4;
const COLOR_RIFLE_WOOD = 0x9c6538;

/** Baked-in forward lean. Costs nothing at runtime (it is part of the merged
 *  geometry) and does most of the work of selling "running" that a vertical bob
 *  alone cannot. */
const BODY_LEAN = 0.12;

// ---------------------------------------------------------------------------
// CONTAINMENT — derived, not tuned
//
// "No unit stands on the grass" is three separate margins, and the first cut
// only had a fraction of the first one:
//
//   1. the blob's own reach — the ellipse PLUS the radial jitter, edge jitter,
//      jostle and spring slack that sit on top of it,
//   2. the unit's own body — a soldier clamped by his navel still puts a
//      shoulder over the kerb,
//   3. perspective — a soldier is 1.2 m tall and the camera is only 34° above
//      him, so his shoulders project further from the road's centreline than his
//      boots do. Feet inside the kerb is not the same as body inside the kerb,
//      and it is worse the nearer the camera he stands.
//
// Everything below falls out of those three; nothing here is eyeballed.
// ---------------------------------------------------------------------------

/** Raw-geometry half-width of the widest part of a unit, and how high that
 *  widest part sits. Both are the shoulder yoke's top corners, and the geometry
 *  below is built FROM these rather than measured against them, so the two
 *  cannot drift apart. The height is what drives margin 3. */
const UNIT_HALF_WIDTH = 0.32;
const UNIT_SHOULDER_Y = 1.07;

/** Mirrors the kerb `lane.ts` builds — a 0.35-thick, 0.4-tall box straddling
 *  ±CORRIDOR_HALF_WIDTH. Its inner face is the line a body may not cross. These
 *  two numbers are the only thing this module duplicates from that file; if the
 *  kerb changes shape, they change with it. */
const KERB_INSET = 0.2;
const KERB_TOP_Y = 0.4;

/**
 * Depth of a world point along the camera's forward axis. The camera never
 * moves, so this is a fixed function of (y, z) and runs once at module load.
 */
function cameraDepth(y: number, z: number): number {
  const dx = CAMERA_LOOK.x - CAMERA_POS.x;
  const dy = CAMERA_LOOK.y - CAMERA_POS.y;
  const dz = CAMERA_LOOK.z - CAMERA_POS.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return -((dy / len) * (y - CAMERA_POS.y) + (dz / len) * (z - CAMERA_POS.z));
}

/**
 * Hard limit on a unit's centre X. A point's horizontal screen position is
 * x / depth, so the kerb's inner face defines a SLOPE, and anything standing
 * higher than the kerb has to come further in to stay behind that slope.
 * Evaluated at the nearest z the blob can reach, because near the camera the
 * depth is smallest and the outward drift is therefore largest. Works out to
 * ~2.77 — a good 0.4 tighter than the naive `CORRIDOR_HALF_WIDTH - 0.25`.
 */
const UNIT_X_LIMIT = (() => {
  const zNear =
    SQUAD_Z + RADIUS_Z_MAX * (1 + RADIAL_JITTER / 2) + EDGE_JITTER + STRAGGLER_TRAIL;
  const kerbSlope = (CORRIDOR_HALF_WIDTH - KERB_INSET) / cameraDepth(KERB_TOP_Y, zNear);
  return (
    kerbSlope * cameraDepth(UNIT_SHOULDER_Y * UNIT_SCALE, zNear) - UNIT_HALF_WIDTH * UNIT_SCALE
  );
})();

/**
 * Steering swing we refuse to trade away no matter how big the squad gets. A
 * clump as wide as the road cannot steer, which is honest physics and is what
 * makes big squads feel unwieldy — but zero is not a difficulty curve, it is a
 * broken control, so the clump stops widening before it eats the last of it.
 */
const MIN_STEER_RANGE = 0.5;

/**
 * Hard cap on half-width — the largest ellipse whose rim units still fit inside
 * UNIT_X_LIMIT with MIN_STEER_RANGE left over. ~1.60, reached at ~50 units.
 * Past that the area the clump wanted has to go somewhere, so it goes backwards:
 * that is the reference's behaviour in the late run, and why `frame_035` splits
 * into two groups rather than one wider one.
 */
const RADIUS_X_MAX =
  (UNIT_X_LIMIT - MIN_STEER_RANGE - EDGE_JITTER - JOSTLE_AMPLITUDE - SPRING_SLACK) /
  (1 + RADIAL_JITTER / 2);

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

  // --- centre steering ---
  #centerX = 0;
  #prevCenterX = 0;

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
    scene.add(this.#body);

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

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  update(dt: number, world: WorldState): void {
    this.#time += dt;
    this.setCount(world.troops);
    this.#reshape();

    // Big clumps cannot use the full lane range without standing on the grass.
    // Shrinking the range with the blob is the honest consequence of being
    // wide, and it is what makes the reference's big squads feel unwieldy.
    //
    // This is the FIRST of two containment gates and the one that does the real
    // work: keep the centre far enough in that no target is ever placed outside
    // the road, and the per-unit clamp below stays a safety net instead of
    // becoming a wall the rim units pile up against.
    const limit = Math.max(0, UNIT_X_LIMIT - this.#halfExtent());
    const targetX = clamp(laneToX(world.squadLane), -limit, limit);

    this.#prevCenterX = this.#centerX;
    this.#centerX += (targetX - this.#centerX) * Math.min(1, CENTER_FOLLOW * dt);
    this.center.set(this.#centerX, 0, SQUAD_Z);
    world.squadCenter.copy(this.center);

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
        // Clamped like any other position: the 1.18 overshoot is the one place
        // a unit is deliberately placed OUTSIDE the blob's own reach, so it is
        // also the one place that would put a body on the kerb for free.
        this.#posX[i] = clamp(
          this.#centerX + (tx - this.#centerX) * 1.18,
          -UNIT_X_LIMIT,
          UNIT_X_LIMIT,
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

      // Second containment gate. The centre limit above means this almost never
      // fires; it exists for the frames where it can — a hard steer where the
      // spring is still carrying units outward after the centre has already
      // stopped. Kill the outward velocity too, or a unit parks on the limit
      // with stored momentum and snaps when it is finally released.
      const nx = this.#posX[i]! + vx * dt;
      if (nx > UNIT_X_LIMIT) {
        this.#posX[i] = UNIT_X_LIMIT;
        this.#velX[i] = vx < 0 ? vx : 0;
      } else if (nx < -UNIT_X_LIMIT) {
        this.#posX[i] = -UNIT_X_LIMIT;
        this.#velX[i] = vx > 0 ? vx : 0;
      } else {
        this.#posX[i] = nx;
        this.#velX[i] = vx;
      }

      // --- pop scale ---
      const goal = alive ? 1 : 0;
      const pv = this.#popVel[i]! + ((goal - this.#pop[i]!) * POP_K - this.#popVel[i]! * POP_C) * dt;
      this.#popVel[i] = pv;
      const p = this.#pop[i]! + pv * dt;
      this.#pop[i] = p < 0 ? 0 : p;

      // --- run-in-place bob ---
      this.#bob[i] = Math.abs(Math.sin(t * this.#slotBobRate[i]! + this.#slotBobPhase[i]!)) * BOB_HEIGHT;

      // Zero it outright on the way out, or the slot freezes mid-shrink and
      // leaves a sliver of a soldier standing on the road forever.
      if (!alive && this.#pop[i]! < 0.01) {
        this.#live[i] = 0;
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

    for (let i = 0; i < n; i++) {
      const x = lerp(this.#prevX[i]!, this.#posX[i]!, alpha);
      const z = lerp(this.#prevZ[i]!, this.#posZ[i]!, alpha);
      const y = lerp(this.#prevBob[i]!, this.#bob[i]!, alpha);
      const p = lerp(this.#prevPop[i]!, this.#pop[i]!, alpha);
      const s = p * UNIT_SCALE;

      pos.set(x, y, z);
      scl.set(s, s, s);
      m.compose(pos, quat, scl);
      this.#body.setMatrixAt(i, m);

      // The shadow stays welded to the ground and shrinks as the unit rises —
      // that gap is the only cue that tells the eye the bob is a jump and not
      // the whole road moving.
      const sh = SHADOW_RADIUS * 2 * p * (1 - (y / BOB_HEIGHT) * 0.3);
      pos.set(x + SHADOW_OFFSET_X, SHADOW_Y, z + SHADOW_OFFSET_Z);
      scl.set(sh, 1, sh);
      m.compose(pos, quat, scl);
      this.#shadow.setMatrixAt(i, m);
    }

    this.#body.count = n;
    this.#shadow.count = n;
    this.#body.instanceMatrix.needsUpdate = true;
    this.#shadow.instanceMatrix.needsUpdate = true;

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

    this.#scene.remove(this.#body, this.#shadow, this.#barGroup);
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
   * Furthest from the blob centre that a unit's TARGET can be placed. Every term
   * the layout adds on top of the ellipse belongs in this sum — if one goes
   * missing, the steering limit built on it is a lie and the rim walks onto the
   * grass. Mirrors the `tx` expression in update() exactly, at its worst case.
   *
   * A lone soldier is not on the rim (rNorm is 0 at count ≤ 1), so he gets the
   * core's tightened jitter and keeps nearly the whole road to steer with.
   */
  #halfExtent(): number {
    const rim = this.#count > 1 ? 1 : 0;
    const loose = CORE_TIGHTNESS + (1 - CORE_TIGHTNESS) * rim;
    return (
      this.#radiusX * rim * (1 + RADIAL_JITTER / 2) +
      EDGE_JITTER * loose +
      JOSTLE_AMPLITUDE +
      SPRING_SLACK
    );
  }

  /** Clump ellipse from troop count. Only runs when the count actually moves. */
  #reshape(): void {
    if (this.#shapedFor === this.#count) return;
    this.#shapedFor = this.#count;

    const root = Math.sqrt(this.#count);
    const idealX = SPREAD * root * (1 + SMALL_SQUAD_FLARE / Math.max(1, this.#count));
    this.#radiusX = Math.min(RADIUS_X_MAX, idealX);

    // Once the road stops the clump getting wider, the area it wanted has to go
    // somewhere — so it goes backwards, and density only starts climbing after
    // the depth cap too. This is the reference's behaviour past ~50 units.
    const squeeze = idealX > 0 ? idealX / Math.max(this.#radiusX, 1e-4) : 1;
    this.#radiusZ = Math.min(RADIUS_Z_MAX, SPREAD * DEPTH_RATIO * root * squeeze);
  }
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------


/** Rifle muzzle in unmodified unit space; scaled by UNIT_SCALE at the call site.
 *  Read straight off the rifle's front face after the pitch, yaw and body lean
 *  below — if the rifle moves, these move with it. */
const MUZZLE_X = 0.239;
const MUZZLE_Y = 0.969;
const MUZZLE_Z = 0.863;
/** Just clear of the road plane at y=0, without needing polygonOffset. */
const SHADOW_Y = 0.012;

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/** How far each leg swings out of the stride. Both legs at z=0 is what made the
 *  lower body read as one block. */
const LEG_STRIDE = 0.16;
/** Rifle attitude. Pitched up and yawed across to +X, which is the pose in
 *  `frame_000` — muzzle clearing the helmet, butt in at the chest. */
const RIFLE_PITCH = 0.3;
const RIFLE_YAW = -0.28;
const RIFLE_X = 0.135;
const RIFLE_Y = 0.95;
const RIFLE_Z = -0.35;

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
    const leg = new THREE.BoxGeometry(0.155, 0.44, 0.19);
    leg.rotateX(-side * LEG_STRIDE);
    leg.translate(side * 0.115, 0.235, side * 0.05);
    parts.push({ geo: leg, color: COLOR_TROUSERS });

    const boot = new THREE.BoxGeometry(0.175, 0.13, 0.26);
    boot.translate(side * 0.115, 0.07, side * 0.085);
    parts.push({ geo: boot, color: COLOR_BOOT });
  }

  // --- torso and shoulder yoke ---------------------------------------------
  const torso = new THREE.BoxGeometry(0.42, 0.54, 0.32);
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
  const armL = new THREE.BoxGeometry(0.12, 0.12, 0.5);
  armL.rotateX(-0.14);
  armL.rotateY(-0.57);
  armL.translate(-0.035, 0.935, -0.21);
  parts.push({ geo: armL, color: COLOR_SHIRT });

  const armR = new THREE.BoxGeometry(0.12, 0.12, 0.38);
  armR.rotateX(-0.25);
  armR.translate(0.2, 0.925, -0.18);
  parts.push({ geo: armR, color: COLOR_SHIRT });

  // --- rifle ---------------------------------------------------------------
  // Built along -Z, then pitched, yawed and carried into place as one piece so
  // the two boxes cannot drift apart. Length is cartoon-long on purpose: the
  // muzzle has to clear the helmet on screen or the diagonal never breaks the
  // blob's outline, which is the entire point of drawing it.
  const barrel = new THREE.BoxGeometry(0.05, 0.055, 0.72);
  barrel.translate(0, 0, -0.06);
  const stock = new THREE.BoxGeometry(0.062, 0.1, 0.22);
  stock.translate(0, -0.012, 0.25);
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
  const head = new THREE.SphereGeometry(0.165, 6, 2);
  head.translate(0, 1.11, -0.1);
  parts.push({ geo: head, color: COLOR_SKIN });

  // Brim: a flat disc overhanging the dome by 0.05 all round, levelled against
  // the body lean the same way the yoke is. Nine triangles for the single
  // cheapest "that is a helmet, not a ball" cue available.
  const brim = new THREE.CircleGeometry(0.285, 9);
  brim.rotateX(-Math.PI / 2);
  brim.rotateX(BODY_LEAN);
  brim.translate(0, 1.15, -0.13);
  parts.push({ geo: brim, color: COLOR_HELMET });

  const dome = new THREE.SphereGeometry(0.235, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.55);
  dome.translate(0, 1.14, -0.13);
  parts.push({ geo: dome, color: COLOR_HELMET });

  const merged = mergeParts(parts);
  // Lean pivots about the feet so the soles stay on the shadow.
  merged.rotateX(-BODY_LEAN);
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
