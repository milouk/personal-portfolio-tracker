import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, IS_DEMO } from "./storage/paths";
import type { Asset } from "./types";
import { fetchYahooDividendCalendar } from "./prices/yahoo";

export type CalendarEventKind = "maturity" | "ex_dividend" | "dividend_payment";

export type CalendarEvent = {
  id: string;
  kind: CalendarEventKind;
  date: string; // ISO date (YYYY-MM-DD)
  daysUntil: number;
  assetId: string;
  assetName: string;
  amountEur?: number;
  detail?: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// How many days *into the past* we still surface events for (so a maturity
// you missed yesterday doesn't disappear from the dashboard immediately).
const PAST_GRACE_DAYS = 7;

function daysFromToday(iso: string): number {
  const t = new Date(iso + "T00:00:00").getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / ONE_DAY_MS);
}

const DIV_CACHE_FILE = path.join(DATA_DIR, "dividend-calendar.json");

type DivCache = Record<
  string,
  { exDate?: string; paymentDate?: string; amount?: number; fetchedAt: string }
>;

async function readDivCache(): Promise<DivCache> {
  try {
    const raw = await fs.readFile(DIV_CACHE_FILE, "utf8");
    return JSON.parse(raw) as DivCache;
  } catch {
    return {};
  }
}
async function writeDivCache(cache: DivCache): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DIV_CACHE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(tmp, DIV_CACHE_FILE);
}

/**
 * Walk the portfolio and build a chronological list of upcoming events:
 *  - bond / T-bill maturities
 *  - ex-dividend dates for ETFs / stocks (Yahoo quoteSummary, 24h cache)
 *  - dividend payment dates
 *
 * `windowDays` clamps how far ahead we look (default 90).
 */
export async function buildCalendar(
  assets: Asset[],
  windowDays = 90
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Maturities (bonds + T-bills)
  for (const a of assets) {
    if ((a.type === "tbill" || a.type === "bond") && a.maturityDate) {
      const days = daysFromToday(a.maturityDate);
      if (days < -PAST_GRACE_DAYS || days > windowDays) continue;
      const face = a.faceValue ?? a.purchasePrice;
      events.push({
        id: `maturity:${a.id}`,
        kind: "maturity",
        date: a.maturityDate,
        daysUntil: days,
        assetId: a.id,
        assetName: a.name,
        amountEur: face,
        detail:
          a.faceValue && a.purchasePrice
            ? `face €${a.faceValue.toLocaleString("en-IE")} · profit €${(a.faceValue - a.purchasePrice).toFixed(2)}`
            : undefined,
      });
    }
  }

  // Dividends (ETF + stock + crypto with Yahoo ticker)
  const cache = await readDivCache();
  let cacheDirty = false;
  // Demo mode reads from the seeded cache only — never modify it.
  if (!IS_DEMO) {
    // Prune cache entries for tickers no longer in the portfolio so the file
    // doesn't grow unboundedly across renames / asset deletions.
    const liveTickers = new Set(
      assets
        .filter((a) => (a.type === "etf" || a.type === "stock") && a.ticker)
        .map((a) => a.ticker as string)
    );
    for (const k of Object.keys(cache)) {
      if (!liveTickers.has(k)) {
        delete cache[k];
        cacheDirty = true;
      }
    }
  }
  for (const a of assets) {
    if (
      (a.type !== "etf" && a.type !== "stock") ||
      !a.ticker ||
      !a.quantity ||
      a.quantity <= 0
    ) {
      continue;
    }
    const cacheKey = a.ticker;
    let entry = cache[cacheKey];
    // Demo mode never hits Yahoo — the seeded cache is the source of truth.
    const stale =
      !IS_DEMO &&
      (!entry || Date.now() - new Date(entry.fetchedAt).getTime() > ONE_DAY_MS);
    if (stale) {
      const fetched = await fetchYahooDividendCalendar(a.ticker);
      if (fetched) {
        entry = {
          exDate: fetched.exDate,
          paymentDate: fetched.paymentDate,
          amount: fetched.amount,
          fetchedAt: new Date().toISOString(),
        };
        cache[cacheKey] = entry;
        cacheDirty = true;
      }
    }
    if (!entry) continue;
    if (entry.exDate) {
      const days = daysFromToday(entry.exDate);
      if (days >= -PAST_GRACE_DAYS && days <= windowDays) {
        const totalAmount =
          entry.amount && a.quantity ? entry.amount * a.quantity : undefined;
        events.push({
          id: `exdiv:${a.id}:${entry.exDate}`,
          kind: "ex_dividend",
          date: entry.exDate,
          daysUntil: days,
          assetId: a.id,
          assetName: a.name,
          amountEur: totalAmount,
          detail: entry.amount ? `≈ ${entry.amount}/share` : undefined,
        });
      }
    }
    if (entry.paymentDate && entry.paymentDate !== entry.exDate) {
      const days = daysFromToday(entry.paymentDate);
      if (days >= -PAST_GRACE_DAYS && days <= windowDays) {
        const totalAmount =
          entry.amount && a.quantity ? entry.amount * a.quantity : undefined;
        events.push({
          id: `divpay:${a.id}:${entry.paymentDate}`,
          kind: "dividend_payment",
          date: entry.paymentDate,
          daysUntil: days,
          assetId: a.id,
          assetName: a.name,
          amountEur: totalAmount,
        });
      }
    }
  }
  if (cacheDirty && !IS_DEMO) await writeDivCache(cache);

  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}
