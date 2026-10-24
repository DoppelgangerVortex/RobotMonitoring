// Shared types for the sensor agent.

/** One line received from the Arduino, after parsing. */
export interface Reading {
  /** Time the line was read (ms since epoch). */
  t: number;
  /** The line exactly as the Arduino printed it (trimmed). */
  raw: string;
  /** "data" if it held numbers, "message" if it was text only (errors, boot messages). */
  kind: "data" | "message";
  /** Parsed numeric fields, keyed by a normalized name, e.g. { temperature: 23.4 }. */
  values: Record<string, number>;
  /** Units seen next to a field, e.g. { temperature: "°C" }. */
  units: Record<string, string>;
  /** Fields that were present but not a number (nan, inf, ovf...). */
  invalid: string[];
  /** Optional device name sent by the bridge. */
  device?: string;
}

export interface FieldStats {
  key: string;
  unit?: string;
  count: number;
  latest: number;
  latestAt: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  /** Change per minute, from a linear fit over the window. */
  slopePerMin: number;
  /** True if every value is integer-valued (often a raw analog/ADC reading). */
  integerOnly: boolean;
  invalidCount: number;
  /** Down-sampled [time, value] points for drawing. */
  series: [number, number][];
}

export type SignalSeverity = "info" | "warning";

/** A rule-based observation computed without the model (cheap, instant). */
export interface Signal {
  severity: SignalSeverity;
  code:
    | "flatline"
    | "spike"
    | "jump"
    | "rail"
    | "invalid_values"
    | "sensor_errors"
    | "stale"
    | "field_missing";
  field?: string;
  message: string;
}

export type Status = "ok" | "watch" | "warning" | "critical" | "unknown";

export interface SensorAssessment {
  field: string;
  likely_sensor: string;
  measures: string;
  unit: string;
  confidence: "high" | "medium" | "low";
  why: string;
  status: Status;
  explanation: string;
}

export interface AgentWarning {
  severity: "info" | "warning" | "critical";
  field: string;
  title: string;
  detail: string;
  action: string;
}

export interface Assessment {
  overall_status: Status;
  headline: string;
  summary: string;
  sensors: SensorAssessment[];
  warnings: AgentWarning[];
  data_quality: string[];
  questions: string[];
  // Bookkeeping added by the server:
  generatedAt: number;
  basedOnT: number;
  readingCount: number;
  contextHash: string;
  localWarnCount: number;
  model: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
