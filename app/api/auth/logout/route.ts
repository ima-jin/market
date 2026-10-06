import { createLogoutHandler } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';

export const POST = createLogoutHandler(authConfig);
