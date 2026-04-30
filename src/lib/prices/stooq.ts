import "server-only";
import type { PriceQuote } from "../types";

// Stooq.com — free CSV endpoint, no auth, very permissive.
// Format: lowercase ticker; for European tickers it usually accepts the same suffix
// as Yahoo (e.g. vwce.de, sxr8.de, iwda.uk -> some tickers map differently).
export async function fetchStooqQuote(symbol: string): Promise<PriceQuote | null> {
  const sym = symbol.toLowerCase();
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) {
      console.warn(`[stooq] ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const csv = await res.text();
    // First line is headers, second is the row.
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map((s) => s.trim().toLowerCase());
    const cols = lines[1].split(",").map((s) => s.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cols[i] ?? ""));
    const closeStr = row["close"];
    if (!closeStr || closeStr === "N/D") {
      console.warn(`[stooq] ${symbol}: no close (${closeStr})`);
      return null;
    }
    const price = parseFloat(closeStr);
    if (!Number.isFinite(price)) return null;
    // Stooq doesn't return currency in this CSV. Infer from ticker suffix.
    const currency = inferCurrency(symbol);
    return {
      symbol,
      price,
      currency,
      source: "yahoo", // we still treat it as live ETF/stock data; UI doesn't differentiate
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[stooq] ${symbol}: fetch failed`, err);
    return null;
  }
}

function inferCurrency(symbol: string): "EUR" | "USD" {
  const s = symbol.toLowerCase();
  if (
    s.endsWith(".de") ||
    s.endsWith(".f") ||
    s.endsWith(".pa") ||
    s.endsWith(".as") ||
    s.endsWith(".mi") ||
    s.endsWith(".mc") ||
    s.endsWith(".lis") ||
    s.endsWith(".at")
  )
    return "EUR";
  return "USD";
}
