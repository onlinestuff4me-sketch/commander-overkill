/**
 * BOSS BAR — red skull + capsule, pinned top-centre, counting down.
 *
 * WHY DOM AND NOT A BILLBOARD: this is the only element in the game that is
 * genuinely screen-space. A canvas-textured quad would need a texture repaint
 * on every value change and would resample the glyphs through the renderer's
 * DPR cap — the number that matters most would be the blurriest thing on
 * screen. DOM text is rasterised at the device's true pixel ratio, costs zero
 * draw calls, and gets `env(safe-area-inset-*)` for free. The trade is that it
 * cannot be occluded by world geometry, which for a pinned HUD element is the
 * behaviour we want anyway.
 *
 * ---------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------------
 *
 *   const boss = createBossBar(document.getElementById("ui")!);
 *   boss.reset(80);          // set max, fill the bar, reveal it
 *   boss.set(62);            // eases down, pops the number, flashes the fill
 *   boss.damage(4);          // same thing, relative; returns hp remaining
 *   boss.hide();             // between encounters
 *
 * `update`/`render` come from the System contract: `update` eases the displayed
 * value toward the target, `render` is the only thing that touches the DOM, so
 * layout is poked once per frame rather than once per sim tick.
 */

import type { System } from "../core/types";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** How fast the displayed value chases the real one. Higher = snappier. */
const EASE = 9;
/** Below this the eased value just snaps, so the last unit never crawls. */
const SNAP = 0.35;
/** Seconds of number-pop and fill-flash after a hit. */
const POP_TIME = 0.22;
/** Peak scale of the number pop. */
const POP_SCALE = 0.3;

const STYLE_ID = "cok-bossbar-style";

/* -------------------------------------------------------------------------- */

export interface BossBarSystem extends System {
  /** The bar's root element, already appended to the host. */
  readonly element: HTMLElement;
  /** Current target value (not the eased display value). */
  readonly value: number;
  /** Max value the bar was reset to. */
  readonly max: number;

  /** Set the boss's full health, fill the bar and show it. */
  reset(max: number): void;
  /** Set absolute health. Eases, and pops if the value dropped. */
  set(value: number): void;
  /** Subtract health. Returns what is left. */
  damage(amount: number): number;

  show(): void;
  hide(): void;
}

