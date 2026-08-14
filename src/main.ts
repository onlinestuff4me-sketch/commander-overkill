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
import { createZoom } from "./core/zoom";
import { bus } from "./core/events";
import { createWorld, MAX_TROOPS } from "./core/types";
import type { System, WeaponTier } from "./core/types";
import { TouchDriver, clamp } from "./input/touch";
import { createCorridor, CORRIDOR_HALF_WIDTH } from "./mechanics/lane";
import { createSquad } from "./entities/squad";
import { createBullets, MAX_STREAMS } from "./mechanics/bullets";
import {
  barrelHp,
  barrelPayout,
  damageOnSegment,
  enemyHp,
  WALKER_PASS_SHARE,
} from "./mechanics/pacing";
import { createDirector, createRng } from "./mechanics/director";
import type { Placement } from "./mechanics/director";
import { composeAutoRow, createGates, MERCY_TROOPS, rowPlacement } from "./mechanics/gates";
import { createBarrels } from "./entities/barrels";
import { createEnemies } from "./entities/enemies";
import { createPickups } from "./entities/pickups";
import type { PickupKind } from "./entities/pickups";
import { createFloaters } from "./ui/floaters";
import { createGrowthFx } from "./entities/growthfx";
import { createBossBar } from "./ui/bossbar";
import { createTroopCount } from "./ui/troopcount";
import { createLoadout } from "./ui/loadout";
import { createNetPop } from "./ui/netpop";
import { mountPerfOverlay } from "./ui/perf";
import type { CanvasTexture, Mesh, MeshLambertMaterial } from "three";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const stage = createStage(canvas);
const state = new StateMachine();
const touch = new TouchDriver(canvas);
const world = createWorld(new THREE.Vector3());
const zoom = createZoom(stage.camera, stage.scene);

const corridor = createCorridor();
stage.scene.add(corridor);

// The reference has no hero avatar — the squad IS the player. entities/commander.ts
// stays in the tree because the brief specs a named hero and specs/prd.md still
// has that question open; it is simply not mounted.
const squad = createSquad(stage.scene);
const bullets = createBullets(stage.scene);
// autoSpawn OFF: the director owns the corridor now. Leaving the gate module
// pacing itself is precisely the second metronome that caused the overlap.
const gates = createGates(stage.scene, { autoSpawn: false });
const barrels = createBarrels(stage.scene);
const enemies = createEnemies(stage.scene);
// What rides a barrel. Not an enemy — see the note in entities/pickups.ts.
const pickups = createPickups(stage.scene);
const floaters = createFloaters(stage.scene);
const growthFx = createGrowthFx(stage.scene);
const bossBar = createBossBar(ui);
// The only number on screen used to be the boss bar's, which counts DOWN.
// Players read it as their army. Now the army has its own readout.
const troopCount = createTroopCount(ui);
// Crowd size is one axis; what the crowd is CARRYING is the other, and until
// this existed the second one was invisible — see ui/loadout.ts.
const loadout = createLoadout(ui);
// The per-unit +1s say WHICH soldiers; they are bad at saying HOW MANY when a
// row resolves three segments at once. This is the running total on top.
const netPop = createNetPop(ui, stage.camera);

const renderables: System[] = [
  squad,
  bullets,
  gates,
  barrels,
  enemies,
  pickups,
  floaters,
  growthFx,
  bossBar,
  troopCount,
  loadout,
  netPop,
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
  // ELITES ARE THE LAST THING YOU LOSE. Ordinary losses eat the crowd around
  // them, so a loss only reaches the specials once the army has been ground down
  // to the specials themselves — which is the read we want: a shattered squad is
  // a handful of veterans and gunners, not a random survivor.
  armCarriers();
  if (delta === 0) return;
  netPop.add(delta);
  if (delta > 0) growthFx.play(squad.center, squad.radius);
  // The floaters are NOT spawned here any more. A `+1` has to sit over the
  // soldier it is counting, and that soldier does not exist yet — the squad
  // creates him on its next update. `drainSquadEvents()` runs after that and
  // places the glyphs on the actual bodies.
}

/** Scratch for the squad's spawn/death reports. Allocated once. */
const bodyEvents = Array.from({ length: 32 }, () => new THREE.Vector3());

