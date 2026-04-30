import { NextResponse } from "next/server";
import { writeOtp, type SyncSource } from "@/lib/sync/state-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { source?: string; code?: string };
  try {
    body = (await req.json()) as { source?: string; code?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const source = body.source as SyncSource | undefined;
  const raw = (body.code ?? "").trim();
  if (source !== "tr" && source !== "nbg") {
    return NextResponse.json({ error: "source must be 'tr' or 'nbg'" }, { status: 400 });
  }
  const m = raw.match(/\b(\d{4,8})\b/);
  if (!m) {
    return NextResponse.json({ error: "code must contain 4-8 digits" }, { status: 400 });
  }
  await writeOtp(source, m[1]);
  return NextResponse.json({ ok: true });
}
