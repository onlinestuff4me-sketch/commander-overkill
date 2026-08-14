/**
 * NET POP — one big number over the crowd saying what a beat just cost or paid.
 *
 * The per-unit `+1`s answer "which soldiers", and they are the reason growth
 * feels earned. They are bad at answering "how many", which is the question a
 * player actually asks when three segments resolve at once: counting a dozen
 * scattered glyphs is not something anyone does at a glance. So this sits on top
 * of them rather than replacing them — a single large `+14` or `-7`.
 *
 * It ACCUMULATES over a short window instead of firing per segment. A row where
 * you smash a `+8` and a `-2` in the same tick is one event to the player, and
 * showing them two competing numbers is worse than showing neither.
 *
 * DOM rather than a 3D sprite: the glyph is arbitrary text at arbitrary sizes,
 * which a canvas texture per value would have to cache and evict. Positioned by
 * projecting the crowd's centre, so it tracks the army rather than sitting in a
 * corner.
 */

import * as THREE from "three";
import type { System } from "../core/types";

const STYLE_ID = "cok-netpop-style";

/**
 * Seconds a pending total stays open for more payouts before it commits.
 *
 * A gate row resolves all of its segments on ONE tick, so this only has to
 * outlast a frame — but a barrel destroyed as you cross a gate is the same beat
 * to the eye and lands a few frames later. Long enough to gather that, short
 * enough that two genuinely separate rows never merge.
 */
const GATHER_TIME = 0.18;
/** Seconds the number is on screen once it commits. */
const HOLD_TIME = 0.85;
/** Metres above the crowd centre the number floats. Clear of the HP bar. */
const HEIGHT = 2.6;

export interface NetPopSystem extends System {
  /** Add to the total currently being gathered. Sign decides the colour. */
  add(amount: number): void;
  dispose(): void;
}

export function createNetPop(parent: HTMLElement, camera: THREE.Camera): NetPopSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-netpop";
  parent.appendChild(root);

  const anchor = new THREE.Vector3();
  let pending = 0;
  let gather = 0;
  let hold = 0;
  let shownClass = "";
  let disposed = false;

  function commit(): void {
    if (pending === 0) return;
    root.textContent = (pending > 0 ? "+" : "") + String(pending);
    const want = pending > 0 ? "is-gain" : "is-loss";
    if (want !== shownClass) {
      if (shownClass) root.classList.remove(shownClass);
      root.classList.add(want);
      shownClass = want;
    }
    // Restart the pop even if one is already running: retriggering a CSS
    // animation needs the class removed and the layout flushed, and this is the
    // one place per beat where that cost is affordable.
    root.classList.remove("is-live");
    void root.offsetWidth;
    root.classList.add("is-live");
    pending = 0;
    hold = HOLD_TIME;
  }

  return {
    update(dt, _world) {
      if (gather > 0) {
        gather -= dt;
        if (gather <= 0) commit();
      }
      if (hold > 0) {
        hold -= dt;
        if (hold <= 0) root.classList.remove("is-live");
      }
    },

    render(_alpha, world) {
      if (hold <= 0 && gather <= 0) return;
      // Project the crowd centre every frame it is visible, so the number rides
      // the army as it steers rather than drifting off it.
      anchor.set(world.squadCenter.x, HEIGHT, world.squadCenter.z);
      anchor.project(camera);
      root.style.left = `${(anchor.x * 0.5 + 0.5) * 100}%`;
      root.style.top = `${(-anchor.y * 0.5 + 0.5) * 100}%`;
    },

    add(amount) {
      if (amount === 0) return;
      pending += amount;
      gather = GATHER_TIME;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
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

const CSS = `
.cok-netpop {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate3d(-50%, -50%, 0) scale(0.4);
  pointer-events: none;
  opacity: 0;
  white-space: nowrap;
  font: 900 64px/1 "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif;
  /* Heavier outline than the gate numerals: this sits directly over a crowd of
     helmets and muzzle flare, which is the busiest part of the frame. */
  -webkit-text-stroke: 8px #10192b;
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
}
.cok-netpop.is-gain { color: #ffe11f; }
.cok-netpop.is-loss { color: #ff5348; }
/* Overshoot on the way in, drift up and fade on the way out — the same shape as
   the per-unit floaters so the two read as one event at two scales. */
.cok-netpop.is-live { animation: cok-netpop-pop 0.85s cubic-bezier(0.2, 1.4, 0.4, 1) forwards; }
@keyframes cok-netpop-pop {
  0%   { opacity: 0; transform: translate3d(-50%, -50%, 0) scale(0.4); }
  22%  { opacity: 1; transform: translate3d(-50%, -58%, 0) scale(1.15); }
  38%  { transform: translate3d(-50%, -58%, 0) scale(1); }
  100% { opacity: 0; transform: translate3d(-50%, -104%, 0) scale(1); }
}
`;
