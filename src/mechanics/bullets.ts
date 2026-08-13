/**
 * BULLETS & FIREHOSE — everything the squad shoots, plus the flash at each end
 * of a bullet's life.
 *
 * ============================ PUBLIC API ====================================
 *
 *   const bullets = createBullets(scene);          // add once, at boot
 *   loop.update  → bullets.update(dt, world)       // fixed 60Hz, owns all RNG
 *   loop.render  → bullets.render(alpha, world)    // pure; safe to call twice
 *   teardown     → bullets.dispose()
 *
 * Automatic fire is driven entirely by `world.weaponTier` and `world.troops` —
 * the orchestrator does not have to call anything per-frame. The rest of the
 * surface is for the other element teams:
 *
 *   bullets.setMuzzle(x, y, z, halfWidth)
 *       SQUAD TEAM. Report the front edge of the blob once per tick and fire
 *       originates from a line across it. If nobody calls this, the muzzle is
 *       inferred from `world.squadCenter` and `world.troops`, so integration
 *       works before the squad exists.
 *
 *       Composes directly with the squad module's surface:
 *           bullets.setMuzzle(squad.center.x, squad.center.y + 1,
 *                             squad.center.z - squad.radiusZ, squad.radiusX);
 *
 *   bullets.fire(x, y, z, halfWidth, shots?)
 *       Manual volley, on top of automatic fire. For scripted beats. Pass
 *       halfWidth 0 to fire from one exact point, which is how you drive this
 *       off `squad.sampleShooters()` instead of off a muzzle line.
 *
 *   bullets.bullets  →  { count, ids, x, y, z, px, py, pz, damage }
 *       BARRELS/GATES TEAM. Live bullets as flat arrays, zero allocation.
 *       `ids[0 .. count)` are the valid slot ids; index every other array by
 *       the slot id, NOT by the loop counter. (px, py, pz) is the position at
 *       the START of this tick, so (px..pz)→(x..z) is a swept segment you can
 *       test against a barrel AABB without tunnelling at 34 m/s.
 *
 *   bullets.consume(id, hitX, hitY, hitZ)
 *       Bullet hit something: despawns it and pops the impact burst. Consuming
 *       swap-removes from `ids`, so ITERATE BACKWARDS if you consume mid-loop.
 *
 *   bullets.spawnImpact(x, y, z, scale?)   cosmetic burst with no bullet
 *   bullets.setEnabled(on)                 stop/start automatic fire
 *   bullets.tuning                         flat numbers, bind straight to lil-gui
 *
 * ============================ HOW IT LOOKS ==================================
 *
 * Three tiers, from `docs/reference/part1/`:
 *
 *   TIER 0  frame_000  1-3 lonely orange needles, ~18:1 aspect, near vertical.
 *   TIER 1  frame_030  3-6 of the same, still countable, front rank only.
 *   TIER 2  frame_035  the firehose: ~130 cyan teardrop darts, blunt nose
 *                      leading, long tapered tail, reading as one stream.
 *
 * THE CONE IS WIDE BECAUSE THE SQUAD IS WIDE, NOT BECAUSE THE SPREAD IS. This
 * is the one measurement that is easy to get wrong. Measured off frame_035 the
 * stream widens about 1.5 m over 12 m of depth — a ~4° half-angle. It *looks*
 * like a 25° fan on screen only because the camera views the corridor at a
 * grazing 22°, which stretches lateral motion and squashes forward motion.
 * Dial the angular spread up to match the screen and the darts spray sideways
 * out of the corridor.
 *
 * ============================ HOW IT DRAWS ==================================
 *
 * Four InstancedMeshes (tracers, darts, muzzle flames, impacts) = four draw
 * calls, two triangles each, additive, no depth writes, no shadows, no fog.
 * Nothing is allocated after construction: the pools are flat typed arrays and
 * every temporary in the hot loops is a module-scope scratch object.
 *
 * Sprites are camera-facing billboards rather than physically-oriented quads.
 * A physically-correct tracer lying along its own travel axis is foreshortened
 * to ~37% of its length by this camera and reads as a stubby dot — the
 * reference is clearly billboarding too. Because the camera is fixed (see
 * `core/renderer.ts`) the billboard basis is computed ONCE, and each bullet
 * only carries a roll about the view axis so its long axis tracks the
 * screen-space direction of travel. Full orientation is baked into a
 * quaternion at spawn, so the per-frame cost per bullet is a compose and a
 * buffer write.
 *
 * Colour is over-bright and additive: a dart tinted (0.30, 1.25, 1.70) clamps
 * to white where the texture is hottest and stays cyan in the halo. That is
 * the mechanism behind the reference's white-cored bolts, and it is why the
 * textures are baked as neutral intensity masks with only a hint of hue.
 */

import * as THREE from "three";
import type { System, WeaponTier, WorldState } from "../core/types";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";
import { CORRIDOR_HALF_WIDTH } from "./lane";

// ---------------------------------------------------------------------------
// Pool sizes. These size GPU buffers at boot and are never exceeded at runtime;
// a spawn against a full pool is dropped rather than growing anything.
// ---------------------------------------------------------------------------

