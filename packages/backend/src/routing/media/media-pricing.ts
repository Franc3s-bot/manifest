import { AGNES_MEDIA_PRICES, type MediaPriceTable, type MediaRate } from 'manifest-shared';

/**
 * Per-provider media price tables. Token pricing does not apply to image or
 * video generation, so cost is derived from the request/response shape:
 * images are priced per generated image, video per second of output duration,
 * optionally refined by the resolution tier the request asked for.
 */
const PROVIDER_MEDIA_PRICES: Readonly<Record<string, MediaPriceTable>> = {
  agnes: AGNES_MEDIA_PRICES,
};

/**
 * Resolve a flat or per-size-tier rate for the request's size. A size map
 * without a matching tier falls back to its `default` entry.
 */
function resolveRate(rate: MediaRate | undefined, size: string | undefined): number | undefined {
  if (rate === undefined) return undefined;
  if (typeof rate === 'number') return Number.isFinite(rate) ? rate : undefined;
  const value = size !== undefined ? rate[size] : undefined;
  const resolved = value ?? rate['default'];
  return resolved !== undefined && Number.isFinite(resolved) ? resolved : undefined;
}

/**
 * USD for `count` generated images, or null when no rate is known.
 * A null result records "cost not tracked" instead of a fabricated zero.
 */
export function imageCostUsd(
  provider: string,
  model: string,
  count: number,
  size?: string,
): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const table = PROVIDER_MEDIA_PRICES[provider.toLowerCase()];
  if (!table) return null;
  const perImage = resolveRate(table.imagePerImage?.[model] ?? table.imageDefaultPerImage, size);
  if (perImage === undefined) return null;
  return perImage * count;
}

/**
 * USD for `seconds` of generated video, or null when no rate is known.
 * Video is billed on the output duration reported by the provider, by
 * resolution tier.
 */
export function videoCostUsd(
  provider: string,
  model: string,
  seconds: number,
  size?: string,
): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const table = PROVIDER_MEDIA_PRICES[provider.toLowerCase()];
  if (!table) return null;
  const perSecond = resolveRate(table.videoPerSecond?.[model] ?? table.videoDefaultPerSecond, size);
  if (perSecond === undefined) return null;
  return perSecond * seconds;
}

/**
 * Parse a duration the provider may report as a number or a numeric string
 * (Agnes returns `seconds` as a string). Returns undefined when unusable.
 */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
