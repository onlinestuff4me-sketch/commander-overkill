/**
 * THE ALLY — a caged war robot you shoot free, who then fights for you.
 *
 * ---------------------------------------------------------------------------
 * What it is for
 * ---------------------------------------------------------------------------
 * Every upgrade in this game so far is a NUMBER: more troops, more gunners, a
 * higher multiplier. Numbers are the right currency for a runner, but they all
 * look the same from the outside, and Mischa's standing note about the reference
 * is that its upgrades are things you can SEE. Last War's Drone is the model
 * (docs/progression-research.md): you unlock it once, and from then on there is
 * an extra unit on the screen fighting beside you.
 *
 * So: a cage on the road, guarded like any other prize. Shoot the cage apart and
 * a robot three times a soldier's height walks out, takes station on the crowd's
 * flank, and pours rockets down the corridor for the rest of the level. It is
 * the only upgrade in the game you can point at.
 *
 * ---------------------------------------------------------------------------
 * How it fights, and why it does NOT own a weapon
 * ---------------------------------------------------------------------------
 * The robot has no bullet code. It reports a MUZZLE, and `main.ts` hands that
 * muzzle to the bullet system as a bank of extra streams (`ALLY_STREAMS`), all
 * firing rockets. That is the whole integration, and it is deliberate: an
 * element module that grew its own projectiles would need to know about barrels,
 * enemies, bosses and gate panels to resolve them, and knowing about those is
 * exactly what the module contract forbids.
 *
 * A bank of streams rather than one, because one stream is one soldier and this
 * thing has to read as a heavy weapons platform. Ten is set by what it should be
 * worth: a rocket stream is about twice a rifleman, so the robot is roughly
 * twenty men — which doubles a small army and adds a tenth to a large one. That
 * curve is the right way round. The ally is a lifeline when you are struggling
 * and a bonus when you are not, rather than a win button that scales with the
 * win you were already having.
 *
 * ---------------------------------------------------------------------------
 * The other half of the job
 * ---------------------------------------------------------------------------
 * It also STEPS IN FRONT. `guard()` lets the orchestrator hand it a breach that
 * would otherwise cost troops, on a cooldown. That is the half the player feels
 * rather than reads, and it is why the robot walks at the crowd's leading flank
 * instead of behind it.
 *
 * ---------------------------------------------------------------------------
 * Lifetime
 * ---------------------------------------------------------------------------
 * The robot lasts the LEVEL, like the crowd does. It is cleared by `clear()` on
 * a run reset, which keeps the game's one promise about levels intact: you start
 * the next one from scratch with your permanent upgrades and nothing else.
 */

import * as THREE from "three";
import type { System } from "../core/types";
import { toyMaterial } from "../core/look";
import { CORRIDOR_HALF_WIDTH } from "../mechanics/lane";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many bullet streams the robot is worth. See the header — this is the
 * number that decides whether the ally is a lifeline or a win button.
 */
export const ALLY_STREAMS = 10;

/** Whole-robot scale. A soldier is ~1.4 m; this puts the robot at about 3.6 m,
 *  which is between an ogre and a boss — big enough to be an event, small enough
 *  that it never hides the road behind it. */
const ROBOT_SCALE = 1.3;
const ROBOT_HEIGHT = 3.1;

/**
 * Where the robot stands relative to the crowd.
 *
 * AHEAD AND OUTBOARD. Ahead because it has to be the thing that meets a breach
 * first, and because a unit standing among the soldiers is a unit you cannot
 * see. Outboard because the crowd's own width grows without limit and anything
 * parked at a fixed offset from the centre eventually stands inside it — the
 * offset is added to the crowd's half-width at the call site.
 */
/**
 * MEASURED, NOT CHOSEN. At 3.4 the robot stood level with the front rank of a
 * 179-troop crowd and was photographed with its legs, arms and half its torso
 * behind soldiers — a three-metre ally rendered as a head. The crowd's own depth
 * grows with its size, so the station has to clear the deepest crowd the game
 * expects to see, not the one it was tested against.
 */
