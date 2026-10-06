import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // @ima-jin/auth-client transitively imports 'next/headers' (getSession's
      // cookie read) — not resolvable under plain-Node vitest, only inside a
      // real Next.js runtime. See test/stubs/next-headers.ts.
      'next/headers': fileURLToPath(new URL('./test/stubs/next-headers.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // src/db/schema.ts requires APP_DB_SCHEMA at import time (see docs/MIGRATIONS.md).
    env: { APP_DB_SCHEMA: 'market' },
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    server: {
      // Otherwise vitest hands @ima-jin/auth-client's ESM import of
      // 'next/headers' straight to Node's own resolver, which bypasses
      // resolve.alias above and can't find it outside a real Next.js runtime.
      // Same reason for @ima-jin/config, which imports 'next/server' without a
      // file extension — resolvable by a bundler, not by plain Node ESM.
      deps: { inline: ['@ima-jin/auth-client', '@ima-jin/config'] },
    },
    coverage: {
      // lcov is what SonarCloud ingests (sonar.javascript.lcov.reportPaths).
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['app/**/*.ts', 'src/**/*.ts', 'middleware.ts', 'instrumentation.ts'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.d.ts',
        '**/.next/**',
        '**/node_modules/**',
      ],
    },
  },
});
