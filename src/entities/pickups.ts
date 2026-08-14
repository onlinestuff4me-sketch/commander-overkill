/**
 * PICKUPS — what rides a barrel, and what you get for breaking it.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 * Barrel riders were built as hostile "gold rim-lit elites" on the strength of
 * a line in REFERENCE.md that turned out to be a misread. The footage says
 * otherwise: `reference-media/clip1a` at 0.20 s shows a barrel bursting and
 * THREE soldiers in the player's own blue helmet and pale uniform flying up out
 * of a golden explosion, and at 0.25 s a barrel marked 220 carrying a
 * blue-and-gold MINIGUN hovering over it. Barrels are not cover holding
 * attackers. They are locked boxes, and the thing on top is the prize.
 *
 * So a pickup is a reward with a face: a recruit adds bodies, a weapon adds
 * firepower. That is the crowd-size axis and the damage axis becoming separate
 * things you can be lopsided in, which is the mechanic the pacing proposal
 * describes and could not previously express — `tierFor(troops)` made quality a
 * pure function of quantity, so there was no such thing as a big weak army.
 *
 * ---------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------------
 * One instanced mesh per kind plus one shared glow sprite: four draw calls for
 * every pickup on screen, whatever the mix. Everything is pooled at boot and
 * nothing allocates in update() or render().
 *
 * The gold rim in the reference is a true outline. This uses a billboard glow
 * disc behind the object instead — at the size a pickup occupies on a phone the
 * two are indistinguishable, and an outline pass would mean either a second
 * pass over every mesh or post-processing, which the frame budget rules out.
 */

import * as THREE from "three";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";
import type { System } from "../core/types";

/** What a barrel can be carrying. */
export type PickupKind = "recruit" | "minigun" | "rocket";

export const PICKUP_KINDS: readonly PickupKind[] = ["recruit", "minigun", "rocket"];

/** Live pickups. One per barrel, and barrels cap at 16. */
const CAPACITY = 16;

/** Metres the pickup hovers above whatever it is sitting on. */
const HOVER = 0.5;
/** Bob amplitude and rate. A prize should never be as still as scenery. */
const BOB = 0.09;
const BOB_RATE = 2.6;
/** Radians/second of lazy spin, so the silhouette reads from every angle. */
const SPIN_RATE = 1.1;

/** Seconds the collect flight takes to reach the crowd. */
const FLY_TIME = 0.45;
/** Metres the pickup pops upward before it heads for the squad — the reference
 *  throws its recruits clear of the explosion before they travel. */
const FLY_LIFT = 1.6;

/**
 * Diameter of the glow disc, in metres.
 *
 * Sized to sit just OUTSIDE the object rather than behind it. At 1.5 the disc
 * was wider than the pickup and read as a white blob at distance — the glow was
 * the silhouette, which defeats the point of three distinguishable shapes.
 */
const GLOW_SIZE = 1.05;

/** Seconds without a `pin` before a pickup is assumed orphaned and retired.
 *  Two ticks would do; this is generous enough to survive a frame hitch. */
const STALE_TIME = 0.25;

export interface PickupSystem extends System {
  readonly object: THREE.Group;
  /** Place a pickup. Returns its id, or -1 when the pool is full. */
  spawn(kind: PickupKind, x: number, y: number, z: number): number;
  /** Hold a pickup at a world position; call once per tick while its barrel
   *  lives. A pickup in flight ignores this. */
  pin(id: number, x: number, y: number, z: number): void;
  /** What kind a pickup is, or null if the id is not live. */
  kindOf(id: number): PickupKind | null;
  /**
   * Its barrel broke: fly it into the crowd and retire it. The EFFECT is the
   * orchestrator's to apply — this is the flight, not the reward.
   */
  collect(id: number): void;
  /** Drop everything. For a run restart. */
  clear(): void;
}

