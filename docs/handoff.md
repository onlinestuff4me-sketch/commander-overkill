# Where the work stands

_Last updated: 2026-09-08, session 3 (seventeenth pass)._

> The next session gets this repo and nothing else. **If it is not in a file, it
> is gone.** Rewrite this file rather than appending to it — a handoff that is
> allowed to grow into a changelog ends up describing a game that no longer
> exists.

**Repo:** `onlinestuff4me-sketch/commander-overkill`, public, `main`.
**Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/ — redeploys
on every push to `main` via `.github/workflows/deploy.yml`.
**Verified at HEAD:** `npx tsc --noEmit` exits 0; `npm test` is 62 passing;
`npm run build` succeeds; the page loads with no console errors. 84 draw calls
and 79k triangles at 37 troops; the turn dust adds exactly one draw call.

**A LEVEL IS AN APPROACH AND THEN A BOSS RUSH.** It builds to something:

- **APPROACH** — `300 + 40×(level−1)` metres of corridor, about fifty seconds at
  level one. Gates, barrels and whatever enemies this level has unlocked. **No
  bosses at all.** This is where the army is built and the only place it can be.
- **RUSH** — the corridor stops, the road empties, a banner fires, and the
  level's bosses arrive back to back with a horde each, 1.4 s apart. One boss at
  level one, two by level two, four by level six.
- Then the card, one permanent upgrade, and the next level from scratch.

The first version counted two boss kills while the conductor scattered bosses on
a 210 m cadence, which made them punctuation rather than a destination. Mischa's
note was exact and the restructure came from it: *"it doesn't look like we have a
big boss and horde moment that you have to beat that culminates the level."*

**A BOSS THAT BREAKS THROUGH STILL COUNTS AGAINST THE RUSH.** It cost the army a
fifth of itself on the way past; requiring a kill would let a weak army stall
forever on a level it can then never finish. The level must terminate whatever
happens, and the punishment is the blood, not the deadlock.

**EACH LEVEL UNLOCKS SOMETHING.** `Beat.unlock` in `mechanics/director.ts` gates
the roster: level 1 is gates, barrels and walkers and nothing else; elites and
blockades arrive on 2, bikers and forks on 3, ogres and crossroads on 4, `surge`
on 5. The perk pool grows the same way — three ranks of three things is a shallow
upgrade path, so FIELD MEDICS unlocks on 3 and SALVAGE CREW on 4, and a
newly-unlocked perk is always on the card the level it unlocks. Medics are capped
at 45% of every casualty on purpose: losses are the only thing that ends a run,
so an uncapped defensive perk is the one you take three times and stop being able
to lose.

**Measured**, `__overkill.sample(32, 110, 0.3)`: **32 of 32 runs clear exactly
one level** in 110 seconds, and **0–2 of 32 wipe** across samples.

**THE WIPE RATE IS BELOW THE BRIEF AND I CANNOT RESOLVE IT AT n=32.** The target
is 1 in 8 for levels 1–2. Consecutive samples of the same build gave 2 and then
0; earlier the horde looked like a sharp lever (5 wipes at four packs against 2
at two packs) and then four packs measured 0. Counts this small carry more noise
than the effect being chased. Either sample much larger, or — better — get this
in front of a person, because the bot crosses a gate row about ten times in a
hundred seconds and never dodges anything it has not been told about.

**The failure mode is a STALL, not a wipe.** `min` is 1 in most samples: a run
that never grew, because filling a reward needs committed fire and a squad that
misses its first few blues stays too small to fill the next. Nothing ever reaches
zero troops, so `wiped` stays 0 while the run is over in every way that matters.
Count stalls alongside wipes when the level system lands.

