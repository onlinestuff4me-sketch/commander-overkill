/**
 * ENEMIES — the opposition: walker packs, gold elites, and the biker.
 *
 * The reference's whole enemy read is silhouette plus rim. Walkers are small,
 * brown, numerous and interchangeable; elites are the same figure lit by a
 * thick GOLD outline that no player unit ever wears. That outline is the entire
 * threat language of the game, so it is not a subtle shader effect — it is an
 * inverted-hull shell in unlit gold, sized to survive being 40px tall on a
 * phone.
 *
 * ---------------------------------------------------------------------------
 * API — what the rest of the game touches
 * ---------------------------------------------------------------------------
 *
 *   const enemies = createEnemies(scene);
 *
 *   // A cluster of walkers that shares one red HP bar. `lane` is normalised
 *   // [-1, 1]; the pack's HP is count * hpEach and walkers drop off the back
 *   // as it takes damage, so the crowd size IS the health bar.
 *   enemies.spawnPack(0.3, -46, 8, 12);
 *
 *   // A barrel rider. `mounted` picks the motorcycle variant.
 *   const rider = enemies.spawnElite(-0.6, -40, 30, false);
 *
 *   // BULLETS TEAM: same shape as the barrel system. Returns hp remaining,
 *   // 0 when the shot killed it, -1 when nothing was there.
 *   const left = enemies.damageAt(x, z, 0.35, damage);
 *
 *   // ORCHESTRATOR: hold a rider on its barrel every tick, then let go.
 *   enemies.pin(rider, barrelX, barrelTopY, barrelZ);
 *   enemies.unpin(rider);   // he drops to the road and joins the advance
 *
 * Enemies own their own motion: they ride the corridor scroll (world.scrollSpeed)
 * AND walk toward the player on top of it. Nothing outside translates them.
 *
 * ---------------------------------------------------------------------------
 * Rendering shape
 * ---------------------------------------------------------------------------
 * 7 draw calls total, whatever the enemy count: walkers, elite bodies, elite
 * shells, biker bodies, biker shells, HP bar backs, HP bar fills. Every one is
 * an InstancedMesh sized at boot; nothing is allocated after that.
 */

import * as THREE from "three";
import type { System } from "../core/types";
import { laneToX } from "../mechanics/lane";
import { CAMERA_LOOK, CAMERA_POS } from "../core/renderer";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Hard ceiling on walkers alive at once. Sizes the walker InstancedMesh. */
export const MAX_WALKERS = 240;
/** Packs + elites share one slot table. */
const MAX_UNITS = 40;
/** Walkers a single pack can hold; beyond this, spawn a second pack. */
const MAX_PACK_SIZE = 16;

/** Metres/second a walker advances on top of the corridor scroll. */
const WALKER_SPEED = 1.6;
/** Elites hold their ground more; they are cover, not a rush. */
const ELITE_SPEED = 0.9;
const BIKER_SPEED = 2.6;

/** Walker figure height. Deliberately under the player's ~1.65m — they read as
 *  rabble, and the size gap is what makes an elite feel like an elite. */
const WALKER_HEIGHT = 1.12;
const ELITE_SCALE = 1.24;

/** Inverted-hull outline thickness, in metres of normal displacement. */
const RIM_THICKNESS = 0.055;
/** The elite signature. Nothing the player owns is ever this colour. */
const RIM_GOLD = 0xffc72c;

/** Past the camera — anything here is behind the player. */
const DESPAWN_Z = 13;
/** Gravity for a rider knocked off a destroyed barrel. */
const DROP_GRAVITY = 22;

/** HP bar geometry, in metres. Small: the reference bars are a glance, not a UI. */
const BAR_W = 1.0;
const BAR_H = 0.15;
const BAR_INSET = 0.035;
const BAR_Y = 1.55;
const MAX_BARS = MAX_UNITS;

/** Seconds an enemy stays white-hot after being hit. */
const HIT_FLASH = 0.09;

/**
 * Fake contact shadow. No shadow maps in this project by design, but the
 * reference seats every figure on the road with one and a crowd without them
 * hovers. Offset matches the scene's key light at (4, 10, 6).
 * REMOVE THIS BLOCK if a shared ground-shadow system lands.
 */
