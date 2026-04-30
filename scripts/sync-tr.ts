#!/usr/bin/env -S npx tsx
/**
 * Trade Republic sync via pytr (LOCAL ONLY — never deploy).
 *
 * Setup once:
 *     uv tool install pytr   (or: pip install pytr)
 *     pytr login             # SMS or push 2FA, saves session to ~/.pytr/
 *
 * Sync:
 *     npm run sync:tr        # silent, uses saved session
 *     npm run sync:tr -- --debug   # verbose, includes pytr stderr
 *
 * Re-auth: when pytr's session expires (every few weeks), this script will
 * exit with `auth_failed` and a desktop notification. Re-run `pytr login`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify } from "./lib/notify";
import { patchState } from "./lib/sync-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORTFOLIO_FILE = path.join(ROOT, "data", "portfolio.json");
const EVENTS_FILE = path.join(ROOT, "data", "events.jsonl");
const PY_HELPER = path.join(__dirname, "tr_fetch.py");

const args = process.argv.slice(2);
const argHas = (flag: string) => args.includes(flag);
const DEBUG = argHas("--debug");
const NOTIFY = !argHas("--no-notify");

// ---------- types ----------
type TrPosition = {
  isin: string;
  name: string;
  quantity: number;
  value: number;
  averagePrice: number | null;
};
type TrCash = { currency: string; amount: number };
type TrFetchResult =
  | {
      ok: true;
      fetched_at: string;
      positions: TrPosition[];
      cash: TrCash[];
    }
  | {
      ok: false;
      error: { code: string; message: string; hint?: string };
    };

type Asset = {
  id: string;
  name: string;
  type: string;
  source: string;
  currency: "EUR" | "USD";
  isin?: string;
  ticker?: string;
  quantity?: number;
  manualPrice?: number;
  amount?: number;
  costBasis?: number;
  faceValue?: number;
  marketValueOverride?: number;
  updatedAt: string;
  [k: string]: unknown;
};
type Portfolio = { version: number; assets: Asset[]; updatedAt: string };

// ---------- io ----------
async function readPortfolio(): Promise<Portfolio> {
  return JSON.parse(await fs.readFile(PORTFOLIO_FILE, "utf8"));
}
async function writePortfolio(p: Portfolio): Promise<void> {
  p.updatedAt = new Date().toISOString();
  await fs.writeFile(PORTFOLIO_FILE, JSON.stringify(p, null, 2), "utf8");
}
async function appendEvent(event: object): Promise<void> {
  await fs.appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf8");
}

// ---------- pytr availability ----------
function findPytrHelper(): string {
  // Resolution order:
  //   1. TR_PYTHON env override.
  //   2. ./.venv/bin/python3  (project virtualenv created via `python3 -m venv .venv`)
  //   3. system python3
  if (process.env.TR_PYTHON) return process.env.TR_PYTHON;
  const venvPy = path.join(ROOT, ".venv", "bin", "python3");
  try {
    require("node:fs").accessSync(venvPy);
    return venvPy;
  } catch {
    /* fall through */
  }
  return "python3";
}

// Notification wrapper that respects --no-notify.
async function alert(
  title: string,
  body: string,
  priority: "low" | "normal" | "high" = "normal"
): Promise<void> {
  if (!NOTIFY) return;
  await notify({ title, body, priority });
}

