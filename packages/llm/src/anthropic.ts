import type { ChatOptions, LLMClient, LLMResponse, ToolCall } from './types';

/**
 * Anthropic Messages API client over native fetch (no SDK dependency, to keep
 * the package lean and the boundary thin). Translates our provider-agnostic
 * shape to/from Anthropic's blocks-and-tools format.
 */
export class AnthropicClient implements LLMClient {
  readonly provider = 'anthropic';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = opts.messages.find((m) => m.role === 'system')?.content;
    const messages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            content: [
              { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content },
            ],
          };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
      messages,
    };
    if (system) body.system = opts.json ? `${system}\nRespond with JSON only.` : system;
    const tools: Record<string, unknown>[] = (opts.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    // Native web search: Anthropic's server-side tool. Results come back in the
    // response content; we don't execute it ourselves.
    if (opts.webSearch === 'native') {
      tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
    }
    if (tools.length) body.tools = tools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as any;

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      stopReason:
        data.stop_reason === 'tool_use'
          ? 'tool_use'
          : data.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : data.stop_reason === 'end_turn'
              ? 'end'
              : 'other',
    };
  }
}
