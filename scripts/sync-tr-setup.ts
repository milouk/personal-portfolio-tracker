#!/usr/bin/env -S npx tsx
/**
 * Run `pytr login` with phone + PIN pulled from .env.local.
 *
 * Inherits stdio so the SMS / push-confirmation prompt is interactive in your
 * terminal. After success, ~/.pytr/{credentials,cookies.txt} is written and
 * `npm run sync:tr` runs silently for weeks until the session expires.
 *
 * Run:    npm run sync:tr:setup
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

if (!phone || !pin) {
  console.error(
    "[tr-setup] TR_PHONE_NUMBER and TR_PIN must be set in .env.local.\n" +
      "  TR_PHONE_NUMBER=+30...        # international format\n" +
      "  TR_PIN=1234                   # your 4-digit TR app PIN"
  );
  process.exit(1);
}

const venvPytr = path.join(ROOT, ".venv", "bin", "pytr");
const pytrCmd = fs.existsSync(venvPytr) ? venvPytr : "pytr";

console.log(
  `[tr-setup] launching \`${pytrCmd === venvPytr ? ".venv/bin/pytr" : "pytr"} login\` for ${phone}\n` +
    `[tr-setup] you'll see a prompt for the verification code from TR app or SMS.\n`
);

const child = spawn(
  pytrCmd,
  ["login", "--phone_no", phone, "--pin", pin, "--store_credentials"],
  { stdio: "inherit" }
);

child.on("error", (err) => {
  console.error(`[tr-setup] could not run pytr: ${err.message}`);
  console.error(
    "Install dependencies first:\n  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  );
  process.exit(1);
});

child.on("exit", (code) => {
  if (code === 0) {
    console.log(
      "\n[tr-setup] success — credentials saved. " +
        "You can now run `npm run sync:tr`."
    );
  }
  process.exit(code ?? 1);
});
