import { describe, expect, it } from 'vitest';
import { GET } from '../route';

describe('GET /api/spec', () => {
  it("serves this app's own OpenAPI document as YAML", async () => {
    const response = await GET();
    const text = await response.text();

    expect(response.headers.get('Content-Type')).toBe('text/yaml');
    expect(text).toContain('openapi:');
    expect(text).toContain('/api/health');
  });

  it('serves the market API, not the template placeholder', async () => {
    const text = await (await GET()).text();

    expect(text).toContain('title: imajin market');
    expect(text).toContain('/api/listings/{id}/purchase');
    expect(text).toContain('/api/webhook');
  });
});
