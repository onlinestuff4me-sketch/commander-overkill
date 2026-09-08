# What the Last War family actually does for progression

Mischa asked for research into Last War: Survival and its neighbours — Top War:
Battle Game, Last Shelter: Survival, Puzzles & Survival — specifically their
mechanics for **upgrading, progressing, unlocking new troop and weapon types and
allies, and fighting hordes and bosses**.

This is that research, followed by the part that matters: which of it survives
the trip into a game that is over in ninety seconds.

**The health warning first.** Every one of those four games is a 4X base-builder.
The runner is the advertisement, not the game. Last War's door-runner exists
inside the shipped product only as a small side mode; the loop players actually
live in is building an HQ, training three arms of troops, and levelling gacha
heroes over months. So none of their progression systems can be lifted — they
are all paced for a session-per-day habit, and we have one continuous sitting.
What can be lifted is the *shape* of each system, and that turns out to be worth
a lot.

---

## What each game actually does

### Last War: Survival

- **Heroes are the progression.** Unlocked through story, then through a
  ticket-fed gacha. Five ways to make one better: level, star tier, skills, gear,
  and an exclusive weapon. Five separate currencies, deliberately.
- **A squad is five slots** — two front, three back. Front slots want defenders
  who soak; back slots want damage and support.
- **Unit classes are the strategic layer.** Tank, Missile Vehicle, Aircraft, in a
  counter relationship. Best practice at the top end is a *mono-squad*: five of
  one class, so the class counters cleanly rather than hedging.
- **Skills have a priority order**, and it differs by role — defenders take their
  tactic skill first, attackers take their damage skill first.
- **Allies arrive as unlocked systems, not as characters.** The Drone is the
  clearest one: clear the territory, build the Drone Centre, and from then on a
  drone fights alongside your squad in every battle.
- **Seasonal maps** rotate in new mechanics, new heroes, and a new meta.
- **The runner minigame** is doors and gates: multiply or add, dodge or shoot,
  with powerups that add troops or improve weapons — *and powerups that backfire
  and cost you soldiers*.

### Top War: Battle Game

- **Merge is the entire upgrade verb.** Two of a thing make one better thing.
  Buildings merge. Troops merge. It replaces the build timer that every other
  game in the genre makes you wait through, which is why the game feels fast.
- **Three unit classes unlock in a fixed order** — Army, then Navy, then Air
  Force. Not simultaneously, not randomly: an authored sequence, so each one is
  an event.
- **Two separate technologies gate the ladder**: a *build* level that says what
  tier you can create from scratch, and a *merge* level that says what tier you
  can combine up to. Progress is the gap between them closing.
- **A class specialisation** — combat elite versus mechanic elite — forks the
  player's whole development path.

### Puzzles & Survival

- **Fragments, not drops.** A hero is not found; ten of their fragments are, and
  the tenth one unlocks them. Rarity runs 2★ to 5★, and rarity sets both the
  level cap and the number of skills.
- **Four troop types** — Fighters, Shooters, Riders, Vehicles.
- **Heroes buff the troop type they match.** A shooter hero with shooter troops
  is worth more than either alone, so the composition is the decision.
- **An alliance research tree** members donate into for permanent shared buffs.

### Last Shelter: Survival

- **Formation over raw power.** The published guides are all about hero
  *synergies* and APC formations rather than a flat "best hero" list.
- Heroes contribute stats to the squad — might, resistance, HP, combat speed —
  so a hero is a modifier on a formation, not a unit.

---

## The seven patterns worth stealing

Sorted by what they would do for *our* game, which is a ninety-second run with
no metagame, no accounts, and no second session.

### 1. Counters — the one that would change the most

Every game here has classes that beat other classes. We have three weapon kinds
(rifle, minigun, rocket) and they are all strictly better than each other in a
straight line: a rocketeer is a rifleman who does more damage. Nothing on the
road cares *which* you brought.

Give one enemy type armour that only rockets open, and one that is fast enough
that only the minigun's rate of fire catches it, and the upgrade card stops being
"take the biggest number" and becomes "what is this level going to throw at me".
That is the single cheapest way to turn our upgrade path into a decision, and it
needs no new art — the enemies already exist.

### 2. Fragments — a reason to chase the optional stuff

Puzzles & Survival needs ten fragments to unlock a hero. We have optional prizes
on the road that nobody has to take. Make some of them *pieces of something*: a
counter in the HUD that fills as you collect them, and at full it unlocks a new
troop type permanently, for this run and every run after.

This is the mechanic that makes a player detour. Right now a prize is worth its
face value and nothing else, so skipping it costs exactly its face value.

### 3. Merge, made visible

Top War's whole appeal is watching two things become one better thing. We already
convert troops into tiers silently — the weapon upgrades at troop-count
thresholds and the player is told by a HUD chip. If three riflemen visibly walked
together and stood up as a gunner, the upgrade would be a *scene* rather than a
notification, and the loadout would finally be legible.

### 4. An ally that joins the run

Last War's Drone is a unit you unlock once and then have forever, fighting beside
you. In a runner this is the most readable upgrade there is: a cage on the road,
you shoot it open, and a thing comes out and runs with you. A drone that strafes
ahead of the crowd. A tank that soaks the first breach. A dog that fetches
prizes off the far kerb.

