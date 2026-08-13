# Commander Overkill — PRD

## Problem

Mob-runner games (*Mob Control*, *Last War: Survival*) nail a 30-second dopamine
loop — steer a swarm, hit a multiplier, watch the screen fill — and then have
nowhere to go. The run ends before any decision compounds. Meanwhile RPG-depth
games have the compounding but not the immediate, physical joy of watching your
number become a crowd.

**Commander Overkill takes the runner loop and gives it somewhere to go.**

## The joke

The Commander narrates screen-clearing carnage with total military composure,
and the gap between his tone and the absurdity on screen is the comedy. He never
breaks. *"Private. That gate tripled our infantry count. Execute tactical
celebratory flex immediately."*

The game takes itself completely seriously. That's the joke.

## Goals

1. A run that is **legible at a glance on a phone at arm's length** — every
   number, gate, and threat readable in under a second.
2. **Growth you feel**, not growth you're told about. Ten troops gained is ten
   `+1`s and a visibly bigger crowd, never a summary popup.
3. **Decisions with teeth.** Gates chain so you cannot take them all; which one
   you commit to is the run.
4. **Rounds long enough to matter** — multi-phase bosses and fortified
   structures, not a 30-second clear.
5. **60fps on a mid-range phone** at 1,000+ units on screen.

## Non-goals (v1)

- Multiplayer, PvP, leaderboards.
- Accounts, cloud save, analytics.
- Monetisation, ads, IAP.
- Native app stores — that is Phase 3, and only if the prototype validates.
- Bespoke character art. Procedural primitives and instanced meshes until the
  frame budget is proven.

## Core loop

1. Your squad advances up a corridor. You steer with one thumb.
2. Gates arrive in rows — red segments cost troops, blue segments pay. **The
   blue value climbs as the gate approaches**, so waiting pays more and costs
   road.
3. Your squad fires continuously. Fire density scales with troop count; the
   weapon tier changes what it looks like.
4. Numbered barrels are cover and targets; the number is hit points and it
   counts down as you shoot.
5. Rewards resolve as `+1` floaters and a visible swell of the crowd.
6. A multi-phase boss holds the far end.

## User stories

- *As a player on a bus*, I can play one-handed in portrait without ever needing
  a second thumb.
- *As a player*, when I earn troops I can see exactly how many arrived, because
  each one announces itself.
- *As a player*, I can tell at a glance which gate is the good one, from colour
  alone, before I can read the number.
- *As a player*, choosing between two gates feels like giving something up.
- *As a returning player*, my upgrades persisted and my next run starts stronger.

## Success criteria

| Criterion | Measure |
|---|---|
| Reads correctly | A new player names the good gate in under 1s, unprompted |
| Feels earned | Growth moments are noticed and remarked on in playtest |
| Performs | 60fps sustained on a real phone at 1,000+ units |
| Has depth | Players make a different gate choice on a second run |
| Ships | Playable at a URL Mischa can text to someone |

## Open questions

- Does the player character exist as a distinct hero unit, or is the Commander
  purely a voice over the squad? The reference has no hero avatar; our brief has
  one. **Unresolved — affects the RPG skill tree design.**
- Do troops persist between runs, or reset with only upgrades carrying over?
- Is the corridor always a bridge, or does the environment vary by stage?

## Assumptions flagged

- The reference footage (`Part1.mov`) is the intended look-and-feel target, not
  just a mechanics reference. Working on that basis.
- Portrait-only. No landscape support planned.
