# Commander Overkill — master execution plan

Portrait mobile line-runner. Steer a swarm through multiplier gates. The
Commander takes it extremely seriously; the screen does not.

**Reference footage:** `docs/reference/part1/` (36 frames from `Part1.mov`),
torn down in [`docs/reference/REFERENCE.md`](docs/reference/REFERENCE.md). That
teardown is the source of truth for look and feel.

---

## Phase 1 — Three.js prototype & core engine

- [x] **1.1a_ViteSetup** — Vite + TypeScript + three.js, portrait viewport meta,
      safe-area handling, no-zoom/no-scroll touch policy.
- [x] **1.1b_CIPipeline** — GitHub Actions workflow deploying `dist/` to GitHub
      Pages on every push to `main`. *Workflow written; repo not yet created —
      blocked on GitHub auth, see below.*
- [x] **1.2a_TouchInput** — single-thumb relative drag steering, tap detection
      separated from steering so a hard dodge never fires a skill.
- [x] **1.2b_CoreLoop** — fixed 60Hz simulation with render interpolation, so
      tuning is reproducible across devices and frame rates.
- [ ] **1.2c_SquadEngine** — instanced troop clump: loose blob, per-unit jostle,
      run bob, drop shadows, ragged silhouette. *In progress.*
- [ ] **1.2d_Firehose** — pooled tracer system across three weapon tiers, from
      lonely orange streaks to a dense cyan stream. *In progress.*
- [ ] **1.3a_MultiplierGates** — segmented red/blue barriers with heavy outlined
      numerals and the climbing blue value. *In progress.*
- [ ] **1.3b_GrowthFeedback** — per-unit `+1` floaters and the cyan swirl on the
      beat the army grows. *In progress.*
- [ ] **1.3c_Destructibles** — numbered barrels counting down under fire, chunky
      debris on death, gold-rim elites, boss bar. *In progress.*
- [ ] **1.4_Integration** — wire all five elements into one scene on the shared
      `WorldState` contract; verify in a browser at mobile viewport.
- [ ] **1.5_ReferenceLoop** — screenshot each element beside its reference frame,
      grade the gap, refine. Repeat until the read matches.
- [ ] **TEST_1.0** — play it on an actual phone over LAN, then on the Pages URL.

## Phase 2 — Game loop, RPG depth & extended rounds

- [ ] **2.1a_CommanderSkills** — cooldown-driven airstrikes and napalm, fired by
      tap, with deadpan radio callouts.
- [ ] **2.1b_UnitEvolution** — mid-run branching into shields, mortars, jetpacks.
- [ ] **2.1c_BossRounds** — multi-phase encounters, lane switching, destructible
      fortifications rather than a 30-second clear.
- [ ] **2.2_ProgressionTree** — post-run upgrade shop persisted to LocalStorage.
- [ ] **2.3_AudioVoice** — Commander Overkill's escalating radio chatter.

## Phase 3 — Unity migration (only after the prototype validates)

- [ ] **3.1a_UnityProjectSetup** — URP 3D, portrait, mobile render pipeline.
- [ ] **3.1b_SwarmPort** — crowd via DOTS or GPU instancing.
- [ ] **3.1c_ContentPort** — gates, barrels, progression carried across.

> Phase 3 is a **rewrite, not a port** — no runtime is shared with the web
> build. Estimate it as one, and only start it once Phase 1/2 have proven the
> game is worth porting.

---

## Blocked on you

**GitHub auth has expired**, so I cannot create the repo or push. One command in
your terminal fixes it:

```bash
gh auth refresh -h github.com
```

After that I can create `commander-overkill`, push, and enable Pages.

## Execution protocol

For every task: write the module, `npx tsc --noEmit` clean, verify the actual
behaviour in a browser at mobile viewport, then tick the box. A task is not done
because the code looks right.
