import type { Lead } from '@fetch/db';
import { logger } from '@fetch/core';
import { requireLLM, type LLMMessage } from '@fetch/llm';
import { defaultTools, type Tool, toolMap } from './tools';

/**
 * The agentic research loop — the waterfall's fallback. When structured
 * providers all miss, the LLM drives a tool-calling loop (search → scrape →
 * extract) until it finds the field or hits a step/cost ceiling. It never
 * returns prose: the output IS the data — { value, confidence, source }.
 */

export interface AgentResult {
  value: unknown;
  confidence: number;
  source: string | null;
  /** True when the loop hit its ceiling without a confident answer. */
  exhausted: boolean;
}

export interface AgentOptions {
  /** Field/column the agent must fill (e.g. "recent_funding"). */
  field: string;
  /** Operator-authored instruction for an agent column, if any. */
  prompt?: string;
  lead: Lead;
  tools?: Tool[];
  /** Hard cap on tool-use turns, to bound cost and stop runaway loops. */
  maxSteps?: number;
}

const SYSTEM = `You are a precise B2B research agent inside Fetch.
Your job: find ONE specific field about a lead and return it as structured data.
Use the tools to search and read sources. When you have the answer, stop calling
tools and reply with a SINGLE JSON object and nothing else:
{ "value": <the value, or null if truly not found>,
  "confidence": <0..1 how sure you are>,
  "source": "<the URL you got it from, or null>" }
Never guess. If you cannot find it, return value null with low confidence.`;

function leadContext(lead: Lead): string {
  return JSON.stringify({
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
    email: lead.email,
    title: lead.title,
    company_domain: lead.email?.split('@')[1] ?? null,
    linkedin: lead.linkedinUrl,
  });
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const llm = requireLLM();
  const tools = opts.tools ?? defaultTools;
  const tmap = toolMap(tools);
  const maxSteps = opts.maxSteps ?? 6;
  const log = logger.child({ lead_id: opts.lead.id, field: opts.field });

  const task = opts.prompt
    ? `${opts.prompt}\n\nField to return: ${opts.field}`
    : `Find this field for the lead: ${opts.field}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${task}\n\nLead context:\n${leadContext(opts.lead)}` },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const res = await llm.chat({
      messages,
      tools: tools.map((t) => t.def),
      maxTokens: 1024,
    });

    // The model wants to use tools — run them and feed results back in.
    if (res.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: res.text || '(calling tools)' });
      for (const call of res.toolCalls) {
        const tool = tmap.get(call.name);
        const output = tool
          ? await tool.execute(call.input).catch((e) => `tool error: ${String(e)}`)
          : `unknown tool: ${call.name}`;
        log.debug('tool call', { tool: call.name, step });
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
      continue;
    }

    // No tool calls → the model is answering. Parse the structured output.
    const parsed = parseResult(res.text);
    if (parsed) {
      log.info('agent resolved field', { confidence: parsed.confidence, step });
      return { ...parsed, exhausted: false };
    }
    // Couldn't parse — nudge once more, then give up at the step limit.
    messages.push({
      role: 'user',
      content: 'Reply with ONLY the JSON object described in the instructions.',
    });
  }

  log.warn('agent hit step limit without a confident answer');
  return { value: null, confidence: 0, source: null, exhausted: true };
}

/** Extract the single JSON object from the model's final message. */
function parseResult(text: string): { value: unknown; confidence: number; source: string | null } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return {
      value: obj.value ?? null,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
      source: obj.source ?? null,
    };
  } catch {
    return null;
  }
}
