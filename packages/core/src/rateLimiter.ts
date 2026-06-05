/**
 * A sliding-window rate limiter for honoring provider request caps (e.g.
 * Smartlead's 10 requests / 2 seconds). `schedule()` returns the timestamp at
 * which the next request may fire and records that slot, guaranteeing that no
 * window of `windowMs` ever contains more than `max` requests.
 *
 * The clock is injectable so the pacing math is testable without real timers.
 * In production the send loop sleeps until the returned time before its call.
 */
export class RateLimiter {
  private readonly fireTimes: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reserve the next slot; returns the epoch-ms time it is cleared to fire. */
  schedule(): number {
    const t = this.now();

    // Forget slots that have fully exited the window — they no longer constrain.
    while (this.fireTimes.length && this.fireTimes[0]! <= t - this.windowMs) {
      this.fireTimes.shift();
    }

    let fireAt = t;
    if (this.fireTimes.length >= this.max) {
      // The `max`-th most recent reservation must be a full window in the past,
      // so this one fires when that slot exits the window.
      const constraining = this.fireTimes[this.fireTimes.length - this.max]!;
      fireAt = Math.max(t, constraining + this.windowMs);
    }
    this.fireTimes.push(fireAt);
    return fireAt;
  }

  /** Reserve a slot and resolve once it's time to fire (used in production). */
  async acquire(): Promise<void> {
    const fireAt = this.schedule();
    const wait = fireAt - this.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
