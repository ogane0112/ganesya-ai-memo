import type { LlmEndpointConfig } from '../config.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Ask for a JSON object response where supported. */
  json?: boolean;
}

export interface LlmClient {
  readonly location: 'local' | 'external';
  readonly label: string;
  chat(req: ChatRequest): Promise<string>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function createLlmClient(cfg: LlmEndpointConfig, location: 'local' | 'external'): LlmClient {
  const label = `${cfg.provider}:${cfg.model}`;
  switch (cfg.provider) {
    case 'ollama':
      return {
        location,
        label,
        async chat(req) {
          const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
          const json = (await postJson(`${cfg.baseUrl}/api/chat`, {}, {
            model: cfg.model,
            messages,
            stream: false,
            ...(req.json ? { format: 'json' } : {}),
            options: { num_predict: req.maxTokens ?? 1024 },
          })) as { message?: { content?: string } };
          return json.message?.content ?? '';
        },
      };
    case 'openai':
      return {
        location,
        label,
        async chat(req) {
          const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
          const json = (await postJson(
            `${cfg.baseUrl}/chat/completions`,
            cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
            { model: cfg.model, messages, max_tokens: req.maxTokens ?? 1024, ...(req.json ? { response_format: { type: 'json_object' } } : {}) },
          )) as { choices?: { message?: { content?: string } }[] };
          return json.choices?.[0]?.message?.content ?? '';
        },
      };
    case 'anthropic':
      return {
        location,
        label,
        async chat(req) {
          const json = (await postJson(
            `${cfg.baseUrl}/v1/messages`,
            { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
            { model: cfg.model, max_tokens: req.maxTokens ?? 1024, ...(req.system ? { system: req.system } : {}), messages: req.messages },
          )) as { content?: { type: string; text?: string }[] };
          return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        },
      };
  }
}

/** Extract the first JSON object from a model response. */
export function parseJsonLoose(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
