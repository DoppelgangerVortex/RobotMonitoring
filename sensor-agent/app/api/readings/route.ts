// POST /api/readings  - the bridge script sends serial lines here.
// DELETE /api/readings - clears stored readings (from the dashboard).
//
// Accepted bodies:
//   application/json  { "device": "uno-1", "lines": ["temp=23.4", { "raw": "hum=51", "t": 1730000000000 }] }
//   application/json  { "line": "temp=23.4" }
//   text/plain        one serial line per line of text

import { checkApp, checkIngest, json } from "../../../lib/auth.ts";
import { parseLine } from "../../../lib/parse.ts";
import { getStore } from "../../../lib/store.ts";
import type { Reading } from "../../../lib/types.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_LINES = 500;
const DAY = 24 * 60 * 60 * 1000;

type LineInput = string | { raw?: unknown; line?: unknown; t?: unknown };

export async function POST(req: Request): Promise<Response> {
  const denied = checkIngest(req);
  if (denied) return denied;

  let inputs: LineInput[] = [];
  let device: string | undefined;
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await req.json()) as { device?: unknown; lines?: unknown; line?: unknown };
      device = typeof body.device === "string" ? body.device : undefined;
      if (Array.isArray(body.lines)) inputs = body.lines as LineInput[];
      else if (typeof body.line === "string") inputs = [body.line];
    } else {
      inputs = (await req.text()).split(/\r?\n/);
      device = req.headers.get("x-device") ?? undefined;
    }
  } catch {
    return json({ error: "Could not read the request body. Send JSON or plain text." }, 400);
  }
  if (inputs.length > MAX_LINES) return json({ error: `Send at most ${MAX_LINES} lines per request.` }, 413);

  const now = Date.now();
  const readings: Reading[] = [];
  let skipped = 0;
  for (const item of inputs) {
    const text = typeof item === "string" ? item : typeof item?.raw === "string" ? item.raw : typeof item?.line === "string" ? item.line : null;
    if (text === null) {
      skipped++;
      continue;
    }
    // Trust the bridge's timestamp if it is within a day of server time.
    const given = typeof item === "object" && typeof item.t === "number" ? item.t : NaN;
    const t = Number.isFinite(given) && Math.abs(given - now) < DAY ? given : now;
    const r = parseLine(text, t, device);
    if (r) readings.push(r);
    else skipped++;
  }

  const store = getStore();
  try {
    await store.addReadings(readings);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
  return json({ accepted: readings.length, skipped, storage: store.kind });
}

export async function DELETE(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  await getStore().clearReadings();
  return json({ cleared: true });
}
