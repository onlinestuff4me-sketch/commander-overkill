/**
 * BARRELS — numbered destructible cover.
 *
 * The number painted on a barrel IS its hit points, and watching it tick down
 * (50 → 45 → 30) is the entire feedback loop for "my guns are working". That
 * makes the numeral the most important pixel in this file: it is drawn to a
 * per-barrel canvas at a size that stays legible at arm's length, and the
 * canvas is only repainted when the displayed integer actually changes — never
 * per frame.
 *
 * ---------------------------------------------------------------------------
 * API — what the rest of the game touches
 * ---------------------------------------------------------------------------
 *
 *   const barrels = createBarrels(scene);
 *
 *   // Spawn. `lane` is normalised [-1, 1] (see mechanics/lane), `z` is world
 *   // depth, `hp` is the numeral. `tag` is an opaque number stored alongside
 *   // the barrel and handed back on every query — the orchestrator uses it to
 *   // remember which enemy elite is riding this barrel.
 *   const id = barrels.spawn(-0.6, -40, 50, riderId);
 *
 *   // BULLETS TEAM: this is your one-liner. Returns hp remaining, 0 when the
 *   // hit destroyed it, or -1 when nothing was there.
 *   const left = barrels.damageAt(bulletX, bulletZ, 0.15, damage);
 *   if (left >= 0) killBullet();
 *
 *   // ORCHESTRATOR: pay out the reward and drop the rider.
 *   barrels.onDestroyed((id, tag, x, z, maxHp) => { ... });
 *
 *   // ORCHESTRATOR: keep barrel riders glued on. Zero allocation — hoist the
 *   // closure once, do not build it inside your update().
 *   barrels.forEachLive(placeRider);
 *
 * Barrels are world furniture: they do not move under their own power, they
 * ride the corridor scroll (`world.scrollSpeed`) toward the camera. Nothing
 * else needs to translate them.
 *
 * ---------------------------------------------------------------------------
 * Rendering shape
 * ---------------------------------------------------------------------------
 * One InstancedMesh for every barrel body (a single wood texture, so they can
 * all share it), plus one small quad per barrel for the numeral (they cannot —
 * each carries its own canvas). Debris, smoke and muzzle-flash bursts are three
 * more instanced meshes drawn from fixed pools. Total: 4 draw calls plus one
 * per live barrel.
 */

import * as THREE from "three";
import type { System } from "../core/types";
import { laneToX } from "../mechanics/lane";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Barrel radius at the ends, in metres. Three abreast fit the 6.8m corridor. */
export const BARREL_RADIUS = 0.62;
/** Length along the barrel's axis, which lies across the road (world X). */
export const BARREL_LENGTH = 1.7;
/** Mid-body swell as a fraction of radius. A straight cylinder reads as a pipe. */
const BARREL_BULGE = 0.09;
const BARREL_MAX_RADIUS = BARREL_RADIUS * (1 + BARREL_BULGE);
/** Sunk very slightly into the road so the silhouette meets its shadow line. */
const BARREL_CENTER_Y = BARREL_MAX_RADIUS * 0.97;
/** Where a rider's feet go. The orchestrator reads this to seat gold elites. */
export const BARREL_TOP_Y = BARREL_CENTER_Y + BARREL_MAX_RADIUS * 0.92;

/** Live barrels. The reference never shows more than ~8 on screen at once. */
const CAPACITY = 16;
/** Past the camera (z 9.5) — anything here is behind the player and gone. */
const DESPAWN_Z = 13;

/** Impact recoil: how long a hit barrel rocks, and how far. Sells each bullet. */
const HIT_SHAKE_TIME = 0.13;
const HIT_SHAKE_AMOUNT = 0.05;

/** Chunky planks, not particle mist — this is the frame_018 read. */
const DEBRIS_PER_BURST = 13;
const DEBRIS_CAPACITY = DEBRIS_PER_BURST * 5;
const DEBRIS_LIFE = 1.25;
const DEBRIS_GRAVITY = 16;

const SMOKE_PER_BURST = 6;
const SMOKE_CAPACITY = SMOKE_PER_BURST * 5;
const SMOKE_LIFE = 0.95;

/** Flash pool serves both the small per-hit spark and the big death fireball. */
const FLASH_CAPACITY = 28;
const SPARK_LIFE = 0.16;
const FIREBALL_LIFE = 0.3;

