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

### Step 1 — One conductor owns the corridor — ✅ DONE

`mechanics/director.ts`. One cursor walks one cycle and answers "place this
now"; `main.ts` executes it. Gates no longer pace themselves
(`autoSpawn: false`), so the second metronome is gone and **two things can no
longer occupy the same stretch of road by construction**.

Two things came out of building it that were not in the plan:

- **The old schedules were unschedulable in principle.** Combined demand was
  1/16 + 1/25.2 + 1/50.4 = 0.122 placements per metre — one every 8.2 m. Ask for
  a legible 11 m gap and that simply does not fit, so "the same content, never
  stacked" was not achievable. Gates now land every ~19.6 m against 16 m before;
  barrel rows are sparser. The cycle makes that trade explicit instead of
  resolving it by collision.
- **The gap has to depend on the PAIR, not be a constant.** 11 m between a gate
  and a barrel row is fine — a barrel asks nothing of the player's thumb. 11 m
  between two gates is 1.8 s to read a decision, act on it, and read the next.
  Gate-to-gate is 16 m, the figure the gate module used on its own. What needs
  separating is decisions, not objects.

The corridor is also primed at the start of a run by **replaying the director**
for 40 m, so the opening layout obeys the same spacing rule as everything after
it rather than being a hand-placed special case that can drift.

*Verified:* 15 tests over spacing, mix, determinism and reset; driven in a
browser from the opening frame to 42 s.

### Step 2 — Beats, not a metronome — ✅ DONE

The director stops thinking in "rows every N seconds" and starts thinking in
**named beats** it strings together:

| Beat | What it is | Why it exists |
|---|---|---|
| **Decision** | a gate row alone on clear road | the choice is the whole game; it deserves to be uncontested |
| **Combat** | barrels + riders + walkers, no gate | somewhere for the guns to matter |
| **Gauntlet** | gate row placed *behind* barrels | the two mechanics finally interact |
| **Breather** | empty road, a few seconds | makes the next surge land |
| **Surge** | dense, overlapping, deliberately loud | the payoff moment |

Shipped as `BEATS` in `mechanics/director.ts` — a weighted table of named
phrases, each with the extra road that follows it. The scheduler guarantees
spacing; the table decides the rhythm, so changing how a run feels is editing
data rather than logic.

Two rules keep it from wandering: `rest` and `surge` may not repeat (two rests
is fifty metres of nothing, two surges is a wall), and after three placements
without a gate the next beat must LEAD with one — measured worst-case dry streak
is 4 placements over 20 km of corridor.

Building it turned up a spacing bug the fixed cycle had hidden: the gap was
computed from the next placement *within the same beat*, so a beat ending on a
gate followed by one starting on a gate got the narrow 11 m gap instead of 16 m.
The gap now resolves across the beat boundary.

### Step 4 — partially done

`__overkill.autopilot(seconds)` plays a run steering at the best segment of the
nearest gate and reports the troop curve. First measurement, 120 s: **1 → 173
troops, zero wipeouts**. Under the 300–500 target, so the reward economy needs
tuning — but it is now a number rather than an opinion.

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

**Failure rate is per level, and it plateaus in bands** — each ratio holds for
longer as the levels climb:

| Level | Runs that end in failure |
|---|---|
| 1–2 | **1 in 8** — forgiving, power fantasy |
| 3 | *not specified — assumed 1 in 7, see below* |
| 4–6 | **1 in 6** |
| 7–10 | **1 in 5** |
| 11–15 | **1 in 4** |
| 16–21 | **1 in 3** |

> **Gap to confirm:** level 3 was not given a band (the answer jumped from
> "levels 1–2" to "levels 4–6"). Assumed **1 in 7** as the interpolation, which
> keeps the early-game promise intact. Cheap to change.

This also implies **~21+ levels**, which is the first time the game has had a
stated length beyond one run.

**On failure, the player chooses: retry the level, or start over.** Meta
progression is explicitly a later revisit — but it should be kept in mind while
building the level structure, because "what carries between attempts" is the
hook it will hang on.

