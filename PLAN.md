# Commander Overkill — master execution plan

Portrait mobile line-runner. Steer a swarm through multiplier gates. The
Commander takes it extremely seriously; the screen does not.

- **Live:** https://onlinestuff4me-sketch.github.io/commander-overkill/
- **Start here:** [`docs/handoff.md`](docs/handoff.md) — where the work stands
- **Rules:** [`CLAUDE.md`](CLAUDE.md) — npm guardrails, invariants, verification
- **Look and feel:** [`docs/reference/REFERENCE.md`](docs/reference/REFERENCE.md)

A task is done when the behaviour has been **seen working**, not when the code
looks right. `npx tsc --noEmit` clean, then verified in a browser at mobile
viewport, then tick the box.

---

## Phase 1 — Three.js prototype & core engine

- [x] **1.1a_ViteSetup** — Vite + TypeScript + three.js, portrait viewport, safe
      areas, no-zoom touch policy.
- [x] **1.1b_CIPipeline** — GitHub Actions deploying to Pages on push to `main`.
- [x] **1.2a_TouchInput** — single-thumb relative drag; tap separated from
      steering so a hard dodge cannot burn a skill.
- [x] **1.2b_CoreLoop** — fixed 60Hz sim with render interpolation, so tuning is
      reproducible across devices.
- [x] **1.2c_SquadEngine** — instanced crowd, √n scaling at constant density,
      per-unit springs, ragged edge, contained to the road.
- [x] **1.2d_Firehose** — one stream per soldier, convergent fire, three tiers.
- [x] **1.3a_MultiplierGates** — segmented red/blue barriers with the climbing
      blue reward.
- [x] **1.3b_GrowthFeedback** — per-unit `+1` floaters with screen-space
      separation, orbiting cyan swirl.
- [x] **1.3c_Destructibles** — numbered barrels counting down under fire, chunky
      debris, gold-rim elites, boss bar.
- [x] **1.4_Integration** — all elements on the shared contract, one scene.
- [x] **1.5_VerificationHarness** — deterministic stepping, because an offscreen
      pane throttles rAF to zero and every "live" screenshot was a frozen frame.
- [x] **1.6_ReferenceLoopPass1** — screenshot against frames, grade, refine.
      Caught three units-of-measure bugs: the cone converges rather than
      diverges, tracers were 6× too long, and the crowd ratio was a screen
      reading used as a world value.

### Next up

- [ ] **1.7_CameraDecision** — match the reference's ~43° camera, or keep
      compensating at 22°? **Blocked on Mischa.** Invalidates calibration in
      every module, so it is a milestone, not an edit. See handoff §1.
- [ ] **1.8_CombatBalance** — tune barrel HP against the measured DPS curve, and
      resolve the ~254-rounds-in-flight vs the reference's ~6–8. Do both
      together; rate changes move the HP curve. See handoff §2.
- [ ] **1.9_GatePacing** — author the opening rows so a survivable segment is
      guaranteed, then drop `START_TROOPS` from 8 back to the reference's 1.
- [ ] **1.10_SquadSplit** — per-group `squadLane`/`health`; recovers steering
      range at high counts and matches the reference past ~60 troops.
      **Needs a product call** on whether one input steers both or selects.
- [ ] **1.11_Tests** — no test files exist yet. Sim modules are plain-Node
      runnable by design; start with gate resolution and reward payout.
- [ ] **TEST_1.0** — play it on a real phone, both over LAN and from the Pages
      URL. Not yet done on hardware.

## Phase 2 — Game loop, RPG depth & extended rounds

Nothing here has been started. This is the brief's actual differentiator.

- [ ] **2.1a_CommanderSkills** — cooldown airstrikes and napalm, fired by tap,
      with deadpan radio callouts.
- [ ] **2.1b_UnitEvolution** — mid-run branching into shields, mortars, jetpacks.
- [ ] **2.1c_BossEntity** — a real multi-phase boss behind the bar, lane
      switching, destructible fortifications.
- [ ] **2.1d_EnemyFire** — the reference's gold elites shoot back; ours do not.
- [ ] **2.2_ProgressionTree** — post-run upgrade shop persisted to LocalStorage.
- [ ] **2.3_RunLoop** — debrief screen, score, run summary. Zero troops
      currently just restarts silently.
- [ ] **2.4_AudioVoice** — Commander Overkill's escalating radio chatter. No
      audio exists at all.
- [ ] **2.5_Environment** — the bridge over water. Currently placeholder grass.

## Phase 3 — Native migration (only after the prototype validates)

- [ ] **3.1a_ProjectSetup** — URP 3D, portrait, mobile pipeline.
- [ ] **3.1b_SwarmPort** — crowd via DOTS or GPU instancing.
- [ ] **3.1c_ContentPort** — gates, barrels, progression.

> Phase 3 is a **rewrite, not a port** — no runtime is shared with the web
> build, and every render module is thrown away. The `WorldState`/`System` seam
> exists so the *simulation rules* survive the crossing; nothing else does.
> Estimate it as a rewrite, and only start once the game is worth porting.
