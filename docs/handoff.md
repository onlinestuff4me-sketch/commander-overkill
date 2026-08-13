# Where the work stands

_Last updated: 2026-08-13, end of session 2._

> The next session gets this repo and nothing else. **If it is not in a file, it
> is gone.** Rewrite this file rather than appending to it — a handoff that is
> allowed to grow into a changelog ends up describing a game that no longer
> exists.

**Repo:** `onlinestuff4me-sketch/commander-overkill`, public, `main`.
**Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/ — redeploys
on every push to `main` via `.github/workflows/deploy.yml`.
**Verified at HEAD:** `npx tsc --noEmit` exits 0; `npm test` is 30 passing;
`npm run build` succeeds; the page loads and runs a 66-second unattended run
with no console errors, at 59–89 draw calls and 52–69k triangles.

Read [`CLAUDE.md`](../CLAUDE.md) before touching anything. It holds the npm
guardrails, the architecture invariants, and how to verify work.

---

## Resume here

Ranked. The first is the only thing blocking a decision Mischa has to make.

### 1. Does every soldier shoot, or only the front rank? — ask Mischa

**This is the last real gap against the reference, and it is a product
question, not a tuning one.** Everything needed to act on the answer is now in
place; what is missing is the answer.

Measured, live rounds on screen:

| | ours | reference |
|---|---|---|
| 1 troop, tier 0 | 2 | 1–3 (`frame_000`) ✓ |
| 50 troops, tier 1 | 175 | 3–6 (`frame_030`) ✗ |
| 50 troops, tier 2 | 161 | "dozens" (`frame_035`) ≈ |

Tier 0 matches and tier 2 is close enough to read right. **Tier 1 is out by
thirty times**, and lowering the fire rate cannot close it. To put 5 rounds on
screen at 50 troops the squad must fire ~10 shots/second in total. Spread over
50 one-per-soldier streams that is a round every five seconds each, which at
44 m/s puts 220 m between rounds in a stream — ten times the 22 m they survive.
Every stream would be empty almost all the time and the "one countable column
per soldier" look, which `frame_030` is the evidence for, would be gone.

The two readings of the reference in our own docs cannot both be true:
`REFERENCE.md` says tier 1 is "3–6 orange tracers, **fired from the front rank
only**", while `bullets.ts` reads `frame_030` as "one column per soldier". Fifty
shooters cannot produce six rounds. **The reference is firing from its front
rank — about 11 men on an 11-wide road — at roughly 1 shot/soldier/second.**
That is 11 shots/second and ~5 rounds live, which is exactly what the footage
shows.

**Why it needs Mischa:** it changes what growing your army *means*. Today damage
is linear in troop count — twice the soldiers, twice the damage. Front-rank fire
makes it grow with the *width* of the blob instead, so doubling the army adds
about 40%. That is a game-design call about the power curve, not an
implementation detail.

Put it to him in his terms: *"When your army gets big, should every soldier
visibly fire — a wall of bullets — or just the front row, like the reference,
where you can still count the tracers? The front row also means a bigger army
adds less extra firepower."*

**It is now cheap either way.** Barrel hit points derive from the weapon model
(below), so the whole difficulty curve re-scales itself. The change is
`sampleShooters` in `entities/squad.ts` plus `tier1RatePerShooter`; nothing else
needs re-tuning by hand.

### 2. Decide the camera angle — still blocks accurate calibration

Unchanged from last session, still undecided, still needs Mischa.

**The reference camera sits ~43° above the horizon. Ours sits at 22°**
(`src/core/renderer.ts`, `CAMERA_POS`/`CAMERA_LOOK`). We *compensate* inside
world-space geometry — the squad's `DEPTH_RATIO = 1.6` exists purely to make a
22° camera produce a 43° camera's silhouette. That taxes every future
measurement: each ratio read off a reference frame has to be divided out by
their camera and re-applied through ours.

**It is not free.** Gates, barrels, bullets and the squad are all calibrated
against the current framing. Changing the camera invalidates all of it and needs
a re-measure pass per module. Treat it as its own milestone, not a one-line edit.

### 3. The squad splits at ~60 in the reference; we cannot express it

The road fits ~11 units abreast, so a single blob caps out near 70 troops. The
reference does not solve this by deepening — **it splits into two groups at ~60**,
which is what the second health bar in `frame_035` is.

Our curve diverges at **~43 troops**, where `RADIUS_Z_MAX` binds and the
silhouette stops being wider than deep. Past 60 we are a column (55% of units
visible at 60, 37% at 100). It also collapses steering range as the army grows —
±2.58 m at 1 troop, ±0.72 m at 20, ±0.50 m at 50+.

**Contract change required:** `squadLane` and `health` in `src/core/types.ts`
become per-group. **Product question for Mischa:** does one input steer both
groups together, or select between them? Recovering steering range means the
split, not a looser containment clamp — do not loosen the clamp.

