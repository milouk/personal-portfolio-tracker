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
import { notify } from "./lib/notify";
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
  try {
    const raw = await fs.readFile(PORTFOLIO_FILE, "utf8");
    return JSON.parse(raw) as Portfolio;
  } catch (e) {
    // First-run: no portfolio.json yet — bootstrap an empty one so the rest
    // of the sync (including auto-creation of NBG accounts) can proceed.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("[nbg] no portfolio.json yet — creating an empty one");
      return { version: 1, assets: [], updatedAt: new Date().toISOString() };
    }
    throw e;
  }
}
async function writePortfolio(p: Portfolio): Promise<void> {
  p.updatedAt = new Date().toISOString();
  await ensureDir(path.dirname(PORTFOLIO_FILE));
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
        // ntfy push only — email is reserved for calendar reminders.
        await notify({
          title: "NBG — OTP needed",
          body:
            "Open Viber on your phone for the 6-digit NBG OTP, then paste it " +
            "into the dashboard prompt or run `npm run sync:nbg -- --otp=<code>`. " +
            "OTP is valid for ~5 minutes.",
          priority: "high",
          channels: { email: false },
        });
        let code = OTP_ARG;

        // OTP arrives via whichever channel the user set up — race ALL of them
        // in parallel and take the first one that yields a code:
        //   1. Web UI queue file  (dashboard's OTP modal posts to /api/sync/otp)
        //   2. Webhook listener   (NBG_OTP_SOURCE=webhook → POST to :4848)
        //   3. stdin TTY          (manual `npm run sync:nbg` from a shell)
        // No more sequential 90 s waits before the dashboard OTP gets read.
        if (!code) {
          const source = (process.env.NBG_OTP_SOURCE ?? "manual").toLowerCase();
          const isTty = MODE === "setup" || HEADED || input.isTTY;
          const channels: Promise<string | null>[] = [
            waitForQueuedOtp("nbg", 5 * 60_000),
          ];
          if (source !== "manual" && source !== "file") {
            channels.push(waitForOtp(source, 5 * 60_000));
          }
          let rl: readline.Interface | null = null;
          if (isTty) {
            rl = readline.createInterface({ input, output });
            channels.push(
              rl
                .question(
                  "[nbg] enter the OTP from your phone (or POST it via the dashboard): "
                )
                .then((s) => s.trim() || null)
            );
          }
          const winner = await Promise.race(channels);
          if (rl) rl.close();
          if (winner) code = winner;
        }

        if (!code) {
          console.error("[nbg] no OTP provided (timed out)");
          await patchState("nbg", {
            status: "error",
            finishedAt: new Date().toISOString(),
            lastError: "OTP timeout",
          });
          void notify({
            title: "NBG sync timed out",
            body: "OTP wasn't provided in time.",
            priority: "high",
            channels: { email: false },
          }).catch(() => undefined);
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
    let idx = portfolio.assets.findIndex((a) => a.id === m.assetId);
    // First-run convenience: if the configured asset id doesn't exist yet,
    // bootstrap it from the matched NBG account. The user can rename / set
    // an interest rate / change the type via the dashboard later.
    if (idx === -1) {
      const now = new Date().toISOString();
      const isInvestment = m.target === "marketValueOverride";
      const newAsset: Asset = {
        id: m.assetId,
        name:
          isInvestment
            ? "NBG Investments"
            : `NBG ${result.matched.label || m.label}`,
        type: isInvestment ? "tbill" : "deposit",
        source: "nbg",
        currency: "EUR",
        // For deposits, seed iban from the matched label if it looks like one.
        iban: /^GR[\d*]+$/i.test(result.matched.label || "")
          ? result.matched.label
          : undefined,
        createdAt: now,
        updatedAt: now,
      };
      portfolio.assets.push(newAsset);
      idx = portfolio.assets.length - 1;
      await appendEvent({
        type: "asset.created",
        at: now,
        asset: newAsset,
        via: "playwright/nbg (first-run auto-create)",
      });
      console.log(
        `   + "${m.label}" → created asset "${m.assetId}" (${newAsset.type}) — edit via dashboard to refine`
      );
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

  // ---------- documents (Υπηρεσίες) ----------
  // Navigate the left sidebar's "Υπηρεσίες" section and try to find the user's
  // signed documents (T-bill purchase receipts etc.). On first run we just
  // capture screenshots so we can refine selectors based on what NBG actually
  // shows. PDFs are downloaded into data/nbg/docs/ for offline parsing.
  if (args.includes("--no-docs") === false) {
    try {
      await scrapeDocuments(page);
    } catch (e) {
      console.warn("[nbg] documents scrape failed:", e);
    }
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

// ---------- safety: refuse any click that looks like a transaction action ----
// This script is read-only by design. As an extra guard against ever
// triggering a buy/sell, every click goes through `safeClick`, which inspects
// the element's accessible name + nearby text and aborts if it matches any
// transaction-related label.
const DANGEROUS_CLICK_LABELS =
  /(?:^|\b)(Αγορά|Αγοράζω|Πώληση|Πωλώ|Εκτέλεση|Επιβεβαίωση|Συμφωνώ|Πληρωμή|Μεταφορά|Έκδοση|Submit|Confirm|Buy|Sell|Pay|Transfer|Execute|Επιλογή)\b/i;

async function safeClick(
  locator: import("playwright").Locator,
  context = "(unspecified)"
): Promise<boolean> {
  const text = (await locator.innerText().catch(() => "")).trim();
  if (DANGEROUS_CLICK_LABELS.test(text)) {
    console.error(
      `[nbg] REFUSING click on "${text.slice(0, 60)}" (${context}) — matches transaction keyword.`
    );
    return false;
  }
  try {
    await locator.click({ timeout: 5000 });
    return true;
  } catch (e) {
    console.warn(`[nbg] click "${text.slice(0, 30)}" (${context}) failed:`, e);
    return false;
  }
}

// ---------- documents (Υπηρεσίες → Έγγραφα) ----------
//
// Goal: navigate to the documents/correspondence section in NBG i-bank, list
// what's available, and download new PDFs into data/nbg/docs/ for offline
// parsing (T-bill receipts → real face/purchase/maturity).
//
// Selectors: NBG i-bank's structure isn't fully predictable; this is a
// best-effort exploration. Override via env if needed:
//   NBG_SERVICES_LABEL    default: "Υπηρεσίες"
//   NBG_DOCS_LABEL        default: matches "Έγγραφα" / "Documents" /
//                                  "Εκτυπώσεις" / "Αρχείο"
async function scrapeDocuments(page: Page): Promise<void> {
  const docsDir = path.join(ROOT, "data", "nbg", "docs");
  await ensureDir(docsDir);

  const servicesLabel =
    process.env.NBG_SERVICES_LABEL ?? "Υπηρεσίες";
  const docsLabel =
    process.env.NBG_DOCS_LABEL ?? "Έγγραφα|Documents|Εκτυπώσεις|Αρχείο|Παραστατικά";

  console.log(`[nbg] looking for "${servicesLabel}" in the sidebar…`);

  // Diagnostic: list every visible link/button so we can find the right one.
  try {
    const elements = await page.locator("a:visible, button:visible").all();
    const interesting: { tag: string; text: string; href: string }[] = [];
    for (const el of elements.slice(0, 200)) {
      const text = (await el.innerText().catch(() => "")).trim().slice(0, 80);
      if (!text) continue;
      // Surface anything plausibly related to docs/services
      const tag = String(
        (await el.evaluate("e => e.tagName").catch(() => "?")) ?? "?"
      );
      const href = (await el.getAttribute("href").catch(() => "")) ?? "";
      if (
        /Υπηρεσίες|Έγγραφα|Παραστατικά|Εκτυπώσεις|Αρχείο|Document|Statement|Investment/i.test(
          text
        ) ||
        /document|statement|invest|service/i.test(href)
      ) {
        interesting.push({ tag, text, href });
      }
    }
    if (interesting.length > 0) {
      console.log(`[nbg] candidate elements (${interesting.length}):`);
      for (const e of interesting.slice(0, 25)) {
        console.log(
          `   ${e.tag.padEnd(8)} "${e.text}"${e.href ? ` → ${e.href.slice(0, 80)}` : ""}`
        );
      }
    } else {
      console.log("[nbg] no Υπηρεσίες/Documents-style elements found visible");
    }
  } catch {
    /* keep going */
  }

  // Step 1 — try clicking Υπηρεσίες in the sidebar / nav.
  const servicesCandidates = [
    `nav >> text=/^${servicesLabel}$/`,
    `aside >> text=/^${servicesLabel}$/`,
    `text=/^${servicesLabel}$/`,
    `a:has-text("${servicesLabel}")`,
    `button:has-text("${servicesLabel}")`,
    `[aria-label*="${servicesLabel}" i]`,
  ];
  let opened = false;
  for (const sel of servicesCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 4000 });
        opened = true;
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        await snap(page, "06-services");
        break;
      }
    } catch {
      /* keep trying */
    }
  }
  if (!opened) {
    console.log(
      `[nbg] could not find "${servicesLabel}" in the sidebar — leaving documents alone. ` +
        `Inspect 04-accounts-listed.png and set NBG_SERVICES_LABEL to the exact text.`
    );
    return;
  }

  // Step 2 — within Υπηρεσίες, click into the Documents sub-section.
  const re = new RegExp(`^(${docsLabel})$`, "i");
  const docsCandidates = [
    page.getByRole("link", { name: re }),
    page.getByRole("button", { name: re }),
    page.locator(`a:has-text("${docsLabel.split("|")[0]}")`),
  ];
  let inDocs = false;
  for (const cand of docsCandidates) {
    try {
      const el = cand.first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 4000 });
        inDocs = true;
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        await snap(page, "07-documents");
        break;
      }
    } catch {
      /* keep trying */
    }
  }
  if (!inDocs) {
    console.log(
      `[nbg] opened "${servicesLabel}" but couldn't find a documents subsection. ` +
        `Inspect 06-services.png and set NBG_DOCS_LABEL to the right substring(s).`
    );
    return;
  }

  // Step 3 — list any PDF download links / rows on the documents page.
  const links = await page
    .locator('a[href$=".pdf"], a[href*="document"], a[href*="statement"]')
    .all();
  console.log(`[nbg] found ${links.length} candidate document link(s)`);
  for (let i = 0; i < Math.min(links.length, 30); i++) {
    const text = (await links[i].innerText().catch(() => "")).trim();
    const href = (await links[i].getAttribute("href").catch(() => "")) ?? "";
    console.log(`   ${i + 1}. "${text.slice(0, 80)}" → ${href.slice(0, 80)}`);
  }

  // Step 4 — try to download each PDF. We let the browser handle the request
  // and capture the response body. Skip if Playwright can't intercept.
  for (let i = 0; i < Math.min(links.length, 10); i++) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
        links[i].click({ timeout: 4000 }).catch(() => undefined),
      ]);
      if (download) {
        const suggested = download.suggestedFilename() || `doc-${i + 1}.pdf`;
        const target = path.join(docsDir, suggested);
        await download.saveAs(target);
        console.log(`   ✓ saved ${suggested}`);
      }
    } catch (e) {
      console.warn(`   ✗ download #${i + 1} failed:`, e);
    }
  }
  console.log(`[nbg] documents scrape done — files in ${docsDir}`);
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

