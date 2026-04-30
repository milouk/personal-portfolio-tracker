/**
 * OTP source watchers — Docker / Linux compatible.
 *
 * Two sources:
 *   "manual"  — disable auto-read (default). Caller falls back to stdin prompt.
 *   "webhook" — start a small HTTP server on NBG_OTP_PORT (default 4848) and
 *               wait up to `timeoutMs` for someone to POST the OTP.
 *
 * Submitting the OTP via webhook (any of these work):
 *
 *   curl -d 123456 http://localhost:4848/otp
 *   curl -d '{"code":"123456"}' -H 'content-type: application/json' http://...
 *
 * Pair this with whatever delivery channel suits you on your server:
 *   - iOS Shortcut watching Viber → POST to a public ngrok URL
 *   - Telegram bot that posts on incoming messages
 *   - Manual paste from any phone via the public URL
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const DEFAULT_PORT = 4848;

function findCodeInText(text: string): string | null {
  const m = text.match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

async function readBody(req: IncomingMessage, maxBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCode(body: string, contentType: string | undefined): string | null {
  // Accept JSON `{ "code": "123456" }`, form `code=123456`, or just the code in body.
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (contentType?.includes("application/json")) {
    try {
      const data = JSON.parse(trimmed) as { code?: string; otp?: string };
      const v = data.code ?? data.otp;
      if (v) return findCodeInText(String(v));
    } catch {
      /* fall through */
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(trimmed);
    const v = params.get("code") ?? params.get("otp");
    if (v) return findCodeInText(v);
  }
  return findCodeInText(trimmed);
}

async function webhookOtpListener(timeoutMs: number): Promise<string | null> {
  const port = parseInt(process.env.NBG_OTP_PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.NBG_OTP_HOST ?? "0.0.0.0";

  return new Promise<string | null>((resolve) => {
    let server: Server | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: string | null) => {
      if (timer) clearTimeout(timer);
      if (server) server.close();
      resolve(code);
    };

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("POST only\n");
        return;
      }
      try {
        const body = await readBody(req);
        const code = parseCode(body, req.headers["content-type"]);
        if (!code) {
          res.statusCode = 400;
          res.end("no 4-8 digit code in body\n");
          return;
        }
        res.statusCode = 200;
        res.end(`accepted ${code}\n`);
        finish(code);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e instanceof Error ? e.message : e));
      }
    });

    server.on("error", (err) => {
      console.warn(`[otp-webhook] listen error: ${err.message}`);
      finish(null);
    });

    server.listen(port, host, () => {
      console.log(
        `[otp-webhook] listening on http://${host === "0.0.0.0" ? "0.0.0.0" : host}:${port}/otp ` +
          `(POST the code; timeout ${Math.round(timeoutMs / 1000)}s)`
      );
    });

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export async function waitForOtp(
  source: string,
  timeoutMs: number
): Promise<string | null> {
  if (source === "webhook") return webhookOtpListener(timeoutMs);
  return null;
}
