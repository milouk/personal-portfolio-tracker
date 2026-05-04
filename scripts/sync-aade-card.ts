#!/usr/bin/env -S npx tsx
/**
 * Scrape monthly card-spend totals from the AADE "Δημόσια κλήρωση —
 * Συναλλαγές και Λαχνοί" report — the figures AADE pre-fills into E1
 * codes 049/050 for the 30 % electronic-spend rule.
 *
 * Flow:
 *   1. Open https://www1.aade.gr/webtax/incomefp/per2010/index.jsp
 *      (redirects to TaxisNet SSO; plain username + password, no OTP)
 *   2. Click "Είσοδος στην εφαρμογή" → notifications app with 5 cards
 *   3. Click "Εκτύπωση" inside the lottery card. AADE's f_print_list()
 *      opens a popup and submits a hidden form into it; we monkey-patch
 *      window.open + HTMLFormElement.submit to capture the URL+params,
 *      then re-submit ourselves to get the response in-hand.
 *   4. The response is an Oracle Reports PDF — extract text via system
 *      `pdftotext` (poppler) and parse "YYYY-MM   amount   count" rows.
 *
 * Read-only — never submits anything to AADE except the same form the
 * Εκτύπωση button would.
 *
 * Usage:
 *     npm run sync:aade-card                # current year, headless
 *     npm run sync:aade-card -- --headed    # debug visible browser
 *     npm run sync:aade-card -- --year 2024
 *     npm run sync:aade-card -- --debug     # keep raw PDF + pdftotext output
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { notify } from "./lib/notify";
import { patchState } from "./lib/sync-state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(ROOT, f));
  } catch {
    /* missing — ignore */
  }
}

const ENTRY_URL = "https://www1.aade.gr/webtax/incomefp/per2010/index.jsp";
const PROFILE_DIR = path.join(ROOT, "data", "aade-card", "profile");
const LOGS_DIR = path.join(ROOT, "data", "aade-card", "logs");
const OUT_DIR = path.join(ROOT, "data", "aade-card");

// ---------- args ----------
const args = process.argv.slice(2);
const argHas = (flag: string) => args.includes(flag);
const argVal = (flag: string) => {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
};

const HEADED = argHas("--headed");
const DEBUG = argHas("--debug");
const YEAR = parseInt(argVal("--year") ?? String(new Date().getFullYear()), 10);

