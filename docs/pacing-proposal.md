# Proposal — making the corridor feel authored

_Written 2026-08-13, for Mischa. The three decisions it asked for have been
answered — see the bottom. Nothing here is blocked._

Everything that arrives in the corridor is now authored **except when it
arrives**. Barrel hit points derive from the weapon model, gate rows are shaped
and guarantee the opening is survivable, the camera steps back to hold the
crowd. But the schedule underneath all of it is still two metronomes that do not
know about each other.

---

## What is actually wrong

**There are two independent spawners, and they collide.**

| | what it places | how often | where |
|---|---|---|---|
| `spawnRow()` in `main.ts` | 3 barrels + riders, walker pack every other row | every **4.2 s** (= 25.2 m at 6 m/s) | z = −58 |
| `gates.ts` auto-spawn | one gate row, 2–4 segments | every **16 m** | z = −58 |

Neither knows the other exists, and both drop content on the *same plane*. Every
time 25.2 m and 16 m come back into phase, a barrel row and a gate row spawn on
top of each other — which is the overlap visible in the current build. It is not
a rendering bug; it is two schedules with no conductor.

Three consequences:

1. **No rhythm.** Content arrives at a constant rate forever. There is no rest,
   no build, no surge — so there is nothing to feel relief from and nothing to
   brace for.
2. **No arc.** Difficulty escalates only on a 25-second timer inside `gates.ts`.
   A run has no shape and no destination.
3. **Nothing is placed relative to anything.** A gate that would be interesting
   *because* it sits behind a barrel you have to shoot through first can only
   happen by accident.

---

## The proposal, in four steps

Each step is shippable on its own and visible to you in the build. Steps 1 and 2
need no decisions from you. Step 3 is the one that needs your answers.

### Step 1 — One conductor owns the corridor

Replace both spawners with a single **director** that owns the timeline and
places everything, gates included (`gates.setAutoSpawn(false)`; the director
calls `gates.spawnRow` explicitly).

It enforces one rule immediately: **a minimum clear distance between anything and
anything else.** That alone removes the overlap.

*What you would see:* the same content, but never stacked on itself, and always
with enough road between decisions to read them.

*Cost:* small. This is a restructure, not new content.

### Step 2 — Beats, not a metronome

The director stops thinking in "rows every N seconds" and starts thinking in
**named beats** it strings together:

| Beat | What it is | Why it exists |
|---|---|---|
| **Decision** | a gate row alone on clear road | the choice is the whole game; it deserves to be uncontested |
| **Combat** | barrels + riders + walkers, no gate | somewhere for the guns to matter |
| **Gauntlet** | gate row placed *behind* barrels | the two mechanics finally interact |
| **Breather** | empty road, a few seconds | makes the next surge land |
| **Surge** | dense, overlapping, deliberately loud | the payoff moment |

A run becomes a sequence like *decision → combat → breather → decision → gauntlet
→ surge*. The mix and the ordering rules are data, so they can be tuned without
touching code.

*What you would see:* the run stops feeling like a treadmill and starts having
a shape. This is the step that will read as "it got better" most obviously.

*Cost:* medium. The beat types mostly reuse what already exists.

### Step 3 — An arc with an end

The PRD already says *"a multi-phase boss holds the far end."* Right now there
is no far end — the run is endless and the boss bar is a display driven by enemy
kills with nothing behind it.

Give the run a **length**, ramp the beats toward it, and put the boss at the
end. Difficulty becomes a curve across a known duration rather than a timer that
climbs forever.

*This is the step that needs your answers* — see below.

*Cost:* the pacing curve is small. **A real boss entity is not** — it is its own
milestone, and I would sequence it after step 3's curve lands, so you can feel
the ramp before the thing at the end of it exists.

### Step 4 — Tune it against measurement, not vibes

Same discipline that fixed barrel hit points. Add an autopilot to the dev
harness that plays a run making plausible gate choices, and report **troop count
over time** across many seeded runs.

That turns "does the run feel good" into a curve we can look at: where players
stall, where they run away with it, how often a run dies early.

*Cost:* small, and it pays for itself the first time we tune anything.

---

## What I would not do yet

- **Split the squad into two groups.** The stepped camera zoom may have removed
  the need — 461 troops now fit on screen as one crowd. Don't build it until
  something visibly fails without it.
- **Change the camera angle.** Still worth deciding, but it invalidates every
  calibrated measurement in the project and deserves its own milestone rather
  than being smuggled into a pacing pass.

---

## Decisions — ANSWERED by Mischa, 2026-08-13

All three came back as the proposed defaults. These are now the targets the
pacing curve is built against; treat them as decisions of record.

| Question | Answer |
|---|---|
| How long is one run? | **90 seconds to 2 minutes**, first gate to boss |
| Army size at the end of a strong run | **300–500 troops** |
| How often should a run end in failure? | **Roughly 1 in 3** |

What each one pins down:

- **90 s – 2 min** sets the number of beats in a run. At 6 m/s that is 540–720 m
  of road, so with a minimum clear distance between beats it is roughly 20–28
  of them. That is the budget the beat sequence in step 2 has to fill.
- **300–500 troops** sets the reward economy. Starting at 1, reaching ~400 over
  ~25 beats means the average beat has to roughly compound the army — which
  makes the blue gates' climbing values, not barrel payouts, the main engine.
  It also means a strong run steps the camera back twice (120 and 250) and
  stops just short of the third.
- **1 in 3 failing** sets how hard the red gates bite and when the opening mercy
  rule (`MERCY_TROOPS = 10`) should stop protecting the player. It is also the
  number step 4's autopilot measures directly, so this is falsifiable rather
  than a matter of opinion.

## Sequencing

Steps 1 and 2 are decision-free. Step 3 is now unblocked by the answers above.
Step 4 can land alongside either, and is what will tell us whether the 300–500
and 1-in-3 targets are actually being hit.
