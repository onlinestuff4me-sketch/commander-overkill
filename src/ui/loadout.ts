/**
 * LOADOUT — what you are carrying, as opposed to how many of you there are.
 *
 * The troop count answers "how big is my army". Nothing answered "how hard does
 * it hit", and after weapon pickups landed that became a real gap rather than a
 * missing nicety: a minigun and a rocket both make a barrel die faster, they
 * cost the same detour to collect, and with no readout the player has no way to
 * learn that the two do different things — let alone that a run heavy in one and
 * empty in the other is the lopsided build the pacing proposal is trying to
 * teach them to avoid.
 *
 * WHY THIS IS TEXT WHEN THE STANDING NOTE IS "SHOW, DON'T TELL". The rule is
 * about CONSEQUENCE — what a decision cost you belongs on the road, in bodies,
 * not in a caption. This is INVENTORY, which is the one thing a caption is
 * genuinely better at: three multipliers that change a handful of times a run
 * and that the player checks between decisions rather than during them. It is
 * also why the chips are silent by default and why each one only exists once you
 * have picked that thing up — an empty loadout draws nothing at all, so the
 * screen a new player sees is unchanged.
 *
 * Sits under the troop badge, in the same visual family, deliberately smaller.
 * It must never compete with the army size, which is still the number.
 */

import type { System } from "../core/types";

const STYLE_ID = "cok-loadout-style";

/** Seconds a chip stays popped after its value changes. Matches the troop
 *  count's pulse so a barrel that pays both reads as one event. */
const PULSE_TIME = 0.5;

type Axis = "elites" | "rate" | "power";

interface Chip {
  root: HTMLElement;
  value: HTMLElement;
  shown: string;
  pulse: number;
  visible: boolean;
}

export interface LoadoutSystem extends System {
  dispose(): void;
}