const STATION_AHEAD = 5.0;
const STATION_CLEAR = 1.5;
/**
 * CEILING ON HOW FAR OUTBOARD IT WILL STAND, in metres from the crowd's centre.
 *
 * Without it the station is `halfWidth + STATION_CLEAR`, which is correct for a
 * small army and wrong for a large one: measured at 140 troops the robot sat at
 * x −4.89 on a road whose half-width is 5.6, and the camera only pans by 78% of
 * the crowd's own offset — so it stood at the frame edge with half of itself cut
 * off. An ally you cannot see is not an ally.
 *
 * 3.0 keeps it inside the frame at every army size. Past about 90 troops that
 * means it overlaps the crowd's outer bodies, which is fine — it is two and a
 * half times their height and stands a metre in front of them, so it reads over
 * the top of them rather than being lost in them.
 */
const STATION_MAX_OUT = 3.0;
/** How fast it takes up station, in 1/seconds. Slower than the crowd steers, so
 *  it visibly lumbers after a hard turn rather than sliding along with it. */
const STATION_FOLLOW = 3.4;

/** Muzzle height and how far forward of the body the guns sit. */
const MUZZLE_Y = 2.05;
const MUZZLE_Z = -0.75;

/** Stride rate and how far the legs swing. Slow and long: a big thing moves at a
 *  lower frequency than a small one, and getting that wrong is most of why a
 *  scaled-up model reads as a toy rather than as something heavy. */
const STEP_RATE = 3.4;
const STEP_SWING = 0.34;
const STEP_BOB = 0.07;

/** Seconds between breaches the robot will absorb. Long enough that it cannot
 *  tank a whole horde, short enough to catch the one that would have hurt. */
const GUARD_COOLDOWN = 5.5;
/** How long the guard pose holds — arms up, planted. Purely visual. */
const GUARD_POSE = 0.5;

/* --- the cage ------------------------------------------------------------- */

/** Cage footprint. Wide enough to be a target worth shooting, narrow enough to
 *  leave a lane past it — it is a prize, not a wall. */
const CAGE_HALF_WIDTH = 1.15;
const CAGE_HALF_Z = 0.95;
const CAGE_HEIGHT = 2.5;
/** Seconds the cage spends bursting open before the robot is on its feet. */
const OPEN_TIME = 0.55;
/** How far past the camera a cage survives before it is written off. */
const DESPAWN_Z = 12;

const HIT_FLASH = 0.09;

/* --- palette -------------------------------------------------------------- */

/**
 * IT HAS TO READ AS OURS AT A GLANCE.
 *
 * The enemy palette in this game is tan, brown and red; the player's is blue
 * helmet, cream and navy. A grey robot would be neither, and a player who cannot
 * tell in a quarter of a second whether the huge thing on the road is friendly
 * has been given a worse game, not a better one. So the chassis is our navy, the
 * plating our cream, and the visor and shoulders are the crowd's own helmet
 * blue — the robot is literally painted in the army's uniform.
 */
const ROBOT_CHASSIS = 0x2f52a8;
const ROBOT_PLATE = 0xdfd7c4;
const ROBOT_TRIM = 0x62b0ea;
const ROBOT_STEEL = 0x8f9bb0;
const ROBOT_DARK = 0x39414f;
const VISOR = 0xffd447;

const CAGE_BAR = 0x9aa6ba;
const CAGE_FRAME = 0xc8442f;

/* -------------------------------------------------------------------------- */

export type AllyFreed = (x: number, z: number) => void;

export interface AllySystem extends System {
  readonly object: THREE.Group;
  /** True once the robot is out and fighting. */
  readonly active: boolean;
  /** True while a cage is on the road waiting to be opened. */
  readonly caged: boolean;
  /** Muzzle position, valid only while `active`. Read by the orchestrator and
   *  handed straight to the bullet system as extra streams. */
  readonly muzzleX: number;
  readonly muzzleY: number;
  readonly muzzleZ: number;

