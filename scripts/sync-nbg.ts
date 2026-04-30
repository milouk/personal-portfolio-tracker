#!/usr/bin/env -S npx tsx
/**
 * NBG i-Bank balance sync via Playwright. Linux/Docker compatible.
 *
 * Two modes:
 *   1. setup → opens headed browser; log in by hand; persistent profile saves session.
 *   2. run   → headless; reuses persistent profile; scrapes balance; updates portfolio.json.
 *
 * Credentials:
 *   NBG_USERNAME, NBG_PASSWORD — set in .env.local (file-based, Docker-safe).
 *
 * OTP delivery (Viber on phone, no SMS to host):
 *   NBG_OTP_SOURCE=manual    — stdin prompt (TTY only). Default.
 *   NBG_OTP_SOURCE=webhook   — script starts a tiny HTTP listener on
 *                              NBG_OTP_PORT (default 4848). POST the code:
 *                                curl -d 123456 http://host:4848/otp
 *
 * Selectors (rarely need to override):
 *   NBG_USERNAME_SELECTOR / NBG_PASSWORD_SELECTOR / NBG_LOGIN_BUTTON
 *   NBG_ACCOUNT_LABEL                       — single-asset fallback
 *   NBG_MAPPINGS=<label>:<asset-id>,...     — multi-asset mapping
 *
 * Usage:
 *   npm run sync:nbg:setup             # one-time: log in by hand
 *   npm run sync:nbg                   # subsequent runs (headless)
 *   npm run sync:nbg -- --headed       # debug visible browser
 *   npm run sync:nbg -- --otp=123456   # CI / pipe the OTP in
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type Page } from "playwright";
import { notify, notifyAsync } from "./lib/notify";
import { waitForOtp } from "./lib/otp-sources";
import {
  clearOtp,
  patchState,
  waitForQueuedOtp,
} from "./lib/sync-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load .env.local (and .env as fallback) — silent if missing.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(ROOT, f));
  } catch {
    /* file missing or unreadable, ignore */
  }
}
const PORTFOLIO_FILE = path.join(ROOT, "data", "portfolio.json");
const EVENTS_FILE = path.join(ROOT, "data", "events.jsonl");
const PROFILE_DIR = path.join(ROOT, "data", "nbg", "profile");
const LOGS_DIR = path.join(ROOT, "data", "nbg", "logs");

const LOGIN_URL = "https://ebanking.nbg.gr/web";
// After login, NBG redirects to ibank.nbg.gr — that's where the actual app lives.
const DASHBOARD_URL = "https://ibank.nbg.gr/";

// ---------- args ----------
const args = process.argv.slice(2);
const argHas = (flag: string) => args.includes(flag);
const argVal = (flag: string) => {
  const a = args.find((x) => x.startsWith(`${flag}=`));
  return a ? a.slice(flag.length + 1) : undefined;
};

const MODE: "setup" | "run" = argHas("--setup") ? "setup" : "run";
const HEADED = argHas("--headed") || MODE === "setup";
const ASSET_ID = argVal("--asset-id") ?? "nbg-savings";
const OTP_ARG = argVal("--otp");

// ---------- portfolio I/O (no Next.js, no server-only) ----------
type Asset = {
  id: string;
  name: string;
  type: string;
  source: string;
  currency: "EUR" | "USD";
  amount?: number;
  updatedAt: string;
  [k: string]: unknown;
};
type Portfolio = { version: number; assets: Asset[]; updatedAt: string };

async function readPortfolio(): Promise<Portfolio> {
  const raw = await fs.readFile(PORTFOLIO_FILE, "utf8");
  return JSON.parse(raw) as Portfolio;
}
async function writePortfolio(p: Portfolio): Promise<void> {
  p.updatedAt = new Date().toISOString();
  await fs.writeFile(PORTFOLIO_FILE, JSON.stringify(p, null, 2), "utf8");
}
async function appendEvent(event: object): Promise<void> {
  await fs.appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf8");
}

// ---------- credentials ----------
function resolvePassword(): { value: string; source: string } | null {
  const fromEnv = process.env.NBG_PASSWORD?.trim();
  if (fromEnv) return { value: fromEnv, source: ".env.local" };
  return null;
}

