/**
 * Provider-agnostic LLM contract. The rest of Fetch talks to *this* interface,
 * never to Anthropic or OpenAI directly, so the model is a swap behind one
 * boundary (locked decision: not married to one LLM).
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMMessage {
  role: Role;
  content: string;
  /** Present on `tool` messages: which tool call this result answers. */
  toolCallId?: string;
}

/** A tool the model may call, described with a JSON-Schema input shape. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation the model asked for. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  /** Assistant text, if any. */
  text: string;
  /** Tool calls the model wants run before it can continue. */
  toolCalls: ToolCall[];
  /** Rough token accounting for cost ceilings. */
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
}

export interface ChatOptions {
  messages: LLMMessage[];
  tools?: ToolDef[];
  /** Force JSON-only output (used for structured extraction). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * Attach the provider's OWN web-search tool so the model can search the web
   * itself ("native" web search source). Each client maps this to its vendor
   * payload (Anthropic `web_search_20250305`, OpenAI/Grok `web_search`, Gemini
   * `googleSearch`). When set, the model may answer from live search results
   * without us running a separate Serper tool.
   */
  webSearch?: 'native';
}

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  chat(opts: ChatOptions): Promise<LLMResponse>;
}
