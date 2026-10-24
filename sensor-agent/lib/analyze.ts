// Cheap, rule-based analysis that runs on every poll. It gives the dashboard
// numbers to draw and gives the model hard facts (stats + red flags) to reason over.

import { looksLikeError } from "./parse.ts";
import type { FieldStats, Reading, Signal } from "./types.ts";

export interface WindowInfo {
  count: number;
  dataCount: number;
  firstT: number | null;
  lastT: number | null;
  medianIntervalMs: number | null;
}

export interface Analysis {
  stats: FieldStats[];
  signals: Signal[];
  window: WindowInfo;
}

const SERIES_POINTS = 120;
/** Values well-known sensors report when they are disconnected or failing. */
const ERROR_VALUES = new Map<number, string>([
  [-127, "-127 is what DS18B20 temperature sensors report when they are disconnected"],
  [-196.6, "-196.6 (°F) is what DS18B20 temperature sensors report when they are disconnected"],
  [-999, "-999 is a common 'no reading' placeholder"],
]);
const RAIL_VALUES = new Set([0, 1023, 4095, 65535]);

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/** Keeps spikes visible: each bucket contributes its min and max, in time order. */
function downsample(points: [number, number][], target: number): [number, number][] {
  if (points.length <= target) return points;
  const buckets = Math.floor(target / 2);
  const size = points.length / buckets;
  const out: [number, number][] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = points.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!slice.length) continue;
    let lo = slice[0];
    let hi = slice[0];
    for (const p of slice) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
  }
  return out;
}

function slopePerMinute(points: [number, number][]): number {
  const pts = points.slice(-200);
  if (pts.length < 3) return 0;
  const t0 = pts[0][0];
  const xs = pts.map((p) => (p[0] - t0) / 60000);
  const ys = pts.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** @param readings oldest first */
export function analyze(readings: Reading[], now = Date.now()): Analysis {
  const data = readings.filter((r) => r.kind === "data");
  const signals: Signal[] = [];

  // Window timing.
  const intervals: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i].t - data[i - 1].t;
    if (d > 0) intervals.push(d);
  }
  const medianInterval = intervals.length ? median(intervals.slice(-100)) : null;
  const window: WindowInfo = {
    count: readings.length,
    dataCount: data.length,
    firstT: readings[0]?.t ?? null,
    lastT: readings.at(-1)?.t ?? null,
    medianIntervalMs: medianInterval,
  };

  // Collect per-field series.
  const series = new Map<string, [number, number][]>();
  const units = new Map<string, string>();
  const invalid = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  data.forEach((r, idx) => {
    for (const [k, v] of Object.entries(r.values)) {
      if (!series.has(k)) series.set(k, []);
      series.get(k)!.push([r.t, v]);
      if (!firstSeen.has(k)) firstSeen.set(k, idx);
    }
    for (const [k, u] of Object.entries(r.units)) units.set(k, u);
    for (const k of r.invalid) {
      invalid.set(k, (invalid.get(k) ?? 0) + 1);
      if (!firstSeen.has(k)) firstSeen.set(k, idx);
    }
  });

  const stats: FieldStats[] = [];
  for (const [key, pts] of series) {
    const vals = pts.map((p) => p[1]);
    const n = vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const latest = vals[n - 1];
    const s: FieldStats = {
      key,
      unit: units.get(key),
      count: n,
      latest,
      latestAt: pts[n - 1][0],
      min: Math.min(...vals),
      max: Math.max(...vals),
      mean: round(mean),
      std: round(std),
      slopePerMin: round(slopePerMinute(pts)),
      integerOnly: vals.every((v) => Number.isInteger(v)),
      invalidCount: invalid.get(key) ?? 0,
      series: downsample(pts, SERIES_POINTS),
    };
    stats.push(s);

    // Known error values (e.g. DS18B20 unplugged).
    const errNote = ERROR_VALUES.get(latest);
    if (errNote) {
      signals.push({ severity: "warning", code: "rail", field: key, message: `${key} is ${latest}. ${errNote}.` });
    }

    const recent = vals.slice(-20);
    const recentConst = recent.length >= 10 && recent.every((v) => v === recent[0]);
    // Stuck at an ADC rail: integer readings pinned at 0 or full scale.
    if (!errNote && recentConst && s.integerOnly && RAIL_VALUES.has(latest) && new Set(vals).size > 2) {
      signals.push({
        severity: "warning",
        code: "rail",
        field: key,
        message: `${key} has been stuck at ${latest} for the last ${recent.length} readings after varying earlier. Pinned at 0 or full scale usually means a loose wire or a floating/shorted pin.`,
      });
    } else if (!errNote && recent.length >= 20 && recentConst && new Set(vals).size > 1) {
      signals.push({
        severity: "info",
        code: "flatline",
        field: key,
        message: `${key} has not changed for the last ${recent.length} readings (stuck at ${latest}).`,
      });
    }

    // Spike: latest is far from the recent median, judged by median absolute deviation.
    const prev = vals.slice(-51, -1);
    if (prev.length >= 15 && new Set(prev).size > 2) {
      const med = median(prev);
      const mad = median(prev.map((v) => Math.abs(v - med)));
      const scale = 1.4826 * mad;
      if (scale > 0) {
        const z = Math.abs(latest - med) / scale;
        if (z > 8) {
          signals.push({
            severity: "warning",
            code: "spike",
            field: key,
            message: `${key} jumped to ${latest} (recent typical value ${round(med, 3)}). That is an unusually large change.`,
          });
        }
      }
    }
  }

  // Fields that report as nan/inf.
  for (const [key, n] of invalid) {
    const lastBad = data.slice(-20).filter((r) => r.invalid.includes(key)).length;
    if (lastBad > 0) {
      signals.push({
        severity: "warning",
        code: "invalid_values",
        field: key,
        message: `${key} was not a number (nan/inf) in ${lastBad} of the last ${Math.min(20, data.length)} readings (${n} in total). Often a loose wire, wrong pin, or missing pull-up resistor.`,
      });
    }
  }

  // Fields that stopped appearing.
  if (data.length >= 15) {
    const last10 = data.slice(-10);
    for (const [key, idx] of firstSeen) {
      if (idx > data.length - 15) continue;
      const present = last10.some((r) => key in r.values || r.invalid.includes(key));
      if (!present) {
        signals.push({
          severity: "info",
          code: "field_missing",
          field: key,
          message: `${key} was reported earlier but is missing from the last 10 readings.`,
        });
      }
    }
  }

  // Error messages printed by the sketch.
  const errLines = readings.slice(-30).filter((r) => r.kind === "message" && looksLikeError(r.raw));
  if (errLines.length) {
    signals.push({
      severity: "warning",
      code: "sensor_errors",
      message: `The Arduino printed ${errLines.length} error message${errLines.length > 1 ? "s" : ""} recently, e.g. "${errLines.at(-1)!.raw.slice(0, 80)}".`,
    });
  }

  // No data arriving.
  if (window.lastT !== null) {
    const expected = Math.max(60_000, (medianInterval ?? 0) * 5);
    const age = now - window.lastT;
    if (age > expected) {
      signals.push({
        severity: "warning",
        code: "stale",
        message: `No readings for ${formatAge(age)}. Check that the Arduino is plugged in and the bridge script is running.`,
      });
    }
  }

  return { stats, signals, window };
}
