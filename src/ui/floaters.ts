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
 */

import * as THREE from "three";
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
 * World-units per quad edge. Measured, not guessed: at the corridor camera's
 * framing this puts the glyph ink at 8-10% of a 390pt screen's width, and the
 * reference's "+1" measures 8.6%.
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

/** The blob is wider than deep, so the scatter ellipse is too (REFERENCE). */
const SCATTER_DEPTH = 0.6;
/** Metres above the squad centre the lowest floaters appear (helmet height). */
const HEIGHT_BASE = 1.3;
const HEIGHT_SPREAD = 1.1;
/** Default scatter radius when the caller does not know the blob's size. */
const DEFAULT_RADIUS = 1.6;

/** 137.5°. Consecutive floaters land far apart in bearing, which is what stops
 *  a burst from stacking into a readable-as-one column. */
const GOLDEN_ANGLE = 2.39996323;

// Texture: square and power-of-two so mipmapping is uncontroversial on every
// driver. The wasted vertical space costs nothing — transparent texels are
// discarded before blending.
const TEX_SIZE = 256;
const GLYPH_PX = 116;
const LABEL = "+1";

// ------------------------------------------------------------------ shaders

const VERT = `
attribute vec3 iPos;
attribute float iSize;
attribute float iAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
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
}

// ---------------------------------------------------------------- internals

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

/**
 * The "+1" sticker, baked once. Yellow fill, heavy dark outline — the outline
 * is not decoration, it is what keeps the text legible over both the pale road
 * and the blue helmets it will inevitably overlap.
 */
function plusOneTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = TEX_SIZE;
  c.height = TEX_SIZE;
  const ctx = c.getContext("2d")!;

  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${GLYPH_PX}px "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif`;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // Two stroke passes: one pass at this width leaves thin spots where the
  // glyphs neck down, and a broken outline is what makes cheap floaters look
  // cheap.
  ctx.strokeStyle = "#150f04";
  ctx.lineWidth = GLYPH_PX * 0.3;
  ctx.strokeText(LABEL, cx, cy);
  ctx.lineWidth = GLYPH_PX * 0.19;
  ctx.strokeText(LABEL, cx, cy);

  const grad = ctx.createLinearGradient(0, cy - GLYPH_PX * 0.5, 0, cy + GLYPH_PX * 0.5);
  grad.addColorStop(0, "#fff581");
  grad.addColorStop(0.45, "#ffe11f");
  grad.addColorStop(1, "#ffb400");
  ctx.fillStyle = grad;
  ctx.fillText(LABEL, cx, cy);

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
  readonly #posBuf: Float32Array;
  readonly #sizeBuf: Float32Array;
  readonly #alphaBuf: Float32Array;
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
    this.#aPos = new THREE.InstancedBufferAttribute(this.#posBuf, 3);
    this.#aSize = new THREE.InstancedBufferAttribute(this.#sizeBuf, 1);
    this.#aAlpha = new THREE.InstancedBufferAttribute(this.#alphaBuf, 1);
    this.#aPos.setUsage(THREE.DynamicDrawUsage);
    this.#aSize.setUsage(THREE.DynamicDrawUsage);
    this.#aAlpha.setUsage(THREE.DynamicDrawUsage);
    this.#geo.setAttribute("iPos", this.#aPos);
    this.#geo.setAttribute("iSize", this.#aSize);
    this.#geo.setAttribute("iAlpha", this.#aAlpha);
    this.#geo.instanceCount = 0;

    this.#tex = plusOneTexture();
    this.#mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.#tex } },
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
    const n = Math.min(Math.max(count | 0, 0), MAX_PER_BURST);
    for (let i = 0; i < n; i++) {
      const f = this.#pool[this.#cursor];
      this.#cursor = (this.#cursor + 1) % CAPACITY;
      if (!f) continue;

      // Golden-angle spiral, jittered: an even fill of the ellipse in which no
      // two consecutive floaters share a bearing.
      const bearing = i * GOLDEN_ANGLE + rand() * 0.9;
      // Tops out inside the blob's own footprint: in `frame_023` the spray of
      // numbers is slightly narrower than the mass it is paying out for, which
      // is what keeps it reading as "these units" rather than "this area".
      const r = radius * (0.18 + 0.68 * Math.sqrt((i + rand()) / n));
      f.x = center.x + Math.cos(bearing) * r;
      f.z = center.z + Math.sin(bearing) * r * SCATTER_DEPTH;
      f.y = center.y + HEIGHT_BASE + rand() * HEIGHT_SPREAD;
      f.px = f.x;
      f.py = f.y;
      f.pz = f.z;

      f.vx = rand2() * DRIFT;
      f.vy = RISE * (1 + rand2() * RISE_JITTER);
      f.vz = rand2() * DRIFT * SCATTER_DEPTH;

      f.life = LIFETIME * (1 + rand2() * LIFETIME_JITTER);
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
      f.vy *= damp;
      f.vz *= damp;
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
      this.#alphaBuf[n] = k >= 1 ? 0 : fadeCurve(k);
      n++;
    }

    this.#geo.instanceCount = n;
    this.#mesh.visible = n > 0;
    if (n === 0) return;
    this.#aPos.needsUpdate = true;
    this.#aSize.needsUpdate = true;
    this.#aAlpha.needsUpdate = true;
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
