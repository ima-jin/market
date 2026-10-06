import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBaseUrl, kernelUrl, payServiceUrl, thisAppHost, webhookSecret } from '../env';
import { resolveAssetUrl, resolveMediaRef } from '../media';
import { errorResponse, formatPrice, generateId, isZeroDecimal, jsonResponse } from '../utils';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('utils', () => {
  it('generateId prefixes and produces distinct ids', () => {
    const a = generateId('lst');
    const b = generateId('lst');
    expect(a).toMatch(/^lst_[0-9a-z]+$/);
    expect(a).not.toBe(b);
  });

  it('jsonResponse and errorResponse set status and body', async () => {
    const ok = jsonResponse({ a: 1 }, 201);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ a: 1 });

    const defaultOk = jsonResponse({ a: 1 });
    expect(defaultOk.status).toBe(200);

    const bad = errorResponse('nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'nope' });

    expect(errorResponse('boom', 500).status).toBe(500);
  });

  it('detects zero-decimal currencies case-insensitively', () => {
    expect(isZeroDecimal('jpy')).toBe(true);
    expect(isZeroDecimal('CAD')).toBe(false);
  });

  it('formats prices from the smallest unit, except zero-decimal currencies', () => {
    expect(formatPrice(1999, 'CAD')).toBe('CA$19.99');
    expect(formatPrice(500, 'jpy')).toBe('¥500');
  });
});

describe('media', () => {
  it('builds asset URLs for each preset against NEXT_PUBLIC_MEDIA_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_MEDIA_URL', 'https://media.test');
    expect(resolveAssetUrl('asset_1')).toBe('https://media.test/api/assets/asset_1');
    expect(resolveAssetUrl('asset_1', 'original')).toBe('https://media.test/api/assets/asset_1');
    expect(resolveAssetUrl('asset_1', 'thumbnail')).toBe('https://media.test/api/assets/asset_1?w=200');
    expect(resolveAssetUrl('asset_1', 'card')).toBe('https://media.test/api/assets/asset_1?w=400');
    expect(resolveAssetUrl('asset_1', 'detail')).toBe('https://media.test/api/assets/asset_1?w=800');
    expect(resolveAssetUrl('asset_1', 'og')).toBe('https://media.test/api/assets/asset_1/og');
    expect(resolveAssetUrl('asset_1', 600)).toBe('https://media.test/api/assets/asset_1?w=600');
  });

  it('falls back to a relative URL when no media base is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_MEDIA_URL', '');
    expect(resolveAssetUrl('asset_1', 'card')).toBe('/api/assets/asset_1?w=400');
  });

  it('resolves asset refs but leaves legacy URLs untouched', () => {
    vi.stubEnv('NEXT_PUBLIC_MEDIA_URL', 'https://media.test');
    expect(resolveMediaRef('asset_9', 'card')).toBe('https://media.test/api/assets/asset_9?w=400');
    expect(resolveMediaRef('https://cdn.test/a.jpg', 'card')).toBe('https://cdn.test/a.jpg');
    expect(resolveMediaRef('/relative/a.jpg')).toBe('/relative/a.jpg');
  });
});

describe('env', () => {
  it('derives the audience host from NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-market.imajin.ai/market');
    expect(thisAppHost()).toBe('dev-market.imajin.ai');
  });

  it('falls back to the production host when the URL is missing or malformed', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(thisAppHost()).toBe('market.imajin.ai');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url');
    expect(thisAppHost()).toBe('market.imajin.ai');
  });

  it('strips trailing slashes from service URLs', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://m.test//');
    vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test/');
    vi.stubEnv('IMAJIN_KERNEL_URL', 'https://jin.test/');
    expect(appBaseUrl()).toBe('https://m.test');
    expect(payServiceUrl()).toBe('https://pay.test');
    expect(kernelUrl()).toBe('https://jin.test');
  });

  it('throws a clear error for required vars and returns null for optional ones', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('PAY_SERVICE_URL', '');
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    vi.stubEnv('WEBHOOK_SECRET', '');
    expect(() => appBaseUrl()).toThrow(/NEXT_PUBLIC_APP_URL is not set/);
    expect(() => payServiceUrl()).toThrow(/PAY_SERVICE_URL is not set/);
    expect(kernelUrl()).toBeNull();
    expect(webhookSecret()).toBeNull();
  });

  it('returns the webhook secret when configured', () => {
    vi.stubEnv('WEBHOOK_SECRET', 'shh');
    expect(webhookSecret()).toBe('shh');
  });
});
