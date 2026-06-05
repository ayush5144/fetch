import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rateLimiter';

/**
 * Phase 11 — provider rate limiting. The limiter must guarantee that no window
 * of `windowMs` ever holds more than `max` reservations, so a large Smartlead
 * send (10 req / 2s) never produces a 429 storm. We drive an injected clock so
 * the test is deterministic with no real waiting.
 */
describe('RateLimiter', () => {
  it('never schedules more than `max` fires in any window', () => {
    const now = 0;
    const limiter = new RateLimiter(10, 2_000, () => now);

    // Reserve 100 slots all "arriving" at t=0.
    const fires = Array.from({ length: 100 }, () => limiter.schedule());

    // For every reservation, at most `max` others fall within the trailing window.
    for (const f of fires) {
      const inWindow = fires.filter((o) => o > f - 2_000 && o <= f).length;
      expect(inWindow).toBeLessThanOrEqual(10);
    }
  });

  it('staggers a burst into windowed batches', () => {
    const now = 0;
    const limiter = new RateLimiter(10, 2_000, () => now);
    const fires = Array.from({ length: 25 }, () => limiter.schedule());

    // First 10 fire immediately, next 10 a window later, final 5 two windows on.
    expect(fires.slice(0, 10).every((t) => t === 0)).toBe(true);
    expect(fires.slice(10, 20).every((t) => t === 2_000)).toBe(true);
    expect(fires.slice(20, 25).every((t) => t === 4_000)).toBe(true);
  });

  it('fires immediately again once earlier slots leave the window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1_000, () => now);
    expect(limiter.schedule()).toBe(0);
    expect(limiter.schedule()).toBe(0);
    now = 1_000; // the first two have now exited the window
    expect(limiter.schedule()).toBe(1_000);
  });
});
