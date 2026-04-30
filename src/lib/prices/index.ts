import "server-only";
import type { Asset, PriceQuote } from "../types";
import { IS_DEMO } from "../storage/paths";
import { isFresh, readPriceCache, writePriceCache } from "./cache";
import { fetchCryptoPrice } from "./coingecko";
import { fetchStooqQuote } from "./stooq";
import { fetchYahooQuote } from "./yahoo";

// Short TTL so a page load / refresh feels live. Yahoo and CoinGecko both
// tolerate this volume for personal use. Refresh button still passes force=1.
const PRICE_TTL_MS = 60 * 1000;

function priceKey(asset: Asset): string {
  if (asset.type === "crypto") {
    return `crypto:${(asset.coingeckoId ?? asset.ticker ?? "").toLowerCase()}`;
  }
  return `${asset.type}:${(asset.ticker ?? "").toUpperCase()}`;
}

function manualQuote(asset: Asset): PriceQuote | null {
  if (typeof asset.manualPrice !== "number") return null;
  return {
    symbol: asset.ticker ?? asset.id,
    price: asset.manualPrice,
    currency: asset.currency,
    source: "manual",
    fetchedAt: asset.updatedAt,
  };
}

function isQuotable(asset: Asset): boolean {
  if (asset.type !== "etf" && asset.type !== "stock" && asset.type !== "crypto") {
    return false;
  }
  return Boolean(asset.ticker || asset.coingeckoId);
}

async function fetchLiveQuote(asset: Asset): Promise<PriceQuote | null> {
  if (asset.type === "crypto") {
    return fetchCryptoPrice(
      asset.ticker,
      asset.coingeckoId,
      asset.currency.toLowerCase() as "eur" | "usd"
    );
  }
  const yahoo = await fetchYahooQuote(asset.ticker!);
  if (yahoo) return yahoo;
  return fetchStooqQuote(asset.ticker!);
}

export async function getPriceForAsset(
  asset: Asset,
  force = false
): Promise<PriceQuote | null> {
  const manual = manualQuote(asset);
  if (manual) return manual;
  if (!isQuotable(asset)) return null;

  const cache = await readPriceCache();
  if (IS_DEMO) return cache[asset.id] ?? null;

  const key = priceKey(asset);
  const cached = cache[key];
  if (!force && cached && isFresh(cached.fetchedAt, PRICE_TTL_MS)) return cached;

  const quote = await fetchLiveQuote(asset);
  if (quote) {
    cache[key] = quote;
    await writePriceCache(cache);
    return quote;
  }
  return cached ?? null;
}

/**
 * Bulk-fetch quotes for a portfolio. Reads the price cache once, fetches all
 * stale quotes in parallel, then writes the merged cache back exactly once —
 * avoiding the read/modify/write race that would happen if each asset wrote
 * the cache independently in a Promise.all.
 */
export async function getPricesForAssets(
  assets: Asset[],
  force = false
): Promise<Record<string, PriceQuote>> {
  const out: Record<string, PriceQuote> = {};

  // Manual overrides resolve synchronously, no cache touch needed.
  const network: Asset[] = [];
  for (const a of assets) {
    const manual = manualQuote(a);
    if (manual) {
      out[a.id] = manual;
      continue;
    }
    if (isQuotable(a)) network.push(a);
  }

  const cache = await readPriceCache();

  // Demo: serve everything from the seeded cache, never hit the network.
  if (IS_DEMO) {
    for (const a of network) {
      const q = cache[a.id];
      if (q) out[a.id] = q;
    }
    return out;
  }

  const stale: Asset[] = [];
  for (const a of network) {
    const key = priceKey(a);
    const cached = cache[key];
    if (!force && cached && isFresh(cached.fetchedAt, PRICE_TTL_MS)) {
      out[a.id] = cached;
    } else {
      stale.push(a);
    }
  }

  if (stale.length > 0) {
    const fetched = await Promise.all(
      stale.map(async (a) => ({ asset: a, quote: await fetchLiveQuote(a) }))
    );
    let cacheDirty = false;
    for (const { asset, quote } of fetched) {
      const key = priceKey(asset);
      if (quote) {
        cache[key] = quote;
        out[asset.id] = quote;
        cacheDirty = true;
      } else if (cache[key]) {
        // Network failed but we have a stale cached price — better than nothing.
        out[asset.id] = cache[key];
      }
    }
    if (cacheDirty) await writePriceCache(cache);
  }

  return out;
}
