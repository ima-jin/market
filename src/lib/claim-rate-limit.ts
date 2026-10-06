/**
 * In-memory rate limiter for the operator `/claim` page's `/api/claim`
 * route (#2427). Deliberately in-process only — this app runs as a single
 * pm2 process, and the claim code itself is single-use and short-TTL
 * kernel-side regardless, so this only needs to blunt local brute-force
 * guessing, not survive a restart or coordinate across replicas.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;

/**
 * `clientKeyFor()` (`app/api/claim/route.ts`) falls back to this sentinel
 * when it cannot resolve any client address at all (no usable
 * `x-forwarded-for` — a deployment not sitting behind a front-door proxy
 * that sets it; `x-real-ip` is never consulted because it is client-
 * controlled). Every such caller shares this one bucket, so it gets its own,
 * much higher cap: a low cap here would let a single attacker with no
 * resolvable address exhaust the shared bucket and lock out the real
 * operator hitting the very same bucket. This is a documented, intentionally
 * coarse stopgap for that degraded case — the real fix is running behind a
 * front door that sets `X-Forwarded-For` and keeping the app port
 * unreachable except through it (see docs/REGISTRATION.md, "Proxy trust
 * assumption").
 */
export const UNKNOWN_CLIENT_KEY = 'unknown';
const MAX_ATTEMPTS_PER_WINDOW_UNKNOWN = 50;

/** Caps total distinct tracked keys so an attacker cycling through spoofed addresses can't grow this map unboundedly. */
export const MAX_TRACKED_KEYS = 500;

const attemptsByKey = new Map<string, number[]>();

function maxAttemptsFor(key: string): number {
  return key === UNKNOWN_CLIENT_KEY ? MAX_ATTEMPTS_PER_WINDOW_UNKNOWN : MAX_ATTEMPTS_PER_WINDOW;
}

function recentAttempts(key: string, now: number): number[] {
  const timestamps = attemptsByKey.get(key) ?? [];
  return timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
}

/** Evicts the oldest tracked key (`Map` preserves insertion order) to make room for a new one once at capacity. */
function evictOldestIfAtCapacity(): void {
  if (attemptsByKey.size < MAX_TRACKED_KEYS) {
    return;
  }
  const oldestKey = attemptsByKey.keys().next().value;
  if (oldestKey !== undefined) {
    attemptsByKey.delete(oldestKey);
  }
}

/** True when `key` has already made its allotted attempts within the current window (see `maxAttemptsFor`). */
export function isRateLimited(key: string): boolean {
  return recentAttempts(key, Date.now()).length >= maxAttemptsFor(key);
}

/** Records an attempt for `key`, pruning timestamps outside the current window and evicting the oldest key if the map is full. */
export function recordAttempt(key: string): void {
  const now = Date.now();
  const timestamps = recentAttempts(key, now);
  timestamps.push(now);
  if (!attemptsByKey.has(key)) {
    evictOldestIfAtCapacity();
  }
  attemptsByKey.set(key, timestamps);
}

/** Test-only: clears all recorded attempts. */
export function resetClaimRateLimitForTests(): void {
  attemptsByKey.clear();
}