/**
 * Fake contact shadow. There are no shadow maps in this project by design, but
 * without *something* on the ground a barrel reads as hovering — the reference
 * seats every object with a soft dark patch. Offset matches the scene's key
 * light at (4, 10, 6), so the shadow falls away from it.
 * REMOVE THIS BLOCK if a shared ground-shadow system lands; two conventions
 * disagreeing is worse than one being slightly wrong.
 */
const SHADOW_Y = 0.014;
const SHADOW_OFF_X = -0.2;
const SHADOW_OFF_Z = -0.28;
const SHADOW_OPACITY = 0.34;

/** Numeral canvas. 208×112 keeps three digits crisp at DPR 2 for ~90KB each. */
const NUMERAL_W = 208;
const NUMERAL_H = 112;
const NUMERAL_FONT = 84;
/** Quad size in metres; aspect matches the canvas so glyphs never stretch. */
const NUMERAL_QUAD_W = 1.3;
const NUMERAL_QUAD_H = (NUMERAL_QUAD_W * NUMERAL_H) / NUMERAL_W;
/**
 * How far in front of the barrel's belly the numeral floats. Must clear the
 * bulge at the quad's top edge once tilted, or the barrel clips the digits.
 */
const NUMERAL_Z = BARREL_MAX_RADIUS + 0.19;
const NUMERAL_Y = 0.52;

/**
 * The camera never rotates (see core/renderer), so "face the camera" is one
 * fixed pitch computed once rather than a per-frame lookAt on every billboard.
 */
const CAMERA_PITCH = Math.atan2(CAMERA_POS.y - CAMERA_LOOK.y, CAMERA_POS.z - CAMERA_LOOK.z);
const BILLBOARD = new THREE.Quaternion().setFromEuler(new THREE.Euler(-CAMERA_PITCH, 0, 0));

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

/** Called once per destroyed barrel. Primitives only — this fires from update(). */
export type BarrelDestroyed = (
  id: number,
  tag: number,
  x: number,
  z: number,
  maxHp: number,
) => void;

/** Called for every live barrel, in slot order. `topY` is where a rider stands. */
export type BarrelVisitor = (
  id: number,
  tag: number,
  x: number,
  topY: number,
  z: number,
) => void;

export interface BarrelSystem extends System {
  /** The group holding every barrel and its VFX. Already added to the scene. */
  readonly object: THREE.Group;
  /** Pool size. `spawn` returns -1 once this many barrels are live. */
  readonly capacity: number;
  /** Height a barrel rider's feet sit at, in world units. */
  readonly riderY: number;

  /**
   * Place a barrel. `lane` is normalised [-1, 1]; `hp` becomes the numeral.
   * `tag` is stored verbatim and returned by every query — use it to link the
   * barrel to whatever is riding it. Returns the barrel id, or -1 if full.
   */
  spawn(lane: number, z: number, hp: number, tag?: number): number;

  isAlive(id: number): boolean;
  /** Current hit points, or -1 for a dead/invalid id. */
  hpOf(id: number): number;

  /** Nearest live barrel overlapping (x, z) inflated by `pad`. -1 if none. */
  hitTest(x: number, z: number, pad: number): number;

  /**
   * Damage a specific barrel. Optionally pass the impact point so the spark
   * lands where the bullet did. Returns hp remaining (0 = destroyed this call),
   * or -1 if the id was not live.
   */
  damage(id: number, amount: number, hitX?: number, hitY?: number, hitZ?: number): number;

  /** hitTest + damage in one. Returns hp remaining, or -1 if nothing was hit. */
  damageAt(x: number, z: number, pad: number, amount: number): number;

  /** Visit every live barrel. Allocation-free if you hoist the callback. */
  forEachLive(fn: BarrelVisitor): void;

  /** Register a destruction listener. Multiple listeners are supported. */
  onDestroyed(fn: BarrelDestroyed): void;

  /** Despawn everything and reset the VFX pools. For a run restart. */
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Internal slots — all pre-allocated, nothing is constructed after boot        */
/* -------------------------------------------------------------------------- */

interface Barrel {
  alive: boolean;
  x: number;
  z: number;
  prevZ: number;
  /** Small per-barrel yaw so a row never looks like it was laid with a ruler. */
  yaw: number;
  hp: number;
  maxHp: number;
  /** The integer currently painted on the canvas; guards needless repaints. */
  painted: number;
  tag: number;
  shake: number;
  plane: THREE.Mesh;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

interface Debris {
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ex: number;
  ey: number;
  ez: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}

interface Puff {
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  grow: number;
  roll: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const _ZERO = new THREE.Vector3(0, -999, 0);
const _NOSCALE = new THREE.Vector3(0, 0, 0);
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

/* -------------------------------------------------------------------------- */

export function createBarrels(scene: THREE.Scene): BarrelSystem {
  const object = new THREE.Group();
  object.name = "barrels";
  scene.add(object);

  /* ---- barrel bodies -------------------------------------------------- */

  const woodTex = makeWoodTexture();
  const bodyGeo = makeBarrelGeometry();
  const bodyMat = new THREE.MeshLambertMaterial({ map: woodTex });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, CAPACITY);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = false;
  object.add(bodies);

