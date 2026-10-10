/**
 * Runtime-neutral configuration. Built from a plain environment record so the
 * same code works with `process.env` (Node) and the Workers `env` binding.
 */
export interface LlmEndpointConfig {
  /** `ollama`, `openai` (any OpenAI-compatible API) or `anthropic`. */
  provider: 'ollama' | 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type SignupMode = 'open' | 'invite' | 'closed';

export interface Config {
  /** Public origin, e.g. https://notes.example.com. Required for passkeys. */
  origin: string;
  /** WebAuthn relying-party id (the domain). */
  rpId: string;
  rpName: string;
  /** Who may create an account once the first (admin) account exists. */
  signup: SignupMode;
  /**
   * Token required to create the first account. On Workers it comes from the
   * GMEMO_SETUP_TOKEN secret; on Node one is generated and printed when unset.
   */
  setupToken?: string;
  /** Encrypts GitHub tokens at rest. Required for GitHub storage. */
  secretKey?: string;
  sessionDays: number;
  accessTokenMinutes: number;
  /** Seconds between checks for commits pushed to a GitHub repo from elsewhere. */
  githubCheckSeconds: number;
  githubApiBase: string;
  llm: {
    local?: LlmEndpointConfig;
    external?: LlmEndpointConfig;
    /** Embedding model served by the local endpoint; empty = built-in hashing embedder. */
    localEmbedModel?: string;
  };
  /** Allow non-HTTPS origins and http calendar URLs (development only). */
  insecureDev: boolean;
  /** IANA time zone for dates without an offset (note dates, floating calendar times). */
  timeZone: string;
}

export type EnvRecord = Record<string, string | undefined>;

export function configFromEnv(envRec: EnvRecord, overrides: Partial<Config> = {}): Config {
  const env = (name: string): string | undefined => {
    const v = envRec[name];
    return v === undefined || v === '' ? undefined : v;
  };
  const origin = (env('GMEMO_ORIGIN') ?? 'http://localhost:8787').replace(/\/+$/, '');
  const rpId = env('GMEMO_RP_ID') ?? new URL(origin).hostname;

  const localUrl = env('GMEMO_LOCAL_LLM_URL');
  const externalProvider = env('GMEMO_EXTERNAL_LLM_PROVIDER') as
    LlmEndpointConfig['provider'] | undefined;
  const local: LlmEndpointConfig | undefined = localUrl
    ? {
        provider:
          (env('GMEMO_LOCAL_LLM_PROVIDER') as LlmEndpointConfig['provider'] | undefined) ??
          'ollama',
        baseUrl: localUrl.replace(/\/+$/, ''),
        model: env('GMEMO_LOCAL_LLM_MODEL') ?? 'qwen2.5:7b',
        ...(env('GMEMO_LOCAL_LLM_API_KEY') ? { apiKey: env('GMEMO_LOCAL_LLM_API_KEY')! } : {}),
      }
    : undefined;
  const external: LlmEndpointConfig | undefined = externalProvider
    ? {
        provider: externalProvider,
        baseUrl: (
          env('GMEMO_EXTERNAL_LLM_URL') ??
          (externalProvider === 'anthropic'
            ? 'https://api.anthropic.com'
            : 'https://api.openai.com/v1')
        ).replace(/\/+$/, ''),
        model:
          env('GMEMO_EXTERNAL_LLM_MODEL') ??
          (externalProvider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1-mini'),
        ...(env('GMEMO_EXTERNAL_LLM_API_KEY')
          ? { apiKey: env('GMEMO_EXTERNAL_LLM_API_KEY')! }
          : {}),
      }
    : undefined;

  const signup = env('GMEMO_SIGNUP');
  return {
    origin,
    rpId,
    rpName: env('GMEMO_RP_NAME') ?? 'Ganesya AI Memo',
    signup: signup === 'open' || signup === 'closed' ? signup : 'invite',
    ...(env('GMEMO_SETUP_TOKEN') ? { setupToken: env('GMEMO_SETUP_TOKEN')! } : {}),
    ...(env('GMEMO_SECRET_KEY') ? { secretKey: env('GMEMO_SECRET_KEY')! } : {}),
    sessionDays: Number(env('GMEMO_SESSION_DAYS') ?? 30),
    accessTokenMinutes: Number(env('GMEMO_ACCESS_TOKEN_MINUTES') ?? 60),
    githubCheckSeconds: Number(env('GMEMO_GITHUB_CHECK_SECONDS') ?? 30),
    githubApiBase: (env('GMEMO_GITHUB_API') ?? 'https://api.github.com').replace(/\/+$/, ''),
    llm: {
      ...(local ? { local } : {}),
      ...(external ? { external } : {}),
      ...(env('GMEMO_LOCAL_EMBED_MODEL')
        ? { localEmbedModel: env('GMEMO_LOCAL_EMBED_MODEL')! }
        : {}),
    },
    insecureDev: env('GMEMO_INSECURE_DEV') === '1',
    timeZone: env('GMEMO_TIMEZONE') ?? env('TZ') ?? 'Asia/Tokyo',
    ...overrides,
  };
}

/** Problems that would make passkeys fail; printed at startup. */
export function configWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  const url = new URL(cfg.origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !cfg.insecureDev) {
    warnings.push(
      `GMEMO_ORIGIN (${cfg.origin}) is not HTTPS. Passkeys only work over HTTPS (or on localhost).`,
    );
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) {
    warnings.push('Passkeys cannot be bound to an IP address. Use a domain name for GMEMO_ORIGIN.');
  }
  if (!url.hostname.endsWith(cfg.rpId)) {
    warnings.push(`GMEMO_RP_ID (${cfg.rpId}) must be the origin's host or a parent domain of it.`);
  }
  if (!cfg.secretKey) {
    warnings.push('GMEMO_SECRET_KEY is not set: connecting a GitHub repository is disabled.');
  }
  return warnings;
}
