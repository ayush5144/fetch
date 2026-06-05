/**
 * @fetch/columns — the DYNAMIC COLUMN ENGINE. A column is a reusable job
 * definition; running it fans that job across rows (run-only-if-empty). Values
 * land in leads.data with confidence + provenance, enriched in place.
 */
export * from './cell';
export * from './formula';
export * from './resolve';
export * from './engine';
export * from './validate';