  /* ---- contact shadows ------------------------------------------------ */

  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowTex = makeShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    // Flat black regardless of lighting; a lit shadow is a contradiction.
    color: 0x000000,
    opacity: SHADOW_OPACITY,
  });
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, CAPACITY);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  shadows.renderOrder = 1;
  object.add(shadows);

  /* ---- numerals ------------------------------------------------------- */

  const numeralGeo = new THREE.PlaneGeometry(NUMERAL_QUAD_W, NUMERAL_QUAD_H);
  const barrels: Barrel[] = [];
  for (let i = 0; i < CAPACITY; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = NUMERAL_W;
    canvas.height = NUMERAL_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("barrels: 2d canvas unavailable");
    const tex = new THREE.CanvasTexture(canvas);
    // Canvas textures default to linear data. The renderer outputs sRGB, so
    // without this every hand-picked colour in this file renders washed out.
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plane = new THREE.Mesh(
      numeralGeo,
      // depthWrite off so the quad never punches a hole in the smoke drawn
      // over a dying barrel; it still depth-tests against the world.
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    plane.rotation.x = -CAMERA_PITCH;
    plane.visible = false;
    plane.frustumCulled = false;
    plane.renderOrder = 2;
    object.add(plane);

    barrels.push({
      alive: false,
      x: 0,
      z: 0,
      prevZ: 0,
      yaw: 0,
      hp: 0,
      maxHp: 0,
      painted: -1,
      tag: -1,
      shake: 0,
      plane,
      ctx,
      tex,
    });
  }

  /* ---- debris --------------------------------------------------------- */

  const plankGeo = new THREE.BoxGeometry(0.46, 0.11, 0.19);
  bakeTopLitColor(plankGeo, 0xb07a33);
  const plankMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const debrisMesh = new THREE.InstancedMesh(plankGeo, plankMat, DEBRIS_CAPACITY);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.frustumCulled = false;
  object.add(debrisMesh);

  const debris: Debris[] = [];
  for (let i = 0; i < DEBRIS_CAPACITY; i++) {
    debris.push({
      life: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      ex: 0,
      ey: 0,
      ez: 0,
      rx: 0,
      ry: 0,
      rz: 0,
      scale: 1,
    });
  }

  /* ---- smoke ---------------------------------------------------------- */

  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const smokeMat = new THREE.MeshBasicMaterial({
    map: makeSmokeTexture(),
    transparent: true,
    depthWrite: false,
    color: 0x8b8b8f,
  });
  // Per-instance opacity: instancing gives us one draw call but no per-instance
  // alpha, and smoke that only shrinks instead of fading reads as a popped
  // balloon. Six lines of shader patch beats 30 individual sprite draw calls.
  const smokeAlpha = attachInstanceAlpha(quadGeo, smokeMat, SMOKE_CAPACITY);
  const smokeMesh = new THREE.InstancedMesh(quadGeo, smokeMat, SMOKE_CAPACITY);
  smokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smokeMesh.frustumCulled = false;
  smokeMesh.renderOrder = 3;
  object.add(smokeMesh);

  const smoke: Puff[] = [];
  for (let i = 0; i < SMOKE_CAPACITY; i++) smoke.push(newPuff());

  /* ---- flashes -------------------------------------------------------- */

  const flashGeo = new THREE.PlaneGeometry(1, 1);
  // Additive fade = fade the colour to black, which needs no alpha channel at
  // all. instanceColor only reaches the fragment when vColor exists, hence the
  // flat white colour attribute.
  bakeFlatColor(flashGeo, 0xffffff);
  const flashMat = new THREE.MeshBasicMaterial({
    map: makeFlashTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Additive + fog means distant flashes get the fog colour *added*, which
    // turns every far-off hit into a blue smear. Opt out.
    fog: false,
    vertexColors: true,
  });
  const flashMesh = new THREE.InstancedMesh(flashGeo, flashMat, FLASH_CAPACITY);
  flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  flashMesh.frustumCulled = false;
  flashMesh.renderOrder = 4;
  for (let i = 0; i < FLASH_CAPACITY; i++) flashMesh.setColorAt(i, _col.setRGB(1, 1, 1));
  object.add(flashMesh);

  const flashes: Puff[] = [];
  for (let i = 0; i < FLASH_CAPACITY; i++) flashes.push(newPuff());

  /* ---- state ---------------------------------------------------------- */

  const destroyedListeners: BarrelDestroyed[] = [];
  let disposed = false;

  function hideAll(): void {
    for (let i = 0; i < CAPACITY; i++) {
      _m.compose(_ZERO, _q.identity(), _NOSCALE);
      bodies.setMatrixAt(i, _m);
    }
    bodies.instanceMatrix.needsUpdate = true;
  }
  hideAll();

  /* ---- VFX emitters --------------------------------------------------- */

  function emitFlash(x: number, y: number, z: number, size: number, life: number): void {
    for (let i = 0; i < FLASH_CAPACITY; i++) {
      const f = flashes[i];
      if (!f || f.life > 0) continue;
      f.life = life;
      f.maxLife = life;
      f.x = x;
      f.y = y;
      f.z = z;
      f.vx = 0;
      f.vy = 0;
      f.vz = 0;
      f.size = size;
      f.grow = size * 0.9;
      f.roll = Math.random() * Math.PI;
      return;
    }
  }

  function emitBurst(x: number, y: number, z: number): void {
    emitFlash(x, y + 0.1, z, 2.5, FIREBALL_LIFE);

    for (let n = 0, spawned = 0; n < DEBRIS_CAPACITY && spawned < DEBRIS_PER_BURST; n++) {
      const d = debris[n];
      if (!d || d.life > 0) continue;
      spawned++;
      // Fan the planks outward and up: a barrel blowing apart throws its staves
      // sideways, and the up component is what keeps them on screen long enough
      // to be read as planks rather than a puff.
      const a = Math.random() * Math.PI * 2;
      const speed = 2.6 + Math.random() * 3.4;
      d.life = DEBRIS_LIFE * (0.7 + Math.random() * 0.5);
      d.x = x + (Math.random() - 0.5) * 0.5;
      d.y = y + Math.random() * 0.5;
      d.z = z + (Math.random() - 0.5) * 0.35;
      d.vx = Math.cos(a) * speed;
      d.vz = Math.sin(a) * speed * 0.7;
      d.vy = 3.4 + Math.random() * 3.6;
      d.ex = Math.random() * 6.28;
      d.ey = Math.random() * 6.28;
      d.ez = Math.random() * 6.28;
      d.rx = (Math.random() - 0.5) * 16;
      d.ry = (Math.random() - 0.5) * 16;
      d.rz = (Math.random() - 0.5) * 16;
      d.scale = 0.75 + Math.random() * 0.75;
    }

    for (let n = 0, spawned = 0; n < SMOKE_CAPACITY && spawned < SMOKE_PER_BURST; n++) {
      const p = smoke[n];
      if (!p || p.life > 0) continue;
      spawned++;
      const life = SMOKE_LIFE * (0.7 + Math.random() * 0.6);
      p.life = life;
      p.maxLife = life;
      p.x = x + (Math.random() - 0.5) * 0.8;
      p.y = y + Math.random() * 0.6;
      p.z = z + (Math.random() - 0.5) * 0.5;
      p.vx = (Math.random() - 0.5) * 1.5;
      p.vy = 0.7 + Math.random() * 0.9;
      p.vz = (Math.random() - 0.5) * 1.0;
      p.size = 0.9 + Math.random() * 0.7;
      p.grow = 1.5 + Math.random() * 1.1;
      p.roll = Math.random() * Math.PI * 2;
    }
  }

  /* ---- numeral painting ----------------------------------------------- */

  function repaint(b: Barrel): void {
    const value = b.hp < 0 ? 0 : Math.ceil(b.hp);
    if (value === b.painted) return;
    b.painted = value;
    drawNumeral(b.ctx, value);
    b.tex.needsUpdate = true;
  }

  /* ---- system --------------------------------------------------------- */

  const system: BarrelSystem = {
    object,
    capacity: CAPACITY,
    riderY: BARREL_TOP_Y,

    spawn(lane, z, hp, tag = -1) {
      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b || b.alive) continue;
        b.alive = true;
        b.x = laneToX(lane);
        b.z = z;
        b.prevZ = z;
        b.yaw = (Math.random() - 0.5) * 0.24;
        b.hp = hp;
        b.maxHp = hp;
        b.tag = tag;
        b.shake = 0;
        b.painted = -1;
        repaint(b);
        // Seat the numeral now rather than waiting for render(), so a barrel
        // spawned outside the loop never shows for a frame at the last
        // occupant's position.
        b.plane.position.set(b.x, NUMERAL_Y, z + NUMERAL_Z);
        b.plane.visible = true;
        return i;
      }
      return -1;
    },

    isAlive(id) {
      const b = barrels[id];
      return b !== undefined && b.alive;
    },

    hpOf(id) {
      const b = barrels[id];
      return b && b.alive ? b.hp : -1;
    },

    hitTest(x, z, pad) {
      let best = -1;
      let bestD = Infinity;
      const halfLen = BARREL_LENGTH * 0.5;
      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b || !b.alive) continue;
        const dx = x - b.x;
        const dz = z - b.z;
        if (dx > halfLen + pad || dx < -halfLen - pad) continue;
        if (dz > BARREL_MAX_RADIUS + pad || dz < -BARREL_MAX_RADIUS - pad) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },

    damage(id, amount, hitX, hitY, hitZ) {
      const b = barrels[id];
      if (!b || !b.alive) return -1;

      b.hp -= amount;
      b.shake = HIT_SHAKE_TIME;
      emitFlash(
        hitX ?? b.x,
        hitY ?? BARREL_CENTER_Y + 0.15,
        hitZ ?? b.z + BARREL_MAX_RADIUS,
        0.85,
        SPARK_LIFE,
      );

      if (b.hp > 0) {
        repaint(b);
        return b.hp;
      }

      b.hp = 0;
      b.alive = false;
      b.plane.visible = false;
      emitBurst(b.x, BARREL_CENTER_Y, b.z);
      for (const fn of destroyedListeners) fn(id, b.tag, b.x, b.z, b.maxHp);
      return 0;
    },

    damageAt(x, z, pad, amount) {
      const id = system.hitTest(x, z, pad);
      if (id < 0) return -1;
      return system.damage(id, amount, x, undefined, z);
    },

    forEachLive(fn) {
      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b || !b.alive) continue;
        fn(i, b.tag, b.x, BARREL_TOP_Y, b.z);
      }
    },

    onDestroyed(fn) {
      destroyedListeners.push(fn);
    },

    clear() {
      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b) continue;
        b.alive = false;
        b.plane.visible = false;
      }
      for (let i = 0; i < DEBRIS_CAPACITY; i++) {
        const d = debris[i];
        if (d) d.life = 0;
      }
      for (let i = 0; i < SMOKE_CAPACITY; i++) {
        const p = smoke[i];
        if (p) p.life = 0;
      }
      for (let i = 0; i < FLASH_CAPACITY; i++) {
        const f = flashes[i];
        if (f) f.life = 0;
      }
      hideAll();
    },

    update(dt, world) {
      const scroll = world.scrollSpeed * dt;

      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b || !b.alive) continue;
        b.prevZ = b.z;
        b.z += scroll;
        if (b.shake > 0) b.shake -= dt;
        if (b.z > DESPAWN_Z) {
          // Rolled past the player without being shot. No reward, no bang —
          // silently retire it so the pool never starves.
          b.alive = false;
          b.plane.visible = false;
        }
      }

      for (let i = 0; i < DEBRIS_CAPACITY; i++) {
        const d = debris[i];
        if (!d || d.life <= 0) continue;
        d.life -= dt;
        d.vy -= DEBRIS_GRAVITY * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        // Debris belongs to the world, so it rides the corridor scroll on top
        // of its own throw velocity — otherwise landed planks hang in space
        // while the road slides out from under them.
        d.z += (d.vz + world.scrollSpeed) * dt;
        d.ex += d.rx * dt;
        d.ey += d.ry * dt;
        d.ez += d.rz * dt;
        // One bounce, heavily damped: planks that skitter forever look like
        // physics debug, planks that stick look like they landed.
        if (d.y < 0.06 && d.vy < 0) {
          d.y = 0.06;
          d.vy = -d.vy * 0.32;
          d.vx *= 0.55;
          d.vz *= 0.55;
          d.rx *= 0.4;
          d.ry *= 0.4;
          d.rz *= 0.4;
        }
      }

      for (let i = 0; i < SMOKE_CAPACITY; i++) {
        const p = smoke[i];
        if (!p || p.life <= 0) continue;
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += (p.vz + world.scrollSpeed) * dt;
        p.vx *= 0.94;
        p.vy *= 0.97;
      }

      for (let i = 0; i < FLASH_CAPACITY; i++) {
        const f = flashes[i];
        if (!f || f.life <= 0) continue;
        f.life -= dt;
        f.z += world.scrollSpeed * dt;
      }
    },

    render(alpha, _world) {
      /* barrels */
      for (let i = 0; i < CAPACITY; i++) {
        const b = barrels[i];
        if (!b || !b.alive) {
          _m.compose(_ZERO, _q.identity(), _NOSCALE);
          bodies.setMatrixAt(i, _m);
          shadows.setMatrixAt(i, _m);
          continue;
        }
        const z = b.prevZ + (b.z - b.prevZ) * alpha;
        // Recoil kick: a short decaying wobble toward the camera. The barrel is
        // being shot from the front, so it rocks on its Z axis, not its X.
        const k = b.shake > 0 ? (b.shake / HIT_SHAKE_TIME) * HIT_SHAKE_AMOUNT : 0;
        const wob = k * Math.sin(b.shake * 150);
        _pos.set(b.x, BARREL_CENTER_Y, z + wob);
        _e.set(0, b.yaw, wob * 1.6);
        _q.setFromEuler(_e);
        _scl.set(1, 1, 1);
        _m.compose(_pos, _q, _scl);
        bodies.setMatrixAt(i, _m);

        _pos.set(b.x + SHADOW_OFF_X, SHADOW_Y, z + SHADOW_OFF_Z);
        _scl.set(BARREL_LENGTH * 1.45, 1, BARREL_MAX_RADIUS * 3.1);
        _m.compose(_pos, _q.identity(), _scl);
        shadows.setMatrixAt(i, _m);

        b.plane.position.set(b.x + wob * 0.5, NUMERAL_Y, z + NUMERAL_Z);
      }
      bodies.instanceMatrix.needsUpdate = true;
      shadows.instanceMatrix.needsUpdate = true;

      /* debris */
      for (let i = 0; i < DEBRIS_CAPACITY; i++) {
        const d = debris[i];
        if (!d || d.life <= 0) {
          _m.compose(_ZERO, _q.identity(), _NOSCALE);
          debrisMesh.setMatrixAt(i, _m);
          continue;
        }
        // Shrink out over the last fifth of life rather than popping.
        const fade = d.life < 0.25 ? d.life / 0.25 : 1;
        _pos.set(d.x, d.y, d.z);
        _e.set(d.ex, d.ey, d.ez);
        _q.setFromEuler(_e);
        _scl.setScalar(d.scale * fade);
        _m.compose(_pos, _q, _scl);
        debrisMesh.setMatrixAt(i, _m);
      }
      debrisMesh.instanceMatrix.needsUpdate = true;

      /* smoke */
      for (let i = 0; i < SMOKE_CAPACITY; i++) {
        const p = smoke[i];
        if (!p || p.life <= 0) {
          _m.compose(_ZERO, _q.identity(), _NOSCALE);
          smokeMesh.setMatrixAt(i, _m);
          smokeAlpha.setX(i, 0);
          continue;
        }
        const t = 1 - p.life / p.maxLife;
        _pos.set(p.x, p.y, p.z);
        _q.setFromAxisAngle(_AXIS_Z, p.roll).premultiply(BILLBOARD);
        _scl.setScalar(p.size + p.grow * t);
        _m.compose(_pos, _q, _scl);
        smokeMesh.setMatrixAt(i, _m);
        // Fast in, slow out: the puff should be at full density almost at once
        // and then linger, which is what makes it read as smoke and not a flash.
        smokeAlpha.setX(i, Math.min(1, t * 6) * (1 - t) * 0.85);
      }
      smokeMesh.instanceMatrix.needsUpdate = true;
      smokeAlpha.needsUpdate = true;

      /* flashes */
      for (let i = 0; i < FLASH_CAPACITY; i++) {
        const f = flashes[i];
        if (!f || f.life <= 0) {
          _m.compose(_ZERO, _q.identity(), _NOSCALE);
          flashMesh.setMatrixAt(i, _m);
          continue;
        }
        const t = 1 - f.life / f.maxLife;
        _pos.set(f.x, f.y, f.z);
        _q.setFromAxisAngle(_AXIS_Z, f.roll).premultiply(BILLBOARD);
        _scl.setScalar(f.size + f.grow * t);
        _m.compose(_pos, _q, _scl);
        flashMesh.setMatrixAt(i, _m);
        const k = 1 - t * t;
        flashMesh.setColorAt(i, _col.setRGB(k, k * 0.72, k * 0.32));
      }
      flashMesh.instanceMatrix.needsUpdate = true;
      if (flashMesh.instanceColor) flashMesh.instanceColor.needsUpdate = true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      bodyGeo.dispose();
      bodyMat.dispose();
      woodTex.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      shadowTex.dispose();
      shadows.dispose();
      numeralGeo.dispose();
      for (const b of barrels) {
        b.tex.dispose();
        (b.plane.material as THREE.Material).dispose();
      }
      plankGeo.dispose();
      plankMat.dispose();
      quadGeo.dispose();
      smokeMat.map?.dispose();
      smokeMat.dispose();
      flashGeo.dispose();
      flashMat.map?.dispose();
      flashMat.dispose();
      bodies.dispose();
      debrisMesh.dispose();
      smokeMesh.dispose();
      flashMesh.dispose();
    },
  };

  return system;
}

