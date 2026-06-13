// Minimal FIFO counting semaphore. Used to cap concurrent transcribes independently
// of book-level concurrency (a single GPU Whisper service serializes anyway, so we
// don't want N books all hitting it at once).
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Acquire a slot; await resolves when one is free. Returns an idempotent release. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      // Slot handed to us by release() — active count is unchanged (transferred).
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); // transfer the slot to the next waiter; active stays the same
    else this.active -= 1;
  }
}
