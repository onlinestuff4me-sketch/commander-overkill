/**
 * GROWTH SWIRL — the energy half of the growth moment (`frame_023`).
 *
 * NOT a radial burst and NOT a ring pulse. The reference is a handful of thin,
 * tapered ribbons ORBITING the squad on tilted planes — long crescents that
 * wrap around the mass, pass in front of it and disappear behind it — plus
 * bright shafts of light rising up through the crowd. The orbit is what says
 * "these troops are being charged up"; a burst would say "something exploded",
 * which is a different beat entirely (that one is `frame_018`).
 *
 * API
 *   const swirl = createGrowthFx(scene);
 *   swirl.play(squadCenter, blobRadius);  // same beat as the "+1" floaters
 *   swirl.update(dt, world);              // fixed 60Hz; tracks world.squadCenter
 *   swirl.render(alpha, world);           // once per frame
 *   swirl.dispose();
 *
 * One additive draw call for the whole effect. Ribbons and light shafts are the
 * same primitive — a polyline widened into a camera-facing strip in the vertex
 * shader — so they share one geometry, one material and one buffer upload.
 * Nothing allocates after construction; `play` only rerolls numbers already in
 * the pool.
 */

import * as THREE from "three";
import type { System, WorldState } from "../core/types";

// ---------------------------------------------------------------- tunables

/** Orbiting ribbons. Eight reads as a vortex; four reads as a mistake. */
const ARC_COUNT = 8;
/**
 * Vertical light shafts rising through the crowd — very prominent in
 * `frame_023`, one per few units. Set to 0 for ribbons only.
 */
const MOTE_COUNT = 12;
/** Points along each strip. 18 keeps a 200° arc smooth at phone resolution. */
const POINTS = 18;

/** Seconds the swirl lasts. Deliberately longer than a floater's ~1.0s so the
 *  energy outlives the numbers and the beat has a tail. */
const DURATION = 1.5;
/** Seconds to reach full brightness. Fast — this is an impact, not a bloom. */
const FADE_IN = 0.1;
/** Fraction of DURATION spent at full brightness before the fade begins. */
const FADE_FROM = 0.42;

/** Orbit radius as a fraction of the blob radius, start and end. The flare
 *  outward is what makes the swirl feel like it is releasing something. */
const RADIUS_IN = 0.55;
const RADIUS_OUT = 1.18;
/** Metres the orbit climbs over its life. Turns a ring into a vortex. */
const LIFT_MIN = 0.25;
const LIFT_MAX = 0.7;
/** Orbit plane tilt off horizontal, radians. The spread is what puts some arcs
 *  edge-on down the left of the blob and others flat across the bottom. */
const TILT_MIN = 0.15;
const TILT_MAX = 1.2;
/** Orbit ellipse squash, matching a blob that is wider than it is deep. */
const SQUASH = 0.72;
/** Radians/second the arcs sweep, ±. Roughly half a turn per effect. */
const SPIN_MIN = 1.6;
const SPIN_MAX = 3.4;
/** Arc length, radians. ~110°–210°, as measured off the reference. */
const SPAN_MIN = 1.9;
const SPAN_MAX = 3.6;

/** Ribbon half-width as a fraction of blob radius, with a floor so a small
 *  squad's swirl is still a visible line rather than a subpixel shimmer. */
const ARC_WIDTH_FRAC = 0.023;
const ARC_WIDTH_MIN = 0.035;
const MOTE_WIDTH_FRAC = 0.015;
const MOTE_WIDTH_MIN = 0.022;

/** Height of the orbit centre above the squad's ground position. */
const ARC_HEIGHT = 0.8;
/** Blob footprint is wider than deep; shafts spawn inside that ellipse. */
const FOOTPRINT_DEPTH = 0.62;
/** Shaft length and climb, as fractions of blob radius. */
const MOTE_LEN = 0.3;
const MOTE_RISE = 0.9;
const MOTE_LIFE_MIN = 0.45;
const MOTE_LIFE_MAX = 0.8;
/** Shafts are staggered so they read as many small events, not one flash. */
const MOTE_STAGGER = 0.35;

