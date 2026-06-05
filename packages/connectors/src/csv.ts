import { parse } from 'csv-parse/sync';
import type { CanonicalLead, Normalizer } from '@fetch/core';
import { type HeaderMap, mapRecord } from './fieldMap';

/**
 * CSV connector — parses a CSV buffer/string into canonical leads. Header
 * detection is automatic; an optional explicit map overrides it for ambiguous
 * columns. Implements the shared Normalizer interface so ingestion treats it
 * like any other source.
 */
export class CsvNormalizer implements Normalizer<string> {
  readonly sourceType = 'csv' as const;

  constructor(private readonly headerMap: HeaderMap = {}) {}

  normalize(raw: string): CanonicalLead[] {
    const records = parse(raw, {
      columns: true, // first row is the header
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true, // tolerate ragged rows rather than throwing
    }) as Record<string, string>[];

    return records.map((record) => mapRecord(record, this.headerMap));
  }
}

/** Read just the header row, for the import UI's column-mapping step. */
export function readCsvHeaders(raw: string): string[] {
  const rows = parse(raw, { to_line: 1, trim: true }) as string[][];
  return rows[0] ?? [];
}