/** Logical bullets alive at once. Steady state at tier 2 is ~130; the rest is
 *  headroom for manual volleys and for anyone cranking the rate in lil-gui. */
const BULLET_POOL = 768;
/** Tier 0/1 never exceeds ~7 live, but in-flight tracers survive a mid-flight
 *  tier change, so the orange batch keeps a comfortable margin over that. */
const TRACER_CAPACITY = 192;
const MUZZLE_POOL = 96;
const IMPACT_POOL = 64;
/** Backstop so a rate spike (or a paused tab) can never spawn an unbounded
 *  volley in a single tick. Normal tier-2 draw is ~5 shots/tick. */
const MAX_SHOTS_PER_TICK = 24;

const STYLE_TRACER = 0;
const STYLE_DART = 1;

// ---------------------------------------------------------------------------
// Tunables. Flat numbers on purpose — lil-gui binds to these directly.
// ---------------------------------------------------------------------------

export interface BulletTuning {
  /** TIER 0 — shots/sec with a single soldier, and the gain per extra troop. */
  tier0Rate: number;
  tier0RatePerTroop: number;
  /** TIER 1 — shots/sec ramps from min to max over `tier1RampTroops` troops. */
  tier1RateMin: number;
  tier1RateMax: number;
  tier1RampTroops: number;
  /** TIER 2 — same ramp, an order of magnitude faster. This is the firehose. */
  tier2RateMin: number;
  tier2RateMax: number;
  tier2RampTroops: number;

  /** Metres/sec. Streak length scales with this, so speed and look stay tied. */
  tracerSpeed: number;
  dartSpeed: number;
  /** Fractional per-bullet speed variance. Without it the stream forms visible
   *  ranks — this is what breaks the lattice at tier 2. */
  speedJitter: number;
  /** Metres a bullet travels before expiring. Sets on-screen density together
   *  with the fire rate: live bullets ≈ rate × range / speed. */
  range: number;

  /** Sprite size in metres at nominal speed, before per-bullet variance. */
  tracerLength: number;
  tracerWidth: number;
  dartLength: number;
  dartWidth: number;

  /** Random half-angle in radians added to every shot. */
  tier01Spread: number;
  tier2Spread: number;
  /** Radians of outward aim at the edge of the muzzle line — the cone proper.
   *  Kept deliberately small; see the note about the camera above. */
  tier2Diverge: number;
  /** Vertical velocity jitter, m/s. Purely so streaks do not share a plane. */
  riseJitter: number;

  /** Muzzle height above the road when inferred rather than reported. */
  muzzleY: number;
  /** 1-in-N tier-2 shots gets a muzzle flame. Every shot would be a strobe. */
  muzzleEveryNth: number;
  muzzleLength: number;
  muzzleWidth: number;
  muzzleLife: number;

  impactSize: number;
  impactLife: number;

  /** Seconds of fade-out at the end of a bullet's life, so range is a fade and
   *  not a pop. */
  fadeTime: number;
  /** Extra brightness for the first `hotTime` seconds out of the barrel. */
  hotBoost: number;
  hotTime: number;
  /** Master multiplier on every additive sprite. */
  brightness: number;

  /** Damage one bullet delivers; barrels just sum `damage` over their hits. */
  tracerDamage: number;
  dartDamage: number;
}

function defaultTuning(): BulletTuning {
  return {
    tier0Rate: 3.0,
    tier0RatePerTroop: 1.2,
    tier1RateMin: 6,
    tier1RateMax: 12,
    tier1RampTroops: 45,
    tier2RateMin: 80,
    tier2RateMax: 280,
    tier2RampTroops: 140,

    tracerSpeed: 44,
    dartSpeed: 34,
    speedJitter: 0.14,
    range: 22,

    // Measured off the frames against known road width: a tier-1 tracer is a
    // ~1.6 m needle roughly 18:1, a tier-2 dart is a ~0.45 m teardrop at 2.7:1.
    // Both are nudged up ~20% because our units are chunkier than the
    // reference's.
    tracerLength: 1.9,
    tracerWidth: 0.11,
    dartLength: 0.62,
    dartWidth: 0.23,

    tier01Spread: 0.012,
    tier2Spread: 0.03,
    tier2Diverge: 0.05,
    riseJitter: 0.5,

    muzzleY: 1.0,
    muzzleEveryNth: 6,
    muzzleLength: 0.62,
    muzzleWidth: 0.26,
    muzzleLife: 0.09,

    impactSize: 0.95,
    impactLife: 0.18,

    fadeTime: 0.1,
    hotBoost: 0.5,
    hotTime: 0.05,
    brightness: 1,

    tracerDamage: 1,
    dartDamage: 1,
  };
}

/** Over-bright additive tints. Values above 1 are intentional — that is what
 *  makes the core clamp to white while the halo keeps its hue. */
const TINT_WARM = { r: 1.85, g: 1.05, b: 0.4 };
const TINT_CYAN = { r: 0.3, g: 1.25, b: 1.7 };

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

