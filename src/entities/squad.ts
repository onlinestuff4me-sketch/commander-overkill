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
 * shadows, two for the HP bar. ~143 triangles per unit, so 1200 troops is
 * ~172k tris in a single instanced call — vertex work a phone eats for
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
 * not length. Calibrated on `frame_023`: ~45 units measured 5.2 m across, so
 * half-width 2.6 at 50 units → 2.6/sqrt(50).
 */
const SPREAD = 0.368;
/**
 * Extra width at tiny counts, decaying as 1/n. Three soldiers do not pack —
 * they stand shoulder to shoulder, and `frame_009` measures ~1.7 m across where
 * the sqrt law alone predicts 1.3. Applied to width only, so small squads read
 * as a rank rather than a huddle. Below 1% by 100 units.
 */
const SMALL_SQUAD_FLARE = 1.0;
/** Depth:width of the silhouette. The reference reads ~5 deep by 9 wide. */
const DEPTH_RATIO = 0.556;
/** Hard cap on half-width: past this the clump would stand on the kerb. Hitting
 *  it at ~62 units is why the reference squad grows BACKWARDS after that, and
 *  why `frame_035` splits into two groups instead of one wider one. */
const RADIUS_X_MAX = 2.9;
/** Hard cap on half-depth. The camera's bottom edge lands at z ≈ +2.8, and
 *  SQUAD_Z + this + the jitter and straggler budget has to stay inside it or
 *  the rear rank walks off the bottom of the screen. */
const RADIUS_Z_MAX = 3.2;
/** Where the clump sits down the corridor. Bottom third of the frame. */
const SQUAD_Z = -1.6;

/** Per-unit target jitter, world units. This is what makes the edge ragged
 *  instead of a clean ellipse — the single biggest "is it a grid?" tell. */
const EDGE_JITTER = 0.26;
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

/** Uniform, straight off the reference: blue helmet, cream shirt, navy trousers. */
const COLOR_HELMET = 0x3f8ede;
const COLOR_SHIRT = 0xe8dcbc;
const COLOR_TROUSERS = 0x242f57;
const COLOR_SKIN = 0xe8b98c;
const COLOR_RIFLE = 0x30353f;

/** Baked-in forward lean. Costs nothing at runtime (it is part of the merged
 *  geometry) and does most of the work of selling "running" that a vertical bob
 *  alone cannot. */
