import { createLogoutHandler } from '@ima-jin/auth-client/handlers';
import { authConfig } from '@/lib/auth-config';

export const POST = createLogoutHandler(authConfig);
