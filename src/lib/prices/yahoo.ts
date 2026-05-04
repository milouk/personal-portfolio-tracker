import "server-only";
import type { PriceQuote } from "../types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Yahoo Finance unofficial chart endpoint. Returns price in the symbol's native currency.
// For European tickers append the exchange suffix (e.g. "VWCE.DE", "SXR8.DE", "IWDA.AS").
export async function fetchYahooQuote(symbol: string): Promise<PriceQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.warn(`[yahoo] ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            symbol?: string;
            regularMarketPrice?: number;
            currency?: string;
          };
        }>;
        error?: unknown;
      };
    };
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") {
      console.warn(`[yahoo] ${symbol}: no meta/price`);
      return null;
    }
    const currency = (meta.currency ?? "USD").toUpperCase();
    if (currency !== "EUR" && currency !== "USD") return null;
    return {
      symbol,
      price: meta.regularMarketPrice,
      currency: currency as "EUR" | "USD",
      source: "yahoo",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[yahoo] ${symbol}: fetch failed`, err);
    return null;
  }
}

type YahooDividendEvent = {
  symbol: string;
  exDate?: string; // ISO date
  paymentDate?: string; // ISO date
  amount?: number;
  currency?: string;
};

/**
 * Fetch the next ex-dividend / payment date for a ticker via Yahoo's
 * quoteSummary endpoint. Works for distributing ETFs (e.g. IDTL.UK) and
 * dividend-paying stocks (e.g. GOOGL). Accumulating ETFs return null.
 */
export async function fetchYahooDividendCalendar(
  symbol: string
): Promise<YahooDividendEvent | null> {
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=calendarEvents,summaryDetail`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      quoteSummary?: {
        result?: Array<{
          calendarEvents?: {
            exDividendDate?: { raw?: number };
            dividendDate?: { raw?: number };
          };
          summaryDetail?: {
            exDividendDate?: { raw?: number };
            dividendRate?: { raw?: number };
            currency?: string;
          };
        }>;
      };
    };
    const r = data.quoteSummary?.result?.[0];
    if (!r) return null;
    const ex =
      r.calendarEvents?.exDividendDate?.raw ??
      r.summaryDetail?.exDividendDate?.raw;
    const pay = r.calendarEvents?.dividendDate?.raw;
    if (!ex && !pay) return null;
    return {
      symbol,
      exDate: ex ? new Date(ex * 1000).toISOString().slice(0, 10) : undefined,
      paymentDate: pay
        ? new Date(pay * 1000).toISOString().slice(0, 10)
        : undefined,
      amount: r.summaryDetail?.dividendRate?.raw,
      currency: r.summaryDetail?.currency,
    };
  } catch {
    return null;
  }
}