**The game can now kill you, and that is new.** For most of this project the
wipe rate was a flat zero: since a row can be walked around, a player who read
the board correctly could not be killed, and every option was upside against less
upside. The punishing reward changed that — walking into a blue you have not
filled TAKES the number instead of giving it, so a bad commitment is now a loss
rather than a missed gain. Bosses added the other half: one that breaks through
takes a fifth of the army in a single hit. 4 of 32 is the brief's early-level
band, but it is a flat rate across the whole run — it still needs **levels** (see
#1) to put the difficulty somewhere in particular rather than everywhere equally.

**A BEAT THAT SOAKS FIRE CAN MAKE A RUN EASIER, WHICH IS BACKWARDS AND WORTH
KNOWING.** The two ogre beats went in at weight 2 and the wipe rate fell from 4
in 32 to 0 — not because ogres are harmless, but because a beat displaces other
beats, and these two displaced enough `fork` and `surge` (the phrases that
actually take armies apart) to soften the whole mix. At weight 1 the rate is back
to 4. Whenever you add a beat, re-measure: the thing you added is only half of
what changed.

`sample()` takes a reaction time because a bot re-deciding sixty times a second
measures the game played perfectly; 0.3 s is the setting the brief's per-level
failure bands should be read against.

**THE DESIGN DIRECTION IS SETTLED: primitives only, indefinitely.** Mischa's
call — the pitch is Roblox rather than realism, and the fun comes from dynamism,
consequence and "I did not think that would happen". Three rules fall out of it
and they are written up in the gap analysis: every prize needs a visible chain
(prize → how troops use it → what it does to the world), anything a primitive
cannot say gets a text label, and every idea is judged by whether someone would
clip it. Do not reopen the art question.

**Where PROGRESSION goes next:**
[`docs/progression-research.md`](progression-research.md) is the Last War /
Top War / Last Shelter / Puzzles & Survival teardown, with seven patterns ranked
by what they would do for a ninety-second run. Nothing from it is built. Item 1c.

**Where the LOOK still falls short:**
[`docs/reference/gap-analysis.md`](reference/gap-analysis.md) audits our build
against the reference game screen by screen and ranks what to build. Its headline
finding — that the WORLD was the gap, a suspension bridge over water against our
grey strip on a green field — **is now built** (`mechanics/lane.ts`: water deck,
railings, scrolling towers, hangers), and so are **bosses** — three of them, in
`entities/boss.ts`. What is still open on that list is the rest of the prize
chains (flamethrower, mortar, shield bearer, drone, magnet), a FLYING enemy, and
the chibi soldier proportions.

Read [`CLAUDE.md`](../CLAUDE.md) before touching anything. It holds the npm
guardrails, the architecture invariants, and how to verify work.

---

## Resume here

Ranked. Nothing here is blocked on Mischa except items 3 and 4, which are
product calls rather than engineering ones.

### 1. Tune the level ramp — the structure is built, the numbers are not

A level is **two boss kills**; it starts the army at `1 + 8×(level−1)` plus perks,
and it runs the row composer at a difficulty clock of `elapsed + 25×(level−1)`
seconds, so level 3 opens where level 1 was a minute in. Clearing one puts up a
card with the run's stats and three permanent upgrades; losing one offers RETRY
(keeps the level and the perks) or START OVER.

Rather than rewrite `PENALTY_BANDS` and `ROW_WIDTHS` to take a level — a change
that would have invalidated every measurement this project has made — a level
ADDS to the elapsed time the composer is told about. Same tables, same tuning, a
new axis. `ROW_WIDTHS` is still the strongest untouched lever if the bands need
to diverge from the clock.

What needs doing, in order:

1. **The wipe rate is too low and the instrument cannot see it.** See the note at
   the top: 0–2 in 32 against a target of 4, on samples that disagree with each
   other. This wants a human, not another sample.
2. **The per-level failure bands are unmeasured.** The brief wants 1 in 8 at
   levels 1–2 easing to 1 in 3 by 16–21; `sample()` reports one blended rate and
   every run clears exactly one level, so levels 3+ are untested by anything.
3. **Level one is 57 seconds.** Later levels are longer by construction (more
   approach, more bosses) — level six works out around 133 s — but the early
   ones sit under the brief's 90-second floor.

### 1a. Second-to-second play — the first two are BUILT; five remain

[`docs/dynamism-proposal.md`](dynamism-proposal.md) measures what the run
currently asks of the player and proposes seven changes, ordered. The measurement
is the part to keep: over a two-minute run the conductor places 39 things, 27 of
them decisions, a median 3.2 s apart, and the decision is "choose a lane and
watch it resolve". Two seconds in every three have no input in them.

The diagnosis in one line: **nothing in this game created tension between moving
and staying.** Moving was free, staying was free, so between rows the correct
play was to do nothing.

**The STREAK and the COMMANDER are shipped; the ABILITY was built and then cut**
(see the decisions below). What is still open from the proposal, in its order:
compound placements as the default rather than 5 of 39, drifting motes to chase
in the dead seconds, and hazards that move sideways.

### 1c. The progression research is done and nothing has been built from it

[`docs/progression-research.md`](progression-research.md) is a teardown of Last
War: Survival, Top War, Last Shelter and Puzzles & Survival, written to Mischa's
brief: what those games do for upgrading, progressing, unlocking troop and weapon
types and allies, and fighting hordes and bosses. The health warning at the top
of it is the important part — all four are 4X base-builders whose progression is
paced for a session a day, so nothing lifts directly.

Seven patterns survive the translation. The two I would build first:

1. **COUNTERS.** Rifle, minigun and rocket are currently a straight line — a
   rocketeer is a rifleman who does more damage — so nothing on the road cares
   which you brought. One enemy with armour only rockets open and one fast enough
   that only the minigun's rate catches it turns every upgrade card from "take
   the biggest number" into "what is this level going to throw at me". No new
   art; the enemies already exist.
2. **AN ALLY YOU RESCUE.** Last War's Drone is a unit you unlock once and then
   have forever, fighting beside you. A cage on the road you shoot open, and a
   drone runs with you for the rest of the level, is the most visible upgrade
   this game could get and it lands in the slot the existing prizes already use.

The rest — fragments, visible merges, front-and-back formation, one new noun per
level, rarity colour — are ranked in the doc with reasons.

### 1b. Nothing on the road punishes you for being big

The crowd's lateral speed eases from 7 m/s down to 5 m/s past 400 troops, which
is the only cost of size in the game. It is not enough to make growth a real
decision. The obvious next lever is content that scales with the army rather than
with the clock — a barrier a small squad can slip past and a large one cannot,
which the geometry now supports and nothing generates.

### 2. Decide the camera ANGLE — still blocks accurate calibration

Unchanged, still undecided, still needs Mischa. Note this is the camera's
ANGLE, which is separate from the stepped zoom added this session — the zoom
dollies along the existing view axis precisely so it does not touch the angle
or any of the bases baked from it.

**The reference camera sits ~43° above the horizon. Ours sits at 22°**
(`src/core/renderer.ts`, `CAMERA_POS`/`CAMERA_LOOK`). We *compensate* inside
world-space geometry — the squad's `DEPTH_RATIO = 1.6` exists purely to make a
22° camera produce a 43° camera's silhouette. That taxes every future
measurement: each ratio read off a reference frame has to be divided out by
their camera and re-applied through ours.

**It is not free.** Gates, barrels, bullets and the squad are all calibrated
against the current framing. Changing the camera invalidates all of it and needs
a re-measure pass per module. Treat it as its own milestone, not a one-line edit.

### 3. The squad splits at ~60 in the reference; we still cannot express it

The reference does not solve a crowd outgrowing its road by deepening — **it
splits into two groups at ~60**, which is what the second health bar in
`frame_035` is.

**This got less urgent, twice over.** The steering half was fixed earlier (the
centre travels the full road and a wider crowd simply overhangs it), and the road
is now 11.2 m rather than 6.8 m, so the crowd does not fill it until ~250 troops
instead of ~120. What remains is that one blob past that point can only get
deeper, and deep is the axis this camera reads worst.

**Contract change required if it is ever wanted:** `squadLane` and `health` in
`src/core/types.ts` become per-group. **Product question for Mischa:** does one
input steer both groups together, or select between them?

Worth saying plainly: the stepped zoom and the wider road may have made this
unnecessary. 500 troops now fit on screen as one crowd. Do not build the split
until something actually fails without it.

### 4. The RPG layer has three pieces now — the rest is untouched

`world.firepower`, `world.fireRate` and `world.elites` are the QUALITY axis,
raised only by pickups off barrels, and all three are deliberately kept out of
the barrel and enemy hit-point models so an upgrade is a real advantage rather
than something the difficulty curve immediately eats. Crowd size is the quantity
axis. Those being separate is what makes "a big weak army" and "a small elite
one" expressible at all — `tierFor(troops)` previously made quality a pure
function of quantity. `ui/loadout.ts` is the readout; it draws nothing until you
have actually picked something up.

An elite is a COUNT, not a set of soldiers: nothing tracks which body is which,
the squad paints `world.elites` of them spread through the crowd, and they are
worth `ELITE_SHOOTER_WEIGHT` (4) rifles each. That is also why they are the last
thing you lose — ordinary losses shrink the crowd around them.

Gunners and rocketeers now have their own visible kit and their own projectile.
Elites still do not — they are a tint and a scale, so a hundred of them look like
a stronger version of the same soldier. Giving them a distinct body is the next
step on this axis, and the carrier meshes are the pattern to copy.

### 4b. Bosses exist now, and the two things they still want

Three archetypes are built (`entities/boss.ts`), scheduled by distance, wired to
the boss bar, and measured. What they do not have yet:

- **An end-of-level boundary to sit on.** They currently arrive every 210 m
  forever, which is a rhythm rather than a structure. The natural home for a boss
  is the end of a level (item #1), and the ramp constants (`BOSS_RAMP_BASE`,
  `BOSS_RAMP_STEP` in `main.ts`) are already shaped like a per-level difficulty
  table waiting to be indexed by one.
- **A fourth archetype that attacks at RANGE.** All three resolve at a distance
  the crowd can shoot back from, so the answer to every one of them is "point the
  guns and maybe step sideways". The gap analysis's Spitter — arcing globs that
  leave a lingering zone on the deck — is the one that would make the player move
  rather than aim, and the machinery for it (telegraph, danger decal, strike
  callback) is all in place.

### 5. Nothing else from the RPG layer exists yet

The brief's actual differentiator is untouched: commander skills on cooldowns,
tactical airstrikes, unit evolution trees, formations, the progression shop, and
Commander Overkill's radio dialogue. `src/rpg/` and `src/systems/` are empty
directories. So is audio. See `PLAN.md` Phase 2.

---

## What shipped

Five element modules, built in parallel by agents blind to each other, composed
against the `WorldState`/`System` contract without a single interface change.

| Module | State |
|---|---|
| `entities/squad.ts` | Instanced crowd, 181 tris/unit with rifle and arms, 4 draw calls at any count. Vogel-spiral layout, per-unit springs, drop shadows, HP bar. Fills the road and overhangs it under steering; depth cap scales with the camera zoom. Per-instance tint: crimson death flash, gold elites at 1.5× scale. Carries the minigun and launcher kits on the shoulder at `KIT_SCALE`. |
| `mechanics/bullets.ts` | One stream per soldier, golden-ratio phase offsets, three weapon tiers, pooled at 768. Fires a **parallel curtain** — convergence is off. Rockets are real geometry on their own instanced mesh, fired at a third the rate for six times the damage. Exports the derived damage model. |
| `mechanics/gates.ts` | Segmented red/blue barriers, heavy outlined numerals, the climbing blue reward, burst on pass or on hitting its ceiling. Blocks fire per segment. Row composition and the reward span are pure exported functions. |
| `mechanics/director.ts` | The conductor. One cursor owns every placement in the corridor, in weighted beats with pair-dependent spacing, and now with a lateral SIDE per placement — which is what lets a beat put a guard in front of a prize or two prizes on opposite kerbs. Pure, seeded, tested. |
| `ui/troopcount.ts`, `ui/netpop.ts`, `ui/loadout.ts` | Army size top-left, the net `+14`/`−12` over the crowd, and what you are carrying. All DOM, all silent until they have something to say. |
| `mechanics/pacing.ts` | Barrel hit points, payouts, and the lane-coverage model. Pure arithmetic, no three.js, fully tested. |
| `entities/barrels.ts` | Numbered destructible cover that counts down under fire, chunky plank debris, riders that drop when it dies. |
| `entities/enemies.ts` | Instanced walkers, gold rim-lit elites, motorcycle variant, HP bars. **Its `elite` is an ENEMY kind** and has nothing to do with `world.elites`, which is the player's gold veterans. Unfortunate collision; rename the enemy one if it ever causes a bug. |
| `ui/floaters.ts`, `entities/growthfx.ts` | Per-unit yellow `+1` popups that rise and red `-1`s that fall out of frame, screen-space separated, one draw call. Orbiting cyan swirl. |
| `ui/bossbar.ts` | DOM, safe-area aware, eases and pops on damage. |
| `entities/pickups.ts` | What rides a barrel: a recruit, a minigun or a rocket launcher, each under a plate reading its own name. Gold-rimmed, hovering, flies into the crowd when its barrel breaks. |
| `mechanics/lane.ts` | The bridge: deck over water, railings, hangers, and suspension towers that scroll and recycle. Owns `CORRIDOR_HALF_WIDTH`, which every placement is measured against. |
| `ui/levelcard.ts` | The level pill, the cleared/failed screen, and the three upgrade cards. Reports which button was pressed; owns none of the run. |
| `ui/streak.ts` | The multiplier chip, top right. Counts rows the player came out ahead on; one bad row resets it. |
| `ui/commander.ts` | The Commander. Files reports after things resolve, never during, and never twice running. |
| `core/look.ts` | The house material. One place that decides everything in the game is made of shiny plastic. Objects use it; the road, water and bridge do not. |
| `entities/boss.ts` | The three bosses, one alive at a time. Owns its own figures, name plate, attack label, danger decal and death. Reports that a strike landed; never touches `world.troops`. |
| `core/zoom.ts` | Stepped camera dolly tied to troop count, with hysteresis, plus a damped lateral pan that follows the crowd. Both are pure translations. Scales the squad depth cap and the fog with the dolly. |
| `core/*`, `input/touch.ts` | Fixed-60Hz loop with render interpolation, state machine, event bus, single-thumb relative drag. |

---

## How the difficulty curve works now

**Barrel hit points are derived, not fitted.** This is the change most likely to
be undone by accident, so it is worth understanding before touching a fire rate.

`damagePerPass(tier, troops, tuning)` in `mechanics/bullets.ts` is the army's
TOTAL output over one barrel-approach, wherever it lands. It is
`shots/second × damage/bullet × 4.25`, and that 4.25 is **measured, not
derived** — damage divided by the shot rate that produced it is flat at 4.25
seconds across every tier and every count from 1 to 1200, to within 4%. It was
then confirmed predictively: after tier 2 was re-tuned it called the new numbers
to under 1% before they were measured.

`laneCoverage(halfWidth)` is the second half, and it exists because the fire
stopped converging: a barrel intercepts only the share of a curtain that can be
over 5 m wide, so total output and where it lands are modelled separately. Keep
them separate — folding them together lets an error in one hide inside the
other. Measured against the probe: 0.69 at 20 troops (model 0.73), 0.57 at 120
(model 0.51).

`barrelHp()` in `mechanics/pacing.ts` takes the **lower** of an authored ladder
(`4 × row^1.5`, capped at 250 so the numeral stays readable) and 55% of that
pass. So a large army meets the authored number and melts it — the power fantasy,
and what `frame_035` shows — while a small army meets a barrel scaled to what it
can actually chew through. The old `10 + rowIndex * 8` scaled with the row and
not the squad, and was therefore impossible for a weak army that had survived a
while and irrelevant to a strong one.

**Consequence worth keeping:** changing a fire rate no longer silently
invalidates every barrel in the game. It carries itself.

**The gate opening is authored.** `MERCY_TROOPS = 10` in `mechanics/gates.ts`:
below ten troops every row is guaranteed a blue segment and penalties stay in the
mildest pool however long the run has gone on. That is what pays for
`START_TROOPS = 1`. Both random draws still happen under mercy, so a seeded run
stays reproducible across the moment the squad crosses the threshold.

---

## How to measure things here

`npm run dev`, then in the browser console (dev builds only, stripped from
production):

```js
__overkill.step(ticks)       // advance N fixed steps, then draw once
__overkill.setTroops(n)
__overkill.setLane(-1..1)
__overkill.pay(n)            // triggers the full growth beat
__overkill.stats()           // troops, tier, draw calls, triangles
__overkill.bulletStats()     // live rounds and their extent — density vs reference
__overkill.setSpawning(bool) // suspend content pacing
__overkill.setElites(n)      // gold veterans, worth 4 rifles each
__overkill.probeDamagePerPass(troops)  // measured damage over one barrel approach
__overkill.damageCurve()     // that swept across troop counts
__overkill.autopilot(secs, sampleEvery, reaction)  // one run; troop curve
__overkill.sample(runs, secs, reaction)  // many runs; median, spread, WIPE RATE
__overkill.place("blockade", z)  // pose one placement on empty road
__overkill.scene              // the live scene graph, for chasing stray instances
```

**`sample()` is how the difficulty brief becomes a number.** A failure rate is a
property of many runs, and half the tuning arguments on this project have been
about whether one unlucky playthrough meant the economy was wrong. It resets the
run between each, so it is destructive; `autopilot()` is the single-run version
and also reports `worstDrop`, the biggest one-tick loss as a share of the army —
which is the number that catches a wipe mechanism before it costs you a run.

**`reaction` is not a detail.** At 0 the autopilot re-decides sixty times a
second, which measures the game played perfectly rather than the game. Tuning
difficulty until an optimal player dies would make it unplayable for anyone else.
0.3 s is roughly a thumb.

**`bestLane()` scores POSITIONS, not segments.** It sweeps candidate positions
across the road and judges each with the same rule `resolve()` uses, for the
crowd's actual width. Picking the highest number instead measured a player who
does not exist — a crowd is metres wide, it smashes everything it overlaps, and
the +9 beside a −14 is a trap. Changing it moved the measured median by 30%, on
identical game rules, which is worth remembering before trusting any economy
number: **half of a measurement is how good the hand holding the controls is.**

**`damageCurve()` is the instrument the whole barrel curve rests on.** It spawns
a barrel with effectively infinite hit points, runs the real update order for a
full approach, and reports what it lost. If you change the scroll speed, the
bullet range or the convergence distance, re-measure and update the table in
`mechanics/pacing.test.ts` — do not widen the tolerance.

It is destructive: it clears the corridor and gates, and leaves the run reset.
**It must clear live gate rows, not just future ones** — a gate resolving
mid-probe re-tiers the weapon, and at one troop a red segment zeroes the count
and resets the run, which reads as "one soldier deals no damage" rather than as
a broken measurement. That bug cost most of an hour; the guard is in the code
with a comment.

Driving the browser needs `playwright-core` pointed at the preinstalled Chromium
(`/opt/pw-browsers/chromium-*/chrome-linux/chrome`). **Install it outside the
project** — `CLAUDE.md` forbids adding dependencies, and this is a harness, not
a dependency.

---

## Decisions of record

**Greenfield, not a fork.** `../swarm-game` is a mature portrait mobile horde
game (~40k LOC, 1,742 tests) with heavy mechanical overlap. Mischa was shown the
overlap and chose to build fresh anyway. Do not quietly start porting from it.

**Rapier3D is specced but deliberately absent.** Running 1,000+ crowd agents
through a rigid-body solver on a mobile browser is a performance trap. Rapier
goes in when there are *tens* of bodies worth solving — destructible fortress
debris, boss rigid bodies. Not before. See `specs/tech-stack.md`.

**The "bullet density gap" is closed, and it was a reference problem.** An
earlier session read `frame_030` of Part1.mov as "3–6 tracers at ~50 soldiers"
and concluded our ~175 was 30x too dense, which would have needed a front-rank
firing model and a rewrite of how damage scales with army size.
`reference-media/reference-clip-1a.mov` shows ~15 dense parallel columns at a
much larger army. Our model was closer to right than the note claimed. **Do not
reintroduce a front-rank shooter model on the strength of that old note.**

**Fire travels as a parallel curtain; `convergeDistance` is 0.** Convergence
focused all fire onto the squad's axis, which made "every column registers on
whatever it crosses" impossible. It is kept in the code as the right model for a
focused-fire powerup, and nothing else should switch it on by default.

**The crowd may leave the road.** "No unit stands on the grass" was an invariant
derived from the kerb; the newer reference overhangs the screen edge routinely.
Steering moves the CENTRE across the full road half-width and the overhang is
allowed. Do not reintroduce a containment clamp to "fix" it.

**Damage is 1 per bullet except for tier 2 darts, which are 2.** The 1:1 rule
existed so "bullets fired" and "damage dealt" were the same number, which is
genuinely useful while debugging. It was given up for tier 2 on purpose: halving
the dart rate to cut on-screen density would otherwise have halved the
firehose's damage and made the upgrade a downgrade. Damage is the lever that
changes the numbers without changing the picture, and barrel HP reads it through
`damagePerPass`, so nothing needed re-tuning by hand.

**THE STRATEGY PROBLEM WAS THAT MOVEMENT WAS FREE, not that the road was narrow.**
This is the most important thing in this file to not undo.

A playtester reported having no meaningful decisions, and diagnosed it as the
road being too narrow to dodge anything. The road was part of it — every
placement spanned it, so the only question a gate could ask was "which third of
this wall do you want". But the deeper cause was the opposite of "you cannot get
out of the way": the crowd centre chased its target on a first-order lag with a
0.1 s time constant and NO SPEED LIMIT, so it arrived just as fast from across
the road as from next door. Position cost nothing, and nothing that costs nothing
can be traded against anything. Widening the road on its own would have produced
a bigger area to teleport around in.

The fix is three constants that only work together, and pulling any one of them
back re-breaks the other two:

  LATERAL_SPEED   entities/squad.ts   7 m/s, so crossing the road takes 1.7 s
  CORRIDOR_HALF_WIDTH  mechanics/lane.ts   5.6 m, so there is a road to cross
  SEGMENT_WIDTH   mechanics/gates.ts   2.35 m, so a row leaves a gap beside it

The ratio that matters is **crossing time against placement spacing**: 1.7 s
against 1.8–2.7 s (`SPACING` / `GATE_TO_GATE_SPACING` in mechanics/director.ts at
6 m/s). Two prizes on opposite kerbs one placement apart are therefore mutually
exclusive, and two on the same side are free. If `scrollSpeed`, `SPACING` or the
road width move, re-derive the speed — a measured kerb-to-kerb crossing is
`__overkill` plus a `setLane` sweep, and it took under a minute to check.

**Going around a row is free, and rows do not span the road.** `resolve()` used
to charge the nearest segment whenever nothing was properly crossed. That
fallback made every row a toll and would have made the wider road cosmetic. A
crowd clear of the barrier now pays nothing, the row stays standing, and it sails
past intact.

**Two things on ONE plane is the only arrangement that forces a choice.**
Sequential content cannot, because the crowd only has to be in one place at the
moment each row arrives — it can take the best of every row in turn. The
`blockade` and `crossroads` placements (mechanics/director.ts, executed in
main.ts) put a gate row on one side and an enemy pack or a barrel cluster in the
gap on the other. Their rows are forced to `COMPOUND_SEGMENTS` (2) because a
four-wide row covers 84% of the road and leaves nowhere to put the second half of
the choice.

**A breach costs a share of the army per BODY that arrives.** It was one troop
per unit, so a whole eight-strong pack cost one troop — which made shooting them
pointless and made "or fight through them", one half of every blockade, free. The
autopilot measured it exactly: with dodging available and a flat breach cost, the
median run went to 660 troops with zero wipes.

**A WEAPON PICKUP ARMS TROOPS; IT DOES NOT RAISE A HIDDEN NUMBER.** Mischa's
ask, verbatim: a rocket launcher with a 10 next to it should mean ten soldiers
are carrying rocket launchers and firing rockets. So `world.gunners` and
`world.rocketeers` are COUNTS on the contract, the squad draws the weapon on
those soldiers (one extra instanced mesh per kind, riding the carrier's shoulder
so it inherits the bob, the pop and the topple for free), their streams fire the
matching projectile, and the loadout chips show the head count.

`firepower` and `fireRate` still exist and are still what the weapon model runs
on — they are DERIVED from the counts in `armCarriers()`, which is the only place
either is written. Elites, gunners and rocketeers are disjoint: the squad hands
out one job per soldier from a single strided sequence, and `armCarriers()` trims
them in priority order so they can never overlap.

**A ROCKET IS GEOMETRY, AND "BIGGER AND MORE OBVIOUS" HAS TWO CEILINGS.**
Mischa's standing instruction on upgrades is to err on the side of bigger and
more obvious: a rocket should look like a rocket, a minigun like a minigun. A
camera-facing quad can only say "bigger and warmer than the rounds beside it", so
rockets are now an `InstancedMesh` (`rocketGeometry()` in `mechanics/bullets.ts`)
— red cone, grey body, three fins, a stub of flame — rotated onto its own
velocity, so one banking across the road banks with it. One draw call that stays
empty until a launcher is earned. The carried kits went up the same way:
`buildMinigunKit()` is a brass drum behind six long barrels bound at a muzzle
ring, `buildRocketKit()` has a warhead and a blast cone so it has a front and a
back at forty pixels.

Both ceilings were found by screenshot, and both matter more than the sizes:

1. **Occlusion.** At `ROCKET_MESH_SCALE = 0.55` and `KIT_SCALE = 1.9` the rockets
   filled the corridor and hid the barriers behind them, and a crowd of launchers
   was a thicket of tubes with no visible men under it. Past obvious is not being
   able to see the game, which costs the player the decision it is all about.
   They are 0.19 and 1.2.
2. **Density, which compounds with size.** Rockets fly at 45% of a dart's speed,
   so they live 2.2× as long and the same fire rate leaves twice as many on
   screen. Shrinking them treated the symptom. `ROCKET_SHOT_STRIDE = 3` skips two
   shots in three and `ROCKET_DAMAGE = 6` carries the difference, so a
   rocketeer's total output is IDENTICAL and only the object count falls. Change
   one of that pair and you have silently retuned the weapon.

The dart sprite is still authored cyan, and a tint can only darken what is
already there — that is why tinting it orange gave olive, and why the warm
tracer batch exists. Keep that in mind for the next weapon.

**Enemies die instead of disappearing.** A walker used to blink out the instant
the pack's health crossed its threshold. It is now detached from its unit at its
world position, thrown back along the round that killed it, tumbled and shrunk
out over `DEATH_TIME`, with a puff. Dying bodies ride the corridor scroll on
their own — their unit may already be gone.

**THE CLIMB COMES FROM YOUR BULLETS AND FROM NOTHING ELSE.** A slow per-second
baseline used to run in `update()` for every unbroken blue whether or not a round
had ever touched it. At 0.9/s over a ~9.4 s approach that is +8.5 — more than a
whole early target — so rewards filled themselves while the player watched, which
is the exact inverse of the mechanic the module header describes. A playtester
caught it on video: +1 climbing to +4 with not one bullet fired.
`REWARD_CLIMB_RATE` is 0 and must stay 0.

**Progress is a FRACTION, not an accumulation.** Each blue carries `need`, the
damage required to fill it, taken as a share of what the army lands on one
segment over an approach and scaled by how much road the row will actually get.
The displayed number is interpolated from `dealt / need`. Two consequences worth
keeping: the same decision ("what share of my fire does this cost") is posed
identically at one troop and at five hundred, and the old `CLIMB_PER_DAMAGE`
constant is gone — it tied fill speed to the absolute damage scale, so every
weapon change silently retuned how hard rewards were to earn.

The share is `MERCY_COMMIT_SHARE` (0.36) under `MERCY_TROOPS` and
`REWARD_COMMIT_SHARE` (0.78) above it. The mercy branch is not decoration: at the
full share a one-troop squad that misses its first blue is still a one-troop
squad, so it misses the next one too, and the run stalls at the bottom forever.
That measured as a median of 565 with a minimum of 1.

**A REWARD IS EARNED BY FILLING IT, NOT BY WALKING INTO IT.** Mischa's call,
picked over the generous alternative (pay whatever number is showing when you
smash it) because it is what makes committing your fire to one segment a decision
rather than a preference. Fire is a curtain, so splitting it between two blues
fills neither.

Three things have to be true for that rule to be fair, and all three are now
enforced rather than hoped for:

1. **The goal is visible.** Every blue carries a gold plate above it reading its
   target (`targetTexture` in mechanics/gates.ts). Without it the rewards were,
   accurately, "arbitrary and surprising — sometimes 9 or 10, sometimes 34".
2. **The goal is always reachable**, and reachability is handled by the COST of
   filling rather than by shrinking the prize. `seg.need` scales to the army;
   `climbSpan` stays a pure economy number. The orchestrator reports the weapon
   side via `gates.reportFirepower()`, because the weapon model belongs to
   main.ts and a gate reaching for the bullet tuning would be exactly the
   module-to-module coupling the contract forbids.
3. **Failing is loud.** A blue smashed unfilled goes grey and its goal plate
   snaps red and oversized. A reward that quietly does not arrive reads as a bug,
   and was reported as one.

**A MISSED BLUE NOW TAKES THE NUMBER YOU REACHED.** This started as Mischa's
backlog idea and he promoted it to the default: walk through a blue you have not
filled and you lose the number that was showing instead of gaining it, in red.
`breakSegment` computes `seg.failed` and pays `-Math.floor(seg.value)`.

It is the single biggest change to the economy this project has made, and it is
why the measured median fell from 508 to 230 and the wipe rate rose off zero. Two
things follow from it that are easy to undo by accident:

- **The autopilot has to price it, or every number it reports is wrong.**
  `bestLane()` initially scored blues at face value, so the bot walked into
  unfillable rewards and 16 of 32 runs wiped — a measurement artefact that looks
  exactly like a broken economy. It now discounts a blue by `LIKELY_FILL` (0.5)
  and only commits inside `COMMIT_Z` (−22 m). That took it to 5 of 32.
- **Do not buy the median back by inflating rewards.** See the note at the top.

**A row's penalties are capped as a whole, not per segment**
(`ROW_PENALTY_CAP = 0.42` in `gates.ts`). A per-segment cap was correct while the
crowd stood in one lane; it stopped being correct once the crowd spanned the
road, because a wide army smashes EVERY segment in the row and pays all of them.
Three segments at the old 35% cap is 105% of the army — a wipe from one barrier,
with nothing on screen that said so, and a measured autopilot run hit exactly
that at 680 troops. The wide crowd taking everything is the mechanic; the fix
belongs on the row. Penalties are scaled down together so the "least bad" ranking
the player is reading survives the squeeze.

**The reward span is sub-linear in the army** (`rewardSpan()` in `gates.ts`,
`base × n^0.685`). Making it PROPORTIONAL was the obvious fix for a flat +7 span
and it is compound interest by another name: every reward multiplied the army by
~1.9 and a measured run passed 680 troops in 60 seconds against a 300–500 target
at 120. Sub-linear keeps the early jumps enormous in relative terms and lets the
late game be tuned at all. The satisfying big climbs are bought back with a
**jackpot** — one row in five runs ~2.8× as far — rather than by raising the
baseline, which is also what makes them worth committing to.

**Fire stops at the nearest standing barrier.** `gates.shootAt()` reports
`blocked` for any unbroken segment and `main.ts` consumes the round, so the
curtain visibly ends at the front barrier and only reaches the barrel behind it
once that segment has come apart. A blue breaks itself the moment it hits its
ceiling, which is what opens the lane. An earlier session argued from a
screenshot that the reference lets fire pass through; Mischa's call overrode it,
and the per-segment version is better anyway — one blue can break while its
neighbours still stand and still block.

**Additive blending needs a dark scene, and ours is not one.** Our sky is
`0x6fbde4`, already at 0.9 in blue, so any additive sprite over it clips to
white. The pickup rim glow was additive AND fogged (three mixes toward the fog
colour, which additive then adds at full strength), which is why playtesting
reported objects "encased in a white cloud". It is now a normal-blended hollow
gold RING with a fully transparent centre. `barrels.ts` and `bullets.ts` already
carried the fog half of this rule; the sky half is new.

**Per-unit colour is `instanceColor`, which MULTIPLIES the baked vertex colours.**
That is one float3 per soldier for a whole repaint with no second material and no
second draw call, and it is what makes a dying unit flash crimson and an elite
read gold. It also constrains the palette: the tint cannot pick out one part of
the body, and a bright multiplier clips the near-white shirt to a flat acid
colour, so the elite tint deliberately darkens as well as warms.

**EVERY SYSTEM MUST BE IN THE TICK, AND `renderables` IS NOT THE TICK.**
`entities/pickups.ts` sat in the `renderables` array — so it drew every frame —
while `pickups.update()` was never called. Its clock never advanced, so the
staleness retirement never fired; its previous-position history never refreshed,
so render interpolated against a frozen frame; and a collected prize never flew,
never landed and never retired. The result was a gold ring stopping dead in
mid-air while its barrel drove on underneath it, which is exactly the "floating
objects" a playtester reported three times running. A scene probe measured it at
194 samples out of 200 carrying at least one ring more than 1.4 m from any
barrel; after the fix, 17 out of 200, all of them prizes legitimately in flight.

`renderables` drives `render()` only. Update order is spelled out explicitly in
`tick()` for exactly this reason — and this is the failure mode that argues for
keeping it that way rather than looping an array.

**A post falls once both its segments are gone.** Posts used to stand until the
whole ROW resolved, so a blue that broke early on its own left two uprights
behind — blue sticks standing on empty road, and on the grass verge when the row
sat against a kerb. The other half of the "floating objects" report.

**Enemies are red, and that was a legibility bug rather than art direction.** A
walker pack at z −30 was reported as "strange artifacts hovering over the road".
They were exactly where they should be, correctly shadowed, doing their job — and
they were brown lumps in brown hats on a grey road at forty pixels. Red is this
game's existing word for "this takes troops off you", so a red silhouette is
legible before any detail resolves, and it is the maximum separation from the
player's own cream-and-blue crowd. An enemy the player cannot recognise cannot
create a trade-off.

**THE HUD IS THREE THINGS AGAIN.** Mischa's reference screenshots have a level
pill, a crowd count and a mute button, and nothing else, ever. Ours had grown to
nine permanent elements. It is now a level pill (top left) and the crowd count
(top centre, blue, matching the reference), with everything else transient: the
loadout chips appear when a value changes and leave after 3.4 s, the streak chip
is invisible at 1×, the boss bar only exists during a boss, and the Commander is
already a passing line. `#ui.is-carded` clears the lot in one switch while a
level card is up — that rule spans five modules and lives in `ui/levelcard.ts`,
because the card is the only thing that knows the state it applies to.

**A CARD IS A SCENE CHANGE, SO THE HUD CUTS RATHER THAN FADES.** It is also the
only version this project can verify: an offscreen browser pane starves CSS
transitions exactly as it starves `requestAnimationFrame`, so a faded HUD
photographs at whatever opacity the transition happened to reach — measured at
0.22 four hundred milliseconds in.

**THE HARNESS NEEDS ITS OWN PATH THROUGH EVERY SCREEN.** `harnessMode` is set for
the duration of `autopilot()`, and both the wipe and the level-clear check it: a
bot that hits a card sits on a paused game for the rest of its sample and reports
it as a run that stalled. Anything that stops the world from now on needs the
same treatment.

**THE AUTOPILOT USED TO CROSS NO GATE ROWS AT ALL, AND THAT WAS THE ALARM.**
Measured while wiring the streak: `clearPayouts()` then a 40-second `autopilot()`
run produced **zero** resolve events. Going around was free and every row was
narrow enough to go around, so the bot took its entire economy from barrels,
pickups and bosses. Widening the rows fixed it — it crosses ten segments in a
hundred seconds now — but the lesson stands and is worth keeping: **if the bot
ignores a whole content type, that content type is optional, and optional content
is not a decision.** Check for it whenever something new goes on the road.

Every economy number this project has ever quoted therefore EXCLUDES gate rows.
That does not make them wrong (they are a real measurement of a real strategy)
but it does mean:

- Anything whose value comes from crossing rows — the streak most obviously — is
  invisible to `sample()` and has to be verified by hand.
- The wipe rate measures deaths by boss, breach and failed blue only.
- "Go around everything" being an optimal-looking line is itself worth a look.
  It is not obviously wrong — a player who dodges everything grows slowly and
  stalls — but nobody has checked whether it is the best line or merely the
  safest one the bot knows.

**THE STREAK COUNTS ROWS YOU CAME OUT AHEAD ON, NOT ROWS WITH NO RED IN THEM.**
"Cross without touching a red" is the version that reads best in a sentence and
it measured out at a flat 1× for an entire run: the raw count reached 1 on 14
samples out of 400 and 2 on none. The reason is structural — a segment is crossed
when the crowd covers a fraction of its width, so past a few dozen troops the
army is wider than a whole row and takes every segment in it whatever it aims at.
A no-red streak is unavailable by construction to any army big enough to want
one. Net-positive is achievable at every size, is broken by a bad row rather than
by geometry, and makes STEERING the tool that turns a bad row into a good one.

The ladder tops out at **2×**, not 3×. On an economy whose failure mode is a run
that catches fire, a 3× on gate rewards is not a thread, it is a second economy.

Rows are totalled across one `gates.update` and judged immediately after it in
`tick()` — `onResolve` fires once per SEGMENT, so a row's verdict cannot be
decided inside the handler.

**THE COMMANDER'S THREE RULES.** He is the joke the game is named after and the
last piece of it to get built (`ui/commander.ts`):

1. **After, never during.** Every trigger is a resolution — a boss died, a row
   paid, the army crossed a threshold. Nothing calls him while a decision is on
   the road, because a player reading a joke is a player not reading the corridor.
2. **Walked, not rolled.** Lines advance a cursor per topic, so the second boss
   gets the second boss line. A random table on a two-minute run repeats itself
   and stops being a character.
3. **He shuts up.** One line at a time, a hard cooldown, and a priority so a boss
   dying cuts off a remark about head count.

His line cursors deliberately survive `resetRun()` — a run ending is exactly when
a player should NOT hear the same casualty line for the fourth time.

**A HUD CHIP CANNOT SIT AT A FIXED OFFSET FROM THE TROOP BADGE.** The streak chip
was placed 124px in, beside the badge; that reads well at "12" and collides at
"1200", which is the run where it matters most. The badge grows with the number.
It is in the opposite corner now.

**THERE IS NO ACTIVE ABILITY, AND THERE SHOULD NOT BE ONE.** The game is steering
and only steering. `world.focus`, `ui/skills.ts`, the squeeze in the squad, the
damage and spread terms in the bullets, and the two perks that modified them are
all deleted.

**THE WHOLE HISTORY, BECAUSE IT IS THE MOST INSTRUCTIVE MISTAKE IN THE PROJECT.**
It shipped first as TWO abilities — a TIGHTEN on the tap that squeezed the crowd,
and a passive FOCUS that filled while the player held a line. Mischa's review was
one question: *"what's the difference?"* Both concentrated fire, neither read as
its own idea, and the passive one rewarded NOT STEERING, which is the only input
the game has. They were merged into one tap ability. Mischa's next note was
*"I don't like the Focus mechanic — invest more in other ways of making the game
feel responsive"*, and that one was right too.

**THE DIAGNOSIS: IT WAS A SECOND THING TO DO WITH THE THUMB THAT STEERS.** On a
phone held one-handed, the thumb that drags the crowd is the thumb that has to
tap, and every hard dodge is a gesture that must not fire it. An ability whose
entire cost is "you were not steering for a moment" cannot be exciting in a game
where steering is the fun. Two full passes of tuning — a squeeze number, a
damage number, a spread number, a cooldown, two perks and a HUD pill — bought
nothing that steering did not already do better.

**REMOVING IT COST NOTHING MEASURABLE, AND THAT IS THE EVIDENCE.** The autopilot
never tapped, so every economy number in this file was ALREADY measured with the
ability at zero. Deleting it moved the sampled wipe rate from 5 in 32 to 1 and 2
in 32 across two samples — a difference inside the noise this file already
documents at n=32. An ability that can be deleted without the numbers noticing
was not carrying the game.

**WHAT REPLACED IT: THE CROWD ANSWERS THE INPUT WITH ITS POSTURE.** The centre is
capped at 7 m/s and ramped over ~0.2 s, both deliberately, so a big army feels
like a big army. The cost was that the first fifth of a second of a swipe
produced almost nothing on screen — and that fifth of a second is exactly the
window in which a control feels connected to a thumb or does not. The latency was
never the problem; the SILENCE was. Three things now fill it, all in
`entities/squad.ts` and all free:

- **LEAN.** Every soldier rolls into the turn, up to 0.2 rad at full lateral
  speed. Uniform across the crowd, so it is one quaternion per frame rather than
  one per unit.
- **DRAG.** The formation shears — the front rank leads, the rear rank trails, by
  0.18 m per metre of depth at full speed. Symmetric about the centre, so
  `world.squadHalfWidth` and every gate calculation are untouched. Applied to the
  muzzle sample too, or a hard turn leaves every tracer starting a third of a
  body width off the soldier firing it.
- **DUST.** A pooled ground puff kicked off the trailing flank above 3 m/s. Three
  things were wrong with the first version and all three are worth knowing:
  pale grey dust over a 0.73-grey road is invisible (it is warm tan and DARKER
  than the road now, because reading against the surface beats being the right
  colour for grit); dust under the crowd is covered by bodies and their shadows;
  and dust behind the rear rank is off the bottom of the frame. The clear road is
  the FLANK the turn is leaving, which is also where the eye already is.

**HIT-STOP DROPS WHOLE SIM STEPS. IT DOES NOT SCALE `dt`.** The standard trick is
to slow time on impact; this project cannot, because `core/loop.ts` runs the sim
at exactly 60 Hz so that a run pays the same on a 120 Hz iPad as on a throttled
Android. `tick()` returns early instead, so every step that runs is still exactly
1/60 s and the frames between simply repeat — which is also what hit-stop
actually is. A freeze reads as "that landed"; a slowdown reads as slow motion.
Three to five frames is the window. Only impacts ON the player and the death of a
boss get one: a barrel goes off several times a corridor, and a game that freezes
several times a corridor is a game that is dropping frames.

**THE CAMERA PUNCH HAS A HARD VERTICAL CEILING, AND IT IS A FRAMING LIMIT.** A
punch is a shake with a direction — the frame is thrown AWAY from the blow — and
at 0.3 m of downward punch a boss hit revealed the near end of the road. Camera
and look-at move together, so dropping the pair shows more of the ground plane at
the bottom of the frame and the deck simply stops there. `PUNCH_Y_LIMIT` in
`core/zoom.ts` caps the vertical component at 0.12 m; the horizontal axis has no
such wall, so a punch spends its budget sideways and only nods vertically.

**THE ROAD WAS 7 m TOO SHORT AT THE NEAR END, AND HAD BEEN ALL ALONG.** Found
while photographing the punch: at the 450-troop zoom step the camera sits far
enough back to see over the deck's near edge, and the road ended about 140 px
above the bottom of the frame with water under it — at exactly the army size the
game is trying to look impressive at. `CORRIDOR_LENGTH` is 84 with the near end
at z +15, which keeps the road's centre where it was so nothing positioned
relative to it moved. `main.ts` had a hardcoded `70` duplicating
`CORRIDOR_LENGTH` in the road-texture scroll; it is imported now.

**THE ROWS STAY AS THEY ARE.** `ROW_WIDTHS` was widened so half of rows are
four-wide by tier 1 and three quarters by tier 2, and that was done to give the
ability a reason to exist. It survives the ability, because the reason it worked
was never the ability: a row you can walk around is scenery with a number on it,
and a row you cannot is a fork. Before the change the autopilot crossed ZERO rows
in forty seconds; it crosses about ten in a hundred now. Being wide is a
liability you cannot switch off any more, which is a cleaner version of the same
trade.

**THE AUTOPILOT HAS NEVER CROSSED A GATE ROW. NOT ONCE.** Measured while wiring
the streak: `clearPayouts()` then a 40-second `autopilot()` run produces **zero**
resolve events. Going around a row is free by design — that is what turned a gate
from a toll into a decision — and the bot exploits it perfectly, so it takes its
entire economy from barrels, pickups and bosses.

Every economy number this project has ever quoted therefore EXCLUDES gate rows.
That does not make them wrong (they are a real measurement of a real strategy)
but it does mean:

- Anything whose value comes from crossing rows — the streak most obviously — is
  invisible to `sample()` and has to be verified by hand.
- The wipe rate measures deaths by boss, breach and failed blue only.
- "Go around everything" being an optimal-looking line is itself worth a look.
  It is not obviously wrong — a player who dodges everything grows slowly and
  stalls — but nobody has checked whether it is the best line or merely the
  safest one the bot knows.

**THE STREAK COUNTS ROWS YOU CAME OUT AHEAD ON, NOT ROWS WITH NO RED IN THEM.**
"Cross without touching a red" is the version that reads best in a sentence and
it measured out at a flat 1× for an entire run: the raw count reached 1 on 14
samples out of 400 and 2 on none. The reason is structural — a segment is crossed
when the crowd covers a fraction of its width, so past a few dozen troops the
army is wider than a whole row and takes every segment in it whatever it aims at.
A no-red streak is unavailable by construction to any army big enough to want
one. Net-positive is achievable at every size, is broken by a bad row rather than
by geometry, and makes STEERING the tool that turns a bad row into a good one.

The ladder tops out at **2×**, not 3×. On an economy whose failure mode is a run
that catches fire, a 3× on gate rewards is not a thread, it is a second economy.

Rows are totalled across one `gates.update` and judged immediately after it in
`tick()` — `onResolve` fires once per SEGMENT, so a row's verdict cannot be
decided inside the handler.

**THE COMMANDER'S THREE RULES.** He is the joke the game is named after and the
last piece of it to get built (`ui/commander.ts`):

1. **After, never during.** Every trigger is a resolution — a boss died, a row
   paid, the army crossed a threshold. Nothing calls him while a decision is on
   the road, because a player reading a joke is a player not reading the corridor.
2. **Walked, not rolled.** Lines advance a cursor per topic, so the second boss
   gets the second boss line. A random table on a two-minute run repeats itself
   and stops being a character.
3. **He shuts up.** One line at a time, a hard cooldown, and a priority so a boss
   dying cuts off a remark about head count.

His line cursors deliberately survive `resetRun()` — a run ending is exactly when
a player should NOT hear the same casualty line for the fourth time.

**A HUD CHIP CANNOT SIT AT A FIXED OFFSET FROM THE TROOP BADGE.** The streak chip
was placed 124px in, beside the badge; that reads well at "12" and collides at
"1200", which is the run where it matters most. The badge grows with the number.
It is in the opposite corner now.

**EVERY OBJECT IS PHONG, EVERY SURFACE IS LAMBERT.** `core/look.ts` owns it.
Lambert has no specular term at all, and that single fact was most of the
difference between the reference's moulded-plastic soldiers and our coloured
paper ones — a Lambert sphere and a Phong sphere have the same silhouette and
only one of them looks smooth. The road, the water and the bridge stay matt: a
highlight is a cue that says "this is a thing", so spending it on the backdrop
spends it on nothing.

**THE LIGHTING HAD TWO BUGS THAT HAD BEEN HIDING BEHIND EACH OTHER.**

- The hemisphere fill's ground bounce was GREEN, left over from when the corridor
  ran across a field rather than over water. Every vertical surface in the game
  was being tinted olive by scenery that no longer exists. There is a comment in
  `squad.ts` deriving the shirt's albedo by pre-dividing that green out, which is
  a heroic fix for a problem that should never have existed — it is re-derived
  now, and the note explains how to re-derive it again.
- Nothing lit the side of anything the camera could see. The key is deliberately
  up-screen so the fake shadows have a direction to match, and the consequence
  was that fronts were carried by ambient alone. **That coupling was imaginary:**
  shadows here are hand-placed quads, not shadow maps, so nothing in the renderer
  derives their direction from a light. A warm fill from the camera's side
  changes what the player sees and changes the shadows not at all.

**COLOURS ARE SAMPLED OFF THE FOOTAGE, NOT PICKED.** The helmet was `#2969AD` on
screen against the reference's `#6FBCE9` — the same hue at half the value, which
in a crowd reads as a dark lump rather than a bright dome. Sample the rendered
pixel, sample the reference frame, scale. `ffmpeg -vf "crop=…,scale=1:1" -f
rawvideo -pix_fmt rgb24` is the whole tool.

**ONE SUN.** The squad threw its shadows down-screen-right, as the reference
does; the enemies, barrels and boss threw theirs up-left, which from this camera
is behind the object where nothing can see them. They agree now. If the key light
moves, every `SHADOW_OFF_*` in the game moves with it.

**THE ARMY WALKS, AND THE LEGS ARE THEIR OWN MESH.** The stride used to be baked
into the merged figure, frozen, on the theory that the bob carried the run. It
does not — a crowd bouncing in place with rigid legs reads as bollards on a
conveyor. One instanced mesh serves every leg in the army: instance 2i is a
unit's left, 2i+1 its right, mirrored by an x offset and an opposite swing. One
extra draw call for twelve hundred walking soldiers.

The swing is a COSINE and that is not a detail. The bob is `abs(sin)`, so it
touches zero at each footfall; cosine puts the legs at full spread exactly there
and brings them together at the top of the bounce. A sine plants both feet
together at the bottom of every step.

**SEGMENTS AROUND BUY SMOOTHNESS; SEGMENTS DOWN BUY NOTHING.** A 14×6 helmet cost
112 triangles a unit — 60k at a full army — and looked identical to a 16×3 one at
64, because from a camera 34° above the crowd you read the helmet's circular
outline and not its profile, and the highlight is per-fragment so it stays round
however coarse the mesh is.

**AN EXPLOSION IS SEVERAL EVENTS, NOT ONE.** A barrel burst was a single
fireball, thirteen small planks and six puffs, and beside `frame_018` it read as
a spark. It is layered now: a white core, two offset satellites so the fireball
has a shape, four tall thin light shafts thrown straight up, staves big enough to
identify as staves under lower-than-real gravity so they hang long enough to
follow, and smoke that outlives all of it.

**THE CAMERA SHAKES FOR EXACTLY TWO THINGS.** A boss dying and a boss landing a
hit on you. `zoom.shake(metres)` takes the larger of the current shake and the
new one rather than summing, decays in about a fifth of a second, and offsets the
camera's position and its look-at together — so like every other camera move in
this project it is a pure translation and every billboard basis stays valid.
Spend it on anything that happens every few seconds and it stops meaning
anything.

**A BOSS IS A DECISION, AND ONE LINE IN `place()` IS WHAT MAKES IT ONE.** While a
boss holds a kerb, every other placement is forced to the opposite one. The
corridor keeps delivering barrels throughout the fight and the guns only point
one way, so the trade is: seconds spent on the boss are prizes given up, against
a patience clock that ends with the boss coming through the crowd for a fifth of
the army. Delete that line and a boss becomes a shooting gallery with one target.

**THE STANDOFF DISTANCE IS A WEAPON RANGE.** Rounds die 22 m from the soldier who
fired them (`range` in mechanics/bullets.ts) and soldiers fire from throughout the
crowd's depth. A boss holding at 29 m was outside the reach of the whole army:
seven seconds of fire took 500 points off a 2,800-point boss, which then died in
a second and a half the moment it charged into range. `STANDOFF_Z` is −23 and it
moves if `range`, the scroll speed, or the crowd's depth budget move.

**BOSS HIT POINTS ARE THE ONE HP MODEL THAT KNOWS ABOUT YOUR UPGRADES.** Every
other one deliberately ignores them so a launcher stays worth picking up. Two
corrections got the boss here, and both are easy to undo by accident:

- It is priced off `damagePerPass` directly, NOT `enemyHp`. That function scales
  its answer by `laneCoverage` — the share of a curtain of fire a 1.7 m barrel
  face intercepts — which for a wide crowd is under a third. A six-metre boss
  catches the whole curtain, so pricing one through that path made it four times
  cheaper than intended.
- `BOSS_UPGRADE_BITE` (0.6) puts most of the army's weapon multipliers back into
  the boss's health. Without it a kitted ninety-strong army killed a brute in
  2.5 s against a bare army's 7.5 — a boss that evaporates is not a check on the
  army, it is a cutscene with a health bar. At 0.6 the spread is 3.5 s to 5.8 s
  against a nine-second patience, which is the window the whole encounter is
  designed around.

**THE FIRST BOSS IS SCALED TO 0.7 AND THE THIRD TO 1.4.** At full weight the
first boss anyone ever meets is unwinnable — a bare thirty-strong army, which is
what a run actually has at the 168 m mark, needs twelve seconds against nine. The
ramp is the difficulty curve for the whole encounter type and it is two constants
in `main.ts`.

**EVERYTHING A BIG FIGURE HAS TO SAY BELONGS ON +Z.** The camera sits at z +9.5
and looks down the corridor, so the side facing the player is POSITIVE z. The
first pass put the face, the maw and the hazard plates on all three bosses at −z
and they came back as blank lumps. The same rule governs the ogre's iron plate
and the elite's rifle.

**A HIT FLASH TUNED FOR A WALKER IS WRONG FOR A BOSS.** A boss is hit several
times per frame, so the flash never decays: a white flash at a walker's strength
left the brute a featureless white blob for the entire fight. It is a third the
strength and biased orange, which reads as glowing hot under sustained fire and
still pops on a single rocket.

**THE OGRE IS PRICED SO THAT SHOOTING IT IS A QUESTION.** `OGRE_PASS_SHARE` is
0.8 of a whole approach, which means an ogre standing in front of a barrel
cluster costs you the cluster — there is not enough approach left to kill both. A
guard that can simply be shot through on the way past is scenery, and that is
what the walker packs in a `blockade` already are.

**THE GAME IS ON A BRIDGE NOW, AND THE SCENERY IS WHAT MAKES IT MOVE.** The road
sits on a deck over water with railings, and `addTowers()` (`mechanics/lane.ts`)
scrolls suspension towers past and recycles them at `TOWER_RECYCLE_Z`. This is
worth more than it looks: a flat road with nothing beside it gives the eye
nothing to measure speed against, so the game read as slower than it is. The
towers are OFF the deck on purpose — anything tall on the road itself competes
with the barriers for attention.

**Shadows move because the light does not.** Every module draws its own flat
shadow quad at a fixed `SHADOW_OFF_X`/`SHADOW_OFF_Z`, which is the offset the
single key light would throw. Playtesting reported shadows that "don't move
realistically", and the fix was to make the offsets consistent across modules and
to make the tower shadows scroll with their towers rather than sit under the
camera. If the key light in `core/renderer.ts` ever moves, every one of those
offsets has to move with it — they are not independent art decisions.

**A PRIZE SAYS ITS OWN NAME.** Playtesting could not tell what the objects riding
the barrels were. Primitives at forty pixels cannot distinguish a minigun from a
recruit, so `labelTexture()` in `entities/pickups.ts` puts TROOPS / MINIGUN /
ROCKET on a plate above each one. This is the general rule Mischa set for the
whole project: **if a primitive cannot say it, use a text label** — do not spend
geometry trying to make the shape self-explanatory.

**No two consecutive rows may be all red.** Mischa's call, and it is a pacing
rule rather than a fairness one: back-to-back walls with nothing to earn read as
a corridor with no decisions in it. `rowHasReward()` reports whether a row
carried a blue, `main.ts` remembers it in `lastRowWasDry`, and the next row is
composed with `forceReward`.

**The camera pans laterally, and it is still a pure translation.** `core/zoom.ts`
moves the camera AND its look-at point by the same vector, so every billboard
basis baked at module load stays correct — the same rule the dolly obeys. Sliding
the camera while the target stays put would rotate it and silently break
bullets/floaters/squad. Keep them moving as a pair.

**Barrel payouts are capped at 10 troops** (`barrelPayout`). A tenth of hit
points was fine when barrels topped out at 50; now that they reach 250, three
late-run barrels at an uncapped tenth would out-earn a whole row of gates and
quietly turn a steering game into a shooting gallery.

**The key light points up-screen** (`core/renderer.ts`). Every element draws its
own fake contact shadow, and a camera-side light throws all of them *behind* the
units casting them, which makes the whole crowd hover. Backlighting is paid for
with a strong hemisphere fill. If you move this light, every module's shadow
direction moves with it.

**Repo is public** because GitHub Pages does not work on private repos on the
free plan, and Mischa chose the URL over privacy. This means the reference frames
extracted from `Part1.mov` are publicly visible.

**`nanoid` advisory is accepted.** Dev-only (`vite → postcss → nanoid`), never
ships, pinned by postcss. Revisit when postcss bumps.

---

## Open questions for Mischa

1. **Camera angle** — match the reference's 43°, or keep compensating? (#2)
2. **Squad split** — one input steering both groups, or selecting between them? (#3)
3. **Is there a hero avatar?** The reference has none — the squad *is* the
   player — but the brief specs a named Commander with a skill tree.
   `entities/commander.ts` exists and is deliberately **not mounted**.
4. **Do troops persist between runs**, or reset with only upgrades carrying over?
5. **Is the corridor always a bridge**, or does the environment vary by stage?
   It is a bridge over water now; nothing varies it, and levels are the natural
   place to hang a second environment if he wants one.

---

## Known gaps and placeholders

- **There are no levels** — see #1 above. Difficulty ramps on `elapsed` alone.
- **The boss bar is a display with nothing behind it.** No boss entity exists;
  it is currently driven by enemy kills. It is also the obvious place to hang an
  end-of-level boundary once levels exist.
- **Nothing shoots back.** Five enemy kinds exist and are placed — walker packs,
  gold elites, bikers, ogres, and three bosses — but every one of them hurts you
  by ARRIVING. No enemy has a ranged attack, so the whole game is still resolved
  by where the crowd stands rather than by anything it has to react to. There are
  also no mines and no flying enemy.
- **The autopilot does not aim.** It positions the crowd but never chooses a
  segment to concentrate fire on, so it under-collects under the fill-to-earn
  rule and every economy median here is a floor. Teaching it to hold a lane until
  a target fills is the next real improvement to the instrument.
- **The autopilot ignores enemies.** `bestLane()` scores gate segments only, so
  it will happily dodge a row straight into a pack. Every economy number here is
  therefore slightly pessimistic about a good player and blind to whether the
  blockade trade-off is actually balanced. Teaching it to price a pack is the
  next real improvement to the instrument.
- **Enemies do not shoot back.** The reference's gold elites fire orange tracers.
  Adding it is a small hook in `enemies.ts` plus a call into `bullets.ts`.
- **Zero troops restarts the run immediately.** There is no debrief screen, no
  score, and no run summary. This is more visible now that runs start at 1 troop.
- **No audio at all.**
- **Test coverage is the pacing math only** (`mechanics/pacing.test.ts`,
  `mechanics/gates.test.ts`, `mechanics/director.test.ts`). Anything that constructs three.js objects needs a
  DOM and a GPU and is not covered; that is why row composition was extracted as
  a pure function. Do the same when you want to test another module's rules.
- **The perf overlay (`?perf`) never populates in an offscreen pane**, because
  it is driven by frame stats and rAF is throttled to zero. It works in a real
  browser.
- **The environment does not vary.** It is one bridge over water for the whole
  run; there is no per-stage environment and nothing changes as a level ramps.
- **No favicon**, so every page load logs a 404 in the console. Harmless, but it
  is the one console error a verification pass will see.
- **The reference media is 25 MB in the repo** (`reference-media/`), a 20 MB
  HEVC clip plus 33 extracted frames. Mischa asked for it in the repo. Note the
  repo is public.
- **`tools/extract-frames.swift` is macOS-only.** On Linux use ffmpeg; the
  Playwright-bundled build is a webm-only stub and cannot read the .mov, so
  `apt-get install ffmpeg` first.
