# Reference teardown — `Part1.mov`

Source: 14.21 s portrait screen capture, 1206×2622, of *Last War: Survival*'s
bridge stage. 36 frames extracted to `docs/reference/part1/` via
`tools/extract-frames.swift`.

**This file is the shared source of truth for the OPENING.** Every element team
works against it and against the named frames. If an observation here
contradicts a frame, the frame wins — say so and correct this file.

> **A second, later clip exists and outranks this one on three things.**
> `reference-media/reference-clip-1a.mov` shows the same game at hundreds of
> troops, and its teardown is `reference-media/README.md`. Where they disagree,
> it is newer evidence:
>
> - **the bullet stream is ~15 parallel columns and all of them register hits**,
>   which is why the convergence derived from `frame_030` below is now off,
> - **the crowd fills the road and hangs off the screen edge**, so the
>   containment rules below no longer apply to width or steering, and
> - **the crowd keeps growing past what the frame holds**, which is what the
>   stepped camera zoom in `core/zoom.ts` exists for.
>
> Everything else here — unit scale, gate anatomy, the climbing reward, the
> opening beat — is still the authority.

---

## Frame index (what each shows)

| Frame | t | Why it matters |
|---|---|---|
| `frame_000` | 0.20s | Opening state: **1 soldier**, empty road, two gate rows ahead |
| `frame_005` | 2.17s | 2 soldiers; a barrel taking fire, orange impact burst |
| `frame_009` | 3.75s | 3 soldiers; first full gate row `-1 / -4 / +2` |
| `frame_013` | 5.33s | 3 soldiers; gate now reads `-1 / -4 / **+9**` — blue value climbs over time |
| `frame_018` | 7.30s | ~20 soldiers; **barrel exploding** — debris, smoke, orange flash |
| `frame_023` | 9.28s | ~45 soldiers; **the growth moment** — a dozen `+1` floaters, blue swirl VFX |
| `frame_030` | 12.04s | ~50 soldiers; steady state, orange tracers |
| `frame_035` | 14.02s | ~60 soldiers; **cyan dart firehose**, weapon tier upgraded |

---

## ⚠️ READ THIS BEFORE MEASURING ANYTHING

**Three separate calibration bugs in this project had the same root cause: a
measurement taken off a reference frame in SCREEN units, and then used as a
WORLD value.** Every one of them shipped, rendered wrong, and had to be found by
looking at the result. Expect this trap; it is not obvious in the moment.

1. *"The blob is ~5 deep by 9 wide"* — a screen reading, used as a world ratio.
   Flattened the crowd into a rank so units piled on top of each other.
2. *"The bullet cone is ~25°"* — an apparent angle. The real cone is ~4°, and it
   **converges**; a grazing camera stretches lateral motion.
3. *"Tracers are ~1.9 m long"* — measured off the reference's **yellow enemy
   soldiers**, not its bullets. Real length is 0.25–0.31 m, a 6× error, and it
   made our fire read as a steam plume instead of discrete rounds.

**The two cameras are not the same.** The reference sits roughly **43° above the
horizon**; ours sits at **22°** (`src/core/renderer.ts`). At 22°, one metre of
world *depth* covers only ~0.375 of the screen that one metre of world *width*
does. So any depth-vs-width ratio read off a reference frame must be divided out
by *their* camera and re-applied through *ours* before it means anything.

**Measure in object-relative units.** Helmet diameters, road widths, body
widths — quantities that are camera-independent. Then convert. A pixel count is
only meaningful alongside the pixel count of something whose world size you know
in the same screen row.

## Camera & staging

- Fixed portrait camera, elevated three-quarter view, looking down a road that
  recedes up-screen. **The camera never rotates and never pans.** The world
  scrolls toward the viewer.
- Road: flat mid-grey (`#b9bcc1`-ish), a single **white dashed centre line**,
  two dashes visible at a time, moving toward camera.
- Framing: red suspension-bridge towers and cables at both edges, dark navy
  water beyond. The bridge furniture is set dressing — it never interacts.
- Vertical budget: the playable road occupies roughly the middle 60% of screen
  width; player squad sits in the **bottom third**, threats occupy the top two
  thirds.

## Player squad — how the troops act

- Uniform: **blue helmet, cream shirt, dark navy trousers.** No rim light.
- **Loose clump, never a grid.** Units overlap, jostle, and the silhouette is a
  rough ellipse *wider than it is deep*. At ~50 units it is about 5 units deep
  and 9 wide.
- All units face up-screen and fire forward regardless of lateral movement.
- Continuous run-in-place bob; the mass drifts as one body when steered.
- Edge units visibly separate from the blob and trail slightly — the outline is
  ragged, not a clean hull.
- **Soft round drop shadow** under every unit. This is what seats them on the
  road; without it the clump floats.
- A **green HP bar** floats above the clump once the squad is large
  (`frame_023`, `frame_030`). `frame_035` shows **two** bars — separate groups
  each carry one.

### The squad splits, and that is load-bearing

Surfaced while building the crowd, and it resolves something that otherwise
does not add up.

The road is about 6.8 m wide and a unit is about 0.58 m, so **roughly 11 units
fit abreast — a hard cap at around 70 troops.** Past that, a single blob has
nowhere to go but backwards, and the silhouette stops being wider-than-deep.
The reference never lets that happen: at ~60 units it **splits into two groups**
(hence the two HP bars in `frame_035`), and each group stays within the width
budget.

