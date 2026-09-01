/**
 * BOSSES — the punctuation a run was missing.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Mischa's diagnosis, and it was the right one: "the main shape is provided by
 * the red barriers getting bigger and bigger." A run was a flat sequence of
 * decisions of steadily rising stakes, with nothing that arrived, demanded
 * everything for ten seconds, and then left. Difficulty was a ramp with no
 * events on it.
 *
 * A boss is an EVENT. It holds a piece of the road, it cannot be shot down in
 * passing, and — this is the part that makes it a decision rather than a wall —
 * while it is alive the corridor keeps delivering prizes to the OTHER side of
 * the road (main.ts forces the side; see `side` below). Every second of fire
 * that goes into the boss is a second that does not go into a barrel worth
 * troops, and the boss's patience is finite. That is the trade the reference
 * puts on screen in `reference-media/clip1a/f_030.jpg`: a giant standing on the
 * left carriageway, two barrels worth 600 and 450 on the right, and one army
 * that can only point one way.
 *
 * ---------------------------------------------------------------------------
 * The three archetypes
 * ---------------------------------------------------------------------------
 * Each answers a different question, so which one arrives changes what a good
 * run looks like:
 *
 *   THE BRUTE   Slams half the road flat. Asks whether you can keep firing from
 *               the side it is not about to hit — a positioning question.
 *   THE ROLLER  Caged spiked drum that lunges down its own lane. Asks whether
 *               you invested in firepower, because the dodge costs you the whole
 *               far side of the road for two seconds.
 *   THE HIVE    Hatches walkers on a timer. Asks whether you can kill it FAST;
 *               everything you fail to do now arrives as bodies later.
 *
 * ---------------------------------------------------------------------------
 * Legibility rules, which are not decoration
 * ---------------------------------------------------------------------------
 * Every attack is telegraphed for `TELEGRAPH` seconds by three things at once: a
 * red zone painted on the deck where the hit will land, a label naming the
 * attack, and the boss's own wind-up animation. An attack a player cannot read
 * a second early is not difficulty, it is a coin toss — and a boss you dodge on
 * purpose is the thing that makes a clip.
 *
 * ---------------------------------------------------------------------------
 * What this module does NOT do
 * ---------------------------------------------------------------------------
 * It never touches `world.troops`. It reports that a strike landed on a stretch
 * of road and main.ts decides what that costs, exactly as a gate reports that it
 * was crossed. Same for the walkers a hive hatches: it asks, `main.ts` spawns
 * them through the enemy module, because two entity modules must not import each
 * other.
 */

import * as THREE from "three";
import type { System, WorldState } from "../core/types";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a boss stops closing and starts fighting.
 *
 * THIS IS A WEAPON RANGE, NOT A FRAMING CHOICE, and getting it wrong the first
 * time produced a boss that could barely be hurt until it charged. Rounds die
 * after `range` (22 m, mechanics/bullets.ts) measured from the soldier that
 * fired them, and soldiers fire from throughout the crowd's depth — the front
 * rank sits near z −4.6 and the back rank several metres behind that. A standoff
 * at −29 was outside the reach of every stream in the army: seven seconds of
 * sustained fire took 500 points off a 2800-point boss, and then it died in a
 * second and a half once it charged into range.
 *
 * At −23 the whole crowd can reach it with room for the rear ranks, which is
 * what makes the fight window a fight rather than a wait.
 */
const STANDOFF_Z = -23;
/** Metres/second it closes from its spawn point to the standoff. Fast, because
 *  the arrival should read as an arrival rather than as drift. */
const ENTER_SPEED = 13;

/**
 * Seconds a boss will hold the road before it gives up on attacking and charges.
 *
 * THIS IS THE FIGHT WINDOW, and it is the number that decides whether a boss is
 * an obstacle or a wall. At 6 m/s a run covers 54 m in this time, which is four
 * or five ordinary placements going past on the far side — enough road for the
 * greed to actually cost something.
 */
const PATIENCE = 9;

/** Wind-up. The reference's tell is about a second; anything under 0.8 s reads
 *  as unfair at this camera distance because the zone appears and lands inside
 *  one glance. */
const TELEGRAPH = 1.15;
/** The strike itself: club down, drum lunging, sac splitting. */
const STRIKE = 0.34;
/** Recovery, during which the boss is a stationary target and the player is
 *  meant to punish it. Generous on purpose. */
const RECOVER = 1.5;
/** Idle between attacks. */
const COOLDOWN = 1.9;

/** Metres/second of the final charge, once patience runs out. */
const CHARGE_SPEED = 11;
/** Where a charge connects with the front rank. The crowd sits at z −1.6 and
 *  reaches ~3 m in front of itself, so this is contact, not overlap. */
const REACH_Z = -6.5;
/** Seconds the wreck lies on the deck before it is cleared. */
const DEATH_TIME = 1.05;
/** Seconds a boss that broke through takes to walk off past the camera. */
const LEAVE_TIME = 1.2;

/**
 * The club arm's three angles, in radians about X.
 *
 * It rests SHOULDERED rather than hanging: a club long enough to read as a club
 * from behind the crowd is longer than the arm holding it, so straight down puts
 * the head through the deck. Carrying it is also the pose the reference's ogre
 * holds, and it means the raise is a change of angle the player can read rather
 * than the first frame the weapon is visible at all.
 */
const CLUB_REST = -0.95;
const CLUB_RAISED = -2.5;
const CLUB_SLAM = 0.35;

/** Seconds of white on the body after a hit lands. */
const HIT_FLASH = 0.07;

/** Half-width of the stretch a BRUTE flattens, as a share of the road. Just
 *  over half: standing anywhere in the near half is a hit, so the dodge is a
 *  real crossing rather than a nudge. */
