/**
 * Prefix a same-origin absolute path with the app's basePath (mirrors
 * ima-jin/dykil#2).
 *
 * Next.js auto-prefixes `<Link>` and `router.push`, but NOT raw `fetch()`,
 * `<a href>`, `redirect()`, or `NextResponse.redirect()` calls. Route those
 * through this helper so they resolve correctly once a fork is mounted under
 * a non-root basePath (e.g. `/coffee`) — see next.config.js and
 * NEXT_PUBLIC_BASE_PATH in .env.example. The bare template defaults to ''
 * (served at /).
 */
export function withBasePath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  if (path === '/') {
    return base === '' ? '/' : base;
  }
  return `${base}${path}`;
}
