import "server-only";
import fs from "node:fs/promises";
import path from "node:path";

// Mirror of scripts/lib/sync-state.ts — kept as a separate module so the Next
// build doesn't try to follow scripts/* into the bundle.
const ROOT = process.cwd();
const SYNC_DIR = path.join(ROOT, "data", "sync");
const STATE_FILE = path.join(SYNC_DIR, "state.json");

export type SyncSource = "tr" | "nbg" | "aade-card" | "mydata";
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
  "aade-card": SourceState;
  mydata: SourceState;
};

const DEFAULT_STATE: SyncState = {
  tr: { status: "idle" },
  nbg: { status: "idle" },
  "aade-card": { status: "idle" },
  mydata: { status: "idle" },
};

// If a sync claims to still be running long after it should have completed,
// the worker process has almost certainly crashed (SIGKILL/OOM/orphaned)
// without writing the final state. Treat anything older than this as dead
// and auto-recover so the next sync attempt isn't blocked by a stale lock.
const STALE_RUNNING_MS = 10 * 60 * 1000;

async function rawReadSyncState(): Promise<SyncState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_STATE;
  }
}

async function writeSyncState(state: SyncState): Promise<void> {
  await fs.mkdir(SYNC_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function readSyncState(): Promise<SyncState> {
  const state = await rawReadSyncState();
  let patched = false;
  const now = Date.now();
  for (const s of ["tr", "nbg", "aade-card", "mydata"] as const) {
    const src = state[s];
    if (
      (src.status === "running" || src.status === "needs_otp") &&
      src.startedAt &&
      now - new Date(src.startedAt).getTime() > STALE_RUNNING_MS
    ) {
      state[s] = {
        status: "error",
        startedAt: src.startedAt,
        // Deliberately leave finishedAt empty so the dashboard's
        // staleness check treats this source as needing a fresh sync.
        lastError:
          `Auto-recovered from stuck "${src.status}" state ` +
          `(>${Math.round(STALE_RUNNING_MS / 60_000)} min old). ` +
          `The previous sync probably crashed before writing its final status.`,
      };
      patched = true;
    }
  }
  if (patched) {
    await writeSyncState(state).catch(() => undefined);
  }
  return state;
}

export async function writeOtp(source: SyncSource, code: string): Promise<void> {
  await fs.mkdir(SYNC_DIR, { recursive: true });
  await fs.writeFile(path.join(SYNC_DIR, `otp-${source}.txt`), code, "utf8");
}
