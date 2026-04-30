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

export async function getPriceForAsset(
  asset: Asset,
  force = false
): Promise<PriceQuote | null> {
  // Manual override always wins
  if (typeof asset.manualPrice === "number") {
    return {
      symbol: asset.ticker ?? asset.id,
      price: asset.manualPrice,
      currency: asset.currency,
      source: "manual",
      fetchedAt: asset.updatedAt,
    };
  }

  if (asset.type !== "etf" && asset.type !== "stock" && asset.type !== "crypto") {
    return null;
  }
  if (!asset.ticker && !asset.coingeckoId) return null;

  const cache = await readPriceCache();
  // Demo mode: prices are seeded under the asset id (matches demo/prices.json).
  if (IS_DEMO) return cache[asset.id] ?? null;

  const key = priceKey(asset);
  const cached = cache[key];
  if (!force && cached && isFresh(cached.fetchedAt, PRICE_TTL_MS)) return cached;

  let quote: PriceQuote | null = null;
  if (asset.type === "crypto") {
    quote = await fetchCryptoPrice(
      asset.ticker,
      asset.coingeckoId,
      asset.currency.toLowerCase() as "eur" | "usd"
    );
  } else {
    quote = await fetchYahooQuote(asset.ticker!);
    if (!quote) quote = await fetchStooqQuote(asset.ticker!);
  }
  if (quote) {
    cache[key] = quote;
    await writePriceCache(cache);
    return quote;
  }
  return cached ?? null;
}

export async function getPricesForAssets(
  assets: Asset[],
  force = false
): Promise<Record<string, PriceQuote>> {
  const out: Record<string, PriceQuote> = {};
  await Promise.all(
    assets.map(async (a) => {
      const q = await getPriceForAsset(a, force);
      if (q) out[a.id] = q;
    })
  );
  return out;
}
