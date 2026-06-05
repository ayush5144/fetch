import type { Lead } from '@fetch/db';

/**
 * Build the variable bag a template can reference, drawn from the lead's system
 * fields and its user `data`. {{first_name}}, {{title}}, {{recent_signal}} all
 * resolve from here. User-column keys are exposed directly so any enriched cell
 * is usable in copy.
 */
export function buildVariables(lead: Lead): Record<string, string> {
  const data = (lead.data as Record<string, unknown>) ?? {};
  const vars: Record<string, string> = {
    first_name: lead.firstName ?? '',
    last_name: lead.lastName ?? '',
    full_name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    email: lead.email ?? '',
    title: lead.title ?? '',
    company_domain: lead.email?.split('@')[1] ?? '',
  };
  // Expose every user column as a variable (stringified).
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) vars[key] = String(value);
  }
  return vars;
}

/** Replace {{var}} tokens. Returns the filled text and any vars left unresolved. */
export function bindTemplate(
  template: string,
  vars: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}
