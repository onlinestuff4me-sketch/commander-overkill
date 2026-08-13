# Tech stack — locked choices and the gotchas that cost time

## Phase 1 (web prototype)

| Piece | Choice | Why, over the obvious alternative |
|---|---|---|
| Renderer | **three.js 0.185, WebGL2** | Not WebGPU. The workload is high mesh-count instancing, which is exactly where the WebGPU backend still regresses. |
| Build | **Vite 8** | Sub-second HMR, and a LAN URL you can open on a phone. |
| Language | **TypeScript, strict** | Five parallel element modules against one `WorldState` contract; the compiler is what keeps that contract honest. |
| Tests | **Vitest 4** | Simulation modules are plain-Node runnable by design. |
| Physics | **None. Hand-rolled.** | See below. |
| Deployment | **GitHub Pages via Actions** | Push to `main`, get a URL you can text to a playtester. |
| Backend | **None** | No accounts, no cloud save, no analytics in the prototype. |

## Rapier3D — deliberately not installed

The brief specced Rapier3D. It is not in the project, and this is the reasoning
so it does not get silently re-added:

Running 1,000+ crowd agents through a general rigid-body solver on a mobile
browser is a known performance trap — broadphase and constraint solving both
scale badly at that agent count, and none of it buys anything, because crowd
units need *steering and separation*, not restitution and friction. A spatial
hash with O(n) neighbour queries is both faster and easier to tune.

**Rapier goes in when there is something it is genuinely good at:** destructible
fortress debris, boss rigid bodies, ragdolls. Tens of bodies, not thousands.
Until then it is a dependency with no job.

## Mobile performance rules

These are load-bearing, not preferences:

- **Cap `devicePixelRatio` at 2.** Phones report 3, which is 9× the pixels of
  DPR 1 on a display held at arm's length. Invisible to the eye, roughly half
  the fill rate back. Single cheapest 60fps decision available.
- **No shadow maps.** Drop shadows are flat translucent discs. Real shadows are
  the second thing that kills a mobile frame budget.
- **`InstancedMesh` for anything over ~20 copies**, pooled and recycled.
- **No allocation inside `update()`/`render()`.** Preallocate vectors and
  matrices; GC pauses read as stutter.
- **Fixed 60Hz simulation** with render interpolation, so a gate pays the same
  on a 120Hz iPad as on a throttled Android.

## npm policy — read before installing anything

This machine enforces `--strict-allow-scripts`. Installs fail if any package
wants a lifecycle script.

- The project `.npmrc` contains **`cache=.npm-cache` and nothing else**. Never
  add `allowScripts`, `strict-allow-scripts=false`, or `min-release-age` to it —
  a project `.npmrc` silently overrides the user-level policy.
- Install with **`--ignore-scripts`**. That is how the current tree was built:
  `fsevents` ships a prebuilt binary, so its `node-gyp rebuild` never needed to
  run. CI uses `npm ci --ignore-scripts` to stay in step.
- **Never run `npm approve-scripts`.** If an install is blocked, report which
  package wants what and let Mischa decide.
- `ERROR: failed to copy trust settings of system certificate-#####` on stderr
  is the sandbox blocking the system cert store. npm still exits 0 — check the
  exit code, not the word ERROR.

### Known advisory, accepted

`nanoid <3.3.18` (high) arrives via `vite → postcss → nanoid`. It is a
**build-time dev dependency and never ships to players**, the advisory requires
a custom generator called with size zero (postcss does not do this), and the
version is pinned by postcss so `npm audit fix` cannot move it without forcing
Vite. Accepted deliberately; revisit when postcss bumps.

## Tooling

`tools/extract-frames.swift` pulls frames out of reference `.mov` files using
system AVFoundation, so the project never takes an ffmpeg dependency just to
look at a video. It needs the sandbox off to run (Swift's compiler cache lives
at a hardcoded `/var/folders` path).

## Phase 2 (native) — deferred, not decided

The brief names Unity URP with DOTS. That remains the plan of record, but it is
**a rewrite, not a port** — no runtime is shared with the web build, and
`src/core/renderer.ts` plus every element module is thrown away. The
`WorldState`/`System` seam exists so the *simulation rules* survive that
crossing; nothing else does.

Port on proven demand, not on intention.