interface Pickup {
  alive: boolean;
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  phase: number;
  spin: number;
  /** 0 while riding, ramps to 1 across the collect flight. */
  fly: number;
  /** Where the flight started, so the arc is stable as the crowd moves. */
  fromX: number;
  fromY: number;
  fromZ: number;
  /** Clock reading of the last `pin`. A pickup whose barrel has gone — driven
   *  past un-destroyed, or recycled — stops being pinned and must retire, or
   *  the pool silently fills with prizes nobody can reach and later barrels
   *  spawn carrying nothing. */
  pinnedAt: number;
}

export function createPickups(scene: THREE.Scene): PickupSystem {
  const object = new THREE.Group();
  scene.add(object);

  const geo: Record<PickupKind, THREE.BufferGeometry> = {
    recruit: recruitGeometry(),
    minigun: minigunGeometry(),
    rocket: rocketGeometry(),
  };

  // Vertex colours carry the whole look, so one material serves every kind.
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const meshes = {} as Record<PickupKind, THREE.InstancedMesh>;
  for (const kind of PICKUP_KINDS) {
    const mesh = new THREE.InstancedMesh(geo[kind], bodyMat, CAPACITY);
    mesh.frustumCulled = false;
    mesh.count = 0;
    meshes[kind] = mesh;
    object.add(mesh);
  }

  const glowTex = glowTexture();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, CAPACITY);
  glow.frustumCulled = false;
  glow.count = 0;
  glow.renderOrder = 5;
  object.add(glow);

  // The camera never rotates, so the billboard orientation is fixed and can be
  // computed once — same trick the bullet sprites use.
  const viewNormal = new THREE.Vector3().subVectors(CAMERA_POS, CAMERA_LOOK).normalize();
  const glowQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(viewNormal, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
  );

  const pool: Pickup[] = [];
  for (let i = 0; i < CAPACITY; i++) {
    pool.push({
      alive: false,
      kind: "recruit",
      x: 0,
      y: 0,
      z: 0,
      prevX: 0,
      prevY: 0,
      prevZ: 0,
      phase: 0,
      spin: 0,
      fly: 0,
      fromX: 0,
      fromY: 0,
      fromZ: 0,
      pinnedAt: 0,
    });
  }

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const spinAxis = new THREE.Vector3(0, 1, 0);
  let clock = 0;

  function retire(p: Pickup): void {
    p.alive = false;
    p.fly = 0;
  }

  return {
    object,

    spawn(kind, x, y, z) {
      for (let i = 0; i < CAPACITY; i++) {
        const p = pool[i]!;
        if (p.alive) continue;
        p.alive = true;
        p.kind = kind;
        p.x = x;
        p.y = y + HOVER;
        p.z = z;
        p.prevX = p.x;
        p.prevY = p.y;
        p.prevZ = p.z;
        p.phase = i * 1.7;
        p.spin = i * 0.9;
        p.fly = 0;
        p.pinnedAt = clock;
        return i;
      }
      return -1;
    },

    pin(id, x, y, z) {
      const p = pool[id];
      if (!p || !p.alive || p.fly > 0) return;
      p.x = x;
      p.y = y + HOVER;
      p.z = z;
      p.pinnedAt = clock;
    },

    kindOf(id) {
      const p = pool[id];
      return p && p.alive ? p.kind : null;
    },

    collect(id) {
      const p = pool[id];
      if (!p || !p.alive || p.fly > 0) return;
      // Tiny non-zero so the flight starts on the next tick rather than being
      // mistaken for "not flying" by `pin`.
      p.fly = 1e-4;
      p.fromX = p.x;
      p.fromY = p.y;
      p.fromZ = p.z;
    },

    clear() {
      for (const p of pool) retire(p);
    },

    update(dt, world) {
      clock += dt;
      for (const p of pool) {
        if (!p.alive) continue;
        p.prevX = p.x;
        p.prevY = p.y;
        p.prevZ = p.z;
        p.spin += SPIN_RATE * dt;

        if (p.fly <= 0 && clock - p.pinnedAt > STALE_TIME) {
          retire(p);
          continue;
        }

        if (p.fly > 0) {
          p.fly = Math.min(1, p.fly + dt / FLY_TIME);
          // Ease toward the crowd, read live so the prize tracks a steering
          // army instead of flying at where it used to be.
          const t = p.fly;
          const ease = t * t * (3 - 2 * t);
          p.x = p.fromX + (world.squadCenter.x - p.fromX) * ease;
          p.z = p.fromZ + (world.squadCenter.z - p.fromZ) * ease;
          // Up first, then down into the crowd — an arc, not a slide.
          p.y = p.fromY + FLY_LIFT * Math.sin(Math.PI * t) - (p.fromY - 1) * ease;
          if (p.fly >= 1) retire(p);
        }
      }
    },

    render(alpha, _world) {
      const counts: Record<string, number> = { recruit: 0, minigun: 0, rocket: 0 };
      let glowCount = 0;

      for (const p of pool) {
        if (!p.alive) continue;
        const x = p.prevX + (p.x - p.prevX) * alpha;
        const z = p.prevZ + (p.z - p.prevZ) * alpha;
        // Bob only while it is still riding; a collected pickup is already
        // being thrown around and a bob on top of that reads as a wobble.
        const bob = p.fly > 0 ? 0 : Math.sin(clock * BOB_RATE + p.phase) * BOB;
        const y = p.prevY + (p.y - p.prevY) * alpha + bob;
        // Shrink into the crowd at the end of the flight, so it is absorbed
        // rather than clipping through a hundred helmets.
        const s = p.fly > 0 ? 1 - Math.max(0, (p.fly - 0.7) / 0.3) : 1;

        quat.setFromAxisAngle(spinAxis, p.spin);
        pos.set(x, y, z);
        scl.set(s, s, s);
        m.compose(pos, quat, scl);
        const mesh = meshes[p.kind];
        mesh.setMatrixAt(counts[p.kind]!, m);
        counts[p.kind]!++;

        const g = GLOW_SIZE * s;
        pos.set(x, y, z - 0.05);
        scl.set(g, g, g);
        m.compose(pos, glowQuat, scl);
        glow.setMatrixAt(glowCount, m);
        glowCount++;
      }

      for (const kind of PICKUP_KINDS) {
        const mesh = meshes[kind];
        mesh.count = counts[kind]!;
        mesh.instanceMatrix.needsUpdate = true;
      }
      glow.count = glowCount;
      glow.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      scene.remove(object);
      for (const kind of PICKUP_KINDS) geo[kind].dispose();
      glow.geometry.dispose();
      bodyMat.dispose();
      glowMat.dispose();
      glowTex.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry — primitives only, per the asset policy                            */
/* -------------------------------------------------------------------------- */

const HELMET = new THREE.Color(0x3d7fd6);
const SKIN = new THREE.Color(0xf0c9a0);
const UNIFORM = new THREE.Color(0xf2ead6);
const GUNMETAL = new THREE.Color(0x4a5568);
const BRASS = new THREE.Color(0xd8a13a);
const STEEL = new THREE.Color(0x8f9bb0);
const WARHEAD = new THREE.Color(0xd8452f);

/** Paint every vertex of `g` one colour and merge it into `parts`. */
function tint(g: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferGeometry {
  const n = g.attributes.position!.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Hand-merged rather than pulling in BufferGeometryUtils: three's helper lives
  // in the examples bundle, and the whole point of the asset policy is to keep
  // the dependency surface at three.js core plus lil-gui.
  let total = 0;
  for (const p of parts) total += p.attributes.position!.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let at = 0;
  for (const p of parts) {
    const src = p.toNonIndexed();
    const sp = src.attributes.position!.array as ArrayLike<number>;
    const sn = src.attributes.normal!.array as ArrayLike<number>;
    const sc = src.attributes.color!.array as ArrayLike<number>;
    const count = src.attributes.position!.count;
    for (let i = 0; i < count * 3; i++) {
      position[at * 3 + i] = sp[i]!;
      normal[at * 3 + i] = sn[i]!;
      color[at * 3 + i] = sc[i]!;
    }
    at += count;
    if (src !== p) src.dispose();
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position.subarray(0, at * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal.subarray(0, at * 3), 3));
  g.setAttribute("color", new THREE.BufferAttribute(color.subarray(0, at * 3), 3));
  return g;
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/** A soldier in the player's colours — blue helmet, pale uniform, rifle. The
 *  point is that he is recognisably ONE OF YOURS before you collect him. */
function recruitGeometry(): THREE.BufferGeometry {
  // Full soldier scale. The reference's rider is the same size as a unit in the
  // crowd — that is what makes "one of yours" readable before you collect him.
  const s = 1.0;
  return merge([
    at(tint(new THREE.BoxGeometry(0.34 * s, 0.46 * s, 0.24 * s), UNIFORM), 0, 0.05 * s, 0),
    at(tint(new THREE.SphereGeometry(0.15 * s, 10, 8), SKIN), 0, 0.36 * s, 0),
    at(tint(new THREE.SphereGeometry(0.17 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), HELMET), 0, 0.4 * s, 0),
    at(tint(new THREE.CylinderGeometry(0.19 * s, 0.19 * s, 0.05 * s, 10), HELMET), 0, 0.39 * s, 0),
    at(tint(new THREE.BoxGeometry(0.5 * s, 0.05 * s, 0.05 * s), BRASS), 0.1 * s, 0.12 * s, 0.14 * s),
  ]);
}

/** The reference's barrel-mounted minigun: a rotary barrel cluster on a blocky
 *  receiver, blue and brass. Reads as "more bullets" from its silhouette. */
function minigunGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    at(tint(new THREE.BoxGeometry(0.44, 0.39, 0.44), HELMET), 0, 0, 0.12),
    at(tint(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 12), BRASS), 0, 0, -0.06),
    at(tint(new THREE.BoxGeometry(0.21, 0.21, 0.26), GUNMETAL), 0, -0.16, 0.2),
  ];
  // Six barrels around the axis — the read that says "this one spins".
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = tint(new THREE.CylinderGeometry(0.042, 0.042, 0.6, 6), STEEL);
    b.rotateX(Math.PI / 2);
    parts.push(at(b, Math.cos(a) * 0.075, Math.sin(a) * 0.075, -0.3));
  }
  return merge(parts);
}