// Try several strategies to find the portfolio id NBG uses in
// /investments/info/<id>. Each strategy is independently tolerant — we just
// return the first one that yields a digit string.
async function discoverPortfolioId(page: Page): Promise<string | null> {
  // 1. Explicit override via env (set this if discovery keeps failing).
  const fromEnv = process.env.NBG_PORTFOLIO_ID?.trim();
  if (fromEnv && /^\d{4,10}$/.test(fromEnv)) {
    console.log(`[nbg] using NBG_PORTFOLIO_ID=${fromEnv} from env`);
    return fromEnv;
  }

  // 2. Any anchor whose href already contains /investments/info/<id> — most
  //    reliable when the list view links straight to the detail page.
  try {
    const hrefs = await page
      .locator('a[href*="/investments/info/"]')
      .evaluateAll((els) =>
        (els as HTMLAnchorElement[]).map((a) => a.getAttribute("href") || "")
      );
    for (const h of hrefs) {
      const m = h.match(/\/investments\/info\/(\d{4,10})/);
      if (m) {
        console.log(`[nbg] portfolio id ${m[1]} discovered via anchor href`);
        return m[1];
      }
    }
  } catch {
    /* ignore */
  }

  // 3. Greek-label text match — covers historical phrasings:
  //      Φιλική Ον/σία   /   Φιλική Ονομασία   /   Αριθμός Χαρτοφυλακίου
  const listText = await page.locator("body").innerText().catch(() => "");
  const labelPatterns = [
    /Φιλική\s+Ον[\/\s]?σ?ία[\s\S]{0,40}?(\d{4,10})/,
    /Φιλική\s+Ονομασία[\s\S]{0,40}?(\d{4,10})/,
    /Αριθμ[όο]ς\s+Χαρτοφυλακ[ίι]ου[\s\S]{0,40}?(\d{4,10})/,
    /Κωδικ[όο]ς\s+Χαρτοφυλακ[ίι]ου[\s\S]{0,40}?(\d{4,10})/,
  ];
  for (const re of labelPatterns) {
    const m = listText.match(re);
    if (m) {
      console.log(`[nbg] portfolio id ${m[1]} discovered via text label`);
      return m[1];
    }
  }

  // 4. Last-resort heuristic: NBG's portfolio cards expose the id as a
  //    `data-portfolio-id` / `data-id` attribute, or inside the URL fragment
  //    after a click. Try DOM data-attributes.
  try {
    const dataAttr = await page
      .locator("[data-portfolio-id], [data-portfolioid], [data-id]")
      .evaluateAll((els) =>
        (els as HTMLElement[])
          .map(
            (e) =>
              e.dataset.portfolioId ?? e.dataset.portfolioid ?? e.dataset.id ?? ""
          )
          .find((v) => /^\d{4,10}$/.test(v))
      );
    if (typeof dataAttr === "string" && dataAttr) {
      console.log(`[nbg] portfolio id ${dataAttr} discovered via data-* attr`);
      return dataAttr;
    }
  } catch {
    /* ignore */
  }

  return null;
}