  /**
   * Put a cage on the road. `hp` is priced by the orchestrator against what the
   * guns can actually deliver — this module has no idea what a hit point is
   * worth, and pricing it here would duplicate `mechanics/pacing.ts`.
   *
   * Ignored if a cage is already up or the robot is already out: one ally.
   */
  spawnCage(x: number, z: number, hp: number): boolean;

  /** Damage the cage. Returns true if the round hit it (and should be consumed).
   *  Opening the cage is what frees the robot. */
  damageAt(x: number, z: number, pad: number, amount: number): boolean;

  /**
   * Ask the robot to take a hit that would otherwise cost troops. Returns true
   * if it did, which is the orchestrator's signal to skip the payment.
   */
  guard(): boolean;

  onFreed(fn: AllyFreed): void;
  /** Cage health for a HUD or a numeral, 0..1. 0 when there is no cage. */
  readonly cageFraction: number;
  clear(): void;
}

/* -------------------------------------------------------------------------- */

export function createAlly(scene: THREE.Scene): AllySystem {
  const object = new THREE.Group();
  scene.add(object);

  /* ---- the cage ------------------------------------------------------- */

  const cage = new THREE.Group();
  cage.visible = false;
  object.add(cage);

  /* ---- the robot ------------------------------------------------------ */

  const robot = new THREE.Group();
  robot.visible = false;
  robot.scale.setScalar(ROBOT_SCALE);
  object.add(robot);

  const rig = buildRobot(robot);
  const cageMats = buildCage(cage);

  /* ---- state ---------------------------------------------------------- */

  let cageUp = false;
  let cageX = 0;
  let cageZ = 0;
  let cagePrevZ = 0;
  let cageHp = 0;
  let cageMaxHp = 1;
  let cageFlash = 0;

  let out = false;
  /** Seconds left of the burst-out animation. The robot is on screen and not
   *  yet shooting during this — the muzzle is only reported once it is up. */
  let opening = 0;

  let x = 0;
  let z = 0;
  let prevX = 0;
  let prevZ = 0;
  let gait = 0;
  let guardLeft = 0;
  let guardPose = 0;
  /** Which side of the crowd it stands on. Set at the moment it is freed, from
   *  which side of the road the cage was on — so the thing appears where the
   *  player was already looking. */
  let side = 1;

  let freedFn: AllyFreed | null = null;

  const _e = new THREE.Euler();

  function free(): void {
    cageUp = false;
    cage.visible = false;
    out = true;
    opening = OPEN_TIME;
    robot.visible = true;
    x = cageX;
    z = cageZ;
    prevX = x;
    prevZ = z;
    side = cageX >= 0 ? 1 : -1;
    guardLeft = 0;
    freedFn?.(cageX, cageZ);
  }

  return {
    object,

    get active() {
      return out && opening <= 0;
    },
    get caged() {
      return cageUp;
    },
    get muzzleX() {
      return x;
    },
    get muzzleY() {
      return MUZZLE_Y * ROBOT_SCALE;
    },
    get muzzleZ() {
      return z + MUZZLE_Z * ROBOT_SCALE;
    },
    get cageFraction() {
      return cageUp ? Math.max(0, cageHp / cageMaxHp) : 0;
    },

    spawnCage(cx, cz, hp) {
      if (cageUp || out) return false;
      cageUp = true;
      cageX = cx;
      cageZ = cz;
      cagePrevZ = cz;
      cageHp = hp;
      cageMaxHp = Math.max(1, hp);
      cageFlash = 0;
      cage.visible = true;
      cage.position.set(cx, 0, cz);
      return true;
    },

    damageAt(px, pz, pad, amount) {
      if (!cageUp) return false;
      if (Math.abs(px - cageX) > CAGE_HALF_WIDTH + pad) return false;
      if (Math.abs(pz - cageZ) > CAGE_HALF_Z + pad) return false;
      cageHp -= amount;
      cageFlash = HIT_FLASH;
      if (cageHp <= 0) free();
      return true;
    },

    guard() {
      if (!out || opening > 0 || guardLeft > 0) return false;
      guardLeft = GUARD_COOLDOWN;
      guardPose = GUARD_POSE;
      return true;
    },

    onFreed(fn) {
      freedFn = fn;
    },

    clear() {
      cageUp = false;
      cage.visible = false;
      out = false;
      opening = 0;
      robot.visible = false;
      guardLeft = 0;
      guardPose = 0;
    },

    update(dt, world) {
      if (cageUp) {
        if (cageFlash > 0) cageFlash -= dt;
        cagePrevZ = cageZ;
        // The cage is furniture on the road, so it rides the scroll exactly as a
        // barrel does. Nothing else moves it.
        cageZ += world.scrollSpeed * dt;
        if (cageZ > DESPAWN_Z) {
          cageUp = false;
          cage.visible = false;
        }
      }

      if (!out) return;
      if (opening > 0) {
        opening = Math.max(0, opening - dt);
        // It rides the scroll while it stands up, or it appears to slide up the
        // road away from the crowd it is supposed to be joining.
        prevZ = z;
        z += world.scrollSpeed * dt;
        return;
      }

      if (guardLeft > 0) guardLeft = Math.max(0, guardLeft - dt);
      if (guardPose > 0) guardPose = Math.max(0, guardPose - dt);

      // STATION IS DERIVED FROM THE CROWD'S LIVE WIDTH, not from a fixed offset.
      // A 500-strong army is eight metres across, and a robot parked 1.5 m from
      // its centre would be standing inside it.
      const clear = Math.min(STATION_MAX_OUT, world.squadHalfWidth + STATION_CLEAR);
      const wantX = clampX(world.squadCenter.x + side * clear);
      const wantZ = world.squadCenter.z - STATION_AHEAD;
      prevX = x;
      prevZ = z;
      const k = Math.min(1, STATION_FOLLOW * dt);
      x += (wantX - x) * k;
      z += (wantZ - z) * k;

      gait += dt * STEP_RATE;
    },

    render(alpha, _world) {
      if (cageUp) {
        const cz = cagePrevZ + (cageZ - cagePrevZ) * alpha;
        cage.position.set(cageX, 0, cz);
        // The cage's meshes SHARE two materials, so the flash is two writes
        // rather than one per bar. Multiplied against the base colour rather
        // than written over it — the frame is red and the bars are pale, and a
        // flash that flattened both to white would lose the cage's identity at
        // the exact moment the player is looking hardest at it.
        const f = cageFlash > 0 ? 1 + (cageFlash / HIT_FLASH) * 1.5 : 1;
        for (const c of cageMats) c.mat.color.setRGB(c.r * f, c.g * f, c.b * f);
      }
      if (!out) return;

      const rx = prevX + (x - prevX) * alpha;
      const rz = prevZ + (z - prevZ) * alpha;

      // THE BURST-OUT. It rises out of the deck rather than fading in, because a
      // three-metre robot appearing from nothing is a pop and this is supposed
      // to be the biggest moment on the road.
      const rise = opening > 0 ? -(opening / OPEN_TIME) * ROBOT_HEIGHT * ROBOT_SCALE : 0;
      const bob = opening > 0 ? 0 : Math.abs(Math.sin(gait)) * STEP_BOB;
      robot.position.set(rx, rise + bob, rz);

      // A guard pose plants it and squares it up; otherwise it leans a few
      // degrees into whichever way it is walking, which is the only thing
      // stopping a box on legs reading as a box on legs.
      const leanTarget = guardPose > 0 ? 0 : (rx - prevX) * 6;
      _e.set(0, 0, -clamp(leanTarget, -0.12, 0.12));
      robot.quaternion.setFromEuler(_e);

      const swing = opening > 0 ? 0 : Math.cos(gait) * STEP_SWING;
      _e.set(swing, 0, 0);
      rig.legL.quaternion.setFromEuler(_e);
      _e.set(-swing, 0, 0);
      rig.legR.quaternion.setFromEuler(_e);

      // ARMS FORWARD WHEN FIRING, UP WHEN GUARDING. The firing pose is the
      // default because the robot is firing almost all of the time it is alive,
      // and the arm geometry is already BUILT pointing down −Z — so the rest
      // pose is zero rotation. The first version rotated the shoulders by −1.35
      // rad on top of that, as though the arms were hanging, and photographed
      // with both cannons pointing at the deck.
      const raise = guardPose > 0 ? 1 - Math.abs(guardPose / GUARD_POSE - 0.5) * 2 : 0;
      _e.set(-raise * 0.85, 0, 0);
      rig.armL.quaternion.setFromEuler(_e);
      rig.armR.quaternion.setFromEuler(_e);

      // The visor pulses while it is firing. One channel of animation on the one
      // part of the model that is allowed to be a light source.
      const glow = 0.75 + 0.25 * Math.sin(gait * 2.1);
      rig.visorMat.color.setRGB(glow, glow * 0.85, glow * 0.25);
    },

    dispose() {
      scene.remove(object);
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) for (const m of mat) m.dispose();
        else mat?.dispose();
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  visorMat: THREE.MeshBasicMaterial;
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toyMaterial({ color }));
}

