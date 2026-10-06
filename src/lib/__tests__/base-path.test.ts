import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBasePath } from '../base-path';

describe('withBasePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the path unchanged when no basePath is configured (bare template default)', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    expect(withBasePath('/api/health')).toBe('/api/health');
  });

  it('returns root for "/" when no basePath is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    expect(withBasePath('/')).toBe('/');
  });

  it('prefixes a path with NEXT_PUBLIC_BASE_PATH when set', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    expect(withBasePath('/api/spec')).toBe('/coffee/api/spec');
  });

  it('returns the basePath itself for root when a basePath is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    expect(withBasePath('/')).toBe('/coffee');
  });

  it('handles nested paths', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/coffee');
    expect(withBasePath('/api/orders/abc/receipt')).toBe('/coffee/api/orders/abc/receipt');
  });
});
