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
 *   bullets.setShooters(points, n)
 *       SQUAD TEAM, PREFERRED. Per-unit muzzle positions, reported once per
 *       tick from `squad.sampleShooters(scratch, MAX_STREAMS)`. Stream `i`
 *       fires from `points[i]` for as long as it keeps being reported there,
 *       so the ORDER MUST BE STABLE across ticks — a reshuffle teleports the
 *       streams. More than MAX_STREAMS points are subsampled with a stride.
 *
 *   bullets.setMuzzle(x, y, z, halfWidth)
 *       FALLBACK, and the source of the blob's centre line either way. Report
 *       the front edge of the blob and its half-width; streams with no reported
 *       soldier behind them are distributed across that blob, so the firehose
 *       is still one-stream-per-troop when the squad can only report a subset.
 *       If nobody calls either, the blob is inferred from `world.squadCenter`
 *       and `world.troops`, so this module is useful standing alone.
 *
 *       Composes directly with the squad module's surface:
 *           bullets.setMuzzle(squad.center.x, squad.center.y + 1,
 *                             squad.center.z - squad.radiusZ, squad.radiusX);
 *
 *   bullets.fire(x, y, z, halfWidth, shots?)
 *       Manual volley, on top of automatic fire. For scripted beats. Pass
 *       halfWidth 0 to fire from one exact point.
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
 * ========================= ONE STREAM PER TROOP ==============================
 *
 * EVERY SOLDIER FIRES ITS OWN STREAM. One troop is one stream, three troops are
 * three parallel streams you can count, twenty troops are twenty. Density comes
 * from THE NUMBER OF SHOOTERS and from nothing else — there is deliberately no
 * shots/second curve that ramps with troop count, because a few fast muzzles
 * read as a few fast muzzles no matter how fast they go.
 *
 * Three things make that read:
 *
 *   POSITION.  Stream `s` starts at soldier `s`'s own muzzle, so the streams are
 *              spread across the blob exactly as the units are. Its origin is
 *              stable frame to frame, which is what turns a sequence of shots
 *              into a *line* rather than a spray.
 *   PHASE.     Each stream's fire clock is offset by frac(s · φ) of a shot
 *              period (φ = golden ratio, so any prefix is maximally spread).
 *              Without this every soldier fires on the same tick and the
 *              firehose pulses in synchronised volleys instead of reading as
 *              continuous fire.
 *   RATE.      Roughly constant PER SOLDIER (see `tierNRatePerShooter`). Total
 *              volume is then troops × rate, automatically.
 *
 * SATURATION. `BULLET_POOL` is finite and one stream per troop at 1200 troops
 * would ask for ~13× it. Two mechanisms, in this order:
 *
 *   1. Streams are capped at MAX_STREAMS. Past that the extra troops raise the
 *      rate of the existing streams instead of adding new ones — at MAX_STREAMS
 *      the streams are ~6 cm apart across the widest legal blob, so they have
 *      already merged into one wall and adding more is invisible anyway.
 *   2. The TOTAL shot rate is soft-clipped to `maxLiveBullets / flightTime` by
 *      `total = desired / (1 + (desired/max)^k)^(1/k)`. That function is
 *      strictly increasing with an asymptote at the budget: more troops is
 *      always more bullets, and the pool can never be overrun. With the default
 *      knee (k = 3) the clip costs under 3% up to ~50 troops and only bites
 *      where the screen is saturated regardless.
 *
 * Overflow past that is still handled — a spawn against a full pool is dropped
 * — but the budget is set so it never happens in normal play.
 *
 * ============================ HOW IT LOOKS ==================================
 *
 * Three tiers, from `docs/reference/part1/`:
 *
 *   TIER 0  frame_000  1-3 lonely orange dashes, ~5:1 aspect, near vertical.
 *   TIER 1  frame_030  the same dashes, one column per soldier, countable.
 *   TIER 2  frame_035  the firehose: cyan teardrop darts at ~2.5:1, blunt nose
 *                      leading, enough columns that they read as one stream.
 *
 * ROUNDS ARE SHORT. Re-measured off the frames by isolating bullet pixels and
 * scaling by the road width in the same screen row: a tracer is 0.28 m long and
 * 0.055 m wide, a dart 0.47 x 0.18. An earlier pass recorded 1.9 m at 18:1,
 * which is 6x too long, and rounds that long touch each other inside a stream
 * and turn it into a continuous pale jet. If the streams ever start looking
 * like steam plumes again, this is the first number to check.
 *
 * THE STREAM CONVERGES, IT DOES NOT FAN. Measured on frame_030: the muzzle line
 * spans 2.21 m and the same fire in flight spans 0.72 m. An earlier note in
 * this file read that as a ~4° divergence; it is a ~4° CONVERGENCE, and the
 * sign is the whole difference between fire that points at a target and fire
 * that sprays past it. See `#advance` for the model and why it matters for how
 * aiming feels. Density is still the shooter count's job, never the spread's.
 *
 * Most of a stream's angular error is FIXED PER STREAM (`shotJitterFraction`
 * decides how much is re-rolled per shot). A stream that re-rolls its whole aim
 * every shot is a cone of noise, not a line.
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

/** Logical bullets alive at once. `tuning.maxLiveBullets` is the rate governor's
 *  target and sits below this; the gap is headroom for manual volleys and for
 *  rounds still in flight across a tier change. */
const BULLET_POOL = 768;
/**
 * Both bullet batches are sized for the whole pool rather than for their tier's
 * expected share. Tier 0/1 used to top out at a handful of live tracers; with
 * one stream per troop it can now be hundreds, and a batch that overflows drops
 * sprites silently while the bullets behind them keep dealing damage — an
 * invisible-bullet bug that is very hard to see and very easy to avoid. The
 * second buffer costs ~60 kB.
 */
const TRACER_CAPACITY = BULLET_POOL;
const MUZZLE_POOL = 96;
/** Bigger than it looks like it needs to be: at firehose density a barrel row
 *  can eat dozens of rounds in one tick, and this ring buffer overwrites its
 *  oldest entries rather than dropping new ones. */
const IMPACT_POOL = 128;
/**
 * Concurrent streams. Past this, extra troops raise the rate of the streams
 * that exist instead of adding more (see the saturation note at the top). 96
 * streams across the widest legal blob (2 × RADIUS_X_MAX = 5.8 m) is one every
 * 6 cm — well past the point where the eye can resolve them individually.
 */
export const MAX_STREAMS = 96;
/** Backstop so a rate spike (or a paused tab) can never spawn an unbounded
 *  volley in a single tick. The governed rate draws ~16 shots/tick at the
 *  budget, so this only ever catches pathology. */
const MAX_SHOTS_PER_TICK = 64;
/** Per-stream backstop for the same reason: one soldier cannot empty the pool. */
const MAX_SHOTS_PER_STREAM_PER_TICK = 4;