So "wider than deep" is not a formation preference — it is a consequence of a
splitting rule, and the split is what keeps the crowd reading as a crowd instead
of a column. **Our contract currently has one `squadLane` and one `health`, so
we cannot express this yet.** It needs a `types.ts` change and a product call on
whether the player steers both groups together or independently.

Until then a single blob deepens past ~100 units and the read degrades. Known
and deliberate, not an oversight.

## Bullets — the firehose

Three distinct tiers appear in 14 seconds:

1. **Single soldier** (`frame_000`–`frame_009`): 1–3 thin **orange/yellow
   tracers**, motion-stretched into streaks, rising up-screen. Small flame
   muzzle flash at the barrel.
2. **Mid squad** (`frame_030`): 3–6 orange tracers, still individually
   countable, fired from the front rank only.
3. **Upgraded** (`frame_035`): **dozens of cyan arrowhead darts** in a dense,
   slightly fanned cone. Individually indistinguishable — it reads as a stream,
   not as bullets. This is the "firehose".

Tracers are **elongated along travel**, never round dots. Density scales with
troop count; colour and shape change with weapon tier.

### The cone is narrow — trust the measurement, not your eye

Measured off `frame_035`: the stream widens about **1.5 m over 12 m of depth, a
~4° half-angle.** It reads on screen as a 25° fan only because this camera views
the corridor at a grazing ~22°, which stretches lateral motion and squashes
forward motion.

**The apparent width comes from the squad being wide, not from angular spread.**
Tuning the spread up until it matches what your eye sees on the reference sprays
bullets straight off the road. This is the easiest thing in the whole document
to get wrong by eyeballing it.

Related: the sprites are **billboards**, not quads lying along their travel
axis. A tracer oriented along its own velocity is foreshortened to ~37% by this
camera and reads as a stubby dot. The reference is clearly billboarding too.

## Gates — how upgrades are presented

- A **horizontal barrier spanning the full road width**, split into **2–4
  segments**.
- **Red segment = penalty** (`-1`, `-4`, `-5`, `-10`, `-20`). Translucent red
  panel, glowing, with vertical post dividers between segments.
- **Blue segment = reward** (`+2`, `+9`). Cyan glow, brighter, with a sparkle
  accent at the corner.
- Value text: **large, heavy, white, thick black outline**, centred per segment.
  Legible at arm's length — this is the single most important readability rule.
- **The blue value climbs while the gate approaches**: `+2` at 3.75s becomes
  `+9` at 5.33s on the same gate. Waiting pays more; the tension is that
  waiting also costs road.
- Gates arrive in **rows, stacked up the corridor**, so the next decision is
  visible while the current one resolves.

## Barrels — destructible cover

- Wooden barrel, big **white outlined numeral** on the face (`1`, `10`, `50`,
  `100`).
- The number is **hit points and it counts down** under fire: `50 → 45`,
  `100 → 98`.
- **Enemy soldiers stand on top of barrels** — gold rim-lit elites, tan
  uniforms. Destroying the barrel drops them.
- On death: **orange flash, wooden plank debris flying outward, grey smoke
  puff** (`frame_018`). Debris is chunky and readable, not a particle mist.

## Enemies

- Brown/tan walkers advancing down the road toward the squad, small and
  numerous.
- **Gold rim-lit elites** on barrels — visually distinct from player blue.
- A **motorcycle** elite on a barrel (`frame_030`, `frame_035`).
- Small **red/black HP bars** float above enemy clusters.
- **Boss bar pinned top-centre**: red skull icon + red capsule bar with a
  number that counts down `80 → 78 → 62 → 45`.

## Earning an upgrade — the growth moment

This is `frame_023`, and it is the beat Mischa called out specifically:

1. Reward resolves (gate passed / barrel destroyed).
2. **Yellow `+1` floaters** — a dozen at once, scattered across and above the
   clump, each with a thick black outline, drifting up and fading.
3. **Blue/cyan swirl ribbons** arc around the squad — curved energy streaks
   orbiting the mass, not a radial burst.
   - Alongside them, **bright vertical light shafts rise through the crowd**.
     Missed on the first pass of this teardown and caught while building the
     effect; they are a large part of why the moment reads as *energy* rather
     than as decoration, and they cost nothing extra to draw.
4. **The clump visibly grows** in the same beat. New units pop in at the blob's
   edge and settle inward.

The floaters are **per-unit-added**, not one summary number. Ten troops gained
means roughly ten `+1`s. That is what makes the growth feel earned rather than
announced.

## UI

- Back arrow, bottom-left, rounded light-grey square.
- Speed multiplier bottom-right (`4x` partially visible in `frame_023`).
- Boss bar top-centre.
- Everything else is diegetic — in the world, not on the HUD.

---

## What we are matching, and what we are not

**Matching:** behaviour, timing, layout, density, colour language, and
readability. A player glancing at our screen and the reference should read the
same information in the same places at the same speed.

**Not matching:** the bespoke character art, the bridge environment art, and the
licensed look of the units. We are on procedural primitives and instanced
meshes by design (see the asset protocol) — the target is *feel and legibility*,
not a pixel-identical copy of a shipped commercial game.
