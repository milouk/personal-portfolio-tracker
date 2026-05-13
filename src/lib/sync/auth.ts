import "server-only";

/**
 * Shared-secret auth gate for the JSON APIs.
 *
 * Same-origin browser fetches (the dashboard talking to its own API routes)
 * are always allowed via `Sec-Fetch-Site: same-origin`. That header is
 * browser-set and unforgeable from JS; non-browser clients (curl, Glance,
 * scripts) don't send it.
 *
 * External callers must supply `PORTFOLIO_API_TOKEN` via one of:
 *   - `?token=<value>`              query string
 *   - `x-api-token: <value>`        header
 *   - `Authorization: Bearer <…>`   header
 *
 * If `PORTFOLIO_API_TOKEN` is unset, external access is denied. The dashboard
 * still works (same-origin path above), but anything outside the browser is
 * locked out by default — fail-closed.
 */
export function isApiAuthorized(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "same-origin") return true;

  const expected = process.env.PORTFOLIO_API_TOKEN?.trim();
  if (!expected) return false;

  const url = new URL(req.url);
  const got =
    url.searchParams.get("token") ??
    req.headers.get("x-api-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return got === expected;
}