const SHADOW_Y = 0.012;
const SHADOW_OFF_X = -0.16;
const SHADOW_OFF_Z = -0.22;
const SHADOW_OPACITY = 0.3;
const WALKER_SHADOW = 0.62;
const ELITE_SHADOW = 0.85;
const BIKER_SHADOW = 1.5;

/**
 * The camera never rotates (see core/renderer), so every billboard shares one
 * fixed pitch instead of a per-frame lookAt. Duplicated from barrels.ts on
 * purpose: two sibling entity modules should not import each other.
 */
const CAMERA_PITCH = Math.atan2(CAMERA_POS.y - CAMERA_LOOK.y, CAMERA_POS.z - CAMERA_LOOK.z);
const BILLBOARD = new THREE.Quaternion().setFromEuler(new THREE.Euler(-CAMERA_PITCH, 0, 0));

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export type EnemyKind = "pack" | "elite" | "biker";

/** Fired when a unit's hp hits zero. Primitives only — this runs inside update(). */
export type EnemyKilled = (id: number, kind: EnemyKind, x: number, z: number) => void;
/** Fired when a unit reaches the squad line. `hp` is what it still had left. */
export type EnemyBreached = (id: number, kind: EnemyKind, hp: number) => void;

export interface EnemySystem extends System {
  /** Group holding every enemy mesh. Already added to the scene. */
  readonly object: THREE.Group;
  /** Live units (packs and elites), for spawn pacing. */
  readonly liveCount: number;

  /**
   * A clustered pack of walkers sharing one HP bar. Total hp is
   * `count * hpEach`; walkers are removed as that pool drains, so the visible
   * crowd always matches the bar. Returns a unit id, or -1 if full.
   */
  spawnPack(lane: number, z: number, count: number, hpEach: number): number;

  /**
   * A single gold rim-lit elite. `mounted` swaps the figure for the motorcycle
   * variant. Returns a unit id, or -1 if full.
   */
  spawnElite(lane: number, z: number, hp: number, mounted: boolean): number;

  /**
   * Hold an elite at a world position. Call once per tick from `update()` (not
   * from `render()` — it keeps a one-tick position history for interpolation).
   * A pinned unit does not advance and ignores gravity.
   */
  pin(id: number, x: number, y: number, z: number): void;
  /** Release a pinned elite. It falls to the road and starts advancing. */
  unpin(id: number): void;

  isAlive(id: number): boolean;
  /** Current hit points, or -1 for a dead/invalid id. */
  hpOf(id: number): number;

  /** Nearest live unit within `pad` metres of (x, z). -1 if none. */
  hitTest(x: number, z: number, pad: number): number;
  /** Damage a unit. Returns hp remaining (0 = killed), or -1 if not live. */
  damage(id: number, amount: number): number;
  /** hitTest + damage in one. Returns hp remaining, or -1 if nothing was hit. */
  damageAt(x: number, z: number, pad: number, amount: number): number;

  onKilled(fn: EnemyKilled): void;
  onBreached(fn: EnemyBreached): void;