/** How fast the swirl re-anchors to a moving squad. Low enough that it trails
 *  the blob slightly when you steer, which reads as attached rather than
 *  parented. */
const FOLLOW = 6;

const DEFAULT_RADIUS = 1.8;

/** Body colour. Sampled between the periwinkle ribbon glow and the cyan-white
 *  shaft cores in `frame_023`; the hot core is added in the shader. */
const COLOR = 0x86c9ff;
/** Overall additive gain. The one knob to turn if the swirl blows out. */
const INTENSITY = 1.15;

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ shaders

const VERT = `
attribute vec3 aTangent;
attribute float aSide;
attribute float aWidth;
attribute float aAlpha;
varying float vSide;
varying float vAlpha;
void main() {
  vSide = aSide;
  vAlpha = aAlpha;
  // Widen the centreline in VIEW space, perpendicular to the projected
  // tangent. A ribbon built in world space would vanish whenever its plane
  // turned edge-on to the camera — which, for something whose whole job is to
  // orbit, is most of the time.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = (modelViewMatrix * vec4(aTangent, 0.0)).xyz;
  vec2 dir = tv.xy;
  // Guard the degenerate case: a tangent pointing straight at the camera has
  // no projected direction, so pick one rather than divide by zero.
  dir = dot(dir, dir) < 1e-8 ? vec2(1.0, 0.0) : normalize(dir);
  mv.xy += vec2(-dir.y, dir.x) * (aSide * aWidth);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
uniform vec3 uColor;
uniform float uIntensity;
varying float vSide;
varying float vAlpha;
void main() {
  // Falloff across the strip, done analytically so the effect needs no
  // texture: a soft body with a hot near-white filament down the middle.
  float e = 1.0 - abs(vSide);
  float body = e * e;
  float core = pow(e, 8.0);
  vec3 col = mix(uColor, vec3(1.0), core);
  // Additive blending is (SRC_ALPHA, ONE) in three, so everything has to live
  // in rgb and alpha stays at 1.
  gl_FragColor = vec4(col * ((body * 0.75 + core) * vAlpha * uIntensity), 1.0);
}
`;

// -------------------------------------------------------------------- types

export interface GrowthFxSystem extends System {
  /**
   * Fire the swirl around a world position.
   * @param radius half-width of the squad blob in world units; the whole
   *        effect scales off it, so a bigger army gets a bigger vortex.
   */
  play(center: THREE.Vector3, radius?: number): void;
  /** True while the effect is on screen. */
  readonly playing: boolean;
  dispose(): void;
}

/** One orbiting ribbon: an arc of a tilted, squashed circle around the blob. */
interface Arc {
  readonly u: THREE.Vector3;
  readonly v: THREE.Vector3;
  phase: number;
  spin: number;
  span: number;
  lift: number;
}

/** One rising light shaft inside the blob. */
interface Mote {
  ox: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  rise: number;
  delay: number;
  life: number;
}

// ---------------------------------------------------------------- internals

let seed = 0x1f123bb5;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randRange(lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}

function smoothstep(u: number): number {
  return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
}

const _normal = new THREE.Vector3();

// ------------------------------------------------------------------- system

class GrowthFx implements GrowthFxSystem {
  readonly #arcs: Arc[] = [];
  readonly #motes: Mote[] = [];
  /** Width/alpha profile along a strip, precomputed: both are functions of the
   *  strip parameter alone, so they never need recomputing per frame. */
  readonly #widthProfile = new Float32Array(POINTS);
  readonly #alphaProfile = new Float32Array(POINTS);

