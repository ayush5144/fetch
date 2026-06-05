import type { ChatOptions, LLMClient, LLMResponse, ToolCall } from './types';

/**
 * OpenAI client over native fetch. Mirrors AnthropicClient so the agent loop and
 * personalization don't care which provider is configured.
 *
 * Two request shapes:
 *  - default → Chat Completions (supports our function tool-calling loop).
 *  - `webSearch: 'native'` → the Responses API, which carries OpenAI's hosted
 *    `web_search` tool. Native search is a one-shot answer (no function-call
 *    round-trip), so we read the final text out of `output`.
 */
export class OpenAIClient implements LLMClient {
  readonly provider = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    if (opts.webSearch === 'native') return this.responses(opts);
    return this.chatCompletions(opts);
  }

  private async chatCompletions(opts: ChatOptions): Promise<LLMResponse> {
    const messages = opts.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId };
      }
      return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
    });

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

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    }
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

  /** Responses API path — used for native web search. */
  private async responses(opts: ChatOptions): Promise<LLMResponse> {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(responsesBody(this.model, opts, { type: 'web_search' })),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    }
    return parseResponses((await res.json()) as any);
  }
}

/**
 * Build a Responses-API request body from our provider-agnostic ChatOptions.
 * Shared by OpenAI and Grok (xAI's Responses API is OpenAI-compatible).
 */
export function responsesBody(
  model: string,
  opts: ChatOptions,
  searchTool: Record<string, unknown>,
): Record<string, unknown> {
  const instructions = opts.messages.find((m) => m.role === 'system')?.content;
  const input = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'tool' ? 'user' : (m.role as 'user' | 'assistant'),
      content: m.content,
    }));
  const body: Record<string, unknown> = { model, input };
  if (instructions) {
    body.instructions = opts.json ? `${instructions}\nRespond with JSON only.` : instructions;
  }
  if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
  if (opts.webSearch === 'native') body.tools = [searchTool];
  return body;
}

/** Parse a Responses-API result (OpenAI/Grok) into our LLMResponse shape. */
export function parseResponses(data: any): LLMResponse {
  let text = '';
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text') text += block.text ?? '';
        }
      }
    }
  }
  // Some responses expose the joined text directly.
  if (!text && typeof data.output_text === 'string') text = data.output_text;
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
    stopReason: 'end',
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
