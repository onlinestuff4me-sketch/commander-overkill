/**
 * COMMANDER OVERKILL — entry point and integration.
 *
 * Every element module is built against the `WorldState`/`System` contract in
 * core/types.ts and knows nothing about the others. This file is the only place
 * they meet, and the only place that owns `world.troops` — a gate reports that
 * it was crossed, it does not pay itself.
 *
 * UPDATE ORDER IS LOAD-BEARING and is spelled out explicitly below rather than
 * looped over an array, because getting it wrong produces a one-frame lag that
 * looks like a physics bug and isn't.
 */

import * as THREE from "three";
import { GameLoop } from "./core/loop";
import { StateMachine } from "./core/state";
import { createStage } from "./core/renderer";
import { bus } from "./core/events";
import { createWorld, MAX_TROOPS } from "./core/types";
import type { System, WeaponTier } from "./core/types";
import { TouchDriver, clamp } from "./input/touch";
import { createCorridor } from "./mechanics/lane";
import { createSquad } from "./entities/squad";
import { createBullets, MAX_STREAMS } from "./mechanics/bullets";
import { barrelHp, barrelPayout } from "./mechanics/pacing";
import { createGates } from "./mechanics/gates";
import { createBarrels } from "./entities/barrels";
import { createEnemies } from "./entities/enemies";
import { createFloaters } from "./ui/floaters";
import { createGrowthFx } from "./entities/growthfx";
import { createBossBar } from "./ui/bossbar";
import { mountPerfOverlay } from "./ui/perf";
import type { CanvasTexture, Mesh, MeshLambertMaterial } from "three";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const stage = createStage(canvas);
const state = new StateMachine();
const touch = new TouchDriver(canvas);
const world = createWorld(new THREE.Vector3());

const corridor = createCorridor();
stage.scene.add(corridor);

// The reference has no hero avatar — the squad IS the player. entities/commander.ts
// stays in the tree because the brief specs a named hero and specs/prd.md still
// has that question open; it is simply not mounted.
const squad = createSquad(stage.scene);
const bullets = createBullets(stage.scene);
const gates = createGates(stage.scene);
const barrels = createBarrels(stage.scene);
const enemies = createEnemies(stage.scene);
const floaters = createFloaters(stage.scene);
const growthFx = createGrowthFx(stage.scene);
const bossBar = createBossBar(ui);

const renderables: System[] = [
  squad,
  bullets,
  gates,
  barrels,
  enemies,
  floaters,
  growthFx,
  bossBar,
];

// ── Rewards ────────────────────────────────────────────────────────────────

/**
 * One payout path for every reward source, so the growth beat is identical
 * whether it came from a gate or a barrel. Floaters are spawned per unit
 * ACTUALLY gained rather than per the reward's face value — a reward clipped by
 * MAX_TROOPS must not promise troops that never arrived.
 */
function payTroops(amount: number): void {
  const before = world.troops;
  world.troops = clamp(world.troops + amount, 0, MAX_TROOPS);
  const delta = world.troops - before;
  if (delta === 0) return;
  if (delta > 0) {
    floaters.spawn(squad.center, delta, squad.radiusX);
    growthFx.play(squad.center, squad.radius);
    return;
  }
  // A red gate is the same beat run backwards, and it has to be as legible as
  // the payout — the player needs to see the size of what it cost, not just
  // watch a bar shrink. Counted off ACTUAL losses, so a -20 taken at 8 troops
  // rains eight, not twenty.
  floaters.drop(squad.center, -delta, squad.radiusX);
}

gates.onResolve((hit) => payTroops(hit.value));

barrels.onDestroyed((_id, tag, _x, _z, maxHp) => {
  payTroops(barrelPayout(maxHp));
  if (tag >= 0) enemies.unpin(tag);
});

// Placeholder boss pacing: the bar is a pure display, so something has to drive
// it. Kills stand in until a real boss entity exists.
bossBar.reset(80);
enemies.onKilled(() => bossBar.damage(1));

// ── Placeholder content pacing ─────────────────────────────────────────────

const ROW_LANES = [-0.62, 0, 0.62] as const;
/**
 * Spacing is authored in TIME but experienced as DISTANCE, so this has to move
 * with scrollSpeed or the corridor silently gets denser every time the world
 * slows down. At 6 m/s, 4.2s ≈ 25m between rows — close enough that the next
 * decision is visible while the current one resolves, which is the stacking the
 * reference uses.
 */
