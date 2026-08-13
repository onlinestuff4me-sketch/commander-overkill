# Where the work stands

_Last updated: 2026-08-13, end of session 1._

> The next session gets this repo and nothing else. **If it is not in a file, it
> is gone.** Rewrite this file rather than appending to it — a handoff that is
> allowed to grow into a changelog ends up describing a game that no longer
> exists.

**Repo:** `onlinestuff4me-sketch/commander-overkill`, public, `main`.
**Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/ — redeploys
on every push to `main` via `.github/workflows/deploy.yml`.
**Verified at HEAD:** `npx tsc --noEmit` exits 0; `npm run build` succeeds; CI
green; the deployed page loads and runs with no console errors.

Read [`CLAUDE.md`](../CLAUDE.md) before touching anything. It holds the npm
guardrails, the architecture invariants, and how to verify work.

---

## Resume here

Ranked. The first two are the ones Mischa is most likely to notice.

### 1. Decide the camera angle — blocks accurate calibration of everything else

**The reference camera sits ~43° above the horizon. Ours sits at 22°**
(`src/core/renderer.ts`, `CAMERA_POS`/`CAMERA_LOOK`). We are currently
*compensating* for that mismatch inside world-space geometry — the squad's
`DEPTH_RATIO = 1.6` exists purely to make a 22° camera produce a 43° camera's
silhouette.

That is a workaround, and it taxes every future measurement: every ratio read
off a reference frame has to be divided out by their camera and re-applied
through ours. Matching the camera would let measurements be used directly, and
would likely close the remaining "our stuff looks bigger and closer than theirs"
gap in one change.

**It is not free.** Gates, barrels, bullets and the squad have all been
calibrated against the current framing — numeral sizes, the convergence
distance, the containment margins, the floater glyph size. Changing the camera
invalidates all of it and needs a re-measure pass across every module.

**Mischa has been told and has not decided.** Do not change the camera without
asking him. If he says yes, treat it as its own milestone with a re-calibration
of each module, not a one-line edit.

### 2. Tune barrel hit points against the real damage curve

Never done — deliberately deferred twice while bullets were being rebuilt, and
now the numbers exist. Barrel HP is currently `hp = 10 + rowIndex * 8` in
`spawnRow()` in `src/main.ts`, a placeholder.

Measured on-target DPS after the convergence fix:

| troops | tier | muzzle DPS | on-target DPS | damage per barrel pass |
|---|---|---|---|---|
| 1 | 0 | 5.0 | 5 | ~12 |
| 3 | 0 | 15.0 | 15 | ~37 |
| 20 | 1 | 139.9 | 138 | ~247 |
| 50 | 2 | 478.3 | 443 | ~573 |

A barrel is only **shootable for ~2.4 s**, not the ~11 s it is on screen —
bullet range is 22 m, so it enters the kill zone around z ≈ −24. Per-bullet
damage is 1 for both tracers and darts, deliberately, so "bullets fired" equals
"damage dealt" and HP tuning reads straight off the shot rate. To make low-count
barrels killable, **raise damage, not fire rate** — damage is the lever that
does not change the visual.

Related and unresolved: **the reference shows ~6–8 rounds in flight at ~40
troops; we hold ~254.** That implies a reference rate under 1 shot/soldier/second
against our 7. Shortening the rounds 6× removed most of the visual symptom, but
the density is still far off. `tier1RatePerShooter` is the knob and lowering it
costs DPS linearly, so it moves the HP tuning above. Do these two together.

### 3. Gate pacing is rolled, not authored

`REWARD_ROW_CHANCE = 0.72` in `src/mechanics/gates.ts` means ~1 row in 4 is
all-red. With a small squad that can be an unavoidable death, which is why
`START_TROOPS = 8` in `src/main.ts` instead of the reference's **1**.

The reference starts you at one soldier and gets away with it because its first
rows guarantee a survivable segment. Author the opening sequence — at minimum,
guarantee a non-negative option in every row until some troop threshold — and
then drop `START_TROOPS` back to 1, which is a meaningfully better opening beat.

### 4. The squad splits at ~60 in the reference; we cannot express it

The road fits ~11 units abreast, so a single blob caps out near 70 troops. The
reference does not solve this by deepening — **it splits into two groups at ~60**,
which is what the second health bar in `frame_035` is.

Our curve diverges from the reference at **~43 troops**, where `RADIUS_Z_MAX`
binds and the on-screen silhouette stops being wider than deep. Between 43 and
60 we approximate; past that we are a column (55% of units visible at 60, 37% at
100).