// ---------- helpers ----------
function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function snap(page: Page, label: string): Promise<string> {
  await ensureDir(LOGS_DIR);
  const file = path.join(LOGS_DIR, `${ts()}-${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    /* page may have closed */
  }
  return file;
}

// "1.234,56" → 1234.56 ;  "1234.56" → 1234.56
function parseAmount(s: string): number | null {
  const cleaned = s.replace(/[^\d.,\-]/g, "").trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const normalized =
    lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// AADE uses <input type="button" value="Εισοδος στην εφαρμογή">.
// Match on stem "ισοδ" (Είσοδος / Εισοδος) — it's the entry verb and
// uniquely identifies this button. "εφαρμογ" alone would also match the
// top-nav "Εφαρμογές" link and steal the click.
function appEntryLocator(page: Page) {
  return stemLocator(page, "Είσοδος", "Εισοδος", "ισοδ");
}

// Locate a clickable element whose visible text or input `value` contains
// any of the given stems. Greek accents are distinct unicode code points
// (ή ≠ η), so callers should pass both accented and plain variants.
function stemLocator(page: Page, ...stems: string[]) {
  const inputSelector = stems
    .flatMap((s) => [
      `input[type="button"][value*="${s}" i]`,
      `input[type="submit"][value*="${s}" i]`,
    ])
    .join(", ");
  const textRe = new RegExp(stems.join("|"), "i");
  return page
    .locator(inputSelector)
    .or(page.locator("a, button").filter({ hasText: textRe }))
    .first();
}

// ---------- login ----------
async function login(ctx: BrowserContext, page: Page): Promise<void> {
  const username = process.env.AADE_TAXISNET_USERNAME?.trim();
  const password = process.env.AADE_TAXISNET_PASSWORD?.trim();

  console.log(`[aade-card] navigating to ${ENTRY_URL}`);
  await page.goto(ENTRY_URL, { waitUntil: "load" });
  await snap(page, "00-landing");

  // Already logged in? Look for the app-entry button. AADE renders it as
  // <input type="button" value="Εισοδος στην εφαρμογή"> with mixed accents
  // ("Εισοδος" plain + "εφαρμογή" accented), so we match on the stable stem
  // `εφαρμογ` to dodge accent variations.
  const appEntry = appEntryLocator(page);
  if (await appEntry.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log("[aade-card] saved session valid — already on app entry page");
    return;
  }

  // Login form: TaxisNet redirects to gsis.gr. Wait for the form to render.
  // Selectors: GSIS uses #username + #password as of 2024.
  const userInput = page
    .locator('input[name="username"], input#username, input[name="j_username"]')
    .first();
  const passInput = page
    .locator('input[name="password"], input#password, input[type="password"]')
    .first();

  const formVisible = await userInput
    .isVisible({ timeout: 15_000 })
    .catch(() => false);
  if (!formVisible) {
    console.log("[aade-card] no obvious login form — assuming already logged in");
    return;
  }

  if (!username || !password) {
    throw new Error(
      "AADE_TAXISNET_USERNAME / AADE_TAXISNET_PASSWORD not set in .env.local"
    );
  }

  console.log("[aade-card] filling TaxisNet credentials");
  await userInput.fill(username);
  await passInput.fill(password);
  await snap(page, "01-creds-filled");

  const submit = page
    .locator(
      'button[type="submit"], input[type="submit"], button:has-text("Είσοδος"), button:has-text("Σύνδεση")'
    )
    .first();
  try {
    await submit.click({ timeout: 5_000 });
  } catch {
    await passInput.press("Enter");
  }

  await page.waitForTimeout(3_000);
  await snap(page, "02-after-login");

  // Wait for redirect back to the AADE app
  try {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
  } catch {
    /* keep going */
  }
}

// ---------- navigation ----------
type CapturedSubmit = {
  action: string;
  method: string;
  params: [string, string][];
};

async function openReport(ctx: BrowserContext, page: Page): Promise<Buffer> {
  // Click "Είσοδος στην εφαρμογή" if the entry-page is showing. Same-window
  // navigation, no popup. (When cookies are still valid, login() lands us
  // already past this step and the button isn't visible.)
  const appEntry = appEntryLocator(page);
  if (await appEntry.isVisible({ timeout: 8_000 }).catch(() => false)) {
    console.log("[aade-card] clicking 'Είσοδος στην εφαρμογή'");
    await appEntry.click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  } else {
    console.log("[aade-card] no entry button — assuming already inside the app");
  }
  await snap(page, "05-app-home");

  // f_print_list(EKTYPn) opens TheNewWindow via window.open() then submits
  // a hidden form into it. In headless chromium the popup never receives
  // the form-submit response, so we patch window.open + form.submit BEFORE
  // the click to capture the URL+params, then re-submit ourselves.
  console.log("[aade-card] installing form-submit interceptor");
  // Plain JS body — tsx injects helpers (__name) into transpiled functions
  // that don't exist in the page context, so we pass a string instead.
  await page.evaluate(`(() => {
    window.__capturedSubmit = undefined;
    const origOpen = window.open.bind(window);
    window.open = () => origOpen("about:blank", "_blank");
    HTMLFormElement.prototype.submit = function () {
      const fd = new FormData(this);
      const params = [];
      fd.forEach((v, k) => { if (typeof v === "string") params.push([k, v]); });
      window.__capturedSubmit = {
        action: new URL(this.action || location.href, location.href).href,
        method: (this.method || "POST").toUpperCase(),
        params: params,
      };
    };
  })()`);

  // The lottery section's "Εκτύπωση" is one of 5 buttons all named "ID2";
  // they're distinguished by EKTYP1/EKTYP10/EKTYP15/… in the onclick.
  // EKTYP1 is the lottery report.
  const lotteryPrintBtn = page
    .locator('input[type="button"][onclick*="EKTYP1)"]')
    .first();
  await lotteryPrintBtn.waitFor({ state: "visible", timeout: 15_000 });
  console.log("[aade-card] clicking 'Εκτύπωση' under Δημόσια κλήρωση card");
  await lotteryPrintBtn.click();
  await page.waitForTimeout(500);

  const captured = (await page.evaluate(
    `window.__capturedSubmit`
  )) as CapturedSubmit | undefined;
  if (!captured) {
    throw new Error(
      "did not capture print-form submission — f_print_list may have changed"
    );
  }
  console.log(
    `[aade-card] intercepted ${captured.method} ${captured.action} (${captured.params.length} params)`
  );

  // Re-submit ourselves through the browser context (carries cookies).
  // Page is iso-8859-7; advertise it on the request so any Greek values
  // round-trip correctly.
  const reportBuf = await ctx.request
    .fetch(captured.action, {
      method: captured.method,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=iso-8859-7" },
      data: captured.params
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&"),
    })
    .then((r) => r.body());

  if (DEBUG) {
    const ext = reportBuf.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : "html";
    const dump = path.join(LOGS_DIR, `${ts()}-report.${ext}`);
    await fs.writeFile(dump, reportBuf);
    console.log(`[aade-card] report (${reportBuf.length} bytes, ${ext}) → ${dump}`);
  }
  return reportBuf;
}

// ---------- parse ----------
type MonthlyAmounts = Record<number, number>;

type ScrapedReport = {
  year: number;
  monthlyAmount: MonthlyAmounts;
  monthlyLottery?: MonthlyAmounts;
  totalAmount: number;
};

// AADE delivers the lottery report as an Oracle Reports PDF. Convert it
// to text via system `pdftotext` (poppler), then walk the rows.
async function pdfToText(pdfBytes: Buffer): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aade-pdf-"));
  const pdfPath = path.join(tmp, "report.pdf");
  try {
    await fs.writeFile(pdfPath, pdfBytes);
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"]);
      let out = "";
      let err = "";
      proc.stdout.on("data", (b) => (out += b.toString("utf8")));
      proc.stderr.on("data", (b) => (err += b.toString("utf8")));
      proc.on("error", (e) =>
        reject(new Error(`pdftotext spawn failed: ${e.message}`))
      );
      proc.on("exit", (code) => {
        if (code === 0) resolve(out);
        else
          reject(
            new Error(
              `pdftotext exited ${code}: ${err.trim() || "(no stderr)"}` +
                " — install via `brew install poppler` (macOS) or `apt install poppler-utils` (Linux)"
            )
          );
      });
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseReport(text: string): ScrapedReport {
  // pdftotext -layout produces rows like:
  //    55   29/04/2026   2026-03   1.707,99   5.124   96 5247 6451  96 5248 1574
  // Annual rollups use just YYYY in the period column — we ignore those by
  // anchoring the regex on YYYY-MM specifically.
  const monthlyAmount: MonthlyAmounts = {};
  const monthlyLottery: MonthlyAmounts = {};

  const rowRe = new RegExp(
    `${YEAR}-(\\d{2})\\s+([\\d.]+,\\d{2})\\s+([\\d.]+)`,
    "g"
  );
  for (const m of text.matchAll(rowRe)) {
    const month = parseInt(m[1], 10);
    if (month < 1 || month > 12) continue;
    const amount = parseAmount(m[2]);
    // Greek-formatted integer count: "5.124" = 5124. parseAmount can't
    // disambiguate thousands-dot from decimal-dot without a comma anchor,
    // so strip everything but digits.
    const lottery = parseInt(m[3].replace(/\D/g, ""), 10);
    if (amount !== null) monthlyAmount[month] = amount;
    if (Number.isFinite(lottery)) monthlyLottery[month] = lottery;
  }

  // Round once to 2dp to avoid floating-point drift on the year sum.
  const totalAmount =
    Math.round(Object.values(monthlyAmount).reduce((s, v) => s + v, 0) * 100) /
    100;

  return {
    year: YEAR,
    monthlyAmount,
    monthlyLottery: Object.keys(monthlyLottery).length ? monthlyLottery : undefined,
    totalAmount,
  };
}

// ---------- main ----------
async function main() {
  await ensureDir(PROFILE_DIR);
  await ensureDir(OUT_DIR);

  console.log(`[aade-card] sync for year ${YEAR}`);
  await patchState("aade-card", {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    lastError: undefined,
    message: `Scraping ${YEAR}…`,
  });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    locale: "el-GR",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    await login(ctx, page);
    const reportBytes = await openReport(ctx, page);
    if (reportBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      // Surface the first chunk so the failure mode is recognisable in logs.
      throw new Error(
        `expected PDF from AADE lottery report; got ${reportBytes
          .subarray(0, 50)
          .toString("latin1")}…`
      );
    }
    const text = await pdfToText(reportBytes);
    if (DEBUG) {
      const dump = path.join(LOGS_DIR, `${ts()}-report.txt`);
      await fs.writeFile(dump, text, "utf8");
      console.log(`[aade-card] pdftotext output → ${dump}`);
    }
    const result = parseReport(text);

    const monthCount = Object.keys(result.monthlyAmount).length;
    console.log(
      `[aade-card] parsed ${monthCount} monthly rows for ${YEAR}, total €${result.totalAmount.toFixed(2)}`
    );

    const outFile = path.join(OUT_DIR, `${YEAR}.json`);
    const payload = {
      year: result.year,
      fetchedAt: new Date().toISOString(),
      monthlyAmount: result.monthlyAmount,
      monthlyLottery: result.monthlyLottery,
      totalAmount: result.totalAmount,
    };
    await fs.writeFile(outFile, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[aade-card] wrote → ${outFile}`);

    await patchState("aade-card", {
      status: "success",
      finishedAt: new Date().toISOString(),
      message:
        monthCount > 0
          ? `${YEAR}: ${monthCount} months, total €${result.totalAmount.toFixed(0)}`
          : `${YEAR}: no rows parsed — re-run with --headed --debug`,
    });
  } finally {
    if (!DEBUG) {
      await ctx.close();
    } else {
      console.log("[aade-card] (debug) leaving browser open — Ctrl-C to exit");
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[aade-card] fatal:", msg);
  void patchState("aade-card", {
    status: "error",
    finishedAt: new Date().toISOString(),
    lastError: msg,
  }).catch(() => undefined);
  void notify({
    title: "AADE card-spend sync failed",
    body: msg,
    priority: "high",
    channels: { email: false },
  }).catch(() => undefined);
  process.exit(1);
});
