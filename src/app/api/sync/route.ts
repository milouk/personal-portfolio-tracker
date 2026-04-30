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
};

function startSync(source: SyncSource): void {
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
      ? ["tr", "nbg"]
      : src === "tr" || src === "nbg"
        ? [src]
        : [];

  if (sources.length === 0) {
    return NextResponse.json(
      { error: "source must be 'tr', 'nbg', or 'all'" },
      { status: 400 }
    );
  }

  // Refuse to start a duplicate sync of an already-running source.
  for (const s of sources) {
    if (state[s].status === "running" || state[s].status === "needs_otp") {
      return NextResponse.json(
        { error: `${s} sync is already in progress`, state },
        { status: 409 }
      );
    }
  }

  for (const s of sources) startSync(s);
  return NextResponse.json({ ok: true, started: sources });
}