/* -------------------------------------------------------------------------- */
/* Geometry & texture construction (boot only)                                 */
/* -------------------------------------------------------------------------- */

function newPuff(): Puff {
  return {
    life: 0,
    maxLife: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    size: 1,
    grow: 0,
    roll: 0,
  };
}

/**
 * A cylinder laid on its side across the road, swollen in the middle.
 *
 * The end caps get their UVs collapsed onto the dark iron strip at the very top
 * of the wood texture. A cylinder's cap UVs otherwise sample the whole texture
 * as a disc, which paints plank seams across the barrel's end in a radial fan.
 * Remapping is one loop and saves splitting this into a multi-material mesh.
 */
function makeBarrelGeometry(): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(BARREL_RADIUS, BARREL_RADIUS, BARREL_LENGTH, 14, 1, false);
  const pos = geo.attributes["position"] as THREE.BufferAttribute;
  const uv = geo.attributes["uv"] as THREE.BufferAttribute;
  const index = geo.getIndex();
  const half = BARREL_LENGTH * 0.5;

  // Swell toward the middle. The factor is 1 at both ends, so cap vertices and
  // the torso's end rings stay put and the caps still meet the torso exactly.
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = y / half;
    const swell = 1 + BARREL_BULGE * (1 - t * t);
    pos.setXYZ(i, pos.getX(i) * swell, y, pos.getZ(i) * swell);
  }

  // Groups 1 and 2 are the caps (group 0 is the torso). Walking them by index
  // is the only safe way to find cap vertices: they sit at the same y as the
  // torso's end rings, so a positional test would drag the torso's UVs with it.
  if (index) {
    for (let g = 1; g < geo.groups.length; g++) {
      const grp = geo.groups[g];
      if (!grp) continue;
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        uv.setXY(index.getX(i), 0.5, 0.985);
      }
    }
  }

  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.computeVertexNormals();
  // Axis across the road: the numeral face then points straight at the camera.
  geo.rotateZ(Math.PI / 2);
  return geo;
}

