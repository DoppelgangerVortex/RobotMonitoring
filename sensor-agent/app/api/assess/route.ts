// POST /api/assess - asks Claude to identify the sensors and assess the readings.
// Body: { "force": true } to skip the cache.
//
// To keep API costs predictable, a cached assessment is returned when nothing has
// changed, and automatic requests are limited to one per ASSESS_MIN_INTERVAL_SEC.

import { hashText, runAssessment } from "../../../lib/agent.ts";
import { checkApp, json } from "../../../lib/auth.ts";
import { ClaudeError } from "../../../lib/claude.ts";
import { ANALYSIS_WINDOW, getStore } from "../../../lib/store.ts";
import type { Assessment } from "../../../lib/types.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

let inflight: Promise<Assessment> | null = null;

function minIntervalMs(): number {
  const s = Number(process.env.ASSESS_MIN_INTERVAL_SEC);
  return (Number.isFinite(s) && s >= 0 ? s : 20) * 1000;
}

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;

  let force = false;
  try {
    force = !!((await req.json()) as { force?: unknown }).force;
  } catch {
    /* empty body is fine */
  }

  const store = getStore();
  try {
    const [readings, context, cached] = await Promise.all([
      store.recent(ANALYSIS_WINDOW),
      store.getContext(),
      store.getAssessment(),
    ]);
    if (!readings.length) return json({ error: "No readings yet. Start the bridge script first." }, 400);

    const now = Date.now();
    const lastT = readings[readings.length - 1].t;
    if (cached && !force) {
      const unchanged = cached.basedOnT === lastT && cached.contextHash === hashText(context);
      const tooSoon = now - cached.generatedAt < minIntervalMs();
      if (unchanged || tooSoon) return json({ assessment: cached, cached: true });
    }

    // Collapse simultaneous requests (e.g. two open tabs) into one model call.
    if (!inflight) {
      inflight = runAssessment(readings, context, now)
        .then(async (a) => {
          await store.setAssessment(a);
          return a;
        })
        .finally(() => {
          inflight = null;
        });
    }
    const assessment = await inflight;
    return json({ assessment, cached: false });
  } catch (e) {
    const status = e instanceof ClaudeError ? e.status : 502;
    return json({ error: (e as Error).message }, status >= 400 && status < 600 ? status : 502);
  }
}
