import 'dotenv/config';
import { columns, db, prompts } from '@fetch/db';
import { CsvNormalizer } from '@fetch/connectors';
import { ensureDefaultTable, ingestLead } from '@fetch/core';
import { sources } from '@fetch/db';

/**
 * Seed a fresh instance with enough to demo the loop end-to-end: a couple of
 * dynamic columns, a personalization prompt, and a handful of sample leads
 * (which also create their accounts via dedupe). Safe to run once on a clean DB.
 */
async function main() {
  const tableId = await ensureDefaultTable();

  console.log('[seed] inserting columns…');
  await db
    .insert(columns)
    .values([
      {
        tableId,
        key: 'company_size',
        label: 'Company size',
        type: 'dogi',
        config: {
          instruction: 'Find the company headcount.',
          reads: ['company'],
          output: { mode: 'fill', key: 'company_size' },
          sources: [{ type: 'provider', name: 'apollo' }, { type: 'web', via: 'native' }],
          policy: 'combine',
        },
      },
      {
        tableId,
        key: 'recent_signal',
        label: 'Recent signal',
        type: 'dogi',
        config: {
          instruction: 'Find this company’s most recent funding, launch, or hiring signal.',
          reads: ['company'],
          output: { mode: 'fill', key: 'recent_signal' },
          sources: [{ type: 'web', via: 'native' }, { type: 'llm' }],
          policy: 'combine',
        },
      },
    ])
    .onConflictDoNothing();

  console.log('[seed] inserting prompt…');
  await db
    .insert(prompts)
    .values({
      name: 'Outbound — default',
      version: 1,
      body: 'Write a short, specific cold email to {{first_name}} ({{title}}). If {{recent_signal}} is set, reference it naturally. No fluff.',
      guardrails: { maxLength: 600, requiredVars: ['first_name'] },
    })
    .onConflictDoNothing();

  console.log('[seed] importing sample leads…');
  const csv = [
    'first_name,last_name,email,company,title',
    'Ava,Chen,ava@acme.com,Acme,VP Sales',
    'Liam,Patel,liam@acme.com,Acme,Head of Growth',
    'Noah,Kim,noah@globex.io,Globex,Founder',
    'Mia,Garcia,mia@initech.com,Initech,RevOps Lead',
  ].join('\n');

  const [source] = await db.insert(sources).values({ type: 'csv', raw: { seed: true } }).returning();
  const leads = new CsvNormalizer().normalize(csv);
  for (const lead of leads) {
    await ingestLead(lead, { sourceId: source!.id, tableId, actor: 'seed' });
  }

  console.log('[seed] done. Open the web app and run a column.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
