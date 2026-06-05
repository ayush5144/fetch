import { describe, expect, it } from 'vitest';
import { getAdapter, InstantlyAdapter, SmartleadAdapter, SmtpAdapter } from '../src';

/**
 * Phase 11 — the second rail proves the abstraction. Provider selection is the
 * ONLY place the core chooses a rail; every adapter implements the same
 * `push` / `parseEvent` contract, so a campaign can switch providers with no
 * change to core or campaign code.
 */
describe('adapter selection', () => {
  it('resolves each provider to its adapter', () => {
    expect(getAdapter('instantly')).toBeInstanceOf(InstantlyAdapter);
    expect(getAdapter('smartlead')).toBeInstanceOf(SmartleadAdapter);
    expect(getAdapter('smtp')).toBeInstanceOf(SmtpAdapter);
  });

  it('throws on an unknown provider rather than silently mis-sending', () => {
    expect(() => getAdapter('carrier-pigeon' as any)).toThrow();
  });

  it('every adapter satisfies the SendAdapter contract identically', () => {
    for (const provider of ['instantly', 'smartlead', 'smtp'] as const) {
      const adapter = getAdapter(provider);
      expect(adapter.provider).toBe(provider);
      expect(typeof adapter.push).toBe('function');
      expect(typeof adapter.parseEvent).toBe('function');
      expect(typeof adapter.available).toBe('boolean');
    }
  });
});
