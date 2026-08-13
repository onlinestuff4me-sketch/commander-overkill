/**
 * SINGLE-THUMB TOUCH DRIVER.
 *
 * RELATIVE DRAG, NOT ABSOLUTE. The obvious implementation maps the touch's x
 * straight onto the lane, but on a phone your thumb then sits on top of the
 * thing you are steering and hides it exactly when the gate arrives. Relative
 * dragging lets you hold the phone naturally, park your thumb low and to one
 * side, and still reach both walls.
 *
 * A gesture is a TAP if it stayed inside TAP_SLOP px and ended inside TAP_MS.
 * Skills fire on tap; anything longer is steering and must not also fire a
 * skill, or every hard dodge would burn an airstrike.
 */

import { bus } from "../core/events";

const TAP_MS = 250;
const TAP_SLOP = 12;
/**
 * Screen widths of drag needed to cross the corridor once.
 *
 * 1.6 was far too slow: crossing the road took more than a full swipe of the
 * screen, so dodging a red segment meant re-gripping mid-gesture and the whole
 * game felt like wading. At 0.7 a comfortable thumb arc — roughly a third of
 * the screen — covers the corridor, which is the range a one-handed grip
 * actually has.
 *
 * This is the OUTER half of steering feel. The inner half is how fast the
 * crowd converges on this target, which lives in the squad's spring constants;
 * loosening one without the other just moves where the lag comes from.
 */
const DRAG_SENSITIVITY = 0.7;

export class TouchDriver {
  /** Current steering target, normalised to [-1, 1]. Read by the sim each tick. */
  lane = 0;

  #pointerId: number | null = null;
  #startX = 0;
  #startY = 0;
  #startLane = 0;
  #startTime = 0;
  #moved = 0;

  constructor(private readonly el: HTMLElement) {
    el.addEventListener("pointerdown", this.#onDown);
    el.addEventListener("pointermove", this.#onMove);
    el.addEventListener("pointerup", this.#onUp);
    el.addEventListener("pointercancel", this.#onUp);
    // Belt and braces: iOS Safari still emits a synthetic scroll/zoom from
    // touchmove in some standalone contexts even with touch-action: none.
    el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  readonly #onDown = (e: PointerEvent): void => {
    // First finger down wins the steering role; later fingers are ignored so a
    // stray palm touch cannot yank the commander across the corridor.
    if (this.#pointerId !== null) return;
    this.#pointerId = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.#startX = e.clientX;
    this.#startY = e.clientY;
    this.#startLane = this.lane;
    this.#startTime = performance.now();
    this.#moved = 0;
  };

  readonly #onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return;
    const dx = e.clientX - this.#startX;
    const dy = e.clientY - this.#startY;
    this.#moved = Math.max(this.#moved, Math.hypot(dx, dy));

    const span = window.innerWidth * DRAG_SENSITIVITY;
    const next = clamp(this.#startLane + (dx / span) * 2, -1, 1);
    if (next !== this.lane) {
      this.lane = next;
      bus.emit("commander:moved", { lane: next });
    }
  };

  readonly #onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return;
    this.#pointerId = null;
    const heldMs = performance.now() - this.#startTime;
    if (heldMs <= TAP_MS && this.#moved <= TAP_SLOP) {
      bus.emit("input:tap", { x: e.clientX, y: e.clientY });
    }
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
