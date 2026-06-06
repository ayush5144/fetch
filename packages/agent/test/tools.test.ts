import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase J · Round 3 — web_search / scrape_url backend selection.
 *
 * Pure unit tests with a mocked getEnv() and a mocked global fetch. They prove:
 *  - backend precedence by env for BOTH tools (OpenSERP > Serper > unavailable;
 *    Firecrawl-url > Firecrawl-key > unavailable),
 *  - OpenSERP {results:[{title,url,snippet}]} normalizes to the existing
 *    {title,link,snippet}[] shape, and
 *  - OpenSERP error JSON (e.g. captcha_detected) → a clear, non-fatal message.
 *
 * getEnv() is mocked (not stubEnv) so each test sets exactly the env it needs;
 * the tools read getEnv() at execute() time, so no module-cache concern.
 */
const { getEnv } = vi.hoisted(() => ({ getEnv: vi.fn() }));
vi.mock('@fetch/core', () => ({ getEnv }));

import { scrapeUrl, webSearch } from '../src/tools';

/** Build a fetch mock that returns one JSON body (status 200 by default). */
function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  getEnv.mockReset();
});

describe('web_search backend selection', () => {
  it('uses OpenSERP when OPENSERP_URL is set, and normalizes results', async () => {
    getEnv.mockReturnValue({ OPENSERP_URL: 'http://localhost:7001', OPENSERP_ENGINE: 'yandex' });
    const fetchMock = mockFetchJson({
      results: [
        { title: 'Hero MotoCorp', url: 'https://www.linkedin.com/in/ceo', snippet: 'CEO profile' },
        { title: 'About', url: 'https://heromotocorp.com', snippet: 'Company site' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch.execute({ query: 'Hero MotoCorp CEO LinkedIn' });

    // Hits the {engine}/search endpoint with the query, lang, limit.
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('http://localhost:7001/yandex/search');
    expect(calledUrl).toContain('text=Hero%20MotoCorp%20CEO%20LinkedIn');
    expect(calledUrl).toContain('lang=EN');
    expect(calledUrl).toContain('limit=5');

    // Normalized to the existing {title, link, snippet}[] shape.
    expect(JSON.parse(out)).toEqual([
      { title: 'Hero MotoCorp', link: 'https://www.linkedin.com/in/ceo', snippet: 'CEO profile' },
      { title: 'About', link: 'https://heromotocorp.com', snippet: 'Company site' },
    ]);
  });

  it('defaults the OpenSERP engine to google when OPENSERP_ENGINE is unset', async () => {
    getEnv.mockReturnValue({ OPENSERP_URL: 'http://localhost:7001' });
    const fetchMock = mockFetchJson({ results: [{ title: 'x', url: 'https://x.com', snippet: 's' }] });
    vi.stubGlobal('fetch', fetchMock);

    await webSearch.execute({ query: 'q' });
    expect(fetchMock.mock.calls[0][0]).toContain('/google/search');
  });

  it('returns a clear, non-fatal message on OpenSERP error JSON (captcha)', async () => {
    getEnv.mockReturnValue({ OPENSERP_URL: 'http://localhost:7001', OPENSERP_ENGINE: 'google' });
    vi.stubGlobal('fetch', mockFetchJson({ error: 'captcha_detected' }));

    const out = await webSearch.execute({ query: 'q' });
    expect(out).toContain('web_search unavailable');
    expect(out).toContain('captcha_detected');
  });

  it('falls back to Serper when only SERPER_API_KEY is set', async () => {
    getEnv.mockReturnValue({ SERPER_API_KEY: 'sk-123' });
    const fetchMock = mockFetchJson({
      organic: [{ title: 'T', link: 'https://t.com', snippet: 'S' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch.execute({ query: 'q' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.serper.dev/search');
    expect(JSON.parse(out)).toEqual([{ title: 'T', link: 'https://t.com', snippet: 'S' }]);
  });

  it('prefers OpenSERP over Serper when both are set', async () => {
    getEnv.mockReturnValue({ OPENSERP_URL: 'http://localhost:7001', SERPER_API_KEY: 'sk-123' });
    const fetchMock = mockFetchJson({ results: [{ title: 'a', url: 'https://a.com', snippet: 's' }] });
    vi.stubGlobal('fetch', fetchMock);

    await webSearch.execute({ query: 'q' });
    expect(fetchMock.mock.calls[0][0]).toContain('/google/search');
  });

  it('returns "unavailable" when no backend is configured', async () => {
    getEnv.mockReturnValue({});
    const fetchMock = mockFetchJson({});
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch.execute({ query: 'q' });
    expect(out).toContain('web_search unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('scrape_url backend selection', () => {
  it('uses self-hosted Firecrawl (no key) when FIRECRAWL_API_URL is set', async () => {
    getEnv.mockReturnValue({ FIRECRAWL_API_URL: 'http://localhost:3002' });
    const fetchMock = mockFetchJson({ data: { markdown: '# Hello' } });
    vi.stubGlobal('fetch', fetchMock);

    const out = await scrapeUrl.execute({ url: 'https://x.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3002/v1/scrape');
    // No bearer header when no key is set.
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.authorization).toBeUndefined();
    expect(out).toBe('# Hello');
  });

  it('includes a bearer for a secured self-host when FIRECRAWL_API_KEY is also set', async () => {
    getEnv.mockReturnValue({ FIRECRAWL_API_URL: 'http://localhost:3002', FIRECRAWL_API_KEY: 'fc-1' });
    const fetchMock = mockFetchJson({ data: { markdown: 'ok' } });
    vi.stubGlobal('fetch', fetchMock);

    await scrapeUrl.execute({ url: 'https://x.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3002/v1/scrape');
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.authorization).toBe('Bearer fc-1');
  });

  it('falls back to hosted Firecrawl when only FIRECRAWL_API_KEY is set', async () => {
    getEnv.mockReturnValue({ FIRECRAWL_API_KEY: 'fc-1' });
    const fetchMock = mockFetchJson({ data: { markdown: 'ok' } });
    vi.stubGlobal('fetch', fetchMock);

    await scrapeUrl.execute({ url: 'https://x.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.firecrawl.dev/v1/scrape');
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.authorization).toBe('Bearer fc-1');
  });

  it('prefers the self-hosted URL over the hosted key when both are set', async () => {
    getEnv.mockReturnValue({ FIRECRAWL_API_URL: 'http://localhost:3002', FIRECRAWL_API_KEY: 'fc-1' });
    const fetchMock = mockFetchJson({ data: { markdown: 'ok' } });
    vi.stubGlobal('fetch', fetchMock);

    await scrapeUrl.execute({ url: 'https://x.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3002/v1/scrape');
  });

  it('returns "unavailable" when no scrape backend is configured', async () => {
    getEnv.mockReturnValue({});
    const fetchMock = mockFetchJson({});
    vi.stubGlobal('fetch', fetchMock);

    const out = await scrapeUrl.execute({ url: 'https://x.com' });
    expect(out).toContain('scrape_url unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
