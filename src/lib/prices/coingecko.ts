import "server-only";
import type { PriceQuote } from "../types";

// Common ticker -> CoinGecko id mapping. Override per asset via `coingeckoId`.
const TICKER_MAP: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  XRP: "ripple",
  DOT: "polkadot",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  LINK: "chainlink",
  ATOM: "cosmos",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  ALGO: "algorand",
  TRX: "tron",
  XLM: "stellar",
  NEAR: "near",
  UNI: "uniswap",
  AAVE: "aave",
  USDT: "tether",
  USDC: "usd-coin",
};

export function resolveCoingeckoId(
  ticker: string | undefined,
  override: string | undefined
): string | null {
  if (override) return override;
  if (!ticker) return null;
  const upper = ticker.toUpperCase();
  return TICKER_MAP[upper] ?? upper.toLowerCase();
}

export async function fetchCryptoPrice(
  ticker: string | undefined,
  coingeckoId: string | undefined,
  vsCurrency: "eur" | "usd" = "eur"
): Promise<PriceQuote | null> {
  const id = resolveCoingeckoId(ticker, coingeckoId);
  if (!id) return null;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${vsCurrency}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, Record<string, number>>;
    const price = data[id]?.[vsCurrency];
    if (typeof price !== "number") return null;
    return {
      symbol: (ticker ?? id).toUpperCase(),
      price,
      currency: vsCurrency.toUpperCase() as "EUR" | "USD",
      source: "coingecko",
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
