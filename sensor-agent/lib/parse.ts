// Turns whatever an Arduino prints over serial into structured readings.
//
// Handles, among others:
//   temp=23.4,hum=51                       key=value pairs
//   Temperature: 23.40 *C  Humidity: 51 %  label: value unit (DHT library examples)
//   {"temp":23.4,"hum":51}                 JSON
//   23.4,51.0,512                          bare numbers / CSV (named value1, value2...)
//   Distance 23 cm                         label value unit, no separator
//   temp=nan                               invalid values are recorded, not dropped
//   Failed to read from DHT sensor!        text-only lines are kept as messages

import type { Reading } from "./types.ts";

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const BAD = String.raw`nan|-?inf(?:inity)?|ovf|err|null|undefined|--+`;
const SEP_VALUE = new RegExp(String.raw`[:=]\s*(${NUM}|${BAD})(?![\w.])`, "gi");
const DELIM = /[,;|\t]/;

const KNOWN_UNITS = new Set(
  [
    "%", "%rh", "rh", "°c", "°f", "*c", "*f", "c", "f", "k", "°", "deg",
    "mm", "cm", "m", "km", "in", "ft",
    "ppm", "ppb", "lux", "lx", "hpa", "pa", "kpa", "mbar", "bar", "psi", "atm", "inhg",
    "v", "mv", "a", "ma", "w", "mw", "kw", "kwh", "wh", "ω", "ohm", "ohms", "kω", "kohm",
    "db", "dba", "hz", "khz", "rpm", "g", "kg", "mg", "ug/m3", "µg/m³", "µg/m3", "mg/m3",
    "ms", "s", "us", "µs", "min", "h", "l/min", "lpm", "ml", "l", "m/s", "km/h", "mph",
    "ntu", "us/cm", "µs/cm", "ms/cm", "bpm", "%vol", "m/s2", "m/s²", "dps", "°/s", "gauss", "ut", "µt",
  ].map((u) => u.toLowerCase()),
);

function isUnit(token: string | undefined): boolean {
  if (!token) return false;
  return KNOWN_UNITS.has(token.toLowerCase());
}

function normUnit(u: string): string {
  const l = u.toLowerCase();
  if (l === "*c" || l === "c") return "°C";
  if (l === "*f" || l === "f") return "°F";
  if (l === "%rh" || l === "rh") return "%";
  return u;
}

/** "Soil Moisture (raw)" -> "soil_moisture_raw" */
export function normKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/°/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "value"
  );
}

function isBadValue(v: string): boolean {
  return new RegExp(`^(?:${BAD})$`, "i").test(v);
}

export function looksLikeError(line: string): boolean {
  return /\b(error|fail(ed|ure)?|timeout|timed out|not found|disconnected|no response|check wiring|invalid)\b/i.test(
    line,
  );
}

function uniqueKey(key: string, used: Set<string>): string {
  let k = key;
  let i = 2;
  while (used.has(k)) k = `${key}_${i++}`;
  used.add(k);
  return k;
}

interface Parsed {
  values: Record<string, number>;
  units: Record<string, string>;
  invalid: string[];
}

function emptyParsed(): Parsed {
  return { values: {}, units: {}, invalid: [] };
}

function parseJson(line: string): Parsed | null {
  if (!line.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const out = emptyParsed();
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = normKey(prefix ? `${prefix}_${k}` : k);
      if (typeof v === "number") {
        if (Number.isFinite(v)) out.values[key] = v;
        else out.invalid.push(key);
      } else if (typeof v === "boolean") {
        out.values[key] = v ? 1 : 0;
      } else if (typeof v === "string" && /^unit$/i.test(k)) {
        // {"value": 3, "unit": "cm"} style - handled below
      } else if (typeof v === "string" && isBadValue(v.trim())) {
        out.invalid.push(key);
      } else if (typeof v === "string" && new RegExp(`^${NUM}$`).test(v.trim())) {
        out.values[key] = Number(v);
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, key);
      }
    }
  };
  walk(obj as Record<string, unknown>, "");
  const o = obj as Record<string, unknown>;
  if (typeof o.unit === "string") {
    for (const k of Object.keys(out.values)) out.units[k] ??= normUnit(o.unit);
  }
  return out;
}

