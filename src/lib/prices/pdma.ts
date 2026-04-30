import "server-only";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../storage/paths";

const ONE_DAY = 24 * 60 * 60 * 1000;
const BASE = "https://www.pdma.gr/en/debt-instruments-greek-government-bonds/issuance-calendar-a-syndication-and-auction-results";
const CALENDAR_URL = `${BASE}/issuance-calendar`;
const LATEST_RESULTS_URL = `${BASE}/latest-results/latest-t-bills-auction-results`;
const HISTORICAL_URLS: Record<"13W" | "26W" | "52W", string> = {
  "13W": `${BASE}/t-bills-historical-data/13-week`,
  "26W": `${BASE}/t-bills-historical-data/26-week`,
  "52W": `${BASE}/t-bills-historical-data/52-week`,
};

const CACHE_FILE = path.join(DATA_DIR, "pdma.json");

export type UpcomingAuction = {
  date: string; // ISO date
  tenor: "13W" | "26W" | "52W" | string;
  isin?: string;
};

export type AuctionResult = {
  auctionDate: string;
  issueDate?: string;
  maturityDate?: string;
  tenor: string;
  amountAcceptedM?: number; // in € millions
  yield?: number; // decimal
  bidToCover?: number;
};

export type PdmaSnapshot = {
  upcoming: UpcomingAuction[];
  latest: AuctionResult[];
  // Latest known yield per tenor, scraped from the historical-data pages.
  latestYieldByTenor: Partial<Record<"13W" | "26W" | "52W", number>>;
  fetchedAt: string;
};

type Cache = { data: PdmaSnapshot } | undefined;

async function readCache(): Promise<Cache> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw) as Cache;
  } catch {
    return undefined;
  }
}
async function writeCache(c: Cache) {
  if (!c) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(c, null, 2), "utf8");
}

function parseEuropeanDate(s: string): string | undefined {
  // Accepts "29/04/2026", "29-04-2026", "29.04.2026"
  const m = s.trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function parseTenor(s: string): string {
  const t = s.toLowerCase().trim();
  if (t.includes("13") || t.includes("3 month") || t.includes("3-month"))
    return "13W";
  if (t.includes("26") || t.includes("6 month") || t.includes("6-month"))
    return "26W";
  if (t.includes("52") || t.includes("12 month") || t.includes("12-month"))
    return "52W";
  return s.trim().toUpperCase();
}

function parseNumber(s: string): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[^\d.,\-]/g, "").replace(/,/g, ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parsePercent(s: string): number | undefined {
  const n = parseNumber(s);
  return n === undefined ? undefined : n / 100;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; portfolio-tracker/1.0)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function parseUpcomingFromCalendar(html: string): UpcomingAuction[] {
  const $ = cheerio.load(html);
  const out: UpcomingAuction[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((__, td) => $(td).text().trim())
      .get();
    if (cells.length < 2) return;
    const dateIso = parseEuropeanDate(cells[0]);
    if (!dateIso) return;
    const tenor = parseTenor(cells[1] ?? "");
    const isin = cells.find((c) => /^GR\d{10}$/.test(c));
    out.push({ date: dateIso, tenor, isin });
  });
  // Future-only T-bills (skip GGB / bond auctions)
  const today = new Date().toISOString().slice(0, 10);
  return out
    .filter((a) => a.date >= today)
    .filter((a) => /^(13W|26W|52W)$/.test(a.tenor))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
}

