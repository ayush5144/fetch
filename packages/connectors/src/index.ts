/**
 * @fetch/connectors — INGESTION. Normalize any source (CSV, manual, webhook,
 * CRM) into the one canonical lead shape so every downstream stage is written
 * once and works everywhere.
 */
export * from './fieldMap';
export * from './csv';
export * from './manual';