/**
 * Put a glyph on every body that just appeared or fell.
 *
 * Runs immediately after `squad.update`, because that is the tick where the new
 * units get their positions and the dying ones start toppling. Any earlier and
 * there is nothing to point at; any later and the glyph is a frame behind the
 * body it belongs to.
 */
function drainSquadEvents(): void {
  const gained = squad.takeSpawns(bodyEvents, bodyEvents.length);
  if (gained > 0) floaters.spawnAt(bodyEvents, gained, "gain");
  const lost = squad.takeDeaths(bodyEvents, bodyEvents.length);
  if (lost > 0) floaters.spawnAt(bodyEvents, lost, "loss");
}

// `troops`, not `value`: the panel's number is what a WHOLE army walking through
// that one segment would collect, and a wide crowd only ever sends part of
// itself through any given segment. See resolve() in mechanics/gates.ts.
/** Dev-only record of what each segment paid. Empty and untouched in production. */
const payoutLog: { troops: number; value: number; share: number; reward: boolean }[] = [];

gates.onResolve((hit) => {
  if (import.meta.env.DEV) {
    payoutLog.push({
      troops: hit.troops,
      value: hit.value,
      share: Number(hit.share.toFixed(3)),
      reward: hit.reward,
    });
  }
  payTroops(hit.troops);
});

/**
 * A DESTROYED BARREL RECRUITS ITS RIDER.
 *
 * The figures standing on barrels were built as hostile "gold rim-lit elites",
 * on the strength of a line in REFERENCE.md that turned out to be a misread of
 * the footage. `reference-media/clip1a` settles it: they wear the PLAYER's blue
 * helmet and pale uniform with a gold upgrade glow, while the actual enemies in
 * the same frames are green zombies and brown walkers. Shooting a barrel is
 * supposed to free an ally, not drop an attacker.
 *
 * So the rider is removed rather than released, and the barrel pays a recruit
 * bonus on top of its normal payout. That bonus is what makes shooting cover
 * worth doing for its own sake instead of only clearing a path.
 *
 * AND THE RECRUIT IS GENUINELY STRONGER. He arrives with three ordinary bodies
 * (the bonus) AND as an elite: bigger, gold, and worth four rifles
 * (`ELITE_SHOOTER_WEIGHT` in mechanics/bullets.ts). Before that, "recruit" was
 * three anonymous troops with a different explosion — and the reference's whole
 * point is that the figure on the barrel is SOMEBODY. A reward you cannot pick
 * out of the crowd a second later is not a reward anyone steers for.
 */
const RECRUIT_BONUS = 3;
/** Elites gained per recruit pickup. One, so the gold in the crowd is a count of
 *  barrels you committed to rather than a colour the whole army drifts toward. */
const RECRUIT_ELITES = 1;
/**
 * What a weapon pickup is worth, as a multiplier on the axis it upgrades.
 *
 * Multiplicative and uncapped-looking, but the rate is clamped by the bullet
 * governor and the damage by `FIREPOWER_MAX`, so a lucky run of barrels cannot
 * trivialise the rest of a level. 1.3 is big enough to feel on the very next
 * barrel and small enough that one pickup is not the whole run.
 */
/**
 * A weapon pickup ARMS TROOPS. It does not raise a hidden multiplier.
 *
 * Mischa put the ask exactly: a rocket launcher with a 10 next to it should mean
 * ten of your soldiers are carrying rocket launchers and firing rockets. So a
 * pickup adds carriers, the squad draws the weapon on them, and their streams
 * fire the matching projectile. `firepower` and `fireRate` are still the numbers
 * the weapon model runs on — they are simply DERIVED from the head count now, in
 * `armCarriers()` below, which is the only place either is written.
 */
const MINIGUN_CREW = 4;
const ROCKET_CREW = 3;
/** What one carrier is worth on its axis. Small, because the count grows. */
const GUNNER_RATE = 0.045;
const ROCKETEER_POWER = 0.06;
/** Ceilings, so a long run cannot stack its way out of the difficulty curve. */
const FIRE_RATE_MAX = 4;
const FIREPOWER_MAX = 6;

