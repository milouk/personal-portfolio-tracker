#!/usr/bin/env node
/**
 * Capture README screenshots from the static demo build served on :3001.
 *
 * Usage (assumes `npm run demo:build` already produced ./out):
 *     npx serve -s out -p 3001 &
 *     node scripts/capture-screenshots.mjs
 *
 * Output: docs/screenshots/*.png
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const BASE = process.env.BASE ?? "http://localhost:3001";

/**
 * @typedef {Object} Shot
 * @property {string} url
 * @property {string} file
 * @property {{width: number, height: number}} clip
 * @property {string} [crop] - CSS selector to crop to (instead of fullPage:false)
 */

/** @type {Shot[]} */
const SHOTS = [
  { url: "/", file: "dashboard.png", clip: { width: 1440, height: 900 } },
  { url: "/assets/", file: "assets.png", clip: { width: 1440, height: 900 } },
  { url: "/tax/", file: "tax.png", clip: { width: 1440, height: 1700 } },
  { url: "/history/", file: "history.png", clip: { width: 1440, height: 900 } },
];

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
for (const s of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: s.clip.width, height: s.clip.height },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  const target = `${BASE}${s.url}`;
  console.log(`→ ${target}`);
  await page.goto(target, { waitUntil: "networkidle" });
  // Give Recharts / motion a beat to settle.
  await page.waitForTimeout(800);
  const out = path.join(OUT_DIR, s.file);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  saved ${out}`);
  await ctx.close();
}

// Bonus: crop the 30 % rule card from the tax page for a focused hero shot.
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/tax/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  // The 30 % rule card is whichever element has the "Electronic spend" header.
  const card = page.locator("h2").filter({ hasText: "Electronic spend" }).locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]").first();
  if (await card.isVisible().catch(() => false)) {
    const out = path.join(OUT_DIR, "card-spend.png");
    await card.screenshot({ path: out });
    console.log(`  saved ${out}`);
  } else {
    console.warn("  (skipped) Electronic-spend card not visible");
  }
  await ctx.close();
}
await browser.close();