const BODY_LEAN = 0.12;

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
   * Front-rank muzzle positions, for bullets and muzzle VFX. Writes into the
   * caller's preallocated vectors and returns how many were filled. O(n), no
   * allocation.
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
      this.#slotRadialJitter[i] = (rand() - 0.5) * 0.34;
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
    // Front band only — the reference fires from the leading rank, not from
    // inside the mass where the muzzle flashes would be buried. The slack term
    // keeps a one-man squad inside its own front rank: a band defined purely as
    // a fraction of the depth is empty when there is no depth, and `frame_000`
    // is a single soldier firing.
    const band = this.center.z - this.#radiusZ * 0.35 + FRONT_BAND_SLACK;
    const limit = Math.min(max, out.length, this.#count);
    let written = 0;
    for (let i = 0; i < this.#count && written < limit; i++) {
      if (this.#posZ[i]! > band) continue;
      const v = out[written];
      if (v === undefined) break;
      v.set(this.#posX[i]!, MUZZLE_Y * UNIT_SCALE + this.#bob[i]!, this.#posZ[i]! - MUZZLE_Z * UNIT_SCALE);
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
    const limit = Math.max(0, CORRIDOR_HALF_WIDTH - this.#radiusX * 0.7);
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
    const laneCap = CORRIDOR_HALF_WIDTH - 0.25;
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
        this.#posX[i] = this.#centerX + (tx - this.#centerX) * 1.18;
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
      let vx = this.#velX[i]! + ((tx - this.#posX[i]!) * k - this.#velX[i]! * c) * dt;
      let vz = this.#velZ[i]! + ((tz - this.#posZ[i]!) * k - this.#velZ[i]! * c) * dt;
      this.#velX[i] = vx;
      this.#velZ[i] = vz;
      this.#posX[i] = clamp(this.#posX[i]! + vx * dt, -laneCap, laneCap);
      this.#posZ[i] = this.#posZ[i]! + vz * dt;

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

  /** Clump ellipse from troop count. Only runs when the count actually moves. */
  #reshape(): void {
    if (this.#shapedFor === this.#count) return;
    this.#shapedFor = this.#count;

    const root = Math.sqrt(this.#count);
    const idealX = SPREAD * root * (1 + SMALL_SQUAD_FLARE / Math.max(1, this.#count));
    this.#radiusX = Math.min(RADIUS_X_MAX, idealX);

    // Once the road stops the clump getting wider, the area it wanted has to go
    // somewhere — so it goes backwards, and density only starts climbing after
    // the depth cap too. This is the reference's behaviour past ~60 units.
    const squeeze = idealX > 0 ? idealX / Math.max(this.#radiusX, 1e-4) : 1;
    this.#radiusZ = Math.min(RADIUS_Z_MAX, SPREAD * DEPTH_RATIO * root * squeeze);
  }
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Depth added to the front-rank band so tiny squads still have a front rank. */
const FRONT_BAND_SLACK = 0.3;

/** Rifle muzzle in unmodified unit space; scaled by UNIT_SCALE at the call site. */
const MUZZLE_Y = 0.77;
const MUZZLE_Z = 0.53;
/** Just clear of the road plane at y=0, without needing polygonOffset. */
const SHADOW_Y = 0.012;

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/**
 * One soldier as a single vertex-coloured geometry, ~143 triangles.
 *
 * Segment counts are as low as they go before the helmet stops reading as a
 * dome from directly above — and from this camera the helmet IS the unit. At
 * 1200 instances every extra triangle here costs 1200 on the GPU, so the head
 * is a 6-segment sphere and the torso is a 7-segment cylinder and nobody will
 * ever be able to tell.
 */
function buildSoldierGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];

  // Proportions are stubby on purpose. The reference unit is roughly as wide as
  // it is half-tall — chunky cartoon, not a realistic figure — and that width is
  // what lets 45 of them fill the road at shoulder-to-shoulder spacing.
  const legGeo = (side: number): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(0.16, 0.4, 0.18);
    g.translate(side * 0.115, 0.2, 0);
    return g;
  };
  parts.push({ geo: legGeo(-1), color: COLOR_TROUSERS });
  parts.push({ geo: legGeo(1), color: COLOR_TROUSERS });

  const torso = new THREE.CylinderGeometry(0.25, 0.22, 0.6, 7);
  torso.translate(0, 0.7, 0);
  parts.push({ geo: torso, color: COLOR_SHIRT });

  // One bar, not two arms: at the on-screen size of a unit in a 50-strong clump
  // the gap between two arms is sub-pixel, and this halves the triangle count.
  const arms = new THREE.BoxGeometry(0.52, 0.11, 0.26);
  arms.translate(0, 0.8, -0.13);
  parts.push({ geo: arms, color: COLOR_SHIRT });

  // The rifle is not decoration — in `frame_023` the dark slivers between the
  // helmets are what stop the crowd reading as a bag of blue marbles.
  const rifle = new THREE.BoxGeometry(0.055, 0.06, 0.5);
  rifle.translate(0.11, 0.77, -0.28);
  parts.push({ geo: rifle, color: COLOR_RIFLE });

  const head = new THREE.SphereGeometry(0.175, 6, 3);
  head.translate(0, 1.1, 0);
  parts.push({ geo: head, color: COLOR_SKIN });

  // A flat disc widening the helmet's footprint from above, for 8 triangles.
  // From this camera the crowd is mostly a field of blue discs, so the helmet's
  // top-down footprint matters more than any other measurement on the unit.
  const brim = new THREE.CircleGeometry(0.275, 8);
  brim.rotateX(-Math.PI / 2);
  brim.translate(0, 1.14, 0);
  parts.push({ geo: brim, color: COLOR_HELMET });

  const dome = new THREE.SphereGeometry(0.245, 7, 3, 0, Math.PI * 2, 0, Math.PI * 0.56);
  dome.translate(0, 1.14, 0);
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
