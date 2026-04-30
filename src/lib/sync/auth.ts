import "server-only";

/**
 * Shared-secret auth gate for the JSON APIs.
 *
 * If PORTFOLIO_API_TOKEN is unset, all requests are allowed (handy for local
 * dev). When set, EXTERNAL callers must supply the token via:
 *   - `?token=<value>`              query string
 *   - `x-api-token: <value>`        header
 *   - `Authorization: Bearer <…>`   header
 *
 * Same-origin browser fetches (i.e. the dashboard talking to its own API
 * routes) are always allowed — the dashboard never needs a token to talk to
 * itself. We trust this via the `Sec-Fetch-Site` Fetch Metadata header,
 * which is set automatically by browsers and cannot be spoofed by JS.
 */
export function isApiAuthorized(req: Request): boolean {
  const expected = process.env.PORTFOLIO_API_TOKEN?.trim();
  if (!expected) return true;

  // Trust browser fetches that originate from the same origin as the page.
  // `Sec-Fetch-Site` is unforgeable by client JavaScript (it's added by the
  // browser); non-browser clients (curl / Glance / scripts) won't send it.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin") return true;

  const url = new URL(req.url);
  const got =
    url.searchParams.get("token") ??
    req.headers.get("x-api-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return got === expected;
}
