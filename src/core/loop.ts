/**
 * GAME LOOP — fixed-timestep simulation, free-running render.
 *
 * WHY FIXED TIMESTEP. Every number in this game is a collision or a
 * multiplication: a gate either sweeps 40 troops or it sweeps 41. If the sim
 * advanced by whatever the frame happened to take, the same run would pay
 * differently on a 120Hz iPad than on a throttled Android, and no tuning pass
 * would ever be reproducible. The sim runs at exactly 60Hz or it doesn't run.
 *
 * The render callback gets `alpha`, the fraction between the last two sim
 * states, so smooth motion survives a frame rate that isn't a multiple of 60.
 */

const STEP_MS = 1000 / 60;
/**
 * A backgrounded tab returns with a multi-second delta. Without a ceiling the
 * loop tries to catch up all of it in one frame, which takes longer than a
 * frame, which grows the debt — the spiral of death. We drop the time instead.
 */
const MAX_FRAME_MS = 250;

export interface LoopCallbacks {
  /** Advance the simulation by exactly `dt` seconds. */
  update: (dt: number) => void;
  /** Draw. `alpha` is 0..1 between the previous and current sim state. */
  render: (alpha: number) => void;
  /** Per-frame timings, for the perf overlay. */
  onStats?: (stats: { fps: number; frameMs: number; simMs: number }) => void;
}

export class GameLoop {
  #raf = 0;
  #last = 0;
  #accumulator = 0;
  #running = false;

  // Rolling average over a second, so the readout is legible rather than jittery.
  #frames = 0;
  #statsClock = 0;
  #frameMsTotal = 0;
  #simMsTotal = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = performance.now();
    this.#accumulator = 0;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
  }

  readonly #tick = (now: number): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#tick);

    const frameMs = Math.min(now - this.#last, MAX_FRAME_MS);
    this.#last = now;
    this.#accumulator += frameMs;

    const simStart = performance.now();
    while (this.#accumulator >= STEP_MS) {
      this.cb.update(STEP_MS / 1000);
      this.#accumulator -= STEP_MS;
    }
    const simMs = performance.now() - simStart;

    this.cb.render(this.#accumulator / STEP_MS);

    this.#frames++;
    this.#frameMsTotal += frameMs;
    this.#simMsTotal += simMs;
    this.#statsClock += frameMs;
    if (this.#statsClock >= 1000) {
      this.cb.onStats?.({
        fps: (this.#frames * 1000) / this.#statsClock,
        frameMs: this.#frameMsTotal / this.#frames,
        simMs: this.#simMsTotal / this.#frames,
      });
      this.#frames = 0;
      this.#statsClock = 0;
      this.#frameMsTotal = 0;
      this.#simMsTotal = 0;
    }
  };
}
