#!/usr/bin/env -S npx tsx
/**
 * Run `pytr login` headlessly: phone + PIN come from .env.local; the SMS / push
 * verification code is read from the sync state queue file (web UI submits it).
 * Stdio is piped, not inherited, so the dashboard's OTP modal drives the flow.
 *
 * Lifecycle:
 *   running → needs_otp (waiting on web-UI POST) → success | error
 *
 * Run:  npm run sync:tr:setup        # web-driven (default)
 *       TR_SETUP_INTERACTIVE=1 npm run sync:tr:setup   # legacy: pipe to terminal
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify } from "./lib/notify";
import {
  clearOtp,
  patchState,
  waitForQueuedOtp,
} from "./lib/sync-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load .env.local first.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(ROOT, f));
  } catch {
    /* ignore */
  }
}

const phone = process.env.TR_PHONE_NUMBER?.trim();
const pin = process.env.TR_PIN?.trim();
const interactive = process.env.TR_SETUP_INTERACTIVE === "1";

async function fail(msg: string, hint?: string): Promise<never> {
  console.error(`[tr-setup] ${msg}${hint ? `\n            ${hint}` : ""}`);
  await patchState("tr", {
    status: "error",
    finishedAt: new Date().toISOString(),
    lastError: msg,
  }).catch(() => undefined);
  process.exit(1);
}

async function main() {
  if (!phone || !pin) {
    await fail(
      "TR_PHONE_NUMBER and TR_PIN must be set in .env.local",
      "  TR_PHONE_NUMBER=+30...        # international format\n            TR_PIN=1234"
    );
  }

  await clearOtp("tr");
  await patchState("tr", {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    lastError: undefined,
    message: "Logging into Trade Republic…",
  });

  const venvPytr = path.join(ROOT, ".venv", "bin", "pytr");
  const pytrCmd = fs.existsSync(venvPytr) ? venvPytr : "pytr";
  console.log(
    `[tr-setup] launching ${pytrCmd === venvPytr ? ".venv/bin/pytr" : "pytr"} login for ${phone}`
  );

  const child = spawn(
    pytrCmd,
    ["login", "--phone_no", phone!, "--pin", pin!, "--store_credentials"],
    { stdio: ["pipe", "pipe", "pipe"] }
  ) as ChildProcessWithoutNullStreams;

  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    handleOutput(text, child);
  };
  const onErr = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);
    handleOutput(text, child);
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onErr);

  // pytr login emits a couple of lines around the SMS prompt:
  //   "Enter the code you received to your mobile app as a notification."
  //   "Enter nothing if you want to receive the (same) code as SMS. (Countdown: …"
  //   "Code: "
  // Then waits on stdin. After we send the code, pytr can RE-PROMPT (e.g. it
  // emits "SMS requested. Enter the confirmation code:" if the first code is
  // empty/wrong) — we need to re-detect and ask the user again.
  let otpInflight = false;
  function handleOutput(text: string, proc: ChildProcessWithoutNullStreams) {
    if (otpInflight) return;
    if (/Enter the code|Enter nothing|Code:|confirmation code/i.test(text)) {
      otpInflight = true;
      void deliverOtp(proc).finally(() => {
        // Re-arm so any subsequent prompt fires another modal.
        otpInflight = false;
      });
    }
  }

  async function deliverOtp(proc: ChildProcessWithoutNullStreams) {
    console.log("[tr-setup] waiting for OTP (web UI or stdin)…");
    await patchState("tr", {
      status: "needs_otp",
      message:
        "Trade Republic sent a code (4-digit) to your phone — enter it in the dashboard.",
    });
    await notify({
      title: "Trade Republic — code needed",
      body:
        "Open the dashboard and paste the 4-digit verification code from your TR app/SMS.",
      priority: "high",
    });

    // 5-minute window; the SMS itself is short-lived.
    const code = await waitForQueuedOtp("tr", 5 * 60_000);
    if (!code) {
      console.error("[tr-setup] OTP wasn't provided in time — aborting");
      proc.kill("SIGTERM");
      await patchState("tr", {
        status: "error",
        finishedAt: new Date().toISOString(),
        lastError: "Re-auth timed out (no OTP entered).",
      });
      process.exit(2);
    }
    console.log("[tr-setup] received OTP, sending to pytr");
    await patchState("tr", { status: "running", message: "Submitting code…" });
    proc.stdin.write(code + "\n");
    // Brief grace period so we don't immediately re-arm on the still-buffered
    // prompt text we just answered.
    await new Promise((r) => setTimeout(r, 1500));
  }

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", async (err) => {
      console.error("[tr-setup] failed to spawn pytr:", err.message);
      await patchState("tr", {
        status: "error",
        finishedAt: new Date().toISOString(),
        lastError: `failed to spawn pytr: ${err.message}`,
      }).catch(() => undefined);
      resolve(1);
    });
  });

  if (exitCode === 0) {
    console.log("[tr-setup] success — credentials saved.");
    await patchState("tr", {
      status: "success",
      finishedAt: new Date().toISOString(),
      message: "Re-auth complete — run sync to refresh data.",
    });
    void notify({
      title: "Trade Republic re-auth complete",
      body: "Click Sync to refresh your portfolio.",
      priority: "low",
    });
  } else {
    await patchState("tr", {
      status: "error",
      finishedAt: new Date().toISOString(),
      lastError: `pytr login exited ${exitCode}`,
    });
  }
  process.exit(exitCode);
}

if (interactive) {
  // Legacy path: just run pytr with inherited stdio (terminal flow).
  const venvPytr = path.join(ROOT, ".venv", "bin", "pytr");
  const pytrCmd = fs.existsSync(venvPytr) ? venvPytr : "pytr";
  if (!phone || !pin) {
    console.error(
      "[tr-setup] TR_PHONE_NUMBER and TR_PIN must be set in .env.local"
    );
    process.exit(1);
  }
  const child = spawn(
    pytrCmd,
    ["login", "--phone_no", phone, "--pin", pin, "--store_credentials"],
    { stdio: "inherit" }
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  main().catch(async (err) => {
    console.error("[tr-setup] fatal:", err);
    await patchState("tr", {
      status: "error",
      finishedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    process.exit(1);
  });
}