/**
 * Re-derive the weapon multipliers from the carrier counts, and keep the counts
 * inside the crowd.
 *
 * Called after anything that changes `troops`, `gunners` or `rocketeers`. The
 * three specials are disjoint — one job per soldier — so they are trimmed in
 * priority order rather than clamped independently: elites first (they are the
 * investment that survives), then gunners, then rocketeers.
 */
function armCarriers(): void {
  world.elites = Math.min(world.elites, world.troops);
  world.gunners = Math.min(world.gunners, Math.max(0, world.troops - world.elites));
  world.rocketeers = Math.min(
    world.rocketeers,
    Math.max(0, world.troops - world.elites - world.gunners),
  );
  world.fireRate = Math.min(FIRE_RATE_MAX, 1 + world.gunners * GUNNER_RATE);
  world.firepower = Math.min(FIREPOWER_MAX, 1 + world.rocketeers * ROCKETEER_POWER);
}

barrels.onDestroyed((_id, tag, _x, _z, maxHp) => {
  payTroops(barrelPayout(maxHp));
  if (tag < 0) return;

  const kind = pickups.kindOf(tag);
  pickups.collect(tag);
  if (kind === "recruit") {
    payTroops(RECRUIT_BONUS);
    // After the payout, so the elite has bodies to be one of. payTroops clamps
    // elites down to the troop count, and doing this first would have the clamp
    // eat the recruit at low counts.
    world.elites = Math.min(world.troops, world.elites + RECRUIT_ELITES);
  } else if (kind === "minigun") {
    world.gunners += MINIGUN_CREW;
  } else if (kind === "rocket") {
    world.rocketeers += ROCKET_CREW;
  }
  armCarriers();
});

/**
 * AN ENEMY THAT REACHES YOU COSTS TROOPS.
 *
 * `enemies.ts` has fired `onBreached` since it was written and nothing was
 * listening, so walking into the crowd did literally nothing — enemies were
 * decoration you shot at for a boss bar that is itself a placeholder. Combat had
 * no stake in either direction.
 *
 * The cost is deliberately small. It routes through `payTroops`, so a breach
 * rains the same red `-1`s a red gate does and reads as the same kind of event,
 * and it is the thing that makes enemy hit points worth scaling at all: a wave
 * that survives long enough to arrive now has a consequence when it does.
 */
/**
 * What one surviving enemy body costs when it reaches the crowd, as a share of
 * the army — and this is the price of the "or fight through them" half of every
 * blockade.
 *
 * It used to be a flat count per UNIT: one troop for a whole eight-strong pack,
 * whatever the army size. That made shooting a pack pointless and walking
 * through one free, which measured out exactly as you would expect once the
 * player could dodge a gate row — the autopilot's median run went from 436 to
 * 660 troops with zero wipes, because "go around" had no downside anywhere on
 * the board. A pack that arrives intact now costs about 12% of the army, which
 * is the same order as a red segment; a pack you shot down to two costs 3%.
 *
 * Proportional for the same reason gate penalties are (see PENALTY_BANDS in
 * mechanics/gates.ts): a fixed price is brutal early and irrelevant late.
 */
const BREACH_SHARE = 0.015;
/** Multiplier per kind, on top of the per-body share. Elites and bikers are one
 *  body but hit like several. */
const BREACH_COST: Record<string, number> = { pack: 1, elite: 3, biker: 3 };
enemies.onBreached((_id, kind, _hp, bodies) => {
  // FREE while the squad is tiny, on the same threshold the gate mercy rule
  // uses. A pack is eight bodies and a two-troop army cannot kill any of them,
  // so charging for every breach turns the opening into a death spiral: too
  // weak to kill, so you lose troops, so you are weaker. Combat starts costing
  // once the army is established enough to do something about it.
  if (world.troops < MERCY_TROOPS) return;
  const weight = (BREACH_COST[kind] ?? 1) * Math.max(1, bodies);
  payTroops(-Math.max(1, Math.round(world.troops * BREACH_SHARE * weight)));
});

// Placeholder boss pacing: the bar is a pure display, so something has to drive
// it. Kills stand in until a real boss entity exists.
bossBar.reset(80);
enemies.onKilled(() => bossBar.damage(1));

// ── Content pacing ─────────────────────────────────────────────────────────