/** frac(s · φ) walks the unit interval without ever repeating or clustering, so
 *  any prefix of the streams is already evenly spread in fire phase. */
const GOLDEN_FRACTION = 0.618033988749895;
/** Vogel spiral, for placing streams that have no reported soldier behind them.
 *  Mirrors the squad's own layout (`entities/squad.ts`) on purpose. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** The squad's depth:width ratio, replicated so a synthesised blob has the same
 *  silhouette as the real one. Only used for the fallback layout. */
const BLOB_DEPTH_RATIO = 0.556;

const STYLE_TRACER = 0;
const STYLE_DART = 1;

// ---------------------------------------------------------------------------
// Tunables. Flat numbers on purpose — lil-gui binds to these directly.
// ---------------------------------------------------------------------------

export interface BulletTuning {
  /**
   * Shots/sec FOR ONE SOLDIER, per tier. Total volume is this times the troop
   * count — do NOT reintroduce a troop-count ramp here, that is the bug this
   * model exists to fix. What these actually control is the gap between rounds
   * inside a single stream: gap = speed / rate, so tier 1 at 7/s and 44 m/s
   * puts a needle every 6.3 m, which is what keeps a stream countable.
   */
  tier0RatePerShooter: number;
  tier1RatePerShooter: number;
  tier2RatePerShooter: number;

  /**
   * Ceiling on live bullets that the rate governor aims at, below BULLET_POOL
   * so manual volleys and a mid-flight tier change still fit. Raising this past
   * the pool does not overflow anything — spawns against a full pool are simply
   * dropped — it just stops the governor being the thing that limits density.
   */
  maxLiveBullets: number;
  /**
   * Knee of the soft clip that holds the total rate under that ceiling. Higher
   * = stays linear for longer and then corners harder; 1 is a lazy hyperbola
   * that starts costing rate immediately. 3 keeps the loss under 3% to ~50
   * troops while still climbing monotonically to the cap at 1200.
   */
  saturationKnee: number;
  /** Concurrent streams, clamped to MAX_STREAMS. Lower it to see the streams
   *  separate at high troop counts; it does not change total volume. */
  maxStreams: number;

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

  /** Random half-angle in radians on a stream's aim. This, not the blob width,
   *  is what sets the width of the converged column at target depth. */
  tier01Spread: number;
  tier2Spread: number;
  /** How much of that spread is re-rolled per shot; the rest is fixed for the
   *  life of the stream. At 1 a stream is a cone of noise instead of a line. */
  shotJitterFraction: number;

  /**
   * CONVERGENCE. Metres over which a round's lateral offset from the squad's
   * firing axis decays by 1/e. Lower = the army's fire focuses into a column
   * sooner. **Zero disables it entirely**, and zero is the shipped default —
   * the fire travels as a parallel curtain the full width of the crowd. See the
   * long note above `#advance`.
   */
  convergeDistance: number;
  /** Hard cap on how far inward a round may be aimed, radians. The outermost
   *  soldier of a wide blob would otherwise fire visibly sideways. */
  convergeMaxAngle: number;
  /** Vertical velocity jitter, m/s. Purely so streaks do not share a plane. */
  riseJitter: number;

  /** Muzzle height above the road when inferred rather than reported. */
  muzzleY: number;
  /**
   * Ceiling on muzzle flames per second, across all streams. A fixed 1-in-N
   * stride cannot serve both one soldier (where every shot should flash) and a
   * thousand (where it would be a strobe and would lap the flame pool every
   * other frame), so the stride is derived from this and the live shot rate.
   */
  muzzleRateCap: number;
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
    // Per soldier. Chosen so one stream reads as a dotted line rather than as a
    // solid rod: at tier 0 a soldier keeps ~2.5 needles in the air (frame_000
    // shows 1-3), at tier 2 ~6.5 darts spaced 3.4 m apart.
    tier0RatePerShooter: 5,
    tier1RatePerShooter: 7,
    // HALVED, and `dartDamage` doubled to match, so the firehose is the same
    // weapon with half as much of it in the air. Measured: 310 darts live at 50
    // troops became 161, and 541 at 120 became 361, while damage per pass did
    // not drop — it rose slightly, because a lower nominal rate sits further
    // under the governor's soft clip and loses less to it. The gap inside one
    // stream goes 3.4 m → 6.8 m, still three darts to a stream over the 22 m
    // range, so it keeps reading as a stream rather than as countable rounds.
    tier2RatePerShooter: 5,

    maxLiveBullets: 620,
    saturationKnee: 3,
    maxStreams: MAX_STREAMS,

    tracerSpeed: 44,
    dartSpeed: 34,
    speedJitter: 0.14,
    range: 22,

    // RE-MEASURED off the frames, by isolating actual bullet pixels and scaling
    // by the road width in the same screen row. The previous numbers here (1.9 m
    // needle at 18:1) were off by 6x in length and came from measuring the
    // reference's yellow ENEMY SOLDIERS rather than its tracers — which is what
    // made our tier 0/1 streams read as continuous pale jets: consecutive rounds
    // in one stream were long enough to touch. The real thing is a short dash.
    //
    //   frame_030 tracer   0.25-0.31 m long, 0.05-0.06 m wide, ~5.5:1
    //   frame_035 dart     0.47 m long,      0.18 m wide,      ~2.5:1
    tracerLength: 0.28,
    tracerWidth: 0.055,
    dartLength: 0.47,
    dartWidth: 0.18,

    tier01Spread: 0.012,
    tier2Spread: 0.03,
    shotJitterFraction: 0.25,
    // OFF. The army fires as a parallel curtain as wide as it is; see the note
    // above `#advance` for why this stopped being 6.
    convergeDistance: 0,
    convergeMaxAngle: 0.209,
    riseJitter: 0.5,

    muzzleY: 1.0,
    muzzleRateCap: 220,
    muzzleLength: 0.5,
    muzzleWidth: 0.22,
    muzzleLife: 0.09,

    impactSize: 0.95,
    impactLife: 0.18,

    fadeTime: 0.1,
    hotBoost: 0.5,
    hotTime: 0.05,
    brightness: 1,

    tracerDamage: 1,
    /**
     * TWO, not one. Damage is otherwise 1 per round across the board so that
     * "bullets fired" and "damage dealt" are the same number — a genuinely
     * useful property while debugging. It is given up here on purpose: cutting
     * the tier 2 rate to halve the on-screen density would otherwise halve the
     * firehose's damage and make the upgrade a downgrade, and damage is the one
     * lever that changes the numbers without changing the picture. Barrel hit
     * points read this through `damagePerPass`, so nothing needs re-tuning by
     * hand when it moves.
     */
    dartDamage: 2,
  };
}