It is also the best answer to "what does level 5 give me that level 4 did not"
because you can *see* it on the screen for the rest of the run.

### 5. Front and back

Last War's squad is two slots in front, three behind, and the split is the whole
composition puzzle. Our crowd is an undifferentiated blob. Putting the elites and
the heavies in the front rank — where a breach lands first and where a gate's red
segment sweeps first — would make crowd shape matter beyond its width, and it
would give a shield-bearer prize something to actually do.

### 6. One new noun per level

Last War rotates a seasonal map that introduces new mechanics. Our levels already
unlock enemy beats on a schedule (`Beat.unlock` in `mechanics/director.ts`).
What they do not do is *announce* it. A level card that says "Level 4:
Bulwarks" and shows the thing you are about to meet turns a difficulty ramp into
a curriculum.

### 7. Rarity colour, everywhere

Every game in this family colour-codes rarity on every icon, and it costs
nothing. Our perk cards and our prizes have no shared visual language for "this
one is rare". A blue/purple/gold ramp applied to both would make the upgrade path
readable at a glance and make a gold card feel like a gold card.

---

## STATUS: patterns 1 and 2 are BUILT

Counters and the rescued ally shipped together (see `docs/handoff.md`), with the
flamethrower, the freeze ray and the giant robot as their content. What that
batch found, and what it cost, is written up there rather than here — this
document is the research, and it should stay readable as research.

The one finding worth repeating in this file, because it is about the pattern
rather than about our code: **a counter table cannot do its job inside an economy
that buffs the whole army.** Our minigun and rocket crews raise `fireRate` and
`firepower` for every soldier, so measured at a realistic loadout a rocket crate
was worth more than a hundred riflemen while a flamer crate hitting three times
as hard was worth forty-five — the table was being swamped by an economy it could
not see. Every game in the Last War family keeps counters and stat upgrades on
separate axes, and now we know why.

## What I would build, in order

1. **Counters** (pattern 1). Biggest change to the decision, no new art, and it
   makes every existing upgrade card mean something different.
2. **An ally you rescue** (pattern 4). The most visible single addition the game
   could get, and it lands in the same slot the existing prizes use.
3. **Fragments** (pattern 2). Cheap, and it is the thing that makes players go
   out of their way.
4. **Merge made visible** (pattern 3) and **rarity colour** (pattern 7) together
   — both are presentation passes over systems that already exist.
5. **Front and back** (pattern 5). The most invasive, because it touches the
   squad's slot layout, which everything else measures against.

Numbers 1 and 2 together are one batch and would be the biggest change to how the
game plays since levels landed.

## What I would not build

**A gacha, a rarity roll, or anything with fragments as a *currency*.** Three of
these four games monetise through hero acquisition, and every one of their
progression systems is shaped by the need to make acquisition slow. Ours has no
reason to be slow. Fragments as a *counter that fills inside one run* is the
useful half; fragments as a thing you save across sessions is the half that only
exists to sell you the tenth one.

**Five upgrade axes per unit.** Last War has level, star, skills, gear and an
exclusive weapon on every hero because it needs five things to sell. We need the
player to understand their army at a glance, mid-run, on a phone, while steering.

---

## Sources

- [Hero Guide for Last War: Survival Game — BlueStacks](https://www.bluestacks.com/blog/game-guides/last-warsurvival-game/lws-heroes-guide-en.html)
- [Key Mechanics in Last War Survival Game — Fundamentals Guide](https://www.lastwargame.online/en/game-basics/)
- [Last War: Survival — Best Hero Skill Upgrade Guide](https://heaven-guardian.com/last-war-survival-best-hero-skill-upgrade-guide/)
- [Beginner's Guide to Last War: Survival Game — BlueStacks](https://www.bluestacks.com/blog/game-guides/last-warsurvival-game/lws-beginners-guide-en.html)
- [Last War: Survival Game — Wikipedia](https://en.wikipedia.org/wiki/Last_War:_Survival_Game)
- [Top War: Battle Game — a Quick Glimpse on the 4X Strategy Hit — GameRefinery](https://www.gamerefinery.com/top-war-battle-game-a-quick-glimpse-on-the-4x-strategy-hit/)
- [Top War: Battle Game Beginner's Guide — Level Winner](https://www.levelwinner.com/top-war-battle-game-beginners-guide-tips-cheats-strategies-to-grow-your-army-and-crush-your-enemies/)
- [Units — Top War: Battle Game Wiki](https://top-war-battle-game.fandom.com/wiki/Units)
- [Puzzles & Survival: A Surviving and Thriving 4X in the post-IDFA World — Naavik](https://naavik.co/deep-dives/puzzles-and-survival-2/)
- [Building an Army — Heroes and Troops in Puzzles & Survival — BlueStacks](https://www.bluestacks.com/blog/game-guides/puzzles-and-survival/ps-hero-army-guide-en.html)
- [Hero List & Troop Skills Guide — Puzzles & Survival — AppGamer](https://www.appgamer.com/puzzles-survival/strategy-guide/hero-list-troop-skills-guide)
- [Questions and Answers for Last Shelter: Survival — AppGamer](https://www.appgamer.com/last-shelter-survival/answers/)