  readonly #mesh: THREE.Mesh;
  readonly #geo: THREE.BufferGeometry;
  readonly #mat: THREE.ShaderMaterial;
  readonly #pos: Float32Array;
  readonly #tan: Float32Array;
  readonly #wid: Float32Array;
  readonly #alp: Float32Array;
  readonly #aPos: THREE.BufferAttribute;
  readonly #aTan: THREE.BufferAttribute;
  readonly #aWid: THREE.BufferAttribute;
  readonly #aAlp: THREE.BufferAttribute;

  readonly #anchor = new THREE.Vector3();
  readonly #prevAnchor = new THREE.Vector3();
  readonly #shown = new THREE.Vector3();
  #radius = DEFAULT_RADIUS;
  #time = 0;
  #prevTime = 0;
  #playing = false;
  #scene: THREE.Scene | null;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;

    for (let i = 0; i < ARC_COUNT; i++) {
      this.#arcs.push({
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 0, 1),
        phase: 0,
        spin: 0,
        span: SPAN_MIN,
        lift: 0,
      });
    }
    for (let i = 0; i < MOTE_COUNT; i++) {
      this.#motes.push({
        ox: 0,
        oz: 0,
        dx: 0,
        dy: 1,
        dz: 0,
        len: 0,
        rise: 0,
        delay: 0,
        life: MOTE_LIFE_MIN,
      });
    }

    for (let j = 0; j < POINTS; j++) {
      const s = j / (POINTS - 1);
      const bell = Math.sin(Math.PI * s);
      // Both ends taper to nothing — the reference ribbons have no visible
      // head or tail, they simply stop existing.
      this.#widthProfile[j] = Math.pow(bell, 0.6);
      this.#alphaProfile[j] = Math.pow(bell, 0.35);
    }

    const strips = ARC_COUNT + MOTE_COUNT;
    const verts = strips * POINTS * 2;
    this.#pos = new Float32Array(verts * 3);
    this.#tan = new Float32Array(verts * 3);
    this.#wid = new Float32Array(verts);
    this.#alp = new Float32Array(verts);

    const side = new Float32Array(verts);
    for (let i = 0; i < verts; i += 2) {
      side[i] = -1;
      side[i + 1] = 1;
    }

    const index = new Uint16Array(strips * (POINTS - 1) * 6);
    let w = 0;
    for (let s = 0; s < strips; s++) {
      const base = s * POINTS * 2;
      for (let j = 0; j < POINTS - 1; j++) {
        const a = base + j * 2;
        index[w] = a;
        index[w + 1] = a + 1;
        index[w + 2] = a + 2;
        index[w + 3] = a + 1;
        index[w + 4] = a + 3;
        index[w + 5] = a + 2;
        w += 6;
      }
    }

    this.#aPos = new THREE.BufferAttribute(this.#pos, 3);
    this.#aTan = new THREE.BufferAttribute(this.#tan, 3);
    this.#aWid = new THREE.BufferAttribute(this.#wid, 1);
    this.#aAlp = new THREE.BufferAttribute(this.#alp, 1);
    this.#aPos.setUsage(THREE.DynamicDrawUsage);
    this.#aTan.setUsage(THREE.DynamicDrawUsage);
    this.#aWid.setUsage(THREE.DynamicDrawUsage);
    this.#aAlp.setUsage(THREE.DynamicDrawUsage);

    this.#geo = new THREE.BufferGeometry();
    this.#geo.setAttribute("position", this.#aPos);
    this.#geo.setAttribute("aTangent", this.#aTan);
    this.#geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.#geo.setAttribute("aWidth", this.#aWid);
    this.#geo.setAttribute("aAlpha", this.#aAlp);
    this.#geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.#mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(COLOR) },
        uIntensity: { value: INTENSITY },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth-tested on purpose: the arcs passing BEHIND the near units is the
      // cue that sells "orbiting the mass" rather than "drawn on top of it".
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.#mesh = new THREE.Mesh(this.#geo, this.#mat);
    // Vertices are rewritten in world space every frame and the bounds are
    // never recomputed, so culling would be reading stale geometry.
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 20;
    this.#mesh.visible = false;
    scene.add(this.#mesh);
  }

  get playing(): boolean {
    return this.#playing;
  }

  play(center: THREE.Vector3, radius = DEFAULT_RADIUS): void {
    this.#anchor.copy(center);
    this.#prevAnchor.copy(center);
    this.#radius = radius;
    this.#time = 0;
    this.#prevTime = 0;
    this.#playing = true;
    this.#mesh.visible = true;

    for (const a of this.#arcs) {
      const tilt = randRange(TILT_MIN, TILT_MAX);
      const az = rand() * TAU;
      // u is horizontal and v carries the tilt, so the orbit plane is a
      // circle rolled off the ground plane by `tilt` about the `az` bearing.
      _normal.set(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
      a.u.set(-Math.sin(az), 0, Math.cos(az));
      a.v.crossVectors(_normal, a.u);
      a.phase = rand() * TAU;
      a.spin = randRange(SPIN_MIN, SPIN_MAX) * (rand() < 0.5 ? -1 : 1);
      a.span = randRange(SPAN_MIN, SPAN_MAX);
      a.lift = randRange(LIFT_MIN, LIFT_MAX);
    }

    for (const m of this.#motes) {
      const bearing = rand() * TAU;
      const r = radius * Math.sqrt(rand());
      m.ox = Math.cos(bearing) * r;
      m.oz = Math.sin(bearing) * r * FOOTPRINT_DEPTH;
      // Near-vertical, leaned a little so a crowd of shafts is not a picket
      // fence.
      const lx = (rand() * 2 - 1) * 0.22;
      const lz = (rand() * 2 - 1) * 0.22;
      const inv = 1 / Math.hypot(lx, 1, lz);
      m.dx = lx * inv;
      m.dy = inv;
      m.dz = lz * inv;
      m.len = radius * MOTE_LEN * randRange(0.7, 1.35);
      m.rise = radius * MOTE_RISE * randRange(0.8, 1.3);
      m.delay = rand() * MOTE_STAGGER;
      m.life = randRange(MOTE_LIFE_MIN, MOTE_LIFE_MAX);
    }
  }

  update(dt: number, world: WorldState): void {
    if (!this.#playing) return;
    this.#prevTime = this.#time;
    this.#time += dt;
    if (this.#time >= DURATION) {
      this.#playing = false;
      this.#mesh.visible = false;
      return;
    }
    this.#prevAnchor.copy(this.#anchor);
    // Follow the blob: over a 1.5s effect the squad can cross half the road,
    // and a swirl left behind at the spawn point reads as a bug.
    this.#anchor.lerp(world.squadCenter, Math.min(1, FOLLOW * dt));
  }

  render(alpha: number, _world: WorldState): void {
    if (!this.#playing) return;

    const t = this.#prevTime + (this.#time - this.#prevTime) * alpha;
    const k = t / DURATION;
    const env =
      Math.min(1, t / FADE_IN) *
      smoothstep(k <= FADE_FROM ? 1 : 1 - (k - FADE_FROM) / (1 - FADE_FROM));
    this.#shown.copy(this.#prevAnchor).lerp(this.#anchor, alpha);

    const R = this.#radius;
    // Flare out fast, then settle — easeOutQuad on the orbit radius.
    const grow = 1 - (1 - k) * (1 - k);
    const orbit = R * (RADIUS_IN + (RADIUS_OUT - RADIUS_IN) * grow);
    const arcWidth = Math.max(ARC_WIDTH_MIN, R * ARC_WIDTH_FRAC) * env;
    const moteWidth = Math.max(MOTE_WIDTH_MIN, R * MOTE_WIDTH_FRAC);

    const cx = this.#shown.x;
    const cy = this.#shown.y + ARC_HEIGHT;
    const cz = this.#shown.z;

    let p = 0;
    let q = 0;

    for (const a of this.#arcs) {
      const start = a.phase + a.spin * t;
      const y = cy + a.lift * grow;
      for (let j = 0; j < POINTS; j++) {
        const ang = start + (j / (POINTS - 1)) * a.span;
        const c = Math.cos(ang);
        const s = Math.sin(ang) * SQUASH;
        const px = cx + a.u.x * c * orbit + a.v.x * s * orbit;
        const py = y + a.u.y * c * orbit + a.v.y * s * orbit;
        const pz = cz + a.u.z * c * orbit + a.v.z * s * orbit;
        // Tangent is the derivative of the point in the angle — not
        // normalised, because the shader normalises the projection anyway.
        const tx = -a.u.x * Math.sin(ang) + a.v.x * c * SQUASH;
        const ty = -a.u.y * Math.sin(ang) + a.v.y * c * SQUASH;
        const tz = -a.u.z * Math.sin(ang) + a.v.z * c * SQUASH;

        this.#pos[p] = px;
        this.#pos[p + 1] = py;
        this.#pos[p + 2] = pz;
        this.#pos[p + 3] = px;
        this.#pos[p + 4] = py;
        this.#pos[p + 5] = pz;
        this.#tan[p] = tx;
        this.#tan[p + 1] = ty;
        this.#tan[p + 2] = tz;
        this.#tan[p + 3] = tx;
        this.#tan[p + 4] = ty;
        this.#tan[p + 5] = tz;
        p += 6;

        const wj = arcWidth * (this.#widthProfile[j] ?? 0);
        const aj = env * (this.#alphaProfile[j] ?? 0);
        this.#wid[q] = wj;
        this.#wid[q + 1] = wj;
        this.#alp[q] = aj;
        this.#alp[q + 1] = aj;
        q += 2;
      }
    }

    for (const m of this.#motes) {
      const u = (t - m.delay) / m.life;
      // Off-window shafts collapse to a zero-width strip: degenerate triangles
      // cost no fragments, which is cheaper than culling them properly.
      const live = u > 0 && u < 1;
      const shaft = live ? Math.sin(Math.PI * u) * env : 0;
      const bx = cx + m.ox;
      const by = this.#shown.y + (live ? m.rise * u : 0);
      const bz = cz + m.oz;
      for (let j = 0; j < POINTS; j++) {
        const d = (j / (POINTS - 1)) * m.len;
        const px = bx + m.dx * d;
        const py = by + m.dy * d;
        const pz = bz + m.dz * d;
        this.#pos[p] = px;
        this.#pos[p + 1] = py;
        this.#pos[p + 2] = pz;
        this.#pos[p + 3] = px;
        this.#pos[p + 4] = py;
        this.#pos[p + 5] = pz;
        this.#tan[p] = m.dx;
        this.#tan[p + 1] = m.dy;
        this.#tan[p + 2] = m.dz;
        this.#tan[p + 3] = m.dx;
        this.#tan[p + 4] = m.dy;
        this.#tan[p + 5] = m.dz;
        p += 6;

        const wj = moteWidth * shaft * (this.#widthProfile[j] ?? 0);
        const aj = shaft * (this.#alphaProfile[j] ?? 0);
        this.#wid[q] = wj;
        this.#wid[q + 1] = wj;
        this.#alp[q] = aj;
        this.#alp[q + 1] = aj;
        q += 2;
      }
    }

    this.#aPos.needsUpdate = true;
    this.#aTan.needsUpdate = true;
    this.#aWid.needsUpdate = true;
    this.#aAlp.needsUpdate = true;
  }

  dispose(): void {
    if (this.#scene) {
      this.#scene.remove(this.#mesh);
      this.#scene = null;
    }
    this.#geo.dispose();
    this.#mat.dispose();
    this.#playing = false;
    this.#mesh.visible = false;
  }
}

/** Build the swirl and attach it to the scene. Idle until `play` is called. */
export function createGrowthFx(scene: THREE.Scene): GrowthFxSystem {
  return new GrowthFx(scene);
}
