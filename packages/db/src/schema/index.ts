/**
 * The single source of truth, as tables. Import the whole schema from here so
 * Drizzle and the migration tooling see one consistent surface.
 *
 * Object order mirrors the nine core domain objects in ARCHITECTURE.md
 * (plus `columns`, which powers the dynamic column engine).
 */
export * from './_shared';
export * from './tables';
export * from './sources';
export * from './accounts';
export * from './prompts';
export * from './campaigns';
export * from './sequences';
export * from './leads';
export * from './columns';
export * from './jobs';
export * from './events';
export * from './auditLog';
