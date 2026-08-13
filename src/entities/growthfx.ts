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
 * One draw call for the whole effect. Ribbons and light shafts are the same
 * primitive — a polyline widened into a camera-facing strip in the vertex
 * shader — so they share one geometry, one material and one buffer upload.
 * Nothing allocates after construction; `play` only rerolls numbers already in
 * the pool.
 *
 * TWO THINGS HERE ARE COUNTER-INTUITIVE AND BOTH ARE SCARS:
 *
 * 1. The orbit planes are kept NEAR-HORIZONTAL. A steeply tilted orbit is
 *    geometrically a fine circle and visually a straight line: this camera sits
 *    22° above a blob 13m away, so a plane rolled 60°+ off horizontal projects
 *    to a sliver ~5:1 elongated, and any arc you cut out of it reads as a
 *    laser beam slashing across the crowd. Curvature you cannot see is not
 *    curvature. See ARC PROJECTION below for the arithmetic.
 *
 * 2. The blending is SCREEN, not additive. Additive over the reference's pale
 *    grey road (~0xb9bcc1) clips every channel to 1.0 and the ribbons come out
 *    white — the one colour they must not be. Screen (`src + dst*(1-src)`)
 *    cannot exceed 1 and a low-red source therefore *holds red down* while
 *    green and blue climb, which is what keeps the ribbons cyan on a light
 *    background. Over black the two blends are identical, so nothing is lost.
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
/**
 * Points along each strip. A ribbon now spans up to 280°, and 18 points across
 * that is a 16° step: on the widest ring that is a chain of chords deviating
 * ~4px from the true curve, which is half of why the first pass read as "hard
 * lines". 44 holds the deviation near a pixel even on the largest ring, at
 * which point the polyline is a curve as far as the eye is concerned.
 */
const POINTS = 44;

/** Seconds the swirl lasts. Deliberately longer than a floater's ~1.0s so the
 *  energy outlives the numbers and the beat has a tail. */
const DURATION = 1.5;
/** Seconds to reach full brightness. Fast — this is an impact, not a bloom. */
const FADE_IN = 0.1;
/** Fraction of DURATION spent at full brightness before the fade begins. */
const FADE_FROM = 0.42;

/**
 * ARC PROJECTION — why the tilt range is small, in numbers.
 *
 * The camera sits at (0, 7.5, 9.5) looking at (0, 0, -9), so a world offset
 * near the squad lands on screen at roughly
 *
 *     screen-x ∝ dx                      screen-y ∝ 0.93·dy − 0.38·dz
 *
 * Depth is foreshortened to about 40% and height is nearly 1:1. Take a ring of
 * radius R whose plane is rolled `T` off horizontal. Its screen ellipse has a
 * horizontal semi-axis of R and a vertical semi-axis of
 *
 *     R · SQUASH · (0.93·sin T + 0.38·cos T)
 *
 * At T = 1.2 rad (the old TILT_MAX) the *horizontal* axis collapses instead —
 * the plane is edge-on — and the ellipse degenerates to about 5:1, i.e. a
 * straight diagonal stripe. At T ≈ 0.2–0.6 rad the ratio lands between 2.7:1
 * and 1.6:1, which is a shape the eye reads as a hoop seen from above. That is
 * the whole fix for "the arcs look like chords".
 */

/** Orbit radius as a fraction of the blob radius, start and end. The flare
 *  outward is what makes the swirl feel like it is releasing something.
 *  RADIUS_OUT > 1 so the ring's flanks clear the blob's edge and stay visible
 *  even while its far side is buried in the crowd. */
const RADIUS_IN = 0.72;
const RADIUS_OUT = 1.22;
/** Per-arc radius multiplier. Without this all eight arcs share one radius and
 *  the swirl reads as a single fat ring instead of nested crescents. */
const RSCALE_MIN = 0.78;
const RSCALE_MAX = 1.24;
/** Metres the orbit climbs over its life. Turns a ring into a vortex. Kept
 *  small: a ring that climbs clear of the crowd stops being occluded by it,
 *  and the occlusion IS the orbit cue. */
const LIFT_MIN = 0.08;
const LIFT_MAX = 0.42;
/** Per-arc height offset off ARC_HEIGHT, metres. Stacks the ribbons through
 *  the crowd's own vertical extent rather than all at one waistline. */
const Y0_MIN = -0.3;
const Y0_MAX = 0.6;
/**
 * Orbit plane tilt off horizontal, radians (~10°–36°), and ALWAYS POSITIVE.
 *
 * The sign is not cosmetic. The screen ellipse's vertical semi-axis is
 * proportional to `0.93·sin T + 0.38·cos T`: at positive T the tilt term and
 * the depth-foreshortening term ADD and the hoop opens up, and at negative T
 * they SUBTRACT and cancel exactly at T ≈ −0.4 rad — a ring rolled backwards
 * by ~23° contains the view direction and projects to a literal straight line.
 * That degenerate band sits right in the middle of the range this file wants,
 * so "randomise the sign for variety" is a trap. Variety comes from YAW_MAX.
 *
 * Past ~0.8 rad the ellipse degenerates the other way, edge-on, which is what
 * the first pass (TILT_MAX = 1.2) was doing.
 */
