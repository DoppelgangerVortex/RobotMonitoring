// Settings come from (highest priority first): command-line flags, environment
// variables, then a .env file in this folder.
//
//   --url      APP_URL       where the web app runs (default http://localhost:3000)
//   --token    INGEST_TOKEN  must match INGEST_TOKEN on the server
//   --port     SERIAL_PORT   e.g. COM3 or /dev/ttyACM0 (default: auto-detect)
//   --baud     BAUD          must match Serial.begin() in your sketch (default 9600)
//   --device   DEVICE        a name for this Arduino (default "arduino")
//   --batch    BATCH_MS      how often to send readings, in ms (default 5000)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const file = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

export function config() {
  loadDotEnv();
  const f = flags(process.argv.slice(2));
  const env = process.env;
  return {
    flags: f,
    url: String(f.url ?? env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    token: String(f.token ?? env.INGEST_TOKEN ?? ""),
    port: f.port ?? env.SERIAL_PORT ?? "",
    baud: Number(f.baud ?? env.BAUD ?? 9600),
    device: String(f.device ?? env.DEVICE ?? "arduino"),
    batchMs: Math.max(1000, Number(f.batch ?? env.BATCH_MS ?? 5000)),
    quiet: !!f.quiet,
  };
}

/** Sends a batch of lines. Returns { ok, status, message }. */
export async function send(cfg, lines) {
  try {
    const res = await fetch(`${cfg.url}/api/readings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({ device: cfg.device, lines }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, message: `sent ${body.accepted ?? lines.length}` };
    if (res.status === 401) return { ok: false, status: 401, message: "the server rejected the token. Check INGEST_TOKEN matches on both sides." };
    return { ok: false, status: res.status, message: body.error || `server returned ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, message: `can't reach ${cfg.url} (${e.cause?.code || e.message})` };
  }
}
