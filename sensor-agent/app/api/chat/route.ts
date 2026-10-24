// POST /api/chat - ask the agent about the live readings. Streams plain text back.
// Body: { "messages": [{ "role": "user", "content": "Why is humidity rising?" }, ...] }

import { streamChat } from "../../../lib/agent.ts";
import { checkApp, json } from "../../../lib/auth.ts";
import { ClaudeError } from "../../../lib/claude.ts";
import { ANALYSIS_WINDOW, getStore } from "../../../lib/store.ts";
import type { ChatTurn } from "../../../lib/types.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;

  let messages: ChatTurn[];
  try {
    const body = (await req.json()) as { messages?: unknown };
    messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is ChatTurn =>
          !!m &&
          typeof m === "object" &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .slice(-20);
  } catch {
    return json({ error: "Send JSON with a messages array." }, 400);
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) return json({ error: "The last message must be a question." }, 400);
  if (last.content.length > 2000) return json({ error: "Keep questions under 2,000 characters." }, 413);

  const store = getStore();
  try {
    const [readings, context, assessment] = await Promise.all([
      store.recent(ANALYSIS_WINDOW),
      store.getContext(),
      store.getAssessment(),
    ]);
    const stream = await streamChat(messages, readings, context, assessment);
    return new Response(stream, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (e) {
    const status = e instanceof ClaudeError ? e.status : 502;
    return json({ error: (e as Error).message }, status >= 400 && status < 600 ? status : 502);
  }
}