// ---------- helpers ----------
function ensureDir(p: string): Promise<void> {
  return fs.mkdir(p, { recursive: true }).then(() => undefined);
}
function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function snap(page: Page, label: string): Promise<string> {
  await ensureDir(LOGS_DIR);
  const file = path.join(LOGS_DIR, `${ts()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// Parse "1.234,56" or "1,234.56" or plain numbers into a number
function parseAmount(s: string): number | null {
  const cleaned = s.replace(/[^\d.,\-]/g, "").trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    // European: 1.234,56 → 1234.56
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// ---------- main ----------
async function main(): Promise<void> {
  await ensureDir(PROFILE_DIR);
  await clearOtp("nbg");
  await patchState("nbg", {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    lastError: undefined,
    message: "Connecting…",
  });

  const username = process.env.NBG_USERNAME?.trim();
  const passwordEntry = resolvePassword();
  const password = passwordEntry?.value;
  const profileExists = await fs
    .stat(path.join(PROFILE_DIR, "Default"))
    .then(() => true)
    .catch(() => false);

  if (MODE === "setup") {
    console.log("[nbg] SETUP mode — browser opens, log in by hand.");
    if (username && password)
      console.log(
        `[nbg] credentials available (password from ${passwordEntry?.source}) — will pre-fill if a login form appears.`
      );
  } else {
    if (!profileExists && !(username && password)) {
      console.error(
        "[nbg] No browser profile and no credentials. Either:\n" +
          "  • fill NBG_USERNAME + NBG_PASSWORD in .env.local, or\n" +
          "  • run `npm run sync:nbg:setup` to log in interactively (recommended)."
      );
      process.exit(1);
    }
    if (username && password) {
      console.log(`[nbg] using password from ${passwordEntry?.source}`);
    }
  }

  // Persistent context preserves cookies, localStorage, IndexedDB, and the
  // browser fingerprint between script runs — required for NBG's
  // "remember this browser" mechanism to actually persist.
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const hasStorageState = profileExists;

  // If we have saved cookies, try the dashboard directly first.
  let onDashboard = false;
  if (hasStorageState && MODE === "run") {
    console.log(`[nbg] trying saved session at ${DASHBOARD_URL}`);
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: "load", timeout: 20_000 });
      await page.waitForTimeout(2000);
      const url = page.url();
      const isSignedOut = /signedout|signin|login|signed-out/i.test(url);
      const stillNeedsLogin = await page
        .locator('input[type="password"], button:has-text("Συνδέομαι")')
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      const onLoginHost = url.includes("ebanking.nbg.gr");
      if (!stillNeedsLogin && !onLoginHost && !isSignedOut) {
        console.log(`[nbg] cookies still valid — skipping login (now on ${url})`);
        onDashboard = true;
        await snap(page, "01-dashboard-via-cookie");
      } else {
        console.log(
          `[nbg] cookies expired (url=${url}) — running full login flow`
        );
      }
    } catch (e) {
      console.warn("[nbg] dashboard probe failed:", e);
    }
  }

  if (!onDashboard) {
    console.log(`[nbg] navigating to ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: "load" });
  }

  // NBG SPA takes a few seconds to hydrate. Give it a real chance to settle.
  try {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
  } catch {
    /* keep going */
  }
  await page.waitForTimeout(1500);
  await snap(page, "00-landing");

  // Step 0: dismiss cookie banner if present (it overlays the login buttons).
  if (!onDashboard) {
    try {
      const cookieBtn = page.getByText(/Αποδοχή Όλων|Accept All/i).first();
      if (await cookieBtn.isVisible({ timeout: 3_000 })) {
        console.log("[nbg] dismissing cookie banner");
        await cookieBtn.click();
        await page.waitForTimeout(500);
      }
    } catch {
      /* no cookie banner, fine */
    }
  }

  // Step 1: role-pick page has two "Συνδέομαι" buttons (Individual / Business).
  // First one is the Individual card (left side).
  if (!onDashboard) {
    try {
      const loginButtons = page.getByText(/Συνδέομαι|^Login$/i);
      const count = await loginButtons.count();
      if (count > 0) {
        console.log(`[nbg] role-pick page detected (${count} login buttons) — clicking Individual`);
        await loginButtons.first().click();
        await page
          .waitForSelector('input[type="password"]', { timeout: 20_000 })
          .catch(() => undefined);
        await snap(page, "01-after-rolepick-click");
      }
    } catch (e) {
      console.warn("[nbg] role-pick click failed:", e);
    }
  }

  // Step 2: NBG uses a two-step form — username → "Συνέχω" → password.
  // Skip everything if cookies already got us to the dashboard.
  if (onDashboard) {
    /* fall through to balance scrape */
  } else {
  const usernameInput = page
    .locator(
      'input[name="userId"], input[name="username"], input[placeholder*="Username" i], #userId'
    )
    .first();
  const usernameVisible = await usernameInput
    .isVisible({ timeout: 6_000 })
    .catch(() => false);

  const passwordInputAhead = page.locator('input[type="password"]').first();
  const passwordVisibleNow = await passwordInputAhead
    .isVisible({ timeout: 1_500 })
    .catch(() => false);

  if (!usernameVisible && !passwordVisibleNow) {
    console.log("[nbg] no login fields detected — assuming already authenticated");
  } else {
    if (!username || !password) {
      if (MODE !== "setup") {
        console.error(
          "[nbg] login form present but credentials missing. Fill .env.local or run setup."
        );
        await snap(page, "01-no-creds");
        await ctx.close();
        process.exit(2);
      }
      console.log("[nbg] complete login in the browser, then press Enter…");
      const rl = readline.createInterface({ input, output });
      await rl.question("");
      rl.close();
    } else {
      // Step 2a: username
      if (usernameVisible) {
        console.log("[nbg] filling username");
        await usernameInput.fill(username);
        await snap(page, "02a-username-filled");
        // Click "Συνέχω" / Continue / submit
        const continueBtn = page
          .locator(
            'button:has-text("Συνέχω"), button:has-text("Συνεχω"), button:has-text("Continue"), button[type="submit"]'
          )
          .first();
        try {
          await continueBtn.click({ timeout: 5_000 });
        } catch {
          await usernameInput.press("Enter");
        }
        // Wait for password field to appear
        await page
          .waitForSelector('input[type="password"]', { timeout: 20_000 })
          .catch(() => undefined);
      }
      // Step 2b: password
      const pw = page.locator('input[type="password"]').first();
      if (await pw.isVisible({ timeout: 5_000 }).catch(() => false)) {
        console.log("[nbg] filling password");
        await pw.fill(password);
        await snap(page, "02b-password-filled");
        const submitBtn = page
          .locator(
            'button:has-text("Είσοδος"), button:has-text("Σύνδεση"), button:has-text("Συνέχω"), button:has-text("Login"), button[type="submit"]'
          )
          .first();
        try {
          await submitBtn.click({ timeout: 5_000 });
        } catch {
          await pw.press("Enter");
        }
        // Wait briefly for either OTP page or dashboard
        await page.waitForTimeout(2500);
      } else {
        console.warn("[nbg] password field never appeared after username step");
      }

      // Step 2c: OTP / 2FA challenge if present.
      await snap(page, "02c-after-password");
      const otpInput = page
        .locator(
          'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[name*="token" i], input[type="tel"], input[inputmode="numeric"]'
        )
        .first();
      const otpVisible = await otpInput
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      if (otpVisible) {
        console.log("[nbg] OTP / 2FA challenge detected");
        await patchState("nbg", {
          status: "needs_otp",
          message: "Waiting for OTP — check Viber on your phone.",
        });
        // High-priority alert across all configured channels (email, ntfy).
        await notify({
          title: "NBG — OTP needed",
          body:
            "Open Viber on your phone for the 6-digit NBG OTP, then paste it " +
            "into the dashboard prompt or run `npm run sync:nbg -- --otp=<code>`. " +
            "OTP is valid for ~5 minutes.",
          priority: "high",
        });
        let code = OTP_ARG;

        // Resolution order: --otp arg > NBG_OTP_SOURCE > queue file > stdin TTY.
        // The queue file is how the web UI delivers OTPs (POST /api/sync/otp).
        if (!code) {
          const source = (process.env.NBG_OTP_SOURCE ?? "manual").toLowerCase();
          if (source !== "manual") {
            console.log(`[nbg] watching ${source} for a fresh OTP (up to 90s)…`);
            const found = await waitForOtp(source, 90_000);
            if (found) {
              code = found;
              console.log(`[nbg] auto-detected OTP from ${source}`);
            }
          }
        }

        // Always also poll the web-UI queue file in parallel with stdin —
        // whichever arrives first wins.
        if (!code) {
          const isTty = MODE === "setup" || HEADED || input.isTTY;
          const queueWatcher = waitForQueuedOtp("nbg", 5 * 60_000);
          let stdinPromise: Promise<string | null> | null = null;
          if (isTty) {
            const rl = readline.createInterface({ input, output });
            stdinPromise = rl
              .question(
                "[nbg] enter the OTP from your phone (or POST it via the dashboard): "
              )
              .then((s) => {
                rl.close();
                return s.trim() || null;
              });
          }
          const winners = await Promise.race(
            [queueWatcher, stdinPromise].filter(Boolean) as Promise<string | null>[]
          );
          if (winners) code = winners;
        }

        if (!code) {
          console.error("[nbg] no OTP provided (timed out)");
          await patchState("nbg", {
            status: "error",
            finishedAt: new Date().toISOString(),
            lastError: "OTP timeout",
          });
          notifyAsync({
            title: "NBG sync timed out",
            body: "OTP wasn't provided in time.",
            priority: "high",
          });
          await ctx.close();
          process.exit(5);
        }
        await patchState("nbg", { status: "running", message: "Submitting OTP…" });

        // Click into the input first, then type one digit at a time.
        try {
          await otpInput.click();
        } catch {
          /* ignore */
        }
        await page.keyboard.type(code, { delay: 60 });
        await page.waitForTimeout(400);
        await snap(page, "02d-otp-filled");

        // Scope the submit button to the OTP dialog, not the page.
        const dialog = page.locator('[role="dialog"], .modal, .ui-dialog').first();
        const dialogVisible = await dialog
          .isVisible({ timeout: 1500 })
          .catch(() => false);
        const otpSubmit = (dialogVisible ? dialog : page).locator(
          'button:has-text("Συνέχω"), button:has-text("Συνέχεια"), button:has-text("Επιβεβαίωση"), button:has-text("Confirm")'
        ).first();
        let submitted = false;
        try {
          await otpSubmit.click({ timeout: 4_000 });
          submitted = true;
        } catch {
          /* try Enter */
        }
        if (!submitted) {
          await otpInput.press("Enter").catch(() => undefined);
        }
        // Give the OTP submission a real chance to navigate.
        await page.waitForTimeout(5_000);
        await snap(page, "02e-after-otp-submit");
      }

      // Wait for navigation away from login (dashboard)
      try {
        await page.waitForLoadState("networkidle", { timeout: 30_000 });
      } catch {
        /* ignore */
      }
    }
  }
  } // end if (!onDashboard)

  // Persistent context auto-saves cookies/localStorage on close — no manual save needed.
  console.log("[nbg] session saved (persistent profile)");

  if (MODE === "setup") {
    console.log(
      "[nbg] setup complete. Now run `npm run sync:nbg` to scrape the balance."
    );
    await ctx.close();
    return;
  }

  // ---------- balance scrape ----------
  await snap(page, "02-post-login");

  const accountLabel =
    (process.env.NBG_ACCOUNT_LABEL ?? "ταμιευτηρίου").toLowerCase();
  const accounts = await listAccounts(page);
  console.log(`[nbg] found ${accounts.length} amounts on page:`);
  for (const a of accounts.slice(0, 20)) {
    console.log(`   €${a.amount.toFixed(2).padStart(12)}   ${a.label.slice(0, 60)}`);
  }
  await snap(page, "04-accounts-listed");

  // Build mapping list: NBG_MAPPINGS env (preferred) OR fallback to a single
  // mapping derived from --asset-id and NBG_ACCOUNT_LABEL.
  const mappings = parseMappings(
    process.env.NBG_MAPPINGS,
    accountLabel,
    ASSET_ID
  );
  console.log(`[nbg] applying ${mappings.length} mapping(s):`);

  const portfolio = await readPortfolio();
  let anyUpdated = false;
  for (const m of mappings) {
    const result = await extractBalance(page, m.label);
    if (!result) {
      console.warn(`   ✗ "${m.label}" → no match`);
      continue;
    }
    const idx = portfolio.assets.findIndex((a) => a.id === m.assetId);
    if (idx === -1) {
      console.warn(
        `   ✗ "${m.label}" matched €${result.amount.toFixed(2)} but asset "${m.assetId}" not in portfolio.json`
      );
      continue;
    }
    const asset = portfolio.assets[idx];
    const before = (asset[m.target] as number | undefined) ?? undefined;
    if (before === result.amount) {
      console.log(
        `   = "${m.label}" → ${m.assetId}.${m.target}: €${result.amount.toFixed(2)} (unchanged)`
      );
      continue;
    }
    const now = new Date().toISOString();
    asset[m.target] = result.amount;
    asset.updatedAt = now;
    await appendEvent({
      type: "asset.updated",
      at: now,
      assetId: m.assetId,
      before: { [m.target]: before },
      after: { [m.target]: result.amount },
      via: "playwright/nbg",
    });
    console.log(
      `   ✓ "${m.label}" → ${m.assetId}.${m.target}: ${before ?? "—"} → €${result.amount.toFixed(2)}`
    );
    anyUpdated = true;
  }

  // ---------- investments drill-down ----------
  // Click into the Επενδυτικά section (or whatever NBG calls it) and try to
  // discover per-position holdings. Match by ISIN to portfolio.json assets.
  const invResult = await scrapeInvestments(page);
  if (invResult.positions.length > 0) {
    console.log(`[nbg] discovered ${invResult.positions.length} investment position(s):`);
    for (const p of invResult.positions) {
      console.log(`   €${p.value.toFixed(2).padStart(12)}   ${p.isin ?? "(no ISIN)"}   ${p.name.slice(0, 50)}`);
    }
    const matched = await applyInvestmentUpdates(portfolio, invResult.positions);
    if (matched.updated > 0) anyUpdated = true;
    for (const line of matched.details) console.log(line);
  } else if (invResult.note) {
    console.log(`[nbg] investments drill-down: ${invResult.note}`);
  }

  if (anyUpdated) await writePortfolio(portfolio);
  else console.log("[nbg] nothing to update");

  await patchState("nbg", {
    status: "success",
    finishedAt: new Date().toISOString(),
    message: anyUpdated ? "Updated" : "No changes",
  });

  await ctx.close();
}

