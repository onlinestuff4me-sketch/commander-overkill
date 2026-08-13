# COMMANDER OVERKILL

A portrait mobile line-runner. You steer a swarm of troops up a corridor through
multiplier gates — red segments cost you soldiers, blue ones pay, and the blue
number *climbs while the gate approaches*, so waiting pays more and costs road.

The Commander narrates the carnage with total military composure. The game takes
itself completely seriously. That's the joke.

**Play it:** https://onlinestuff4me-sketch.github.io/commander-overkill/

## Run it

```bash
npm install --ignore-scripts
npm run dev
```

Port **5174**. Open the printed Network URL on a phone on the same Wi-Fi — it is
built for a thumb at arm's length and that is the only honest way to judge it.

Add `?perf` for a frame-time overlay, `?debug` for tuning sliders.

> `--ignore-scripts` is not optional here. See [`CLAUDE.md`](CLAUDE.md) — this
> machine enforces a strict install-script policy, and the project keeps its npm
> cache local. Always `cd` into this directory first; `npm --prefix` sends the
> cache to your home folder.

## Build and test

```bash
npm run build      # tsc --noEmit && vite build
npm run typecheck
npm test           # vitest — no test files exist yet
```

## Where things are

| Path | What |
|---|---|
| `src/core/` | Loop, state machine, event bus, renderer, and the `WorldState`/`System` contract every element implements |
| `src/entities/` | Squad, barrels, enemies, growth VFX |
| `src/mechanics/` | Gates, bullets, corridor geometry |
| `src/input/` | Single-thumb touch driver |
| `src/ui/` | Boss bar, `+1` floaters, perf overlay |
| `src/main.ts` | The only place elements meet, and the only owner of `world.troops` |
| `docs/reference/` | 36 frames from the reference footage, and the teardown built from them |
| `specs/` | PRD and locked tech-stack decisions |
| `tools/` | `extract-frames.swift` — pulls frames from a `.mov` via system AVFoundation, so the project never needs ffmpeg |

## Start here

- [`docs/handoff.md`](docs/handoff.md) — where the work stands, and what to do next
- [`CLAUDE.md`](CLAUDE.md) — guardrails, invariants, and how to verify work
- [`docs/reference/REFERENCE.md`](docs/reference/REFERENCE.md) — the look-and-feel
  source of truth. **Read its measurement warning before calibrating anything**;
  three shipped bugs came from using a screen reading as a world value.

## Status

Playable prototype. All five core elements are built, integrated, and verified on
screen. The RPG layer the design actually hinges on — commander skills, unit
evolution, progression — does not exist yet. **Not yet played on real phone
hardware**, and until it is, treat every performance number here as unproven.
