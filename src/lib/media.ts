/**
 * Media URL resolution with size presets.
 *
 * Local stand-in for `@imajin/media`'s `resolveMediaRef`, which is not
 * published to npm — tracked in ima-jin/imajin-ai#2637. Drop this file and
 * import from `@ima-jin/media` once it ships.
 *
 * Uses NEXT_PUBLIC_MEDIA_URL at runtime. Falls back to an empty string so
 * relative URLs still work in dev.
 */

/** Named size presets for common display contexts */
export type MediaPreset = 'thumbnail' | 'card' | 'detail' | 'og' | 'original';

const PRESET_WIDTHS: Record<Exclude<MediaPreset, 'og' | 'original'>, number> = {
  thumbnail: 200,
  card: 400,
  detail: 800,
};

export function resolveAssetUrl(assetId: string, preset?: MediaPreset | number): string {
  const base = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';
  const url = `${base}/api/assets/${assetId}`;

  if (!preset || preset === 'original') return url;
  if (preset === 'og') return `${url}/og`;
  if (typeof preset === 'number') return `${url}?w=${preset}`;
  return `${url}?w=${PRESET_WIDTHS[preset]}`;
}

/**
 * Resolve a media reference that may be either a legacy URL/path or an asset
 * ID. `asset_*` refs become CDN URLs; anything else is returned unchanged.
 */
export function resolveMediaRef(ref: string, preset?: MediaPreset | number): string {
  if (ref.startsWith('asset_')) {
    return resolveAssetUrl(ref, preset);
  }
  return ref;
}