const SPAWN_EVERY = 4.2;
const SPAWN_Z = -58;
let spawnTimer = SPAWN_EVERY;
let rowIndex = 0;
/** Suspends barrel/enemy pacing. Only the dev calibration harness touches this —
 *  a probe needs an empty corridor or the traffic eats the rounds it is counting. */
let contentSpawning = true;

function spawnRow(): void {
  rowIndex++;
  const hp = barrelHp(rowIndex, world.troops, tierFor(world.troops), bullets.tuning);
  for (const lane of ROW_LANES) {
    // Every third row rides a motorcycle elite, so the variant actually shows up.
    const mounted = rowIndex % 3 === 0 && lane === 0;
    const rider = enemies.spawnElite(lane, SPAWN_Z, 30, mounted);
    barrels.spawn(lane, SPAWN_Z, hp, rider);
  }
  if (rowIndex % 2 === 0) {
    enemies.spawnPack(0, SPAWN_Z + 10, 8, 4);
  }
}

/**
 * ONE SOLDIER, as the reference opens. This was 8 only because gate rows were
 * rolled independently and roughly one in four came up all-red — an unavoidable
 * death at low strength. `MERCY_TROOPS` in mechanics/gates.ts now guarantees a
 * blue segment and mild penalties until the squad can absorb a bad row, so the
 * opening beat the reference actually has is available again: one man on an
 * empty road, and the first gate is the whole game in miniature.
 */
const START_TROOPS = 1;

/**
 * Zero troops is a loss. Restarting immediately (rather than freezing on an
 * empty road) keeps the prototype iterable — there is no debrief screen yet,
 * and a frozen screen teaches nobody anything.
 */
function resetRun(): void {
  world.troops = START_TROOPS;
  world.health = 1;
  barrels.clear();
  enemies.clear();
  gates.reset();
  bossBar.reset(80);
  spawnTimer = SPAWN_EVERY;
  rowIndex = 0;
}

/**
 * Muzzle scratch buffer, allocated once. One entry per possible stream: the
 * squad reports where each soldier's rifle actually is, and bullets fires one
 * stream from each, which is what makes "20 troops = 20 streams" true by
 * construction rather than by a rate curve pretending to be density.
 */
const shooters = Array.from({ length: MAX_STREAMS }, () => new THREE.Vector3());

/** Hoisted so the per-tick rider seating allocates nothing. */
function seatRider(_id: number, tag: number, x: number, topY: number, z: number): void {
  if (tag >= 0) enemies.pin(tag, x, topY, z);
}

// ── Collision ──────────────────────────────────────────────────────────────

const BARREL_PAD = 0.2;
const ENEMY_PAD = 0.32;

/**
 * Bullets are tested against barrels first: barrels are cover, and a round that
 * hits one must not also reach the enemy standing behind it.
 *
 * ITERATES BACKWARDS because `consume` swap-removes from `ids` — forwards would
 * skip whichever bullet got swapped into the freed slot.
 */
