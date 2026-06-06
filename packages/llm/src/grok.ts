import { parseResponses, responsesBody, toChatMessage } from './openai';
import type { ChatOptions, LLMClient, LLMResponse, ToolCall } from './types';

/**
 * Grok (xAI) client over native fetch. xAI ships an OpenAI-compatible Responses
 * API, so we reuse the same request/response helpers as OpenAIClient. Native web
 * search attaches xAI's `web_search` tool; the answer comes back as text.
 *
 * Function tool-calling (our research loop's own tools) goes through xAI's
 * Chat Completions endpoint, which is OpenAI-shaped.
 */
export class GrokClient implements LLMClient {
  readonly provider = 'grok';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    if (opts.webSearch === 'native') return this.responses(opts);
    return this.chatCompletions(opts);
  }

  private async responses(opts: ChatOptions): Promise<LLMResponse> {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(responsesBody(this.model, opts, { type: 'web_search' })),
    });
    if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
    return parseResponses((await res.json()) as any);
  }

  private async chatCompletions(opts: ChatOptions): Promise<LLMResponse> {
    const messages = opts.messages.map(toChatMessage);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      input: safeParse(c.function.arguments),
    }));

    return {
      text: choice?.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      stopReason:
        choice?.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice?.finish_reason === 'length'
            ? 'max_tokens'
            : choice?.finish_reason === 'stop'
              ? 'end'
              : 'other',
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
