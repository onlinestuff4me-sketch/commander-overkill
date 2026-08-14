# Where the work stands

_Last updated: 2026-08-14, session 3 (fourth pass)._

> The next session gets this repo and nothing else. **If it is not in a file, it
> is gone.** Rewrite this file rather than appending to it — a handoff that is
> allowed to grow into a changelog ends up describing a game that no longer
> exists.

**Repo:** `onlinestuff4me-sketch/commander-overkill`, public, `main`.
**Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/ — redeploys
on every push to `main` via `.github/workflows/deploy.yml`.
**Verified at HEAD:** `npx tsc --noEmit` exits 0; `npm test` is 60 passing;
`npm run build` succeeds; the page loads with no console errors. 93 draw calls
and 105k triangles at 280 troops with the camera stepped back to 1.45.

**The economy is measured, not guessed.** `__overkill.sample(32, 110, 0.3)`:
median **588 troops** against a 300–500 target, and **0 of 32 wiped**. A 50 s
sample medians 99.

**These medians carry roughly ±25% run-to-run noise at n=16.** The distribution
has a long tail (a good run reaches the 1200 cap, a bad one never gets going), so
a sixteen-run sample cannot resolve a 12% tuning change — one attempt to trim the
median moved it the wrong way by more than the change was worth. Use n≥32 before
believing any adjustment, and do not chase a number inside the noise band.

**The failure mode is a STALL, not a wipe.** `min` is 1 in most samples: a run
that never grew, because filling a reward needs committed fire and a squad that
misses its first few blues stays too small to fill the next. Nothing ever reaches
zero troops, so `wiped` stays 0 while the run is over in every way that matters.
Count stalls alongside wipes when the level system lands.

**Zero wipes is the honest bad news and should not be tuned away.** Since a row
can be walked around, a player who reads the board correctly cannot be killed —
every option is upside against less upside. Fixing that properly means **levels**
(see #1): late levels need content that is unavoidable by construction, which
`ROW_WIDTHS` has the hooks for and nothing yet drives. Inflating penalties now
would only make the mid-game miserable without putting the difficulty anywhere in
particular.

`sample()` takes a reaction time because a bot re-deciding sixty times a second
measures the game played perfectly; 0.3 s is the setting the brief's per-level
failure bands should be read against.

Read [`CLAUDE.md`](../CLAUDE.md) before touching anything. It holds the npm
guardrails, the architecture invariants, and how to verify work.

---

## Resume here

Ranked. Nothing here is blocked on Mischa except items 3 and 4, which are
product calls rather than engineering ones.

### 1. LEVELS, and the difficulty they are supposed to carry

The pacing plan in [`docs/pacing-proposal.md`](pacing-proposal.md) is done except
for its last piece. The conductor owns the corridor (`mechanics/director.ts`),
penalties are proportional and capped per row, the reward span is sub-linear, and
`__overkill.sample()` measures a failure rate instead of arguing about one.

What is missing is the **level** itself. Mischa's answer specced failure rates in
plateauing bands — 1 in 8 at levels 1–2, easing to 1 in 3 by 16–21, implying a
~21-level game — and there is no level concept in the code to hang those on. The
only difficulty axis is `elapsed`, which drives `PENALTY_BANDS` in tiers of 25
seconds. That accidentally produces the right SHAPE (a run ramps through the
bands) but it cannot express "level 7 is harder than level 3 from its first
second", and it means a long level and a hard level are the same thing.

Concretely, this wants: a level number on `WorldState`, `PENALTY_BANDS` and the
director's beat weights selected by it rather than by `elapsed`, an end-of-level
boundary (the boss bar is the obvious place), and the retry/start-over choice
Mischa asked for. `sample()` is already the instrument that says whether each
band lands on its target rate.

Read `director.ts`'s header before changing the beat cycle: the old three-timer
schedule was over-subscribed by ~50% against any legible gap, so content density
had to drop, and the gap between two placements depends on the PAIR (16 m
gate-to-gate, 11 m otherwise) because what needs separating is decisions, not
objects.

The lever the level system most needs is already in place and unused:
`ROW_WIDTHS` in `mechanics/gates.ts` decides how many segments a row has, and a
row's width is now literally how avoidable it is (2 segments leave 6.5 m of clear
road, 4 leave 1.8 m). It is currently indexed by the `elapsed` tier. Point it at
a level number and the failure-rate bands become tunable in one table.

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

