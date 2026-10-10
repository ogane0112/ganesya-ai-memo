import type { LlmEndpointConfig } from '../config.js';

export interface Embedder {
  /** Identifier stored with vectors so a model change triggers re-embedding. */
  readonly id: string;
  /** Embedders here always run locally; external embedding is not used. */
  readonly location: 'builtin' | 'local';
  embed(texts: string[]): Promise<Float32Array[]>;
}

const DIM = 512;

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Dependency-free fallback: hashed character n-gram vectors. It captures lexical
 * similarity (works for Japanese without a tokenizer), not deep semantics. Use a
 * local embedding model via Ollama for real semantic search.
 */
export class HashingEmbedder implements Embedder {
  readonly id = `hash-ngram-${DIM}`;
  readonly location = 'builtin' as const;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      const s = t.toLowerCase().replace(/\s+/g, ' ');
      for (let n = 1; n <= 3; n++) {
        for (let i = 0; i + n <= s.length; i++) {
          const gram = s.slice(i, i + n);
          if (gram.trim() === '') continue;
          const h = hash32(gram);
          v[h % DIM]! += (h & 0x80000000 ? -1 : 1) * (n === 1 ? 0.3 : n === 2 ? 0.7 : 1);
        }
      }
      return normalize(v);
    });
  }
}

/** Embeddings from a local Ollama (or OpenAI-compatible local server). */
export class LocalModelEmbedder implements Embedder {
  readonly location = 'local' as const;
  readonly id: string;

  constructor(
    private readonly endpoint: LlmEndpointConfig,
    private readonly model: string,
  ) {
    this.id = `${endpoint.provider}:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.endpoint.provider === 'ollama') {
      const res = await fetch(`${this.endpoint.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) throw new Error(`embedding failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings.map((e) => normalize(Float32Array.from(e)));
    }
    const res = await fetch(`${this.endpoint.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.endpoint.apiKey ? { authorization: `Bearer ${this.endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => normalize(Float32Array.from(d.embedding)));
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}