/**
 * Per-instance tints for the ROUNDS. Held at 1 on purpose.
 *
 * These used to be over-bright (1.85, 1.05, 0.40) on the theory that additive
 * blending clamps the core to white and leaves the hue in the halo. That is
 * true over black and false over our road — see the blending note above the
 * textures. Under alpha compositing a multiplier above 1 clamps to white and
 * destroys the hue, and a multiplier below 1 walks the round toward BLACK
 * rather than toward invisible. The colour now lives in the texture, where it
 * can vary from a hot core to a saturated body, and intensity lives in alpha.
 *
 * They stay as tints rather than being folded away because they are the hook a
 * powerup or a damage flash would grab.
 */
const TINT_WARM = { r: 1, g: 1, b: 1 };
const TINT_CYAN = { r: 1, g: 1, b: 1 };
/**
 * Impact bursts are still ADDITIVE — a hit flash is a light source, it should
 * blow out, and it lasts 0.18 s so it never has to hold a hue. Kept just under
 * the clamp so the fringe still reads warm/cool instead of grey.
 */
const BURST_WARM = { r: 1.0, g: 0.72, b: 0.3 };
const BURST_CYAN = { r: 0.3, g: 0.95, b: 1.0 };
/**
 * Muzzle flames. These DO carry their colour in the tint, because the flame
 * texture is deliberately neutral white — the flame has to be warm at tier 0/1
 * and cyan at tier 2 off one texture, and under compositing `tint × white` is
 * exactly the tint. Both sit at 1.0 in their hot channel and low in the
 * opposite one, which is where the saturation comes from.
 */
