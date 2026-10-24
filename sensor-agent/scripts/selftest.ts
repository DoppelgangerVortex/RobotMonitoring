// Self-test: runs the parser, the analysis and every API route with the Claude API mocked.
// Run with: npm run selftest   (Node 22.18+ runs TypeScript directly)

import assert from "node:assert/strict";
import { analyze } from "../lib/analyze.ts";
import { buildBrief } from "../lib/agent.ts";
import { parseLine } from "../lib/parse.ts";
import type { Reading } from "../lib/types.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n${(e as Error).stack}`);
    process.exitCode = 1;
  }
}

// ---------- Parser ----------

const P = (s: string) => parseLine(s, 0)!;
await test("key=value pairs", () => assert.deepEqual(P("temp=23.4,hum=51").values, { temp: 23.4, hum: 51 }));
await test("DHT library style with units", () => {
  const r = P("Humidity: 45.00 %\tTemperature: 23.40 *C");
  assert.deepEqual(r.values, { humidity: 45, temperature: 23.4 });
  assert.deepEqual(r.units, { humidity: "%", temperature: "°C" });
});
await test("space separated labels with units", () =>
  assert.deepEqual(P("CO2: 812 ppm, TVOC: 13 ppb").units, { co2: "ppm", tvoc: "ppb" }));
await test("JSON, nested", () => assert.deepEqual(P('{"t":1.5,"gas":{"raw":312}}').values, { t: 1.5, gas_raw: 312 }));
await test("bare CSV", () => assert.deepEqual(P("23.4,51.0,512").values, { value1: 23.4, value2: 51, value3: 512 }));
await test("label value unit without separator", () =>
  assert.deepEqual(P("Distance 23 cm Light 400").values, { distance: 23, light: 400 }));
await test("pin names stay labels", () => assert.deepEqual(P("A0 512").values, { a0: 512 }));
await test("nan is recorded as invalid", () => assert.deepEqual(P("temp=nan, hum=nan").invalid, ["temp", "hum"]));
await test("error text is a message", () => assert.equal(P("Failed to read from DHT sensor!").kind, "message"));
await test("IDE timestamp is ignored", () =>
  assert.deepEqual(P("12:34:56.789 -> temp=23.4 hum=40").values, { temp: 23.4, hum: 40 }));
await test("blank line is skipped", () => assert.equal(parseLine("   \r", 0), null));

// ---------- Analysis ----------

function series(make: (i: number) => string, n: number, start = Date.now() - n * 2000): Reading[] {
  return Array.from({ length: n }, (_, i) => parseLine(make(i), start + i * 2000)!);
}

await test("stats and trend", () => {
  const rs = series((i) => `temp=${20 + i * 0.1}`, 60);
  const a = analyze(rs);
  const s = a.stats.find((x) => x.key === "temp")!;
  assert.equal(s.count, 60);
  assert.ok(Math.abs(s.slopePerMin - 3) < 0.01, `slope ${s.slopePerMin}`);
  assert.equal(a.signals.length, 0);
});
await test("spike is flagged", () => {
  const rs = series((i) => `temp=${i === 59 ? 80 : 22 + Math.sin(i) * 0.3}`, 60);
  assert.ok(analyze(rs).signals.some((s) => s.code === "spike" && s.field === "temp"));
});
await test("analog pin stuck at 1023 is flagged", () => {
  const rs = series((i) => `soil=${i < 40 ? 400 + (i % 5) : 1023}`, 60);
  assert.ok(analyze(rs).signals.some((s) => s.code === "rail"));
});
await test("DS18B20 -127 is flagged", () => {
  const rs = series((i) => `temp=${i < 30 ? 21.5 : -127}`, 31);
  assert.ok(analyze(rs).signals.some((s) => s.code === "rail" && /DS18B20/.test(s.message)));
});
await test("nan and error lines are flagged", () => {
  const rs = series((i) => (i % 4 === 0 ? "Failed to read from DHT sensor!" : i % 4 === 1 ? "temp=nan" : `temp=${21 + (i % 3) * 0.1}`), 40);
  const codes = analyze(rs).signals.map((s) => s.code);
  assert.ok(codes.includes("invalid_values") && codes.includes("sensor_errors"), codes.join(","));
});
await test("stale data is flagged", () => {
  const rs = series((i) => `temp=${21 + (i % 3) * 0.1}`, 20, Date.now() - 20 * 60_000);
  assert.ok(analyze(rs).signals.some((s) => s.code === "stale"));
});
await test("brief includes context, fields and lines", () => {
  const rs = series((i) => `temp=${21 + (i % 3) * 0.1}`, 20);
  const brief = buildBrief(rs, analyze(rs), "DHT22 in my bedroom");
  assert.match(brief, /DHT22 in my bedroom/);
  assert.match(brief, /- temp: latest/);
  assert.match(brief, /temp=21/);
});

