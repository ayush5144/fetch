import { auditLog, db } from '@fetch/db';

/**
 * Append one row to the audit log. This is the *only* place history is kept —
 * we never copy a lead to remember its past. Call it on every meaningful state
 * change (create, update, approve, send) with a before/after diff.
 */
export async function audit(entry: {
  actor?: string;
  entity: string;
  entityId: string;
  action: string;
  diff?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor ?? 'system',
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    diff: entry.diff ?? {},
  });
}

/**
 * Compute a shallow before/after diff for an update, so the audit row records
 * only what actually changed rather than the whole object.
 */
export function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      diff[key] = { from: before[key], to: after[key as keyof T] };
    }
  }
  return diff;
}
