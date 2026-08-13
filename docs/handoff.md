# Where the work stands

_Last updated: 2026-08-13, end of session 2._

> The next session gets this repo and nothing else. **If it is not in a file, it
> is gone.** Rewrite this file rather than appending to it — a handoff that is
> allowed to grow into a changelog ends up describing a game that no longer
> exists.

**Repo:** `onlinestuff4me-sketch/commander-overkill`, public, `main`.
**Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/ — redeploys
on every push to `main` via `.github/workflows/deploy.yml`.
**Verified at HEAD:** `npx tsc --noEmit` exits 0; `npm test` is 34 passing;
`npm run build` succeeds; the page loads with no console errors. 78 draw calls
and 139k triangles at 461 troops with the camera stepped back to 1.7.

Read [`CLAUDE.md`](../CLAUDE.md) before touching anything. It holds the npm
guardrails, the architecture invariants, and how to verify work.

---

## Resume here

Ranked. Nothing here is blocked on Mischa except items 3 and 4, which are
product calls rather than engineering ones.

### 1. Author the content pacing — the last obviously-unfinished thing

`spawnRow()` in `main.ts` still fires a barrel row every 4.2 s and a walker pack
every other row, forever, at three fixed lanes. Everything those rows contain is
now authored — hit points derive from the weapon model, gate rows are shaped,
the camera steps back to hold it all — but **when they arrive is not**. At high
troop counts barrel rows and gate rows overlap in depth, which is legible but
plainly unauthored.

This is the largest remaining piece of decision-free work, and there is a
written plan for it: [`docs/pacing-proposal.md`](pacing-proposal.md). Nothing
in it is blocked: Mischa has answered the three questions it asked. A run is
**90 s to 2 min**, a strong run ends at **300–500 troops**, and the failure rate
**scales by level** — 1 in 8 on levels 1–2, 1 in 5 on levels 3–4.

That last one is not a tuning value. Penalties are absolute numbers while the
army grows exponentially, so a `-5` is 62% of an 8-troop squad and 1.2% of a
400-troop one — the exact inverse of "forgiving early, punishing late". The
proposal's fix is proportional penalties with a per-level cap on what one gate
may take. Read that section before touching `PENALTY_POOLS`.

The specific defect to fix first: **gates and barrels are two independent
spawners that both drop content at z = −58**, one every 16 m and one every
4.2 s. When those cadences come back into phase they spawn on top of each other.

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

The road fits ~11 units abreast, so a single blob caps out near 70 troops. The
reference does not solve this by deepening — **it splits into two groups at ~60**,
which is what the second health bar in `frame_035` is.

**The steering half of this is fixed** — the centre now travels the full road at
every size, and a crowd wider than the road simply overhangs it, which is what
`reference-clip-1a.mov` shows. What remains is that one blob past ~120 troops
can only get deeper, and deep is the axis this camera reads worst.

**Contract change required if it is ever wanted:** `squadLane` and `health` in
`src/core/types.ts` become per-group. **Product question for Mischa:** does one
input steer both groups together, or select between them?

Worth saying plainly: the stepped camera zoom may have made this unnecessary.
461 troops now fit on screen as one crowd. Do not build the split until
something actually fails without it.

### 4. Nothing from the RPG layer exists yet

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
| `entities/squad.ts` | Instanced crowd, 181 tris/unit with rifle and arms, 4 draw calls at any count. Vogel-spiral layout, per-unit springs, drop shadows, HP bar. Fills the road and overhangs it under steering; depth cap scales with the camera zoom. |
| `mechanics/bullets.ts` | One stream per soldier, golden-ratio phase offsets, three weapon tiers, pooled at 768. Fires a **parallel curtain** — convergence is off. Exports the derived damage model. |
| `mechanics/gates.ts` | Segmented red/blue barriers, heavy outlined numerals, the climbing blue reward, burst on pass. Row composition is a pure exported function. |
| `mechanics/pacing.ts` | Barrel hit points, payouts, and the lane-coverage model. Pure arithmetic, no three.js, fully tested. |
| `entities/barrels.ts` | Numbered destructible cover that counts down under fire, chunky plank debris, riders that drop when it dies. |
| `entities/enemies.ts` | Instanced walkers, gold rim-lit elites, motorcycle variant, HP bars. |
| `ui/floaters.ts`, `entities/growthfx.ts` | Per-unit yellow `+1` popups that rise and red `-1`s that fall out of frame, screen-space separated, one draw call. Orbiting cyan swirl. |
| `ui/bossbar.ts` | DOM, safe-area aware, eases and pops on damage. |
| `core/zoom.ts` | Stepped camera dolly tied to troop count, with hysteresis. Scales the squad depth cap and the fog with it. |
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
- **The reference media is 25 MB in the repo** (`reference-media/`), a 20 MB
  HEVC clip plus 33 extracted frames. Mischa asked for it in the repo. Note the
  repo is public.
- **`tools/extract-frames.swift` is macOS-only.** On Linux use ffmpeg; the
  Playwright-bundled build is a webm-only stub and cannot read the .mov, so
  `apt-get install ffmpeg` first.