// ---------- investments drill-down ----------
type InvestmentPosition = {
  isin?: string;
  name: string;
  quantity?: number;
  value: number;
};

type InvestmentScrapeResult = {
  positions: InvestmentPosition[];
  note?: string;
};

async function scrapeInvestments(page: Page): Promise<InvestmentScrapeResult> {
  const sectionLabel =
    process.env.NBG_INVESTMENTS_LABEL ?? "Επενδυτικά";
  console.log(`[nbg] drilling into "${sectionLabel}" section…`);

  // Try to click the section heading or the first link inside it. NBG renders
  // the "Επενδυτικά" card as a heading + a "View all" / "Λεπτομέρειες" link.
  // We try two strategies: click a sibling button, then fall back to the
  // heading itself.
  const candidates = [
    `text=/^${sectionLabel}$/`,
    `a:has-text("${sectionLabel}")`,
    `button:has-text("${sectionLabel}")`,
    `[aria-label*="${sectionLabel}" i]`,
    `text=Λεπτομέρειες`,
    `text=Προβολή`,
  ];

  let clicked = false;
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 4000 });
        clicked = true;
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        await snap(page, "05-investments-section");
        break;
      }
    } catch {
      /* keep trying */
    }
  }

  if (!clicked) {
    return {
      positions: [],
      note:
        "couldn't find a clickable Επενδυτικά element. Set NBG_INVESTMENTS_LABEL " +
        "to the exact heading text or inspect 04-accounts-listed.png.",
    };
  }

  // Once on the investments page, dump body text and parse position rows.
  // Each row typically has: position name, possibly an ISIN (12 chars),
  // possibly a quantity, and a EUR amount. We pair rows + amounts heuristically.
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

  const reIsin = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
  const reAmount = /-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€?/;

  const positions: InvestmentPosition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isinMatch = lines[i].match(reIsin);
    if (!isinMatch) continue;
    const isin = isinMatch[1];
    // Look ahead up to 5 lines for an amount.
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join(" ");
    const amtMatch = window.match(reAmount);
    if (!amtMatch) continue;
    const value = parseAmount(amtMatch[0]);
    if (value === null) continue;
    // Use the first non-ISIN line near it as the name. Prefer line BEFORE the
    // ISIN (NBG puts security name on the previous row).
    const candidates = [lines[i - 1], lines[i - 2], lines[i + 1]]
      .map((s) => (s ?? "").trim())
      .filter((s) => s && !reIsin.test(s) && !reAmount.test(s) && s.length > 2);
    const name = candidates[0] ?? isin;
    positions.push({ isin, name, value });
  }

  return { positions };
}

