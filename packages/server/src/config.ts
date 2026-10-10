import { join, resolve } from 'node:path';

export interface LlmEndpointConfig {
  /** `ollama`, `openai` (any OpenAI-compatible API) or `anthropic`. */
  provider: 'ollama' | 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface Config {
  dataDir: string;
  notesDir: string;
  appDbFile: string;
  indexDbFile: string;
  pluginsDir: string;
  port: number;
  host: string;
  /** Public origin, e.g. https://notes.example.com. Required for passkeys. */
  origin: string;
  /** WebAuthn relying-party id (the domain). */
  rpId: string;
  rpName: string;
  /** Directory with the built web app (served statically when present). */
  webDir: string;
  /** Seconds between scans for edits made outside the app (0 disables). */
  externalScanSeconds: number;
  sessionDays: number;
  accessTokenMinutes: number;
  llm: {
    local?: LlmEndpointConfig;
    external?: LlmEndpointConfig;
    /** Embedding model served by the local endpoint; empty = built-in hashing embedder. */
    localEmbedModel?: string;
  };
  /** Allow non-HTTPS origins (development only). */
  insecureDev: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(overrides.dataDir ?? env('GMEMO_DATA_DIR') ?? './data');
  const port = Number(env('GMEMO_PORT') ?? 8787);
  const origin = (env('GMEMO_ORIGIN') ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const rpId = env('GMEMO_RP_ID') ?? new URL(origin).hostname;

  const localUrl = env('GMEMO_LOCAL_LLM_URL');
  const externalProvider = env('GMEMO_EXTERNAL_LLM_PROVIDER') as LlmEndpointConfig['provider'] | undefined;
  const local: LlmEndpointConfig | undefined = localUrl
    ? {
        provider: (env('GMEMO_LOCAL_LLM_PROVIDER') as LlmEndpointConfig['provider'] | undefined) ?? 'ollama',
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
          (externalProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
        ).replace(/\/+$/, ''),
        model: env('GMEMO_EXTERNAL_LLM_MODEL') ?? (externalProvider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1-mini'),
        ...(env('GMEMO_EXTERNAL_LLM_API_KEY') ? { apiKey: env('GMEMO_EXTERNAL_LLM_API_KEY')! } : {}),
      }
    : undefined;

  const cfg: Config = {
    dataDir,
    notesDir: join(dataDir, 'notes'),
    appDbFile: join(dataDir, 'app.db'),
    indexDbFile: join(dataDir, 'index.db'),
    pluginsDir: env('GMEMO_PLUGINS_DIR') ?? join(dataDir, 'plugins'),
    port,
    host: env('GMEMO_HOST') ?? '0.0.0.0',
    origin,
    rpId,
    rpName: env('GMEMO_RP_NAME') ?? 'Ganesya AI Memo',
    webDir: env('GMEMO_WEB_DIR') ?? resolve(import.meta.dirname, '../../web/dist'),
    externalScanSeconds: Number(env('GMEMO_EXTERNAL_SCAN_SECONDS') ?? 15),
    sessionDays: Number(env('GMEMO_SESSION_DAYS') ?? 30),
    accessTokenMinutes: Number(env('GMEMO_ACCESS_TOKEN_MINUTES') ?? 60),
    llm: {
      ...(local ? { local } : {}),
      ...(external ? { external } : {}),
      ...(env('GMEMO_LOCAL_EMBED_MODEL') ? { localEmbedModel: env('GMEMO_LOCAL_EMBED_MODEL')! } : {}),
    },
    insecureDev: env('GMEMO_INSECURE_DEV') === '1',
    ...overrides,
  };
  return cfg;
}

/** Problems that would make passkeys fail; printed at startup. */
export function configWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  const url = new URL(cfg.origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !cfg.insecureDev) {
    warnings.push(`GMEMO_ORIGIN (${cfg.origin}) is not HTTPS. Passkeys only work over HTTPS (or on localhost).`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) {
    warnings.push('Passkeys cannot be bound to an IP address. Use a domain name for GMEMO_ORIGIN.');
  }
  if (!url.hostname.endsWith(cfg.rpId)) {
    warnings.push(`GMEMO_RP_ID (${cfg.rpId}) must be the origin's host or a parent domain of it.`);
  }
  return warnings;
}
