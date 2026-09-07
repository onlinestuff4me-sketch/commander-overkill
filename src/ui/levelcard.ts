/**
 * LEVELS — the pill on the HUD, the screen between levels, and the upgrade
 * choice that screen exists to offer.
 *
 * ---------------------------------------------------------------------------
 * Why one module owns all three
 * ---------------------------------------------------------------------------
 * They are one idea. A level is a unit of play with a boundary; the pill says
 * which one you are in, the card says you finished it, and the upgrade is what
 * finishing it buys. Splitting them across three files would put the level
 * number in two places and guarantee they drift.
 *
 * ---------------------------------------------------------------------------
 * What this module does NOT decide
 * ---------------------------------------------------------------------------
 * When a level ends, what a perk does, or what the next one costs. It is a
 * screen: it is told the numbers and it reports which button was pressed. The
 * orchestrator owns the run.
 */

import type { System } from "../core/types";

const STYLE_ID = "cok-level-style";

/** What a finished level is summarised by. Deliberately two numbers — the
 *  reference shows exactly two, and a debrief that needs reading is a debrief
 *  nobody reads. */
export interface LevelSummary {
  level: number;
  biggestCrowd: number;
  bosses: number;
  /** Blurb under the headline: what the next level brings. */
  teaser: string;
}

/** One offer on the cleared screen. */
export interface PerkOffer {
  id: string;
  title: string;
  detail: string;
  /** Roman numeral of the level this perk would become. Empty for the first. */
  rank: string;
  icon: string;
}

export type LevelChoice =
  | { kind: "perk"; id: string }
  | { kind: "retry" }
  | { kind: "restart" };

export interface LevelCardSystem extends System {
  /** Show the cleared screen. `onPick` fires once, with the chosen perk. */
  showCleared(summary: LevelSummary, perks: readonly PerkOffer[]): void;
  /** Show the failed screen: retry this level, or start over from level 1. */
  showFailed(level: number): void;
  hide(): void;
  readonly visible: boolean;
  onChoice(fn: (choice: LevelChoice) => void): void;
  dispose(): void;
}

