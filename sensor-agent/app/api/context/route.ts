// PUT /api/context - saves the user's description of their setup.
// Body: { "text": "Arduino Uno, DHT22 on pin 2 in my greenhouse, capacitive soil sensor on A0" }

import { checkApp, json } from "../../../lib/auth.ts";
import { getStore } from "../../../lib/store.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 2000;

export async function PUT(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  let text: string;
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return json({ error: "Send JSON with a text field." }, 400);
  }
  if (text.length > MAX) return json({ error: `Keep the description under ${MAX} characters.` }, 413);
  await getStore().setContext(text);
  return json({ saved: true, text });
}