/** A shoulder tube with a fat warhead. Reads as "hits harder", not "shoots
 *  faster" — the silhouette has to carry which upgrade it is. */
function rocketGeometry(): THREE.BufferGeometry {
  const tube = tint(new THREE.CylinderGeometry(0.115, 0.115, 0.92, 10), GUNMETAL);
  tube.rotateX(Math.PI / 2);
  const head = tint(new THREE.ConeGeometry(0.18, 0.38, 10), WARHEAD);
  head.rotateX(-Math.PI / 2);
  const fin = tint(new THREE.BoxGeometry(0.04, 0.28, 0.2), STEEL);
  return merge([
    at(tube, 0, 0, 0),
    at(head, 0, 0, -0.48),
    at(tint(new THREE.BoxGeometry(0.18, 0.18, 0.2), BRASS), 0, -0.02, 0.18),
    at(fin.clone(), 0.1, 0, 0.3),
    at(fin, -0.1, 0, 0.3),
  ]);
}

/** Soft radial gold, drawn behind the pickup. This is the reference's rim glow
 *  approximated with one additive sprite instead of an outline pass. */
function glowTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Hollow-ish: dim in the middle so the object reads against it, brightest in
  // the ring just outside the silhouette. That is what makes it a RIM light
  // rather than a lamp the pickup is standing in front of.
  g.addColorStop(0, "rgba(255, 226, 130, 0.18)");
  g.addColorStop(0.45, "rgba(255, 205, 90, 0.42)");
  g.addColorStop(0.72, "rgba(255, 180, 50, 0.28)");
  g.addColorStop(1, "rgba(255, 170, 40, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