const SLAM_SHARE = 0.56;
/** A roller's lunge is narrow — it is a lane, not a sweep. Metres. */
const ROLL_HALF = 2.7;
/** A charge is aimed at wherever the crowd was when it started, and it is wide,
 *  because "it gave up and came for you" has to be worth avoiding. */
const CHARGE_SHARE = 0.6;

/** How many walkers a hive coughs up per hatch. */
const HATCH_COUNT = 4;

/* Body dimensions, in metres. A road is 11.2 m wide; a boss covering ~40% of it
 * leaves a genuine dodge and still reads as enormous from behind the crowd. */
const BRUTE_HALF = 3.05;
const ROLLER_HALF = 3.2;
const HIVE_HALF = 2.8;
/** How much bigger each figure is drawn than it is authored. Authoring at a
 *  comfortable scale and then multiplying is what let all three be pushed up
 *  in one edit after the first screenshot came back reading "teddy bear". */
const BRUTE_SCALE = 1.3;
const ROLLER_SCALE = 1.26;
const HIVE_SCALE = 1.4;
/** Depth of the hit box. Bosses are shot at from directly behind, so this is
 *  mostly about how forgiving a grazing round is. */
const BODY_HALF_Z = 2.0;

/** Fake contact shadow, at the offset the scene's fixed key light throws — same
 *  construction as every other module's, and it has to move with this one or
 *  the boss reads as a sticker. */
const SHADOW_Y = 0.02;
const SHADOW_OFF_X = -0.5;
const SHADOW_OFF_Z = -0.7;
const SHADOW_OPACITY = 0.34;

/** Height of the name plate above the deck, and of the attack label under it. */
/** Plate heights, and they are a framing budget rather than a taste call: at the
 *  standoff distance the camera's top edge lands at about y 8.5, and the first
 *  pass put the name plate at 9.4 where it was simply not on screen. */
const PLATE_Y = 7.7;
const LABEL_Y = 6.4;
const PLATE_W = 4.6;
const PLATE_H = 1.15;

/** The camera never rotates (see core/renderer), so billboards share one fixed
 *  basis. Duplicated from the sibling entity modules on purpose: two of them
 *  must not import each other. */
const CAMERA_PITCH = Math.atan2(CAMERA_POS.y - CAMERA_LOOK.y, CAMERA_POS.z - CAMERA_LOOK.z);
const BILLBOARD = new THREE.Quaternion().setFromEuler(new THREE.Euler(-CAMERA_PITCH, 0, 0));

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export type BossKind = "brute" | "roller" | "hive";

/** Fired the moment a strike lands. `x`/`halfWidth` describe the stretch of road
 *  it covers; the orchestrator decides whether the crowd was standing in it and
 *  what that costs. */
export type BossStrike = (kind: BossKind, x: number, halfWidth: number) => void;
/** A hive asking for bodies. Lane is normalised [-1, 1], as the enemy module
 *  wants it. */
export type BossHatch = (lane: number, z: number, count: number) => void;
export type BossKilled = (kind: BossKind, x: number, z: number) => void;
/** The boss got past the crowd alive. Fired once, after its landing strike. */
export type BossEscaped = (kind: BossKind) => void;

export interface BossSystem extends System {
  /** True from spawn until the wreck (or the escapee) has cleared. */
  readonly active: boolean;
  /** True only while it can still be shot and can still hurt you. */
  readonly fighting: boolean;
  readonly kind: BossKind | null;
  readonly hp: number;
  readonly maxHp: number;
  /** Which kerb it is holding: −1 left, +1 right. main.ts pushes every other
   *  placement to the other one, which is the whole of the either/or. */
  readonly side: number;
  readonly x: number;
  readonly z: number;
  /** The stretch of road a strike is about to land on, while one is telegraphed.
   *  Exposed so the calibration autopilot can dodge it — a bot that walks into
   *  every slam measures a game nobody is playing. */
  readonly dangerActive: boolean;
  readonly dangerX: number;
  readonly dangerHalf: number;

  /** Put one on the road. Ignored if one is already active. */
  spawn(kind: BossKind, hp: number, side: number, z: number): void;
  /** Bullet test. Returns true if the round was stopped by the boss. */
  damageAt(x: number, z: number, pad: number, amount: number): boolean;

  onStrike(fn: BossStrike): void;
  onHatch(fn: BossHatch): void;
  onKilled(fn: BossKilled): void;
  onEscaped(fn: BossEscaped): void;

  clear(): void;
}

/* -------------------------------------------------------------------------- */

type Phase = "idle" | "enter" | "wait" | "wind" | "strike" | "recover" | "charge" | "dying" | "leaving";

interface Rig {
  group: THREE.Group;
  /** The static mass. */
  body: THREE.Mesh;
  /** The part that animates: club arm, spinning drum, hatch lid. */
  limb: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  limbMaterial: THREE.MeshLambertMaterial;
  halfWidth: number;
  shadowScale: number;
}

const _colFlash = new THREE.Color(0x000000);

