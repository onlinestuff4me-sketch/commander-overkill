# Making the run dynamic — where the fun is missing, and what to build

_Written 2026-09-01, against the build at `c93f183`._

Mischa's ask: **more second-to-second challenge, and more risk-and-reward
decisions to make as you play.** This is the research behind that and the plan
that comes out of it. Nothing here is built yet.

---

## 1. What the game actually asks of you, measured

Driving the conductor over a two-minute run at the default 6 m/s
(`createDirector(7)`, 720 m of road):

| | |
|---|---|
| Placements | 39 |
| Of those, DECISIONS (a gate row, a compound, a boss) | 27 |
| Median gap between placements | **2.8 s** |
| Median gap between decisions | **3.2 s** |
| Longest stretch with no decision | **10.1 s** |

And the decision itself is: put the crowd in one of two or three lateral
positions, then wait for the row to arrive and resolve itself.

So the honest description of the current loop is:

> Every three seconds, choose a lane. Hold it. Watch the game resolve it.

The choosing takes well under a second. **Two seconds in every three have
nothing in them at all** — no input, no risk, nothing being spent or earned by
the player's hands.

## 2. The diagnosis, in one line

**Nothing in this game creates tension between MOVING and STAYING.**

Moving is free. Staying is free. There is no meter that fills while you hold
still, no cost to a dodge, no reason to be anywhere in particular except in the
half-second before a row lands. Every good one-axis game — and this is a
one-axis game — generates its moment-to-moment play from exactly that tension:
*something rewards me for being here, something else demands I be there.*

Three specific absences follow from it:

**No continuous pressure.** Nothing costs you anything for holding a lane, so
between rows the correct play is to do nothing.

**No execution layer.** Every decision resolves on contact. There is no timing,
no aiming, nothing you can do well or badly — only correctly or incorrectly.
Choice without execution is a quiz, not a game.

**Growth is almost free.** The only cost of a big army is that lateral speed
eases from 7 m/s to 5 past 400 troops (`MASS_TROOPS`, `squad.ts`). The thing the
whole damage model runs on — the crowd's WIDTH — is not something the player
controls or can spend.

## 3. Two things already in the tree that nobody is using

Worth knowing before designing anything new:

**A second verb is already wired and has no listener.** `src/input/touch.ts`
distinguishes a tap from a drag (`TAP_MS`, `TAP_SLOP`) and emits `input:tap` on
the bus. Its own header says "skills fire on tap". Nothing anywhere subscribes.
The whole input side of an active ability exists and costs nothing to adopt.

**Crowd width is the hidden variable of the entire combat model.**
`laneCoverage(streamHalfWidth)` in `mechanics/pacing.ts` decides what share of
the army's fire lands on any one target, and `world.squadHalfWidth` decides how
many gate segments a row charges you for. A wide army does more total damage
across the road and pays more tolls; a narrow one drills one hole and slips
through gaps. **That is a genuinely interesting trade and the player has no
control over which side of it they are on.**

---

## 4. The plan

Ordered by impact per unit of work. The first two are the ones that change what
playing the game feels like second to second; the rest raise the stakes of
decisions that already exist.

### P1 — TIGHTEN: give the player control of the crowd's width

**Tap to compress the army into a narrow column for ~1.5 s, then it spreads back
out. Cooldown, so it is a resource rather than a stance.**

This is the single highest-value change available, because it turns the model's
central hidden variable into the player's main verb:

- **Narrow gets you through.** A 500-strong army is five metres wide and cannot
  help smashing every segment of a row it meets. Tightened, it threads the gap.
- **Narrow concentrates fire.** All of the curtain on one lane: the fastest way
  to fill a blue or break a boss.
- **Narrow gives up the road.** While tight you cover one lane instead of three,
  so the barrels either side go unshot and a second target is unreachable.

Every one of those is a live decision with an obvious upside and an obvious
cost, available at any moment, on a cooldown that makes it a thing to spend
rather than a thing to hold. It also makes SIZE meaningful for the first time:
being big is now a real handicap you have a real tool to manage.

*Cost:* medium. `input:tap` already fires; the squad already computes its own
radius each tick and everything downstream reads `world.squadHalfWidth`, so this
is a multiplier on one number plus a cooldown and a readout.

*Risk:* the crowd's spring settling is what makes the blob feel like a crowd;
compressing it hard could look like a scale animation rather than men moving.
Prototype the squeeze before building the economy around it.

### P2 — FOCUS: give the player a reason to stand still

