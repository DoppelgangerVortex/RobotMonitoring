// Two secrets:
//   INGEST_TOKEN  - the bridge script sends this when posting readings.
//   APP_PASSWORD  - protects the dashboard and the Claude-powered endpoints, so a
//                   public URL can't be used to run up your API bill.
// Both are required when deployed (NODE_ENV=production). Locally they're optional.

import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const isProd = () => process.env.NODE_ENV === "production";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Returns an error response if the request may not post readings, otherwise null. */
export function checkIngest(req: Request): Response | null {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return isProd() ? json({ error: "INGEST_TOKEN is not set on the server. Add it to the environment variables." }, 500) : null;
  }
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : (req.headers.get("x-ingest-token") ?? "");
  return given && safeEqual(given, expected) ? null : json({ error: "Wrong or missing ingest token." }, 401);
}

/** Returns an error response if the request may not use the dashboard API, otherwise null. */
export function checkApp(req: Request): Response | null {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return isProd()
      ? json({ error: "APP_PASSWORD is not set on the server. Add it to the environment variables.", code: "no_password_configured" }, 500)
      : null;
  }
  const given = req.headers.get("x-app-password") ?? "";
  return given && safeEqual(given, expected) ? null : json({ error: "Password required.", code: "password_required" }, 401);
}