// ---------- API routes, with the Claude API mocked ----------

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.INGEST_TOKEN = "tok";
process.env.APP_PASSWORD = "pw";
process.env.ASSESS_MIN_INTERVAL_SEC = "0";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const claudeCalls: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body));
  claudeCalls.push(body);
  if (body.stream) {
    const events = [
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Your DHT22 " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "looks fine." } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json({
    id: "m",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "t",
        name: "submit_assessment",
        input: {
          overall_status: "ok",
          headline: "Room conditions are normal.",
          summary: "Temperature and humidity are steady.",
          sensors: [
            { field: "temperature", likely_sensor: "DHT22 temperature", measures: "Air temperature", unit: "°C", confidence: "high", why: "DHT label output", status: "ok", explanation: "Comfortable." },
          ],
          warnings: [],
          data_quality: [],
          questions: ["Where is the sensor placed?"],
        },
      },
    ],
  });
}) as typeof fetch;

const readings = await import("../app/api/readings/route.ts");
const state = await import("../app/api/state/route.ts");
const assess = await import("../app/api/assess/route.ts");
const chat = await import("../app/api/chat/route.ts");
const context = await import("../app/api/context/route.ts");

const H = { "x-app-password": "pw", "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}) => new Request(`http://local${path}`, init);

await test("ingest rejects a wrong token", async () => {
  const res = await readings.POST(req("/api/readings", { method: "POST", body: "temp=1", headers: { authorization: "Bearer nope" } }));
  assert.equal(res.status, 401);
});
await test("ingest accepts JSON batches and plain text", async () => {
  const now = Date.now();
  const lines = Array.from({ length: 30 }, (_, i) => ({ raw: `Humidity: ${45 + (i % 3)} %\tTemperature: ${22 + (i % 4) * 0.1} *C`, t: now - (30 - i) * 2000 }));
  let res = await readings.POST(
    req("/api/readings", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ device: "uno", lines }) }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accepted, 30);
  res = await readings.POST(req("/api/readings", { method: "POST", headers: { "x-ingest-token": "tok" }, body: "Sensor ready\n\n" }));
  assert.deepEqual(await res.json(), { accepted: 1, skipped: 2, storage: "memory" });
});
await test("state requires the app password", async () => {
  assert.equal((await state.GET(req("/api/state"))).status, 401);
});
await test("state returns stats and log", async () => {
  const body = await (await state.GET(req("/api/state", { headers: H }))).json();
  assert.equal(body.window.count, 31);
  assert.deepEqual(body.stats.map((s: { key: string }) => s.key).sort(), ["humidity", "temperature"]);
  assert.equal(body.log.at(-1).raw, "Sensor ready");
});
await test("context saves", async () => {
  const res = await context.PUT(req("/api/context", { method: "PUT", headers: H, body: JSON.stringify({ text: "DHT22 in my bedroom" }) }));
  assert.equal((await res.json()).text, "DHT22 in my bedroom");
});
await test("assess calls Claude with a forced tool and caches the result", async () => {
  let body = await (await assess.POST(req("/api/assess", { method: "POST", headers: H, body: "{}" }))).json();
  assert.equal(body.cached, false);
  assert.equal(body.assessment.overall_status, "ok");
  assert.equal(body.assessment.sensors[0].likely_sensor, "DHT22 temperature");
  const call = claudeCalls.at(-1)!;
  assert.deepEqual(call.tool_choice, { type: "tool", name: "submit_assessment" });
  assert.match(JSON.stringify(call.messages), /DHT22 in my bedroom/);
  const n = claudeCalls.length;
  body = await (await assess.POST(req("/api/assess", { method: "POST", headers: H, body: "{}" }))).json();
  assert.equal(body.cached, true);
  assert.equal(claudeCalls.length, n, "no second Claude call when nothing changed");
});
await test("chat streams text", async () => {
  const res = await chat.POST(
    req("/api/chat", { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "Is it ok?" }] }) }),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "Your DHT22 looks fine.");
  assert.match(String(claudeCalls.at(-1)!.system), /Live data/);
});
await test("chat rejects an empty question", async () => {
  const res = await chat.POST(req("/api/chat", { method: "POST", headers: H, body: JSON.stringify({ messages: [] }) }));
  assert.equal(res.status, 400);
});
await test("clear readings", async () => {
  await readings.DELETE(req("/api/readings", { method: "DELETE", headers: H }));
  const body = await (await state.GET(req("/api/state", { headers: H }))).json();
  assert.equal(body.window.count, 0);
  assert.equal(body.assessment, null);
});

console.log(process.exitCode ? "\nSome tests failed." : `\nAll ${passed} tests passed.`);