const FLAME_WARM = { r: 1.0, g: 0.72, b: 0.22 };
const FLAME_CYAN = { r: 0.35, g: 0.92, b: 1.0 };

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
  /**
   * Squad system: report per-unit muzzle positions once per tick, ideally from
   * `squad.sampleShooters(scratch, MAX_STREAMS)`. Stream `i` fires from
   * `points[i]`, so the ORDER MUST BE STABLE tick to tick. `count` may exceed
   * `MAX_STREAMS` — the excess is subsampled with a stride, never truncated,
   * so the streams still span the whole blob.
   *
   * The vectors are read and copied immediately; the caller keeps ownership and
   * may reuse them. Reporting fewer than `world.troops` positions is fine: the
   * remaining streams are laid out across the blob from `setMuzzle`.
   */
  setShooters(points: readonly THREE.Vector3[], count: number): void;
  /** Squad system: front edge and half-width of the blob, once per tick. */
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
  /**
   * Per-instance opacity. three gives instances a colour but not an alpha, and
   * under alpha compositing INTENSITY IS ALPHA: scaling a sprite's RGB toward
   * zero fades it to black over a bright road instead of fading it out. Same
   * patch barrels.ts uses on its smoke, for the same reason.
   *
   * It is equally correct for the additive batch — additive blending in three
   * is (SRC_ALPHA, ONE), so `dst + rgb·a` scales with alpha exactly as it would
   * with RGB. One intensity channel drives both blend modes.
   */
  readonly #alpha: THREE.InstancedBufferAttribute;
  /** Own geometry per batch: the alpha attribute lives ON the geometry, so a
   *  shared one would have all four batches writing the same buffer. */
  readonly #geometry: THREE.BufferGeometry;
  #n = 0;

  constructor(material: THREE.Material, capacity: number, renderOrder: number) {
    this.#capacity = capacity;
    this.#geometry = new THREE.PlaneGeometry(1, 1);
    this.#alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.#alpha.setUsage(THREE.DynamicDrawUsage);
    this.#geometry.setAttribute("aSpriteAlpha", this.#alpha);
    this.mesh = new THREE.InstancedMesh(this.#geometry, material, capacity);
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
    alpha: number,
  ): void {
    if (this.#n >= this.#capacity) return;
    _pos.set(x, y, z);
    _quat.copy(BILLBOARD).multiply(_roll.setFromAxisAngle(_zAxis, roll));
    _scale.set(width, length, 1);
    _mat.compose(_pos, _quat, _scale);
    this.mesh.setMatrixAt(this.#n, _mat);
    this.mesh.setColorAt(this.#n, _col.setRGB(r, g, b));
    this.#alpha.setX(this.#n, alpha < 0 ? 0 : alpha > 1 ? 1 : alpha);
    this.#n++;
  }

  flush(): void {
    this.mesh.count = this.#n;
    this.mesh.visible = this.#n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.#alpha.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.#geometry.dispose();
    this.mesh.dispose();
  }
}

/**
 * Give an instanced material a per-instance alpha channel, patching the stock
 * shader rather than writing a custom one so the material keeps three's own
 * fog/tone-mapping/colour-space handling.
 */
function attachSpriteAlpha(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "attribute float aSpriteAlpha;\nvarying float vSpriteAlpha;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvSpriteAlpha = aSpriteAlpha;",
      );
    shader.fragmentShader =
      "varying float vSpriteAlpha;\n" +
      shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        "#include <opaque_fragment>\ngl_FragColor.a *= vSpriteAlpha;",
      );
  };
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
      // Intensity rides alpha for both blend modes: additive is (SRC_ALPHA,
      // ONE) so `dst + rgb·a` dims identically, and composited flames dissolve
      // instead of turning into dark smudges on a light road.
      const k = out[2]! * brightness;
      const s = this.#size[i]!;
      batch.push(
        this.#x[i]!,
        this.#y[i]!,
        this.#z[i]!,
        this.#roll[i]!,
        baseWidth * s * out[0]!,
        baseLength * s * out[1]!,
        this.#r[i]!,
        this.#g[i]!,
        this.#b[i]!,
        k,
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
  /** The x this round steers toward — the squad's firing axis when it was
   *  fired, captured per bullet so steering the squad does not bend rounds
   *  that are already in the air. */
  readonly #axisX = new Float32Array(BULLET_POOL);
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
  readonly #needleTex: THREE.CanvasTexture;
  readonly #dartTex: THREE.CanvasTexture;
  readonly #flameTex: THREE.CanvasTexture;
  readonly #burstTex: THREE.CanvasTexture;
  readonly #needleMat: THREE.MeshBasicMaterial;
  readonly #dartMat: THREE.MeshBasicMaterial;
  readonly #flameMat: THREE.MeshBasicMaterial;
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
  /**
   * Shared fire clock, in shot periods, wrapped to [0, 1). Stream `s` fires
   * whenever `clock + phase[s]` crosses an integer, which gives every stream
   * exactly the same rate on a permanently different phase for the cost of one
   * scalar. Wrapping each tick keeps it exact forever — only the crossings
   * matter, and shifting every clock by the same integer does not move them.
   */
  #fireClock = 0;
  #shotIndex = 0;
  #tier: WeaponTier = 0;
  #muzzleX = 0;
  #muzzleY = 1;
  #muzzleZ = 0;
  #muzzleHalfWidth = 0.5;
  #muzzleReported = false;
  #disposed = false;

  // --- streams ---
  /** Muzzle position of each live stream, rebuilt every tick. */
  readonly #streamX = new Float32Array(MAX_STREAMS);
  readonly #streamY = new Float32Array(MAX_STREAMS);
  readonly #streamZ = new Float32Array(MAX_STREAMS);
  /** Fire-clock offset, in shot periods. Constant for the life of the run. */
  readonly #streamPhase = new Float32Array(MAX_STREAMS);
  /** The part of a stream's aim error that does NOT change per shot, in units
   *  of the tier's spread. This is what makes a stream a line. */
  readonly #streamAim = new Float32Array(MAX_STREAMS);
  /** Unit-disc slot used to place streams with no reported soldier behind them.
   *  Vogel spiral, matching the squad's own layout. */
  readonly #slotCos = new Float32Array(MAX_STREAMS);
  readonly #slotSin = new Float32Array(MAX_STREAMS);
  /** Fractional wobble on that slot's radius, so the rim is ragged. */
  readonly #slotRadius = new Float32Array(MAX_STREAMS);
  /** Streams filled from `setShooters` this tick; the rest are synthesised. */
  #reportedCount = 0;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    for (let i = 0; i < BULLET_POOL; i++) this.#free[i] = BULLET_POOL - 1 - i;

    const rand = mulberry32(0xb0175);
    for (let s = 0; s < MAX_STREAMS; s++) {
      this.#streamPhase[s] = (s * GOLDEN_FRACTION) % 1;
      this.#streamAim[s] = rand() * 2 - 1;
      // Warped toward ±X and then jittered, exactly as `entities/squad.ts` warps
      // and jitters its own spiral: warping alone makes the blob wide, and the
      // jitter is what stops three streams landing in a tidy row. Only the angle
      // is baked — the radius is applied per tick against the LIVE stream count,
      // because a prefix of a fixed 96-slot spiral is a huddle, not a squad.
      const spiral = s * GOLDEN_ANGLE;
      const a = spiral - 0.35 * Math.sin(2 * spiral) + (rand() - 0.5) * 1.1;
      this.#slotCos[s] = Math.cos(a);
      this.#slotSin[s] = Math.sin(a);
      this.#slotRadius[s] = (rand() - 0.5) * 0.34;
    }

    this.#needleTex = needleTexture();
    this.#dartTex = dartTexture();
    this.#flameTex = flameTexture();
    this.#burstTex = burstTexture();

    // Rounds composite; only the impact flash adds. See the blending note above
    // the texture builders — this is the whole fix for colourless tracers.
    this.#needleMat = compositeMaterial(this.#needleTex);
    this.#dartMat = compositeMaterial(this.#dartTex);
    this.#flameMat = compositeMaterial(this.#flameTex);
    this.#burstMat = additiveMaterial(this.#burstTex);

    // Muzzle flames share the needle texture with tracers — the reference's
    // muzzle flash is just a short fat version of the same flame lick.
    this.#tracerBatch = new SpriteBatch(this.#needleMat, TRACER_CAPACITY, 10);
    this.#dartBatch = new SpriteBatch(this.#dartMat, BULLET_POOL, 10);
    this.#muzzleBatch = new SpriteBatch(this.#flameMat, MUZZLE_POOL, 11);
    this.#impactBatch = new SpriteBatch(this.#burstMat, IMPACT_POOL, 12);

    scene.add(this.#tracerBatch.mesh);
    scene.add(this.#dartBatch.mesh);
    scene.add(this.#muzzleBatch.mesh);
    scene.add(this.#impactBatch.mesh);
  }

  // ------------------------------------------------------------------ public

  setShooters(points: readonly THREE.Vector3[], count: number): void {
    const n = Math.min(count, points.length);
    if (n <= 0) {
      this.#reportedCount = 0;
      return;
    }
    // Stride rather than truncate: the first 96 of 400 reported units are the
    // 96 the squad happened to list first, and taking them would collapse every
    // stream onto whatever part of the blob that is.
    const take = Math.min(n, MAX_STREAMS);
    for (let s = 0; s < take; s++) {
      // Spread the picks across the whole report, endpoints included.
      const i = take > 1 ? Math.round((s * (n - 1)) / (take - 1)) : 0;
      const p = points[i];
      if (p === undefined) {
        this.#reportedCount = s;
        return;
      }
      this.#streamX[s] = p.x;
      this.#streamY[s] = p.y;
      this.#streamZ[s] = p.z;
    }
    this.#reportedCount = take;
  }

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
    const t = this.tuning;
    const dart = this.#tier === 2;
    const spread = dart ? t.tier2Spread : t.tier01Spread;
    for (let i = 0; i < n; i++) {
      // Triangular rather than uniform across the line: a blob is denser through
      // the middle, and a uniform pick reads as a curtain with hard edges.
      const u = Math.random() + Math.random() - 1;
      const aim = (Math.random() * 2 - 1) * spread;
      // Manual volleys converge on the point they were fired at, so a scripted
      // beat focuses exactly like automatic fire does.
      this.#shootFrom(x + u * hw, y, z, aim, this.#tier, 0, 1, x);
    }
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (!on) this.#fireClock = 0;
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
    this.#burst(x, y, z, warm ? 0.85 : 0.6, warm ? BURST_WARM : BURST_CYAN);
  }

  spawnImpact(x: number, y: number, z: number, scale = 1): void {
    this.#burst(x, y, z, scale, this.#tier === 2 ? BURST_CYAN : BURST_WARM);
  }

  // ------------------------------------------------------------------ system

  update(dt: number, world: WorldState): void {
    this.#tier = world.weaponTier;
    this.#advance(dt);
    this.#muzzles.advance(dt);
    this.#impacts.advance(dt);

    // A report only counts for the tick it was made in — a stale muzzle line
    // would drag the streams behind the blob for as long as the squad stayed
    // quiet. Cleared here so both early-outs below still consume it.
    const reported = this.#reportedCount;
    const muzzleReported = this.#muzzleReported;
    this.#reportedCount = 0;
    this.#muzzleReported = false;

    if (!this.#enabled) return;

    // If the squad system is not wired up yet, infer the blob so the module is
    // useful standing alone.
    if (!muzzleReported) this.#inferMuzzle(world);

    const t = this.tuning;
    const tier = world.weaponTier;
    const streams = this.#layOutStreams(world.troops, reported);
    if (streams === 0) return;

    const total = totalShotsPerSecond(tier, world.troops, t);
    if (total <= 0) return;

    // Every stream fires at the same rate; the crowd's volume is the sum, which
    // is the whole point of the model.
    const perStream = total / streams;
    const advance = perStream * dt;
    if (advance <= 0) return;

    // One flame per `flashStride` shots, chosen so flames/sec never exceeds the
    // cap however many soldiers are firing. At one soldier this is 1 — every
    // shot flashes, as it must when there is only one muzzle to look at.
    const flashStride = Math.max(1, Math.ceil(total / Math.max(1, t.muzzleRateCap)));

    const prev = this.#fireClock;
    const next = prev + advance;
    this.#fireClock = next - Math.floor(next);

    const dart = tier === 2;
    const spread = dart ? t.tier2Spread : t.tier01Spread;
    const rolled = spread * clamp01(t.shotJitterFraction);
    const fixed = spread - rolled;
    // No divergence term any more. A stream's aim is jitter only; where it
    // actually points is decided by convergence toward the firing axis, which
    // `#advance` applies over the whole flight. The jitter is what gives the
    // converged column a finite waist instead of a focal point.
    const axis = this.#muzzleX;

    let budget = MAX_SHOTS_PER_TICK;
    for (let s = 0; s < streams && budget > 0; s++) {
      const phase = this.#streamPhase[s]!;
      const from = Math.floor(prev + phase);
      let shots = Math.floor(next + phase) - from;
      if (shots <= 0) continue;
      if (shots > MAX_SHOTS_PER_STREAM_PER_TICK) shots = MAX_SHOTS_PER_STREAM_PER_TICK;
      if (shots > budget) shots = budget;
      budget -= shots;

      const ox = this.#streamX[s]!;
      const oy = this.#streamY[s]!;
      const oz = this.#streamZ[s]!;
      const aim = this.#streamAim[s]! * fixed;

      for (let k = 0; k < shots; k++) {
        // Where inside this tick the clock actually crossed. Advancing the
        // bullet by the remainder is what spreads a volley smoothly between
        // tick boundaries — skip it and an instanced stream marches in rows.
        const cross = from + 1 + k;
        const age = (1 - (cross - prev - phase) / advance) * dt;
        this.#shotIndex++;
        this.#shootFrom(
          ox,
          oy,
          oz,
          aim + (Math.random() * 2 - 1) * rolled,
          tier,
          age < 0 ? 0 : age,
          this.#shotIndex % flashStride === 0 ? 1 : 0,
          axis,
        );
      }
    }
  }

  /**
   * Fill `#stream*` with one muzzle per troop, up to the stream cap.
   *
   * Reported soldier positions are used verbatim and come first. Anything the
   * squad could not report — because its sampler is narrower than the blob, or
   * because nobody called `setShooters` at all — is laid out across the blob
   * from the muzzle line, so the stream COUNT is right even when the positions
   * are only approximate. Returns how many streams are live.
   */
  #layOutStreams(troops: number, reported: number): number {
    const cap = Math.min(MAX_STREAMS, Math.max(0, Math.floor(this.tuning.maxStreams)));
    const want = Math.min(Math.max(0, Math.floor(troops)), cap);
    if (want === 0) return 0;

    const filled = Math.min(reported, want);
    if (filled < want) {
      // r = sqrt(s / (count-1)) is the squad's own radial law: area-uniform, and
      // it pins slot 0 at the dead centre and the last slot on the rim. Pinning
      // slot 0 is what makes a ONE-troop squad fire out of its own rifle rather
      // than from somewhere off its shoulder, and taking the denominator from
      // the live count is what makes a THREE-troop squad span the blob instead
      // of huddling at the middle of a 96-slot spiral.
      const halfWidth = this.#muzzleHalfWidth;
      const halfDepth = halfWidth * BLOB_DEPTH_RATIO;
      const edge = CORRIDOR_HALF_WIDTH - 0.1;
      const denom = want > 1 ? want - 1 : 1;
      for (let s = filled; s < want; s++) {
        const base = want > 1 ? Math.sqrt(s / denom) : 0;
        const r = Math.max(0, base + this.#slotRadius[s]! * base);
        const x = this.#muzzleX + this.#slotCos[s]! * r * halfWidth;
        this.#streamX[s] = x < -edge ? -edge : x > edge ? edge : x;
        // The reported z is the FRONT edge of the blob, so the body of it lies
        // behind: shift the unit disc into [0, 2·halfDepth] rather than
        // straddling zero, or half the streams start in front of the squad.
        this.#streamZ[s] = this.#muzzleZ + (this.#slotSin[s]! * r + 1) * halfDepth;
        this.#streamY[s] = this.#muzzleY;
      }
    }

    return want;
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
      // neither end of the trajectory pops. This drives ALPHA, not RGB: a round
      // dimmed by RGB over a light road goes grey and then black, where one
      // dimmed by alpha dissolves into the road the way it should. The hot
      // boost therefore reads as denser rather than whiter — the heat itself is
      // painted into the nose of the texture, where it cannot wash out the hue.
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
        tint.r,
        tint.g,
        tint.b,
        k,
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
      batch.dispose();
    }
    this.#needleMat.dispose();
    this.#dartMat.dispose();
    this.#flameMat.dispose();
    this.#burstMat.dispose();
    this.#needleTex.dispose();
    this.#dartTex.dispose();
    this.#flameTex.dispose();
    this.#burstTex.dispose();
  }

  // ----------------------------------------------------------------- private

  /**
   * CONVERGENCE — why the army's fire focuses instead of travelling as a
   * parallel curtain.
   *
   * One stream per soldier spreads the muzzles across the whole blob, which is
   * right, but firing them all straight up the corridor means a 50-troop squad
   * throws a 5.3 m wide curtain at a 2.1 m barrel and misses with half of it.
   * Measured: 49% of muzzle damage on target. The player steers the crowd onto
   * a barrel and most of the army shoots past it, so aiming does not read as
   * aiming.
   *
   * The reference does not do this. In frame_030 the muzzle line spans 2.21 m
   * and the same fire in flight spans 0.72 m — it converges to a third of its
   * origin width. (That also settles the "~4° cone" measured earlier: for the
   * reference's outermost round it is 4.3° of CONVERGENCE, and the old note in
   * this file had the sign backwards.)
   *
   * So each round's lateral offset from the axis it was fired at decays with
   * DISTANCE TRAVELLED, u(d) = u₀·e^(−d/Dc). Differentiating gives a lateral
   * velocity proportional to the current offset, vx = −u·v/Dc, which is what is
   * applied here — recomputed each tick, so the decay is exact regardless of
   * speed and there is no focal point to cross and diverge past. Capped at
   * `convergeMaxAngle` so an edge soldier never appears to fire sideways.
   *
   * Consequences, all wanted:
   *   * Near the muzzles the fire is still nearly as wide as the blob (4.5 m of
   *     5.3 m at 2 m out), so every soldier visibly shoots its own stream.
   *   * By target depth it is a column: 1.0 m at 12 m, inside the barrel window.
   *   * 93% of a 50-troop army's damage now lands on the barrel it is aimed at.
   *
   * ===================== AND WHY IT IS NOW OFF BY DEFAULT ====================
   *
   * All of the above is still true, and it is still the wrong behaviour for
   * this game. It was derived from `frame_030` of Part1.mov, where a single
   * barrel sits in the squad's lane and "did the army hit it" is the only
   * question worth asking. `reference-media/reference-clip-1a.mov` shows the
   * mechanic the game is actually built on, and it is the opposite:
   *
   *   * the stream is made of individually visible parallel COLUMNS, roughly
   *     15 of them spanning ~475 px of a 720 px frame at 45% depth, and
   *   * every column registers on whatever barrel or barrier it happens to
   *     cross, so a barrel clipped by the right-hand edge of the stream ticks
   *     down slowly while one squarely inside it melts.
   *
   * That makes the crowd's WIDTH into a weapon — a wide army covers several
   * lanes at once and a narrow one drills a single hole — and it turns aiming
   * into a question of coverage rather than one of a single lane. Focusing all
   * fire into one column throws that away, and no amount of tuning the decay
   * distance recovers it, because the whole point is the parts of the stream
   * that DON'T point at what you are aiming at.
   *
   * Setting `convergeDistance` to 0 restores the parallel curtain. The decay is
   * kept, rather than deleted, because it is still the right model for a
   * focused-fire powerup or a boss-phase weapon.
   */
  #advance(dt: number): void {
    const t = this.tuning;
    // Zero means parallel: no re-aiming at all, so a round keeps the lateral
    // velocity it left the muzzle with.
    const invDc = t.convergeDistance > 0 ? 1 / Math.max(0.25, t.convergeDistance) : 0;
    const tanMax = Math.tan(Math.max(0, t.convergeMaxAngle));

    // Backwards, because expiring swap-removes the tail into the current slot —
    // the element that lands here has already been stepped this tick.
    for (let i = this.#count - 1; i >= 0; i--) {
      const id = this.ids[i]!;
      const cx = this.x[id]!;
      const cy = this.y[id]!;
      const cz = this.z[id]!;

      // Re-aim toward the firing axis. `vz` is left alone, so forward pacing and
      // therefore range and lifetime are unaffected by how hard a round turns.
      const forward = -this.#vz[id]!;
      const cap = tanMax * forward;
      let vx = -(cx - this.#axisX[id]!) * invDc * forward;
      if (vx > cap) vx = cap;
      else if (vx < -cap) vx = -cap;
      this.#vx[id] = vx;

      const vy = this.#vy[id]!;
      this.px[id] = cx;
      this.py[id] = cy;
      this.pz[id] = cz;
      this.x[id] = cx + vx * dt;
      this.y[id] = cy + vy * dt;
      this.z[id] = cz + this.#vz[id]! * dt;

      // The sprite's long axis tracks travel, and its nose offset in render()
      // divides by speed — both move as the round turns, so both are refreshed
      // rather than left at their spawn values.
      // Plain sqrt rather than Math.hypot: this runs for every live bullet every
      // tick, and hypot's overflow guarding costs several times more for values
      // that can never overflow.
      this.#invSpeed[id] = 1 / Math.sqrt(vx * vx + vy * vy + forward * forward);
      this.#roll[id] = rollFor(vx, vy, this.#vz[id]!);

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

  /**
   * One shot from one stream's muzzle. `angle` is the aim in radians (0 = up
   * the corridor), `age` is how far into its flight the round already is, and
   * `flash` requests a muzzle flame.
   *
   * Everything randomised in here is PER SHOT and deliberately small: the aim
   * and the origin are the stream's, and a stream whose origin wandered would
   * be a spray. Speed and vertical jitter are the exceptions — they scatter
   * rounds ALONG a stream rather than across it, which is what stops a column
   * of evenly-spaced sprites reading as a lattice.
   */
  #shootFrom(
    sx: number,
    sy: number,
    sz: number,
    angle: number,
    tier: WeaponTier,
    age: number,
    flash: number,
    axisX: number,
  ): void {
    if (this.#freeCount === 0) return;
    const t = this.tuning;
    const dart = tier === 2;

    const speed =
      (dart ? t.dartSpeed : t.tracerSpeed) * (1 + (Math.random() - 0.5) * t.speedJitter);

    // Seed the inward lean at spawn rather than waiting for the first tick of
    // `#advance`, so the sub-tick catch-up below places the round on the path it
    // is actually going to fly.
    const cap = Math.tan(Math.max(0, t.convergeMaxAngle)) * speed;
    let lean =
      t.convergeDistance > 0
        ? -(sx - axisX) * (1 / Math.max(0.25, t.convergeDistance)) * speed
        : 0;
    if (lean > cap) lean = cap;
    else if (lean < -cap) lean = -cap;

    const vx = Math.sin(angle) * speed + lean;
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
    const ox = sx < -edge ? -edge : sx > edge ? edge : sx;
    const oy = sy + (Math.random() - 0.5) * 0.12;
    const oz = sz;

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
    this.#axisX[id] = axisX;
    this.#style[id] = dart ? STYLE_DART : STYLE_TRACER;
    this.damage[id] = dart ? t.dartDamage : t.tracerDamage;
    // Length tracks speed so a faster round is a longer streak, and a little
    // per-bullet variance stops the stream reading as clones.
    const nominal = dart ? t.dartSpeed : t.tracerSpeed;
    this.#size[id] = (speed / nominal) * (0.88 + Math.random() * 0.24);

    // The caller decides — the flash stride is derived from the live shot rate
    // so one soldier flashes on every round and a thousand do not strobe.
    if (flash !== 0) {
      const tint = dart ? FLAME_CYAN : FLAME_WARM;
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

/**
 * Total shots/second across the whole squad.
 *
 * The honest answer is `troops × rate`, one stream each. This governs that
 * against the pool, because at 1200 troops the honest answer asks for ~13× the
 * bullets that exist. The soft clip
 *
 *     total = desired / (1 + (desired/max)^k)^(1/k)
 *
 * is strictly increasing for all desired > 0 with an asymptote at `max` — proof
 * is one line: d(ln total)/d(desired) = 1 / (desired · (1 + (desired/max)^k)),
 * which is positive everywhere. So more troops is ALWAYS more bullets, and the
 * pool can never be overrun no matter how the tiers or the troop cap move.
 *
 * `max` is a rate, derived from the live-bullet budget and how long a round
 * survives: live ≈ rate × flightTime, so rate_max = budget / flightTime. Tier 2
 * rounds are slower, live longer and therefore get a lower rate ceiling for the
 * same on-screen population — which is correct, and is why this is computed per
 * tier rather than hard-coded.
 */
export function totalShotsPerSecond(tier: WeaponTier, troops: number, t: BulletTuning): number {
  const n = Math.max(0, Math.floor(troops));
  if (n === 0) return 0;

  const perShooter =
    tier === 0 ? t.tier0RatePerShooter : tier === 1 ? t.tier1RatePerShooter : t.tier2RatePerShooter;
  const desired = n * Math.max(0, perShooter);
  if (desired <= 0) return 0;

  const speed = tier === 2 ? t.dartSpeed : t.tracerSpeed;
  const flightTime = t.range / Math.max(1e-3, speed);
  const max = Math.max(1, t.maxLiveBullets) / Math.max(1e-3, flightTime);

  const k = Math.max(0.5, t.saturationKnee);
  return desired / Math.pow(1 + Math.pow(desired / max, k), 1 / k);
}

/**
 * Rounds in the air at once, at steady state. `live ≈ rate × flightTime` — the
 * governor's own identity, read back out. This is the number to compare against
 * a reference frame when asking "is our fire too dense?".
 */
export function liveBullets(tier: WeaponTier, troops: number, t: BulletTuning): number {
  const speed = tier === 2 ? t.dartSpeed : t.tracerSpeed;
  return totalShotsPerSecond(tier, troops, t) * (t.range / Math.max(1e-3, speed));
}

/**
 * Seconds of on-target fire a single barrel absorbs over one full approach.
 *
 * A barrel is on screen for ~10 s but only shootable for the last stretch, and
 * the exact figure moves with the blob's depth (the muzzle line rides its front
 * edge) and with how much of the cone the barrel's 1.7 m face intercepts.
 * MEASURED, not derived: `__overkill.damageCurve()` in a real browser, damage
 * divided by the shot rate that produced it —
 *
 *     tier 0    1,2,3 troops        4.40, 4.30, 4.33
 *     tier 1    5..30 troops        4.40, 4.21, 4.18, 4.14, 4.10
 *     tier 2    50,80,120 troops    4.29, 4.30, 4.29
 *
 * Flat to ±4% across every tier and every count, which is why one constant is
 * honest here. Re-measure it if the scroll speed, the bullet range or the
 * convergence distance move — all three feed it.
 */
export const EFFECTIVE_PASS_SECONDS = 4.25;

/**
 * TOTAL damage the army delivers over one barrel-approach — the whole curtain,
 * wherever it lands.
 *
 * This exists so barrel hit points can be DERIVED from the weapon model instead
 * of hand-fitted to it. Hand-fitted numbers were the standing problem: every
 * change to a fire rate silently invalidated the HP curve, so the two had to be
 * retuned together and in practice neither was. Route HP through here and a
 * rate change carries itself.
 *
 * NOT what a single barrel takes. Since the fire stopped converging it travels
 * as a curtain the width of the crowd, so one barrel intercepts only the share
 * of it that overlaps its 1.7 m face — see `laneCoverage` in mechanics/pacing.ts.
 * Total output is a property of the WEAPON; where it lands is a property of the
 * crowd's geometry, and keeping the two apart is what stops one of them
 * silently absorbing an error in the other.
 */
export function damagePerPass(tier: WeaponTier, troops: number, t: BulletTuning): number {
  const perBullet = tier === 2 ? t.dartDamage : t.tracerDamage;
  return totalShotsPerSecond(tier, troops, t) * perBullet * EFFECTIVE_PASS_SECONDS;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Seeded PRNG, so a stream's fixed aim is the same on every run. */
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

// ---------------------------------------------------------------------------
// Materials & procedural textures
//
// ======================= WHY THE ROUNDS ARE NOT ADDITIVE ===================
//
// THE ROAD IS BRIGHT. That single fact decides the blend mode, and getting it
// wrong is what made the tracers render as colourless white jets.
//
// Measured off the reference frames (docs/reference/part1, sampled over the
// road well clear of any object) the road sits at rgb(0.70, 0.71, 0.73) — and
// ours matches. Now measure what the reference's own bullets do against it:
//
//     tier 0/1 tracer   rgb(0.791, 0.562, 0.291)   saturation 0.645
//     tier 2   dart     rgb(0.405, 0.803, 0.878)   saturation 0.537
//
// Look at the LOW channel in each. The tracer's blue is 0.291 and the dart's
// red is 0.405, both far BELOW the 0.71 road they are drawn over. No
// brighten-only blend can produce that. Additive (dst + src) and screen
// (dst + src·(1−dst)) can only ever move a channel up from 0.727 toward 1.0,
// so the widest gap either can open between channels is 1 − 0.727 = 0.273:
//
//     additive / screen, best possible   rgb(1.000, 0.727, 0.727)  sat 0.273
//     the reference actually achieves                              sat 0.645
//
// Screen is a real improvement on additive — it cannot clip, so it reliably
// reaches that 0.273 instead of overshooting every channel to 1.0 and going
// white, which is why it was the right call for growthfx.ts. But it tops out
// at less than half the saturation the tracers need, because a tracer has to
// hold its blue channel DOWN and screen has no way to darken anything.
//
// So the rounds composite: (SRC_ALPHA, ONE_MINUS_SRC_ALPHA). Coverage, not
// glow. That is the only blend that can push a channel below the background,
// and it is plainly what the reference does. Consequences, all deliberate:
//
//   * COLOUR LIVES IN THE TEXTURE, not in the instance tint, because at high
//     alpha the on-screen pixel IS the texel. The tints are 1.0 (see above).
//   * INTENSITY LIVES IN ALPHA. Scaling RGB down under compositing walks a
//     round toward black, not toward invisible.
//   * "HOT" IS PAINTED, not multiplied: each ramp runs from a pale, barely
//     saturated nose to a deeply saturated body, so the round still reads as a
//     white-cored bolt without a single channel having to exceed 1.0.
//
// The impact burst stays ADDITIVE. It is a light source rather than an object,
// it is supposed to blow out, and it lives 0.18 s — long enough to punch, too
// short to need a hue.
//
// Fog is off on all of them: additive blending toward a bright fog colour makes
// distant sprites glow *brighter*, which is backwards. Bullets expire inside
// the fog's near plane instead.
// ---------------------------------------------------------------------------

/**
 * Colour ramps, nose (0) to tail (1), as [t, r, g, b, a] in SRGB 0..1 — the
 * literal on-screen colour of the round wherever it is opaque, because the
 * instance tint is 1.0 and `toneMapped` is off.
 *
 * Kept as data rather than inline gradient stops so the composite over the road
 * can be computed and checked against the reference numbers above without
 * running the game.
 */
type Stop = readonly [number, number, number, number, number];

/**
 * The hot tip is SHORT and it is not white. The reference tracer averages
 * rgb(0.791, 0.562, 0.291) — a saturated orange streak of only moderate
 * brightness with a small hot tip, not a blazing white line with a warm edge.
 * A long pale nose is the thing that drags the average toward grey, so the ramp
 * is already deep orange by 12% of the streak's length.
 */
/**
 * Note how little blue there is even in the hot tip. Saturation here is very
 * nearly `1 − blue/red`, and blue is the channel the road pushes back up
 * wherever alpha is short of 1 — so a pale, blue-ish "white hot" nose is
 * precisely what costs the round its orange. The tip reads as heat because it
 * is the brightest thing in frame at value 1.0, not because it is white.
 */
/* RAMP:TRACER */
const TRACER_RAMP: readonly Stop[] = [
  [0.0, 1.0, 0.94, 0.62, 0.0],
  [0.03, 1.0, 0.92, 0.5, 0.98],
  [0.1, 1.0, 0.7, 0.16, 0.98],
  [0.28, 1.0, 0.48, 0.05, 0.98],
  [0.72, 0.99, 0.36, 0.02, 0.94],
  [0.9, 0.96, 0.3, 0.02, 0.66],
  [1.0, 0.92, 0.26, 0.02, 0.0],
];
/* RAMP:END */

/* RAMP:DART */
const DART_RAMP: readonly Stop[] = [
  [0.0, 0.9, 1.0, 1.0, 0.0],
  [0.06, 0.8, 0.99, 1.0, 0.98],
  [0.18, 0.4, 0.94, 1.0, 0.98],
  [0.4, 0.09, 0.8, 1.0, 0.97],
  [0.78, 0.05, 0.58, 0.92, 0.82],
  [0.92, 0.04, 0.48, 0.86, 0.5],
  [1.0, 0.03, 0.4, 0.82, 0.0],
];
/* RAMP:END */

/**
 * Cross-section opacity of the needle, centre (0) to edge (1).
 *
 * Tighter than a plain falloff, and the ramps above hold alpha near 1 for most
 * of the streak's length rather than fading out across it. Both exist for the
 * same measured reason: a long, wide, low-alpha skirt is a large area of pixels
 * sitting a few percent off road grey, and averaging those in is what pulled
 * the first attempt at this fix down to 0.37 saturation. A tracer is a dense
 * bright dash with a quick fade at the tail, not a soft plume — which is also
 * exactly what the reference frames show.
 */
/* RAMP:CROSS */
const NEEDLE_CROSS: readonly (readonly [number, number])[] = [
  [0.0, 1.0],
  [0.45, 0.84],
  [0.78, 0.3],
  [1.0, 0.0],
];
/* RAMP:END */

const stopsToGradient = (g: CanvasGradient, ramp: readonly Stop[]): void => {
  for (const [t, r, gr, b, a] of ramp) {
    g.addColorStop(
      t,
      `rgba(${Math.round(r * 255)},${Math.round(gr * 255)},${Math.round(b * 255)},${a})`,
    );
  }
};

/** Rounds and muzzle flames: coverage, so a channel can go below the road. */
function compositeMaterial(map: THREE.CanvasTexture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    blending: THREE.NormalBlending,
    // Off for the same reason as before: hundreds of overlapping sprites would
    // z-fight and punch holes in one another. They still depth-test against the
    // world, so a round behind a barrel is correctly hidden.
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
  attachSpriteAlpha(mat);
  return mat;
}

function additiveMaterial(map: THREE.CanvasTexture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
  attachSpriteAlpha(mat);
  return mat;
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

  // TRACER_RAMP carries the colour AND the along-length opacity. It runs from a
  // pale hot nose to a deeply saturated orange body: the nose is what reads as
  // heat, the body is what reads as orange, and neither has to exceed 1.0.
  const along = ctx.createLinearGradient(0, 0, 0, H);
  stopsToGradient(along, TRACER_RAMP);
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, W, H);

  // Cross-section falloff, applied to alpha only so it thins the needle without
  // touching its hue. Shaped rather than clipped, because a hard silhouette at
  // 32 px across aliases badly once it is a few screen pixels wide.
  const across = ctx.createLinearGradient(0, 0, W, 0);
  for (const [u, a] of NEEDLE_CROSS) across.addColorStop(0.5 - u * 0.5, `rgba(0,0,0,${a})`);
  for (const [u, a] of NEEDLE_CROSS) across.addColorStop(0.5 + u * 0.5, `rgba(0,0,0,${a})`);
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, W, H);

  return finish(ctx);
}

/**
 * Muzzle flame. Deliberately NEUTRAL: white RGB with a shaped alpha, so the
 * per-instance tint sets the colour exactly (tint × white = tint under
 * compositing). The flame has to be warm at tier 0/1 and cyan at tier 2, and
 * tinting the orange needle texture cyan would just produce mud.
 */
function flameTexture(): THREE.CanvasTexture {
  const W = 32;
  const H = 128;
  const ctx = canvas2d(W, H);

  const along = ctx.createLinearGradient(0, 0, 0, H);
  along.addColorStop(0.0, "rgba(255,255,255,0)");
  along.addColorStop(0.12, "rgba(255,255,255,0.95)");
  along.addColorStop(0.45, "rgba(255,255,255,0.7)");
  along.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, W, H);

  const across = ctx.createLinearGradient(0, 0, W, 0);
  across.addColorStop(0.0, "rgba(0,0,0,0)");
  across.addColorStop(0.5, "rgba(0,0,0,1)");
  across.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, W, H);

  return finish(ctx);
}

/**
 * The tier-2 dart. frame_035 zoomed 6x: a blunt round nose leading, a long tail
 * tapering to a point, a pale core inside a cyan body.
 *
 * Built in two passes rather than by stacking coloured teardrops with `lighter`.
 * Stacking translucent passes gives a nice glow falloff, but it BUILDS colour
 * additively inside the canvas — every overlap climbs toward white, which is the
 * same mistake at texture scale that additive blending was making at frame
 * scale. So: shape first, in neutral white, then paint DART_RAMP through it, so
 * the silhouette and the hue are independent and the hue is exactly what the
 * table says.
 */
function dartTexture(): THREE.CanvasTexture {
  const W = 64;
  const H = 160;
  const ctx = canvas2d(W, H);
  const cx = W / 2;

  // Pass 1 — silhouette and soft edge, alpha only.
  ctx.globalCompositeOperation = "lighter";
  teardrop(ctx, cx, 6, W * 0.46, H * 0.9, "rgba(255,255,255,0.34)");
  teardrop(ctx, cx, 9, W * 0.33, H * 0.82, "rgba(255,255,255,0.42)");
  teardrop(ctx, cx, 13, W * 0.19, H * 0.6, "rgba(255,255,255,0.5)");

  // Pass 2 — recolour. `source-in` keeps the alpha built above and replaces the
  // RGB wholesale, which is what makes the ramp authoritative.
  ctx.globalCompositeOperation = "source-in";
  const along = ctx.createLinearGradient(0, 0, 0, H);
  stopsToGradient(along, DART_RAMP);
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, W, H);

  // White-hot pip inside the nose — this is what survives when the sprite is
  // only a few pixels tall at the far end of the corridor. Added last, over the
  // top, so it lifts the nose toward white without lifting the body with it.
  ctx.globalCompositeOperation = "lighter";
  const nose = ctx.createRadialGradient(cx, 26, 0, cx, 26, 15);
  nose.addColorStop(0, "rgba(150,240,255,0.85)");
  nose.addColorStop(0.5, "rgba(90,200,235,0.35)");
  nose.addColorStop(1, "rgba(0,0,0,0)");
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
