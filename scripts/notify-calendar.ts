#!/usr/bin/env -S npx tsx
/**
 * Daily reminder runner.
 *
 * Sends ONE email per upcoming event you actually care about, exactly once:
 *   1. T-bill maturity (kind=maturity, asset.type=tbill) — N days ahead
 *   2. Ex-dividend date (kind=ex_dividend) — N days ahead
 *
 * Bond maturities, dividend-payment dates and every other calendar event are
 * intentionally skipped here — they show up on the dashboard's Upcoming
 * Events widget but don't trigger email so the inbox stays quiet.
 *
 * State file (data/sync/notified.jsonl) records every event id we've sent —
 * a 7-day cron run never spams the same maturity twice.
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

type CalendarEventKind = "maturity" | "ex_dividend" | "dividend_payment";
type CalendarEvent = {
  id: string;
  kind: CalendarEventKind;
  date: string;
  daysUntil: number;
  assetId: string;
  assetName: string;
  /** "tbill", "bond", "etf", "stock" — populated by the calendar API. */
  assetType?: string;
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

/** Decide if a calendar event is one of the two kinds the user asked for. */
function shouldEmail(event: CalendarEvent): boolean {
  if (event.kind === "maturity" && event.assetType === "tbill") return true;
  if (event.kind === "ex_dividend") return true;
  return false;
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function fmtEur(n: number | undefined): string {
  if (n === undefined) return "—";
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IE", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function describe(event: CalendarEvent): { title: string; html: string; text: string } {
  const dashboardUrl = process.env.PORTFOLIO_BASE_URL ?? "http://localhost:3000";
  const eyebrow =
    event.kind === "maturity" ? "T-Bill maturity" : "Ex-dividend";
  const verb =
    event.kind === "maturity"
      ? "matures"
      : "goes ex-dividend";
  const dateStr = fmtDate(event.date);
  const daysStr =
    event.daysUntil === 1
      ? "tomorrow"
      : event.daysUntil === 0
        ? "today"
        : `in ${event.daysUntil} days`;
  const amountStr = fmtEur(event.amountEur);
  const title = `${eyebrow} ${daysStr} — ${event.assetName}`;

  const text =
    `${event.assetName} ${verb} on ${dateStr} (${daysStr}).\n` +
    (event.amountEur !== undefined ? `Amount: ${amountStr}\n` : "") +
    (event.detail ? `Detail: ${event.detail}\n` : "") +
    `\nDashboard: ${dashboardUrl}\n`;

  // Inline-styled HTML — works in Gmail, Outlook, iOS Mail, plain webmail.
  const accent = event.kind === "maturity" ? "#16a34a" : "#7c3aed";
  const ctaLabel =
    event.kind === "maturity" ? "Plan redeployment" : "View asset";
  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 20px 32px;border-bottom:1px solid #e5e7eb;">
                <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${accent};font-weight:600;">${escapeHtml(eyebrow)}</div>
                <div style="margin-top:8px;font-size:22px;line-height:1.3;color:#0f172a;font-weight:600;">${escapeHtml(event.assetName)}</div>
                <div style="margin-top:6px;font-size:15px;color:#475569;">${escapeHtml(verb)} on <strong>${escapeHtml(dateStr)}</strong> · ${escapeHtml(daysStr)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:14px;color:#334155;">
                  ${
                    event.amountEur !== undefined
                      ? `<tr>
                          <td style="padding:6px 0;color:#64748b;width:40%;">Amount</td>
                          <td style="padding:6px 0;font-feature-settings:'tnum';font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(amountStr)}</td>
                         </tr>`
                      : ""
                  }
                  <tr>
                    <td style="padding:6px 0;color:#64748b;">Date</td>
                    <td style="padding:6px 0;font-feature-settings:'tnum';color:#0f172a;text-align:right;">${escapeHtml(dateStr)}</td>
                  </tr>
                  ${
                    event.detail
                      ? `<tr>
                          <td style="padding:6px 0;color:#64748b;">Detail</td>
                          <td style="padding:6px 0;color:#0f172a;text-align:right;">${escapeHtml(event.detail)}</td>
                         </tr>`
                      : ""
                  }
                </table>
              </td>
            </tr>
            <tr>
              <td align="left" style="padding:8px 32px 28px 32px;">
                <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(ctaLabel)} →</a>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 32px 22px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#94a3b8;">
                Personal Portfolio Tracker · sent ${escapeHtml(NOTIFY_DAYS_AHEAD.toString())} day${NOTIFY_DAYS_AHEAD === 1 ? "" : "s"} before the event.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { title, html, text };
}

async function main() {
  const baseUrl = process.env.PORTFOLIO_BASE_URL ?? "http://localhost:3000";
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
  let filtered = 0;
  for (const e of events) {
    if (e.daysUntil < 0 || e.daysUntil > NOTIFY_DAYS_AHEAD) continue;
    if (!shouldEmail(e)) {
      filtered++;
      continue;
    }
    if (sent.has(e.id)) {
      skipped++;
      continue;
    }
    const { title, html, text } = describe(e);
    console.log(`[notify-cal] ${title}`);
    if (!DRY_RUN) {
      await notify({ title, body: text, html, priority: "normal" });
      await recordSent(e.id);
    }
    due++;
  }
  console.log(
    `[notify-cal] ${due} email(s) sent, ${skipped} already-notified, ` +
      `${filtered} filtered (not tbill maturity / ex-dividend), ` +
      `window=${NOTIFY_DAYS_AHEAD}d` +
      (DRY_RUN ? " (dry-run)" : "")
  );
}

main().catch((err) => {
  console.error("[notify-cal] fatal:", err);
  process.exit(1);
});