const TILT_MIN = 0.18;
const TILT_MAX = 0.62;
/** Yaw of the ring's wide axis off "across the road", radians. Bounded so the
 *  long axis never swings down-road, where perspective would foreshorten it
 *  into a sliver — the same degeneracy as a steep tilt, by another route. */
const YAW_MAX = 0.55;
/** Orbit ellipse squash along the depth axis, matching a blob that is wider
 *  than it is deep (squad DEPTH_RATIO is 0.556). Raised from 0.72 because the
 *  camera already foreshortens depth to ~40%: squashing hard in world space on
 *  top of that is what flattened the screen ellipse. */
const SQUASH = 0.74;
/** Radians/second the arcs sweep. About a third of a turn per effect — slower
 *  than the first pass, because a fast sweep on a long arc smears. */
const SPIN_MIN = 0.9;
const SPIN_MAX = 2.0;
/**
 * Arc length, radians (~189°–281°). Deliberately > π: a span of at least half
 * a turn GUARANTEES the ribbon covers both the near and the far side of the
 * ring, so a meaningful stretch of every arc is behind the crowd and gets
 * depth-clipped by it. Short arcs could sit entirely in front, which is what
 * made the first pass read as decals painted over the blob.
 */
const SPAN_MIN = 3.3;
const SPAN_MAX = 4.9;

/** Ribbon half-width as a fraction of blob radius, with a floor so a small
 *  squad's swirl is still a visible line rather than a subpixel shimmer. */
const ARC_WIDTH_FRAC = 0.035;
const ARC_WIDTH_MIN = 0.05;

/** Height of the orbit centre above the squad's ground position. Chest height
 *  on a ~1.35m unit, so the ring threads the crowd instead of hovering over
 *  it. */
const ARC_HEIGHT = 0.62;
/** Blob footprint is wider than deep; shafts spawn inside that ellipse. */
const FOOTPRINT_DEPTH = 0.62;
/**
 * Shaft length, climb and thickness — ABSOLUTE METRES, not fractions of the
 * blob radius.
 *
 * This is the bug that produced the "oversized white glyph" report. These three
 * were fractions of `radius`, but `radius` is the blob's HALF-WIDTH: it grows
 * with troop count (0.368·√n, up to 2.9m) while the thing the shafts actually
 * rise through — a soldier — is 1.35m tall no matter how many of them there
 * are. Scaling a vertical quantity by a horizontal one meant that at ~50 troops
 * (radius ≈ 2.5) a shaft was 0.75m long and climbed to 2.2m, i.e. a bright bar
 * roughly three times the height of a "+1" glyph's ink, sitting at exactly HP
 * bar height on either side of the blob centre. Blown to flat white by the old
 * additive core, that is indistinguishable from a clipped, oversized "1".
 */
const MOTE_LEN_MIN = 0.28;
const MOTE_LEN_MAX = 0.5;
const MOTE_RISE_MIN = 0.75;
const MOTE_RISE_MAX = 1.35;
const MOTE_WIDTH = 0.028;
const MOTE_LIFE_MIN = 0.45;
const MOTE_LIFE_MAX = 0.8;
/** Shafts are staggered so they read as many small events, not one flash. */
const MOTE_STAGGER = 0.35;

/** How fast the swirl re-anchors to a moving squad. Low enough that it trails
 *  the blob slightly when you steer, which reads as attached rather than
 *  parented. */
const FOLLOW = 6;

const DEFAULT_RADIUS = 1.8;

/**
 * Body colour — SATURATED cyan, and the red channel is the load-bearing part.
 *
 * The road this draws over is a pale grey around 0xb9bcc1, i.e. ~0.73 in every
 * channel. Any blend that only ever *adds* pushes all three channels toward
 * 1.0 together, and three equal channels is white by definition — which is how
 * 0x86c9ff (red already at 0.53) came out as white laser lines. Holding red at
 * 0.12 means the road's red barely moves while green and blue saturate, and
 * the difference between them is the cyan the eye actually reads.
 *
 * Verified against a mid-grey background, not against black: on black almost
 * any blue survives, which is why the first pass looked correct in isolation.
 */
const COLOR = 0x1fb6ff;
/**
 * Hot filament colour. Icy, NOT white — a pure-white core over a bright road
 * screens to pure white and takes the hue of the whole ribbon with it. Its red
 * is the lowest number in this file for a reason: screening over a 0.73 grey
 * road can only shift a channel by (1 − 0.73), so the *entire* colour budget
 * available is 27% saturation, and it is spent by holding red down.
 */
const CORE_COLOR = 0x17eaff;
/** Overall gain. The one knob to turn if the swirl looks weak or blown out.
 *  Above 1 on purpose: under screen blending, driving green and blue to
 *  saturation while red is pinned low is what BUYS the cyan, where under the
 *  old additive blend the same move bought white. */
