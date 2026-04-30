import { NextResponse } from "next/server";
import { readPortfolio } from "@/lib/storage/portfolio";
import { buildCalendar } from "@/lib/calendar";
import { isApiAuthorized } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const windowDays = Math.max(
    1,
    Math.min(365, parseInt(url.searchParams.get("days") ?? "90", 10) || 90)
  );
  const portfolio = await readPortfolio();
  const events = await buildCalendar(portfolio.assets, windowDays);
  return NextResponse.json(
    { events, windowDays, fetchedAt: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } }
  );
}
