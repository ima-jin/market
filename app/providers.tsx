'use client';

import type { ReactNode } from 'react';

/**
 * Extension point for client-side context providers (theme, query client,
 * feature flags, ...). Empty by design in the bare template — a fork adds
 * providers here rather than editing `layout.tsx` directly, so future
 * `scripts/sync-from-template.sh` merges stay conflict-free.
 */
export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return <>{children}</>;
}
