import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isRateLimited,
  MAX_TRACKED_KEYS,
  recordAttempt,
  resetClaimRateLimitForTests,
  UNKNOWN_CLIENT_KEY,
} from '../claim-rate-limit';

const ATTEMPT_LIMIT = 5;

describe('claim rate limiting', () => {
  afterEach(() => {
    resetClaimRateLimitForTests();
    vi.useRealTimers();
  });

  it('allows attempts under the limit', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT - 1; attempt += 1) {
      expect(isRateLimited('1.2.3.4')).toBe(false);
      recordAttempt('1.2.3.4');
    }
  });

  it('blocks once the limit is reached', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }

    expect(isRateLimited('1.2.3.4')).toBe(true);
  });

  it('tracks separate keys independently', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }

    expect(isRateLimited('5.6.7.8')).toBe(false);
  });

  it('forgets attempts once the window elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('1.2.3.4');
    }
    expect(isRateLimited('1.2.3.4')).toBe(true);

    vi.setSystemTime(20 * 60 * 1000);

    expect(isRateLimited('1.2.3.4')).toBe(false);
  });

  it('gives the shared UNKNOWN_CLIENT_KEY bucket a much higher cap than a normal per-address key', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt(UNKNOWN_CLIENT_KEY);
    }

    // A normal key would already be blocked at this point (ATTEMPT_LIMIT) —
    // the unknown bucket must not be, since every caller with no resolvable
    // address shares it and a low cap here would let one of them lock out
    // every other caller sharing the same bucket, including the operator.
    expect(isRateLimited(UNKNOWN_CLIENT_KEY)).toBe(false);
  });

  it('still eventually blocks the UNKNOWN_CLIENT_KEY bucket once its own higher cap is reached', () => {
    const unknownBucketLimit = 50;
    for (let attempt = 0; attempt < unknownBucketLimit; attempt += 1) {
      recordAttempt(UNKNOWN_CLIENT_KEY);
    }

    expect(isRateLimited(UNKNOWN_CLIENT_KEY)).toBe(true);
  });

  it('caps the number of tracked keys, evicting the oldest entry to make room', () => {
    for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
      recordAttempt('first-key');
    }
    expect(isRateLimited('first-key')).toBe(true);

    for (let i = 0; i < MAX_TRACKED_KEYS; i += 1) {
      recordAttempt(`filler-${i}`);
    }

    // 'first-key' was the oldest tracked entry and got evicted to make room
    // for the newest filler key — its exhausted history is forgotten, so it
    // reads as fresh (not rate-limited) again.
    expect(isRateLimited('first-key')).toBe(false);
  });
});
