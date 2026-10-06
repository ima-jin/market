import { describe, expect, it } from 'vitest';
import { GET } from '../route';

describe('GET /api/health', () => {
  it('reports ok status for this service', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'imajin-app-template' });
    expect(typeof body.timestamp).toBe('string');
  });
});
