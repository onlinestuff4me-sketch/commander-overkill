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

Each step is shippable on its own and visible to you in the build. All four are
unblocked — the decisions step 3 depended on are answered at the bottom.

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

### Step 3 — Levels, and an arc with an end

The PRD already says *"a multi-phase boss holds the far end."* Right now there
is no far end — the run is endless and the boss bar is a display driven by enemy
kills with nothing behind it.

Give the run a **length**, ramp the beats toward it, and put the boss at the
end. Difficulty becomes a curve across a known duration rather than a timer that
climbs forever.

This step also introduces **levels**, because difficulty is now scaled by level
(see the decisions below). A level is one run: 90 s to 2 min, ending in a boss.
Level number is what selects the penalty band and the single-gate cap.

*Targets:* a run is 90 s to 2 min and a strong one ends at 300–500 troops. See
the decisions at the bottom.

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
| How often should a run end in failure? | **Scales by level** — see below |

**Failure rate is per level, and it ramps:**

| Level | Runs that end in failure |
|---|---|
| 1–2 | **1 in 8** — forgiving, power fantasy |
| 3–4 | **1 in 5** — losses start to bite |
| 5+ | not yet decided |

Mischa's framing for the early levels, which matters as much as the number:
risk in levels 1–2 should be about **obvious lost opportunity and small but
meaningful troop losses**, not death. The player should clearly see what a poor
choice cost them — both the troops it took *and* the growth it forfeited — while
almost never being wiped out by it.

What each one pins down:

- **90 s – 2 min** sets the number of beats in a run. At 6 m/s that is 540–720 m
  of road, so with a minimum clear distance between beats it is roughly 20–28
  of them. That is the budget the beat sequence in step 2 has to fill.
- **300–500 troops** sets the reward economy. Starting at 1, reaching ~400 over
  ~25 beats means the average beat has to roughly compound the army — which
  makes the blue gates' climbing values, not barrel payouts, the main engine.
  It also means a strong run steps the camera back twice (120 and 250) and
  stops just short of the third.
- **The scaling failure rate is the one with teeth.** See below: it cannot be
  built on the penalty model we currently have.

---

## The problem the scaling failure rate creates

**Penalties are absolute numbers. The army is exponential. Those do not mix.**

To reach ~400 troops in ~25 beats the army has to grow about **27% per beat**.
Against that, a fixed penalty decays into nothing:

| Army | What a `-5` gate actually costs |
|---|---|
| 8 | **62%** of everything you have |
| 20 | 25% |
| 60 | 8% |
| 150 | 3% |
| 400 | **1.2%** — noise |

So the current model is the *exact inverse* of what Mischa asked for. It is
brutal at the start, where he wants forgiveness, and irrelevant by the end,
where he wants teeth. `gates.ts` papers over this by escalating penalties on a
25-second timer, but a timer does not know how strong the player actually is —
a struggling squad and a runaway one meet the same `-20`.

### The fix: penalties are a share of the army, shown as a number

A red segment picks a **percentage of the current troop count**, rounds it, and
paints that. You still read `-2` early and `-40` late — the number on the gate
is absolute, the rule behind it is proportional.

**This is what the reference does.** `Part1.mov` shows `-1` through `-20` with
an army of 1–60. `reference-clip-1a.mov` shows a `-300` gate with an army in the
hundreds and barrels at 450–600. The magnitudes track the army; they were never
a fixed table.

### What that buys, in the terms of the ask

Each level sets a penalty band and a **single-gate cap** — the most any one
mistake may take:

| Level | Penalty band | One gate may never take more than | Consecutive worst-case rows to wipe out |
|---|---|---|---|
| 1–2 | 8–18% | 35% | **7–9** |
| 3–4 | 15–30% | 50% | **5–6** |

That cap is what makes "rarely catastrophic" true **by construction** rather
than by luck. In levels 1–2 no single bad decision can end a run; it takes seven
in a row with no rewards in between. By levels 3–4 it takes five. The dial
between 1-in-8 and 1-in-5 is that cap and that band, and step 4's autopilot
measures whether we hit it.

Two floors keep the bottom of the curve sane: a penalty is never less than 1,
and the existing mercy rule (`MERCY_TROOPS`) still guarantees a blue segment
while the squad is tiny.

### Making the lost opportunity visible

"The player should see the consequences of not taking enough risks" is a
feature, not a tuning value. Right now the segments you *didn't* take simply
burst and vanish, so a missed `+9` and a missed `+1` look identical.

Proposal: as a row resolves, the **best segment you did not take briefly shows
what it would have paid**, ghosted, next to what you actually got. That is the
whole "obvious lost opportunity" ask in one mechanic, and it is what makes an
early level teach without killing.

---

## What this needs that does not exist yet

**There is no concept of a level.** `WorldState` has no level, the run is
endless, and `gates.ts` escalates on a wall-clock timer. Difficulty-by-level
needs a level to exist first, so that is the prerequisite for step 3 — and it is
what turns "the run" into "level 1".

## Sequencing

Steps 1 and 2 are decision-free and can start now.

Step 3 is unblocked in shape but has a prerequisite of its own: **the level
concept has to exist**, and the penalty model has to become proportional, before
"1 in 8 on level 1, 1 in 5 on level 3" can mean anything. Sequenced:

1. Conductor (step 1)
2. Beats (step 2)
3. Autopilot measurement (step 4) — **moved earlier on purpose**, because the
   whole difficulty ask is stated as failure rates, and a failure rate is not
   something you can eyeball. Without this we would be guessing at 1-in-8.
4. Levels + proportional penalties + the lost-opportunity display
5. A real boss entity — its own milestone, after the ramp is felt

Two things still open: the failure rate beyond level 4, and what happens when a
run fails (replay the level, or lose the campaign).
