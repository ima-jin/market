import { createSessionHandler } from '@ima-jin/auth-client/handlers';
import { authConfig } from '@/lib/auth-config';

export const GET = createSessionHandler(authConfig);