function parseLatestResults(html: string): AuctionResult[] {
  // PDMA presents the latest results as a TRANSPOSED table:
  //   col 0: row label (e.g. "AUCTION DATE", "YIELD")
  //   col 1: most recent auction
  //   col 2: previous auction
  // Sometimes more columns for additional historical results.
  const $ = cheerio.load(html);
  const rows: string[][] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr)
      .find("th, td")
      .map((__, el) => $(el).text().trim().replace(/\s+/g, " "))
      .get();
    if (cells.length > 0) rows.push(cells);
  });

  // Build a label → cells[] map
  const byLabel = new Map<string, string[]>();
  let tenorRow: string[] | null = null;
  for (const r of rows) {
    const label = (r[0] ?? "").trim().toLowerCase();
    const values = r.slice(1);
    if (!label && values.some((v) => /t-bills?\s*\d/i.test(v))) {
      tenorRow = values;
      continue;
    }
    if (label) byLabel.set(label, values);
  }

  const dates = byLabel.get("auction date") ?? [];
  const issues = byLabel.get("issue date") ?? [];
  const maturities = byLabel.get("maturity date") ?? [];
  const accepted =
    byLabel.get("total accept. amnt") ??
    byLabel.get("total accepted amount") ??
    byLabel.get("amount auctioned") ??
    [];
  const yields = byLabel.get("yield") ?? [];
  const coverages = byLabel.get("coverage ratio") ?? [];

  const out: AuctionResult[] = [];
  for (let i = 0; i < dates.length; i++) {
    const auctionDate = parseEuropeanDate(dates[i] ?? "");
    if (!auctionDate) continue;
    const tenorRaw = tenorRow?.[i] ?? "";
    const tenor = parseTenor(tenorRaw) || "?";
    out.push({
      auctionDate,
      issueDate: parseEuropeanDate(issues[i] ?? ""),
      maturityDate: parseEuropeanDate(maturities[i] ?? ""),
      tenor,
      // amounts arrive like "500.000.000" (Greek thousand separator) -> millions
      amountAcceptedM: parseAmountInMillions(accepted[i] ?? ""),
      yield: parsePercent(yields[i] ?? ""),
      bidToCover: parseNumber(coverages[i] ?? ""),
    });
  }
  return out.sort((a, b) => b.auctionDate.localeCompare(a.auctionDate));
}

function parseAmountInMillions(s: string): number | undefined {
  if (!s) return undefined;
  // Greek format uses "." as thousand separator and "," as decimal.
  // Strip "." entirely, replace "," with "."
  const cleaned = s.replace(/[^\d.,\-]/g, "").replace(/\./g, "").replace(/,/g, ".");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return n / 1_000_000;
}

async function fetchLatestYieldForTenor(
  tenor: "13W" | "26W" | "52W"
): Promise<number | undefined> {
  const html = await fetchHtml(HISTORICAL_URLS[tenor]);
  if (!html) return undefined;
  // Historical pages list rows newest-first; the first percentage in the body
  // is the latest auction's yield.
  const m = html.match(/(\d+),(\d{2})%/);
  if (!m) return undefined;
  return parseFloat(`${m[1]}.${m[2]}`) / 100;
}

export async function getPdmaSnapshot(force = false): Promise<PdmaSnapshot> {
  const cache = await readCache();
  if (
    !force &&
    cache?.data &&
    Date.now() - new Date(cache.data.fetchedAt).getTime() < ONE_DAY
  ) {
    return cache.data;
  }

  const [calHtml, resHtml, y13, y26, y52] = await Promise.all([
    fetchHtml(CALENDAR_URL),
    fetchHtml(LATEST_RESULTS_URL),
    fetchLatestYieldForTenor("13W"),
    fetchLatestYieldForTenor("26W"),
    fetchLatestYieldForTenor("52W"),
  ]);

  const upcoming = calHtml ? parseUpcomingFromCalendar(calHtml) : [];
  const latest = resHtml ? parseLatestResults(resHtml) : [];
  const latestYieldByTenor: PdmaSnapshot["latestYieldByTenor"] = {};
  if (y13 !== undefined) latestYieldByTenor["13W"] = y13;
  if (y26 !== undefined) latestYieldByTenor["26W"] = y26;
  if (y52 !== undefined) latestYieldByTenor["52W"] = y52;

  const snapshot: PdmaSnapshot = {
    upcoming,
    latest,
    latestYieldByTenor,
    fetchedAt: new Date().toISOString(),
  };

  if (
    upcoming.length > 0 ||
    latest.length > 0 ||
    Object.keys(latestYieldByTenor).length > 0 ||
    !cache?.data
  ) {
    await writeCache({ data: snapshot });
    return snapshot;
  }
  return cache.data;
}
