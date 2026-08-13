# Reference teardown — `reference-clip-1a.mov`

Source: 8.24 s portrait screen capture, 1206×2622, 60fps, HEVC. 33 frames
extracted to `clip1a/` at 4fps and 720px wide.

This is a **later stage of the same game** than `docs/reference/Part1.mov`, and
where the two disagree, this one is the newer evidence about what the game
actually is. Both are the source of truth for different things:

| | `Part1.mov` | `reference-clip-1a.mov` |
|---|---|---|
| Stage | opening, 1–60 troops | mid-run, hundreds of troops |
| Units | infantry on foot | infantry, then motorcycles |
| Road | single carriageway | two-carriageway bridge, player on the left |
| Best for | unit scale, gate anatomy, opening beat | crowd envelope, bullet stream, steering |

Frames are named `f_001` … `f_033` at 0.25 s intervals.

---

## What this clip settled

### 1. The bullet stream is many parallel columns, and all of them count

`f_013` at 45% frame depth is almost entirely tracer. Scanning that row gives
**~15 distinct fire runs spanning x = 11…486 of a 720px frame**, spaced ~33px
apart — individually visible columns, not a single jet.

They travel **parallel**, and every column registers on whatever it crosses. A
barrel clipped by the edge of the stream ticks down slowly; one squarely inside
it melts. This is the mechanic the game is built on, and it makes the crowd's
WIDTH into a weapon: a wide army covers several barrel lanes at once, a narrow
one drills a single hole.

**This is why `convergeDistance` is 0.** The convergence model was derived from
`frame_030` of Part1.mov, where one barrel sits in the player's lane and "did
the army hit it" is the only question. It collapsed all fire onto the squad's
axis by target depth, which makes multi-lane coverage impossible by
construction.

Our measured coverage, damage per pass by how far a barrel sits off the squad's
lane (0 = dead ahead, 1 = road edge):

| troops | 0 | 0.25 | 0.5 | 0.75 | 1.0 |
|---|---|---|---|---|---|
| 1 | 21 | 21 | 0 | 0 | 0 |
| 20 | 413 | 442 | 255 | 88 | 0 |
| 120 | 2036 | 1956 | 2140 | 1528 | 416 |

### 2. The crowd fills the road and is allowed to overflow it

Scanning `f_003`, `f_009`, `f_021` at 68% depth, the crowd's right edge moves
between x≈333 and x≈475 as the player steers, and **its left edge is clipped by
the frame at x=0 in several frames**. The crowd is routinely half off the
screen.

So "no unit stands on the grass" is not a rule this game plays by. The crowd is
as wide as its carriageway, and steering means moving its CENTRE — to the very
edge of the road, with the overhang simply allowed. Reserving steering room out
of the crowd's width, which is what our half-width cap of ~1.63 was doing, buys
a permanently small crowd to solve a problem the reference does not have.

### 3. It grows in both axes, and the camera is what gives it room

The crowd grows horizontally *and* forward/backward. Width is bounded by the
road, which does not change; depth is bounded by the bottom of the frame, which
moves when the camera steps back. Hence `core/zoom.ts`.

### 4. Gains bloom as many small `+1`s

`f_002` shows the payout beat: dozens of yellow `+1` glyphs scattered across the
whole crowd, one per unit gained, over a cyan radial shockwave. Never a single
summary number. Our losses mirror it in red, falling out of frame — the clip
does not show a loss beat, so that direction is ours.

---

## Numbers taken from this clip

| Measurement | Value | Frame |
|---|---|---|
| Bullet columns across the stream | ~15 | `f_013`, y=45% |
| Column spacing | ~33 px of 720 | `f_013`, y=45% |
| Stream span | 475 px of 720 (66%) | `f_013`, y=45% |
| Crowd right edge, steering range | x 333 → 475 of 720 | `f_003`/`f_009`/`f_021`, y=68% |
| Crowd left edge at full lock | clipped at x=0 | `f_003`, `f_021` |

Scanlines were classified by hue and luminance; the tool is throwaway, the
numbers are in the table. Re-measure rather than trusting these if the question
is load-bearing — see the warning at the top of `docs/reference/REFERENCE.md`.