function resolveHits(): void {
  const view = bullets.bullets;
  for (let i = view.count - 1; i >= 0; i--) {
    const id = view.ids[i]!;
    const x = view.x[id]!;
    const y = view.y[id]!;
    const z = view.z[id]!;
    const dmg = view.damage[id]!;

    if (barrels.damageAt(x, z, BARREL_PAD, dmg) >= 0) {
      bullets.consume(id, x, y, z);
      continue;
    }
    if (enemies.damageAt(x, z, ENEMY_PAD, dmg) >= 0) {
      bullets.consume(id, x, y, z);
    }
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────

/** Placeholder progression: tier tracks army size until weapon pickups exist. */
function tierFor(troops: number): WeaponTier {
  if (troops < 4) return 0;
  if (troops < 40) return 1;
  return 2;
}

const road = corridor.children[0] as Mesh;
const roadTex = (road.material as MeshLambertMaterial).map as CanvasTexture;
let scrolled = 0;

/**
 * One simulation step. Split out of the loop callback so the debug harness at
 * the bottom of this file can drive it directly — an offscreen browser pane
 * throttles requestAnimationFrame to a dead stop, so verification screenshots
 * have to advance the world themselves.
 */
function tick(dt: number): void {
    if (state.state !== "running") return;
    world.elapsed += dt;
    world.squadLane = touch.lane;
    world.weaponTier = tierFor(world.troops);

    if (contentSpawning) {
      spawnTimer += dt;
      if (spawnTimer >= SPAWN_EVERY) {
        spawnTimer -= SPAWN_EVERY;
        spawnRow();
      }
    }

    // 1. Squad first: it writes world.squadCenter, which everything below reads.
    squad.update(dt, world);

    // 2. Muzzles sit at the blob's front edge, spread across its width — firing
    //    from a single point reads as one soldier no matter how many there are.
    bullets.setMuzzle(
      squad.center.x,
      squad.center.y + 1,
      squad.center.z - squad.radiusZ,
      squad.radiusX,
    );
    // setMuzzle still supplies the blob centre and width for aim; setShooters
    // is what gives each soldier its own stream origin.
    bullets.setShooters(shooters, squad.sampleShooters(shooters, MAX_STREAMS));
    bullets.update(dt, world);

    // 3. Targets move, then get shot — so a hit lands where the barrel is now,
    //    not where it was last tick.
    barrels.update(dt, world);
    enemies.update(dt, world);
    barrels.forEachLive(seatRider);
    resolveHits();

    // 4. Gates resolve against the settled squad position.
    gates.update(dt, world);

    // 5. Feedback last: it reacts to everything above, within the same tick.
    floaters.update(dt, world);
    growthFx.update(dt, world);
    bossBar.update(dt, world);

    scrolled += world.scrollSpeed * dt;

    if (world.troops <= 0) resetRun();
}

function draw(alpha: number): void {
  for (const system of renderables) system.render(alpha, world);
  roadTex.offset.y = (scrolled / (70 / roadTex.repeat.y)) % 1;
  stage.renderer.render(stage.scene, stage.camera);
}

const loop = new GameLoop({
  update: tick,
  render: draw,
  onStats(stats) {
    bus.emit("frame:stats", stats);
  },
});

mountPerfOverlay(ui, stage.renderer);

state.transition("briefing");
state.transition("running");
world.troops = START_TROOPS;
loop.start();

// A backgrounded run should not drain a phone battery, and stopping also means
// the loop never has a multi-second delta to swallow on return.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) loop.stop();
  else loop.start();
});

/**
 * Damage a single barrel actually takes on one full approach, at a given troop
 * count. Dev-only — the `import.meta.env.DEV` block below is its only caller,
 * so production strips it along with the harness.
 *
 * Barrel HP is the one number in the game that cannot be reasoned about from
 * the fire rate alone: a barrel is only in range for the last third of its
 * journey, the squad's muzzles move forward as the blob deepens, and the
 * convergence cone means an off-lane barrel catches a fraction of the stream.
 * Three shipped calibration bugs came from doing this arithmetic on paper, so
 * this measures it instead — spawn one barrel with more HP than any weapon can
 * chew through, run the real update order, and count what it lost.
 *
 * Destructive: it clears the corridor and leaves the run reset behind it.
 */