/**
 * A BARREL CLUSTER IS A PLACE, NOT A ROW.
 *
 * Three barrels used to be spread across the lanes at ±0.62 and 0, which on the
 * old narrow road meant they covered it end to end — the same "everything is a
 * wall" problem gate rows had. They are now a tight group of three placed
 * somewhere on the road, so shooting them is a DETOUR: you go to where they are,
 * which is a second or so of not being anywhere else.
 */
const BARREL_SPACING = 1.95;
const BARREL_CLUSTER = 3;
/** A barrel's own width, for fitting a cluster into a gap. */
const BARREL_FACE = 1.7;
/** Metres of daylight kept between a compound placement's two halves, so they
 *  read as two options rather than as one cluttered obstacle. */
const CLUSTER_CLEARANCE = 0.5;
/**
 * Segments a compound placement's gate row may have.
 *
 * Two, so the row covers 42% of the road and there is genuinely somewhere else
 * to be. The whole premise of a blockade or a crossroads is two options on one
 * plane; a four-wide row covers 84% and there is no second option left to place.
 */
const COMPOUND_SEGMENTS = 2;
/** Metres of road a cluster or a pack keeps clear of the kerb, so nothing ever
 *  spawns half on the grass. */
const PLACE_INSET = 1.3;
const SPAWN_Z = -58;
let rowIndex = 0;
/** Suspends the director. Only the dev calibration harness touches this — a
 *  probe needs an empty corridor or the traffic eats the rounds it is counting. */
let contentSpawning = true;

/**
 * THE CONDUCTOR. One cursor decides everything that enters the corridor, so two
 * things can no longer land on the same plane — see mechanics/director.ts for
 * what this replaced and why three independent timers could not be made to fit.
 */
const director = createDirector();
/** Reused every gate placement so the corridor never allocates inside tick(). */
const gateBuffer: number[] = [0, 0, 0, 0];
/** The director's own stream, kept apart from the gate module's so that tuning
 *  gate variety cannot silently reshuffle the corridor's pacing. */
const rowRng = createRng(0xc0ffee);

/**
 * What the next barrel carries.
 *
 * Recruits are the common case, because crowd size is the run's main currency
 * and a weapon on every barrel would make firepower the only thing that
 * mattered. Weapons are the treat: rarer, and worth steering for.
 */
const PICKUP_ODDS: readonly PickupKind[] = [
  "recruit",
  "recruit",
  "recruit",
  "minigun",
  "recruit",
  "recruit",
  "rocket",
];
let pickupCursor = 0;

function pickForRow(): PickupKind {
  // Walked rather than rolled, so a run cannot go two minutes without a weapon
  // on a bad streak of luck — the same reason gate rows are authored.
  const kind = PICKUP_ODDS[pickupCursor % PICKUP_ODDS.length]!;
  pickupCursor++;
  return kind;
}

/** Walker toughness tracks the army, for the reason in mechanics/pacing.ts. The
 *  floor is the old fixed value, so the opening is unchanged. Barrels no longer
 *  carry elites at all — they carry pickups — so only walkers need this. */
function walkerHp(): number {
  return enemyHp(world.troops, tierFor(world.troops), bullets.tuning, squad.radiusX, WALKER_PASS_SHARE, 4);
}

/**
 * A world X for a cluster of `width` metres, biased toward `side` when the
 * director wants this lined up with something. Always leaves `PLACE_INSET` of
 * road outside it so nothing straddles a kerb.
 */
function clusterX(width: number, side: number): number {
  const reach = Math.max(0, CORRIDOR_HALF_WIDTH - width / 2 - PLACE_INSET);
  if (reach <= 0) return 0;
  const dir = side !== 0 ? Math.sign(side) : rowRng() < 0.5 ? -1 : 1;
  return dir * reach * (0.35 + rowRng() * 0.65);
}

/**
 * Centre a cluster of at most `max` items inside the stretch of road between
 * `from` and `to`, dropping items until it fits. Returns the centre and how many
 * survived; 0 means the stretch is too narrow for even one.
 *
 * THIS IS THE FIX FOR THE FLOATING GOLD OBJECTS. A compound placement put its
 * barrel cluster on "the other side" of the gate row, which is not the same
 * thing as "in the road the gate row left over": a 5.6 m cluster placed against
 * the far kerb still overlapped a row reaching past the centreline, so barrels
 * ended up INSIDE a gate panel — hidden by it, while the pickup they were
 * carrying hovered above the barrier in its gold ring with nothing under it.
 * Reported, reasonably, as floating artifacts.
 */
