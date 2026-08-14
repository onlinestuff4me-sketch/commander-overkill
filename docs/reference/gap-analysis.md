# What separates our build from the reference

_Written 2026-08-14, from three screenshots of our live build against two of the
reference game. Ordered by how much each item closes the gap per unit of work._

This is a LOOK-AND-FEEL audit, not a mechanics one. Mechanically we are close:
we have the crowd, the gates, the climbing reward, the barrels, the pickups, the
enemies, the boss bar. Side by side, the reference still looks like a shipped
game and ours looks like a prototype, and almost all of that difference is in
five specific places.

Effort marks are rough: **S** is an afternoon, **M** is a day or two, **L** is a
milestone in its own right.

---

## 1. THE WORLD. This is the single biggest gap and it is not close

**Reference:** a suspension bridge. Red towers with crossbeams, main cables and
vertical hangers, railings down both sides, dark water below, lane markings, and
the towers' shadows lying across the deck. Every frame has depth, colour
contrast, and something to read distance against.

**Ours:** a grey strip on flat green grass under a flat blue sky
(`0x6ab04c` and `0x7cc4e8`, no gradient on either). There is nothing in the
frame except the road and the content on it.

Everything below is procedural geometry and costs almost nothing to draw,
because it is all static and instanced.

| Build | Effort | What it buys |
|---|---|---|
| Water plane below the deck, dark blue-green, with the road raised on it | S | Instant "we are somewhere" |
| Side railings/parapets running the corridor length, one instanced mesh | S | Frames the road; gives the kerbs a reason to exist |
| Suspension towers every ~45 m — two uprights plus crossbeams, instanced | M | Vertical scale, and landmarks that show speed |
| Main cables + vertical hangers (thin instanced boxes on a catenary) | M | The silhouette that makes it read as a BRIDGE |
| Tower shadows as dark quads across the deck | S | The reference's strongest depth cue, and nearly free |
| Sky gradient instead of a flat clear colour | S | Stops the top third of the frame being dead |
| Lane markings: solid edge lines + a proper centre line | S | Speed read; we have dashes only |

`mechanics/lane.ts` already owns all corridor geometry in one place, so this
lands in one file. Do the water, railings and sky gradient first — they are
three small changes that together carry most of the effect.

---

## 2. OUR SOLDIERS ARE BLOCKS; THEIRS ARE CHARACTERS

**Reference:** big round heads with visible faces, blue helmets with a
chinstrap, cream shirts, rifles held ACROSS the chest. Chibi proportions —
roughly one head to three bodies. They are appealing at 40 px.

**Ours:** a 0.15 m sphere for a head under a helmet, a rifle angled out to the
side, no face, no outline. Correct proportions for a realistic figure and wrong
ones for this genre.

| Build | Effort | What it buys |
|---|---|---|
| Grow the head to chibi proportions and shrink the body to match | S | The single biggest character change; pure constant edits |
| A face: two dark eye dots on the front of the head | S | Turns a sphere into someone |
| Chinstrap — a darker band under the helmet brim | S | Reads as a helmet rather than a blue cap |
| Hold the rifle across the body instead of angled up | S | Matches the reference silhouette |
| A dark outline on player units (inverted-hull shell) | M | `entities/enemies.ts` already does exactly this in gold for elites — the technique is in the codebase, it just needs a second, dark, cheap version for the crowd |

**Caution, and it is a real one:** `RIFLE_PITCH`/`RIFLE_YAW` and `UNIT_HALF_WIDTH`
in `entities/squad.ts` are calibrated, with the reasoning written above them —
the rifle angle was chosen because at the old attitude 88% of the barrel was
hidden behind the soldier's own helmet, and the body half-width is what the
crowd's packing density is derived from. Changing either needs the packing
re-checked, not just a nicer-looking pose.

---

## 3. ENEMY VARIETY

**Reference:** zombies in straw hats, green-skinned shamblers, striped flying
bees, and a rider on a motorbike — four silhouettes on screen at once, all
obviously hostile and all obviously different.

**Ours:** one walker type. `spawnElite()` and the motorcycle variant are **built,
tested and never called** — `main.ts` only ever calls `spawnPack`.

