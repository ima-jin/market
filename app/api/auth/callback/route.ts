import { createCallbackHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';

export const GET = createCallbackHandler(authConfig);
