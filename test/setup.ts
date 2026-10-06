import { vi } from 'vitest';

/**
 * Keeps route/lib tests quiet: `@ima-jin/logger` is a real pino logger that
 * would otherwise write JSON lines to stdout for every handled error path.
 */
vi.mock('@ima-jin/logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { createLogger: () => logger };
});
