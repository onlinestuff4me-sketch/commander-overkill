/**
 * "+1" FLOATERS — the payout half of the growth moment (`frame_023`).
 *
 * ONE FLOATER PER UNIT GAINED. Never one summary "+10". A dozen small numbers
 * blooming across the squad is what makes growth read as *earned*; a single
 * big number reads as a notification. That is the entire point of this file
 * and it is the thing not to "simplify" later.
 *
 * API
 *   const floaters = createFloaters(scene);
 *   floaters.spawn(squadCenter, unitsGained, blobRadius); // on the reward beat
 *   floaters.update(dt, world);                           // fixed 60Hz
 *   floaters.render(alpha, world);                        // once per frame
 *   floaters.dispose();
 *
 * The whole pool is ONE instanced draw call of camera-facing quads sharing one
 * cached "+1" canvas texture. Nothing allocates after construction: `spawn`
 * takes the next slot in a ring and stomps the oldest floater when saturated,
 * which is cheaper and more predictable than a free list and never visible at
 * a 64-deep pool.
 *
 * PLACEMENT IS THE HARD PART, not the animation. A dozen numbers that overlap
 * is one illegible number, and it costs the beat its entire meaning. Two rules
 * do the work, and both are in `spawn`:
 *
 *   - the burst uses the FULL width of the blob and a little beyond it, and
 *   - no two floaters of the same beat may land within MIN_SEP of each other
 *     ON SCREEN — measured through the fixed camera's projection, because
 *     world-space distance and apparent distance differ by 2.5x in depth.
 */

import * as THREE from "three";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";
import type { System, WorldState } from "../core/types";

// ---------------------------------------------------------------- tunables

/** Pool depth. Comfortably over the 40 the brief asks for; costs one buffer. */
const CAPACITY = 64;
/**
 * Ceiling on a single burst. Past ~20 the screen is a wall of yellow and the
 * count stops being readable at all, so a +50 gate still shows a fistful. The
 * per-unit rule is about the *feel* of many, not an exact tally.
 */
const MAX_PER_BURST = 20;

/**
 * World-units per quad edge.
 *
 * Careful with this number: it sizes the QUAD, and the glyph's ink fills only
 * about 57% of the quad's width (145px of ink centred in a 256px texture). At
 * this camera the visible width at the floaters' depth is ~5.6m, so a 0.52m
 * quad is 9.3% of screen width but the ink is only ~5.3% — against 8.6% for
 * the reference's "+1". Matching that means either a bigger quad or a tighter
 * texture, and both make the pile-up problem below worse, so it is a scope
 * call rather than a bug. Left as measured; do not "correct" it to 8.6 by
 * changing this constant alone.
 */
const SIZE = 0.52;

/** Seconds a floater lives, before jitter. */
const LIFETIME = 1.0;
/** ±fraction on lifetime. Without this the burst dies as one block. */
const LIFETIME_JITTER = 0.2;

/** Initial upward metres/second, before jitter. */
const RISE = 1.5;
const RISE_JITTER = 0.3;
/** Sideways metres/second, ± — spreads the burst as it climbs. */
const DRIFT = 0.45;
/** Per-second velocity damping: fast pop, slow settle. Reads as weight. */
const DRAG = 1.15;

/** Scale-in duration. Short enough to feel like an impact, not an animation. */
const POP_TIME = 0.12;
/** Overshoot strength of the scale-in (easeOutBack's c1). */
const POP_BACK = 1.35;
/** Fraction of life spent fully opaque before the fade begins. */
const FADE_FROM = 0.55;

/** Spread of spawn times across one burst. `frame_023` shows the floaters at
 *  visibly different ages, so they were not all born on one frame. */
const STAGGER = 0.16;

/**
 * SCATTER — how wide the burst spreads, as a multiple of the blob's HALF-WIDTH.
 *
 * `spawn` is handed `squad.radiusX`, which is ~2.5m at 45 troops (a ~5m wide
 * clump). The first pass topped out at 0.86× that, so a dozen floaters fought
 * over a 4.2m band and stacked into an unreadable "+1+1+1" near the centre.
 * `frame_023` uses the FULL width of the crowd and overhangs it slightly, so
 * this goes past 1.0 on purpose.
 */
const SCATTER_WIDE = 1.18;
/** The blob is wider than deep, so the scatter ellipse is too (REFERENCE). */
const SCATTER_DEPTH = 0.55;
/** Inner limit of the scatter ring, as a fraction of the reach. Keeps the burst
 *  off the squad's own HP bar without hollowing the middle out. */
