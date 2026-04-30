/**
 * Cross-platform notification helper for sync scripts.
 *
 * Channels (all opt-in via .env.local; safe to leave any subset unconfigured):
 *   - Email (SMTP) — SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *                  + NOTIFY_EMAIL_FROM / NOTIFY_EMAIL_TO
 *   - ntfy.sh push — NTFY_TOPIC (optional NTFY_SERVER, default ntfy.sh)
 *
 * Designed to run identically on Linux/Docker and on dev machines.
 *
 * Usage:
 *   await notify({
 *     title: "NBG — OTP needed",
 *     body: "Open Viber, paste the code at http://host:4848/otp",
 *     priority: "high",
 *   });
 */
import nodemailer from "nodemailer";

export type NotifyOptions = {
  title: string;
  body: string;
  /** Pre-rendered HTML for email — falls back to a wrapped <p> of `body`. */
  html?: string;
  /** Higher → ntfy priority bump; surfaces email subject prefix. */
  priority?: "low" | "normal" | "high";
  /** Override recipient list per-call. */
  emailTo?: string[];
  /** Disable individual channels for this call. */
  channels?: { email?: boolean; ntfy?: boolean };
};

const env = (k: string) => process.env[k]?.trim();

// ---------- email (SMTP) ----------
let cachedTransport: nodemailer.Transporter | null | undefined;
function getTransport(): nodemailer.Transporter | null {
  if (cachedTransport !== undefined) return cachedTransport;
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  if (!host || !user || !pass) {
    cachedTransport = null;
    return null;
  }
  const port = parseInt(env("SMTP_PORT") ?? "465", 10);
  const secure = env("SMTP_SECURE") !== "false" && port === 465;
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return cachedTransport;
}

async function emailNotify(
  title: string,
  body: string,
  priority: "low" | "normal" | "high",
  html?: string,
  to?: string[]
): Promise<{ ok: boolean; error?: string }> {
  const transport = getTransport();
  if (!transport) return { ok: false, error: "SMTP not configured" };
  const from = env("NOTIFY_EMAIL_FROM") ?? env("SMTP_USER")!;
  const recipients =
    to ?? env("NOTIFY_EMAIL_TO")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!recipients || recipients.length === 0) {
    return { ok: false, error: "no recipients (set NOTIFY_EMAIL_TO)" };
  }
  const subjectPrefix = priority === "high" ? "[!] " : "";
  try {
    await transport.sendMail({
      from,
      to: recipients.join(", "),
      subject: `${subjectPrefix}${title}`,
      text: body,
      html: html ?? `<p>${body.replace(/\n/g, "<br>")}</p>`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- ntfy.sh push ----------
async function ntfyNotify(
  title: string,
  body: string,
  priority: "low" | "normal" | "high"
): Promise<{ ok: boolean; error?: string }> {
  const topic = env("NTFY_TOPIC");
  if (!topic) return { ok: false, error: "NTFY_TOPIC not set" };
  const server = env("NTFY_SERVER") ?? "https://ntfy.sh";
  const url = `${server.replace(/\/$/, "")}/${topic}`;
  const prio =
    priority === "high" ? "5" : priority === "low" ? "2" : "3";
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: {
        Title: title,
        Priority: prio,
        Tags: priority === "high" ? "warning" : "information_source",
      },
    });
    if (!res.ok) return { ok: false, error: `ntfy http ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- public ----------
export async function notify(opts: NotifyOptions): Promise<void> {
  const priority = opts.priority ?? "normal";
  const useEmail = opts.channels?.email ?? true;
  const useNtfy = opts.channels?.ntfy ?? true;

  const tasks: Promise<{ kind: string; result: { ok: boolean; error?: string } }>[] = [];
  if (useEmail) {
    tasks.push(
      emailNotify(opts.title, opts.body, priority, opts.html, opts.emailTo).then(
        (result) => ({ kind: "email", result })
      )
    );
  }
  if (useNtfy) {
    tasks.push(
      ntfyNotify(opts.title, opts.body, priority).then((result) => ({
        kind: "ntfy",
        result,
      }))
    );
  }
  const settled = await Promise.all(tasks);
  for (const s of settled) {
    if (
      !s.result.ok &&
      s.result.error &&
      !s.result.error.includes("not configured") &&
      !s.result.error.includes("not set")
    ) {
      console.warn(`[notify] ${s.kind} failed: ${s.result.error}`);
    }
  }
}

/**
 * Fire-and-forget: returns immediately so sync flow isn't blocked.
 * Use for status pings; await `notify()` for critical alerts.
 */
export function notifyAsync(opts: NotifyOptions): void {
  void notify(opts).catch((e) => console.warn("[notify] error:", e));
}