What is still missing on this axis: elites only multiply the rate, so a hundred
of them look and behave like a stronger version of the same soldier rather than a
different unit. Unit types with their own geometry are the next real step, and
they want a second `InstancedMesh` rather than more tint.

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
| `entities/squad.ts` | Instanced crowd, 181 tris/unit with rifle and arms, 4 draw calls at any count. Vogel-spiral layout, per-unit springs, drop shadows, HP bar. Fills the road and overhangs it under steering; depth cap scales with the camera zoom. Per-instance tint: crimson death flash, gold elites at 1.34× scale. |
| `mechanics/bullets.ts` | One stream per soldier, golden-ratio phase offsets, three weapon tiers, pooled at 768. Fires a **parallel curtain** — convergence is off. Exports the derived damage model. |
| `mechanics/gates.ts` | Segmented red/blue barriers, heavy outlined numerals, the climbing blue reward, burst on pass or on hitting its ceiling. Blocks fire per segment. Row composition and the reward span are pure exported functions. |
| `mechanics/director.ts` | The conductor. One cursor owns every placement in the corridor, in weighted beats with pair-dependent spacing, and now with a lateral SIDE per placement — which is what lets a beat put a guard in front of a prize or two prizes on opposite kerbs. Pure, seeded, tested. |
| `ui/troopcount.ts`, `ui/netpop.ts`, `ui/loadout.ts` | Army size top-left, the net `+14`/`−12` over the crowd, and what you are carrying. All DOM, all silent until they have something to say. |
| `mechanics/pacing.ts` | Barrel hit points, payouts, and the lane-coverage model. Pure arithmetic, no three.js, fully tested. |
| `entities/barrels.ts` | Numbered destructible cover that counts down under fire, chunky plank debris, riders that drop when it dies. |
| `entities/enemies.ts` | Instanced walkers, gold rim-lit elites, motorcycle variant, HP bars. **Its `elite` is an ENEMY kind** and has nothing to do with `world.elites`, which is the player's gold veterans. Unfortunate collision; rename the enemy one if it ever causes a bug. |
| `ui/floaters.ts`, `entities/growthfx.ts` | Per-unit yellow `+1` popups that rise and red `-1`s that fall out of frame, screen-space separated, one draw call. Orbiting cyan swirl. |
| `ui/bossbar.ts` | DOM, safe-area aware, eases and pops on damage. |
| `entities/pickups.ts` | What rides a barrel: a recruit, a minigun or a rocket launcher. Gold-rimmed, hovering, flies into the crowd when its barrel breaks. Four draw calls. |
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

The share is `MERCY_COMMIT_SHARE` (0.28) under `MERCY_TROOPS` and
`REWARD_COMMIT_SHARE` (0.62) above it. The mercy branch is not decoration: at the
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

**BACKLOG, Mischa's idea and worth building:** a reward variant that is
attractive but PUNISHES a miss — walk through it unfilled and you lose the number
that was showing instead of gaining it. The hooks are all here: `seg.failed` is
already computed in `breakSegment`, and paying `-Math.floor(seg.value)` on it is
a one-line change plus a distinct panel colour so the player can tell the two
kinds apart before committing.

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
`0x7cc4e8`, already at 0.9 in blue, so any additive sprite over it clips to
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
   Current environment is placeholder grass and sky, not the reference's bridge.

---

## Known gaps and placeholders

- **There are no levels** — see #1 above. Difficulty ramps on `elapsed` alone.
- **The boss bar is a display with nothing behind it.** No boss entity exists;
  it is currently driven by enemy kills. It is also the obvious place to hang an
  end-of-level boundary once levels exist.
- **Enemies and mines are thin.** Walkers exist, read as enemies, and now cost a
  share of the army per body that reaches you. There are still no mines, enemies
  do not shoot back, and a pack is the only enemy the director ever places —
  `spawnElite` and the biker variant are built and unused.
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
- **Environment art is placeholder.** Grass and blue sky, not a bridge over water.
- **No favicon**, so every page load logs a 404 in the console. Harmless, but it
  is the one console error a verification pass will see.
- **The reference media is 25 MB in the repo** (`reference-media/`), a 20 MB
  HEVC clip plus 33 extracted frames. Mischa asked for it in the repo. Note the
  repo is public.
- **`tools/extract-frames.swift` is macOS-only.** On Linux use ffmpeg; the
  Playwright-bundled build is a webm-only stub and cannot read the .mov, so
  `apt-get install ffmpeg` first.