async function applyInvestmentUpdates(
  portfolio: Portfolio,
  positions: InvestmentPosition[]
): Promise<{ updated: number; details: string[] }> {
  const details: string[] = [];
  let updated = 0;
  const now = new Date().toISOString();

  for (const p of positions) {
    if (!p.isin) {
      details.push(`   ? "${p.name}" (no ISIN) — skipped`);
      continue;
    }
    const idx = portfolio.assets.findIndex((a) => a.isin === p.isin);
    if (idx === -1) {
      details.push(
        `   ? ${p.isin} (€${p.value.toFixed(2)}) — no asset with this ISIN in portfolio.json. Add one to track.`
      );
      continue;
    }
    const asset = portfolio.assets[idx];
    const before = asset.marketValueOverride;
    if (before === p.value) {
      details.push(`   = ${asset.id} (${p.isin}): unchanged €${p.value.toFixed(2)}`);
      continue;
    }
    asset.marketValueOverride = Number(p.value.toFixed(2));
    asset.updatedAt = now;
    await appendEvent({
      type: "asset.updated",
      at: now,
      assetId: asset.id,
      before: { marketValueOverride: before },
      after: { marketValueOverride: asset.marketValueOverride },
      via: "playwright/nbg-investments",
    });
    details.push(
      `   ✓ ${asset.id} (${p.isin}): ${before ?? "—"} → €${p.value.toFixed(2)}`
    );
    updated++;
  }
  return { updated, details };
}