/** Splits the text between two values into [unit of the previous value, label of the next]. */
function splitGap(gap: string, hasNext: boolean): { unit?: string; label: string } {
  // If there is a delimiter, the unit is before the first one and the label after the last.
  if (DELIM.test(gap)) {
    const parts = gap.split(DELIM);
    const before = parts[0].trim();
    const after = parts[parts.length - 1].trim();
    const unitTok = before.split(/\s+/)[0];
    return { unit: isUnit(unitTok) ? unitTok : undefined, label: hasNext ? after : "" };
  }
  const tokens = gap.trim().split(/\s+/).filter(Boolean);
  if (!hasNext) return { unit: isUnit(tokens[0]) ? tokens[0] : undefined, label: "" };
  if (tokens.length >= 2 && isUnit(tokens[0])) return { unit: tokens[0], label: tokens.slice(1).join(" ") };
  return { label: tokens.join(" ") };
}

function parsePairs(line: string): Parsed | null {
  const matches = [...line.matchAll(SEP_VALUE)];
  if (matches.length === 0) return null;
  const out = emptyParsed();
  const used = new Set<string>();

  // The label of the first value is everything before its separator (after the last delimiter).
  let label = line.slice(0, matches[0].index).split(DELIM).pop()!.trim();

  matches.forEach((m, i) => {
    const valueText = m[1];
    const end = m.index! + m[0].length;
    const nextStart = i + 1 < matches.length ? matches[i + 1].index! : line.length;
    const { unit, label: nextLabel } = splitGap(line.slice(end, nextStart), i + 1 < matches.length);

    // Strip bracketed prefixes like "[DHT]" and trailing filler words from the label.
    const cleanLabel = label.replace(/^\[[^\]]*\]\s*/, "").trim();
    const key = uniqueKey(normKey(cleanLabel || `value${i + 1}`), used);
    if (isBadValue(valueText)) out.invalid.push(key);
    else {
      out.values[key] = Number(valueText);
      if (unit) out.units[key] = normUnit(unit);
    }
    label = nextLabel;
  });
  return out;
}

function parseLoose(line: string): Parsed | null {
  const re = new RegExp(`(${NUM})`, "g");
  // A number glued to letters ("A0", "DHT22") is part of a label, not a reading.
  const matches = [...line.matchAll(re)].filter((m) => {
    const prevChar = line[m.index! - 1];
    return !(prevChar && /[A-Za-z_]/.test(prevChar));
  });
  if (matches.length === 0) return null;
  const out = emptyParsed();
  const used = new Set<string>();
  matches.forEach((m, i) => {
    // Label: the word(s) directly before the number, if any (within the same delimited segment).
    const before = line.slice(0, m.index).split(DELIM).pop()!;
    const prevNumEnd = i > 0 ? matches[i - 1].index! + matches[i - 1][0].length : 0;
    const segStart = Math.max(prevNumEnd, m.index! - before.length);
    let words = line.slice(segStart, m.index).trim();
    // Drop a leading unit belonging to the previous number ("23 cm Light 400" -> "Light").
    const toks = words.split(/\s+/).filter(Boolean);
    if (toks.length && isUnit(toks[0]) && i > 0) toks.shift();
    words = toks.join(" ").replace(/[^A-Za-z0-9 _()#-]/g, "").trim();

    const after = line.slice(m.index! + m[0].length).split(DELIM)[0].trim().split(/\s+/)[0];
    const key = uniqueKey(words && /[a-z]/i.test(words) ? normKey(words) : `value${i + 1}`, used);
    out.values[key] = Number(m[1]);
    if (isUnit(after)) out.units[key] = normUnit(after);
  });
  return Object.keys(out.values).length ? out : null;
}

const MAX_LINE = 500;

/** Parses one serial line. Returns null for blank lines. */
export function parseLine(input: string, t: number, device?: string): Reading | null {
  const raw = input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX_LINE);
  if (!raw) return null;

  // Ignore a leading clock timestamp, e.g. the Arduino IDE's "12:34:56.789 -> ".
  const body = raw.replace(/^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:->)?\s*/, "") || raw;

  let parsed = parseJson(body) ?? parsePairs(body);
  if (!parsed && !looksLikeError(body)) parsed = parseLoose(body);

  const hasData = !!parsed && (Object.keys(parsed.values).length > 0 || parsed.invalid.length > 0);
  return {
    t,
    raw,
    kind: hasData ? "data" : "message",
    values: parsed?.values ?? {},
    units: parsed?.units ?? {},
    invalid: parsed?.invalid ?? [],
    ...(device ? { device: device.slice(0, 40) } : {}),
  };
}
