import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../src/anthropic';
import { OpenAIClient } from '../src/openai';
import { GeminiClient } from '../src/gemini';
import { GrokClient } from '../src/grok';
import type { LLMMessage } from '../src/index';

/**
 * The multi-step tool-calling loop (Dogi research): the assistant turn that MADE
 * a tool call must be replayed WITH its tool_calls, so the following tool-result
 * message references a live id. These tests build a step-2 conversation
 *   system + user → assistant(toolCall) → tool(result)
 * and assert the SERIALIZED request body carries the call AND its matching
 * result, referencing the same id. Regression guard for the OpenAI 400:
 * "messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'".
 */

const CALL_ID = 'call_abc123';

const STEP2: LLMMessage[] = [
  { role: 'system', content: 'You are a research agent.' },
  { role: 'user', content: 'Find the CEO of Hero MotoCorp.' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: CALL_ID, name: 'web_search', input: { query: 'Hero MotoCorp CEO' } }],
  },
  { role: 'tool', content: 'Pawan Munjal is the chairman; CEO is Niranjan Gupta.', toolCallId: CALL_ID },
];

/** Capture the JSON body of the single fetch the client makes, then return a
 * minimal valid provider response so the client doesn't throw. */
function stubFetch(responseBody: unknown): () => any {
  const captured: { body?: any } = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      captured.body = JSON.parse(init.body);
      return { ok: true, json: async () => responseBody };
    }),
  );
  return () => captured.body;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenAI tool-call replay', () => {
  it('serializes the assistant tool_calls and a tool message with the matching id', async () => {
    const getBody = stubFetch({
      choices: [{ message: { content: '{"value":"Niranjan Gupta","confidence":0.9,"source":null}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await new OpenAIClient('sk-test', 'gpt-4.1').chat({ messages: STEP2 });
    const body = getBody();

    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe(CALL_ID);
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('web_search');
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ query: 'Hero MotoCorp CEO' });

    const tool = body.messages.find((m: any) => m.role === 'tool');
    expect(tool.tool_call_id).toBe(CALL_ID);
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });
});

describe('Grok tool-call replay', () => {
  it('serializes the assistant tool_calls and a tool message with the matching id', async () => {
    const getBody = stubFetch({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await new GrokClient('xai-test', 'grok-4').chat({ messages: STEP2 });
    const body = getBody();

    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls[0].id).toBe(CALL_ID);
    const tool = body.messages.find((m: any) => m.role === 'tool');
    expect(tool.tool_call_id).toBe(CALL_ID);
  });
});

describe('Anthropic tool-call replay', () => {
  it('replays the assistant turn as a tool_use block matched by a tool_result', async () => {
    const getBody = stubFetch({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicClient('sk-ant', 'claude-opus-4-8').chat({ messages: STEP2 });
    const body = getBody();

    const assistant = body.messages.find((m: any) => m.role === 'assistant' && Array.isArray(m.content));
    const toolUse = assistant.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.id).toBe(CALL_ID);
    expect(toolUse.name).toBe('web_search');
    expect(toolUse.input).toEqual({ query: 'Hero MotoCorp CEO' });

    // The tool result rides on a following user message, referencing the same id.
    const resultMsg = body.messages.find(
      (m: any) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result'),
    );
    const result = resultMsg.content.find((b: any) => b.type === 'tool_result');
    expect(result.tool_use_id).toBe(CALL_ID);
  });
});

describe('Gemini tool-call replay', () => {
  it('replays a functionCall part matched by a functionResponse keyed on the name', async () => {
    const getBody = stubFetch({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    await new GeminiClient('g-test', 'gemini-2.5-flash').chat({ messages: STEP2 });
    const body = getBody();

    const modelTurn = body.contents.find(
      (c: any) => c.role === 'model' && c.parts.some((p: any) => p.functionCall),
    );
    const fc = modelTurn.parts.find((p: any) => p.functionCall).functionCall;
    expect(fc.name).toBe('web_search');
    expect(fc.args).toEqual({ query: 'Hero MotoCorp CEO' });

    const respTurn = body.contents.find(
      (c: any) => c.role === 'user' && c.parts.some((p: any) => p.functionResponse),
    );
    const fr = respTurn.parts.find((p: any) => p.functionResponse).functionResponse;
    // Gemini matches results to calls by name; it must equal the call's name.
    expect(fr.name).toBe('web_search');
    expect(fr.response).toBeDefined();
  });
});