const SCATTER_FLOOR = 0.22;
/** Floor on the reach so a 3-troop squad's payout still fans out instead of
 *  landing on one spot. */
const MIN_REACH = 1.2;
/** Metres above the squad centre the lowest floaters appear (helmet height). */
const HEIGHT_BASE = 1.25;
const HEIGHT_SPREAD = 1.5;
/** Default scatter radius when the caller does not know the blob's size. */
const DEFAULT_RADIUS = 1.6;

/**
 * MINIMUM SEPARATION, in metres of apparent (screen-plane) distance at the
 * squad's depth — not world distance. Two floaters a metre apart in Z are only
 * ~0.38m apart on screen at this camera, so a world-space separation test
 * would happily stack them; see `screenX`/`screenY` below.
 *
 * The "+1" ink is about 0.30m wide and 0.24m tall on a 0.52m quad, so 0.58
 * leaves a clear gap at the tightest legal packing.
 */
const MIN_SEP = 0.58;
/** Placement attempts per floater (Mitchell best-candidate). Bounded work, no
 *  allocation, and it degrades to "the least bad spot" rather than failing when
 *  a 20-strong burst genuinely runs out of room. */
const CANDIDATES = 12;
/** Floaters younger than this still count as "this beat" for the separation
 *  test, so two payouts a few frames apart do not land on each other. */
const RECENT = 0.35;

/** 137.5°. Consecutive floaters land far apart in bearing, which is what stops
 *  a burst from stacking into a readable-as-one column. */
const GOLDEN_ANGLE = 2.39996323;

/** Sideways metres/second of outward push, per metre of offset from the burst
 *  centre. Small, but it makes the drift diverge instead of converge — spacing
 *  bought at spawn then survives the whole 1s life. */
const OUTWARD = 0.13;

// Texture: square tiles, power-of-two, so mipmapping is uncontroversial on
// every driver. The wasted vertical space costs nothing — transparent texels
// are discarded before blending.
const TEX_SIZE = 256;
const GLYPH_PX = 116;

/**
 * Two glyphs in ONE texture, side by side, selected per instance.
 *
 * The alternative — a second mesh with a second material — would double the
 * draw calls for what is literally a different two characters, and a gate that
 * charges you always fires in the same frame as one that pays, so both kinds
 * are on screen together constantly.
 */
const KIND_GAIN = 0;
const KIND_LOSS = 1;
const LABELS = ["+1", "-1"] as const;
const TILES = LABELS.length;

/** Gain is the reward yellow. Loss is a hot red that still reads over the blue
 *  helmets it falls through — dark enough to hold the white-hot core away from
 *  the road's pale grey, which a pure red loses against. */
const GAIN_GRADIENT = ["#fff581", "#ffe11f", "#ffb400"] as const;
const LOSS_GRADIENT = ["#ffb3ae", "#ff3b30", "#c1121f"] as const;

// --- loss motion -----------------------------------------------------------
//
// A loss does not rise and fade where it was born; it FALLS OFF THE BOTTOM OF
// THE SCREEN. That direction is the whole read: up-and-fade means "you gained
// something", and using it for a penalty is the single easiest way to make a
// punishment feel like a reward.
//
// "Down the screen" is not "down in Y" at this camera. The camera looks along
// -Z from above, so the bottom edge of the frame is TOWARD the camera in +Z.
// Falling in Y alone just sinks a glyph into the road; travelling in +Z is what
// carries it out of frame. Losses do both — the Y drop reads as weight, the Z
// travel is what actually removes it.

/** Initial downward metres/second, before gravity takes over. */
const FALL_START = 0.9;
/** Metres/second² pulling a loss down. Lower than real gravity: at 9.8 the
 *  glyph is off frame before the eye has resolved what it said. */
const FALL_GRAVITY = 4.0;
/** Metres/second toward the camera. This is the one doing the real work — see
 *  the note above. Tuned so a loss clears the bottom edge inside its life. */
const FALL_TOWARD = 2.2;
/** Losses live longer than gains: they have further to travel, and a penalty
 *  that vanishes instantly is a penalty the player never reads. */
const LOSS_LIFETIME = 1.25;
/** Losses hold full opacity far longer than gains — they should leave by
 *  EXITING, not by dissolving in mid-air. This is the backstop for any that are
 *  still on screen at the end of their life. */
