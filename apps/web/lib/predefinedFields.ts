/**
 * Single source of truth for **predefined common fields** — a thin recognition
 * layer over the arbitrary-columns model (see devx/predefined-fields.md).
 *
 * A Fetch table is still arbitrary columns; this registry only adds friendly
 * icons + quick-pick chips for a handful of ubiquitous B2B fields. It does NOT
 * introduce a fixed schema: `company` is still a normal `text` column whose
 * value lives in `data.company`.
 *
 * Both the Add-column "Common fields" chips and the grid `columnIcon` read from
 * this list so they never drift. Adding/removing a recognized field is a
 * one-line edit here.
 *
 * `key` is the snake_cased key the column will have — it must match how
 * AddColumnPopover derives keys from labels ("First name" → `first_name`,
 * "LinkedIn URL" → `linkedin_url`).
 */

export interface PredefinedField {
  key: string;
  label: string;
  valueType: string;
  icon: string;
}

export const PREDEFINED_FIELDS: PredefinedField[] = [
  { key: 'name',         label: 'Name',         valueType: 'text',  icon: '👤' },
  { key: 'first_name',   label: 'First name',   valueType: 'text',  icon: '👤' },
  { key: 'last_name',    label: 'Last name',    valueType: 'text',  icon: '👤' },
  { key: 'email',        label: 'Email',        valueType: 'email', icon: '✉' },
  { key: 'phone',        label: 'Phone',        valueType: 'text',  icon: '☎' },
  { key: 'title',        label: 'Title',        valueType: 'text',  icon: '🏷' },
  { key: 'linkedin_url', label: 'LinkedIn URL', valueType: 'url',   icon: '🔗' },
  { key: 'company',      label: 'Company',      valueType: 'text',  icon: '🏢' },
];

const BY_KEY = new Map(PREDEFINED_FIELDS.map((f) => [f.key, f]));

/** Look up a predefined field by its (snake_cased) column key. */
export function predefinedFieldByKey(key: string | undefined): PredefinedField | undefined {
  if (!key) return undefined;
  return BY_KEY.get(key);
}
