#!/usr/bin/env -S npx tsx
/**
 * Run every available sync (TR, NBG, myDATA) in sequence.
 * Per-sync failures don't abort the rest — we just collect status and report.
 *
 * Usage:
 *     npm run sync:all
 *     npm run sync:all -- --skip-nbg          # TR + myDATA + aade-card only
 *     npm run sync:all -- --skip-tr           # NBG + myDATA + aade-card only
 *     npm run sync:all -- --skip-mydata       # skip AADE myDATA REST
 *     npm run sync:all -- --skip-aade-card    # skip TaxisNet card-spend scrape
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify } from "./lib/notify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const skipNbg = args.includes("--skip-nbg");
const skipTr = args.includes("--skip-tr");
const skipMyData = args.includes("--skip-mydata");
const skipAadeCard = args.includes("--skip-aade-card");

type StepResult = { name: string; ok: boolean; exitCode: number; durationMs: number };

function runStep(name: string, cmd: string, cmdArgs: string[]): Promise<StepResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n──── ${name} ────`);
    const proc = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
    });
    proc.on("error", (e) => {
      console.error(`[${name}] spawn error:`, e.message);
      resolve({ name, ok: false, exitCode: -1, durationMs: Date.now() - start });
    });
    proc.on("exit", (code) => {
      const ok = code === 0;
      const durationMs = Date.now() - start;
      resolve({ name, ok, exitCode: code ?? -1, durationMs });
    });
  });
}

async function main() {
  const results: StepResult[] = [];
  if (!skipTr) {
    results.push(
      await runStep("Trade Republic", "npx", ["tsx", "scripts/sync-tr.ts"])
    );
  }
  if (!skipNbg) {
    results.push(
      await runStep("NBG", "npx", ["tsx", "scripts/sync-nbg.ts"])
    );
  }
  if (!skipMyData && process.env.AADE_USER_ID && process.env.AADE_SUBSCRIPTION_KEY) {
    results.push(
      await runStep("myDATA", "npx", ["tsx", "scripts/sync-mydata.ts"])
    );
  }
  if (
    !skipAadeCard &&
    process.env.AADE_TAXISNET_USERNAME &&
    process.env.AADE_TAXISNET_PASSWORD
  ) {
    results.push(
      await runStep("AADE card-spend", "npx", ["tsx", "scripts/sync-aade-card.ts"])
    );
  }

  console.log("\n──── summary ────");
  for (const r of results) {
    const status = r.ok ? "✓" : "✗";
    const t = (r.durationMs / 1000).toFixed(1);
    console.log(`  ${status} ${r.name.padEnd(16)}  exit=${r.exitCode}  ${t}s`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    void notify({
      title: "Portfolio sync — partial failure",
      body: failed.map((r) => `${r.name}: exit ${r.exitCode}`).join(" · "),
      priority: "high",
      channels: { email: false }, // operational pings → ntfy only
    });
    process.exit(1);
  } else if (results.length > 0) {
    console.log(`\nAll ${results.length} sync(s) completed successfully.`);
  }
}

main().catch((err) => {
  console.error("[sync-all] fatal:", err);
  process.exit(1);
});
