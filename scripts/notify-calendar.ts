#!/usr/bin/env -S npx tsx
/**
 * Daily reminder runner.
 *
 * Reads the portfolio's upcoming events (maturities + ex-dividends + dividend
 * payments) and sends an email/ntfy notification N days before each.
 *
 * State file (data/sync/notified.jsonl) keeps a record of every event id we've
 * already sent — so a 7-day cron run never spams the same maturity twice.
 *
 * Usage:
 *   npm run notify:calendar
 *   npm run notify:calendar -- --days=14
 *   npm run notify:calendar -- --dry-run
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify } from "./lib/notify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(ROOT, f));
  } catch {
    /* ignore */
  }
}

type CalendarEvent = {
  id: string;
  kind: "maturity" | "ex_dividend" | "dividend_payment";
  date: string;
  daysUntil: number;
  assetId: string;
  assetName: string;
  amountEur?: number;
  detail?: string;
};

const STATE_DIR = path.join(ROOT, "data", "sync");
const STATE_FILE = path.join(STATE_DIR, "notified.jsonl");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const daysArg = args.find((a) => a.startsWith("--days="));
const NOTIFY_DAYS_AHEAD = daysArg
  ? parseInt(daysArg.split("=")[1], 10)
  : parseInt(process.env.NOTIFY_DAYS_AHEAD ?? "7", 10);

async function readSent(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const ids = new Set<string>();
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        ids.add((JSON.parse(line) as { id: string }).id);
      } catch {
        /* ignore malformed lines */
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function recordSent(id: string): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.appendFile(
    STATE_FILE,
    JSON.stringify({ id, at: new Date().toISOString() }) + "\n",
    "utf8"
  );
}

function describe(event: CalendarEvent): { title: string; body: string } {
  const date = new Date(event.date).toLocaleDateString("en-IE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const amount = event.amountEur
    ? ` · €${event.amountEur.toFixed(2)}`
    : "";
  const days =
    event.daysUntil >= 0
      ? `in ${event.daysUntil}d`
      : `${Math.abs(event.daysUntil)}d ago`;

  switch (event.kind) {
    case "maturity":
      return {
        title: `Maturity ${days} — ${event.assetName}`,
        body:
          `${event.assetName} matures on ${date}${amount}.` +
          (event.detail ? `\n${event.detail}` : "") +
          `\nPlan how to redeploy the proceeds.`,
      };
    case "ex_dividend":
      return {
        title: `Ex-dividend ${days} — ${event.assetName}`,
        body:
          `${event.assetName} goes ex-dividend on ${date}.` +
          (event.detail ? ` ${event.detail}.` : "") +
          (event.amountEur ? ` Estimated total: €${event.amountEur.toFixed(2)}.` : ""),
      };
    case "dividend_payment":
      return {
        title: `Dividend ${days} — ${event.assetName}`,
        body: `${event.assetName} pays its dividend on ${date}${amount}.`,
      };
  }
}

async function main() {
  const baseUrl =
    process.env.PORTFOLIO_BASE_URL ?? "http://localhost:3000";
  const token = process.env.PORTFOLIO_API_TOKEN;
  const url = `${baseUrl}/api/calendar?days=${Math.max(NOTIFY_DAYS_AHEAD + 1, 30)}`;
  console.log(`[notify-cal] fetching ${url}`);
  const headers: Record<string, string> = {};
  if (token) headers["x-api-token"] = token;
  let events: CalendarEvent[];
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(
        `[notify-cal] /api/calendar returned ${res.status} — is the dashboard running?`
      );
      process.exit(2);
    }
    events = ((await res.json()) as { events: CalendarEvent[] }).events;
  } catch (e) {
    console.error("[notify-cal] fetch failed:", e);
    process.exit(2);
  }

  const sent = await readSent();
  let due = 0;
  let skipped = 0;
  for (const e of events) {
    if (e.daysUntil < 0 || e.daysUntil > NOTIFY_DAYS_AHEAD) continue;
    if (sent.has(e.id)) {
      skipped++;
      continue;
    }
    const { title, body } = describe(e);
    console.log(`[notify-cal] ${title}`);
    if (!DRY_RUN) {
      await notify({ title, body, priority: "normal" });
      await recordSent(e.id);
    }
    due++;
  }
  console.log(
    `[notify-cal] ${due} notification(s) sent, ${skipped} already-notified, window=${NOTIFY_DAYS_AHEAD}d` +
      (DRY_RUN ? " (dry-run)" : "")
  );
}

main().catch((err) => {
  console.error("[notify-cal] fatal:", err);
  process.exit(1);
});
