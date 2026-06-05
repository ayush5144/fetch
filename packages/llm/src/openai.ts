import type { ChatOptions, LLMClient, LLMResponse, ToolCall } from './types';

/**
 * OpenAI Chat Completions client over native fetch. Mirrors AnthropicClient so
 * the agent loop and personalization don't care which provider is configured.
 */
export class OpenAIClient implements LLMClient {
  readonly provider = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async chat(opts: ChatOptions): Promise<LLMResponse> {
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
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