export function createLoadout(parent: HTMLElement): LoadoutSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-loadout";
  parent.appendChild(root);

  const chips = {} as Record<Axis, Chip>;
  for (const axis of ["elites", "rate", "power"] as const) {
    const el = document.createElement("div");
    el.className = `cok-chip cok-chip--${axis}`;
    el.innerHTML = `${ICON[axis]}<span class="cok-chip__v"></span>`;
    root.appendChild(el);
    chips[axis] = {
      root: el,
      value: el.querySelector(".cok-chip__v") as HTMLElement,
      shown: "",
      pulse: 0,
      visible: false,
    };
  }

  let disposed = false;

  /** Set a chip's text and show it, pulsing if the text actually moved. */
  function set(chip: Chip, text: string, live: boolean): void {
    if (!live) {
      if (chip.visible) {
        chip.visible = false;
        chip.root.classList.remove("is-live");
      }
      // Keep `shown` so re-acquiring the same value still counts as a change.
      chip.shown = "";
      return;
    }
    if (text !== chip.shown) {
      // Never pulse the first appearance from nothing — the chip sliding in IS
      // the event, and stacking a pop on top of it reads as a glitch.
      if (chip.shown !== "") chip.pulse = PULSE_TIME;
      chip.shown = text;
      chip.value.textContent = text;
    }
    if (!chip.visible) {
      chip.visible = true;
      chip.root.classList.add("is-live");
    }
  }

  return {
    update(dt, world) {
      const elites = Math.max(0, Math.floor(world.elites));
      set(chips.elites, String(elites), elites > 0);
      // COUNTS, NOT MULTIPLIERS. "1.7×" is a number you have to be told; "12" is
      // twelve soldiers you can find in the crowd carrying miniguns, which is
      // what the pickup actually bought. The multipliers still exist — they are
      // derived from these in main.ts — but they are not what the player is
      // being asked to reason about.
      const gunners = Math.max(0, Math.floor(world.gunners));
      const rocketeers = Math.max(0, Math.floor(world.rocketeers));
      set(chips.rate, String(gunners), gunners > 0);
      set(chips.power, String(rocketeers), rocketeers > 0);

      for (const axis of ["elites", "rate", "power"] as const) {
        const chip = chips[axis];
        if (chip.pulse > 0) chip.pulse -= dt;
      }
    },

    render() {
      // Class writes are the expensive part of a DOM overlay, so the pulse class
      // is only touched on the frames it changes.
      for (const axis of ["elites", "rate", "power"] as const) {
        const chip = chips[axis];
        const want = chip.pulse > 0;
        if (want === chip.root.classList.contains("is-pop")) continue;
        chip.root.classList.toggle("is-pop", want);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Inline SVG, per the procedural-only asset policy — and drawn to match the
 * PICKUP SILHOUETTES rather than to be pretty icons. The whole job of this chip
 * is to connect "the gold thing I shot off that barrel" to "this number went
 * up", and it only does that if the two look like the same object.
 */
const ICON: Record<Axis, string> = {
  // A helmeted head with a gold chevron — the crowd's own silhouette, promoted.
  elites: `<svg class="cok-chip__i" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 4c-6 0-10.4 4-10.4 9.4v1.2h20.8v-1.2C26.4 8 22 4 16 4z" fill="#ffc93c"/>
    <rect x="3.6" y="14.2" width="24.8" height="2.9" rx="1.45" fill="#d8951a"/>
    <path d="M16 19.5l3.2 6.2h-6.4z" fill="#ffe07a"/>
  </svg>`,
  // Rotary barrel cluster, blue receiver — the minigun pickup, side-on.
  rate: `<svg class="cok-chip__i" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="16" y="10" width="12" height="12" rx="2.5" fill="#3d7fd6"/>
    <rect x="3" y="11.4" width="15" height="2.6" rx="1.3" fill="#8f9bb0"/>
    <rect x="3" y="15" width="15" height="2.6" rx="1.3" fill="#c3ccdb"/>
    <rect x="3" y="18.6" width="15" height="2.6" rx="1.3" fill="#8f9bb0"/>
    <circle cx="22" cy="16" r="3.1" fill="#d8a13a"/>
  </svg>`,
  // Tube plus red warhead — the rocket pickup, nose left.
  power: `<svg class="cok-chip__i" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="10" y="12.6" width="17" height="6.8" rx="3.4" fill="#4a5568"/>
    <path d="M10.5 12.2L3 16l7.5 3.8z" fill="#d8452f"/>
    <rect x="21" y="19" width="4" height="5" rx="1" fill="#8f9bb0"/>
    <rect x="24.5" y="11" width="4" height="10" rx="1.6" fill="#d8a13a"/>
  </svg>`,
};

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Positioned off the troop badge's own metrics (10px top inset + ~36px tall +
 * an 8px gutter), so the two move together if the badge is ever restyled.
 */
const CSS = `
.cok-loadout {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 54px);
  left: calc(var(--safe-left, env(safe-area-inset-left, 0px)) + 12px);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  pointer-events: none;
}
.cok-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px 3px 5px;
  border-radius: 999px;
  background: rgba(12, 20, 34, 0.55);
  /* Hidden by default and slid left, so acquiring the first of a kind is a
     small arrival rather than a value appearing out of nowhere. */
  opacity: 0;
  transform: translate3d(-10px, 0, 0);
  transition: opacity 160ms ease-out, transform 160ms ease-out;
}
.cok-chip.is-live {
  opacity: 1;
  transform: translate3d(0, 0, 0);
}
.cok-chip.is-live.is-pop {
  transform: translate3d(0, 0, 0) scale(1.18);
}
.cok-chip__i {
  width: 18px;
  height: 18px;
  display: block;
  flex: 0 0 auto;
}
.cok-chip__v {
  font: 900 15px/1 "Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif;
  color: #ffffff;
  -webkit-text-stroke: 2px #10192b;
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
  transition: color 140ms ease-out;
}
.cok-chip.is-pop .cok-chip__v { color: #ffe11f; }
`;