**Hold the crowd steady and a focus meter fills over about 1.5 s. Full focus
tightens the fire into a bright concentrated stream that does substantially more
damage to whatever is dead ahead. A hard dodge resets it.**

P1 gives you a reason to move and a tool for it. This gives you a reason NOT to,
and it is what puts a stake on every second rather than every third second:

> Do I break focus to grab that barrel, or hold it and melt the thing in front
> of me?

That question is available continuously, needs no new content on the road, and
gets harder the more the corridor offers.

It also fixes something the reference has and we do not: their fire visibly
changes character. Ours is one texture at one density forever.

*Cost:* medium. A `focus` value on `WorldState`, driven by the squad's own
lateral speed; bullets read it for spread and damage; a ring under the crowd
reads it out.

*Clip potential:* high — a fully focused army deleting a boss in one beat is the
moment somebody films.

### P3 — Two options on one plane, as the default rather than the exception

The conductor's compound beats (`blockade`, `crossroads`) are the only ones that
put two things the player wants on the same stretch of road, where taking one is
not taking the other. Over the measured run they were **5 placements out of 39**.

Raising their weight, and adding one or two more compound shapes (a prize behind
a red row; two blues at different distances so you can only fill one), directly
raises the fraction of decisions that have teeth. It is a beat-table edit.

*Cost:* trivial. *Caveat, learned the hard way and written into the table: a beat
displaces other beats — when the ogre beats went in at weight 2 the run's failure
rate halved. Re-measure the wipe rate after any change here.*

### P4 — STREAK: a thread that runs the whole way through

**Rows crossed without touching a red build a multiplier on everything blue pays,
1× → 3×. One red segment resets it to 1×.**

Cheap, and it does something none of the above does: it makes the SAFE play
valuable and losing it hurt, so a run develops a state you are protecting. It
also gives the greedy line an honest counter-argument — right now "go round the
row" is free, and this is what prices it.

*Cost:* low. A counter in `main.ts`, a multiplier at the payout, and a readout.

### P5 — Something to chase in the empty seconds

A thin stream of small troop motes that drifts across the road between rows —
one or two troops each, snaking, so the collecting line is never the safe line.

This is the standard runner answer to dead time and it works: it puts a small
continuous pull on the thumb without adding another thing to read.

*Cost:* low-medium. A small pooled module; the pickup flight and payout paths
already exist.

### P6 — Hazards that move sideways

Everything on the road currently travels straight at the player, which means the
whole board is readable three seconds out and needs one adjustment. One class of
content that slides across lanes as it approaches — a patrolling heavy, a rolling
mine, a wrecking ball swinging from the bridge's own cables — forces continuous
re-aiming rather than a single decision.

The boss's charge already does this; this is generalising it to ordinary content.

*Cost:* medium. Likely a movement flag on the enemy module rather than a new one.

### P7 — The Commander, who does not exist yet

Not a challenge item, a FUN item, and it is the whole premise of the game per
`specs/prd.md`: a voice that narrates the carnage with total military composure
and never breaks. There is currently no Commander in the build at all.

Short text callouts at the loud moments — a boss dying, a streak hitting 3×, an
army passing 500 — cost one more DOM element and are the cheapest personality in
the project.

---

## 5. What I would build first, and why

**P1 and P2 together, as one batch.** They are two halves of one idea — a reason
to move and a reason to stay — and either alone is half a mechanic. Together they
turn every second of the run into a small decision, which is exactly what was
asked for, and they need no new content on the road to do it.

Then **P4 (streak)** and **P3 (compound-by-default)** as a small second batch:
both are cheap, and between them they give the run a state worth protecting and
a higher density of real either/ors.

**P5–P7 after that**, judged on what the first two batches actually feel like.

## 6. How we will know it worked

The instrument we have is `__overkill.sample(32, 110, 0.3)`, and the note at the
top of the handoff applies: **trust the wipe rate, not the median** — three
samples of an unchanged build gave medians of 301, 445 and 254 while the wipe
count moved by one.

For this work the wipe rate is not the interesting number either, because the
goal is not difficulty. Two things to watch instead:

1. **Inputs per minute.** The autopilot re-decides on a fixed 0.3 s clock, so it
   cannot measure this — a human playtest can. If the answer after P1/P2 is not
   "noticeably more", the mechanics are not paying for themselves.
2. **Spread of outcomes at a fixed skill level.** If a well-played run and a
   badly played one currently land in the same place, there is no skill in the
   game to express. Widening that gap is the actual goal here, and `sample()`'s
   min/max spread across a fixed reaction time is a proxy for it.
