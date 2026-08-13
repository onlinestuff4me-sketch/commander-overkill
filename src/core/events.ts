/**
 * EVENT BUS — the one place systems are allowed to talk to each other.
 *
 * The rule this enforces: the simulation never reaches into the renderer, and
 * the renderer never reaches into the simulation. They both publish and
 * subscribe here. Break that and the Unity port in Phase 3 stops being a port.
 *
 * Typed by design — `GameEvents` is the whole vocabulary of the game, and a
 * typo in an event name is a compile error rather than a listener that silently
 * never fires.
 */

export interface GameEvents {
  /** Player's lane position changed, normalised to [-1, 1]. */
  "commander:moved": { lane: number };
  /** A skill button or screen tap fired. */
  "input:tap": { x: number; y: number };
  /** Frame finished; carries timings for the perf overlay. */
  "frame:stats": { fps: number; frameMs: number; simMs: number };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

export class EventBus {
  readonly #handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    // Returning the unsubscribe closure means callers never need the handler
    // reference again, which is what makes it practical to actually clean up.
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    // Copy before iterating: a handler is allowed to unsubscribe itself.
    for (const handler of [...set]) (handler as Handler<K>)(payload);
  }

  clear(): void {
    this.#handlers.clear();
  }
}

export const bus = new EventBus();
