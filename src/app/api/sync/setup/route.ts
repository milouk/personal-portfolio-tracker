import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { isApiAuthorized } from "@/lib/sync/auth";
import { readSyncState, type SyncSource } from "@/lib/sync/state-server";

export const dynamic = "force-dynamic";

const ROOT = process.cwd();

const SETUP_SCRIPTS: Record<SyncSource, string | undefined> = {
  tr: "scripts/sync-tr-setup.ts",
  // NBG has no separate setup phase — the regular sync handles 2FA inline.
  nbg: undefined,
  // AADE card sync handles TaxisNet OTP inline on first run; no separate setup.
  "aade-card": undefined,
  // myDATA REST API uses static credentials, no setup phase.
  mydata: undefined,
};

export async function POST(req: Request) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { source?: string };
  try {
    body = (await req.json()) as { source?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const source = body.source as SyncSource | undefined;
  if (source !== "tr" && source !== "nbg") {
    return NextResponse.json(
      { error: "source must be 'tr' or 'nbg'" },
      { status: 400 }
    );
  }
  const script = SETUP_SCRIPTS[source];
  if (!script) {
    return NextResponse.json(
      { error: `${source} has no separate setup flow` },
      { status: 400 }
    );
  }

  const state = await readSyncState();
  if (state[source].status === "running" || state[source].status === "needs_otp") {
    return NextResponse.json(
      { error: `${source} setup already in progress`, state },
      { status: 409 }
    );
  }

  const proc = spawn("npx", ["tsx", path.join(ROOT, script)], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  proc.unref();

  return NextResponse.json({ ok: true, started: source });
}