| Build | Effort | What it buys |
|---|---|---|
| Place the elite and the biker the director already has names for | S | Two more enemy types for the cost of a switch case |
| A flying enemy — sine-wave path, bullets have to lead it | M | The only enemy that changes how you shoot rather than where you stand |
| A second walker silhouette (straw hat, different gait) | S | Crowd variety at almost no cost |

Item one is the highest ratio of payoff to effort anywhere in this document.

---

## 4. PRIZES DON'T LOOK LIKE PRIZES

**Reference:** big wooden barrels with metal hoops and a huge white
outlined number on the face. Soldiers stand ON TOP of them holding rifles,
wrapped in a thick gold OUTLINE. You can tell exactly what you are about to win.

**Ours:** the number is a small dark plate floating in front of the barrel
(`NUMERAL_Y = 0.52`), and the pickup hovers 0.5 m above the lid inside a gold
ring sprite.

| Build | Effort | What it buys |
|---|---|---|
| Barrel numbers big, white, heavy black outline — the gate numeral treatment | S | The gates already prove this reads at distance; barrels use a different, weaker style |
| Sit the pickup ON the lid instead of hovering above it | S | Removes the last of the "floating object" read for good |
| Real gold outline on pickups (inverted hull) instead of the ring sprite | M | Same technique as the elite rim; the ring was always an approximation |
| Metal hoops on the barrel | S | Three instanced rings; makes it a barrel rather than a cylinder |

---

## 5. IMPACT

**Reference:** where fire meets an enemy there is a white-hot starburst with
purple fringing, big enough to blow out a chunk of the frame. Streams are denser
than ours. Yellow chevrons on the road mark boost lanes.

**Ours:** a small impact flash, and the stream is visibly sparser.

| Build | Effort | What it buys |
|---|---|---|
| Scale the impact bloom up hard — bigger, brighter, shorter | S | The cheapest "this game feels expensive" change available |
| Screen shake on a barrel break and on a big payout | S | Weight |
| Chevron arrows painted on the road | S | Reads as speed even when nothing is happening |
| Denser stream at high troop counts | M | Governed by the bullet pool; needs a re-measure, not a constant bump |

---

## 6. WE HAVE MORE UI THAN THEY DO, NOT LESS

**Reference:** a boss bar with enemy portraits inside it, and a back button.
That is the entire interface. The army size is not written anywhere — you read
it off the crowd.

**Ours:** a troop counter, three loadout chips and a boss bar, stacked down the
top-left corner.

Not a straight copy job: our counter exists because a playtester read the boss
bar as their army, and the loadout chips exist because weapon pickups were
invisible. Both fixed real confusion. But the reference is proof that this genre
carries almost no HUD, and worth revisiting once the carried weapons are legible
enough in the crowd to speak for themselves.

| Build | Effort | What it buys |
|---|---|---|
| Enemy portraits inside the boss bar | S | Tells you what is coming; the bar is currently a number with no subject |
| Fold the three loadout chips into one row instead of a column | S | Reclaims the left edge |

---

## 7. SYSTEMS VISIBLE IN THE REFERENCE THAT WE HAVE NOT BUILT

These are features, not polish, and each is its own milestone.

- **A hero unit.** Both reference frames have a distinct larger character at the
  front-left of the crowd — leather outfit, oversized weapon. `entities/commander.ts`
  exists in our tree and is deliberately not mounted, pending Mischa's call on
  whether this game has a named hero. **L**, and it is a product decision first.
- **Unit evolution.** The second reference frame shows the WHOLE crowd upgraded
  to a different unit — heavy gunners with ammo belts, not the soldiers from the
  first frame. Our elites are a tint and a scale on the same body. **L**, and the
  carrier meshes added for miniguns and rockets are the pattern to copy.
- **The squad split.** Two health bars over the crowd. Long-standing item #3 in
  the handoff, still needs Mischa's answer on whether one input steers both.
- **Much bigger numbers.** The reference shows `+280` against `−600` with a
  barrel at `88`. Ours run an order of magnitude smaller. That is an economy
  decision rather than a display one, and it should wait for levels.

---

---

## THE DESIGN LENS (Mischa, 2026-08-14)

