import "server-only";

/**
 * Shared-secret auth gate for the JSON APIs.
 *
 * If PORTFOLIO_API_TOKEN is unset, all requests are allowed (handy for local
 * dev). When set, callers must supply the token via:
 *   - `?token=<value>`              query string
 *   - `x-api-token: <value>`        header
 *   - `Authorization: Bearer <…>`   header
 */
export function isApiAuthorized(req: Request): boolean {
  const expected = process.env.PORTFOLIO_API_TOKEN?.trim();
  if (!expected) return true;
  const url = new URL(req.url);
  const got =
    url.searchParams.get("token") ??
    req.headers.get("x-api-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return got === expected;
}