/** Live bullets, as flat arrays. See the API notes at the top of the file. */
export interface BulletView {
  /** Valid length of `ids`. Changes as bullets spawn, expire and are consumed. */
  readonly count: number;
  /** Slot ids of live bullets. Index every other array with these, not with
   *  the loop counter. Treat as read-only. */
  readonly ids: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Position at the start of the current tick — the tail of the swept segment. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Damage this bullet delivers on impact. */
  readonly damage: Float32Array;
}

export interface BulletSystem extends System {
  /** Squad system: report the front rank once per tick. */
  setMuzzle(x: number, y: number, z: number, halfWidth: number): void;
  /** Manual volley from a muzzle line centred on (x, y, z). */
  fire(x: number, y: number, z: number, halfWidth: number, shots?: number): void;
  /** Live bullets for collision. */
  readonly bullets: BulletView;
  /** Despawn a bullet at its hit point and pop the impact burst. */
  consume(id: number, x: number, y: number, z: number): void;
  /** Impact burst with no bullet behind it — debris hits, barrel chip-off. */
  spawnImpact(x: number, y: number, z: number, scale?: number): void;
  /** Stop/start automatic fire (cutscenes, death, gate resolution). */
  setEnabled(on: boolean): void;
  readonly tuning: BulletTuning;
}

// ---------------------------------------------------------------------------
// Billboard basis — fixed, because the camera is.
//
// Local +Z is the quad normal and points back at the camera. Local +Y is the
// world travel direction (-Z) projected into that plane, which lands at ~22°
// off world-up: an upright sprite leaning back into the camera. Local +X falls
// out as world +X.
// ---------------------------------------------------------------------------

const VIEW_NORMAL = new THREE.Vector3().subVectors(CAMERA_POS, CAMERA_LOOK).normalize();
const BILLBOARD_UP = new THREE.Vector3(0, 0, -1)
  .addScaledVector(VIEW_NORMAL, VIEW_NORMAL.z /* = -dot((0,0,-1), n) */)
  .normalize();
const BILLBOARD_RIGHT = new THREE.Vector3().crossVectors(BILLBOARD_UP, VIEW_NORMAL).normalize();
const BILLBOARD = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(BILLBOARD_RIGHT, BILLBOARD_UP, VIEW_NORMAL),
);

/** How much world +Y and world +Z contribute to "up the screen". Used to turn
 *  a velocity into the sprite roll that keeps the streak aligned with travel. */
const UP_FROM_WORLD_Y = BILLBOARD_UP.y;
const UP_FROM_WORLD_Z = BILLBOARD_UP.z;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _col = new THREE.Color();
const _roll = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Roll that points the sprite's long axis along this velocity, on screen. */
function rollFor(vx: number, vy: number, vz: number): number {
  const up = vy * UP_FROM_WORLD_Y + vz * UP_FROM_WORLD_Z;
  return Math.atan2(-vx, up);
}

// ---------------------------------------------------------------------------
// SpriteBatch — one InstancedMesh, refilled from scratch every frame.
//
// Rewriting the whole buffer beats tracking which slots changed: at these
// counts the upload dominates either way, and "count = however many I pushed"
// removes a whole class of stale-instance bug.
// ---------------------------------------------------------------------------

class SpriteBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly #capacity: number;
  #n = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    renderOrder: number,
  ) {
    this.#capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    // The instances move every frame and their union bounds is the whole
    // corridor, so per-object culling can only ever be wrong or wasted work.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Touch one instance so three allocates instanceColor up front rather than
    // mid-frame on the first shot.
    this.mesh.setColorAt(0, _col.setRGB(1, 1, 1));
    this.mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  }

  reset(): void {
    this.#n = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    roll: number,
    width: number,
    length: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (this.#n >= this.#capacity) return;
    _pos.set(x, y, z);
    _quat.copy(BILLBOARD).multiply(_roll.setFromAxisAngle(_zAxis, roll));
    _scale.set(width, length, 1);
    _mat.compose(_pos, _quat, _scale);
    this.mesh.setMatrixAt(this.#n, _mat);
    this.mesh.setColorAt(this.#n, _col.setRGB(r, g, b));
    this.#n++;
  }

  flush(): void {
    this.mesh.count = this.#n;
    this.mesh.visible = this.#n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Puffs — muzzle flames and impact bursts. Static, short-lived, non-colliding,
// so they get a ring buffer instead of a free list: at 96 slots and a 0.09 s
// life the write head laps the live set by a wide margin, and there is no
// bookkeeping to get wrong.
// ---------------------------------------------------------------------------

class Puffs {
  readonly #cap: number;
  readonly #x: Float32Array;
  readonly #y: Float32Array;
  readonly #z: Float32Array;
  readonly #life: Float32Array;
  readonly #maxLife: Float32Array;
  readonly #size: Float32Array;
  readonly #roll: Float32Array;
  readonly #r: Float32Array;
  readonly #g: Float32Array;
  readonly #b: Float32Array;
  #head = 0;

  constructor(capacity: number) {
    this.#cap = capacity;
    this.#x = new Float32Array(capacity);
    this.#y = new Float32Array(capacity);
    this.#z = new Float32Array(capacity);
    this.#life = new Float32Array(capacity);
    this.#maxLife = new Float32Array(capacity);
    this.#size = new Float32Array(capacity);
    this.#roll = new Float32Array(capacity);
    this.#r = new Float32Array(capacity);
    this.#g = new Float32Array(capacity);
    this.#b = new Float32Array(capacity);
  }

  spawn(
    x: number,
    y: number,
    z: number,
    life: number,
    size: number,
    roll: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const i = this.#head;
    this.#head = (this.#head + 1) % this.#cap;
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = z;
    this.#life[i] = life;
    this.#maxLife[i] = life;
    this.#size[i] = size;
    this.#roll[i] = roll;
    this.#r[i] = r;
    this.#g[i] = g;
    this.#b[i] = b;
  }

  advance(dt: number): void {
    for (let i = 0; i < this.#cap; i++) {
      const life = this.#life[i]!;
      if (life > 0) this.#life[i] = life - dt;
    }
  }

  /**
   * `shape(u)` maps normalised age 0..1 to [widthScale, lengthScale, brightness],
   * written into the supplied scratch triple so nothing allocates per puff.
   */
  draw(
    batch: SpriteBatch,
    baseWidth: number,
    baseLength: number,
    brightness: number,
    shape: (u: number, out: Float32Array) => void,
    out: Float32Array,
  ): void {
    for (let i = 0; i < this.#cap; i++) {
      const life = this.#life[i]!;
      if (life <= 0) continue;
      const u = 1 - life / this.#maxLife[i]!;
      shape(u, out);
      const k = out[2]! * brightness;
      const s = this.#size[i]!;
      batch.push(
        this.#x[i]!,
        this.#y[i]!,
        this.#z[i]!,
        this.#roll[i]!,
        baseWidth * s * out[0]!,
        baseLength * s * out[1]!,
        this.#r[i]! * k,
        this.#g[i]! * k,
        this.#b[i]! * k,
      );
    }
  }
}

/** A muzzle flame licks out fast then collapses back into the barrel. */
function muzzleShape(u: number, out: Float32Array): void {
  out[0] = 1 - 0.35 * u;
  out[1] = 1 - 0.5 * u;
  out[2] = 1 - u * u;
}

/** An impact pops open and fades — see the barrel hit in frame_005. */
function impactShape(u: number, out: Float32Array): void {
  const s = 0.5 + 1.1 * u;
  out[0] = s;
  out[1] = s;
  out[2] = (1 - u) * (1 - u) * 1.6;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

class Bullets implements BulletSystem, BulletView {
  readonly tuning = defaultTuning();

  // --- pool, structure-of-arrays ---
  readonly ids = new Int32Array(BULLET_POOL);
  readonly x = new Float32Array(BULLET_POOL);
  readonly y = new Float32Array(BULLET_POOL);
  readonly z = new Float32Array(BULLET_POOL);
  readonly px = new Float32Array(BULLET_POOL);
  readonly py = new Float32Array(BULLET_POOL);
  readonly pz = new Float32Array(BULLET_POOL);
  readonly damage = new Float32Array(BULLET_POOL);
  readonly #vx = new Float32Array(BULLET_POOL);
  readonly #vy = new Float32Array(BULLET_POOL);
  readonly #vz = new Float32Array(BULLET_POOL);
  readonly #invSpeed = new Float32Array(BULLET_POOL);
  readonly #life = new Float32Array(BULLET_POOL);
  readonly #maxLife = new Float32Array(BULLET_POOL);
  readonly #roll = new Float32Array(BULLET_POOL);
  readonly #size = new Float32Array(BULLET_POOL);
  readonly #style = new Uint8Array(BULLET_POOL);
  /** Where each slot sits inside `ids`, so a consume is an O(1) swap-remove. */
  readonly #slot = new Int32Array(BULLET_POOL);
  readonly #free = new Int32Array(BULLET_POOL);
  #freeCount = BULLET_POOL;
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /** Self-reference: the system IS the view, but callers get the narrow type. */
  get bullets(): BulletView {
    return this;
  }

  // --- rendering ---
  readonly #scene: THREE.Scene;
  readonly #geometry = new THREE.PlaneGeometry(1, 1);
  readonly #needleTex: THREE.CanvasTexture;
  readonly #dartTex: THREE.CanvasTexture;
  readonly #burstTex: THREE.CanvasTexture;
  readonly #needleMat: THREE.MeshBasicMaterial;
  readonly #dartMat: THREE.MeshBasicMaterial;
  readonly #burstMat: THREE.MeshBasicMaterial;
  readonly #tracerBatch: SpriteBatch;
  readonly #dartBatch: SpriteBatch;
  readonly #muzzleBatch: SpriteBatch;
  readonly #impactBatch: SpriteBatch;
  readonly #muzzles = new Puffs(MUZZLE_POOL);
  readonly #impacts = new Puffs(IMPACT_POOL);
  readonly #shape = new Float32Array(3);

  // --- firing state ---
  #enabled = true;
  #fireAcc = 0;
  #shotIndex = 0;
  #tier: WeaponTier = 0;
  #muzzleX = 0;
  #muzzleY = 1;
  #muzzleZ = 0;
  #muzzleHalfWidth = 0.5;
  #muzzleReported = false;
  #disposed = false;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    for (let i = 0; i < BULLET_POOL; i++) this.#free[i] = BULLET_POOL - 1 - i;

    this.#needleTex = needleTexture();
    this.#dartTex = dartTexture();
    this.#burstTex = burstTexture();

    this.#needleMat = additiveMaterial(this.#needleTex);
    this.#dartMat = additiveMaterial(this.#dartTex);
    this.#burstMat = additiveMaterial(this.#burstTex);

    // Muzzle flames share the needle texture with tracers — the reference's
    // muzzle flash is just a short fat version of the same flame lick.
    this.#tracerBatch = new SpriteBatch(this.#geometry, this.#needleMat, TRACER_CAPACITY, 10);
    this.#dartBatch = new SpriteBatch(this.#geometry, this.#dartMat, BULLET_POOL, 10);
    this.#muzzleBatch = new SpriteBatch(this.#geometry, this.#needleMat, MUZZLE_POOL, 11);
    this.#impactBatch = new SpriteBatch(this.#geometry, this.#burstMat, IMPACT_POOL, 12);

    scene.add(this.#tracerBatch.mesh);
    scene.add(this.#dartBatch.mesh);
    scene.add(this.#muzzleBatch.mesh);
    scene.add(this.#impactBatch.mesh);
  }

  // ------------------------------------------------------------------ public

  setMuzzle(x: number, y: number, z: number, halfWidth: number): void {
    this.#muzzleX = x;
    this.#muzzleY = y;
    this.#muzzleZ = z;
    this.#muzzleHalfWidth = Math.min(halfWidth, CORRIDOR_HALF_WIDTH);
    this.#muzzleReported = true;
  }

  fire(x: number, y: number, z: number, halfWidth: number, shots = 1): void {
    const hw = Math.min(halfWidth, CORRIDOR_HALF_WIDTH);
    const n = Math.min(shots, MAX_SHOTS_PER_TICK);
    for (let i = 0; i < n; i++) this.#shoot(x, y, z, hw, this.#tier, 0);
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (!on) this.#fireAcc = 0;
  }

  consume(id: number, x: number, y: number, z: number): void {
    // Full validation, not just a range check: a caller that walks `ids` past
    // `count` hands us `undefined`, which sails through every comparison and
    // would corrupt the free list silently.
    if (!Number.isInteger(id) || id < 0 || id >= BULLET_POOL) return;
    if (this.#life[id]! <= 0) return;
    // The burst matches the round that made it, not the tier we happen to be
    // on — orange tracers still in flight when the upgrade lands must not land
    // as cyan sparks.
    const warm = this.#style[id] === STYLE_TRACER;
    this.#release(id);
    this.#burst(x, y, z, warm ? 0.85 : 0.6, warm ? TINT_WARM : TINT_CYAN);
  }

  spawnImpact(x: number, y: number, z: number, scale = 1): void {
    this.#burst(x, y, z, scale, this.#tier === 2 ? TINT_CYAN : TINT_WARM);
  }

  // ------------------------------------------------------------------ system

  update(dt: number, world: WorldState): void {
    this.#tier = world.weaponTier;
    this.#advance(dt);
    this.#muzzles.advance(dt);
    this.#impacts.advance(dt);

    if (!this.#enabled) {
      this.#muzzleReported = false;
      return;
    }

    // The squad's report only counts for the tick it was made in; if the squad
    // system is not wired up yet we fall back to inferring the front rank so
    // the module is useful on its own.
    if (!this.#muzzleReported) this.#inferMuzzle(world);
    this.#muzzleReported = false;

    const rate = shotsPerSecond(world.weaponTier, world.troops, this.tuning);
    if (rate <= 0) return;

    const interval = 1 / rate;
    this.#fireAcc += dt;
    let guard = MAX_SHOTS_PER_TICK;
    while (this.#fireAcc >= interval && guard > 0) {
      this.#fireAcc -= interval;
      guard--;
      // `#fireAcc` is now exactly how long ago inside this tick the shot went
      // off, so advancing the bullet by that much spreads a volley smoothly
      // between tick boundaries. Skipping this is what makes an instanced
      // stream look like marching rows.
      this.#shoot(
        this.#muzzleX,
        this.#muzzleY,
        this.#muzzleZ,
        this.#muzzleHalfWidth,
        world.weaponTier,
        this.#fireAcc,
      );
    }
    // A backlog can only come from a rate spike or a resumed tab; catching up
    // on it would fire a wall of bullets nobody asked for.
    if (guard === 0) this.#fireAcc = 0;
  }

  render(alpha: number, _world: WorldState): void {
    const t = this.tuning;
    this.#tracerBatch.reset();
    this.#dartBatch.reset();
    this.#muzzleBatch.reset();
    this.#impactBatch.reset();

    for (let i = 0; i < this.#count; i++) {
      const id = this.ids[i]!;
      const life = this.#life[id]!;
      const age = this.#maxLife[id]! - life;

      // Fade in hot out of the barrel, fade out before the range limit, so
      // neither end of the trajectory pops.
      let k = t.brightness;
      if (life < t.fadeTime) k *= life / t.fadeTime;
      if (age < t.hotTime) k *= 1 + t.hotBoost * (1 - age / t.hotTime);

      const dart = this.#style[id] === STYLE_DART;
      const size = this.#size[id]!;
      const length = (dart ? t.dartLength : t.tracerLength) * size;
      const width = (dart ? t.dartWidth : t.tracerWidth) * size;
      const tint = dart ? TINT_CYAN : TINT_WARM;

      // Interpolate the nose, then push the sprite back by half its length so
      // the nose — not the sprite centre — sits on the collision point.
      const inv = this.#invSpeed[id]!;
      const half = length * 0.5;
      const nx = this.px[id]! + (this.x[id]! - this.px[id]!) * alpha;
      const ny = this.py[id]! + (this.y[id]! - this.py[id]!) * alpha;
      const nz = this.pz[id]! + (this.z[id]! - this.pz[id]!) * alpha;

      (dart ? this.#dartBatch : this.#tracerBatch).push(
        nx - this.#vx[id]! * inv * half,
        ny - this.#vy[id]! * inv * half,
        nz - this.#vz[id]! * inv * half,
        this.#roll[id]!,
        width,
        length,
        tint.r * k,
        tint.g * k,
        tint.b * k,
      );
    }

    this.#muzzles.draw(
      this.#muzzleBatch,
      t.muzzleWidth,
      t.muzzleLength,
      t.brightness * 1.3,
      muzzleShape,
      this.#shape,
    );
    this.#impacts.draw(
      this.#impactBatch,
      t.impactSize,
      t.impactSize,
      t.brightness,
      impactShape,
      this.#shape,
    );

    this.#tracerBatch.flush();
    this.#dartBatch.flush();
    this.#muzzleBatch.flush();
    this.#impactBatch.flush();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const batch of [
      this.#tracerBatch,
      this.#dartBatch,
      this.#muzzleBatch,
      this.#impactBatch,
    ]) {
      this.#scene.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.#geometry.dispose();
    this.#needleMat.dispose();
    this.#dartMat.dispose();
    this.#burstMat.dispose();
    this.#needleTex.dispose();
    this.#dartTex.dispose();
    this.#burstTex.dispose();
  }

  // ----------------------------------------------------------------- private

  #advance(dt: number): void {
    // Backwards, because expiring swap-removes the tail into the current slot —
    // the element that lands here has already been stepped this tick.
    for (let i = this.#count - 1; i >= 0; i--) {
      const id = this.ids[i]!;
      const cx = this.x[id]!;
      const cy = this.y[id]!;
      const cz = this.z[id]!;
      this.px[id] = cx;
      this.py[id] = cy;
      this.pz[id] = cz;
      this.x[id] = cx + this.#vx[id]! * dt;
      this.y[id] = cy + this.#vy[id]! * dt;
      this.z[id] = cz + this.#vz[id]! * dt;
      const life = this.#life[id]! - dt;
      this.#life[id] = life;
      if (life <= 0) this.#release(id);
    }
  }

  /**
   * Front rank of the blob, inferred. The reference's clump is a rough ellipse
   * wider than it is deep and grows with the square root of its population.
   * Calibrated against REFERENCE.md: ~9 units across at 50 troops, which on a
   * 6.8 m road is about 3.6 m — so half-width lands near 1.8 at 50.
   */
  #inferMuzzle(world: WorldState): void {
    const root = Math.sqrt(Math.max(1, world.troops));
    const halfWidth = Math.min(0.4 + 0.2 * root, CORRIDOR_HALF_WIDTH - 0.6);
    const depth = Math.min(0.3 + 0.11 * root, 1.6);
    this.#muzzleX = world.squadCenter.x;
    this.#muzzleY = world.squadCenter.y + this.tuning.muzzleY;
    this.#muzzleZ = world.squadCenter.z - depth;
    this.#muzzleHalfWidth = halfWidth;
  }

  /** One shot. `age` is how far into its flight it already is, in seconds. */
  #shoot(
    cx: number,
    cy: number,
    cz: number,
    halfWidth: number,
    tier: WeaponTier,
    age: number,
  ): void {
    if (this.#freeCount === 0) return;
    const t = this.tuning;
    const dart = tier === 2;

    // Triangular rather than uniform across the muzzle line: the blob is denser
    // through the middle, and a uniform pick reads as a curtain with hard edges.
    const u = Math.random() + Math.random() - 1;

    const spread = dart ? t.tier2Spread : t.tier01Spread;
    const angle = u * (dart ? t.tier2Diverge : 0) + (Math.random() * 2 - 1) * spread;
    const speed =
      (dart ? t.dartSpeed : t.tracerSpeed) * (1 + (Math.random() - 0.5) * t.speedJitter);

    const vx = Math.sin(angle) * speed;
    const vz = -Math.cos(angle) * speed;
    const vy = (Math.random() - 0.5) * t.riseJitter;

    // A fire rate slower than one shot per flight time makes the sub-tick
    // catch-up longer than the bullet lives. Nothing to draw, so don't take a
    // slot for it.
    const maxLife = t.range / speed;
    if (age >= maxLife) return;

    // Muzzles stay on the road even if the blob is reported wider than it;
    // the bullets themselves are free to drift over the kerb, which is what
    // the reference's tier-2 cone does on its right-hand edge.
    const edge = CORRIDOR_HALF_WIDTH - 0.1;
    const ox = Math.min(Math.max(cx + u * halfWidth, -edge), edge);
    const oy = cy + (Math.random() - 0.5) * 0.12;
    // Ragged front edge — the reference's outermost units trail the blob.
    const oz = cz - Math.random() * 0.25;

    const id = this.#free[--this.#freeCount]!;
    this.#slot[id] = this.#count;
    this.ids[this.#count++] = id;

    this.x[id] = ox + vx * age;
    this.y[id] = oy + vy * age;
    this.z[id] = oz + vz * age;
    this.px[id] = this.x[id]!;
    this.py[id] = this.y[id]!;
    this.pz[id] = this.z[id]!;
    this.#vx[id] = vx;
    this.#vy[id] = vy;
    this.#vz[id] = vz;
    this.#invSpeed[id] = 1 / speed;
    this.#maxLife[id] = maxLife;
    this.#life[id] = maxLife - age;
    this.#roll[id] = rollFor(vx, vy, vz);
    this.#style[id] = dart ? STYLE_DART : STYLE_TRACER;
    this.damage[id] = dart ? t.dartDamage : t.tracerDamage;
    // Length tracks speed so a faster round is a longer streak, and a little
    // per-bullet variance stops the stream reading as clones.
    const nominal = dart ? t.dartSpeed : t.tracerSpeed;
    this.#size[id] = (speed / nominal) * (0.88 + Math.random() * 0.24);

    // Every tier-0/1 shot flashes; at 280 rounds/sec that would be a strobe, so
    // the firehose only flashes on every Nth.
    this.#shotIndex++;
    const flash = !dart || this.#shotIndex % Math.max(1, t.muzzleEveryNth | 0) === 0;
    if (flash) {
      const tint = dart ? TINT_CYAN : TINT_WARM;
      this.#muzzles.spawn(
        ox,
        oy,
        oz - t.muzzleLength * 0.4,
        t.muzzleLife,
        0.85 + Math.random() * 0.4,
        rollFor(vx, vy, vz) + (Math.random() - 0.5) * 0.25,
        tint.r,
        tint.g,
        tint.b,
      );
    }
  }

  /** `size` is a multiplier on `tuning.impactSize`, which `Puffs.draw` applies
   *  — storing absolute metres here would square it. */
  #burst(x: number, y: number, z: number, scale: number, tint: { r: number; g: number; b: number }): void {
    this.#impacts.spawn(
      x,
      y,
      z,
      this.tuning.impactLife,
      scale * (0.9 + Math.random() * 0.2),
      Math.random() * Math.PI * 2,
      tint.r,
      tint.g,
      tint.b,
    );
  }

  #release(id: number): void {
    this.#life[id] = 0;
    const slot = this.#slot[id]!;
    const last = this.ids[--this.#count]!;
    this.ids[slot] = last;
    this.#slot[last] = slot;
    this.#free[this.#freeCount++] = id;
  }
}

function shotsPerSecond(tier: WeaponTier, troops: number, t: BulletTuning): number {
  if (tier === 0) {
    return t.tier0Rate + t.tier0RatePerTroop * (Math.min(Math.max(troops, 1), 3) - 1);
  }
  if (tier === 1) {
    return lerp(t.tier1RateMin, t.tier1RateMax, clamp01((troops - 3) / t.tier1RampTroops));
  }
  return lerp(t.tier2RateMin, t.tier2RateMax, clamp01(troops / t.tier2RampTroops));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Materials & procedural textures
//
// Fog is off deliberately: additive blending toward a bright fog colour makes
// distant bullets glow *brighter*, which is backwards. Bullets expire inside
// the fog's near plane instead.
// ---------------------------------------------------------------------------

function additiveMaterial(map: THREE.CanvasTexture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

function canvas2d(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d")!;
}

function finish(ctx: CanvasRenderingContext2D): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Clamped, or the linear filter wraps the hot core round to the opposite
  // edge and every sprite gets a bright seam.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * The tier-0/1 tracer, and the muzzle flame. A soft needle: pale core the whole
 * length, warm halo, hot at the nose (canvas top = the sprite's leading edge),
 * fading to nothing at the tail. Shaped by multiplying alpha with a horizontal
 * falloff rather than by clipping a path, because a hard silhouette at 32 px
 * across aliases badly once it is scaled down to a few screen pixels.
 */
function needleTexture(): THREE.CanvasTexture {
  const W = 32;
  const H = 256;
  const ctx = canvas2d(W, H);

  const along = ctx.createLinearGradient(0, 0, 0, H);
  along.addColorStop(0.0, "rgba(255,255,255,0)");
  along.addColorStop(0.05, "rgba(255,255,255,1)");
  along.addColorStop(0.14, "rgba(255,247,214,1)");
  along.addColorStop(0.36, "rgba(255,206,128,0.95)");
  along.addColorStop(0.7, "rgba(255,170,96,0.45)");
  along.addColorStop(1.0, "rgba(255,150,80,0)");
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, W, H);

  const across = ctx.createLinearGradient(0, 0, W, 0);
  across.addColorStop(0.0, "rgba(0,0,0,0)");
  across.addColorStop(0.3, "rgba(0,0,0,0.28)");
  across.addColorStop(0.5, "rgba(0,0,0,1)");
  across.addColorStop(0.7, "rgba(0,0,0,0.28)");
  across.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, W, H);

  return finish(ctx);
}

/**
 * The tier-2 dart. frame_035 zoomed 6x: a blunt round nose leading, a long
 * tail tapering to a point, a pale core inside a cyan body. Built from three
 * concentric teardrops composited with `lighter` — stacking translucent passes
 * gives the glow falloff for free and avoids depending on `ctx.filter`, which
 * older mobile Safari does not have.
 */
function dartTexture(): THREE.CanvasTexture {
  const W = 64;
  const H = 160;
  const ctx = canvas2d(W, H);
  const cx = W / 2;
  ctx.globalCompositeOperation = "lighter";

  teardrop(ctx, cx, 6, W * 0.46, H * 0.9, "rgba(40,150,255,0.5)");
  teardrop(ctx, cx, 9, W * 0.33, H * 0.82, "rgba(80,214,255,0.8)");
  teardrop(ctx, cx, 13, W * 0.19, H * 0.6, "rgba(205,247,255,0.95)");

  // White-hot pip inside the nose — this is what survives when the sprite is
  // only a few pixels tall at the far end of the corridor.
  const nose = ctx.createRadialGradient(cx, 26, 0, cx, 26, 14);
  nose.addColorStop(0, "rgba(255,255,255,1)");
  nose.addColorStop(0.5, "rgba(220,250,255,0.55)");
  nose.addColorStop(1, "rgba(160,235,255,0)");
  ctx.fillStyle = nose;
  ctx.fillRect(0, 0, W, 60);

  return finish(ctx);
}

function teardrop(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  halfWidth: number,
  length: number,
  fill: string,
): void {
  const noseY = top + halfWidth;
  const tipY = top + length;
  ctx.beginPath();
  // PI → 0 sweeps over the top of the circle in canvas space (y grows down).
  ctx.arc(cx, noseY, halfWidth, Math.PI, 0);
  ctx.quadraticCurveTo(cx + halfWidth * 0.55, noseY + (tipY - noseY) * 0.45, cx, tipY);
  ctx.quadraticCurveTo(cx - halfWidth * 0.55, noseY + (tipY - noseY) * 0.45, cx - halfWidth, noseY);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Impact burst — the barrel hit in frame_005: a white core, a warm halo, and a
 * few hard radiating spikes. Baked neutral so the same texture tints warm for
 * bullets and cyan for the firehose.
 */
function burstTexture(): THREE.CanvasTexture {
  const S = 128;
  const ctx = canvas2d(S, S);
  const c = S / 2;
  ctx.globalCompositeOperation = "lighter";

  const halo = ctx.createRadialGradient(c, c, 0, c, c, c);
  halo.addColorStop(0.0, "rgba(255,255,255,1)");
  halo.addColorStop(0.16, "rgba(255,250,230,0.85)");
  halo.addColorStop(0.42, "rgba(255,225,170,0.32)");
  halo.addColorStop(1.0, "rgba(255,200,140,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  // Spikes at uneven lengths — an even star reads as a UI sparkle rather than
  // something being hit.
  const spikes = [1.0, 0.62, 0.86, 0.55, 0.94, 0.6, 0.78, 0.5];
  ctx.translate(c, c);
  for (let i = 0; i < spikes.length; i++) {
    const len = c * 0.98 * spikes[i]!;
    ctx.save();
    ctx.rotate((i / spikes.length) * Math.PI * 2 + 0.2);
    const g = ctx.createLinearGradient(0, 0, 0, -len);
    g.addColorStop(0, "rgba(255,252,240,0.9)");
    g.addColorStop(0.45, "rgba(255,236,190,0.35)");
    g.addColorStop(1, "rgba(255,210,150,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-c * 0.075, 0);
    ctx.lineTo(0, -len);
    ctx.lineTo(c * 0.075, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return finish(ctx);
}

/**
 * Build the bullet system and attach its four instanced meshes to the scene.
 * Everything is allocated here; nothing allocates again for the life of the run.
 */
export function createBullets(scene: THREE.Scene): BulletSystem {
  return new Bullets(scene);
}
