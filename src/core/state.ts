/**
 * STATE MACHINE — which screen owns the frame.
 *
 * Deliberately tiny. Its job is to make "the run ended but pickups are still
 * spawning" impossible to express, not to be a general-purpose FSM library.
 */

export type GameState = "boot" | "briefing" | "running" | "paused" | "debrief";

const ALLOWED: Record<GameState, readonly GameState[]> = {
  boot: ["briefing"],
  briefing: ["running"],
  running: ["paused", "debrief"],
  paused: ["running", "debrief"],
  debrief: ["briefing"],
};

export class StateMachine {
  #state: GameState = "boot";
  readonly #listeners = new Set<(to: GameState, from: GameState) => void>();

  get state(): GameState {
    return this.#state;
  }

  can(to: GameState): boolean {
    return ALLOWED[this.#state].includes(to);
  }

  /** Returns false rather than throwing — a rejected transition is a bug to see, not a crash. */
  transition(to: GameState): boolean {
    if (!this.can(to)) {
      console.warn(`[state] refused ${this.#state} → ${to}`);
      return false;
    }
    const from = this.#state;
    this.#state = to;
    for (const listener of this.#listeners) listener(to, from);
    return true;
  }

  onChange(listener: (to: GameState, from: GameState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
