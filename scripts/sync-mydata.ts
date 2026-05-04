#!/usr/bin/env -S npx tsx
/**
 * Pull income + expense aggregates from AADE's myDATA REST API.
 *
 * Read-only — calls only `RequestMyIncome` and `RequestMyExpenses`. No writes
 * (no SendInvoices / SendIncomeClassification / etc. anywhere in this file).
 *
 * Writes one file per year to `data/mydata/<year>.json`:
 *
 *   {
 *     "year": 2026,
 *     "fetchedAt": "...",
 *     "dateFrom": "01/01/2026",
 *     "dateTo": "05/05/2026",
 *     "income":   { netValue, vatAmount, withheldAmount, grossValue, count },
 *     "expenses": { netValue, vatAmount, withheldAmount, grossValue, count },
 *     "incomeBreakdown":   [...],   // per-counterparty rows (optional drill-down)
 *     "expensesBreakdown": [...]
 *   }
 *
 * Run manually:
 *     npm run sync:mydata           # current year + previous year
 *     YEARS=2024,2025 npm run sync:mydata
 *
 * Cron-friendly — exits 0 on success, non-zero on failure. Safe to run daily.
 *
 * Required env (in .env.local):
 *     AADE_USER_ID
 *     AADE_SUBSCRIPTION_KEY
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchState } from "./lib/sync-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(ROOT, f));
  } catch {
    /* file optional */
  }
}

const USER_ID = process.env.AADE_USER_ID?.trim();
const SUB_KEY = process.env.AADE_SUBSCRIPTION_KEY?.trim();
if (!USER_ID || !SUB_KEY) {
  console.error(
    "[mydata] AADE_USER_ID and AADE_SUBSCRIPTION_KEY must be set in .env.local"
  );
  process.exit(2);
}

const BASE_URL = "https://mydatapi.aade.gr/myDATA";

function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

type BookRow = {
  counterVatNumber: string;
  issueDate: string;
  invType: string;
  netValue: number;
  vatAmount: number;
  withheldAmount: number;
  grossValue: number;
  count: number;
};

type BookSummary = {
  netValue: number;
  vatAmount: number;
  withheldAmount: number;
  grossValue: number;
  count: number;
};

