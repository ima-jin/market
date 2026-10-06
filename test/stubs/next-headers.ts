/**
 * Stands in for Next.js's `next/headers` under vitest, which runs as plain
 * Node — not through Next's own module resolution/runtime — so the real
 * `next/headers` subpath export isn't resolvable here. Only
 * `@ima-jin/auth-client`'s `getSession()` path needs `cookies()`; nothing in
 * this app's test suite calls it, so a no-op is enough to satisfy the import
 * graph when a test exercises another part of that package (e.g.
 * `loadAppSigningKey()`).
 */
export function cookies() {
  return Promise.resolve({
    get: () => undefined,
  });
}