Primitives only, indefinitely. The pitch is **Roblox, not realism**: the fun
comes from dynamism, physics, consequence, and "I didn't think that would
happen" — the moments people clip and share. Fidelity is not the axis we
compete on and chasing it would cost us the axis we do.

Three rules fall out of that, and they should be applied to everything below.

**1. Every prize needs a visible chain.** Prize → how the troops use it → what it
does to the world. A rocket pickup is the worked example and it is now complete
end to end: gold launcher on a barrel → soldiers visibly carrying tubes → orange
rockets in the stream → a blast that clears whatever was standing next to what it
hit. Each link is something you can point at. A pickup whose chain stops at "a
number went up" is not finished.

**2. If the picture is ambiguous, label it.** Boxes and spheres have a ceiling on
how much they can say. We do not fight that — we pick effects that translate to
primitives, and where the shape cannot carry the meaning we put words on it. A
clear label beats a clever silhouette nobody reads.

**3. Judge every idea by "would someone clip this?"** Not "is it balanced" or "is
it readable" — those are floors, not the goal. The question is whether it
produces a moment worth showing someone.

### Prize chains worth building next

Each is a pickup, a visible carrier, and a world effect. Ranked by clip potential.

| Prize | Carried as | What it does to the world |
|---|---|---|
| **Flamethrower** | Fat tank on the back, short nozzle | A cone of fire that LINGERS on the road; enemies walking into it keep burning after the stream has moved on |
| **Mortar crew** | Two soldiers carrying a tube | Lobs shells that arc OVER the nearest barrier and land on whatever is behind it — the one weapon that ignores our blocking rule, and that is exactly why it is worth having |
| **Shield bearer** | Riot shield out front | Absorbs a red gate's penalty entirely, once, then shatters. Turns a bad row into a decision you can survive on purpose |
| **Drone** | Small unit orbiting above the crowd | Fires independently at whatever the crowd is not shooting — visibly disobeys the curtain |
| **Magnet** | A spinning coil held aloft | Drags nearby pickups and blue segments TOWARD the crowd, so a near miss becomes a hit |

The mortar and the magnet are the two that most reliably produce "wait, you can
do that?" — both break a rule the player has already learned.

### Enemies and bosses

Currently one enemy type is placed (walker packs). `spawnElite()` and the
motorcycle variant are built and never called, which remains the cheapest win in
this document.

Bosses should be **ridiculous and legible**: primitives at absurd scale, with the
attack named on screen. Concretely buildable:

- **The Roller** — a giant spiked cylinder that rolls down the corridor. It does
  not shoot; it flattens whatever lane it is in and you must not be in that lane.
  One cylinder, one rotation, enormous.
- **The Spitter** — a squat boss that lobs arcing globs which leave slow-zones on
  the deck. Punishes a crowd that has committed to one side.
- **The Wall** — advances slowly across the full road with a huge hit-point
  number on its face, and the ONLY way past is to out-damage it. A pure check on
  whether you invested in firepower.
- **The Swarm Queen** — spawns flying enemies continuously until killed. Makes
  the flying enemy worth building first.

Each wants a **name plate and an attack label** floating above it, per rule 2 —
"CHARGING" or "SPITTING" in the same heavy outlined type the gates use. That is
also how we make an attack readable one second before it lands, which is what
turns a boss from unfair into a thing you dodge on purpose.

---

## The one thing that needs Mischa

**ANSWERED, 2026-08-14: primitives only, indefinitely.** See the design lens
above. The original question is kept below because the reasoning is still the
reasoning.

**Do we stay procedural, or do we start bringing in real art?**

Every item above is deliberately written to be buildable with primitives and
generated textures, because that is the asset policy the project has held to so
far — and it has been the right call, since it kept the frame budget honest
while the mechanics moved every week.

But the reference's characters are modelled and textured, and there is a ceiling
on how close boxes and spheres get to them. We can get the proportions, the
colours, the outline and the silhouette right, and that will close most of the
distance. We cannot get their faces or their hands.

The environment has no such ceiling — a procedural bridge can look genuinely
good, because it is made of boxes in real life.

So the honest recommendation is: **do the environment and the polish first**,
all of it procedural, and treat "commission or buy character models" as a
separate decision to take once the game plays the way it should. Nothing in
sections 1, 4, 5 and 6 is blocked on that decision.