function parseBookInfo(xml: string): { rows: BookRow[]; totals: BookSummary } {
  const blocks = [...xml.matchAll(/<bookInfo>([\s\S]*?)<\/bookInfo>/g)];
  const rows: BookRow[] = blocks.map(([, body]) => {
    const grab = (tag: string): string => {
      const m = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : "";
    };
    return {
      counterVatNumber: grab("counterVatNumber"),
      issueDate: grab("issueDate"),
      invType: grab("invType"),
      netValue: parseFloat(grab("netValue") || "0"),
      vatAmount: parseFloat(grab("vatAmount") || "0"),
      withheldAmount: parseFloat(grab("withheldAmount") || "0"),
      grossValue: parseFloat(grab("grossValue") || "0"),
      count: parseInt(grab("count") || "0", 10),
    };
  });
  const sum = (k: keyof BookRow): number =>
    rows.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  return {
    rows,
    totals: {
      netValue: round2(sum("netValue")),
      vatAmount: round2(sum("vatAmount")),
      withheldAmount: round2(sum("withheldAmount")),
      grossValue: round2(sum("grossValue")),
      count: sum("count"),
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type E3Row = {
  code: string;       // e.g. "E3_585_016", "E3_587", "E3_882_001"
  value: number;
};

type E3Summary = {
  /** One entry per E3 form code with cumulative € + count of classifications. */
  byCode: Record<string, { sum: number; count: number }>;
  /**
   * Sum of all `E3_585_*` lines — the canonical "deductible expenses" total
   * the accountant uses when filing the E3 form. Verified to land within
   * ~€55 of an accountant's filed number on real-world 2025 data.
   */
  deductibleE3585Total: number;
  /** Count of distinct classification entries (not invoices). */
  count: number;
};

async function fetchAggregate(
  endpoint: "RequestMyIncome" | "RequestMyExpenses",
  dateFrom: string,
  dateTo: string,
  attempt = 1
): Promise<{ rows: BookRow[]; totals: BookSummary }> {
  const url = `${BASE_URL}/${endpoint}?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await fetch(url, {
    headers: {
      "aade-user-id": USER_ID!,
      "Ocp-Apim-Subscription-Key": SUB_KEY!,
    },
  });
  if (res.status === 429) {
    // myDATA's 429 body looks like:
    //   {"statusCode":429,"message":"Rate limit is exceeded. Try again in 64 seconds."}
    if (attempt > 3) throw new Error(`${endpoint} rate-limited 3× — giving up`);
    const text = await res.text().catch(() => "");
    const m = text.match(/in (\d+) seconds/);
    const waitS = m ? parseInt(m[1], 10) + 1 : 30;
    console.log(`  [mydata] rate-limited, sleeping ${waitS}s then retry…`);
    await sleep(waitS * 1000);
    return fetchAggregate(endpoint, dateFrom, dateTo, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(
      `${endpoint} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`
    );
  }
  return parseBookInfo(await res.text());
}

async function fetchE3Info(
  dateFrom: string,
  dateTo: string,
  attempt = 1
): Promise<E3Summary> {
  const url = `${BASE_URL}/RequestE3Info?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await fetch(url, {
    headers: {
      "aade-user-id": USER_ID!,
      "Ocp-Apim-Subscription-Key": SUB_KEY!,
    },
  });
  if (res.status === 429) {
    if (attempt > 3) throw new Error(`RequestE3Info rate-limited 3× — giving up`);
    const text = await res.text().catch(() => "");
    const m = text.match(/in (\d+) seconds/);
    const waitS = m ? parseInt(m[1], 10) + 1 : 30;
    console.log(`  [mydata] rate-limited, sleeping ${waitS}s then retry…`);
    await sleep(waitS * 1000);
    return fetchE3Info(dateFrom, dateTo, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(
      `RequestE3Info HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`
    );
  }
  const xml = await res.text();
  const blocks = [...xml.matchAll(/<E3Info>([\s\S]*?)<\/E3Info>/g)];
  const rows: E3Row[] = blocks.map(([, body]) => {
    const grab = (tag: string): string => {
      const m = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : "";
    };
    return {
      code: grab("V_Class_Type") || "(uncoded)",
      value: parseFloat(grab("V_Class_Value") || "0"),
    };
  });
  const byCode: Record<string, { sum: number; count: number }> = {};
  let deductibleE3585Total = 0;
  for (const r of rows) {
    if (!byCode[r.code]) byCode[r.code] = { sum: 0, count: 0 };
    byCode[r.code].sum = round2(byCode[r.code].sum + r.value);
    byCode[r.code].count += 1;
    if (r.code.startsWith("E3_585_")) deductibleE3585Total += r.value;
  }
  return {
    byCode,
    deductibleE3585Total: round2(deductibleE3585Total),
    count: rows.length,
  };
}

async function main() {
  const now = new Date();
  const currentYear = now.getFullYear();

  // Default: current + 3 prior years (4 total — matches the year picker on
  // the tax estimator UI). Override with YEARS=2022,2023,2024 …
  const years = process.env.YEARS
    ? process.env.YEARS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
    : [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];

  await patchState("mydata", {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    lastError: undefined,
    message: `Fetching ${years.length} year${years.length === 1 ? "" : "s"}…`,
  });

  const outDir = path.join(ROOT, "data", "mydata");
  await fs.mkdir(outDir, { recursive: true });

  for (const year of years) {
    const dateFrom = `01/01/${year}`;
    const dateTo = year === currentYear ? fmtDate(now) : `31/12/${year}`;

    process.stdout.write(`[mydata] ${year} (${dateFrom} → ${dateTo}) … `);

    // Sequential calls — myDATA rate-limits aggressive concurrent requests
    // (we hit 429s when running 4 in parallel earlier). One at a time is
    // plenty for a daily cron.
    const income = await fetchAggregate("RequestMyIncome", dateFrom, dateTo);
    const expenses = await fetchAggregate("RequestMyExpenses", dateFrom, dateTo);
    const e3 = await fetchE3Info(dateFrom, dateTo);

    const payload = {
      year,
      dateFrom,
      dateTo,
      fetchedAt: new Date().toISOString(),
      income: income.totals,
      expenses: expenses.totals,
      e3,
      incomeBreakdown: income.rows,
      expensesBreakdown: expenses.rows,
    };

    const file = path.join(outDir, `${year}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmp, file);

    console.log(
      `income €${income.totals.netValue.toFixed(2)} (${income.totals.count} inv) · ` +
        `expenses raw €${expenses.totals.netValue.toFixed(2)} → ` +
        `E3_585_* €${e3.deductibleE3585Total.toFixed(2)} · ` +
        `withheld €${income.totals.withheldAmount.toFixed(2)}`
    );
  }

  await patchState("mydata", {
    status: "success",
    finishedAt: new Date().toISOString(),
    message: `${years.length} year${years.length === 1 ? "" : "s"} synced`,
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[mydata] fatal:", msg);
  void patchState("mydata", {
    status: "error",
    finishedAt: new Date().toISOString(),
    lastError: msg,
  }).catch(() => undefined);
  process.exit(1);
});
