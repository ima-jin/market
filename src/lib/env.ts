/**
 * Central env-var accessors. `.env.example` is the contract (AGENTS.md §5) —
 * no hard-coded service URLs anywhere else in this app.
 */

const DEFAULT_APP_HOST = 'market.imajin.ai';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — see .env.example.`);
  }
  return value;
}

/** This app's own host, used as the `aud` for scoped app-token verification. */
export function thisAppHost(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return DEFAULT_APP_HOST;
  try {
    return new URL(base).host;
  } catch {
    return DEFAULT_APP_HOST;
  }
}

/** Public origin of this app, without a trailing slash. */
export function appBaseUrl(): string {
  return required('NEXT_PUBLIC_APP_URL').replace(/\/+$/, '');
}

/** Base URL of the kernel's pay service (checkout sessions). */
export function payServiceUrl(): string {
  return required('PAY_SERVICE_URL').replace(/\/+$/, '');
}

/** Kernel base URL (public HTTP surface), or null when unset. */
export function kernelUrl(): string | null {
  const value = process.env.IMAJIN_KERNEL_URL;
  return value ? value.replace(/\/+$/, '') : null;
}

/** Shared secret the pay service sends with payment webhooks, or null when unset. */
export function webhookSecret(): string | null {
  return process.env.WEBHOOK_SECRET || null;
}
