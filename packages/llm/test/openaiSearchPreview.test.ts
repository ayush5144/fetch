import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient, isSearchPreviewModel } from '../src/openai';
import type { LLMMessage } from '../src/index';

/**
 * The OpenAI default is now a `*-search-preview` model (web search built into
 * Chat Completions, real cited results). Those models REJECT `temperature` and
 * take search via `web_search_options`, so `chatCompletions` branches on the
 * model name. These tests assert:
 *   - search-preview: NO temperature, HAS web_search_options, NO function tools
 *   - a normal model: unchanged (temperature present, function tools forwarded)
 * Network is mocked; no real API calls.
 */

const MESSAGES: LLMMessage[] = [
  { role: 'user', content: 'Who is the current CEO of Hero MotoCorp?' },
];

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

const OK = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isSearchPreviewModel', () => {
  it('matches the search-preview model ids and nothing else', () => {
    expect(isSearchPreviewModel('gpt-4o-mini-search-preview')).toBe(true);
    expect(isSearchPreviewModel('gpt-4o-search-preview')).toBe(true);
    expect(isSearchPreviewModel('gpt-4o-mini')).toBe(false);
    expect(isSearchPreviewModel('gpt-4.1')).toBe(false);
  });
});

describe('OpenAI chat() with a search-preview model', () => {
  it('omits temperature and sends web_search_options', async () => {
    const getBody = stubFetch(OK);
    await new OpenAIClient('sk-test', 'gpt-4o-mini-search-preview').chat({
      messages: MESSAGES,
      temperature: 0.7,
    });
    const body = getBody();
    expect(body.model).toBe('gpt-4o-mini-search-preview');
    expect('temperature' in body).toBe(false);
    expect(body.web_search_options).toEqual({});
  });

  it('omits response_format even when json is requested (web_search forbids json_object)', async () => {
    const getBody = stubFetch(OK);
    await new OpenAIClient('sk-test', 'gpt-4o-mini-search-preview').chat({
      messages: MESSAGES,
      json: true,
    });
    const body = getBody();
    expect('response_format' in body).toBe(false);
    expect(body.web_search_options).toEqual({});
  });

  it('does not forward function tools (search models use built-in search)', async () => {
    const getBody = stubFetch(OK);
    await new OpenAIClient('sk-test', 'gpt-4o-search-preview').chat({
      messages: MESSAGES,
      tools: [{ name: 'web_search', description: 'x', inputSchema: { type: 'object' } }],
    });
    const body = getBody();
    expect(body.tools).toBeUndefined();
    expect(body.web_search_options).toEqual({});
  });
});

describe('OpenAI chat() with a non-search model is unchanged', () => {
  it('sends temperature, forwards function tools, and no web_search_options', async () => {
    const getBody = stubFetch(OK);
    await new OpenAIClient('sk-test', 'gpt-4.1').chat({
      messages: MESSAGES,
      temperature: 0.5,
      tools: [{ name: 'web_search', description: 'x', inputSchema: { type: 'object' } }],
    });
    const body = getBody();
    expect(body.temperature).toBe(0.5);
    expect(body.web_search_options).toBeUndefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('web_search');
  });

  it('defaults temperature to 0.2 when unspecified', async () => {
    const getBody = stubFetch(OK);
    await new OpenAIClient('sk-test', 'gpt-4o-mini').chat({ messages: MESSAGES });
    const body = getBody();
    expect(body.temperature).toBe(0.2);
  });
});
