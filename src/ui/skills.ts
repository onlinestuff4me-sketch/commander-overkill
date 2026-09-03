/**
 * SKILLS HUD — the focus meter and the tighten button.
 *
 * ---------------------------------------------------------------------------
 * Why this is on the HUD when the standing rule is "show, don't tell"
 * ---------------------------------------------------------------------------
 * That rule is about CONSEQUENCE: what a decision cost you belongs on the road,
 * in bodies, not in a caption. This is neither a consequence nor inventory — it
 * is the STATE OF THE PLAYER'S OWN CONTROLS, and a control whose availability
 * you cannot see is a control you do not use.
 *
 * Both readouts are also carried in the world for anyone who is watching it
 * rather than the HUD: focus visibly narrows and brightens the fire, and tighten
 * visibly crushes the crowd into a column. This is the confirmation, not the
 * signal. That is why it sits low and small — the eye should be on the road.
 *
 * DOM rather than a billboard, for the same reason the boss bar is: it is
 * genuinely screen-space, it costs zero draw calls, and text rasterises at the
 * device's true pixel ratio rather than through the renderer's DPR cap.
 */

import type { System, WorldState } from "../core/types";

const STYLE_ID = "cok-skills-style";

/** Seconds the tighten pill stays flared after it comes back off cooldown. The
 *  moment it becomes available is the moment worth announcing. */
const READY_FLASH = 0.45;

export interface SkillsSystem extends System {
  /** Cooldown state, pushed in by the orchestrator each tick: 0 ready, 1 just
   *  spent. The HUD does not own the ability, only its picture. */
  setTightenCooldown(fraction: number, active: boolean): void;
  dispose(): void;
}

export function createSkills(parent: HTMLElement): SkillsSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-skills";
  root.innerHTML = MARKUP;
  parent.appendChild(root);

  const focusFill = root.querySelector<HTMLElement>(".cok-focus__fill")!;
  const focusRoot = root.querySelector<HTMLElement>(".cok-focus")!;
  const pill = root.querySelector<HTMLElement>(".cok-tight")!;
  const sweep = root.querySelector<HTMLElement>(".cok-tight__sweep")!;

  let cooldown = 0;
  let active = false;
  let wasReady = true;
  let flash = 0;
  /** Last values written to the DOM, so a frame that changed nothing touches
   *  nothing — layout is the expensive part of a HUD, not the arithmetic. */
  let shownFocus = -1;
  let shownCooldown = -1;
  let shownState = "";

  return {
    setTightenCooldown(fraction, isActive) {
      cooldown = fraction;
      active = isActive;
    },

    update(dt, _world) {
      const ready = cooldown <= 0 && !active;
      if (ready && !wasReady) flash = READY_FLASH;
      wasReady = ready;
      if (flash > 0) flash = Math.max(0, flash - dt);
    },

    render(_alpha, world: WorldState) {
      const f = Math.round(world.focus * 100);
      if (f !== shownFocus) {
        shownFocus = f;
        focusFill.style.width = `${f}%`;
        // Full focus is the state worth noticing; anything short of it is just
        // progress, so only the top of the meter gets to glow.
        focusRoot.classList.toggle("is-full", f >= 99);
      }

      const c = Math.round(cooldown * 100);
      if (c !== shownCooldown) {
        shownCooldown = c;
        sweep.style.width = `${c}%`;
      }

      const state = active ? "active" : cooldown > 0 ? "cool" : flash > 0 ? "flash" : "ready";
      if (state !== shownState) {
        shownState = state;
        pill.className = `cok-tight is-${state}`;
      }
    },

    dispose() {
      root.remove();
    },
  };
}

const MARKUP = `
<div class="cok-focus"><div class="cok-focus__fill"></div><span class="cok-focus__label">FOCUS</span></div>
<div class="cok-tight is-ready"><div class="cok-tight__sweep"></div><span>TIGHTEN</span></div>
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Bottom-centre and deliberately small. The reference puts its back arrow at the
 * bottom left and its speed control bottom right, so the middle of that band is
 * the one piece of screen furniture this game has not already spoken for — and
 * it is under the thumb rather than over the road.
 */
const CSS = `
.cok-skills {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--safe-bottom, env(safe-area-inset-bottom, 0px)) + 14px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  font: 800 11px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.08em;
}
.cok-focus {
  position: relative;
  width: 132px;
  height: 14px;
  border-radius: 999px;
  background: rgba(10, 18, 30, 0.55);
  overflow: hidden;
}
.cok-focus__fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  background: linear-gradient(90deg, #2f7fd6, #7fd0ff);
  transition: width 60ms linear;
}
.cok-focus.is-full .cok-focus__fill {
  background: linear-gradient(90deg, #ffd447, #fff3b0);
  box-shadow: 0 0 10px rgba(255, 212, 71, 0.85);
}
.cok-focus__label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.cok-tight {
  position: relative;
  min-width: 96px;
  padding: 5px 12px;
  border-radius: 999px;
  text-align: center;
  color: #fff;
  background: rgba(10, 18, 30, 0.55);
  overflow: hidden;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  transition: transform 120ms ease-out, opacity 120ms ease-out;
}
/* The sweep is what is LEFT of the cooldown, draining to nothing, so the pill
   refills rather than emptying — a bar that grows reads as "coming back". */
.cok-tight__sweep {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  background: rgba(255, 255, 255, 0.16);
}
.cok-tight span { position: relative; }
.cok-tight.is-cool { opacity: 0.5; }
.cok-tight.is-ready { background: rgba(47, 127, 214, 0.72); }
.cok-tight.is-flash {
  background: rgba(255, 212, 71, 0.9);
  color: #16202e;
  transform: scale(1.08);
}
.cok-tight.is-active {
  background: rgba(255, 212, 71, 0.95);
  color: #16202e;
  transform: scale(1.12);
}
`;
