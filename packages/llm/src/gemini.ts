import type { ChatOptions, LLMClient, LLMResponse, ToolCall } from './types';

/**
 * Gemini (Google) client over the Generative Language REST API (no SDK). Maps
 * our provider-agnostic shape to Gemini's `contents`/`parts` format.
 *
 * - system prompt → `systemInstruction`
 * - function tools → `tools[].functionDeclarations`; calls come back as
 *   `functionCall` parts and we surface them as ToolCalls for the loop.
 * - native web search → `tools: [{ googleSearch: {} }]` (grounding).
 *
 * Note: Gemini rejects mixing `googleSearch` grounding with functionDeclarations
 * in the same request, so native search takes precedence when both are asked.
 */
export class GeminiClient implements LLMClient {
  readonly provider = 'gemini';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    const system = opts.messages.find((m) => m.role === 'system')?.content;

    // Gemini roles: 'user' and 'model'. An assistant turn that called tools
    // becomes `functionCall` parts; each tool result becomes a `functionResponse`
    // part (role 'user'). Gemini keys responses by function NAME, not id, so we
    // resolve each tool message's name from the matching call id.
    const nameById = new Map<string, string>();
    for (const m of opts.messages) {
      for (const tc of m.toolCalls ?? []) nameById.set(tc.id, tc.name);
    }
    const contents = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          const name = (m.toolCallId && nameById.get(m.toolCallId)) || 'tool';
          return {
            role: 'user' as const,
            parts: [
              { functionResponse: { name, response: { result: m.content } } },
            ],
          };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          const parts: Record<string, unknown>[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.input } });
          }
          return { role: 'model' as const, parts };
        }
        return {
          role: (m.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
          parts: [{ text: m.content }],
        };
      });

    const body: Record<string, unknown> = { contents };
    if (system) {
      const text = opts.json ? `${system}\nRespond with JSON only.` : system;
      body.systemInstruction = { parts: [{ text }] };
    }
    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens ?? 1024,
    };
    if (opts.json) generationConfig.responseMimeType = 'application/json';
    body.generationConfig = generationConfig;

    if (opts.webSearch === 'native') {
      body.tools = [{ googleSearch: {} }];
    } else if (opts.tools?.length) {
      body.tools = [
        {
          functionDeclarations: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;

    const candidate = data.candidates?.[0];
    let text = '';
    const toolCalls: ToolCall[] = [];
    let callIdx = 0;
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string') text += part.text;
      else if (part.functionCall) {
        toolCalls.push({
          id: `gemini-call-${callIdx++}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      stopReason:
        toolCalls.length > 0
          ? 'tool_use'
          : candidate?.finishReason === 'MAX_TOKENS'
            ? 'max_tokens'
            : candidate?.finishReason === 'STOP'
              ? 'end'
              : 'other',
    };
  }
}
