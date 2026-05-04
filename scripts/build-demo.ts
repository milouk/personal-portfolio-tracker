#!/usr/bin/env -S npx tsx
/**
 * Build the demo (static export) for GitHub Pages.
 *
 * - Moves src/app/api out of the way (incompatible with output:'export')
 * - Sets DEMO=1 so server actions and live fetches no-op
 * - Restores src/app/api after the build, even on failure
 *
 * Output: ./out (drop into gh-pages or upload as Pages artifact)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "src", "app", "api");
// Backup OUTSIDE src/app — Next.js scans src/app/** even hidden dotfile dirs.
const API_BACKUP = path.join(ROOT, ".api-backup");

// Pages that have `force-dynamic` for normal use; flip to `force-static` for export.
const PAGES_WITH_DYNAMIC = [
  path.join(ROOT, "src", "app", "page.tsx"),
  path.join(ROOT, "src", "app", "(app)", "assets", "page.tsx"),
  path.join(ROOT, "src", "app", "(app)", "history", "page.tsx"),
  path.join(ROOT, "src", "app", "(app)", "tax", "page.tsx"),
];

const ACTIONS_FILE = path.join(ROOT, "src", "lib", "actions.ts");
const ACTIONS_STUB = `// Auto-generated stub during demo build — server actions can't ship with output:export.
// The original file is restored after the build completes.
export async function createAssetAction(_input: unknown) {
  throw new Error("Demo mode is read-only.");
}
export async function updateAssetAction(_id: string, _patch: unknown) {
  throw new Error("Demo mode is read-only.");
}
export async function deleteAssetAction(_id: string) {
  throw new Error("Demo mode is read-only.");
}
`;

function patchPages(): Map<string, string> {
  const originals = new Map<string, string>();
  for (const p of PAGES_WITH_DYNAMIC) {
    const content = fs.readFileSync(p, "utf8");
    originals.set(p, content);
    const patched = content.replace(
      /export const dynamic = "force-dynamic";/,
      'export const dynamic = "force-static";'
    );
    fs.writeFileSync(p, patched, "utf8");
  }
  return originals;
}

function restorePages(originals: Map<string, string>) {
  for (const [p, content] of originals) {
    fs.writeFileSync(p, content, "utf8");
  }
}

function main(): number {
  const hadApi = fs.existsSync(API_DIR);
  if (hadApi) {
    if (fs.existsSync(API_BACKUP)) {
      console.error(
        `[demo] backup dir already exists at ${API_BACKUP} — refusing to overwrite. ` +
          "Remove it manually if a previous build was interrupted."
      );
      return 1;
    }
    fs.renameSync(API_DIR, API_BACKUP);
    console.log(`[demo] moved src/app/api → ${API_BACKUP}`);
  }

  const originals = patchPages();
  console.log("[demo] patched force-dynamic → force-static in pages");

  // Stub server actions so the bundle doesn't carry "use server" directives.
  const originalActions = fs.readFileSync(ACTIONS_FILE, "utf8");
  fs.writeFileSync(ACTIONS_FILE, ACTIONS_STUB, "utf8");
  console.log("[demo] stubbed src/lib/actions.ts");

  let exitCode = 0;
  try {
    const env = {
      ...process.env,
      DEMO: "1",
      NEXT_PUBLIC_DEMO: "1",
      // BASE_PATH set by caller (e.g. GitHub Actions sets it to /<repo-name>)
    };
    const r = spawnSync("npx", ["next", "build"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });
    exitCode = r.status ?? 1;
  } finally {
    restorePages(originals);
    fs.writeFileSync(ACTIONS_FILE, originalActions, "utf8");
    console.log("[demo] restored page dynamic configs + actions.ts");
    if (hadApi && fs.existsSync(API_BACKUP)) {
      if (fs.existsSync(API_DIR)) {
        fs.rmSync(API_DIR, { recursive: true });
      }
      fs.renameSync(API_BACKUP, API_DIR);
      console.log("[demo] restored src/app/api");
    }
  }

  if (exitCode === 0) {
    // Touch a CNAME-less .nojekyll so Pages serves _next/* assets correctly.
    const out = path.join(ROOT, "out");
    if (fs.existsSync(out)) {
      fs.writeFileSync(path.join(out, ".nojekyll"), "");
      console.log(`[demo] wrote .nojekyll to ${out}`);
    }
  }
  return exitCode;
}

process.exit(main());