### 4. Content pacing is still a fixed metronome

`spawnRow()` in `main.ts` fires a barrel row every 4.2 s and a walker pack every
other row, forever. Barrel *hit points* are now authored and derived; **when
they arrive is not.** A late-run frame has barrel rows and gate rows overlapping
in depth, which is legible but plainly unauthored. This is the next piece of
straightforward, decision-free work if the questions above are still open.

### 5. Nothing from the RPG layer exists yet

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
| `entities/squad.ts` | Instanced crowd, 181 tris/unit with rifle and arms, 4 draw calls at any count. Vogel-spiral layout, per-unit springs, drop shadows, HP bar. Contained to the road at every count. |
| `mechanics/bullets.ts` | One stream per soldier, golden-ratio phase offsets, convergent fire, three weapon tiers, pooled at 768. Exports the derived damage model. |
| `mechanics/gates.ts` | Segmented red/blue barriers, heavy outlined numerals, the climbing blue reward, burst on pass. Row composition is a pure exported function. |
| `mechanics/pacing.ts` | Barrel hit points and payouts. Pure arithmetic, no three.js, fully tested. |
| `entities/barrels.ts` | Numbered destructible cover that counts down under fire, chunky plank debris, riders that drop when it dies. |
| `entities/enemies.ts` | Instanced walkers, gold rim-lit elites, motorcycle variant, HP bars. |
| `ui/floaters.ts`, `entities/growthfx.ts` | Per-unit `+1` popups with screen-space separation, orbiting cyan swirl. |
| `ui/bossbar.ts` | DOM, safe-area aware, eases and pops on damage. |
| `core/*`, `input/touch.ts` | Fixed-60Hz loop with render interpolation, state machine, event bus, single-thumb relative drag. |

---

## How the difficulty curve works now

**Barrel hit points are derived, not fitted.** This is the change most likely to
be undone by accident, so it is worth understanding before touching a fire rate.

`damagePerPass(tier, troops, tuning)` in `mechanics/bullets.ts` predicts what a
barrel standing in the squad's lane loses over one full approach. It is
`shots/second × damage/bullet × 4.25`, and that 4.25 is **measured, not
derived** — damage divided by the shot rate that produced it is flat at 4.25
seconds across every tier and every count from 1 to 1200, to within 4%. It was
then confirmed predictively: after tier 2 was re-tuned it called the new numbers
to under 1% before they were measured.

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
__overkill.probeDamagePerPass(troops)  // measured damage over one barrel approach
__overkill.damageCurve()     // that swept across troop counts
```

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

**Damage is 1 per bullet except for tier 2 darts, which are 2.** The 1:1 rule
existed so "bullets fired" and "damage dealt" were the same number, which is
genuinely useful while debugging. It was given up for tier 2 on purpose: halving
the dart rate to cut on-screen density would otherwise have halved the
firehose's damage and made the upgrade a downgrade. Damage is the lever that
changes the numbers without changing the picture, and barrel HP reads it through
`damagePerPass`, so nothing needed re-tuning by hand.

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

1. **Does every soldier shoot, or only the front rank?** (#1 above — the one
   that is actually blocking.)
2. **Camera angle** — match the reference's 43°, or keep compensating? (#2)
3. **Squad split** — one input steering both groups, or selecting between them? (#3)
4. **Is there a hero avatar?** The reference has none — the squad *is* the
   player — but the brief specs a named Commander with a skill tree.
   `entities/commander.ts` exists and is deliberately **not mounted**.
5. **Do troops persist between runs**, or reset with only upgrades carrying over?
6. **Is the corridor always a bridge**, or does the environment vary by stage?
   Current environment is placeholder grass and sky, not the reference's bridge.

---

## Known gaps and placeholders

- **Content pacing is a fixed metronome** — see #4 above.
- **The boss bar is a display with nothing behind it.** No boss entity exists;
  it is currently driven by enemy kills.
- **Enemies do not shoot back.** The reference's gold elites fire orange tracers.
  Adding it is a small hook in `enemies.ts` plus a call into `bullets.ts`.
- **Zero troops restarts the run immediately.** There is no debrief screen, no
  score, and no run summary. This is more visible now that runs start at 1 troop.
- **No audio at all.**
- **Test coverage is the pacing math only** (`mechanics/pacing.test.ts`,
  `mechanics/gates.test.ts`). Anything that constructs three.js objects needs a
  DOM and a GPU and is not covered; that is why row composition was extracted as
  a pure function. Do the same when you want to test another module's rules.
- **The perf overlay (`?perf`) never populates in an offscreen pane**, because
  it is driven by frame stats and rAF is throttled to zero. It works in a real
  browser.
- **Environment art is placeholder.** Grass and blue sky, not a bridge over water.
- **No favicon**, so every page load logs a 404 in the console. Harmless, but it
  is the one console error a verification pass will see.