This also causes a second problem: **steering range collapses** as the army
grows — ±2.58 m at 1 troop, ±0.72 m at 20, ±0.50 m at 50+. A big army responds
instantly (settle time is count-independent) and then runs out of road.

**Contract change required:** `squadLane` and `health` in `src/core/types.ts`
become per-group. **Product question for Mischa:** does one input steer both
groups together, or select between them? Recovering steering range means the
split, not a looser containment clamp — do not loosen the clamp.

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
| `mechanics/bullets.ts` | One stream per soldier, golden-ratio phase offsets, convergent fire, three weapon tiers, pooled at 768. |
| `mechanics/gates.ts` | Segmented red/blue barriers, heavy outlined numerals, the climbing blue reward, burst on pass. |
| `entities/barrels.ts` | Numbered destructible cover that counts down under fire, chunky plank debris, riders that drop when it dies. |
| `entities/enemies.ts` | Instanced walkers, gold rim-lit elites, motorcycle variant, HP bars. |
| `ui/floaters.ts`, `entities/growthfx.ts` | Per-unit `+1` popups with screen-space separation, orbiting cyan swirl. |
| `ui/bossbar.ts` | DOM, safe-area aware, eases and pops on damage. |
| `core/*`, `input/touch.ts` | Fixed-60Hz loop with render interpolation, state machine, event bus, single-thumb relative drag. |

Roughly 75–80 draw calls and ~60k triangles at 50 troops with barrels, enemies
and a saturated bullet pool live.

---

## Decisions of record

**Greenfield, not a fork.** `../swarm-game` is a mature portrait mobile horde
game (~40k LOC, 1,742 tests) with heavy mechanical overlap — gates, crowds,
boss, ordnance, and the same deadpan-military tone. Mischa was shown the overlap
and chose to build fresh anyway. Do not quietly start porting from it.

**Rapier3D is specced but deliberately absent.** Running 1,000+ crowd agents
through a rigid-body solver on a mobile browser is a performance trap, and
crowds need steering and separation rather than restitution. Rapier goes in when
there are *tens* of bodies worth solving — destructible fortress debris, boss
rigid bodies. Not before. See `specs/tech-stack.md`.

**Damage is 1 per bullet, on purpose**, so shot rate and DPS are the same number.

**The key light points up-screen** (`core/renderer.ts`). Every element draws its
own fake contact shadow, and a camera-side light throws all of them *behind* the
units casting them, where they are invisible — which makes the whole crowd
hover. Backlighting is paid for with a strong hemisphere fill. If you move this
light, every module's shadow direction moves with it.

**Repo is public** because GitHub Pages does not work on private repos on the
free plan, and Mischa chose the URL over privacy. Note this means the reference
frames extracted from `Part1.mov` are publicly visible.

**`nanoid` advisory is accepted.** Dev-only (`vite → postcss → nanoid`), never
ships, pinned by postcss. Revisit when postcss bumps.

---

## Open questions for Mischa

1. **Camera angle** — match the reference's 43°, or keep compensating? (#1 above)
2. **Squad split** — one input steering both groups, or selecting between them? (#4)
3. **Is there a hero avatar?** The reference has none — the squad *is* the
   player — but the brief specs a named Commander with a skill tree.
   `entities/commander.ts` exists and is deliberately **not mounted**.
4. **Do troops persist between runs**, or reset with only upgrades carrying over?
5. **Is the corridor always a bridge**, or does the environment vary by stage?
   Current environment is placeholder grass and sky, not the reference's bridge.

---

## Known gaps and placeholders

- **Content pacing in `main.ts` is placeholder** — a fixed barrel row every 4.2s
  and a walker pack every other row. Not authored, not tuned.
- **The boss bar is a display with nothing behind it.** No boss entity exists;
  it is currently driven by enemy kills.
- **Enemies do not shoot back.** The reference's gold elites fire orange tracers.
  Adding it is a small hook in `enemies.ts` plus a call into `bullets.ts`.
- **Zero troops restarts the run immediately.** There is no debrief screen, no
  score, and no run summary.
- **No audio at all.**
- **No tests.** `vitest` is installed and configured; `npm test` finds no test
  files. The element modules were verified by throwaway headless harnesses that
  were deliberately not committed. Simulation modules are plain-Node runnable by
  design, so this is cheap to start.
- **The perf overlay (`?perf`) never populates in an offscreen pane**, because
  it is driven by frame stats and rAF is throttled to zero. It works in a real
  browser.
- **Environment art is placeholder.** Grass and blue sky, not a bridge over water.