const LOSS_FADE_FROM = 0.82;

// ------------------------------------------------------------------ shaders

const VERT = `
attribute vec3 iPos;
attribute float iSize;
attribute float iAlpha;
attribute float iTile;
uniform float uTiles;
varying vec2 vUv;
varying float vAlpha;
void main() {
  // Pick this instance's glyph out of the horizontal strip. One texture, one
  // material, one draw call, whatever mix of gains and losses is on screen.
  vUv = vec2((uv.x + iTile) / uTiles, uv.y);
  vAlpha = iAlpha;
  // Billboard in VIEW space: the quad is built around the instance origin
  // after the view transform, so it always faces the camera and the CPU never
  // needs to know where the camera is. That is what keeps this a System with
  // no camera in its constructor.
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * iSize;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.02) discard;
  gl_FragColor = vec4(t.rgb, t.a * vAlpha);
}
`;

// -------------------------------------------------------------------- types

export interface FloaterSystem extends System {
  /**
   * Bloom `count` "+1"s scattered over the blob at `center`. One per unit
   * gained — pass the number of troops added, not a total.
   * @param radius half-width of the squad blob in world units.
   */
  spawn(center: THREE.Vector3, count: number, radius?: number): void;
  /**
   * Rain `count` red "-1"s over the blob at `center` — one per unit KILLED —
   * which fall away and leave down the bottom of the screen.
   *
   * Deliberately a separate call rather than `spawn` with a negative count: the
   * two read in opposite directions on purpose, and a caller that forgets the
   * sign should get a compile error's worth of friction rather than silently
   * congratulating the player for losing half their army.
   */
  drop(center: THREE.Vector3, count: number, radius?: number): void;
  /** Floaters currently alive, counting ones still inside their spawn stagger. */
  readonly active: number;
  dispose(): void;
}

interface Floater {
  live: boolean;
  /** Seconds since spawn, including the pre-roll `delay`. */
  age: number;
  prevAge: number;
  delay: number;
  life: number;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** KIND_GAIN or KIND_LOSS. Selects the glyph, the motion and the fade. */
  kind: number;
}

// ---------------------------------------------------------------- internals

/**
 * SCREEN-PLANE BASIS for the fixed camera, built once at module load.
 *
 * The camera never rotates or pans (REFERENCE, "Camera & staging"), so the map
 * from a world offset near the squad to an apparent on-screen offset is a
 * constant 2x3 matrix — no camera object, no per-frame projection, and the
 * `System` contract stays camera-free. Perspective divide is ignored: over a
 * 6m blob at ~13m it changes the scale by a few percent, which is far below
 * the separation this is used to enforce.
 *
 * For this camera it works out to roughly `sx = dx`, `sy = 0.93·dy − 0.38·dz`:
 * height is nearly 1:1 on screen, depth is foreshortened to about 40%.
 */
const _viewZ = new THREE.Vector3().subVectors(CAMERA_POS, CAMERA_LOOK).normalize();
const _viewX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), _viewZ).normalize();
const _viewY = new THREE.Vector3().crossVectors(_viewZ, _viewX);

function screenX(dx: number, dy: number, dz: number): number {
  return dx * _viewX.x + dy * _viewX.y + dz * _viewX.z;
}

function screenY(dx: number, dy: number, dz: number): number {
  return dx * _viewY.x + dy * _viewY.y + dz * _viewY.z;
}

/** Deterministic so a replayed sim produces an identical burst. */
let seed = 0x9e3779b9;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [-1, 1). */
function rand2(): number {
  return rand() * 2 - 1;
}

/** easeOutBack — lands on 1 after briefly overshooting it. The overshoot is
 *  the entire difference between "a number appeared" and "a number popped". */
function popScale(u: number): number {
  const k = u - 1;
  return 1 + (POP_BACK + 1) * k * k * k + POP_BACK * k * k;
}

function fadeCurve(k: number): number {
  if (k <= FADE_FROM) return 1;
  const u = 1 - (k - FADE_FROM) / (1 - FADE_FROM);
  return u <= 0 ? 0 : u * u * (3 - 2 * u);
}

/** Same shape, held opaque much longer. A loss should leave the frame by
 *  falling out of it, not by evaporating where the player is still looking. */
function lossFade(k: number): number {
  if (k <= LOSS_FADE_FROM) return 1;
  const u = 1 - (k - LOSS_FADE_FROM) / (1 - LOSS_FADE_FROM);
  return u <= 0 ? 0 : u * u * (3 - 2 * u);
}

