import { z } from 'zod';

/**
 * Centralized, validated environment access. The app reads config through this
 * module instead of poking `process.env` directly, so a missing or malformed
 * required var fails fast at boot with a clear message — not deep inside a
 * worker three minutes later.
 *
 * Only DATABASE_URL is truly required to boot (one Postgres + the app). The
 * rest are optional and unlock a capability; helpers below report what's wired.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().default(4000),
  NEXT_PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  WORKER_CONCURRENCY: z.coerce.number().default(4),

  // Optional API bearer token. When unset the API is open (single-tenant
  // self-host default); when set, data routes require it.
  FETCH_API_TOKEN: z.string().optional(),

  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'gemini', 'grok']).default('anthropic'),
  LLM_MODEL: z.string().default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROK_API_KEY: z.string().optional(),

  APOLLO_API_KEY: z.string().optional(),
  HUNTER_API_KEY: z.string().optional(),
  FINDYMAIL_API_KEY: z.string().optional(),
  DROPCONTACT_API_KEY: z.string().optional(),

  SERPER_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),

  REACHER_URL: z.string().optional(),

  INSTANTLY_API_KEY: z.string().optional(),
  INSTANTLY_WEBHOOK_SECRET: z.string().optional(),
  SMARTLEAD_API_KEY: z.string().optional(),
  SMARTLEAD_WEBHOOK_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Parse and cache the environment. Throws a readable error if invalid. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when a given capability has the keys it needs to actually run. */
export function isConfigured(capability: 'llm' | 'instantly' | 'smartlead' | 'reacher'): boolean {
  const env = getEnv();
  switch (capability) {
    case 'llm':
      return Boolean(
        env.LLM_PROVIDER === 'anthropic'
          ? env.ANTHROPIC_API_KEY
          : env.LLM_PROVIDER === 'openai'
            ? env.OPENAI_API_KEY
            : env.LLM_PROVIDER === 'gemini'
              ? env.GEMINI_API_KEY
              : env.GROK_API_KEY,
      );
    case 'instantly':
      return Boolean(env.INSTANTLY_API_KEY);
    case 'smartlead':
      return Boolean(env.SMARTLEAD_API_KEY);
    case 'reacher':
      return Boolean(env.REACHER_URL);
  }
}
