import "server-only";
import fs from "node:fs/promises";
import path from "node:path";

// Mirror of scripts/lib/sync-state.ts — kept as a separate module so the Next
// build doesn't try to follow scripts/* into the bundle.
const ROOT = process.cwd();
const SYNC_DIR = path.join(ROOT, "data", "sync");
const STATE_FILE = path.join(SYNC_DIR, "state.json");

export type SyncSource = "tr" | "nbg";
type SourceStatus =
  | "idle"
  | "running"
  | "needs_otp"
  | "needs_setup"
  | "success"
  | "error";

type SourceState = {
  status: SourceStatus;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};
type SyncState = {
  tr: SourceState;
  nbg: SourceState;
};

const DEFAULT_STATE: SyncState = {
  tr: { status: "idle" },
  nbg: { status: "idle" },
};

export async function readSyncState(): Promise<SyncState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function writeOtp(source: SyncSource, code: string): Promise<void> {
  await fs.mkdir(SYNC_DIR, { recursive: true });
  await fs.writeFile(path.join(SYNC_DIR, `otp-${source}.txt`), code, "utf8");
}
