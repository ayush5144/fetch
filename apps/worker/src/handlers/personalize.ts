import { campaigns, db, leads, prompts } from '@fetch/db';
import type { PersonalizeJobData } from '@fetch/core';
import { audit } from '@fetch/core';
import { generateCopy } from '@fetch/personalization';
import { eq } from 'drizzle-orm';

/**
 * personalize handler — generates the per-lead draft for a campaign and writes
 * it back to the lead row as a visible, editable artifact (subject/body), in
 * state `ready` (passed guardrails) or `draft` (flagged for review). Nothing is
 * sent here; a human still previews and approves.
 */
export async function personalizeHandler(data: PersonalizeJobData): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, data.leadId) });
  if (!lead) return;

  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, data.campaignId),
  });
  if (!campaign?.templateId) return; // no template → nothing to generate

  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, campaign.templateId) });
  if (!prompt) return;

  const out = await generateCopy({
    lead,
    template: prompt.body,
    guardrails: prompt.guardrails as any,
    promptVersion: `${prompt.name} v${prompt.version}`,
  });

  await db
    .update(leads)
    .set({
      subject: out.draft.subject,
      body: out.draft.body,
      promptVersion: out.promptVersion,
      approvalStatus: out.approvalStatus,
    })
    .where(eq(leads.id, data.leadId));

  await audit({
    actor: 'system',
    entity: 'lead',
    entityId: data.leadId,
    action: 'personalize',
    diff: { approvalStatus: out.approvalStatus, guardrails: out.guardrails.failures },
  });
}