export function createBossBar(host: HTMLElement): BossBarSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-boss";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = MARKUP;
  host.appendChild(root);

  const fill = root.querySelector<HTMLElement>(".cok-boss__fill");
  const flash = root.querySelector<HTMLElement>(".cok-boss__flash");
  const num = root.querySelector<HTMLElement>(".cok-boss__num");
  if (!fill || !flash || !num) throw new Error("bossbar: markup did not mount");

  let max = 1;
  let target = 0;
  let shown = 0;
  let prevShown = 0;
  let pop = 0;
  let prevPop = 0;
  let visible = false;
  let disposed = false;

  /** Last integer written to the DOM. Guards a pointless text reflow per frame. */
  let paintedInt = -1;
  let paintedFill = -1;
  let paintedPop = -1;

  const system: BossBarSystem = {
    element: root,
    get value() {
      return target;
    },
    get max() {
      return max;
    },

    reset(next) {
      max = Math.max(1, next);
      target = max;
      shown = max;
      prevShown = max;
      pop = 0;
      prevPop = 0;
      paintedInt = -1;
      paintedFill = -1;
      paintedPop = -1;
      system.show();
    },

    set(value) {
      const clamped = value < 0 ? 0 : value > max ? max : value;
      if (clamped < target) pop = POP_TIME;
      target = clamped;
    },

    damage(amount) {
      system.set(target - amount);
      return target;
    },

    show() {
      if (visible) return;
      visible = true;
      root.classList.add("is-live");
    },

    hide() {
      if (!visible) return;
      visible = false;
      root.classList.remove("is-live");
    },

    update(dt, _world) {
      prevShown = shown;
      prevPop = pop;
      if (pop > 0) pop -= dt;

      const gap = target - shown;
      // The bar drains rather than jumps: seeing 80 slide to 62 is what makes
      // a big hit feel like a big hit. Snap the tail so it always arrives.
      if (gap > -SNAP && gap < SNAP) shown = target;
      else shown += gap * Math.min(1, EASE * dt);
    },

    render(alpha, _world) {
      if (!visible) return;

      const value = prevShown + (shown - prevShown) * alpha;
      const popNow = Math.max(0, prevPop + (pop - prevPop) * alpha);

      const asInt = Math.ceil(value - 1e-6);
      if (asInt !== paintedInt) {
        paintedInt = asInt;
        num.textContent = String(asInt);
      }

      // scaleX rather than width: transforms stay on the compositor, width
      // would relayout the capsule every frame the boss is taking fire.
      const frac = Math.max(0, Math.min(1, value / max));
      if (Math.abs(frac - paintedFill) > 0.0005) {
        paintedFill = frac;
        fill.style.transform = `scaleX(${frac})`;
      }

      const k = popNow / POP_TIME;
      if (Math.abs(k - paintedPop) > 0.004) {
        paintedPop = k;
        num.style.transform = `scale(${1 + k * POP_SCALE})`;
        flash.style.opacity = String(k * 0.55);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };

  return system;
}

/* -------------------------------------------------------------------------- */
/* Markup and style                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The skull is inline SVG rather than an image: procedural-only asset policy,
 * and it stays sharp at every DPR without shipping a file.
 */
const MARKUP = `
<div class="cok-boss__skull">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 2.6C9.1 2.6 4.6 7.1 4.6 13.5c0 3.7 1.7 6.6 4.3 8.3v3.3c0 1.4 1.1 2.5 2.4 2.5h9.4c1.3 0 2.4-1.1 2.4-2.5v-3.3c2.6-1.7 4.3-4.6 4.3-8.3C27.4 7.1 22.9 2.6 16 2.6z" fill="#ef3b30"/>
    <ellipse cx="11.3" cy="14.1" rx="3.5" ry="4" fill="#2b0a0a" transform="rotate(-13 11.3 14.1)"/>
    <ellipse cx="20.7" cy="14.1" rx="3.5" ry="4" fill="#2b0a0a" transform="rotate(13 20.7 14.1)"/>
    <path d="M16 17.7l1.8 3.2h-3.6z" fill="#2b0a0a"/>
    <rect x="11.8" y="23.3" width="8.4" height="1.6" rx="0.8" fill="#2b0a0a"/>
  </svg>
</div>
<div class="cok-boss__track">
  <div class="cok-boss__fill"></div>
  <div class="cok-boss__flash"></div>
  <span class="cok-boss__num">0</span>
</div>`;

/**
 * Styles are injected from here rather than living in style.css so the boss bar
 * is a single self-contained drop-in — mounting it is one call and it brings
 * its own look. The id guard makes a second mount (hot reload, restart) free.
 */
function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const CSS = `
.cok-boss {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 10px);
  left: 50%;
  display: flex;
  align-items: center;
  pointer-events: none;
  /* Hidden until reset() names a boss. translate3d keeps it on its own layer. */
  opacity: 0;
  transform: translate3d(-50%, -6px, 0);
  transition: opacity 180ms ease-out, transform 180ms ease-out;
}
.cok-boss.is-live {
  opacity: 1;
  transform: translate3d(-50%, 0, 0);
}

.cok-boss__skull {
  position: relative;
  z-index: 1;
  width: clamp(30px, 8.4vw, 44px);
  height: clamp(30px, 8.4vw, 44px);
  /* Overlaps the capsule's left cap, exactly as in the reference plate. */
  margin-right: clamp(-12px, -2.6vw, -8px);
  padding: clamp(3px, 0.9vw, 5px);
  border-radius: 30%;
  background: #1b1e26;
  border: 2px solid #0c0e13;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
}
.cok-boss__skull svg {
  display: block;
  width: 100%;
  height: 100%;
}

.cok-boss__track {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: clamp(124px, 34vw, 240px);
  height: clamp(24px, 6.4vw, 34px);
  padding-left: clamp(8px, 2.2vw, 12px);
  border: 3px solid #f7efe2;
  border-radius: 999px;
  background: #2a1216;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}

.cok-boss__fill,
.cok-boss__flash {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  will-change: transform, opacity;
}
.cok-boss__fill {
  background: linear-gradient(180deg, #ff7d6c 0%, #f13b2c 46%, #c11710 100%);
}
.cok-boss__flash {
  background: #fff;
  opacity: 0;
}

.cok-boss__num {
  position: relative;
  display: inline-block;
  color: #fff;
  font: 900 clamp(14px, 4vw, 21px) / 1 "Arial Black", Impact, "Helvetica Neue", sans-serif;
  letter-spacing: 0.02em;
  /* Dark edge on every side: the number sits on a bright red fill and has to
     survive it at a glance. */
  text-shadow:
    0 1px 0 rgba(0, 0, 0, 0.5),
    0 0 3px rgba(0, 0, 0, 0.45),
    1px 0 0 rgba(0, 0, 0, 0.3),
    -1px 0 0 rgba(0, 0, 0, 0.3);
  will-change: transform;
}
`;