function tube(r: number, h: number, color: number, seg = 9): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), toyMaterial({ color }));
}

/**
 * The robot, in parts, with the joints as empty Groups so `render` can pose it
 * without touching geometry.
 *
 * EVERY DETAIL IS ON +Z. The camera and the player are on the positive side, and
 * this project has shipped a boss whose face was authored away from the camera
 * once already — the visor, the chest plate and the shoulder blazons all live on
 * the side that is actually seen.
 */
function buildRobot(root: THREE.Group): Rig {
  // Legs. Hip groups so the swing is a rotation about the hip rather than a
  // translation of the whole limb.
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  legL.position.set(-0.34, 1.15, 0);
  legR.position.set(0.34, 1.15, 0);
  for (const [g, sign] of [
    [legL, -1],
    [legR, 1],
  ] as const) {
    const thigh = box(0.34, 0.72, 0.36, ROBOT_CHASSIS);
    thigh.position.y = -0.36;
    g.add(thigh);
    const shin = box(0.3, 0.55, 0.32, ROBOT_DARK);
    shin.position.y = -0.98;
    g.add(shin);
    const foot = box(0.42, 0.18, 0.6, ROBOT_STEEL);
    foot.position.set(sign * 0.02, -1.32, 0.08);
    g.add(foot);
    root.add(g);
  }

  // Torso: a heavy block with a cream chest plate over it, so the silhouette has
  // a light panel where the eye lands.
  const torso = box(1.0, 0.95, 0.62, ROBOT_CHASSIS);
  torso.position.y = 1.68;
  root.add(torso);

  const chest = box(0.66, 0.6, 0.14, ROBOT_PLATE);
  chest.position.set(0, 1.74, 0.34);
  root.add(chest);

  // Waist joint, so the torso does not sit straight on the hips.
  const waist = tube(0.26, 0.24, ROBOT_DARK);
  waist.position.y = 1.16;
  root.add(waist);

  // Shoulders — the blue trim that makes it ours.
  for (const sx of [-1, 1]) {
    const pad = box(0.42, 0.36, 0.5, ROBOT_TRIM);
    pad.position.set(sx * 0.66, 2.0, 0);
    root.add(pad);
  }

  // Head and visor. The visor is BASIC, not phong: it is the one part of this
  // model that is emitting rather than reflecting, and a lit material would put
  // a specular highlight on a light source, which reads as plastic.
  const head = box(0.44, 0.4, 0.42, ROBOT_DARK);
  head.position.y = 2.4;
  root.add(head);

  const visorMat = new THREE.MeshBasicMaterial({ color: VISOR, toneMapped: false });
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.06), visorMat);
  visor.position.set(0, 2.42, 0.22);
  root.add(visor);

  // Arm cannons. Shoulder groups again, and the muzzles point down −Z when the
  // arms are levelled, which is where the bullets go.
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  armL.position.set(-0.66, 1.94, 0);
  armR.position.set(0.66, 1.94, 0);
  for (const g of [armL, armR]) {
    const upper = box(0.28, 0.3, 0.5, ROBOT_DARK);
    upper.position.z = -0.2;
    g.add(upper);
    const barrel = tube(0.14, 0.72, ROBOT_STEEL);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.62;
    g.add(barrel);
    const brake = tube(0.19, 0.16, ROBOT_TRIM);
    brake.rotation.x = Math.PI / 2;
    brake.position.z = -0.98;
    g.add(brake);
    root.add(g);
  }

  return { legL, legR, armL, armR, visorMat };
}

