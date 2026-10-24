// GET /api/state - everything the dashboard needs in one poll.

import { analyze } from "../../../lib/analyze.ts";
import { checkApp, json } from "../../../lib/auth.ts";
import { model } from "../../../lib/claude.ts";
import { ANALYSIS_WINDOW, getStore, storageIsEphemeral } from "../../../lib/store.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;

  const store = getStore();
  try {
    const [readings, context, assessment] = await Promise.all([
      store.recent(ANALYSIS_WINDOW),
      store.getContext(),
      store.getAssessment(),
    ]);
    const now = Date.now();
    const { stats, signals, window } = analyze(readings, now);
    return json({
      now,
      storage: store.kind,
      storageEphemeral: storageIsEphemeral(store),
      apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
      model: model(),
      window,
      stats,
      signals,
      log: readings.slice(-80).map((r) => ({ t: r.t, raw: r.raw, kind: r.kind })),
      context,
      assessment,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
