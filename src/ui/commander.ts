/**
 * THE COMMANDER — the joke the whole game is named after, and the last piece of
 * it to get built.
 *
 * ---------------------------------------------------------------------------
 * The brief, from specs/prd.md
 * ---------------------------------------------------------------------------
 * "The Commander narrates screen-clearing carnage with total military composure,
 * and the gap between his tone and the absurdity on screen is the comedy. He
 * never breaks. The game takes itself completely seriously. That's the joke."
 *
 * Everything here follows from "he never breaks". He does not comment on how
 * funny it is, he does not use exclamation marks except as orders, and he never
 * acknowledges that four hundred identical men are riding a suspension bridge
 * into a giant with a club. He files a report.
 *
 * ---------------------------------------------------------------------------
 * Three rules that keep him funny rather than noisy
 * ---------------------------------------------------------------------------
 * 1. HE SPEAKS AFTER, NEVER DURING. Every trigger is a resolution — a boss died,
 *    a row paid, the army crossed a threshold. Nothing calls him while a
 *    decision is on the road, because a player reading a joke is a player not
 *    reading the corridor.
 * 2. HE DOES NOT REPEAT HIMSELF. Lines are walked rather than rolled, per kind,
 *    so the second boss gets the second boss line. A random table on a two
 *    minute run says the same thing twice and stops being a character.
 * 3. HE SHUTS UP. One line at a time, a hard cooldown between them, and a
 *    priority so a boss dying can cut off a remark about troop numbers.
 *
 * DOM rather than world text, for the reason the boss bar is: it is screen-space
 * by nature, it costs no draw calls, and it rasterises at the device's true
 * pixel ratio instead of through the renderer's DPR cap.
 */

import type { System } from "../core/types";

const STYLE_ID = "cok-commander-style";

/** Seconds a line stays up, and the quiet after it before another may fire.
 *  The hold is long enough to read twelve words at arm's length; the cooldown
 *  is longer than the corridor's decision cadence, so he cannot become a
 *  running commentary. */
const HOLD_TIME = 2.6;
const COOLDOWN = 5.5;

export type CommanderTopic = "opening" | "growth" | "boss" | "streak" | "loss" | "wipe";

/** Higher cuts off lower. A boss dying outranks a remark about head count. */
const PRIORITY: Record<CommanderTopic, number> = {
  opening: 0,
  growth: 1,
  streak: 1,
  loss: 2,
  boss: 3,
  wipe: 4,
};

export interface CommanderSystem extends System {
  /** File a report. Ignored if something more important is already on screen or
   *  the cooldown is still running. */
  say(topic: CommanderTopic): void;
  reset(): void;
  dispose(): void;
}

export function createCommander(parent: HTMLElement): CommanderSystem {
  injectStyle();

  const root = document.createElement("div");
  root.className = "cok-cmdr";
  root.innerHTML = `<span class="cok-cmdr__who">COMMANDER</span><span class="cok-cmdr__line"></span>`;
  parent.appendChild(root);
  const lineEl = root.querySelector<HTMLElement>(".cok-cmdr__line")!;

  const cursor: Record<string, number> = {};
  let hold = 0;
  let cool = 0;
  let priority = -1;
  let shownLive = false;

  return {
    say(topic) {
      const rank = PRIORITY[topic];
      // A line already up may only be interrupted by something that outranks it;
      // otherwise the cooldown decides.
      if (hold > 0 ? rank <= priority : cool > 0) return;
      const lines = LINES[topic];
      const i = cursor[topic] ?? 0;
      cursor[topic] = (i + 1) % lines.length;
      lineEl.textContent = lines[i] ?? "";
      hold = HOLD_TIME;
      cool = HOLD_TIME + COOLDOWN;
      priority = rank;
    },

    reset() {
      hold = 0;
      cool = 0;
      priority = -1;
      for (const k of Object.keys(cursor)) cursor[k] = 0;
    },

    update(dt, _world) {
      if (hold > 0) {
        hold = Math.max(0, hold - dt);
        if (hold === 0) priority = -1;
      }
      if (cool > 0) cool = Math.max(0, cool - dt);
    },

    render(_alpha, _world) {
      const live = hold > 0;
      if (live !== shownLive) {
        shownLive = live;
        root.classList.toggle("is-live", live);
      }
    },

    dispose() {
      root.remove();
    },
  };
}

/**
 * Walked in order, per topic. Written to be read in one glance on a phone — the
 * longest is eleven words — and to be funnier for being filed rather than
 * exclaimed.
 */
const LINES: Record<CommanderTopic, readonly string[]> = {
  opening: [
    "One man. Acceptable. Proceed.",
    "Company at full strength. Strength: one.",
    "Advance. The bridge is not going to cross itself.",
  ],
  growth: [
    "Recruitment target exceeded. Requisition more helmets.",
    "Head count nominal. Head count is never nominal.",
    "Reinforcements absorbed. Formation remains dignified.",
    "We are now a crowd. Maintain military bearing.",
    "Logistics reports we have run out of road, not men.",
  ],
  boss: [
    "Target neutralised. Execute tactical celebratory flex.",
    "The obstruction has been reclassified as debris.",
    "Hostile removed. Note its dimensions in the report.",
    "Enemy commander eliminated. His club is now ours.",
  ],
  streak: [
    "Four clean gates. Somebody is reading the road.",
    "Discipline holding. This is what discipline looks like.",
    "Unblemished record. Do not develop a personality about it.",
  ],
  loss: [
    "Casualties acceptable. Morale: outstanding.",
    "We have taken losses. We will take fewer next time.",
    "Regrettable. Press on.",
    "Those men knew the risks. They did not, but they do now.",
  ],
  wipe: [
    "Company destroyed. Filing paperwork. Beginning again.",
    "Total loss. The bridge remains. So do we.",
    "That was a learning opportunity. Learn faster.",
  ],
};

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Under the boss bar and above the road's business. Deliberately narrow so a
 * long line wraps to two rather than running the full width — a full-width
 * banner reads as a system message, and this is a person.
 */
const CSS = `
.cok-cmdr {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 92px);
  left: 50%;
  width: min(74vw, 310px);
  transform: translate(-50%, -6px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 12px 8px;
  border-radius: 12px;
  background: rgba(10, 16, 26, 0.72);
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 180ms ease-out, transform 180ms ease-out;
}
.cok-cmdr.is-live {
  opacity: 1;
  transform: translate(-50%, 0);
}
.cok-cmdr__who {
  font: 800 9px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.22em;
  color: #ffd447;
}
.cok-cmdr__line {
  font: 700 13px/1.25 "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #f2f6ff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
`;
