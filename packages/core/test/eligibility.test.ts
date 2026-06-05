import { describe, expect, it } from 'vitest';
import type { Lead } from '@fetch/db';
import { isCampaignEligible } from '../src/eligibility';

/**
 * Phase 8 — the send gate. Pure predicate, so a fast unit test. Proves only
 * approved + valid (opt-in risky) leads are eligible, and an already-sent lead
 * is never re-sent.
 */
const lead = (over: Partial<Lead>): Lead =>
  ({
    validationStatus: 'valid',
    approvalStatus: 'approved',
    sendStatus: 'none',
    ...over,
  }) as Lead;

describe('isCampaignEligible', () => {
  it('passes an approved, valid, unsent lead', () => {
    expect(isCampaignEligible(lead({}))).toBe(true);
  });

  it('blocks a non-valid lead regardless of approval', () => {
    expect(isCampaignEligible(lead({ validationStatus: 'invalid' }))).toBe(false);
    expect(isCampaignEligible(lead({ validationStatus: 'no_email' }))).toBe(false);
    expect(isCampaignEligible(lead({ validationStatus: 'unchecked' }))).toBe(false);
  });

  it('blocks a risky lead unless allowRisky is opted in', () => {
    expect(isCampaignEligible(lead({ validationStatus: 'risky' }))).toBe(false);
    expect(isCampaignEligible(lead({ validationStatus: 'risky' }), { allowRisky: true })).toBe(true);
  });

  it('blocks an unapproved lead by default, but allows it when approval not required', () => {
    expect(isCampaignEligible(lead({ approvalStatus: 'draft' }))).toBe(false);
    expect(isCampaignEligible(lead({ approvalStatus: 'draft' }), { requireApproved: false })).toBe(
      true,
    );
  });

  it('never re-sends an already-sent lead', () => {
    expect(isCampaignEligible(lead({ sendStatus: 'sent' }))).toBe(false);
  });
});