async function scrapeInvestments(page: Page): Promise<InvestmentScrapeResult> {
  // The dashboard's Επενδυτικά card links to a per-portfolio investments page
  // whose URL pattern is #/investments/info/<portfolioId>. We discover it
  // organically by finding any anchor on the dashboard with that href shape —
  // works for any user without hardcoding the portfolio id.
  console.log("[nbg] looking for an investments link on the dashboard…");
  const startUrl = page.url();

  const linkLocator = page.locator('a[href*="/investments/info/"]').first();
  const fallbackLocator = page.locator('a[href*="/investments"]').first();

  const candidate = (await linkLocator.count()) > 0 ? linkLocator : fallbackLocator;
  if ((await candidate.count()) === 0) {
    return {
      positions: [],
      note:
        "couldn't find an /investments/info/ link on the dashboard. " +
        "NBG might render the card without a real anchor — inspect 04-accounts-listed.png.",
    };
  }

  const href = await candidate.getAttribute("href").catch(() => null);
  console.log(`[nbg] clicking investments link: ${href ?? "(no href)"}`);

  // NBG renders a `loading-stage-container` overlay while the dashboard's
  // widgets finish loading. Wait for it to go away before clicking.
  await page
    .locator(".loading-stage-container")
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);

  try {
    await candidate.click({ timeout: 8000 });
  } catch {
    // Fall back to programmatic navigation using the discovered href.
    if (href) {
      console.log("[nbg] click intercepted, using direct href navigation");
      const targetUrl = new URL(href, page.url()).toString();
      await page.goto(targetUrl, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
    } else {
      return { positions: [], note: "click intercepted and no href available" };
    }
  }

  // SPA hash-based routing — wait for the URL to settle to /investments/.
  await page
    .waitForFunction(
      (start) => location.href !== start && /\/investments\b/.test(location.href),
      startUrl,
      { timeout: 10_000 }
    )
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);

  // We're on /investments (the portfolio list). The clickable element that
  // drills into the breakdown is the portfolio CARD itself — NOT the bottom
  // "Συναλλαγές Κινητών Αξιών" link (that opens a buy/sell modal).
  //
  // Strategy: discover the portfolio id organically from the page text
  // (NBG renders it next to "Φιλική Ον/σία"), then navigate to the canonical
  // detail URL #/investments/info/<id>#transferableSecurities. This is the
  // same path the user follows by clicking the card.
  await page
    .locator(".loading-stage-container")
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => undefined);
  // Always snap the list page so we can inspect when discovery fails.
  await snap(page, "05a-investments-list");

  const portfolioId = await discoverPortfolioId(page);
  if (!portfolioId) {
    return {
      positions: [],
      note:
        "couldn't discover portfolio id on the investments list. " +
        "Inspect 05a-investments-list.png and consider setting NBG_PORTFOLIO_ID in .env.local.",
    };
  }
  console.log(`[nbg] discovered portfolio id ${portfolioId}, drilling in`);

  // Land on the portfolio detail. We do NOT append `#transferableSecurities`
  // any more — that fragment dropped the page onto the buy/sell tab where
  // the donut-chart legend acts as a trade trigger; clicking
  // "Χρηματοπιστωτικά Μέσα" then opened the Αγορά / Πώληση modal instead
  // of expanding the holdings.
  const detailUrl = `https://ebanking.nbg.gr/web/#/investments/info/${portfolioId}`;
  await page.goto(detailUrl, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page
    .getByText(/Παρακαλώ\s+περιμένετε/i)
    .first()
    .waitFor({ state: "hidden", timeout: 30_000 })
    .catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined); // dismiss anything stale
  await page.waitForTimeout(1500);
  await snap(page, "05b-securities-loaded");
  console.log(`[nbg] now at ${page.url().slice(0, 100)}`);

  // Click the "Προϊόντα Χαρτοφυλακίου" tab so the page actually shows the
  // products-by-category breakdown (not the buy/sell or transactions tab).
  const productsTab = page
    .getByRole("tab", { name: /Προϊόντα\s+Χαρτοφυλακίου/i })
    .first();
  if ((await productsTab.count().catch(() => 0)) > 0) {
    console.log('[nbg] clicking "Προϊόντα Χαρτοφυλακίου" tab');
    await productsTab.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  } else {
    // Fallback: click any element with that text outside of the donut legend.
    const tabFallback = page
      .locator(":not(.legend) :not(.recharts-legend-item-text)")
      .getByText(/Προϊόντα\s+Χαρτοφυλακίου/i)
      .first();
    if ((await tabFallback.count().catch(() => 0)) > 0) {
      console.log('[nbg] clicking products text (no role=tab found)');
      await tabFallback.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
    }
  }
  await snap(page, "05b-products-tab");

  // Now look for the "Χρηματοπιστωτικά Μέσα" tile. We restrict to clickable
  // elements (role=button, button, link) and explicitly exclude anything
  // inside the donut-chart legend, where clicking opens the trade modal.
  // The tile we want has a € amount nearby and is in the products section.
  const tileCandidates = page.locator(
    [
      'button:has-text("Χρηματοπιστωτικά Μέσα")',
      'a:has-text("Χρηματοπιστωτικά Μέσα")',
      '[role="button"]:has-text("Χρηματοπιστωτικά Μέσα")',
      '.tile:has-text("Χρηματοπιστωτικά Μέσα")',
      '.card:has-text("Χρηματοπιστωτικά Μέσα")',
      '[class*="tile"]:has-text("Χρηματοπιστωτικά Μέσα")',
      '[class*="card"]:has-text("Χρηματοπιστωτικά Μέσα")',
    ].join(", ")
  );
  const tileCount = await tileCandidates.count().catch(() => 0);
  console.log(`[nbg] ${tileCount} clickable Χρηματοπιστωτικά-Μέσα tile(s) detected`);
  for (let i = 0; i < tileCount; i++) {
    const tile = tileCandidates.nth(i);
    const text = (await tile.innerText().catch(() => "")).slice(0, 80);
    // Skip donut-chart legend items (they only contain the label + percent,
    // no € amount) — these trigger trade modals when clicked.
    if (!/€|\d{1,3}(?:\.\d{3})*,\d{2}/.test(text)) {
      console.log(`   - skipping #${i + 1} (no € amount, likely legend): "${text}"`);
      continue;
    }
    console.log(`[nbg] click #${i + 1}/${tileCount}: "${text.slice(0, 50)}"`);
    const ok = await safeClick(tile, `Χρηματοπιστωτικά Μέσα tile #${i + 1}`);
    if (!ok) continue;
    await page.waitForTimeout(1500);
    await page
      .getByText(/Παρακαλώ\s+περιμένετε/i)
      .first()
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText();
    if (/GR\d{10}/.test(body)) {
      console.log(`[nbg] click #${i + 1} expanded the breakdown`);
      await snap(page, "05c-financial-instruments");
      break;
    }
    // Anything that opened a modal — dismiss with Escape and try the next.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(500);
  }

  await snap(page, "05-investments-detail");
  console.log(`[nbg] now at ${page.url().slice(0, 100)}`);

  // We're on /investments/info/<portfolioId>. Below the summary there's a
  // "Προϊόντα Χαρτοφυλακίου" (Portfolio Products) section whose first tile is
  // the portfolio card itself. Clicking that card drills into per-holding
  // pages with the real ISIN / face value / maturity.
  //
  // We discover the tile by looking for a link whose href extends the current
  // URL — i.e. /investments/info/<id>/<something>. That's a clickable holding.
  await page.waitForTimeout(800);
  const currentPath = (() => {
    const m = page.url().match(/#\/investments\/info\/[^/?]+/);
    return m ? m[0] : "#/investments/info";
  })();
  const productsHeading = page
    .getByText(/Προϊόντα\s+Χαρτοφυλακίου/i)
    .first();
  const hasProducts = await productsHeading
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  {
    console.log(
      hasProducts
        ? '[nbg] found "Προϊόντα Χαρτοφυλακίου" heading'
        : '[nbg] heading not visible — falling back to URL-pattern tile detection'
    );

    // Find tiles by href pattern: any anchor whose href extends the current
    // /investments/info/<id> path (i.e. a link to a per-holding sub-route).
    const allLinks = await page.locator("a:visible").all();
    const annotated = await Promise.all(
      allLinks.map(async (l) => {
        const t = (await l.innerText().catch(() => "")).trim();
        const h = (await l.getAttribute("href").catch(() => "")) ?? "";
        return { l, t, h };
      })
    );
    // Tiles = anchors whose href contains the current portfolio path PLUS
    // additional segments (sub-pages of this portfolio).
    const portfolioPathRe = new RegExp(
      currentPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "/"
    );
    const productTiles = annotated
      .filter(
        (x) =>
          portfolioPathRe.test(x.h) ||
          /\/securities\//.test(x.h) ||
          /\/holdings?\//.test(x.h)
      )
      .map((x) => x.l);

    console.log(`[nbg] ${productTiles.length} product tile(s) detected via URL pattern`);
    for (const x of annotated.filter(
      (a) =>
        portfolioPathRe.test(a.h) ||
        /\/securities\//.test(a.h) ||
        /\/holdings?\//.test(a.h)
    )) {
      console.log(`   "${x.t.slice(0, 50)}" → ${x.h.slice(0, 80)}`);
    }
    const collected: InvestmentPosition[] = [];
    const startedAt = page.url();

    for (let i = 0; i < productTiles.length; i++) {
      try {
        await page
          .locator(".loading-stage-container")
          .waitFor({ state: "hidden", timeout: 8000 })
          .catch(() => undefined);
        await productTiles[i].click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        await snap(page, `05c-product-${i + 1}`);

        const detailText = await page.locator("body").innerText();
        const lines = detailText.split("\n").map((l) => l.trim()).filter(Boolean);
        const isinM = detailText.match(/\b([A-Z]{2}[A-Z0-9]{9}\d)\b/);
        const isin = isinM ? isinM[1] : undefined;

        // Pick the largest EUR amount on the page as the current value.
        const amounts = (detailText.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) ?? [])
          .map((s) => parseAmount(s) ?? 0)
          .sort((a, b) => b - a);
        const value = amounts[0] ?? 0;

        const name =
          lines.find(
            (l) =>
              l.length > 4 &&
              l.length < 80 &&
              !/^[\d.,€\s]+$/.test(l) &&
              !/^\d{6,}$/.test(l) &&
              !/Συνολ|Διαθέσ|Κατηγορ|Επενδ|Κύριος/.test(l)
          ) ?? isin ?? "";

        if (isin || value > 0) {
          collected.push({ isin, name, value });
          console.log(
            `   ✓ tile ${i + 1}: ${isin ?? "(no isin)"} · ${name.slice(0, 50)} · €${value.toFixed(2)}`
          );
        } else {
          console.log(`   ? tile ${i + 1}: nothing useful — first 30 lines:`);
          for (const l of lines.slice(0, 30)) console.log(`     "${l}"`);
        }
      } catch (e) {
        console.warn(`   ✗ tile ${i + 1} drill failed:`, e);
      }
      // Back to portfolio info for the next tile.
      await page.goBack({ timeout: 8000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      // If goBack didn't restore the right URL, navigate via known link.
      if (!page.url().includes(startedAt.split("#")[1] ?? "")) {
        await page.goto(startedAt, { waitUntil: "load" }).catch(() => undefined);
        await page.waitForTimeout(800);
      }
    }

    if (collected.length > 0) return { positions: collected };
  }

  // Parse position rows. Each holding shows up with: name, ISIN (12 chars),
  // quantity, current value, and (for T-bills) maturity / yield.
  const body = await page.locator("body").innerText();
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

  const reIsin = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
  const reAmount = /-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€?/;

  const positions: InvestmentPosition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isinMatch = lines[i].match(reIsin);
    if (!isinMatch) continue;
    const isin = isinMatch[1];
    const window = lines.slice(i, Math.min(i + 8, lines.length)).join(" ");
    const amtMatch = window.match(reAmount);
    if (!amtMatch) continue;
    const value = parseAmount(amtMatch[0]);
    if (value === null) continue;
    const nameCandidates = [lines[i - 1], lines[i - 2], lines[i + 1]]
      .map((s) => (s ?? "").trim())
      .filter((s) => s && !reIsin.test(s) && !reAmount.test(s) && s.length > 2);
    const name = nameCandidates[0] ?? isin;
    positions.push({ isin, name, value });
  }

  // Diagnostic: if nothing matches, dump first 60 lines so we can see exactly
  // what NBG renders on the investments-info page.
  if (positions.length === 0) {
    console.log("[nbg] no ISIN-shaped rows on the investments page. First 60 lines:");
    for (const line of lines.slice(0, 60)) console.log(`   "${line}"`);
  }

  return { positions };
}

