#!/usr/bin/env -S npx tsx
/**
 * Pull the full TR timeline (every buy/sell/dividend/interest payout) via
 * pytr and normalise it into data/tr-transactions.jsonl.
 *
 * One row per event, append-only, idempotent (we replace by event id on rerun).
 *
 * Usage:
 *     npm run sync:tr:transactions
 *     npm run sync:tr:transactions -- --debug
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { accessSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify } from "./lib/notify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "data", "tr-transactions.jsonl");
const PY_HELPER = path.join(__dirname, "tr_dl_events.py");

const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");

function pyExecutable(): string {
  if (process.env.TR_PYTHON) return process.env.TR_PYTHON;
  const venvPy = path.join(ROOT, ".venv", "bin", "python3");
  try {
    accessSync(venvPy);
    return venvPy;
  } catch {
    return "python3";
  }
}

type RawEvent = {
  id?: string;
  timestamp?: string;
  eventType?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  amount?: { value?: number; currency?: string };
  details?: unknown;
  [k: string]: unknown;
};

type NormalizedTxn = {
  id: string;
  date: string;
  type: string;
  description: string;
  amountEur: number | null;
  rawType: string;
};

function categorise(eventType: string, amountEur: number | null): string {
  const t = eventType.toUpperCase();

  // Trades
  if (t === "TRADING_SAVINGSPLAN_EXECUTED" || t === "SAVINGS_PLAN_INVOICE_CREATED")
    return "savings_plan";
  if (t === "TRADING_SAVINGSPLAN_EXECUTION_FAILED") return "cancelled";
  if (t === "SAVEBACK_AGGREGATE") return "saveback";
  if (
    t === "TRADING_TRADE_EXECUTED" ||
    t === "ORDER_EXECUTED" ||
    t === "TRADE_INVOICE"
  ) {
    if (amountEur === null) return "trade";
    return amountEur < 0 ? "buy" : "sell";
  }
  if (
    t === "TRADING_ORDER_REJECTED" ||
    t === "TRADING_ORDER_CANCELLED" ||
    t === "TRADING_ORDER_EXPIRED" ||
    t === "ORDER_CANCELED"
  )
    return "cancelled";

  if (t === "CRYPTO_TRANSACTION_INCOMING") return "buy";

  // Income
  if (t === "INTEREST_PAYOUT" || t === "INTEREST_PAYOUT_CREATED") return "interest";
  if (
    t === "SSP_CORPORATE_ACTION_CASH" ||
    t === "SSP_CORPORATE_ACTION_ACTIVITY" ||
    t === "GESH_CORPORATE_ACTION"
  )
    return "dividend";
  if (t === "STOCK_PERK_REFUNDED" || t === "ACQUISITION_TRADE_PERK") return "stock_perk";

  // Cash flow
  if (t === "PAYMENT_INBOUND" || t === "BANK_TRANSACTION_INCOMING") return "deposit";
  if (
    t === "PAYMENT_OUTBOUND" ||
    t === "BANK_TRANSACTION_OUTGOING" ||
    t === "SSP_SECURITIES_TRANSFER_OUTGOING"
  )
    return "withdrawal";

  // Card
  if (t === "CARD_REFUND") return "card_refund";
  if (t === "CARD_ATM_WITHDRAWAL") return "atm_withdrawal";
  if (t === "CARD_VERIFICATION") return "card_verify";
  if (t === "CARD_ORDER_FEE") return "fee";
  if (t.startsWith("CARD_")) return "card";

  // Documents / reports
  if (
    t === "TAX_YEAR_END_REPORT_CREATED" ||
    t === "EX_POST_COST_REPORT_CREATED" ||
    t === "QUARTERLY_REPORT" ||
    t.startsWith("DOCUMENTS_")
  )
    return "document";

  // Admin
  if (t === "PRIVATE_MARKETS_SUITABILITY_QUIZ_COMPLETED") return "admin";

  return "other";
}

function normalise(e: RawEvent): NormalizedTxn | null {
  const id = e.id ?? `${e.timestamp ?? ""}-${e.eventType ?? ""}`;
  if (!id || !e.timestamp) return null;
  const rawType = String(e.eventType ?? "");
  const amountEur =
    typeof e.amount?.value === "number" && (e.amount.currency ?? "EUR") === "EUR"
      ? e.amount.value
      : null;
  return {
    id,
    date: e.timestamp,
    type: categorise(rawType, amountEur),
    description: [e.title, e.subtitle].filter(Boolean).join(" — "),
    amountEur,
    rawType,
  };
}

async function spawnHelper(outDir: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(pyExecutable(), [PY_HELPER, outDir], {
      stdio: ["ignore", "pipe", DEBUG ? "inherit" : "pipe"],
      cwd: ROOT,
    });
    let lastLine = "";
    proc.stdout?.on("data", (b) => {
      lastLine = b.toString().trim().split("\n").pop() ?? lastLine;
    });
    let errOut = "";
    if (!DEBUG) {
      proc.stderr?.on("data", (b) => (errOut += b.toString()));
    }
    proc.on("error", (e) =>
      resolve({ ok: false, error: `spawn failed: ${e.message}` })
    );
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // Helper emits structured errors as JSON on stdout's last line.
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed?.error?.message) {
          resolve({ ok: false, error: parsed.error.message });
          return;
        }
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        error: `pytr helper exited ${code}: ${errOut.trim().slice(-400) || lastLine.slice(-400)}`,
      });
    });
  });
}

async function readEventsFromExport(outDir: string): Promise<RawEvent[]> {
  // pytr writes events_with_documents.json (events that have linked PDFs)
  // and other_events.json (everything else). We want both.
  const candidates = [
    path.join(outDir, "events_with_documents.json"),
    path.join(outDir, "other_events.json"),
  ];
  const all: RawEvent[] = [];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) all.push(...(parsed as RawEvent[]));
    } catch {
      /* file not present is fine */
    }
  }
  return all;
}

async function writeJsonl(rows: NormalizedTxn[]) {
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  // Replace, not append — full export every run keeps things idempotent.
  await fs.writeFile(
    OUT_FILE,
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
    "utf8"
  );
}

async function main() {
  console.log("[tr-tx] downloading TR timeline via pytr…");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tr-events-"));
  try {
    const r = await spawnHelper(tmp);
    if (!r.ok) {
      console.error(`[tr-tx] error: ${r.error}`);
      void notify({
        title: "TR transactions sync failed",
        body: r.error ?? "unknown",
        priority: "high",
      });
      process.exit(2);
    }

    const raw = await readEventsFromExport(tmp);
    console.log(`[tr-tx] received ${raw.length} raw events`);
    const normalised: NormalizedTxn[] = [];
    for (const e of raw) {
      const n = normalise(e);
      if (n) normalised.push(n);
    }
    normalised.sort((a, b) => b.date.localeCompare(a.date));

    await writeJsonl(normalised);

    // Quick summary by category
    const byType = new Map<string, number>();
    for (const t of normalised) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
    console.log(`[tr-tx] wrote ${normalised.length} → ${OUT_FILE}`);
    for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`         ${k.padEnd(14)} ${v}`);
    }
  } finally {
    if (!DEBUG) {
      try {
        await fs.rm(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      console.log(`[tr-tx] (debug) raw export kept at ${tmp}`);
    }
  }
}

main().catch((err) => {
  console.error("[tr-tx] fatal:", err);
  process.exit(1);
});
