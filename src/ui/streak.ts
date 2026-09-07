/**
 * STREAK — the run-long thread.
 *
 * ---------------------------------------------------------------------------
 * What it is for
 * ---------------------------------------------------------------------------
 * Going around a row is free. That was the deliberate change that turned a gate
 * from a toll into a decision (see `resolve()` in mechanics/gates.ts), and it
 * left the safe line with no value of its own: dodging everything costs nothing,
 * so there is no argument against it and nothing at stake in a clean run.
 *
 * A streak prices it. Collect blues without taking a red and everything blue
 * pays climbs; take one red and it is gone. That does two things a single row
 * cannot: it makes the safe play worth something, and it gives a run a STATE
 * the player is protecting — which is the thing that produces "one more go".
 *
 * ---------------------------------------------------------------------------
 * Why this is a HUD element
 * ---------------------------------------------------------------------------
 * Same reasoning as the loadout chips. The standing "show, don't tell" rule is
 * about CONSEQUENCE — what a decision cost you belongs on the road in bodies.
 * This is neither a consequence nor a thing happening in the world; it is a
 * multiplier the player is carrying, and a multiplier you cannot see is a
 * multiplier you cannot play around.
 *
 * It sits beside the troop badge because the two answer the same question — how
 * is this run going — and it is deliberately smaller, because the army is still
 * the number.
 */

import type { System } from "../core/types";

const STYLE_ID = "cok-streak-style";

/** Seconds the chip stays popped after the multiplier climbs, and after it
 *  breaks. The break is longer: losing it is the event worth reading. */
const CLIMB_TIME = 0.45;
const BREAK_TIME = 0.9;

export interface StreakSystem extends System {
  /** How many paying segments in a row, and the multiplier that buys. */
  readonly count: number;
  readonly multiplier: number;
  /** A blue paid. Returns the multiplier that was in force for it. */
  bank(): number;
  /** A red was taken. Everything resets. Returns true if a streak was actually
   *  lost, so the caller can decide whether that is worth remarking on. */
  breakStreak(): boolean;
  reset(): void;
  dispose(): void;
}

/**
 * What each streak length is worth.
 *
 * DELIBERATELY SHALLOW AT THE TOP. The obvious version of this doubles and
 * trebles, and on an economy whose whole failure mode is a run that catches fire
 * (see the note on the noise band in docs/handoff.md) a 3× on gate rewards is
 * not a thread, it is a second economy. Two is enough to be worth protecting and
 * small enough that losing it is a setback rather than a run ending.
 *
 * Index is the streak count, clamped to the last entry.
 */
const LADDER: readonly number[] = [1, 1, 1.15, 1.3, 1.5, 1.75, 2];

export function createStreak(parent: HTMLElement): StreakSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-streak";
  root.innerHTML = `<span class="cok-streak__x">×</span><span class="cok-streak__v">1</span>`;
  parent.appendChild(root);
  const value = root.querySelector<HTMLElement>(".cok-streak__v")!;

  let count = 0;
  let pop = 0;
  let broke = 0;
  let shown = "";
  let shownClass = "";

  function multiplierFor(n: number): number {
    return LADDER[Math.min(n, LADDER.length - 1)] ?? 1;
  }

  return {
    get count() {
      return count;
    },
    get multiplier() {
      return multiplierFor(count);
    },

    bank() {
      // The multiplier in force is the one you had BEFORE this segment, so the
      // first blue of a run pays 1× and the chip climbing is a promise about the
      // next one rather than a description of this one. That ordering is what
      // makes the number on screen honest.
      const applied = multiplierFor(count);
      count++;
      if (multiplierFor(count) !== applied) pop = CLIMB_TIME;
      return applied;
    },

    breakStreak() {
      const had = count > 1;
      count = 0;
      if (had) broke = BREAK_TIME;
      return had;
    },

    reset() {
      count = 0;
      pop = 0;
      broke = 0;
    },

    update(dt, _world) {
      if (pop > 0) pop = Math.max(0, pop - dt);
      if (broke > 0) broke = Math.max(0, broke - dt);
    },

    render(_alpha, _world) {
      const m = multiplierFor(count);
      // Trailing zero trimmed: "×2" reads faster than "×2.0", and this string is
      // read in the corner of the eye.
      const text = m === Math.floor(m) ? String(m) : m.toFixed(2).replace(/0$/, "");
      if (text !== shown) {
        shown = text;
        value.textContent = text;
      }
      // HIDDEN AT 1×, not dimmed. A dormant chip was the right call when it was
      // the only new thing on the HUD; against a HUD being cut back to a level,
      // a count and a mute button it is one more permanent object competing with
      // the road. It appears when it is worth something.
      const cls =
        broke > 0
          ? "cok-streak is-broke"
          : m > 1
            ? `cok-streak is-live${pop > 0 ? " is-pop" : ""}`
            : "cok-streak is-idle";
      if (cls !== shownClass) {
        shownClass = cls;
        root.className = cls;
      }
    },

    dispose() {
      root.remove();
    },
  };
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * TOP RIGHT, not beside the troop badge.
 *
 * It was next to the badge at a fixed 124px inset, which reads well at "12" and
 * collides at "1200" — the badge grows with the number and the number reaches
 * four digits in a good run, which is exactly the run where this chip matters
 * most. The opposite corner cannot collide with anything.
 */
const CSS = `
.cok-streak {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 12px);
  right: calc(var(--safe-right, env(safe-area-inset-right, 0px)) + 12px);
  display: flex;
  align-items: baseline;
  gap: 1px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(12, 20, 34, 0.55);
  color: rgba(255, 255, 255, 0.55);
  font: 800 17px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  pointer-events: none;
  /* At 1× it is dormant rather than absent: a chip that appears out of nowhere
     on the second blue reads as a bug, and one that is always there teaches the
     player what it is before it matters. */
  opacity: 0;
  transition: opacity 140ms ease-out, transform 140ms ease-out, color 140ms ease-out;
}
.cok-streak.is-idle { opacity: 0; }
.cok-streak__x { font-size: 12px; opacity: 0.8; }
.cok-streak.is-live {
  opacity: 1;
  color: #ffd447;
  background: rgba(60, 44, 10, 0.6);
}
.cok-streak.is-pop { transform: scale(1.28); }
.cok-streak.is-broke {
  opacity: 1;
  color: #ff6a52;
  background: rgba(70, 18, 14, 0.7);
  transform: scale(0.86);
}
`;
