// The agent: builds a data brief, asks Claude for a structured assessment, and answers questions.

import { analyze, formatAge, type Analysis } from "./analyze.ts";
import { createMessage, model, streamText, type MessageParam, type Tool } from "./claude.ts";
import type { Assessment, ChatTurn, Reading } from "./types.ts";

const SYSTEM = `You are the monitoring agent for a hobbyist or student Arduino project. Readings arrive over USB serial as text lines. Your jobs:

1. Work out which sensors are connected. Use the user's setup description first, then field names, units, value ranges, resolution (e.g. integers from 0-1023 are raw 10-bit analog readings; 0-4095 is 12-bit), update rate, and any text the sketch prints (library names, error messages). Name a likely sensor model only when the evidence supports it, and say how confident you are.
2. Judge whether each reading is normal for what it most likely measures and the setting the user describes. Use typical ranges (indoor temperature, comfortable humidity, plant soil moisture, CO2 ppm, etc.), the trend, and sudden changes.
3. Separate real-world conditions from sensor or wiring problems. Constant values, values pinned at 0 or full scale, nan, -127 from a DS18B20, error text, and gaps in data usually mean hardware or code issues, not the environment.
4. Explain in plain language that a beginner can follow, and give concrete next steps.

Rules:
- Base every claim on the data provided. Do not invent readings or history.
- If something is ambiguous, say so and ask one specific question about the setup.
- Raw analog values have no physical unit until calibrated. Say this rather than guessing a unit.
- Hobby gas, smoke and CO sensors (MQ-series and similar) are not calibrated safety devices. Never call air "safe" based on them alone. If readings suggest smoke, gas or CO, tell the user to treat it as a possible real hazard (ventilate, leave, use a certified detector, call emergency services if people feel unwell) while noting the sensor's limits.
- Same for anything involving mains power, heat sources, batteries or water near electronics: flag real hazards plainly.
- Keep wording short and specific. No filler.`;

const ASSESS_TOOL: Tool = {
  name: "submit_assessment",
  description: "Submit the assessment of the current sensor readings.",
  input_schema: {
    type: "object",
    properties: {
      overall_status: {
        type: "string",
        enum: ["ok", "watch", "warning", "critical", "unknown"],
        description:
          "ok = all normal; watch = drifting or slightly off; warning = needs attention soon; critical = act now; unknown = not enough information.",
      },
      headline: {
        type: "string",
        description: "One plain-language sentence (max ~110 characters) stating the current situation.",
      },
      summary: { type: "string", description: "2-4 sentences explaining what is going on and why." },
      sensors: {
        type: "array",
        description: "One entry per data field.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "The field key exactly as given in the data." },
            likely_sensor: {
              type: "string",
              description: "Short display name, e.g. 'DHT22 temperature' or 'Analog sensor on A0'.",
            },
            measures: { type: "string", description: "What it measures, e.g. 'Air temperature'." },
            unit: { type: "string", description: "Unit, or 'raw' for uncalibrated analog values." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            why: { type: "string", description: "One sentence: the evidence for the identification." },
            status: { type: "string", enum: ["ok", "watch", "warning", "critical", "unknown"] },
            explanation: { type: "string", description: "1-2 sentences on what the current value means." },
          },
          required: ["field", "likely_sensor", "measures", "unit", "confidence", "why", "status", "explanation"],
        },
      },
      warnings: {
        type: "array",
        description: "Problems worth the user's attention, most severe first. Empty if none.",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["info", "warning", "critical"] },
            field: { type: "string", description: "Related field key, or empty string." },
            title: { type: "string", description: "Short title, sentence case." },
            detail: { type: "string", description: "What is happening and why it matters." },
            action: { type: "string", description: "What to do about it." },
          },
          required: ["severity", "field", "title", "detail", "action"],
        },
      },
      data_quality: {
        type: "array",
        items: { type: "string" },
        description: "Notes about wiring, noise, gaps or calibration. Empty if none.",
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description: "Up to 3 questions whose answers would make the assessment more accurate. Empty if none.",
      },
    },
    required: ["overall_status", "headline", "summary", "sensors", "warnings", "data_quality", "questions"],
  },
};

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return x.toExponential(3);
  return String(Math.round(x * 1000) / 1000);
}