/**
 * The cage: a red frame with pale bars and a dark shape hunched inside it.
 *
 * The shape inside is the whole reason this reads as a rescue rather than as
 * another barrel. It is one dark box with two yellow eyes — nothing more is
 * legible through bars at this distance — and it is what tells the player there
 * is something in there before they have shot anything.
 */
interface CageMat {
  mat: THREE.MeshPhongMaterial;
  r: number;
  g: number;
  b: number;
}

function buildCage(root: THREE.Group): CageMat[] {
  const frameMat = toyMaterial({ color: CAGE_FRAME });
  const barMat = toyMaterial({ color: CAGE_BAR });

  // Base and cap.
  for (const y of [0.09, CAGE_HEIGHT - 0.09]) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(CAGE_HALF_WIDTH * 2 + 0.16, 0.18, CAGE_HALF_Z * 2 + 0.16),
      frameMat,
    );
    slab.position.y = y;
    root.add(slab);
  }
  // Corner posts.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.17, CAGE_HEIGHT, 0.17),
        frameMat,
      );
      post.position.set(sx * CAGE_HALF_WIDTH, CAGE_HEIGHT / 2, sz * CAGE_HALF_Z);
      root.add(post);
    }
  }
  // Bars on the +Z face only. The back and sides are never seen from this
  // camera, and a full cage of bars is four times the triangles for nothing.
  const bars = 6;
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars;
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.052, CAGE_HEIGHT - 0.3, 6),
      barMat,
    );
    bar.position.set(
      -CAGE_HALF_WIDTH + t * CAGE_HALF_WIDTH * 2,
      CAGE_HEIGHT / 2,
      CAGE_HALF_Z,
    );
    root.add(bar);
  }

  // The occupant.
  const shape = new THREE.Mesh(
    new THREE.BoxGeometry(1.25, 1.5, 0.9),
    toyMaterial({ color: ROBOT_DARK }),
  );
  shape.position.set(0, 1.0, 0);
  root.add(shape);

  const eyeMat = new THREE.MeshBasicMaterial({ color: VISOR, toneMapped: false });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.06), eyeMat);
    eye.position.set(sx * 0.24, 1.42, 0.46);
    root.add(eye);
  }

  return [frameMat, barMat].map((mat) => ({
    mat,
    r: mat.color.r,
    g: mat.color.g,
    b: mat.color.b,
  }));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Keeps the robot on the deck. It stands outboard of a crowd that is allowed to
 *  overhang the kerb, so without this it walks over the water. */
function clampX(v: number): number {
  const edge = CORRIDOR_HALF_WIDTH - 0.7;
  return clamp(v, -edge, edge);
}
