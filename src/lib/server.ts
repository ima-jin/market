import { initializeDatabase } from '../db';

/** Imported only inside createVaultBoot.start, after required credentials load. */
export function initializeServer(): void {
  initializeDatabase();
}