/** Compact, factual text description of the data for the model. */
export function buildBrief(readings: Reading[], analysis: Analysis, context: string, now = Date.now()): string {
  const { stats, signals, window } = analysis;
  const lines: string[] = [];
  lines.push(`Current time: ${new Date(now).toISOString()}`);
  lines.push("");
  lines.push("## User's description of the setup");
  lines.push(context.trim() || "(none given)");
  lines.push("");
  lines.push("## Data window");
  if (window.firstT !== null && window.lastT !== null) {
    lines.push(
      `${window.count} lines (${window.dataCount} with data) over ${formatAge(window.lastT - window.firstT)}; last line ${formatAge(now - window.lastT)} ago.` +
        (window.medianIntervalMs ? ` Typical interval ${fmt(window.medianIntervalMs / 1000)} s.` : ""),
    );
  } else {
    lines.push("No readings yet.");
  }
  const devices = [...new Set(readings.map((r) => r.device).filter(Boolean))];
  if (devices.length) lines.push(`Device name(s): ${devices.join(", ")}`);
  lines.push("");
  lines.push("## Fields (parsed from the serial text)");
  if (!stats.length) lines.push("(no numeric fields)");
  for (const s of stats) {
    lines.push(
      `- ${s.key}${s.unit ? ` [${s.unit}]` : ""}: latest ${fmt(s.latest)}, min ${fmt(s.min)}, max ${fmt(s.max)}, mean ${fmt(s.mean)}, std ${fmt(s.std)}, trend ${fmt(s.slopePerMin)}/min, n=${s.count}` +
        (s.integerOnly ? ", integers only" : "") +
        (s.invalidCount ? `, ${s.invalidCount} invalid (nan/inf)` : ""),
    );
  }
  lines.push("");
  lines.push("## Automatic checks");
  if (!signals.length) lines.push("(nothing flagged)");
  for (const sig of signals) lines.push(`- [${sig.severity}] ${sig.message}`);
  lines.push("");
  lines.push("## Most recent serial lines (oldest first)");
  const tail = readings.slice(-30);
  for (const r of tail) lines.push(`${new Date(r.t).toISOString().slice(11, 19)}  ${r.raw}`);
  const errs = readings.filter((r) => r.kind === "message").slice(-10);
  const shown = new Set(tail);
  const extra = errs.filter((r) => !shown.has(r));
  if (extra.length) {
    lines.push("");
    lines.push("## Earlier text-only lines");
    for (const r of extra) lines.push(`${new Date(r.t).toISOString().slice(11, 19)}  ${r.raw}`);
  }
  return lines.join("\n");
}

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

type AssessmentBody = Omit<
  Assessment,
  "generatedAt" | "basedOnT" | "readingCount" | "contextHash" | "localWarnCount" | "model"
>;

const STATUSES = ["ok", "watch", "warning", "critical", "unknown"];

/** Defensive clean-up so the UI never breaks on an unexpected shape. */
function sanitize(input: unknown): AssessmentBody {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 600) => (typeof v === "string" ? v.slice(0, max) : "");
  const status = (v: unknown) => (STATUSES.includes(v as string) ? (v as Assessment["overall_status"]) : "unknown");
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    overall_status: status(o.overall_status),
    headline: str(o.headline, 200) || "Assessment complete.",
    summary: str(o.summary, 1200),
    sensors: arr(o.sensors)
      .slice(0, 30)
      .map((s: Record<string, unknown>) => ({
        field: str(s.field, 60),
        likely_sensor: str(s.likely_sensor, 80),
        measures: str(s.measures, 80),
        unit: str(s.unit, 20),
        confidence: (["high", "medium", "low"].includes(s.confidence as string) ? s.confidence : "low") as
          | "high"
          | "medium"
          | "low",
        why: str(s.why, 300),
        status: status(s.status),
        explanation: str(s.explanation, 400),
      })),
    warnings: arr(o.warnings)
      .slice(0, 10)
      .map((w: Record<string, unknown>) => ({
        severity: (["info", "warning", "critical"].includes(w.severity as string) ? w.severity : "info") as
          | "info"
          | "warning"
          | "critical",
        field: str(w.field, 60),
        title: str(w.title, 120),
        detail: str(w.detail, 600),
        action: str(w.action, 400),
      })),
    data_quality: arr(o.data_quality).map((x) => str(x, 300)).filter(Boolean).slice(0, 8),
    questions: arr(o.questions).map((x) => str(x, 300)).filter(Boolean).slice(0, 3),
  };
}

export async function runAssessment(readings: Reading[], context: string, now = Date.now()): Promise<Assessment> {
  const analysis = analyze(readings, now);
  const brief = buildBrief(readings, analysis, context, now);
  const res = await createMessage({
    model: model(),
    max_tokens: 3000,
    system: SYSTEM,
    tools: [ASSESS_TOOL],
    tool_choice: { type: "tool", name: ASSESS_TOOL.name },
    messages: [{ role: "user", content: `Assess these Arduino sensor readings.\n\n${brief}` }],
  });
  const block = res.content.find((b) => b.type === "tool_use") as { input: unknown } | undefined;
  if (!block) throw new Error("Claude did not return an assessment.");
  return {
    ...sanitize(block.input),
    generatedAt: now,
    basedOnT: analysis.window.lastT ?? 0,
    readingCount: readings.length,
    contextHash: hashText(context),
    localWarnCount: analysis.signals.filter((s) => s.severity === "warning").length,
    model: model(),
  };
}

export async function streamChat(
  history: ChatTurn[],
  readings: Reading[],
  context: string,
  assessment: Assessment | null,
  now = Date.now(),
): Promise<ReadableStream<Uint8Array>> {
  const analysis = analyze(readings, now);
  const brief = buildBrief(readings, analysis, context, now);
  const latest = assessment
    ? `\n\n## Your latest assessment (${formatAge(now - assessment.generatedAt)} ago)\n${JSON.stringify({
        overall_status: assessment.overall_status,
        headline: assessment.headline,
        sensors: assessment.sensors.map((s) => ({ field: s.field, likely_sensor: s.likely_sensor, status: s.status })),
        warnings: assessment.warnings.map((w) => w.title),
      })}`
    : "";

  const system = `${SYSTEM}

You are now answering the user's questions in a chat beside their live dashboard. Answer in short plain paragraphs; use a simple "- " list only when listing steps. No headings, no tables. If the user tells you something new about their setup, use it and suggest they add it to the setup description so future assessments use it too.

# Live data
${brief}${latest}`;

  const messages: MessageParam[] = history
    .filter((t) => t.content.trim())
    .slice(-20)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));
  // The API needs the conversation to start with a user turn.
  while (messages.length && messages[0].role !== "user") messages.shift();

  return streamText({ model: model(), max_tokens: 1500, system, messages });
}
