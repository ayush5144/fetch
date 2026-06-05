import { describe, expect, it } from 'vitest';
import { CsvNormalizer, ManualNormalizer, mapRecord, readCsvHeaders } from '../src';

/**
 * Phase 2 — ingestion. The canonical-shape invariant is the load-bearing one:
 * every source must normalize to the same lead, so downstream stages are
 * written once and work everywhere. These are pure-function tests (no DB).
 */
describe('field mapping', () => {
  it('maps common headers (incl. snake_case) to canonical fields', () => {
    const lead = mapRecord({
      first_name: 'Ava',
      last_name: 'Chen',
      email: 'AVA@Acme.com',
      job_title: 'VP Sales',
      company: 'Acme',
    });
    expect(lead.firstName).toBe('Ava');
    expect(lead.lastName).toBe('Chen');
    expect(lead.email).toBe('ava@acme.com'); // lowercased
    expect(lead.title).toBe('VP Sales');
    expect(lead.company?.name).toBe('Acme');
  });

  it('derives the account domain from the email when none is given', () => {
    const lead = mapRecord({ email: 'noah@globex.io' });
    expect(lead.company?.domain).toBe('globex.io');
  });

  it('routes unmapped columns into data verbatim', () => {
    const lead = mapRecord({ email: 'a@b.com', 'Custom Score': '42', Region: 'EMEA' });
    expect(lead.data).toMatchObject({ 'Custom Score': '42', Region: 'EMEA' });
  });

  it('extracts a domain from a website value with protocol and path', () => {
    const lead = mapRecord({ email: 'x@y.com', website: 'https://www.Acme.com/about' });
    expect(lead.company?.domain).toBe('acme.com');
  });
});

describe('canonical-shape invariant', () => {
  it('produces an identical canonical lead from CSV and manual entry', () => {
    const csv = 'first_name,last_name,email,company,title\nAva,Chen,ava@acme.com,Acme,VP Sales';
    const fromCsv = new CsvNormalizer().normalize(csv)[0];

    const fromManual = new ManualNormalizer().normalize({
      'first name': 'Ava',
      'last name': 'Chen',
      email: 'ava@acme.com',
      company: 'Acme',
      title: 'VP Sales',
    });

    expect(fromManual).toEqual(fromCsv);
  });
});

describe('CSV parsing', () => {
  it('reads just the header row for the mapping UI', () => {
    const csv = 'first_name,email,company\nAva,ava@acme.com,Acme';
    expect(readCsvHeaders(csv)).toEqual(['first_name', 'email', 'company']);
  });

  it('tolerates ragged rows instead of throwing', () => {
    const csv = 'first_name,email\nAva,ava@acme.com\nLiam'; // missing email
    const leads = new CsvNormalizer().normalize(csv);
    expect(leads).toHaveLength(2);
    expect(leads[1]!.firstName).toBe('Liam');
  });
});