function fitCluster(
  from: number,
  to: number,
  max: number,
  spacing: number,
  itemWidth: number,
): { x: number; count: number } {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const room = hi - lo;
  let count = max;
  while (count > 1 && (count - 1) * spacing + itemWidth > room) count--;
  if ((count - 1) * spacing + itemWidth > room) return { x: 0, count: 0 };
  return { x: (lo + hi) / 2, count };
}

/**
 * `side` is the director's lateral request: −1 left, +1 right, 0 free. It is how
 * a guard gets lined up with the prize it is guarding — see mechanics/director.ts.
 */
function place(what: Placement, z: number, side = 0, free?: { x: number; count: number }): void {
  switch (what) {
    case "gate": {
      const count = composeAutoRow(rowRng, world.elapsed, world.troops, gateBuffer);
      gates.spawnRow(gateBuffer, z, rowPlacement(rowRng, count, side));
      return;
    }

    case "barrels": {
      rowIndex++;
      const hp = barrelHp(
        rowIndex,
        world.troops,
        tierFor(world.troops),
        bullets.tuning,
        squad.radiusX,
      );
      const width = (BARREL_CLUSTER - 1) * BARREL_SPACING + BARREL_FACE;
      const cx = free ? free.x : clusterX(width, side);
      const n = free ? free.count : BARREL_CLUSTER;
      for (let i = 0; i < n; i++) {
        const x = cx + (i - (n - 1) / 2) * BARREL_SPACING;
        const lane = x / CORRIDOR_HALF_WIDTH;
        const rider = pickups.spawn(pickForRow(), x, barrels.riderY, z);
        // If the barrel pool is full there is nothing for the prize to sit on,
        // and an unpinned pickup is a gold-ringed object hovering over the road.
        if (barrels.spawn(lane, z, hp, rider) < 0 && rider >= 0) pickups.retire(rider);
      }
      return;
    }

    case "walkers": {
      // A pack is ~2 m across, so it is a thing standing in one part of the road
      // rather than a line across it. That is what lets it guard an approach.
      const lane = clusterX(2.2, side) / CORRIDOR_HALF_WIDTH;
      enemies.spawnPack(lane, z, 8, walkerHp());
      return;
    }

    // ---- compound placements: two things on ONE plane, on opposite sides ----
    //
    // Everything above is sequential, and sequential content cannot force a
    // choice: the crowd only has to be in one place at the moment each row
    // arrives, so it can take the best of every row in turn. These two put both
    // options on the same plane, where taking one is not taking the other.

    case "blockade": {
      // The gate takes one side; the walkers stand in the gap on the other, so
      // the clear road is not clear. Pay the row, or fight through the bodies.
      const dir = side !== 0 ? Math.sign(side) : rowRng() < 0.5 ? -1 : 1;
      const count = composeAutoRow(rowRng, world.elapsed, world.troops, gateBuffer, COMPOUND_SEGMENTS);
      const placed = rowPlacement(rowRng, count, dir);
      gates.spawnRow(gateBuffer, z, placed);
      // Middle of whatever road the row left over, so the pack stands squarely
      // in the way of the dodge rather than off beside it.
      const inner = placed.centerX - dir * placed.halfSpan;
      enemies.spawnPack(
        (-dir * CORRIDOR_HALF_WIDTH + inner) / 2 / CORRIDOR_HALF_WIDTH,
        z,
        8,
        walkerHp(),
      );
      return;
    }

    case "crossroads": {
      // Bodies or firepower. The row pays troops, the barrels carry a pickup,
      // and they are on opposite kerbs — this is the beat that teaches that a
      // run heavy in one axis and empty in the other is a choice you made.
      const dir = side !== 0 ? Math.sign(side) : rowRng() < 0.5 ? -1 : 1;
      const count = composeAutoRow(rowRng, world.elapsed, world.troops, gateBuffer, COMPOUND_SEGMENTS);
      const placed = rowPlacement(rowRng, count, dir);
      gates.spawnRow(gateBuffer, z, placed);
      // Into the road the ROW left over, not merely onto the far kerb — see
      // fitCluster. A cluster that does not fit sheds barrels rather than
      // straddling the barrier.
      const inner = placed.centerX - dir * placed.halfSpan;
      const fit = fitCluster(
        -dir * (CORRIDOR_HALF_WIDTH - PLACE_INSET),
        inner - dir * CLUSTER_CLEARANCE,
        BARREL_CLUSTER,
        BARREL_SPACING,
        BARREL_FACE,
      );
      if (fit.count > 0) place("barrels", z, -dir, fit);
      return;
    }
  }
}

