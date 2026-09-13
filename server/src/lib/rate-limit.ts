/** Small in-memory fixed-window rate limiter. Good enough for login/enroll on a single node. */
export interface RateLimiter {
  check(key: string): { ok: boolean; retryAfterSeconds: number };
  reset(key: string): void;
  /** Seconds until `key` is under its limit again, without counting a hit; 0 when it already is. */
  retryAfter(key: string): number;
}

export function createRateLimiter(
  { windowMs, max }: { windowMs: number; max: number },
): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  const sweep = () => {
    const now = Date.now();
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  };

  return {
    check(key) {
      sweep();
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, retryAfterSeconds: 0 };
      }
      entry.count++;
      if (entry.count > max) {
        return { ok: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
      }
      return { ok: true, retryAfterSeconds: 0 };
    },
    reset(key) {
      hits.delete(key);
    },
    retryAfter(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now || entry.count < max) return 0;
      return Math.ceil((entry.resetAt - now) / 1000);
    },
  };
}
