import type { Lead } from '@fetch/db';
import { requireLLM } from '@fetch/llm';
import { bindTemplate, buildVariables } from './bind';
import { checkGuardrails, type Draft, type Guardrails, type GuardrailResult } from './guardrails';

/**
 * Generate personalized copy for one lead from a campaign template. The bound
 * template seeds the LLM with the lead's real, enriched context; the model
 * returns { subject, body }, which is checked against guardrails. The result is
 * written back to the lead row as a visible, editable artifact — never an
 * invisible step.
 */

export interface GenerateInput {
  lead: Lead;
  /** Template body with {{variables}}, from the campaign's prompt. */
  template: string;
  guardrails?: Guardrails;
  promptVersion?: string;
}

export interface GenerateOutput {
  draft: Draft;
  guardrails: GuardrailResult;
  promptVersion: string;
  /** Resulting approval state: `ready` on pass, `draft` (flagged) on fail. */
  approvalStatus: 'ready' | 'draft';
}

const SYSTEM = `You write concise, specific B2B cold outreach.
Given a lead's context and a template, produce a personalized email.
Return ONLY a JSON object: { "subject": "...", "body": "..." }.
Keep it human, specific, and free of generic filler or unverifiable claims.`;

export async function generateCopy(input: GenerateInput): Promise<GenerateOutput> {
  const llm = requireLLM();
  const vars = buildVariables(input.lead);
  const bound = bindTemplate(input.template, vars);
  const guardrails = input.guardrails ?? {};

  const res = await llm.chat({
    json: true,
    maxTokens: 800,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Lead context:\n${JSON.stringify(vars)}\n\nTemplate / brief:\n${bound.text}`,
      },
    ],
  });

  const draft = parseDraft(res.text);
  const check = checkGuardrails(draft, guardrails, bound.missing);

  return {
    draft,
    guardrails: check,
    promptVersion: input.promptVersion ?? 'v1',
    approvalStatus: check.pass ? 'ready' : 'draft',
  };
}

function parseDraft(text: string): Draft {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      return { subject: String(obj.subject ?? ''), body: String(obj.body ?? '') };
    } catch {
      /* fall through */
    }
  }
  return { subject: '', body: text.trim() };
}
