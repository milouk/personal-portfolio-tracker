/**
 * File-backed sync state machine.
 *
 * Sync scripts write their status here so the web UI can read it and prompt
 * the user when an OTP is needed. The OTP itself is delivered back to the
 * sync process via a per-source queue file.
 *
 *   data/sync/state.json   — current status of each sync
 *   data/sync/otp-nbg.txt  — OTP queue (web UI writes, sync reads + deletes)
 *   data/sync/otp-tr.txt
 *   data/sync/log-nbg.txt  — last log line for status surface
 *   data/sync/log-tr.txt
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SYNC_DIR = path.join(ROOT, "data", "sync");
const STATE_FILE = path.join(SYNC_DIR, "state.json");

export type SyncSource = "tr" | "nbg" | "aade-card" | "mydata";

export type SourceStatus =
  | "idle"
  | "running"
  | "needs_otp"
  | "needs_setup"
  | "success"
  | "error";

export type SourceState = {
  status: SourceStatus;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  /** When status === needs_otp, sync polls this file for the code. */
  otpPath?: string;
};

export type SyncState = {
  tr: SourceState;
  nbg: SourceState;
  "aade-card": SourceState;
  mydata: SourceState;
};

const DEFAULT_STATE: SyncState = {
  tr: { status: "idle" },
  nbg: { status: "idle" },
  "aade-card": { status: "idle" },
  mydata: { status: "idle" },
};

async function ensureDir() {
  await fs.mkdir(SYNC_DIR, { recursive: true });
}

export async function readState(): Promise<SyncState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_STATE;
    return DEFAULT_STATE;
  }
}

export async function patchState(
  source: SyncSource,
  patch: Partial<SourceState>
): Promise<SyncState> {
  await ensureDir();
  const state = await readState();
  state[source] = { ...state[source], ...patch };
  // Atomic write: write to tmp, then rename.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
  return state;
}

function otpFilePath(source: SyncSource): string {
  return path.join(SYNC_DIR, `otp-${source}.txt`);
}

/**
 * Wait up to `timeoutMs` for an OTP to arrive in the source's queue file.
 * Reads + deletes the file on success.
 */
export async function waitForQueuedOtp(
  source: SyncSource,
  timeoutMs: number,
  pollMs = 250
): Promise<string | null> {
  await ensureDir();
  const file = otpFilePath(source);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(file, "utf8")).trim();
      // Expect 4-8 digit code; tolerate JSON wrapper or plain text.
      // Note: a bare digit string like "1234" is valid JSON (a number) so we
      // try string/object shapes first and ALWAYS fall back to the raw text.
      let candidate: string = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") candidate = parsed;
        else if (parsed && typeof parsed.code === "string") candidate = parsed.code;
        // numbers/other shapes → keep raw
      } catch {
        /* not JSON, raw is fine */
      }
      const m = candidate.match(/\b(\d{4,8})\b/);
      // Always delete the file so a stale OTP doesn't satisfy a future request.
      await fs.unlink(file).catch(() => undefined);
      if (m) return m[1];
    } catch {
      /* file not yet present */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

export async function clearOtp(source: SyncSource): Promise<void> {
  try {
    await fs.unlink(otpFilePath(source));
  } catch {
    /* ignore */
  }
}

export async function writeOtp(source: SyncSource, code: string): Promise<void> {
  await ensureDir();
  await fs.writeFile(otpFilePath(source), code, "utf8");
}