Mischa's framing for the early levels, which matters as much as the number:
risk in levels 1–2 should be about **lost opportunity and small but meaningful
troop losses**, not death. The player should feel what a poor choice cost them —
both the troops it took *and* the growth it forfeited — while almost never being
wiped out by it. **Felt, not read**: see "Teaching consequence without asking
anyone to read" below.

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

### Teaching consequence without asking anyone to read

An earlier draft proposed ghosting the value of the segment you did not take.
**Rejected, and rightly** — it teaches by making the player read a number at the
exact moment they should be watching their army. The lesson should be felt in
the game state, not annotated on top of it.

Mischa's framing is about strategy across a run, not regret about one gate:

- committing to a reward that takes longer to earn beats jumping between them
  and arriving with nothing,
- investing in growth early is what makes you strong enough for later waves,
- spreading rewards across types gives balanced power, where over-investing in
  one leaves a hole.

Three mechanics, in increasing order of cost. None of them displays text.

#### 1. Commitment is what makes the number climb

The blue value already climbs as a gate approaches. Today it climbs **on its own
schedule regardless of what the player does**, so there is no reward for
committing and no cost to flitting.

Change it so the climb tracks **the segment the squad is actually lined up
with**. Stay on it and it keeps climbing; swing away and it stalls and slides
back while the one you switched to starts low.

Now lane-jumping is punished by something the player watches happen: the big
number they abandoned visibly falls. Holding a line pays, and it pays *visibly
more* the longer you hold. That is lesson one, with no text and no new art —
it is a change to a value that is already on screen.

*Cost:* small. `gates.ts` already owns the climb; it needs to know which segment
the squad is aligned with, which `world.squadCenter` already provides.

#### 2. Being under-powered should be felt as a wall

Right now it cannot be. `barrelHp()` deliberately caps every barrel at 55% of
what the current army can destroy in one approach — I built that so a weak squad
would never meet an unkillable barrel. It also means **the player can never be
too weak for anything**, which makes "you under-invested and now you are
under-powered" impossible to express.

From some level onward, lift the cap: a barrel that outlives your fire survives,
reaches the crowd, and costs troops on impact. Nothing is announced. You simply
watch the number on the barrel fail to reach zero in time, and then it hits you.

This is the most direct "show, don't tell" available, and it is the natural home
for the escalating failure rate — an under-invested army fails on contact rather
than on a dice roll.

*Cost:* small in code, and it is a difficulty dial rather than new content. Needs
care: the cap is what currently guarantees the opening is winnable, so it must
stay in force for the early levels.

#### 3. Two kinds of power, so the player can be lopsided

This is the one that unlocks "diversify your rewards", and it does not exist yet.

`tierFor(troops)` in `main.ts` derives weapon tier **purely from troop count** —
under 4 is tier 0, under 40 tier 1, above that tier 2. So quantity and quality
are the same axis. **You cannot currently be a big weak army or a small elite
one**, which means there is nothing to balance and no way to be lopsided.

Split them. Troops stay the crowd; weapon tier becomes its own earnable reward
that some gates pay instead of troops. Then the shapes the player can end up in
become visible on their own:

| What you over-invested in | What you see |
|---|---|
| Troops only | A huge crowd whose fire cannot break a late barrel before it arrives |
| Weapons only | A small squad that shreds anything but gets swamped by a wave |
| Balanced | Wide enough to cover the road, strong enough to clear it |

No readout is needed: the crowd's size and the barrel's numeral falling (or not)
say it. It also gives the reward economy a second currency, which is what makes a
gate choice a *strategy* rather than a bigger-number check.

*Cost:* medium, and it touches the weapon tier contract. Worth flagging that it
is the first real piece of the RPG layer in `PLAN.md` Phase 2, so it is a good
place for that work to start rather than a detour from pacing.

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
4. Levels + proportional penalties + the commitment climb (mechanic 1)
5. Lifting the barrel cap in later levels (mechanic 2) — needs the autopilot
   first, since it is the main dial on the failure rate
6. Splitting troops from weapon tier (mechanic 3) — the biggest of the three,
   and the natural start of the RPG layer rather than a pacing detour
7. A real boss entity — its own milestone, after the ramp is felt

Open: level 3's failure band (assumed 1 in 7), and what meta progression carries
between attempts — which only needs answering once levels exist.