/**
 * Wood staves running along the barrel's axis plus iron hoops around it.
 * U wraps the circumference (vertical bands here), V runs along the axis
 * (horizontal bands = hoops). Stave count divides the width evenly so the
 * pattern wraps without a seam.
 */
function makeWoodTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 96;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("barrels: 2d canvas unavailable");

  ctx.fillStyle = "#b0762e";
  ctx.fillRect(0, 0, 128, 96);

  const staves = 16;
  const w = 128 / staves;
  for (let i = 0; i < staves; i++) {
    const shade = i % 2 === 0 ? "#bc8137" : "#a56b28";
    ctx.fillStyle = shade;
    ctx.fillRect(i * w, 0, w, 96);
    ctx.fillStyle = "rgba(90,52,16,0.55)";
    ctx.fillRect(i * w, 0, 1.5, 96);
    // A lighter streak inside each stave reads as grain at a glance and stops
    // the barrel looking like a striped beach ball at distance.
    ctx.fillStyle = "rgba(255,220,160,0.13)";
    ctx.fillRect(i * w + w * 0.45, 0, 1, 96);
  }

  // Iron hoops. The two at the ends double as the end-cap colour (see UV remap).
  const hoop = (y: number, h: number): void => {
    ctx.fillStyle = "#4a4f57";
    ctx.fillRect(0, y, 128, h);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(0, y, 128, Math.max(1, h * 0.28));
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, y + h * 0.72, 128, Math.max(1, h * 0.28));
  };
  hoop(0, 5);
  hoop(91, 5);
  hoop(20, 7);
  hoop(69, 7);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Big white digits, thick black outline. Legibility beats everything here. */