/**
 * Metres of road the corridor is pre-filled with at the start of a run.
 *
 * The gate module used to prime three rows itself so the run never opened on an
 * empty road (`frame_000` has two rows already stacked). That went with its
 * auto-spawn, so the director has to do it — and doing it by REPLAYING the
 * director means the opening layout obeys exactly the same spacing rule as
 * every metre after it, rather than being a hand-placed special case that can
 * drift away from the real thing.
 *
 * 40 m leaves the nearest placement ~18 m out, about three seconds at the
 * default speed: enough to read the first decision before having to make it.
 */
const PRIME_SPAN = 40;

/**
 * Fill the visible corridor as if the run had already been going for
 * PRIME_SPAN metres. An item placed `d` metres into that replay has had
 * `PRIME_SPAN - d` metres to travel, which is exactly where it is put.
 */
function primeCorridor(): void {
  const step = 0.5;
  for (let d = 0; d < PRIME_SPAN; d += step) {
    const due = director.advance(step);
    if (due) place(due.what, SPAWN_Z + (PRIME_SPAN - d), due.side);
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

/** Runs lost since boot. The failure-rate target is a ratio of runs, so it has
 *  to be counted rather than inferred from a troop curve. Read by the autopilot. */
let wipes = 0;

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
  director.reset();
  rowIndex = 0;
  pickups.clear();
  pickupCursor = 0;
  world.elites = 0;
  world.gunners = 0;
  world.rocketeers = 0;
  armCarriers();
  primeCorridor();
  zoom.reset(world.troops);
  world.zoom = zoom.distance;
}

/**
 * Muzzle scratch buffer, allocated once. One entry per possible stream: the
 * squad reports where each soldier's rifle actually is, and bullets fires one
 * stream from each, which is what makes "20 troops = 20 streams" true by
 * construction rather than by a rate curve pretending to be density.
 */
const shooters = Array.from({ length: MAX_STREAMS }, () => new THREE.Vector3());
/** Parallel to `shooters`: what each of them is carrying. Allocated once. */
const shooterKinds = new Uint8Array(MAX_STREAMS);

/** Hoisted so the per-tick rider seating allocates nothing. */
function seatRider(_id: number, tag: number, x: number, topY: number, z: number): void {
  if (tag >= 0) pickups.pin(tag, x, topY, z);
}

// ── Collision ──────────────────────────────────────────────────────────────

const BARREL_PAD = 0.2;
/** Gates span the road, so lateral tolerance matters less than depth; this is
 *  just enough that a round grazing a segment edge still counts. */
const GATE_PAD = 0.1;
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

    // GATES FIRST, AND THEY STOP THE ROUND. A barrier is a physical thing: the
    // stream ends at the nearest standing one and only reaches what is behind
    // once that has come apart. A blue grows as it soaks fire and breaks itself
    // at its ceiling, which is what opens the lane.
    if (gates.shootAt(x, z, GATE_PAD, dmg)) {
      bullets.consume(id, x, y, z);
      continue;
    }

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

    // Before anything spawns: the gate module sizes a reward's target off what
    // the guns can actually deliver, and only this file knows the weapon model.
    gates.reportFirepower(
      damageOnSegment(world.troops, tierFor(world.troops), bullets.tuning, squad.radiusX),
    );

    if (contentSpawning) {
      // Distance, not time. Spacing is authored in metres of road, so it holds
      // even if the world speeds up or slows down.
      const due = director.advance(world.scrollSpeed * dt);
      if (due) place(due.what, SPAWN_Z, due.side);
    }

    // 1. Squad first: it writes world.squadCenter, which everything below reads.
    squad.update(dt, world);
    // Immediately after, while the bodies that just arrived or fell are current.
    drainSquadEvents();

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
    const reported = squad.sampleShooters(shooters, MAX_STREAMS);
    bullets.setShooters(shooters, reported);
    // Immediately after, against the same buffers: which of those soldiers is
    // carrying what, so a rocketeer's stream actually fires rockets.
    bullets.setShooterKinds(shooterKinds, squad.sampleShooterKinds(shooterKinds, MAX_STREAMS));
    bullets.update(dt, world);

    // 3. Targets move, then get shot — so a hit lands where the barrel is now,
    //    not where it was last tick.
    barrels.update(dt, world);
    enemies.update(dt, world);
    // BEFORE the seating pass, and it has to be here: pickups was in
    // `renderables` (so it drew) but its update was never called, which is the
    // whole of the "floating objects" bug. Without a tick its clock never
    // advanced, so the staleness retirement never fired; its previous-position
    // history never refreshed, so render interpolated against a frozen frame;
    // and a collected prize never flew, never landed and never retired. A gold
    // ring simply stopped in mid-air while its barrel drove on underneath.
    pickups.update(dt, world);
    barrels.forEachLive(seatRider);
    resolveHits();

    // 4. Gates resolve against the settled squad position.
    gates.update(dt, world);

    // 5. Feedback last: it reacts to everything above, within the same tick.
    floaters.update(dt, world);
    growthFx.update(dt, world);
    bossBar.update(dt, world);
    // Last of the readouts, so it reports the count this tick actually ended on.
    troopCount.update(dt, world);
    loadout.update(dt, world);
    netPop.update(dt, world);

    scrolled += world.scrollSpeed * dt;

    // Last, so it steps on the count this tick actually ended with — a gate
    // that pays 200 troops should move the camera on the same beat the +1s
    // bloom, not one tick later.
    zoom.update(dt, world.troops, squad.center.x);
    world.zoom = zoom.distance;

    if (world.troops <= 0) {
      wipes++;
      resetRun();
    }
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
// The corridor has to be stocked before the first frame, or the run opens on an
// empty road and the player waits three seconds for anything to happen.
primeCorridor();
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
function probeDamagePerPass(troops: number, lane = 0, barrelLane = lane): {
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

  // `barrelLane` defaults to the squad's own lane — the head-on case. Passing a
  // different one measures COVERAGE: with fire travelling as a parallel curtain,
  // a barrel off to one side takes only the share of the stream that overlaps
  // it, which is the mechanic the whole width of the crowd now buys.
  const id = barrels.spawn(barrelLane, SPAWN_Z, PROBE_HP);
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
 * Run `seconds` of play with a simple autopilot steering at the best segment of
 * the nearest gate, and report the troop curve. Dev-only, like the probe.
 *
 * "Steer at the biggest number" is not a good player, and that is the point: it
 * is a REPEATABLE one. A growth target and a failure rate are both properties of
 * the content rather than of anybody's thumbs, so measuring them needs a hand
 * that plays the same way every time.
 */
function autopilot(seconds = 120, sampleEvery = 5, reaction = 0.3) {
  const dt = 1 / 60;
  const ticks = Math.round(seconds / dt);
  const samples: { t: number; troops: number }[] = [];
  const before = wipes;
  let peak = world.troops;
  let worstDrop = 0;
  let prev = world.troops;
  // REACTION TIME, because a bot that re-decides sixty times a second is not a
  // measurement of the game — it is a measurement of the game played perfectly.
  // At reaction 0 the autopilot wiped 0 runs in 16 while a human playtester was
  // losing armies, and tuning the difficulty until an optimal player dies would
  // have made the game unplayable for anyone else. Re-deciding every ~0.3 s puts
  // it in the range a thumb actually operates in, and it is the setting the
  // brief's per-level failure rates should be read against.
  let sinceDecision = Infinity;
  for (let i = 0; i < ticks; i++) {
    sinceDecision += dt;
    if (sinceDecision >= reaction) {
      sinceDecision = 0;
      const want = gates.bestLane();
      if (!Number.isNaN(want)) touch.lane = clamp(want, -1, 1);
    }
    tick(dt);
    peak = Math.max(peak, world.troops);
    // Biggest single-tick loss as a share of what was standing. A wipe is the
    // tail of this distribution, so watching it is how a change to the penalty
    // model gets judged on more than one unlucky run.
    if (prev > 0) worstDrop = Math.max(worstDrop, (prev - world.troops) / prev);
    prev = world.troops;
    if (i % Math.max(1, Math.round(sampleEvery / dt)) === 0) {
      samples.push({ t: Number((i * dt).toFixed(1)), troops: world.troops });
    }
  }
  return {
    samples,
    wipes: wipes - before,
    peak,
    worstDrop: Number(worstDrop.toFixed(3)),
    final: world.troops,
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
      /** The live scene graph. For asking what is ACTUALLY in the world rather
       *  than what a module believes it drew — the only way to chase down a
       *  stray instance without a module volunteering a debug accessor. */
      scene: stage.scene,
      probeDamagePerPass,
      /** Sweep the probe across troop counts. This is the barrel HP curve. */
      damageCurve(counts: readonly number[] = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120]) {
        return counts.map((n) => probeDamagePerPass(n));
      },
      setSpawning(on: boolean): void {
        contentSpawning = on;
      },
      /** Drop one placement at an exact Z, bypassing the director. For posing a
       *  single piece of content in an otherwise empty corridor — the only way
       *  to photograph one thing without the rest of the road in frame. */
      place(what: Placement, z = SPAWN_Z): void {
        place(what, z);
      },
      autopilot,
      /**
       * Play `runs` fresh runs of `seconds` each and report the distribution.
       *
       * The brief specs a failure RATE — 1 in 8 at levels 1–2 — and a rate is
       * not a thing one run can measure. Half the tuning arguments on this
       * project have been about whether a single unlucky playthrough meant the
       * economy was wrong; this is what replaces that with a number.
       */
      sample(runs = 12, seconds = 110, reaction = 0.3) {
        const out: { final: number; peak: number; wiped: boolean }[] = [];
        for (let r = 0; r < runs; r++) {
          const before = wipes;
          resetRun();
          world.elapsed = 0;
          const run = autopilot(seconds, seconds, reaction);
          out.push({ final: run.final, peak: run.peak, wiped: wipes - before > 0 });
        }
        const finals = out.map((r) => r.final).sort((a, b) => a - b);
        return {
          runs: out.length,
          wiped: out.filter((r) => r.wiped).length,
          median: finals[Math.floor(finals.length / 2)],
          min: finals[0],
          max: finals[finals.length - 1],
          peaks: out.map((r) => r.peak),
          finals,
        };
      },
      /** Face values of every live unresolved gate segment, nearest row first. */
      gateValues(): number[] {
        return gates.debugValues();
      },
      /** Place an exact gate row, for testing how a wide crowd resolves it. */
      spawnGate(values: number[], z = SPAWN_Z): void {
        gates.spawnRow(values, z);
      },
      /** Every payout since the last clear, as [troops, wasReward] pairs. */
      payouts(): { troops: number; value: number; share: number; reward: boolean }[] {
        return payoutLog.slice();
      },
      clearPayouts(): void {
        payoutLog.length = 0;
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
        if (world.elites > world.troops) world.elites = world.troops;
      },
      setElites(n: number): void {
        world.elites = clamp(Math.round(n), 0, world.troops);
        armCarriers();
      },
      /** Arm N troops with each weapon. For posing the crowd in a screenshot. */
      setCarriers(gunners: number, rocketeers: number): void {
        world.gunners = clamp(Math.round(gunners), 0, world.troops);
        world.rocketeers = clamp(Math.round(rocketeers), 0, world.troops);
        armCarriers();
      },
      setLane(n: number): void {
        touch.lane = clamp(n, -1, 1);
      },
      pay: payTroops,
      stats: () => ({
        troops: world.troops,
        elites: world.elites,
        gunners: world.gunners,
        rocketeers: world.rocketeers,
        firepower: Number(world.firepower.toFixed(2)),
        fireRate: Number(world.fireRate.toFixed(2)),
        tier: world.weaponTier,
        elapsed: Number(world.elapsed.toFixed(2)),
        squadX: Number(squad.center.x.toFixed(2)),
        radiusX: Number(squad.radiusX.toFixed(2)),
        calls: stage.renderer.info.render.calls,
        zoom: Number(world.zoom.toFixed(3)),
        radiusZ: Number(squad.radiusZ.toFixed(2)),
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