const INTENSITY = 1.35;

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
uniform vec3 uCore;
uniform float uIntensity;
varying float vSide;
varying float vAlpha;
void main() {
  // Falloff across the strip, done analytically so the effect needs no
  // texture: a soft body with a hot filament down the middle. The body
  // exponent is 1.6 rather than 2.0 so the cyan skirt is wide enough to be
  // seen at all — at e^2 essentially only the core survives, and a ribbon
  // whose only visible part is its hot core is a white line.
  float e = 1.0 - abs(vSide);
  float body = pow(e, 1.6);
  float core = pow(e, 5.0);
  vec3 col = mix(uColor, uCore, core);
  float gain = (body * 0.9 + core * 0.5) * vAlpha * uIntensity;
  // Screen blending is (ONE, ONE_MINUS_SRC_COLOR), so the source must be
  // clamped into [0,1] to mean anything: a channel over 1 does not "add more",
  // it just pins that channel to white and destroys the hue.
  gl_FragColor = vec4(clamp(col * gain, 0.0, 1.0), 1.0);
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

/**
 * One orbiting ribbon: an arc of a tilted, squashed circle around the blob.
 * `u` is the ring's wide axis (unit length, roughly across the road) and `v`
 * its depth axis with SQUASH already baked into its LENGTH — so `render` never
 * applies the squash a second time, which is the sort of thing that silently
 * flattens an ellipse into a line.
 */
interface Arc {
  readonly u: THREE.Vector3;
  readonly v: THREE.Vector3;
  phase: number;
  spin: number;
  span: number;
  lift: number;
  /** Per-arc radius multiplier, so the eight ribbons nest instead of stacking. */
  rscale: number;
  /** Per-arc height offset off ARC_HEIGHT. */
  y0: number;
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
        rscale: 1,
        y0: 0,
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
        uCore: { value: new THREE.Color(CORE_COLOR) },
        uIntensity: { value: INTENSITY },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // SCREEN, not additive: dst' = src + dst·(1 − src). Identical to additive
      // over black, but it cannot exceed 1, so a low-red source keeps red near
      // the background's value while green and blue saturate — the ribbon stays
      // cyan on the pale road instead of clipping to white. Alpha is left alone
      // (Zero/One) because the swirl has no business writing the framebuffer's
      // alpha channel.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
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

    // One sweep direction for the whole burst. Counter-rotating ribbons read as
    // debris; a shared direction reads as a vortex, which is the note.
    const dir = rand() < 0.5 ? -1 : 1;

    for (const a of this.#arcs) {
      // Build the ring in the ground plane — wide axis across the road, depth
      // axis squashed — then roll it by `tilt` about that wide axis and yaw the
      // whole thing a little. Constructing it this way is what guarantees the
      // ring stays wider than it is deep no matter which angles come up; the
      // previous version picked an arbitrary azimuth first, which let the wide
      // axis point straight down the road where perspective erased it.
      // Tilt sign is fixed positive on purpose — see TILT_MIN/TILT_MAX.
      const tilt = randRange(TILT_MIN, TILT_MAX);
      const yaw = (rand() * 2 - 1) * YAW_MAX;
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      a.u.set(cy, 0, -sy);
      a.v.set(SQUASH * ct * sy, -SQUASH * st, SQUASH * ct * cy);
      a.phase = rand() * TAU;
      a.spin = randRange(SPIN_MIN, SPIN_MAX) * dir;
      a.span = randRange(SPAN_MIN, SPAN_MAX);
      a.lift = randRange(LIFT_MIN, LIFT_MAX);
      a.rscale = randRange(RSCALE_MIN, RSCALE_MAX);
      a.y0 = randRange(Y0_MIN, Y0_MAX);
    }

    for (const m of this.#motes) {
      const bearing = rand() * TAU;
      // Footprint DOES scale with the blob — this one is a horizontal quantity,
      // so a wider squad spreads its shafts wider. Length and climb below do
      // not; see the MOTE_LEN_* comment.
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
      m.len = randRange(MOTE_LEN_MIN, MOTE_LEN_MAX);
      m.rise = randRange(MOTE_RISE_MIN, MOTE_RISE_MAX);
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

    const cx = this.#shown.x;
    const cy = this.#shown.y + ARC_HEIGHT;
    const cz = this.#shown.z;

    let p = 0;
    let q = 0;

    for (const a of this.#arcs) {
      const start = a.phase + a.spin * t;
      const rad = orbit * a.rscale;
      const y = cy + a.y0 + a.lift * grow;
      for (let j = 0; j < POINTS; j++) {
        const ang = start + (j / (POINTS - 1)) * a.span;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        // No SQUASH here — it is already baked into |a.v| (see the Arc doc).
        const px = cx + (a.u.x * c + a.v.x * s) * rad;
        const py = y + (a.u.y * c + a.v.y * s) * rad;
        const pz = cz + (a.u.z * c + a.v.z * s) * rad;
        // Tangent is the derivative of the point in the angle — not
        // normalised, because the shader normalises the projection anyway.
        const tx = -a.u.x * s + a.v.x * c;
        const ty = -a.u.y * s + a.v.y * c;
        const tz = -a.u.z * s + a.v.z * c;

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

        const wj = MOTE_WIDTH * shaft * (this.#widthProfile[j] ?? 0);
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
