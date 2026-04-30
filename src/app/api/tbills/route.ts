import { NextResponse } from "next/server";
import { getPdmaSnapshot } from "@/lib/prices/pdma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const data = await getPdmaSnapshot(force);
  return NextResponse.json(data);
}
