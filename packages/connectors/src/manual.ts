import type { CanonicalLead, Normalizer } from '@fetch/core';
import { mapRecord } from './fieldMap';

/**
 * Manual / API connector — normalizes a single hand-entered or API-posted lead.
 * Proves the canonical-shape invariant: the same person entered manually and
 * imported from CSV must produce an identical CanonicalLead.
 */
export class ManualNormalizer implements Normalizer<Record<string, string>> {
  readonly sourceType = 'manual' as const;

  normalize(raw: Record<string, string>): CanonicalLead {
    return mapRecord(raw);
  }
}