  /** Despawn everything. For a run restart. */
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Internal slots — pre-allocated at boot, never grown                         */
/* -------------------------------------------------------------------------- */

interface Unit {
  alive: boolean;
  kind: EnemyKind;
  x: number;
  y: number;
  z: number;
  prevZ: number;
  vy: number;
  hp: number;
  maxHp: number;
  /** Walkers this pack started with; drives how many die per hp lost. */
  size: number;
  /** Walkers still standing. Kept in step so damage() never has to count them. */
  crowdAlive: number;
  pinned: boolean;
  bar: number;
  flash: number;
  /** Per-unit gait offset so a crowd never steps in unison. */
  phase: number;
  breached: boolean;
}

interface Walker {
  /** Owning unit id, or -1 when free. */
  unit: number;
  ox: number;
  oz: number;
  phase: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const _ZERO = new THREE.Vector3(0, -999, 0);
const _NOSCALE = new THREE.Vector3(0, 0, 0);

/* -------------------------------------------------------------------------- */

export function createEnemies(scene: THREE.Scene): EnemySystem {
  const object = new THREE.Group();
  object.name = "enemies";
  scene.add(object);

  /* ---- geometry ------------------------------------------------------- */

  const walkerGeo = buildWalker();
  const eliteGeo = buildElite();
  const bikerGeo = buildBiker();

  const walkerMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const eliteMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const rimMat = new THREE.MeshBasicMaterial({
    color: RIM_GOLD,
    // The shell is the *inside* of a slightly fattened copy of the figure, so
    // only the parts that stick out past the real mesh are visible. Front faces
    // culled, depth written, no lighting — a flat gold halo at any angle.
    side: THREE.BackSide,
  });

  const walkers = new THREE.InstancedMesh(walkerGeo, walkerMat, MAX_WALKERS);
  walkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  walkers.frustumCulled = false;
  object.add(walkers);

  const MAX_ELITES = 20;
  const eliteRimGeo = buildElite(RIM_THICKNESS);
  const bikerRimGeo = buildBiker(RIM_THICKNESS);

  const eliteShells = new THREE.InstancedMesh(eliteRimGeo, rimMat, MAX_ELITES);
  const eliteBodies = new THREE.InstancedMesh(eliteGeo, eliteMat, MAX_ELITES);
  const bikerShells = new THREE.InstancedMesh(bikerRimGeo, rimMat, MAX_ELITES);
  const bikerBodies = new THREE.InstancedMesh(bikerGeo, eliteMat, MAX_ELITES);
  for (const mesh of [eliteShells, eliteBodies, bikerShells, bikerBodies]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    object.add(mesh);
  }
  // Shells draw first so the body's depth writes win where they overlap; this
  // keeps the gold strictly outside the silhouette instead of bleeding in.
  eliteShells.renderOrder = -1;
  bikerShells.renderOrder = -1;

  /* ---- contact shadows ------------------------------------------------ */

  // One pool for everything on the ground: walkers occupy [0, MAX_WALKERS) and
  // elites the tail, so an index is derivable and needs no cursor.
  const SHADOW_CAPACITY = MAX_WALKERS + MAX_ELITES * 2;
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowTex = makeShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    color: 0x000000,
    opacity: SHADOW_OPACITY,
  });
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, SHADOW_CAPACITY);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  shadows.renderOrder = 1;
  object.add(shadows);

  /* ---- HP bars -------------------------------------------------------- */

  const barBackGeo = new THREE.PlaneGeometry(BAR_W, BAR_H);
  // Left-anchored so scaling X drains the bar from the right, like a real bar.
  const barFillGeo = new THREE.PlaneGeometry(1, BAR_H - BAR_INSET * 2);
  barFillGeo.translate(0.5, 0, 0);

  const barBackMat = new THREE.MeshBasicMaterial({ color: 0x14141a, depthWrite: false });
  const barFillMat = new THREE.MeshBasicMaterial({ color: 0xe23a2e, depthWrite: false });
  const barBacks = new THREE.InstancedMesh(barBackGeo, barBackMat, MAX_BARS);
  const barFills = new THREE.InstancedMesh(barFillGeo, barFillMat, MAX_BARS);
  for (const mesh of [barBacks, barFills]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    object.add(mesh);
  }
  // Neither bar layer writes depth, so depth cannot break the tie between them
  // — explicit render order is the only thing keeping the fill on top of its
  // own backing plate. Do not collapse these to one value.
  barBacks.renderOrder = 5;
  barFills.renderOrder = 6;

  /* ---- slots ---------------------------------------------------------- */

  const units: Unit[] = [];
  for (let i = 0; i < MAX_UNITS; i++) {
    units.push({
      alive: false,
      kind: "pack",
      x: 0,
      y: 0,
      z: 0,
      prevZ: 0,
      vy: 0,
      hp: 0,
      maxHp: 1,
      size: 0,
      crowdAlive: 0,
      pinned: false,
      bar: -1,
      flash: 0,
      phase: 0,
      breached: false,
    });
  }

  const crowd: Walker[] = [];
  for (let i = 0; i < MAX_WALKERS; i++) crowd.push({ unit: -1, ox: 0, oz: 0, phase: 0 });

  /** Elite instance slot per unit id, so a unit keeps its instance while alive. */
  const eliteSlotOf = new Int16Array(MAX_UNITS).fill(-1);
  const eliteFree: number[] = [];
  const bikerFree: number[] = [];
  for (let i = MAX_ELITES - 1; i >= 0; i--) {
    eliteFree.push(i);
    bikerFree.push(i);
  }

  const killedListeners: EnemyKilled[] = [];
  const breachedListeners: EnemyBreached[] = [];
  let clock = 0;
  let live = 0;
  let disposed = false;

  function hideInstances(mesh: THREE.InstancedMesh, count: number): void {
    _m.compose(_ZERO, _q.identity(), _NOSCALE);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _m);
    mesh.instanceMatrix.needsUpdate = true;
  }
  hideInstances(walkers, MAX_WALKERS);
  hideInstances(eliteShells, MAX_ELITES);
  hideInstances(eliteBodies, MAX_ELITES);
  hideInstances(bikerShells, MAX_ELITES);
  hideInstances(bikerBodies, MAX_ELITES);
  hideInstances(barBacks, MAX_BARS);
  hideInstances(barFills, MAX_BARS);
  hideInstances(shadows, SHADOW_CAPACITY);
  for (let i = 0; i < MAX_WALKERS; i++) walkers.setColorAt(i, _col.setRGB(1, 1, 1));
  for (let i = 0; i < MAX_ELITES; i++) {
    eliteBodies.setColorAt(i, _col.setRGB(1, 1, 1));
    bikerBodies.setColorAt(i, _col.setRGB(1, 1, 1));
  }

  /* ---- helpers -------------------------------------------------------- */

  function freeUnitSlot(): number {
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (u && !u.alive) return i;
    }
    return -1;
  }

  function releaseWalkers(unitId: number, keep: number): void {
    // Walk backwards so the pack sheds its stragglers first — the crowd shrinks
    // from the edges inward, which reads as casualties rather than a resize.
    let found = 0;
    for (let i = MAX_WALKERS - 1; i >= 0; i--) {
      const w = crowd[i];
      if (!w || w.unit !== unitId) continue;
      found++;
      if (found > keep) w.unit = -1;
    }
  }

  function retire(id: number, u: Unit, killed: boolean): void {
    u.alive = false;
    u.bar = -1;
    live--;
    if (u.kind === "pack") {
      releaseWalkers(id, 0);
      u.crowdAlive = 0;
    } else {
      const slot = eliteSlotOf[id] ?? -1;
      if (slot >= 0) (u.kind === "biker" ? bikerFree : eliteFree).push(slot);
      eliteSlotOf[id] = -1;
    }
    if (killed) for (const fn of killedListeners) fn(id, u.kind, u.x, u.z);
  }

  /* ---- system --------------------------------------------------------- */

  const system: EnemySystem = {
    object,
    get liveCount() {
      return live;
    },

    spawnPack(lane, z, count, hpEach) {
      const id = freeUnitSlot();
      const u = units[id];
      if (!u) return -1;

      const n = Math.max(1, Math.min(MAX_PACK_SIZE, Math.floor(count)));
      let placed = 0;
      for (let i = 0; i < MAX_WALKERS && placed < n; i++) {
        const w = crowd[i];
        if (!w || w.unit >= 0) continue;
        w.unit = id;
        // Ellipse wider than deep, matching the reference's loose road-blocking
        // clusters. Squared radius keeps the middle denser than the rim.
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random());
        w.ox = Math.cos(a) * r * 0.95;
        w.oz = Math.sin(a) * r * 0.6;
        w.phase = Math.random() * Math.PI * 2;
        placed++;
      }
      if (placed === 0) return -1;

      u.alive = true;
      u.kind = "pack";
      u.x = laneToX(lane);
      u.y = 0;
      u.z = z;
      u.prevZ = z;
      u.vy = 0;
      u.hp = placed * hpEach;
      u.maxHp = u.hp;
      u.size = placed;
      u.crowdAlive = placed;
      u.pinned = false;
      u.flash = 0;
      u.breached = false;
      u.phase = Math.random() * Math.PI * 2;
      u.bar = id;
      live++;
      return id;
    },

    spawnElite(lane, z, hp, mounted) {
      const id = freeUnitSlot();
      const u = units[id];
      if (!u) return -1;
      const pool = mounted ? bikerFree : eliteFree;
      const slot = pool.pop();
      if (slot === undefined) return -1;

      eliteSlotOf[id] = slot;
      u.alive = true;
      u.kind = mounted ? "biker" : "elite";
      u.x = laneToX(lane);
      u.y = 0;
      u.z = z;
      u.prevZ = z;
      u.vy = 0;
      u.hp = hp;
      u.maxHp = hp;
      u.size = 1;
      u.crowdAlive = 0;
      u.pinned = false;
      u.flash = 0;
      u.breached = false;
      u.phase = Math.random() * Math.PI * 2;
      // Elites carry no bar of their own until hurt — on a barrel, the barrel's
      // numeral is already the health readout the player is watching.
      u.bar = -1;
      live++;
      return id;
    },

    pin(id, x, y, z) {
      const u = units[id];
      if (!u || !u.alive) return;
      // Keep last tick's z as the interpolation source, exactly like a free
      // unit does. Without this the rider steps at the 60Hz sim rate while the
      // barrel under it interpolates, and on a 120Hz screen it visibly slides
      // around on the lid. Call this once per tick from update(), not render().
      u.prevZ = u.pinned ? u.z : z;
      u.pinned = true;
      u.x = x;
      u.y = y;
      u.z = z;
      u.vy = 0;
    },

    unpin(id) {
      const u = units[id];
      if (!u || !u.alive || !u.pinned) return;
      u.pinned = false;
      // A small upward kick before the fall: being blown off cover should look
      // like being blown off, not like the barrel was deleted.
      u.vy = 2.4;
    },

    isAlive(id) {
      const u = units[id];
      return u !== undefined && u.alive;
    },

    hpOf(id) {
      const u = units[id];
      return u && u.alive ? u.hp : -1;
    },

    hitTest(x, z, pad) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < MAX_UNITS; i++) {
        const u = units[i];
        if (!u || !u.alive) continue;
        // Packs present a wide body; a single elite is a narrow one.
        const rx = (u.kind === "pack" ? 1.05 : 0.34) + pad;
        const rz = (u.kind === "pack" ? 0.7 : 0.34) + pad;
        const dx = x - u.x;
        const dz = z - u.z;
        if (dx > rx || dx < -rx || dz > rz || dz < -rz) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },

    damage(id, amount) {
      const u = units[id];
      if (!u || !u.alive) return -1;
      u.hp -= amount;
      u.flash = HIT_FLASH;

      if (u.hp <= 0) {
        u.hp = 0;
        retire(id, u, true);
        return 0;
      }

      if (u.kind === "pack") {
        // The crowd IS the health bar: thin it to match the remaining fraction.
        // Under a tier-2 firehose this runs hundreds of times a frame, so the
        // early-out on crowdAlive is what keeps it off the profile.
        const want = Math.max(1, Math.ceil((u.hp / u.maxHp) * u.size));
        if (want < u.crowdAlive) {
          releaseWalkers(id, want);
          u.crowdAlive = want;
        }
      } else if (u.bar < 0) {
        u.bar = id;
      }
      return u.hp;
    },

    damageAt(x, z, pad, amount) {
      const id = system.hitTest(x, z, pad);
      if (id < 0) return -1;
      return system.damage(id, amount);
    },

    onKilled(fn) {
      killedListeners.push(fn);
    },

    onBreached(fn) {
      breachedListeners.push(fn);
    },

    clear() {
      for (let i = 0; i < MAX_UNITS; i++) {
        const u = units[i];
        if (u && u.alive) retire(i, u, false);
      }
      for (let i = 0; i < MAX_WALKERS; i++) {
        const w = crowd[i];
        if (w) w.unit = -1;
      }
      live = 0;
    },

    update(dt, world) {
      clock += dt;
      const breachZ = world.squadCenter.z - 0.7;

      for (let i = 0; i < MAX_UNITS; i++) {
        const u = units[i];
        if (!u || !u.alive) continue;

        if (u.flash > 0) u.flash -= dt;

        if (u.pinned) {
          // Position is driven from outside every tick; nothing to integrate.
          continue;
        }

        const speed =
          u.kind === "pack" ? WALKER_SPEED : u.kind === "biker" ? BIKER_SPEED : ELITE_SPEED;
        u.prevZ = u.z;
        u.z += (world.scrollSpeed + speed) * dt;

        if (u.y > 0 || u.vy !== 0) {
          u.vy -= DROP_GRAVITY * dt;
          u.y += u.vy * dt;
          if (u.y <= 0) {
            u.y = 0;
            u.vy = 0;
          }
        }

        if (!u.breached && u.z > breachZ) {
          u.breached = true;
          for (const fn of breachedListeners) fn(i, u.kind, u.hp);
        }
        if (u.z > DESPAWN_Z) retire(i, u, false);
      }
    },

    render(alpha, _world) {
      /* walkers */
      for (let i = 0; i < MAX_WALKERS; i++) {
        const w = crowd[i];
        const u = w && w.unit >= 0 ? units[w.unit] : undefined;
        if (!w || !u || !u.alive) {
          _m.compose(_ZERO, _q.identity(), _NOSCALE);
          walkers.setMatrixAt(i, _m);
          shadows.setMatrixAt(i, _m);
          continue;
        }
        const z = u.prevZ + (u.z - u.prevZ) * alpha + w.oz;
        const t = clock * 9 + w.phase;
        // Run-in-place bob plus a counter-rotating sway. Cheap, and it is what
        // stops 200 identical instances reading as furniture.
        const bob = Math.abs(Math.sin(t)) * 0.075;
        _pos.set(u.x + w.ox, u.y + bob, z);
        _e.set(0.09, 0, Math.sin(t) * 0.09);
        _q.setFromEuler(_e);
        _scl.set(1, 1, 1);
        _m.compose(_pos, _q, _scl);
        walkers.setMatrixAt(i, _m);
        const hot = u.flash > 0 ? 1 + (u.flash / HIT_FLASH) * 1.6 : 1;
        walkers.setColorAt(i, _col.setRGB(hot, hot, hot));

        // Shadow stays on the ground and does not inherit the bob — a shadow
        // that bounces with the walker is worse than no shadow at all.
        _pos.set(u.x + w.ox + SHADOW_OFF_X, SHADOW_Y, z + SHADOW_OFF_Z);
        _scl.set(WALKER_SHADOW, 1, WALKER_SHADOW);
        _m.compose(_pos, _q.identity(), _scl);
        shadows.setMatrixAt(i, _m);
      }
      walkers.instanceMatrix.needsUpdate = true;
      if (walkers.instanceColor) walkers.instanceColor.needsUpdate = true;

      /* elites and bikers */
      hideInstances(eliteShells, MAX_ELITES);
      hideInstances(eliteBodies, MAX_ELITES);
      hideInstances(bikerShells, MAX_ELITES);
      hideInstances(bikerBodies, MAX_ELITES);
      _m.compose(_ZERO, _q.identity(), _NOSCALE);
      for (let i = MAX_WALKERS; i < SHADOW_CAPACITY; i++) shadows.setMatrixAt(i, _m);

      let barCount = 0;
      for (let i = 0; i < MAX_UNITS; i++) {
        const u = units[i];
        if (!u || !u.alive) continue;

        if (u.kind !== "pack") {
          const slot = eliteSlotOf[i] ?? -1;
          if (slot >= 0) {
            const z = u.prevZ + (u.z - u.prevZ) * alpha;
            const t = clock * 7 + u.phase;
            // Pinned elites stand still on their barrel; loose ones stride.
            const bob = u.pinned ? Math.sin(t * 0.55) * 0.02 : Math.abs(Math.sin(t)) * 0.07;
            _pos.set(u.x, u.y + bob, z);
            _e.set(0, 0, u.kind === "biker" ? 0 : Math.sin(t) * 0.06);
            _q.setFromEuler(_e);
            _scl.setScalar(ELITE_SCALE);
            _m.compose(_pos, _q, _scl);

            const body = u.kind === "biker" ? bikerBodies : eliteBodies;
            const shell = u.kind === "biker" ? bikerShells : eliteShells;
            body.setMatrixAt(slot, _m);
            shell.setMatrixAt(slot, _m);
            const hot = u.flash > 0 ? 1 + (u.flash / HIT_FLASH) * 1.6 : 1;
            body.setColorAt(slot, _col.setRGB(hot, hot, hot));

            // A rider standing on a barrel is not touching the road, and the
            // barrel already casts its own shadow there.
            if (!u.pinned) {
              const size = u.kind === "biker" ? BIKER_SHADOW : ELITE_SHADOW;
              const base = u.kind === "biker" ? MAX_WALKERS + MAX_ELITES : MAX_WALKERS;
              _pos.set(u.x + SHADOW_OFF_X, SHADOW_Y, z + SHADOW_OFF_Z);
              _scl.set(size, 1, size * (u.kind === "biker" ? 0.55 : 1));
              _m.compose(_pos, _q.identity(), _scl);
              shadows.setMatrixAt(base + slot, _m);
            }
          }
        }

        /* HP bar */
        if (u.bar >= 0 && barCount < MAX_BARS) {
          const z = u.prevZ + (u.z - u.prevZ) * alpha;
          const frac = Math.max(0, Math.min(1, u.hp / u.maxHp));
          _pos.set(u.x, u.y + BAR_Y, z - 0.35);
          _scl.set(1, 1, 1);
          _m.compose(_pos, BILLBOARD, _scl);
          barBacks.setMatrixAt(barCount, _m);

          // Fill is left-anchored, so it shrinks toward its own left edge.
          _pos.set(u.x - (BAR_W * 0.5 - BAR_INSET), u.y + BAR_Y, z - 0.35 + 0.004);
          _scl.set((BAR_W - BAR_INSET * 2) * frac, 1, 1);
          _m.compose(_pos, BILLBOARD, _scl);
          barFills.setMatrixAt(barCount, _m);
          barCount++;
        }
      }
      eliteShells.instanceMatrix.needsUpdate = true;
      eliteBodies.instanceMatrix.needsUpdate = true;
      bikerShells.instanceMatrix.needsUpdate = true;
      bikerBodies.instanceMatrix.needsUpdate = true;
      if (eliteBodies.instanceColor) eliteBodies.instanceColor.needsUpdate = true;
      if (bikerBodies.instanceColor) bikerBodies.instanceColor.needsUpdate = true;

      // Only the bars actually in use are drawn; the rest of the pool is parked.
      _m.compose(_ZERO, _q.identity(), _NOSCALE);
      for (let i = barCount; i < MAX_BARS; i++) {
        barBacks.setMatrixAt(i, _m);
        barFills.setMatrixAt(i, _m);
      }
      barBacks.instanceMatrix.needsUpdate = true;
      barFills.instanceMatrix.needsUpdate = true;
      shadows.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      walkerGeo.dispose();
      eliteGeo.dispose();
      bikerGeo.dispose();
      eliteRimGeo.dispose();
      bikerRimGeo.dispose();
      barBackGeo.dispose();
      barFillGeo.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      shadowTex.dispose();
      shadows.dispose();
      walkerMat.dispose();
      eliteMat.dispose();
      rimMat.dispose();
      barBackMat.dispose();
      barFillMat.dispose();
      walkers.dispose();
      eliteShells.dispose();
      eliteBodies.dispose();
      bikerShells.dispose();
      bikerBodies.dispose();
      barBacks.dispose();
      barFills.dispose();
    },
  };

  return system;
}

