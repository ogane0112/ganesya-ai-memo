/** Limits attempts per key (client address + endpoint) to slow down guessing. */
export interface RateLimiter {
  /** true = allowed. */
  allow(key: string): Promise<boolean>;
}

/** Cloudflare Workers Rate Limiting binding (configured in cloudflare.config.ts). */
export interface WorkersRateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export function workersRateLimiter(binding: WorkersRateLimitBinding): RateLimiter {
  return {
    async allow(key) {
      try {
        return (await binding.limit({ key })).success;
      } catch {
        return true; // never lock everyone out because the limiter failed
      }
    },
  };
}

/** In-process fixed window (Node). */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async allow(key: string): Promise<boolean> {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) {
        for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
      }
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