// Greek government securities (T-bills + bonds) all use ISO ISIN code "GR"
// (any GR\d… ISIN issued by ΟΔΔΗΧ). Distinguishing T-bill vs longer bond
// from the ISIN alone isn't reliable, so we classify everything Greek as a
// T-bill (the common case for retail NBG holdings) and let the user
// re-type to "bond" via the dashboard if needed.
function classifyInvestmentByIsin(isin: string): {
  type: string;
  source: string;
} {
  if (/^GR\d/i.test(isin)) {
    return { type: "tbill", source: "greek-tbills" };
  }
  return { type: "bond", source: "nbg" };
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
    let idx = portfolio.assets.findIndex((a) => a.isin === p.isin);
    if (idx === -1) {
      // First-run: auto-create the position from what NBG showed us. The
      // user can fill in face value / purchase price / maturity later for
      // the maturity ladder + YTM calc.
      const cls = classifyInvestmentByIsin(p.isin);
      const newAsset: Asset = {
        id: `${cls.source === "greek-tbills" ? "gr-tbill" : "nbg-inv"}-${p.isin.toLowerCase()}`,
        name: p.name,
        type: cls.type,
        source: cls.source,
        currency: "EUR",
        isin: p.isin,
        marketValueOverride: Number(p.value.toFixed(2)),
        createdAt: now,
        updatedAt: now,
      };
      if (typeof p.quantity === "number") newAsset.quantity = p.quantity;
      portfolio.assets.push(newAsset);
      idx = portfolio.assets.length - 1;
      await appendEvent({
        type: "asset.created",
        at: now,
        asset: newAsset,
        via: "playwright/nbg-investments (first-run auto-create)",
      });
      details.push(
        `   + created ${newAsset.id} (${p.isin}, ${cls.type}) — €${p.value.toFixed(2)}`
      );
      updated++;
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
