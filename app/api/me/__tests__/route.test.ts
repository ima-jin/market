import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock('@ima-jin/auth-client', () => ({
  getSession: getSessionMock,
}));

describe('GET /api/me', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('returns 401 when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("returns the caller's DID when signed in", async () => {
    getSessionMock.mockResolvedValue({ did: 'did:imajin:abc123' });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ did: 'did:imajin:abc123' });
  });
});
