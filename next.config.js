// Mirrors ima-jin/dykil#2: a fork mounted behind a reverse-proxy path prefix
// (e.g. a split child served at /coffee) sets NEXT_PUBLIC_BASE_PATH; the bare
// template defaults to '' (served at /). Read directly here (this file runs
// as plain Node at build/boot time) and mirrored into `env` so the same
// value is available client-side without a separate NEXT_PUBLIC_BASE_PATH
// definition — see src/lib/base-path.ts for the raw fetch()/<a href>/
// redirect() helper Next.js's own basePath rewriting doesn't cover.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Same tier-2 + tier-3 security headers the kernel's market app sent on every
// route: this app is embedded by the kernel's auth hub. Published SDK export.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- next.config.js is CommonJS, run as plain Node
const { tier2Headers, tier3Headers } = require('@ima-jin/config/next-headers');

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: [...tier2Headers(), ...tier3Headers()] }];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.imajin.ai',
      },
    ],
  },
};

module.exports = nextConfig;