export function createLevelCard(parent: HTMLElement): LevelCardSystem {
  injectStyle();

  const pill = document.createElement("div");
  pill.className = "cok-lvl";
  pill.textContent = "LVL 1";
  parent.appendChild(pill);

  const card = document.createElement("div");
  card.className = "cok-card";
  parent.appendChild(card);

  let visible = false;
  let choiceFn: ((choice: LevelChoice) => void) | null = null;
  let shownLevel = -1;

  function emit(choice: LevelChoice): void {
    if (!visible) return;
    visible = false;
    card.classList.remove("is-live");
    choiceFn?.(choice);
  }

  // ONE DELEGATED LISTENER rather than one per button. The card's contents are
  // rebuilt on every level, and per-button listeners on rebuilt markup are how a
  // screen ends up firing last level's callback.
  card.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-choice]");
    if (!el) return;
    const kind = el.dataset["choice"];
    if (kind === "perk") emit({ kind: "perk", id: el.dataset["perk"] ?? "" });
    else if (kind === "retry") emit({ kind: "retry" });
    else if (kind === "restart") emit({ kind: "restart" });
  });

  return {
    get visible() {
      return visible;
    },

    showCleared(summary, perks) {
      card.innerHTML = `
        <div class="cok-card__head cok-card__head--win">LEVEL ${summary.level}<br>CLEARED!</div>
        <div class="cok-card__teaser">${summary.teaser}</div>
        <div class="cok-card__stats">
          <div><b>${summary.biggestCrowd}</b><span>BIGGEST CROWD</span></div>
          <div><b>${summary.bosses}</b><span>BOSSES</span></div>
        </div>
        <div class="cok-card__pick">CHOOSE AN UPGRADE</div>
        <div class="cok-card__perks">
          ${perks
            .map(
              (p) => `<button class="cok-perk" data-choice="perk" data-perk="${p.id}">
                <span class="cok-perk__icon">${p.icon}</span>
                <span class="cok-perk__title">${p.title}${p.rank ? ` <i>${p.rank}</i>` : ""}</span>
                <span class="cok-perk__detail">${p.detail}</span>
              </button>`,
            )
            .join("")}
        </div>`;
      card.classList.add("is-live");
      visible = true;
    },

    showFailed(level) {
      card.innerHTML = `
        <div class="cok-card__head cok-card__head--lose">LEVEL ${level}<br>FAILED</div>
        <div class="cok-card__teaser">The company was destroyed. It happens.</div>
        <div class="cok-card__perks cok-card__perks--end">
          <button class="cok-btn cok-btn--go" data-choice="retry">RETRY LEVEL</button>
          <button class="cok-btn" data-choice="restart">START OVER</button>
        </div>`;
      card.classList.add("is-live");
      visible = true;
    },

    hide() {
      visible = false;
      card.classList.remove("is-live");
    },

    onChoice(fn) {
      choiceFn = fn;
    },

    update(_dt, _world) {},

    render(_alpha, world) {
      if (world.level !== shownLevel) {
        shownLevel = world.level;
        pill.textContent = `LVL ${world.level}`;
      }
    },

    dispose() {
      pill.remove();
      card.remove();
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
.cok-lvl {
  position: absolute;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 14px);
  left: calc(var(--safe-left, env(safe-area-inset-left, 0px)) + 12px);
  padding: 6px 13px;
  border-radius: 999px;
  background: rgba(12, 20, 34, 0.55);
  color: #fff;
  font: 800 13px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.06em;
  pointer-events: none;
}
/*
 * ONE SWITCH CLEARS THE HUD.
 *
 * The card is a screen, not an overlay: the level, the count, the meters and the
 * Commander are all statements about a run that is currently not happening, and
 * leaving them up turns a reward moment into a cluttered modal. The rule spans
 * five modules, which is why it lives here rather than in each of them — the
 * card is the only thing that knows the state it applies to.
 */
#ui.is-carded .cok-troops,
#ui.is-carded .cok-lvl,
#ui.is-carded .cok-loadout,
#ui.is-carded .cok-streak,
#ui.is-carded .cok-skills,
#ui.is-carded .cok-cmdr,
#ui.is-carded .cok-boss {
  /* NOT a fade. A card is a scene change rather than a state change, so the HUD
     cuts. It is also the only version this project can verify: an offscreen
     browser pane starves CSS transitions the same way it starves
     requestAnimationFrame (see CLAUDE.md), so a faded HUD photographs at
     whatever opacity the transition happened to reach. */
  visibility: hidden;
  opacity: 0;
}
.cok-card {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px 18px;
  /* Dark enough to read a button against, light enough that the crowd you just
     built is still visible behind it — the reference keeps the road on screen
     through its own clear screen, and it is most of why the moment feels like a
     reward rather than a modal. */
  background: rgba(6, 10, 18, 0.62);
  text-align: center;
  z-index: 20;
}
.cok-card.is-live { display: flex; }
.cok-card__head {
  font: 900 40px/0.95 "Arial Black", "Helvetica Neue", Impact, sans-serif;
  -webkit-text-stroke: 5px #0d1524;
  paint-order: stroke fill;
  letter-spacing: 0.01em;
}
.cok-card__head--win { color: #46e06a; }
.cok-card__head--lose { color: #ff5a45; }
.cok-card__teaser {
  font: 700 14px/1.3 "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #dfe7f5;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}
.cok-card__stats {
  display: flex;
  gap: 34px;
  margin-top: 2px;
}
.cok-card__stats div { display: flex; flex-direction: column; gap: 3px; }
.cok-card__stats b {
  font: 900 30px/1 "Arial Black", "Helvetica Neue", Impact, sans-serif;
  color: #fff;
  -webkit-text-stroke: 3px #0d1524;
  paint-order: stroke fill;
}
.cok-card__stats span {
  font: 800 9px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.14em;
  color: #9fb0c8;
}
.cok-card__pick {
  margin-top: 6px;
  font: 800 10px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.2em;
  color: #ffd447;
}
.cok-card__perks {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: min(88vw, 330px);
}
.cok-card__perks--end { margin-top: 10px; }
.cok-perk {
  display: grid;
  grid-template-columns: 34px 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 1px 10px;
  padding: 10px 14px;
  border: 0;
  border-radius: 14px;
  background: rgba(30, 44, 68, 0.94);
  color: #fff;
  text-align: left;
  cursor: pointer;
  /* The card is the only thing in this game that takes input, so it is the only
     thing that opts back in — everything else on the HUD is pointer-events:none
     so a thumb dragging across it still steers. */
  pointer-events: auto;
}
.cok-perk:active { transform: scale(0.97); }
.cok-perk__icon { grid-row: 1 / 3; font-size: 24px; text-align: center; }
.cok-perk__title {
  font: 800 15px/1.1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
}
.cok-perk__title i { color: #ffd447; font-style: normal; }
.cok-perk__detail {
  font: 600 12px/1.15 "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #a9bad2;
}
.cok-btn {
  padding: 14px 18px;
  border: 0;
  border-radius: 999px;
  background: rgba(30, 44, 68, 0.94);
  color: #fff;
  font: 800 16px/1 "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.06em;
  cursor: pointer;
  pointer-events: auto;
}
.cok-btn--go { background: #35c95a; }
.cok-btn:active { transform: scale(0.97); }
`;