function drawNumeral(ctx: CanvasRenderingContext2D, value: number): void {
  ctx.clearRect(0, 0, NUMERAL_W, NUMERAL_H);
  const text = String(value);

  ctx.font = `900 ${NUMERAL_FONT}px "Arial Black", Impact, "Helvetica Neue", sans-serif`;
  // Shrink only when a long number would run off the quad, so a "1" and a "50"
  // share the same glyph height — exactly as they do in the reference.
  const measured = ctx.measureText(text).width;
  const maxWidth = NUMERAL_W - 26;
  if (measured > maxWidth) {
    const size = Math.floor((NUMERAL_FONT * maxWidth) / measured);
    ctx.font = `900 ${size}px "Arial Black", Impact, "Helvetica Neue", sans-serif`;
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const cx = NUMERAL_W / 2;
  const cy = NUMERAL_H / 2 + 2;

  ctx.strokeStyle = "#14100c";
  ctx.lineWidth = 17;
  ctx.strokeText(text, cx, cy);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 26;
  ctx.strokeText(text, cx, cy + 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, cx, cy);
}

/** A soft ellipse of alpha. Black RGB so the material never tints it. */
function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("barrels: 2d canvas unavailable");

  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,1)");
  // Held near-solid to ~45% of the radius, so the shadow has a readable core
  // instead of dissolving into a grey smudge at phone size.
  g.addColorStop(0.45, "rgba(0,0,0,0.85)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);

  return new THREE.CanvasTexture(c);
}

