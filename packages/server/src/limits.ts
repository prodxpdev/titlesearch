// Request limits: a per-principal rate limit, and a global ceiling on
// requests that fetch from the outside world (CLAUDE.md, HTTP API).

export class PrincipalRateLimit {
  readonly #windows = new Map<string, { start: number; count: number }>();
  constructor(
    readonly perMinute: number,
    readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds to wait if over the limit, or 0 if the request may proceed. */
  take(principal: string): number {
    const t = this.now();
    const w = this.#windows.get(principal);
    if (!w || t - w.start >= 60_000) {
      this.#windows.set(principal, { start: t, count: 1 });
      return 0;
    }
    if (w.count >= this.perMinute) return Math.ceil((w.start + 60_000 - t) / 1000);
    w.count++;
    return 0;
  }
}

export class ConcurrencyLimit {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  constructor(
    readonly max: number,
    readonly maxQueued: number,
  ) {}

  /** Runs `fn` when a slot is free. Returns undefined, without running it, if the queue is full. */
  async run<T>(fn: () => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.#active >= this.max) {
      if (this.#queue.length >= this.maxQueued) return undefined;
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      return { value: await fn() };
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}
