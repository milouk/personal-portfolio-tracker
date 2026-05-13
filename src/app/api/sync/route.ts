import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { readSyncState, type SyncSource } from "@/lib/sync/state-server";
import { isApiAuthorized } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

const ROOT = process.cwd();

const SCRIPTS: Record<SyncSource, string> = {
  tr: "scripts/sync-tr.ts",
  nbg: "scripts/sync-nbg.ts",
  "aade-card": "scripts/sync-aade-card.ts",
  mydata: "scripts/sync-mydata.ts",
};

// In-memory lock to prevent spawn races. readSyncState() reads from disk,
// so two rapid POSTs can both see "idle" and double-spawn before the child
// writes "running". This Map closes that window in the same Node process.
// Entries are cleared when the child exits or after a safety timeout that
// matches the auto-recovery window in state-server.ts.
const SPAWN_LOCK_MS = 10 * 60 * 1000;
const spawning = new Map<SyncSource, number>();

function isLocked(source: SyncSource): boolean {
  const ts = spawning.get(source);
  if (!ts) return false;
  if (Date.now() - ts > SPAWN_LOCK_MS) {
    spawning.delete(source);
    return false;
  }
  return true;
}

function startSync(source: SyncSource): void {
  spawning.set(source, Date.now());
  const scriptPath = path.join(ROOT, SCRIPTS[source]);
  // tsx is part of devDependencies; resolve via npx to avoid PATH assumptions.
  const proc = spawn("npx", ["tsx", scriptPath], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      // Make sure NBG sync only listens to the file queue when web-driven —
      // the manual stdin prompt would never be answered.
      NBG_OTP_SOURCE: process.env.NBG_OTP_SOURCE ?? "manual",
    },
  });
  proc.once("exit", () => spawning.delete(source));
  proc.once("error", () => spawning.delete(source));
  // Disown so the API route can return immediately while sync runs.
  proc.unref();
}

export async function GET(req: Request) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const state = await readSyncState();
  return NextResponse.json(state);
}

export async function POST(req: Request) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { source?: string };
  try {
    body = (await req.json()) as { source?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const src = body.source;
  const state = await readSyncState();

  const sources: SyncSource[] =
    src === "all"
      ? ["tr", "nbg", "aade-card", "mydata"]
      : src === "tr" ||
          src === "nbg" ||
          src === "aade-card" ||
          src === "mydata"
        ? [src]
        : [];

  if (sources.length === 0) {
    return NextResponse.json(
      {
        error: "source must be 'tr', 'nbg', 'aade-card', 'mydata', or 'all'",
      },
      { status: 400 }
    );
  }

  // Refuse to start a duplicate sync. The disk state is authoritative once
  // the child has written it; the in-memory lock covers the gap between
  // spawn and that first write so rapid POSTs can't double-fire.
  for (const s of sources) {
    if (
      isLocked(s) ||
      state[s].status === "running" ||
      state[s].status === "needs_otp"
    ) {
      return NextResponse.json(
        { error: `${s} sync is already in progress`, state },
        { status: 409 }
      );
    }
  }

  for (const s of sources) startSync(s);
  return NextResponse.json({ ok: true, started: sources });
}