type MappingTarget = "amount" | "marketValueOverride";

function parseMappings(
  envValue: string | undefined,
  fallbackLabel: string,
  fallbackAssetId: string
): { label: string; assetId: string; target: MappingTarget }[] {
  if (envValue && envValue.trim()) {
    return envValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // Format: "<label>:<asset-id>" or "<label>:<asset-id>:<target>"
        // <target> defaults to "amount"; "marketValueOverride" routes the
        // matched value into that field instead (for tracking aggregate
        // investment positions where the bank shows a single mark-to-market).
        const parts = s.split(":");
        if (parts.length < 2 || parts.length > 3) {
          console.warn(
            `[nbg] ignoring malformed mapping "${s}" (need label:asset-id[:field])`
          );
          return null;
        }
        const target = (parts[2] ?? "amount").trim() as MappingTarget;
        if (target !== "amount" && target !== "marketValueOverride") {
          console.warn(
            `[nbg] mapping "${s}" has unknown target "${target}" — must be amount|marketValueOverride`
          );
          return null;
        }
        return {
          label: parts[0].trim(),
          assetId: parts[1].trim(),
          target,
        };
      })
      .filter(
        (m): m is { label: string; assetId: string; target: MappingTarget } =>
          m !== null
      );
  }
  return [{ label: fallbackLabel, assetId: fallbackAssetId, target: "amount" }];
}