// ---------- run pytr helper ----------
function runHelper(): Promise<TrFetchResult> {
  return new Promise((resolve) => {
    const py = findPytrHelper();
    const helperArgs = [PY_HELPER, ...(DEBUG ? ["--debug"] : [])];
    const proc = spawn(py, helperArgs, {
      stdio: ["ignore", "pipe", DEBUG ? "inherit" : "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (b) => (out += b.toString()));
    if (!DEBUG) {
      proc.stderr?.on("data", (b) => (err += b.toString()));
    }
    proc.on("error", (e) => {
      resolve({
        ok: false,
        error: {
          code: "spawn_failed",
          message: `failed to spawn ${py}: ${e.message}`,
          hint:
            "Install Python and pytr: `uv tool install pytr` or `pip install pytr`. " +
            "Then run `pytr login` once.",
        },
      });
    });
    proc.on("exit", (code) => {
      const trimmed = out.trim();
      // Helper always emits a single JSON line on the last line of stdout.
      const lastLine = trimmed.split("\n").pop() ?? "";
      try {
        const parsed = JSON.parse(lastLine) as TrFetchResult;
        resolve(parsed);
        return;
      } catch {
        /* fall through */
      }
      resolve({
        ok: false,
        error: {
          code: "bad_helper_output",
          message: `pytr helper exited with code ${code}; output not JSON.`,
          hint: err.trim() || trimmed.slice(0, 400),
        },
      });
    });
  });
}

// ---------- mapping ----------
function findAssetByIsin(
  portfolio: Portfolio,
  isin: string
): Asset | undefined {
  return portfolio.assets.find((a) => a.isin === isin);
}

function findCashAsset(portfolio: Portfolio): Asset | undefined {
  // Prefer the explicit Trade Republic cash asset; fall back to first "cash" or
  // "interest_account" with source "trade-republic".
  return (
    portfolio.assets.find(
      (a) =>
        a.source === "trade-republic" &&
        (a.type === "interest_account" || a.type === "cash") &&
        (a.id === "tr-cash" || true)
    ) ?? undefined
  );
}

async function applyUpdates(
  portfolio: Portfolio,
  data: Extract<TrFetchResult, { ok: true }>
): Promise<{ updated: number; skipped: number; details: string[] }> {
  const details: string[] = [];
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  // 1. Positions by ISIN
  for (const p of data.positions) {
    const asset = findAssetByIsin(portfolio, p.isin);
    if (!asset) {
      details.push(`  ? unknown ISIN ${p.isin} (${p.name}) qty=${p.quantity} value=€${p.value.toFixed(2)} — no matching asset`);
      skipped++;
      continue;
    }
    const before = {
      quantity: asset.quantity,
      manualPrice: asset.manualPrice,
      costBasis: asset.costBasis,
      marketValueOverride: asset.marketValueOverride,
    };
    let changedKeys: string[] = [];

    // pytr's compactPortfolio returns quantity + average buy-in price, but
    // not current value (value is 0 in compact view). We sync the structural
    // facts (qty + cost basis) and leave price discovery to our live feeds
    // (Yahoo / Stooq / CoinGecko) or the user's manualPrice override.

    if (asset.type === "etf" || asset.type === "stock" || asset.type === "crypto") {
      if (p.quantity > 0 && asset.quantity !== p.quantity) {
        asset.quantity = p.quantity;
        changedKeys.push("quantity");
      }
      if (p.averagePrice !== null && p.quantity > 0) {
        const totalCost = Number((p.averagePrice * p.quantity).toFixed(2));
        if (asset.costBasis !== totalCost) {
          asset.costBasis = totalCost;
          changedKeys.push("costBasis");
        }
      }
    } else if (asset.type === "bond" || asset.type === "tbill") {
      // Bonds: track quantity and cost basis. Don't touch marketValueOverride —
      // pytr compactPortfolio doesn't have a usable current value, and our
      // existing engine accrues value over time from purchasePrice → faceValue.
      if (p.quantity > 0 && asset.quantity !== p.quantity) {
        asset.quantity = p.quantity;
        changedKeys.push("quantity");
      }
      if (p.averagePrice !== null && p.quantity > 0) {
        const totalCost = Number((p.averagePrice * p.quantity).toFixed(2));
        if (asset.costBasis !== totalCost) {
          asset.costBasis = totalCost;
          changedKeys.push("costBasis");
        }
      }
    }

    if (changedKeys.length > 0) {
      asset.updatedAt = now;
      await appendEvent({
        type: "asset.updated",
        at: now,
        assetId: asset.id,
        before,
        after: {
          quantity: asset.quantity,
          manualPrice: asset.manualPrice,
          costBasis: asset.costBasis,
          marketValueOverride: asset.marketValueOverride,
        },
        via: "pytr",
      });
      details.push(
        `  ✓ ${asset.id} (${p.isin}): ${changedKeys.join(", ")} — value €${p.value.toFixed(2)}`
      );
      updated++;
    } else {
      details.push(`  = ${asset.id} (${p.isin}): unchanged`);
    }
  }

  // 2. Cash — pick EUR row, sum if multiple
  const eurCash = data.cash
    .filter((c) => (c.currency || "EUR").toUpperCase() === "EUR")
    .reduce((sum, c) => sum + c.amount, 0);
  if (data.cash.length > 0) {
    const cashAsset = findCashAsset(portfolio);
    if (cashAsset) {
      const before = cashAsset.amount;
      if (before !== eurCash) {
        cashAsset.amount = Number(eurCash.toFixed(2));
        cashAsset.updatedAt = now;
        await appendEvent({
          type: "asset.updated",
          at: now,
          assetId: cashAsset.id,
          before: { amount: before },
          after: { amount: cashAsset.amount },
          via: "pytr",
        });
        details.push(
          `  ✓ ${cashAsset.id}: cash ${before ?? "—"} → €${cashAsset.amount.toFixed(2)}`
        );
        updated++;
      } else {
        details.push(`  = ${cashAsset.id}: cash unchanged €${eurCash.toFixed(2)}`);
      }
    } else {
      details.push(`  ? no TR cash asset found in portfolio.json — got €${eurCash.toFixed(2)}`);
      skipped++;
    }
  }

  return { updated, skipped, details };
}

// ---------- main ----------
async function main() {
  await patchState("tr", {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    lastError: undefined,
    message: "Fetching portfolio…",
  });

  console.log("[tr] fetching portfolio via pytr…");
  const result = await runHelper();

  if (!result.ok) {
    console.error(`[tr] error (${result.error.code}): ${result.error.message}`);
    if (result.error.hint) console.error(`     hint: ${result.error.hint}`);
    const needsLogin =
      result.error.code === "auth_failed" || result.error.code === "no_session";
    await patchState("tr", {
      status: needsLogin ? "needs_setup" : "error",
      finishedAt: new Date().toISOString(),
      lastError: result.error.message,
      message: needsLogin
        ? "Session expired — run `npm run sync:tr:setup` to re-auth"
        : result.error.message,
    });
    if (needsLogin) {
      await alert(
        "Trade Republic — re-auth needed",
        "Your pytr session has expired. Run `npm run sync:tr:setup` to refresh.",
        "high"
      );
    } else {
      await alert("Trade Republic sync failed", result.error.message, "normal");
    }
    process.exit(2);
  }

  console.log(
    `[tr] received ${result.positions.length} positions, ${result.cash.length} cash entries`
  );

  const portfolio = await readPortfolio();
  const { updated, skipped, details } = await applyUpdates(portfolio, result);
  for (const line of details) console.log(line);

  if (updated > 0) {
    await writePortfolio(portfolio);
    console.log(`[tr] portfolio updated · ${updated} change(s), ${skipped} skipped`);
    void alert("Trade Republic synced", `${updated} update(s) written.`, "low");
  } else {
    console.log(`[tr] no changes (${skipped} unmatched ISINs)`);
  }

  await patchState("tr", {
    status: "success",
    finishedAt: new Date().toISOString(),
    message: updated > 0 ? `${updated} update(s) written` : "No changes",
  });
}

main().catch(async (err) => {
  console.error("[tr] fatal:", err);
  await patchState("tr", {
    status: "error",
    finishedAt: new Date().toISOString(),
    lastError: err instanceof Error ? err.message : String(err),
  }).catch(() => undefined);
  await alert("Trade Republic sync crashed", String(err?.message ?? err), "high");
  process.exit(1);
});