/** Soft grey cloud built from overlapping radial blobs, not one clean circle. */
function makeSmokeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("barrels: 2d canvas unavailable");

  const blob = (x: number, y: number, r: number, a: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  blob(48, 50, 30, 0.85);
  blob(32, 38, 20, 0.7);
  blob(64, 40, 22, 0.7);
  blob(58, 62, 19, 0.6);
  blob(36, 62, 17, 0.55);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}

/** Hot core plus four spikes — the frame_005 impact starburst. */
function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("barrels: 2d canvas unavailable");

  ctx.translate(64, 64);
  for (let i = 0; i < 4; i++) {
    const g = ctx.createLinearGradient(0, 0, 62, 0);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.35, "rgba(255,190,80,0.5)");
    g.addColorStop(1, "rgba(255,140,20,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(62, 0);
    ctx.lineTo(0, 9);
    ctx.closePath();
    ctx.fill();
    ctx.rotate(Math.PI / 2);
  }

  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 34);
  core.addColorStop(0, "rgba(255,255,245,1)");
  core.addColorStop(0.35, "rgba(255,205,110,0.85)");
  core.addColorStop(1, "rgba(255,120,0,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, 34, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Flat vertex colour, so instanceColor has a vColor to multiply into. */
function bakeFlatColor(geo: THREE.BufferGeometry, hex: number): void {
  const pos = geo.attributes["position"] as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(hex);
  for (let i = 0; i < pos.count; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

/**
 * Vertex colour biased by how upward-facing each vertex is. From a camera this
 * steeply pitched you mostly see tops, and a flat-shaded plank tumbling through
 * the air is much easier to track when its top face is brighter.
 */
function bakeTopLitColor(geo: THREE.BufferGeometry, hex: number): void {
  const pos = geo.attributes["position"] as THREE.BufferAttribute;
  const nrm = geo.attributes["normal"] as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(hex);
  for (let i = 0; i < pos.count; i++) {
    const k = 0.78 + 0.32 * Math.max(0, nrm.getY(i));
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

/**
 * Give an instanced material a per-instance alpha channel.
 *
 * three has no built-in for this: instanceColor covers RGB only. The patch adds
 * one float attribute and multiplies it into the final fragment alpha, which is
 * blend-mode agnostic and survives however the material is otherwise shaded.
 */
function attachInstanceAlpha(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  count: number,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aInstanceAlpha", attr);

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "attribute float aInstanceAlpha;\nvarying float vInstanceAlpha;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvInstanceAlpha = aInstanceAlpha;",
      );
    shader.fragmentShader =
      "varying float vInstanceAlpha;\n" +
      shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        "#include <opaque_fragment>\ngl_FragColor.a *= vInstanceAlpha;",
      );
  };

  return attr;
}
