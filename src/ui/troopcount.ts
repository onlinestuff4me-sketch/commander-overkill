/**
 * TROOP COUNT — how many soldiers you have, in a number, on the screen.
 *
 * This did not exist, and its absence was actively misleading. The only number
 * on screen was the boss bar's, which counts DOWN as you kill things; a
 * playtester read it as their army and reported that killing enemies was
 * shrinking their squad and that gate penalties never registered. Neither was
 * true. There was simply nothing to look at.
 *
 * Rules it follows, in order of importance:
 *
 *   1. It is the army size and nothing else. No score, no multiplier, no
 *      secondary readout competing with it.
 *   2. It reacts. A gain pops it green and a loss pops it red for a few frames,
 *      so the number is visibly the same thing the `+1`/`-1` floaters are
 *      counting. Without that they read as unrelated effects.
 *   3. It never animates the value itself. Tweening a counter toward its target
 *      is the standard flourish and it is wrong here: the player is trying to
 *      decide whether they can afford the next red gate, and a number that lags
 *      reality by half a second is a number that lies at exactly the moment it
 *      matters.
 */

import type { System } from "../core/types";

const STYLE_ID = "cok-troops-style";

/** Seconds a gain/loss tint lasts. Long enough to notice, short enough that a
 *  fast sequence of gates does not smear into one continuous colour. */
const PULSE_TIME = 0.32;

export interface TroopCountSystem extends System {
  dispose(): void;
}

export function createTroopCount(parent: HTMLElement): TroopCountSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-troops";
  root.innerHTML = MARKUP;
  parent.appendChild(root);

  const num = root.querySelector(".cok-troops__num") as HTMLElement;

  let shown = -1;
  let pulse = 0;
  /** +1 for a gain, -1 for a loss, 0 for idle. Drives which tint is applied. */
  let pulseDir = 0;
  let appliedClass = "";
  let disposed = false;

  return {
    update(dt, world) {
      const troops = Math.max(0, Math.round(world.troops));
      if (troops !== shown) {
        if (shown >= 0) {
          pulseDir = troops > shown ? 1 : -1;
          pulse = PULSE_TIME;
        }
        shown = troops;
        num.textContent = String(troops);
      }
      if (pulse > 0) {
        pulse -= dt;
        if (pulse <= 0) pulseDir = 0;
      }
    },

    render() {
      // Class writes are the expensive part of a DOM overlay, so only touch it
      // when the state actually changes rather than every frame.
      const want = pulseDir > 0 ? "is-gain" : pulseDir < 0 ? "is-loss" : "";
      if (want === appliedClass) return;
      if (appliedClass) root.classList.remove(appliedClass);
      if (want) root.classList.add(want);
      appliedClass = want;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Inline SVG rather than an image: procedural-only asset policy, and it stays
 *  sharp at every DPR without shipping a file. A helmeted head, because that is
 *  the silhouette the crowd itself reads as from above. */
const MARKUP = `
<div class="cok-troops__icon">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 5c-6 0-10.4 4-10.4 9.4v1.2h20.8v-1.2C26.4 9 22 5 16 5z" fill="#3d7fd6"/>
    <rect x="3.6" y="15.2" width="24.8" height="2.9" rx="1.45" fill="#2b5ea3"/>
    <path d="M10.6 18.6h10.8v4.2c0 2.4-2.4 4.2-5.4 4.2s-5.4-1.8-5.4-4.2z" fill="#e8d9b8"/>
  </svg>
</div>
<span class="cok-troops__num">0</span>`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Top-LEFT, deliberately. The boss bar owns top-centre, and the two must not be
 * confusable — being mistaken for each other is the entire bug this fixes.
 */
const CSS = `
.cok-troops {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 10px);
  left: calc(var(--safe-left, env(safe-area-inset-left, 0px)) + 12px);
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  padding: 5px 12px 5px 7px;
  border-radius: 999px;
  background: rgba(12, 20, 34, 0.55);
  transform: translate3d(0, 0, 0);
  transition: transform 120ms ease-out;
}
.cok-troops__icon {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
}
.cok-troops__icon svg {
  width: 100%;
  height: 100%;
  display: block;
}
.cok-troops__num {
  font: 900 26px/1 "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif;
  color: #ffffff;
  /* Same heavy dark outline the gate numerals use — it is what keeps the
     number readable over sky, road and a crowd of blue helmets alike. */
  -webkit-text-stroke: 3px #10192b;
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
  transition: color 120ms ease-out;
}
/* The pop is on the CONTAINER and the tint on the glyph, so a gain reads as the
   whole badge flinching rather than as the digits changing font. */
.cok-troops.is-gain { transform: translate3d(0, 0, 0) scale(1.12); }
.cok-troops.is-gain .cok-troops__num { color: #ffe11f; }
.cok-troops.is-loss { transform: translate3d(0, 0, 0) scale(0.94); }
.cok-troops.is-loss .cok-troops__num { color: #ff5348; }
`;