function probeDamagePerPass(troops: number, lane = 0): {
  troops: number;
  tier: WeaponTier;
  /** Total damage the barrel absorbed between spawn and passing the squad. */
  damage: number;
  /** Seconds it spent actually taking fire — the real kill window. */
  window: number;
  /** Muzzle DPS the squad was producing, for comparison against on-target. */
  onTargetDps: number;
} {
  const PROBE_HP = 1e9;
  const dt = 1 / 60;

  contentSpawning = false;
  gates.setAutoSpawn(false);
  // Rows already in the corridor MUST go too, not just future ones. A live gate
  // resolving mid-probe pays or charges troops, which silently re-tiers the
  // weapon; at one troop a red segment zeroes the count, trips resetRun(), and
  // clears the probe barrel before it ever reaches the kill zone — which reads
  // as "one soldier deals no damage" rather than as a broken measurement.
  gates.reset();
  barrels.clear();
  enemies.clear();
  world.troops = clamp(Math.round(troops), 1, MAX_TROOPS);
  touch.lane = clamp(lane, -1, 1);

  // Settle first. The blob's width and depth grow with the count and the muzzle
  // line rides its front edge, so probing before the springs converge measures
  // the wrong geometry.
  for (let i = 0; i < 90; i++) tick(dt);

  const id = barrels.spawn(lane, SPAWN_Z, PROBE_HP);
  let ticks = 0;
  let last = PROBE_HP;
  // First and last tick on which a round actually landed. The window is the
  // span BETWEEN them, not the count of ticks that scored — at one troop most
  // ticks are empty, and counting only the scoring ones reports a kill window
  // twelve times shorter than the barrel really spent under fire.
  let firstHit = -1;
  let lastHit = -1;

  // 58 m at 6 m/s is ~10 s; the cap is a runaway guard, not the exit condition.
  while (ticks < 60 * 20) {
    tick(dt);
    ticks++;
    const hp = barrels.hpOf(id);
    if (hp < 0) break; // destroyed or recycled past the camera
    if (hp < last) {
      if (firstHit < 0) firstHit = ticks;
      lastHit = ticks;
    }
    last = hp;
    let z = -Infinity;
    barrels.forEachLive((bid, _tag, _x, _topY, bz) => {
      if (bid === id) z = bz;
    });
    if (z >= squad.center.z) break;
  }

  const damage = PROBE_HP - last;
  const window = firstHit < 0 ? 0 : (lastHit - firstHit + 1) * dt;
  const tier = world.weaponTier;

  contentSpawning = true;
  gates.setAutoSpawn(true);
  resetRun();

  return {
    troops: Math.round(troops),
    tier,
    damage: Math.round(damage),
    window: Number(window.toFixed(2)),
    onTargetDps: window > 0 ? Math.round(damage / window) : 0,
  };
}

/**
 * HEADLESS DRIVE — dev builds only, stripped from production.
 *
 * An offscreen browser pane reports `document.hidden` and throttles
 * requestAnimationFrame to *zero* frames, so screenshotting a live run captures
 * whatever frame it happened to freeze on. This lets a verification pass pose
 * the world at an exact state — "45 troops, gate 6 metres out" — and render
 * that deterministically, which is a better way to compare against a specific
 * reference frame than trying to catch the moment live.
 */
if (import.meta.env.DEV) {
  Object.assign(window, {
    __overkill: {
      world,
      probeDamagePerPass,
      /** Sweep the probe across troop counts. This is the barrel HP curve. */
      damageCurve(counts: readonly number[] = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120]) {
        return counts.map((n) => probeDamagePerPass(n));
      },
      setSpawning(on: boolean): void {
        contentSpawning = on;
      },
      /** Live round population and its extent — the number to hold against a
       *  reference frame when asking whether our fire is too dense. */
      bulletStats() {
        const v = bullets.bullets;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < v.count; i++) {
          const id = v.ids[i]!;
          minX = Math.min(minX, v.x[id]!);
          maxX = Math.max(maxX, v.x[id]!);
          minZ = Math.min(minZ, v.z[id]!);
          maxZ = Math.max(maxZ, v.z[id]!);
        }
        return {
          count: v.count,
          minX,
          maxX,
          minZ,
          maxZ,
          muzzleZ: squad.center.z - squad.radiusZ,
        };
      },
      /** Advance `ticks` fixed steps, then draw once. */
      step(ticks = 60): void {
        for (let i = 0; i < ticks; i++) tick(1 / 60);
        draw(0);
      },
      setTroops(n: number): void {
        world.troops = clamp(Math.round(n), 0, MAX_TROOPS);
      },
      setLane(n: number): void {
        touch.lane = clamp(n, -1, 1);
      },
      pay: payTroops,
      stats: () => ({
        troops: world.troops,
        tier: world.weaponTier,
        elapsed: Number(world.elapsed.toFixed(2)),
        squadX: Number(squad.center.x.toFixed(2)),
        radiusX: Number(squad.radiusX.toFixed(2)),
        calls: stage.renderer.info.render.calls,
        tris: stage.renderer.info.render.triangles,
      }),
    },
  });
}

// Debug sliders are opt-in: lil-gui is ~30kB and has no business in a playtest
// build the player is holding.
if (new URLSearchParams(location.search).has("debug")) {
  void import("lil-gui").then(({ default: GUI }) => {
    const gui = new GUI({ title: "Overkill" });
    gui.add(world, "troops", 0, MAX_TROOPS, 1).listen();
    gui.add(world, "scrollSpeed", 0, 24, 0.5);
    gui
      .add({ grow: 10 }, "grow", 1, 50, 1)
      .name("test growth (+N)")
      .onFinishChange((n: number) => payTroops(n));
  });
}