export function createBoss(scene: THREE.Scene): BossSystem {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  const rigs: Record<BossKind, Rig> = {
    brute: buildBrute(),
    roller: buildRoller(),
    hive: buildHive(),
  };
  for (const k of Object.keys(rigs) as BossKind[]) {
    rigs[k].group.visible = false;
    root.add(rigs[k].group);
  }

  // Contact shadow. One quad, reused by whichever boss is up.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({
      color: 0x0d1a24,
      transparent: true,
      opacity: SHADOW_OPACITY,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = -1;
  shadow.visible = false;
  root.add(shadow);

  // The danger zone, painted on the deck. NORMAL blending, not additive: the
  // road is a 0.727 grey under a bright sky, and additive red on it comes out
  // pink and washed — the same trap documented in barrels.ts.
  const zone = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xff2b1e,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  zone.rotation.x = -Math.PI / 2;
  zone.position.y = 0.03;
  zone.renderOrder = -1;
  zone.visible = false;
  root.add(zone);

  // Name plates and attack labels, baked once. Repainting a canvas mid-fight
  // would be a texture upload inside update().
  const namePlates: Record<BossKind, THREE.Mesh> = {
    brute: plate(labelTexture("THE BRUTE", "#ffd447"), PLATE_W, PLATE_H),
    roller: plate(labelTexture("THE ROLLER", "#ffd447"), PLATE_W, PLATE_H),
    hive: plate(labelTexture("THE HIVE", "#ffd447"), PLATE_W, PLATE_H),
  };
  const attackPlates: Record<BossKind, THREE.Mesh> = {
    brute: plate(labelTexture("SLAM!", "#ff5a45"), PLATE_W * 0.78, PLATE_H * 0.92),
    roller: plate(labelTexture("CHARGING!", "#ff5a45"), PLATE_W * 0.78, PLATE_H * 0.92),
    hive: plate(labelTexture("HATCHING!", "#ff5a45"), PLATE_W * 0.78, PLATE_H * 0.92),
  };
  const breakPlate = plate(labelTexture("BREAKING THROUGH!", "#ff5a45"), PLATE_W * 1.05, PLATE_H * 0.92);
  for (const k of Object.keys(namePlates) as BossKind[]) {
    namePlates[k].visible = false;
    attackPlates[k].visible = false;
    root.add(namePlates[k]);
    root.add(attackPlates[k]);
  }
  breakPlate.visible = false;
  root.add(breakPlate);

  // ---- live state -------------------------------------------------------
  let kind: BossKind | null = null;
  let phase: Phase = "idle";
  let hp = 0;
  let maxHp = 1;
  let side = 1;
  let x = 0;
  let z = STANDOFF_Z;
  let timer = 0;
  let patience = 0;
  let flash = 0;
  let spin = 0;
  let lunge = 0;
  /** Where the pending strike will land. Latched at wind-up, so the zone the
   *  player reads is the zone that resolves — a boss that re-aims during its own
   *  telegraph makes the telegraph a lie. */
  let zoneX = 0;
  let zoneHalf = 1;
  let struckOnLanding = false;

  let onStrikeFn: BossStrike | null = null;
  let onHatchFn: BossHatch | null = null;
  let onKilledFn: BossKilled | null = null;
  let onEscapedFn: BossEscaped | null = null;

  function hideAll(): void {
    for (const k of Object.keys(rigs) as BossKind[]) rigs[k].group.visible = false;
    for (const k of Object.keys(namePlates) as BossKind[]) {
      namePlates[k].visible = false;
      attackPlates[k].visible = false;
    }
    breakPlate.visible = false;
    shadow.visible = false;
    zone.visible = false;
    root.visible = false;
  }

  function beginAttack(world: WorldState): void {
    phase = "wind";
    timer = TELEGRAPH;
    if (kind === "brute") {
      // Aimed at the half of the road the crowd is standing in RIGHT NOW, and
      // then committed to. Crossing the centreline is the answer.
      const half = Math.abs(zoneHalfForRoad(SLAM_SHARE));
      zoneHalf = half;
      zoneX = world.squadCenter.x >= 0 ? half - 0.4 : -(half - 0.4);
    } else if (kind === "roller") {
      zoneHalf = ROLL_HALF;
      zoneX = x;
    } else {
      // A hive does not strike; the zone is where its brood will land, which is
      // still worth painting because bodies appearing out of nowhere reads as a
      // glitch rather than as an attack.
      zoneHalf = 1.8;
      zoneX = x;
    }
  }

  function resolveStrike(): void {
    if (kind === "hive") {
      onHatchFn?.(clampLane(zoneX), z + 2.2, HATCH_COUNT);
    } else if (kind) {
      onStrikeFn?.(kind, zoneX, zoneHalf);
    }
  }

  function die(): void {
    phase = "dying";
    timer = DEATH_TIME;
    zone.visible = false;
    if (kind) onKilledFn?.(kind, x, z);
  }

  return {
    get active() {
      return phase !== "idle";
    },
    get fighting() {
      return phase !== "idle" && phase !== "dying" && phase !== "leaving";
    },
    get kind() {
      return kind;
    },
    get hp() {
      return hp;
    },
    get maxHp() {
      return maxHp;
    },
    get side() {
      return side;
    },
    get x() {
      return x;
    },
    get z() {
      return z;
    },
    get dangerActive() {
      return phase === "wind" || phase === "strike" || phase === "charge";
    },
    get dangerX() {
      return zoneX;
    },
    get dangerHalf() {
      return zoneHalf;
    },

    spawn(k, health, s, spawnZ) {
      if (phase !== "idle") return;
      kind = k;
      hp = health;
      maxHp = Math.max(1, health);
      side = s >= 0 ? 1 : -1;
      // Held against its own kerb, with its body fully on the road. The player
      // needs the other kerb to be genuinely clear or there is no dodge.
      x = side * (5.6 - rigs[k].halfWidth - 0.35);
      z = spawnZ;
      phase = "enter";
      timer = 0;
      patience = PATIENCE;
      flash = 0;
      spin = 0;
      lunge = 0;
      struckOnLanding = false;

      hideAll();
      root.visible = true;
      const r = rigs[k];
      r.group.visible = true;
      r.group.scale.setScalar(1);
      r.group.rotation.set(0, 0, 0);
      namePlates[k].visible = true;
      shadow.visible = true;
    },

    damageAt(px, pz, pad, amount) {
      if (!this.fighting || !kind) return false;
      const r = rigs[kind];
      if (Math.abs(px - x) > r.halfWidth + pad) return false;
      if (Math.abs(pz - (z + lunge)) > BODY_HALF_Z + pad) return false;
      hp -= amount;
      flash = HIT_FLASH;
      if (hp <= 0) {
        hp = 0;
        die();
      }
      return true;
    },

    onStrike(fn) {
      onStrikeFn = fn;
    },
    onHatch(fn) {
      onHatchFn = fn;
    },
    onKilled(fn) {
      onKilledFn = fn;
    },
    onEscaped(fn) {
      onEscapedFn = fn;
    },

    clear() {
      kind = null;
      phase = "idle";
      hp = 0;
      hideAll();
    },

    update(dt, world) {
      if (phase === "idle" || !kind) return;
      const r = rigs[kind];
      if (flash > 0) flash = Math.max(0, flash - dt);
      timer -= dt;

      switch (phase) {
        case "enter": {
          z = Math.min(STANDOFF_Z, z + ENTER_SPEED * dt);
          if (z >= STANDOFF_Z) {
            phase = "wait";
            timer = COOLDOWN * 0.6;
          }
          break;
        }

        case "wait": {
          patience -= dt;
          if (patience <= 0) {
            // Out of patience: it stops trying to hit you from range and comes
            // through the crowd. Aimed at where you are, and painted the whole
            // way in, so the last two seconds are a real dodge and not a death.
            phase = "charge";
            zoneHalf = zoneHalfForRoad(CHARGE_SHARE);
            zoneX = clampX(world.squadCenter.x, zoneHalf);
          } else if (timer <= 0) {
            beginAttack(world);
          }
          break;
        }

        case "wind": {
          patience -= dt;
          if (timer <= 0) {
            phase = "strike";
            timer = STRIKE;
            resolveStrike();
          }
          break;
        }

        case "strike": {
          patience -= dt;
          if (timer <= 0) {
            phase = "recover";
            timer = RECOVER;
          }
          break;
        }

        case "recover": {
          patience -= dt;
          if (timer <= 0) {
            phase = "wait";
            timer = COOLDOWN;
          }
          break;
        }

        case "charge": {
          z += CHARGE_SPEED * dt;
          // It tracks a little on the way in — enough that a lazy half-step
          // does not shake it, not enough to make the dodge impossible.
          zoneX += (clampX(world.squadCenter.x, zoneHalf) - zoneX) * Math.min(1, dt * 1.4);
          x += (zoneX - x) * Math.min(1, dt * 1.4);
          if (z >= REACH_Z && !struckOnLanding) {
            struckOnLanding = true;
            onStrikeFn?.(kind, zoneX, zoneHalf);
            onEscapedFn?.(kind);
            phase = "leaving";
            timer = LEAVE_TIME;
            zone.visible = false;
          }
          break;
        }

        case "leaving": {
          // Past the camera, still upright. It won.
          z += (CHARGE_SPEED + world.scrollSpeed) * dt;
          if (timer <= 0) this.clear();
          break;
        }

        case "dying": {
          // Toppled backwards onto the deck and sinking through it, rather than
          // faded out: a boss that dissolves reads as a despawn, and this is
          // supposed to be the loudest thing in the run.
          const t = 1 - Math.max(0, timer) / DEATH_TIME;
          r.group.rotation.x = -t * 1.35;
          r.group.position.y = -t * t * 2.4;
          r.group.scale.setScalar(1 - t * 0.18);
          z += world.scrollSpeed * dt * 0.35;
          if (timer <= 0) {
            r.group.position.y = 0;
            this.clear();
          }
          break;
        }
      }

      // Limb animation, driven off the phase clocks above so it is exactly in
      // step with what the attack is doing.
      if (kind === "roller") {
        // Always turning, faster during the lunge. A drum that stops rolling
        // stops reading as a drum.
        const rate = phase === "strike" || phase === "charge" ? 9 : 2.6;
        spin -= rate * dt;
        r.limb.rotation.x = spin;
      }
      if (phase === "strike") {
        const t = 1 - Math.max(0, timer) / STRIKE;
        lunge = kind === "roller" ? t * 2.6 : 0;
        if (kind === "brute") r.limb.rotation.x = CLUB_RAISED + t * (CLUB_SLAM - CLUB_RAISED);
        if (kind === "hive") r.limb.rotation.x = -t * 1.5;
      } else if (phase === "wind") {
        const t = 1 - Math.max(0, timer) / TELEGRAPH;
        if (kind === "brute") r.limb.rotation.x = CLUB_REST + t * (CLUB_RAISED - CLUB_REST);
        if (kind === "hive") r.limb.rotation.x = -t * 0.25;
        lunge = 0;
      } else if (phase === "recover") {
        const t = 1 - Math.max(0, timer) / RECOVER;
        lunge = kind === "roller" ? 2.6 * (1 - t) : 0;
        if (kind === "brute") r.limb.rotation.x = CLUB_SLAM + t * (CLUB_REST - CLUB_SLAM);
        if (kind === "hive") r.limb.rotation.x = -1.5 * (1 - t);
      } else {
        lunge = 0;
        if (kind === "brute") r.limb.rotation.x = CLUB_REST;
      }
    },

    render(_alpha, _world) {
      if (phase === "idle" || !kind) return;
      const r = rigs[kind];
      const zNow = z + lunge;
      r.group.position.set(x, r.group.position.y, zNow);

      // A hive breathes; the swell is the only cue that it is a living thing
      // rather than a rock, and it costs one sin().
      if (kind === "hive" && phase !== "dying") {
        const s = 1 + Math.sin(spin) * 0.02;
        r.group.scale.set(1, s, 1);
      }

      // Hit flash, on both materials so the whole silhouette reacts.
      //
      // WARM AND WEAK, and both of those are corrections. A boss under fire is
      // hit several times per frame, so the flash never decays — a white flash
      // at the strength a walker gets left the brute a featureless white blob
      // for the entire fight. An orange bias at a third the strength reads as
      // "glowing hot" under sustained fire and still pops on a single rocket.
      const f = flash > 0 ? (flash / HIT_FLASH) * 0.3 : 0;
      _colFlash.setRGB(f, f * 0.28, f * 0.1);
      r.material.emissive.copy(_colFlash);
      r.limbMaterial.emissive.copy(_colFlash);

      shadow.visible = phase !== "dying" && phase !== "leaving";
      if (shadow.visible) {
        shadow.position.set(x + SHADOW_OFF_X, SHADOW_Y, zNow + SHADOW_OFF_Z);
        shadow.scale.setScalar(r.shadowScale);
      }

      // Plates ride above the boss and always face the camera on the fixed
      // basis. The name is always up; the attack label only during the tell.
      const plateNode = namePlates[kind];
      plateNode.visible = phase !== "dying" && phase !== "leaving";
      plateNode.position.set(x, PLATE_Y, zNow);
      plateNode.quaternion.copy(BILLBOARD);

      const attackNode = attackPlates[kind];
      const telegraphing = phase === "wind" || phase === "strike";
      attackNode.visible = telegraphing;
      if (telegraphing) {
        attackNode.position.set(x, LABEL_Y, zNow);
        attackNode.quaternion.copy(BILLBOARD);
      }
      breakPlate.visible = phase === "charge";
      if (phase === "charge") {
        breakPlate.position.set(x, LABEL_Y, zNow);
        breakPlate.quaternion.copy(BILLBOARD);
      }

      // The danger zone. It reaches from the boss to well past the crowd, so
      // "am I standing in it" is answered by looking down, not by estimating.
      const showZone = phase === "wind" || phase === "strike" || phase === "charge";
      zone.visible = showZone;
      if (showZone) {
        const near = 6;
        const far = zNow - 2;
        zone.position.set(zoneX, 0.03, (near + far) / 2);
        zone.scale.set(zoneHalf * 2, Math.max(2, near - far), 1);
        // Pulses during the tell and goes solid on the strike — the change in
        // rhythm is the "now" cue.
        const pulse = phase === "wind" ? 0.16 + 0.16 * (0.5 + 0.5 * Math.sin(timer * 26)) : 0.42;
        zone.material.opacity = pulse;
      }
    },

    dispose() {
      for (const k of Object.keys(rigs) as BossKind[]) {
        const r = rigs[k];
        r.body.geometry.dispose();
        r.limb.geometry.dispose();
        r.material.dispose();
        r.limbMaterial.dispose();
      }
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      zone.geometry.dispose();
      (zone.material as THREE.Material).dispose();
      for (const k of Object.keys(namePlates) as BossKind[]) {
        disposePlate(namePlates[k]);
        disposePlate(attackPlates[k]);
      }
      disposePlate(breakPlate);
      scene.remove(root);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Half-width in metres of a zone covering `share` of the road. The corridor's
 *  own constant is not imported: mechanics/lane.ts is not an entity module's
 *  dependency, and this is the one number that would create the edge. */
const ROAD_HALF = 5.6;
function zoneHalfForRoad(share: number): number {
  return ROAD_HALF * share;
}
function clampX(v: number, half: number): number {
  const lim = Math.max(0, ROAD_HALF - half * 0.55);
  return v < -lim ? -lim : v > lim ? lim : v;
}
function clampLane(v: number): number {
  const l = v / ROAD_HALF;
  return l < -1 ? -1 : l > 1 ? 1 : l;
}

function plate(tex: THREE.CanvasTexture, w: number, h: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    // depthTest OFF, which is unusual in this project and deliberate here: a
    // plate is a label, not an object. The bridge's own towers were cutting
    // "THE BRUTE" in half whenever a boss stood behind one, and a name you can
    // only read on some stretches of road is worse than none.
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  mesh.renderOrder = 12;
  return mesh;
}

function disposePlate(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
}

/**
 * Heavy outlined text on a dark rounded plate — the same treatment the gates and
 * the prize plates use, because a boss's name has to read as part of the same
 * game and not as a different game's HUD.
 */
function labelTexture(text: string, accent: string): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;

  const r = 26;
  ctx.beginPath();
  ctx.moveTo(12 + r, 10);
  ctx.arcTo(w - 12, 10, w - 12, h - 10, r);
  ctx.arcTo(w - 12, h - 10, 12, h - 10, r);
  ctx.arcTo(12, h - 10, 12, 10, r);
  ctx.arcTo(12, 10, w - 12, 10, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(12, 8, 12, 0.86)";
  ctx.fill();

  let size = 72;
  const font = (px: number): string =>
    `900 ${px}px "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.font = font(size);
  while (ctx.measureText(text).width > w - 60 && size > 22) {
    size -= 3;
    ctx.font = font(size);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(8, size * 0.22);
  ctx.strokeStyle = "#0a0508";
  ctx.strokeText(text, w / 2, h / 2 + 2);
  ctx.fillStyle = accent;
  ctx.fillText(text, w / 2, h / 2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                     */
/* -------------------------------------------------------------------------- */

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/** Same hand-rolled merge the other entity modules use: position/normal/colour
 *  concatenation with a top-lit bias, so one draw call carries a whole figure. */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) {
    const idx = p.geo.getIndex();
    total += idx ? idx.count : p.geo.attributes["position"]!.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let out = 0;
  const c = new THREE.Color();
  for (const p of parts) {
    const pos = p.geo.attributes["position"] as THREE.BufferAttribute;
    const nrm = p.geo.attributes["normal"] as THREE.BufferAttribute;
    const idx = p.geo.getIndex();
    const count = idx ? idx.count : pos.count;
    c.set(p.color);
    for (let i = 0; i < count; i++) {
      const v = idx ? idx.getX(i) : i;
      position[out * 3] = pos.getX(v);
      position[out * 3 + 1] = pos.getY(v);
      position[out * 3 + 2] = pos.getZ(v);
      const nx = nrm.getX(v);
      const ny = nrm.getY(v);
      const nz = nrm.getZ(v);
      normal[out * 3] = nx;
      normal[out * 3 + 1] = ny;
      normal[out * 3 + 2] = nz;
      // Same top-lit bias the other figures use, PLUS a front bias, and the
      // front one is specific to this module. The scene's key light is
      // up-screen-left at (−4, 10, −6) — deliberately behind the subject, so
      // that fake contact shadows fall toward the camera where they can be seen
      // (see core/renderer.ts). Everything on the road is small enough that the
      // hemisphere fill carries its camera-facing side. A boss is not: it is
      // six metres of flat frontage pointed straight at the lens, and lit only
      // by fill it reads as a silhouette in a hole. This puts the missing bounce
      // back into the vertex colours, where it costs nothing.
      const k = 0.78 + 0.22 * Math.max(0, ny) + 0.2 * Math.max(0, nz);
      color[out * 3] = c.r * k;
      color[out * 3 + 1] = c.g * k;
      color[out * 3 + 2] = c.b * k;
      out++;
    }
    p.geo.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
  return geo;
}

function at(geo: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

function lambert(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/**
 * `scale` is baked into the geometry rather than applied to the group, because
 * the group's scale is already spoken for by the hive's breathing and the death
 * shrink. `halfWidth` is the FINAL world half-width, after scaling — it is what
 * the hit test and the kerb placement run on, so it must describe the thing that
 * is actually on the road rather than what was authored.
 */
function rigFrom(
  bodyParts: Part[],
  limbParts: Part[],
  pivot: THREE.Vector3,
  halfWidth: number,
  shadowScale: number,
  scale = 1,
): Rig {
  const material = lambert();
  const limbMaterial = lambert();
  const bodyGeo = mergeParts(bodyParts);
  const limbGeo = mergeParts(limbParts);
  bodyGeo.scale(scale, scale, scale);
  limbGeo.scale(scale, scale, scale);
  const body = new THREE.Mesh(bodyGeo, material);
  const limb = new THREE.Mesh(limbGeo, limbMaterial);
  limb.position.copy(pivot).multiplyScalar(scale);
  const group = new THREE.Group();
  group.add(body);
  group.add(limb);
  return { group, body, limb, material, limbMaterial, halfWidth, shadowScale };
}

/* Colours. Deliberately outside the player's cream-and-blue and outside the
 * enemy walkers' flat red, so a boss reads as its own faction at forty pixels. */
const FLESH = 0xe8a184;
const FLESH_DARK = 0xc07a60;
const LEATHER = 0x6b4230;
const IRON = 0x8d97a4;
const IRON_DARK = 0x5c646f;
const RUST = 0xb5432c;
const BONE = 0xf0e2c8;
const CHITIN = 0x7b3f6e;
const CHITIN_LIGHT = 0xa85c95;
const ACID = 0x9ede3a;
const HAZARD = 0xf2c327;

/**
 * THE BRUTE — the reference's ogre, in boxes.
 *
 * Proportions are cartoon on purpose: the head is small, the shoulders are
 * enormous, and the club is nearly as long as the body is tall. At the distance
 * this is read from, the silhouette is the whole character, and a realistic
 * ogre is a lump.
 */
function buildBrute(): Rig {
  const body: Part[] = [
    // Legs, planted wide.
    { geo: at(new THREE.BoxGeometry(1.0, 2.2, 1.05), -0.9, 1.1, 0), color: FLESH_DARK },
    { geo: at(new THREE.BoxGeometry(1.0, 2.2, 1.05), 0.9, 1.1, 0), color: FLESH_DARK },
    // Belt and loincloth. The dark band across the middle is what stops the
    // whole figure reading as one continuous pink lump.
    { geo: at(new THREE.BoxGeometry(3.1, 0.55, 1.4), 0, 2.25, 0), color: LEATHER },
    { geo: at(new THREE.BoxGeometry(1.5, 1.1, 0.3), 0, 1.7, 0.62), color: LEATHER },
    // Gut and chest — one wide slab, so the mass reads from the front.
    { geo: at(new THREE.SphereGeometry(1.35, 14, 10), 0, 2.95, 0.2), color: FLESH },
    { geo: at(new THREE.BoxGeometry(3.5, 1.5, 1.5), 0, 3.65, 0), color: FLESH },
    // Shoulders.
    { geo: at(new THREE.SphereGeometry(0.85, 12, 8), -1.85, 4.15, 0), color: FLESH },
    { geo: at(new THREE.SphereGeometry(0.85, 12, 8), 1.85, 4.15, 0), color: FLESH },
    // Free arm, hanging.
    { geo: at(new THREE.CylinderGeometry(0.42, 0.5, 2.1, 10), -1.95, 3.1, 0.1), color: FLESH },
    { geo: at(new THREE.SphereGeometry(0.55, 10, 8), -1.95, 2.1, 0.1), color: FLESH },
    // Studded bracer on the free arm.
    { geo: at(new THREE.CylinderGeometry(0.56, 0.56, 0.45, 10), -1.95, 2.55, 0.1), color: IRON_DARK },
    // Head: small, low, jammed between the shoulders.
    { geo: at(new THREE.BoxGeometry(1.25, 1.0, 1.15), 0, 4.6, 0.05), color: FLESH },
    // Jaw and two tusks — the only detail that makes it a face at this size.
    //
    // ON +Z, WHICH IS THE SIDE THE PLAYER IS ON. The camera sits at z +9.5 and
    // looks down the corridor, so a face authored at −z is a face pointed at the
    // horizon: the first pass put every detail on all three of these figures on
    // the far side, and they came back as blank lumps.
    { geo: at(new THREE.BoxGeometry(1.2, 0.4, 0.5), 0, 4.22, 0.5), color: FLESH_DARK },
    { geo: at(new THREE.ConeGeometry(0.19, 0.6, 6), -0.34, 4.5, 0.66), color: BONE },
    { geo: at(new THREE.ConeGeometry(0.19, 0.6, 6), 0.34, 4.5, 0.66), color: BONE },
    // Eyes, big and pale so there is something to read at forty pixels.
    { geo: at(new THREE.SphereGeometry(0.23, 8, 6), -0.3, 4.82, 0.56), color: 0xfff2d8 },
    { geo: at(new THREE.SphereGeometry(0.23, 8, 6), 0.3, 4.82, 0.56), color: 0xfff2d8 },
    { geo: at(new THREE.SphereGeometry(0.11, 8, 6), -0.3, 4.82, 0.74), color: 0x2a1418 },
    { geo: at(new THREE.SphereGeometry(0.11, 8, 6), 0.3, 4.82, 0.74), color: 0x2a1418 },
    // Heavy brow. One box, and it is most of what makes the face angry rather
    // than surprised.
    { geo: at(new THREE.BoxGeometry(1.3, 0.26, 0.34), 0, 5.06, 0.52), color: FLESH_DARK },
  ];

  // The club arm, pivoting at the right shoulder. Geometry is authored relative
  // to that pivot so the rotation in update() is a plain angle.
  const limb: Part[] = [
    { geo: at(new THREE.CylinderGeometry(0.42, 0.46, 2.2, 10), 0, -0.9, 0.35), color: FLESH },
    { geo: at(new THREE.SphereGeometry(0.55, 10, 8), 0, -1.95, 0.5), color: FLESH },
    { geo: at(new THREE.CylinderGeometry(0.6, 0.6, 0.45, 10), 0, -1.5, 0.45), color: IRON_DARK },
    // The club itself: long, red, and unmistakably a weapon.
    { geo: at(new THREE.CylinderGeometry(0.24, 0.32, 3.1, 10), 0, -3.4, 0.6), color: LEATHER },
    { geo: at(new THREE.BoxGeometry(1.5, 1.9, 1.5), 0, -5.1, 0.6), color: RUST },
    { geo: at(new THREE.ConeGeometry(0.34, 0.72, 6), -0.9, -5.1, 0.6), color: IRON },
    { geo: at(new THREE.ConeGeometry(0.34, 0.72, 6), 0.9, -5.1, 0.6), color: IRON },
    { geo: at(new THREE.ConeGeometry(0.34, 0.72, 6), 0, -5.1, -0.2), color: IRON },
  ];
  // The spikes on the club head point outward, which a cone built along +Y does
  // not do on its own.
  limb[5]!.geo.rotateZ(Math.PI / 2);
  limb[6]!.geo.rotateZ(-Math.PI / 2);
  limb[7]!.geo.rotateX(-Math.PI / 2);

  return rigFrom(body, limb, new THREE.Vector3(2.15, 4.15, 0), BRUTE_HALF, 2.9, BRUTE_SCALE);
}

/**
 * THE ROLLER — a spiked drum in a rolling cage.
 *
 * The cage is what makes it a machine rather than a boulder, and it is also
 * what stays still while the drum spins, so the rotation is legible. A boulder
 * spinning in place at this distance just shimmers.
 */
function buildRoller(): Rig {
  // NO CAGE. The first version had the drum inside a heavy frame, and from
  // behind the crowd the frame and the drum merged into one dark rectangle —
  // "a crate with spikes on it". The drum IS the character, so everything else
  // is either behind it or gone.
  const body: Part[] = [
    // Tow arms, raked back and away from the camera so they never cross the
    // drum's silhouette.
    { geo: at(new THREE.BoxGeometry(0.4, 0.4, 3.0), -2.5, 3.6, -1.6), color: IRON_DARK },
    { geo: at(new THREE.BoxGeometry(0.4, 0.4, 3.0), 2.5, 3.6, -1.6), color: IRON_DARK },
    { geo: at(new THREE.BoxGeometry(5.4, 0.45, 0.6), 0, 4.6, -2.9), color: IRON_DARK },
    // Exhaust stacks behind the drum, belching nothing, purely for silhouette.
    { geo: at(new THREE.CylinderGeometry(0.22, 0.3, 1.8, 8), -1.5, 5.2, -2.9), color: IRON_DARK },
    { geo: at(new THREE.CylinderGeometry(0.22, 0.3, 1.8, 8), 1.5, 5.2, -2.9), color: IRON_DARK },
  ];

  // The drum. Built along Y then laid on its side, so a rotation about X rolls
  // it the way the road is moving.
  const drum = new THREE.CylinderGeometry(2.25, 2.25, 4.4, 20);
  drum.rotateZ(Math.PI / 2);
  const limb: Part[] = [{ geo: drum, color: RUST }];
  // Hazard bands. Two rings of a slightly larger radius, which at this distance
  // read as painted stripes and are what makes the roll visible at all — a
  // plain cylinder turning about its own axis looks stationary.
  for (const bx of [-1.15, 1.15]) {
    const band = new THREE.CylinderGeometry(2.3, 2.3, 0.7, 20);
    band.rotateZ(Math.PI / 2);
    limb.push({ geo: at(band, bx, 0, 0), color: HAZARD });
  }
  // Hubs, with a bright boss in the middle of each.
  for (const bx of [-2.25, 2.25]) {
    const hub = new THREE.CylinderGeometry(2.35, 2.35, 0.24, 20);
    hub.rotateZ(Math.PI / 2);
    limb.push({ geo: at(hub, bx, 0, 0), color: IRON_DARK });
    const cap = new THREE.CylinderGeometry(0.7, 0.7, 0.36, 12);
    cap.rotateZ(Math.PI / 2);
    limb.push({ geo: at(cap, bx * 1.06, 0, 0), color: HAZARD });
  }
  // Spikes: three rings of eight, big enough to be individually visible. Built
  // pointing +Y and rotated onto the drum's surface.
  for (let ring = 0; ring < 3; ring++) {
    const bx = -1.75 + ring * 1.75;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + ring * 0.26;
      const spike = new THREE.ConeGeometry(0.42, 1.35, 6);
      spike.translate(0, 2.75, 0);
      spike.rotateX(a);
      spike.translate(bx, 0, 0);
      limb.push({ geo: spike, color: BONE });
    }
  }

  // Pivot height is the spike tip, not the drum surface: a drum whose skin
  // touched the road would have a metre of spike buried under it. Riding on the
  // points is also the only pose in which the roll is unambiguous.
  return rigFrom(body, limb, new THREE.Vector3(0, 3.4, 0), ROLLER_HALF, 3.0, ROLLER_SCALE);
}

/**
 * THE HIVE — a fat chitinous sac on stubby legs, with a lid that opens.
 *
 * Purple and acid-green, which is the one colour pair in this game not already
 * spoken for: the player is cream and blue, the walkers are red, the prizes are
 * gold. A hive should not be mistakable for any of them for even a frame.
 */
function buildHive(): Rig {
  const body: Part[] = [
    // Legs — six stubs, which is what makes it read as vermin.
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.1, 8), -1.5, 0.55, -0.8), color: CHITIN },
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.1, 8), 1.5, 0.55, -0.8), color: CHITIN },
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.3, 8), -1.75, 0.65, 0.2), color: CHITIN },
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.3, 8), 1.75, 0.65, 0.2), color: CHITIN },
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.1, 8), -1.2, 0.55, 1.1), color: CHITIN },
    { geo: at(new THREE.CylinderGeometry(0.2, 0.28, 1.1, 8), 1.2, 0.55, 1.1), color: CHITIN },
    // The sac.
    { geo: at(new THREE.SphereGeometry(2.0, 16, 12), 0, 2.5, 0), color: CHITIN_LIGHT },
    // Ribbed plates over the back, so the sphere is not just a sphere.
    { geo: at(new THREE.TorusGeometry(1.75, 0.16, 6, 18), 0, 2.6, 0), color: CHITIN },
    { geo: at(new THREE.TorusGeometry(1.5, 0.14, 6, 18), 0, 3.35, 0), color: CHITIN },
    // The maw, on the FRONT and always visible. It was on top and tucked inside
    // the sac, where the lid opening revealed something the camera could not see
    // anyway — from behind the crowd you are looking at this thing's face, so
    // the face is where the acid has to be.
    { geo: at(new THREE.SphereGeometry(1.3, 14, 10), 0, 2.6, 1.35), color: ACID },
    { geo: at(new THREE.TorusGeometry(1.05, 0.28, 6, 14), 0, 2.6, 1.75), color: CHITIN },
    // Teeth around it. Three is enough at this distance and reads as a mouth.
    { geo: at(new THREE.ConeGeometry(0.26, 0.8, 6), -0.55, 3.3, 2.35), color: BONE },
    { geo: at(new THREE.ConeGeometry(0.26, 0.8, 6), 0.55, 3.3, 2.35), color: BONE },
    { geo: at(new THREE.ConeGeometry(0.26, 0.8, 6), 0, 1.85, 2.35), color: BONE },
    // Eye cluster, high and wide so it is not mistaken for the mouth.
    { geo: at(new THREE.SphereGeometry(0.45, 10, 8), -1.15, 3.9, 1.1), color: 0xffe14a },
    { geo: at(new THREE.SphereGeometry(0.45, 10, 8), 1.15, 3.9, 1.1), color: 0xffe14a },
    { geo: at(new THREE.SphereGeometry(0.22, 8, 6), -1.15, 3.9, 1.44), color: 0x1b1020 },
    { geo: at(new THREE.SphereGeometry(0.22, 8, 6), 1.15, 3.9, 1.44), color: 0x1b1020 },
  ];
  body[7]!.geo.rotateX(Math.PI / 2);
  body[8]!.geo.rotateX(Math.PI / 2);
  body[10]!.geo.rotateX(Math.PI / 2);
  // The two upper teeth hang down into the maw; the lower one points up. Cones
  // are built along +Y, so only the upper pair gets flipped.
  body[11]!.geo.rotateX(Math.PI);
  body[12]!.geo.rotateX(Math.PI);

  // The lid, hinged at the back of the sac.
  // The lid, hinged at the BACK of the sac so that opening it swings the cover
  // up and away from the maw the player is looking at.
  const limb: Part[] = [
    { geo: at(new THREE.SphereGeometry(1.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0, 1.0), color: CHITIN },
    { geo: at(new THREE.ConeGeometry(0.26, 0.85, 6), -0.55, 0.45, 1.1), color: BONE },
    { geo: at(new THREE.ConeGeometry(0.26, 0.85, 6), 0.55, 0.45, 1.1), color: BONE },
  ];

  return rigFrom(body, limb, new THREE.Vector3(0, 3.6, -0.7), HIVE_HALF, 2.8, HIVE_SCALE);
}