/* -------------------------------------------------------------------------- */
/* Figure construction (boot only)                                             */
/* -------------------------------------------------------------------------- */

interface Part {
  geo: THREE.BufferGeometry;
  color: number;
}

/**
 * Merge a handful of primitives into one geometry with baked vertex colours.
 *
 * Written by hand rather than pulled from BufferGeometryUtils because all we
 * need is position/normal/colour concatenation, and doing it here keeps the
 * per-part tint in the same place as the part list.
 */
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
      // Same top-lit bias as the barrel debris: from this camera pitch you read
      // tops, so lifting them keeps small figures from turning into blobs.
      const k = 0.84 + 0.24 * Math.max(0, ny);
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

function place(geo: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

/**
 * Brown/tan walker: torso, legs, greenish head, wide brimmed hat. ~130 tris,
 * which at 240 instances is still one draw call and 31k triangles.
 */
function buildWalker(): THREE.BufferGeometry {
  const h = WALKER_HEIGHT;
  return mergeParts([
    { geo: place(new THREE.BoxGeometry(0.3, 0.34, 0.2), 0, h * 0.17, 0), color: 0x5f4126 },
    { geo: place(new THREE.BoxGeometry(0.36, 0.4, 0.24), 0, h * 0.5, 0), color: 0xb08248 },
    { geo: place(new THREE.SphereGeometry(0.145, 6, 5), 0, h * 0.79, 0), color: 0x9fb27a },
    {
      geo: place(new THREE.CylinderGeometry(0.27, 0.27, 0.045, 10), 0, h * 0.87, 0),
      color: 0x6d4a2b,
    },
    {
      geo: place(new THREE.CylinderGeometry(0.13, 0.15, 0.16, 8), 0, h * 0.93, 0),
      color: 0x7a5533,
    },
  ]);
}

/**
 * Gold elite: bigger than a walker, khaki uniform, dark helmet, and a bright
 * weapon held forward. Read as a threat before you read what it is.
 *
 * `g` grows every part by that many metres in every direction, which is how the
 * gold rim shell is built (see RIM_THICKNESS). Growing the parts rather than
 * displacing the merged mesh along its normals matters: these figures are made
 * of hard-edged boxes, and a box's corner vertices carry three different
 * normals, so normal displacement tears the shell open at every corner.
 */
function buildElite(g = 0): THREE.BufferGeometry {
  const h = 1.3;
  return mergeParts([
    { geo: place(box(0.32, 0.4, 0.22, g), 0, h * 0.16, 0), color: 0x4a3a22 },
    { geo: place(box(0.42, 0.46, 0.28, g), 0, h * 0.5, 0), color: 0xd8c68a },
    { geo: place(new THREE.SphereGeometry(0.16 + g, 7, 5), 0, h * 0.8, 0), color: 0xe8c9a0 },
    { geo: place(new THREE.SphereGeometry(0.185 + g, 8, 5), 0, h * 0.85, 0), color: 0x4b3b28 },
    // Rifle across the chest, pointing down-road at the player.
    { geo: place(box(0.09, 0.09, 0.62, g), 0.13, h * 0.52, 0.3), color: 0xf0b429 },
  ]);
}

/**
 * Motorcycle elite (frames 030 / 035): a dark bike with a gold rider. Only a
 * handful ever exist, so it can afford more geometry than a walker.
 */
function buildBiker(g = 0): THREE.BufferGeometry {
  const wheel = (z: number): Part => ({
    geo: (() => {
      // Cylinder's axis is Y by default; a wheel needs it across the road.
      const w = new THREE.CylinderGeometry(0.26 + g, 0.26 + g, 0.11 + g * 2, 12);
      w.rotateZ(Math.PI / 2);
      w.translate(0, 0.26, z);
      return w;
    })(),
    color: 0x24242a,
  });

  return mergeParts([
    wheel(0.46),
    wheel(-0.46),
    { geo: place(box(0.2, 0.16, 1.0, g), 0, 0.42, 0), color: 0x3d4030 },
    { geo: place(box(0.26, 0.22, 0.42, g), 0, 0.58, -0.05), color: 0x5b6040 },
    // Rider, seated and leaning into the bars.
    { geo: place(box(0.34, 0.36, 0.3, g), 0, 0.86, -0.06), color: 0xd8c68a },
    { geo: place(new THREE.SphereGeometry(0.16 + g, 7, 5), 0, 1.12, 0.02), color: 0x4b3b28 },
    { geo: place(box(0.5, 0.07, 0.07, g), 0, 0.78, 0.42), color: 0xf0b429 },
  ]);
}

function box(w: number, h: number, d: number, g: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w + g * 2, h + g * 2, d + g * 2);
}

/** A soft ellipse of alpha. Black RGB so the material never tints it. */
function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("enemies: 2d canvas unavailable");

  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,1)");
  // Held near-solid to ~45% of the radius so the shadow keeps a readable core
  // instead of dissolving into a grey smudge at phone size.
  g.addColorStop(0.45, "rgba(0,0,0,0.85)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);

  return new THREE.CanvasTexture(c);
}
