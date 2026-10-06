import type { ImajinAuthConfig } from '@ima-jin/auth-client';

/**
 * Shared "Sign in with Imajin" config for every route handler in this app.
 * See @ima-jin/auth-client's README and docs/REGISTRATION.md.
 */
export const authConfig: ImajinAuthConfig = {
  secret: process.env.SESSION_SECRET!,
  authUrl: process.env.IMAJIN_AUTH_URL!,
  appDid: process.env.IMAJIN_APP_DID,
  publicUrl: process.env.NEXT_PUBLIC_APP_URL,
  loginRedirect: '/',
};