type AccountCandidate = {
  label: string;
  amount: number;
  raw: string;
};

async function listAccounts(page: Page): Promise<AccountCandidate[]> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  } catch {
    /* ignore */
  }
  // Wait briefly for SPA balance widgets to populate
  await page.waitForTimeout(2000);

  const body = await page.locator("body").innerText();
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: AccountCandidate[] = [];
  // Greek format amounts: 1.234,56 € — match a number pattern with thousands sep
  const reAmount = /-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€?/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(reAmount);
    if (m) {
      const amt = parseAmount(m[0]);
      if (amt === null) continue;
      // Use the previous non-empty line as the label, fallback to current line
      let label = lines[i - 1]?.trim() ?? "";
      if (!label || label.length < 3 || /^\d/.test(label)) {
        label = line.replace(reAmount, "").trim() || lines[i - 2]?.trim() || "";
      }
      out.push({ label, amount: amt, raw: line });
    }
  }
  return out;
}

async function extractBalance(
  page: Page,
  accountLabel: string
): Promise<{ amount: number; matched: AccountCandidate } | null> {
  const accounts = await listAccounts(page);
  if (accounts.length === 0) return null;

  const needle = accountLabel.toLowerCase();
  // 1. Exact-substring match on label
  let match = accounts.find(
    (a) => a.label.toLowerCase().includes(needle)
  );
  // 2. Fall back: match anywhere in the raw line
  if (!match) {
    match = accounts.find((a) => a.raw.toLowerCase().includes(needle));
  }
  if (!match) return null;
  return { amount: match.amount, matched: match };
}

main().catch(async (err) => {
  console.error("[nbg] fatal:", err);
  await patchState("nbg", {
    status: "error",
    finishedAt: new Date().toISOString(),
    lastError: err instanceof Error ? err.message : String(err),
  }).catch(() => undefined);
  process.exit(1);
});
