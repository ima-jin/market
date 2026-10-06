import { afterEach, describe, expect, it } from 'vitest';
import { resetSigningIdentityForTests } from '@/lib/signing-identity';
import { GET } from '../route';

describe('GET /api/health', () => {
  afterEach(() => {
    resetSigningIdentityForTests();
  });

  it('reports ok status for this service, and claimed:false before this app has claimed a signing identity', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'market', claimed: false });
    expect(typeof body.timestamp).toBe('string');
  });
});
