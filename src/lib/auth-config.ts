import type { ImajinAuthConfig } from '@ima-jin/auth-client';
import { getSessionSecret } from './self-secrets';

/**
 * Shared "Sign in with Imajin" config for every route handler in this app.
 * See @ima-jin/auth-client's README and docs/REGISTRATION.md.
 */
export const authConfig: ImajinAuthConfig = {
  // Handler factories run at build/import time; resolve only when signing/verifying.
  get secret() {
    return getSessionSecret();
  },
  authUrl: process.env.IMAJIN_AUTH_URL!,
  appDid: process.env.IMAJIN_APP_DID,
  publicUrl: process.env.NEXT_PUBLIC_APP_URL,
  loginRedirect: '/',
};
