# Commander Overkill — rules for agents

Portrait mobile line-runner. Steer a swarm through multiplier gates. The
Commander takes it extremely seriously; the screen does not.

**Read before writing any code:**

| File | What it is |
|---|---|
| [`docs/handoff.md`](docs/handoff.md) | Where the work stands and what to do next. **Start here.** |
| [`docs/reference/REFERENCE.md`](docs/reference/REFERENCE.md) | Teardown of the reference footage. The look-and-feel source of truth. |
| [`specs/prd.md`](specs/prd.md) | What the game is, and what it deliberately is not. |
| [`specs/tech-stack.md`](specs/tech-stack.md) | Locked technical choices and the gotchas that cost time. |
| [`PLAN.md`](PLAN.md) | Task roadmap across all three phases. |

Mischa is a non-technical PM. He owns scope and priorities; agents own technical
execution. Never ask him a technical question he has no way of evaluating —
make the call, do it, and explain in plain language what changed for him.

---

## npm — the hard rules

This machine enforces `--strict-allow-scripts`. Installs fail if any package
wants a lifecycle script. **The guardrail is you, not the sandbox.**

- **`cd` into the project before any npm command.** `npm --prefix <dir>` does
  NOT relocate `.npmrc` — that is read from the *working directory*, so running
  from the workspace root sends the cache to `~/.npm`. Measured, confirmed, and
  it is silent when it happens.
- The project `.npmrc` contains **`cache=.npm-cache` and nothing else.** Never
  add `allowScripts`, `strict-allow-scripts=false`, or `min-release-age` — a
  project `.npmrc` silently overrides Mischa's user-level policy.
- Install with **`--ignore-scripts`**. That is how this tree was built.
- **Never run `npm approve-scripts`**, in any form, especially `--all`. If an
  install is blocked, stop and report which package wants what. Mischa's threat
  model explicitly includes agents approving install scripts.
- Do not add dependencies. three.js and lil-gui are here; that is the budget.
- `ERROR: failed to copy trust settings of system certificate-#####` is the
  sandbox blocking the cert store. npm still exits 0 — **check the exit code,
  not the word ERROR.**

---

## Architecture invariants

**The `WorldState` / `System` contract in `src/core/types.ts` is the seam.**
Every element module reads that and nothing else about the rest of the game.
Five modules were built in parallel by agents blind to each other and composed
without a single interface change — that is the contract earning its keep, and
it is also the seam the Phase 3 native port will cut along. Do not create
direct module-to-module imports between elements.

- **`src/main.ts` is the only place elements meet**, and the only place that
  owns `world.troops`. A gate reports that it was crossed; it does not pay
  itself. Route every reward through `payTroops()` so the growth beat is
  identical regardless of source.
- **Update order is load-bearing** and is spelled out explicitly in `tick()`.
  Squad first — it writes `world.squadCenter`, which bullets aim from and gates
  resolve against.
- **One agent owns one file.** Parallel agents must never share a file.
- **No allocation in `update()`/`render()`.** Preallocate and reuse; GC pauses
  read as stutter.
- **`InstancedMesh` for anything over ~20 copies**, pooled and recycled.
- **No shadow maps, no post-processing.** Drop shadows are flat discs.
- **Cap `devicePixelRatio` at 2.** Phones report 3, which is 9× the pixels for
  a display held at arm's length.

---

## Verifying your work

**`npx tsc --noEmit` must exit 0 before you report done.** Strict mode is on
with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`verbatimModuleSyntax` — type-only imports must use `import type`.

**The dev server must run from inside this directory:**

```bash
cd ~/Documents/claude-workspace/projects/commander-overkill && npm run dev
```

Port **5174** (5173 belongs to the neighbouring `swarm-game` project).

**An offscreen browser pane throttles `requestAnimationFrame` to zero frames**,
so screenshotting a "live" run captures whichever frame it froze on. Drive the
world deterministically instead — in dev builds `window.__overkill` exposes:

```js
__overkill.step(ticks)     // advance N fixed steps, then draw once
__overkill.setTroops(n)
__overkill.setLane(-1..1)
__overkill.pay(n)          // triggers the full growth beat
__overkill.stats()         // troops, tier, draw calls, triangles
```

Posing the world at an exact state (`48 troops, mid-growth`) and comparing that
against a named reference frame is better than trying to catch the moment live.

**Subagents must not drive the browser.** One pane, one tab — parallel agents
will collide. Build to spec; the orchestrator screenshots and grades.

---

## Measurement discipline

See the warning at the top of `docs/reference/REFERENCE.md`. Short version:
**three shipped calibration bugs all came from using a screen measurement as a
world value**, and the reference's camera is 43° where ours is 22°. Measure in
helmet diameters or road widths, then convert. Report numbers, not impressions —
"looks orange in the texture" is not evidence; "saturation 0.600 composited over
a 0.727 grey road" is.

---

## Code style

Match the surrounding code: comments explain **why** a non-obvious choice was
made, not what the line does. Several constants in this codebase are load-bearing
in ways that are invisible without the comment above them — preserve that.

Commit messages state what changed and why it mattered, in prose, not bullet
lists of files.