/**
 * The "+1" and "-1" stickers, baked once into one strip. Heavy dark outline on
 * both — the outline is not decoration, it is what keeps the text legible over
 * the pale road, the blue helmets and the orange muzzle flare it will
 * inevitably overlap.
 */
function glyphStripTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = TEX_SIZE * TILES;
  c.height = TEX_SIZE;
  const ctx = c.getContext("2d")!;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${GLYPH_PX}px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif`;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (let tile = 0; tile < TILES; tile++) {
    const cx = tile * TEX_SIZE + TEX_SIZE / 2;
    const cy = TEX_SIZE / 2;
    const label = LABELS[tile]!;

    // Two stroke passes: one pass at this width leaves thin spots where the
    // glyphs neck down, and a broken outline is what makes cheap floaters look
    // cheap.
    ctx.strokeStyle = "#150f04";
    ctx.lineWidth = GLYPH_PX * 0.3;
    ctx.strokeText(label, cx, cy);
    ctx.lineWidth = GLYPH_PX * 0.19;
    ctx.strokeText(label, cx, cy);

    const stops = tile === KIND_LOSS ? LOSS_GRADIENT : GAIN_GRADIENT;
    const grad = ctx.createLinearGradient(0, cy - GLYPH_PX * 0.5, 0, cy + GLYPH_PX * 0.5);
    grad.addColorStop(0, stops[0]);
    grad.addColorStop(0.45, stops[1]);
    grad.addColorStop(1, stops[2]);
    ctx.fillStyle = grad;
    ctx.fillText(label, cx, cy);
  }

  const tex = new THREE.CanvasTexture(c);
  // Left in the default (no) colour space on purpose: this material is a hand
  // written shader, so three's sRGB decode/encode chunks are not in play and
  // the canvas' bytes reach the framebuffer untouched. That is exactly what UI
  // text wants — the yellow on screen is the yellow authored above.
  return tex;
}

// ------------------------------------------------------------------- system

class Floaters implements FloaterSystem {
  readonly #pool: Floater[] = [];
  readonly #mesh: THREE.Mesh;
  readonly #geo: THREE.InstancedBufferGeometry;
  readonly #mat: THREE.ShaderMaterial;
  readonly #tex: THREE.CanvasTexture;
  readonly #aPos: THREE.InstancedBufferAttribute;
  readonly #aSize: THREE.InstancedBufferAttribute;
  readonly #aAlpha: THREE.InstancedBufferAttribute;
  readonly #aTile: THREE.InstancedBufferAttribute;
  readonly #posBuf: Float32Array;
  readonly #sizeBuf: Float32Array;
  readonly #alphaBuf: Float32Array;
  readonly #tileBuf: Float32Array;
  /** Screen-plane positions of everything already placed this beat, so the
   *  separation test never allocates. Rewritten from scratch on every `spawn`. */
  readonly #occX = new Float32Array(CAPACITY);
  readonly #occY = new Float32Array(CAPACITY);
  #cursor = 0;
  #live = 0;
  #scene: THREE.Scene | null;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;

    for (let i = 0; i < CAPACITY; i++) {
      this.#pool.push({
        live: false,
        age: 0,
        prevAge: 0,
        delay: 0,
        life: LIFETIME,
        x: 0,
        y: 0,
        z: 0,
        px: 0,
        py: 0,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        kind: KIND_GAIN,
      });
    }

    this.#geo = new THREE.InstancedBufferGeometry();
    // Hand-built unit quad rather than PlaneGeometry: four verts, and no
    // orphaned geometry object to remember to dispose.
    this.#geo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]),
        3,
      ),
    );
    this.#geo.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2),
    );
    this.#geo.setIndex([0, 1, 2, 2, 1, 3]);

    this.#posBuf = new Float32Array(CAPACITY * 3);
    this.#sizeBuf = new Float32Array(CAPACITY);
    this.#alphaBuf = new Float32Array(CAPACITY);
    this.#tileBuf = new Float32Array(CAPACITY);
    this.#aPos = new THREE.InstancedBufferAttribute(this.#posBuf, 3);
    this.#aSize = new THREE.InstancedBufferAttribute(this.#sizeBuf, 1);
    this.#aAlpha = new THREE.InstancedBufferAttribute(this.#alphaBuf, 1);
    this.#aTile = new THREE.InstancedBufferAttribute(this.#tileBuf, 1);
    this.#aPos.setUsage(THREE.DynamicDrawUsage);
    this.#aSize.setUsage(THREE.DynamicDrawUsage);
    this.#aAlpha.setUsage(THREE.DynamicDrawUsage);
    this.#aTile.setUsage(THREE.DynamicDrawUsage);
    this.#geo.setAttribute("iPos", this.#aPos);
    this.#geo.setAttribute("iSize", this.#aSize);
    this.#geo.setAttribute("iAlpha", this.#aAlpha);
    this.#geo.setAttribute("iTile", this.#aTile);
    this.#geo.instanceCount = 0;

    this.#tex = glyphStripTexture();
    this.#mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.#tex }, uTiles: { value: TILES } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Reward text is the one thing that must never be swallowed by a helmet.
      // The reference draws it over everything and so do we.
      depthTest: false,
    });

    this.#mesh = new THREE.Mesh(this.#geo, this.#mat);
    // Instances live anywhere in the world; the geometry's bounds describe a
    // single quad at the origin, so culling would be wrong, not merely slow.
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 30;
    this.#mesh.visible = false;
    scene.add(this.#mesh);
  }

  get active(): number {
    return this.#live;
  }

  spawn(center: THREE.Vector3, count: number, radius = DEFAULT_RADIUS): void {
    this.#burst(center, count, radius, KIND_GAIN);
  }

  drop(center: THREE.Vector3, count: number, radius = DEFAULT_RADIUS): void {
    this.#burst(center, count, radius, KIND_LOSS);
  }

  /** Placement is identical for both kinds — only the launch velocity, the
   *  lifetime and the glyph differ. Sharing it is what keeps a mixed beat (a
   *  gate that charges while a barrel pays) from stacking one on the other. */
  #burst(center: THREE.Vector3, count: number, radius: number, kind: number): void {
    const n = Math.min(Math.max(count | 0, 0), MAX_PER_BURST);
    if (n === 0) return;
    const reach = Math.max(radius, MIN_REACH) * SCATTER_WIDE;
    const sep2 = MIN_SEP * MIN_SEP;

    // Seed the occupancy list with floaters from the last fraction of a second.
    // A gate and a barrel can pay out three frames apart; to the eye that is one
    // beat, and a burst that ignores the previous one lands right on top of it.
    let placed = 0;
    for (const o of this.#pool) {
      if (!o.live || o.age > RECENT || placed >= CAPACITY) continue;
      const dx = o.x - center.x;
      const dy = o.y - center.y;
      const dz = o.z - center.z;
      this.#occX[placed] = screenX(dx, dy, dz);
      this.#occY[placed] = screenY(dx, dy, dz);
      placed++;
    }

    for (let i = 0; i < n; i++) {
      const f = this.#pool[this.#cursor];
      this.#cursor = (this.#cursor + 1) % CAPACITY;
      if (!f) continue;

      // BEST-CANDIDATE PLACEMENT. Draw up to CANDIDATES offsets, keep the one
      // furthest (in screen-plane distance) from everything already placed, and
      // stop early the moment one clears MIN_SEP. A golden-angle spiral alone —
      // what this used to be — spaces floaters in BEARING but says nothing
      // about how close two of them end up once the radii differ, which is how
      // eight of them ended up in one legible-as-one clump.
      let bx = 0;
      let by = 0;
      let bz = 0;
      let bsx = 0;
      let bsy = 0;
      let best = -1;
      for (let c = 0; c < CANDIDATES; c++) {
        const bearing = i * GOLDEN_ANGLE + c * 0.61 + rand() * 1.3;
        // Area-uniform radius off a floor, so the ring fills evenly rather than
        // crowding the middle the way a linear radius would.
        const rr = SCATTER_FLOOR + (1 - SCATTER_FLOOR) * Math.sqrt((i + rand()) / n);
        const ox = Math.cos(bearing) * rr * reach;
        const oz = Math.sin(bearing) * rr * reach * SCATTER_DEPTH;
        const oy = HEIGHT_BASE + rand() * HEIGHT_SPREAD;
        const sx = screenX(ox, oy, oz);
        const sy = screenY(ox, oy, oz);

        let nearest = Infinity;
        for (let k = 0; k < placed; k++) {
          const ddx = sx - this.#occX[k]!;
          const ddy = sy - this.#occY[k]!;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < nearest) nearest = d2;
        }
        if (nearest > best) {
          best = nearest;
          bx = ox;
          by = oy;
          bz = oz;
          bsx = sx;
          bsy = sy;
        }
        if (best >= sep2) break;
      }

      if (placed < CAPACITY) {
        this.#occX[placed] = bsx;
        this.#occY[placed] = bsy;
        placed++;
      }

      f.x = center.x + bx;
      f.y = center.y + by;
      f.z = center.z + bz;
      f.px = f.x;
      f.py = f.y;
      f.pz = f.z;

      // Drift is biased outward from the burst centre. Purely random drift can
      // walk two well-separated floaters into each other over a one-second
      // life, which would undo the placement work above halfway through.
      f.kind = kind;
      f.vx = bx * OUTWARD + rand2() * DRIFT * 0.5;
      if (kind === KIND_LOSS) {
        // Down and toward the camera. See the note on FALL_TOWARD: the +Z is
        // what actually carries it off the bottom of the frame.
        f.vy = -FALL_START * (1 + rand2() * RISE_JITTER);
        f.vz = FALL_TOWARD * (1 + rand2() * 0.25);
      } else {
        f.vy = RISE * (1 + rand2() * RISE_JITTER);
        f.vz = bz * OUTWARD + rand2() * DRIFT * SCATTER_DEPTH * 0.5;
      }

      f.life = (kind === KIND_LOSS ? LOSS_LIFETIME : LIFETIME) * (1 + rand2() * LIFETIME_JITTER);
      f.delay = (i / n) * STAGGER * rand();
      f.age = 0;
      f.prevAge = 0;
      if (!f.live) this.#live++;
      f.live = true;
    }
  }

  update(dt: number, _world: WorldState): void {
    let live = 0;
    for (const f of this.#pool) {
      if (!f.live) continue;
      f.prevAge = f.age;
      f.px = f.x;
      f.py = f.y;
      f.pz = f.z;
      f.age += dt;

      const t = f.age - f.delay;
      if (t < 0) {
        live++;
        continue;
      }
      if (t >= f.life) {
        f.live = false;
        continue;
      }
      // Exponential damping, first-order. At a fixed 60Hz step the error
      // against the closed form is far below one pixel of travel.
      const damp = 1 - DRAG * dt;
      f.vx *= damp;
      if (f.kind === KIND_LOSS) {
        // A loss accelerates instead of settling: damping the fall would leave
        // it hanging in the middle of the frame, which is the one thing it must
        // not do. Only the sideways scatter is damped.
        f.vy -= FALL_GRAVITY * dt;
      } else {
        f.vy *= damp;
        f.vz *= damp;
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      live++;
    }
    this.#live = live;
  }

  render(alpha: number, _world: WorldState): void {
    let n = 0;
    for (const f of this.#pool) {
      if (!f.live) continue;
      const age = f.prevAge + (f.age - f.prevAge) * alpha;
      const t = age - f.delay;
      if (t < 0) continue; // staggered in but not born yet: costs no instance

      const k = t / f.life;
      const i3 = n * 3;
      this.#posBuf[i3] = f.px + (f.x - f.px) * alpha;
      this.#posBuf[i3 + 1] = f.py + (f.y - f.py) * alpha;
      this.#posBuf[i3 + 2] = f.pz + (f.z - f.pz) * alpha;
      this.#sizeBuf[n] = SIZE * (t < POP_TIME ? popScale(t / POP_TIME) : 1);
      this.#alphaBuf[n] =
        k >= 1 ? 0 : f.kind === KIND_LOSS ? lossFade(k) : fadeCurve(k);
      this.#tileBuf[n] = f.kind;
      n++;
    }

    this.#geo.instanceCount = n;
    this.#mesh.visible = n > 0;
    if (n === 0) return;
    this.#aPos.needsUpdate = true;
    this.#aSize.needsUpdate = true;
    this.#aAlpha.needsUpdate = true;
    this.#aTile.needsUpdate = true;
  }

  dispose(): void {
    if (this.#scene) {
      this.#scene.remove(this.#mesh);
      this.#scene = null;
    }
    this.#geo.dispose();
    this.#mat.dispose();
    this.#tex.dispose();
    for (const f of this.#pool) f.live = false;
    this.#live = 0;
  }
}

/** Build the floater pool and attach it to the scene. */
export function createFloaters(scene: THREE.Scene): FloaterSystem {
  return new Floaters(scene);
}
