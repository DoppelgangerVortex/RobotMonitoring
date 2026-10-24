// Storage for readings, the setup description and the latest assessment.
//
// On Vercel, serverless functions don't share memory, so readings must live in
// Redis. Add Upstash Redis from the Vercel Marketplace (or any Upstash database)
// and the env vars below are set for you. Without them the app keeps data in
// memory, which is fine for `npm run dev` on your own computer.

import type { Assessment, Reading } from "./types.ts";

export const MAX_STORED = 1000; // readings kept
export const ANALYSIS_WINDOW = 400; // readings analyzed / sent to the model

const K_READINGS = "sa:readings";
const K_CONTEXT = "sa:context";
const K_ASSESSMENT = "sa:assessment";

export interface Store {
  kind: "redis" | "memory";
  addReadings(rs: Reading[]): Promise<void>;
  /** Most recent readings, oldest first. */
  recent(n: number): Promise<Reading[]>;
  clearReadings(): Promise<void>;
  getContext(): Promise<string>;
  setContext(text: string): Promise<void>;
  getAssessment(): Promise<Assessment | null>;
  setAssessment(a: Assessment | null): Promise<void>;
}

// ---------- In-memory (local dev) ----------

interface Mem {
  readings: Reading[];
  context: string;
  assessment: Assessment | null;
}

function memStore(): Store {
  const g = globalThis as unknown as { __sensorAgentMem?: Mem };
  g.__sensorAgentMem ??= { readings: [], context: "", assessment: null };
  const m = g.__sensorAgentMem;
  return {
    kind: "memory",
    async addReadings(rs) {
      m.readings.push(...rs);
      m.readings.sort((a, b) => a.t - b.t);
      if (m.readings.length > MAX_STORED) m.readings.splice(0, m.readings.length - MAX_STORED);
    },
    async recent(n) {
      return m.readings.slice(-n);
    },
    async clearReadings() {
      m.readings = [];
      m.assessment = null;
    },
    async getContext() {
      return m.context;
    },
    async setContext(text) {
      m.context = text;
    },
    async getAssessment() {
      return m.assessment;
    },
    async setAssessment(a) {
      m.assessment = a;
    },
  };
}

// ---------- Upstash Redis over its REST API (no extra packages) ----------

function redisStore(url: string, token: string): Store {
  async function pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Redis request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const err = out.find((r) => r.error);
    if (err) throw new Error(`Redis error: ${err.error}`);
    return out.map((r) => r.result);
  }

  return {
    kind: "redis",
    async addReadings(rs) {
      if (!rs.length) return;
      // Newest at the head of the list.
      const sorted = [...rs].sort((a, b) => a.t - b.t);
      await pipeline([
        ["LPUSH", K_READINGS, ...sorted.map((r) => JSON.stringify(r))],
        ["LTRIM", K_READINGS, 0, MAX_STORED - 1],
      ]);
    },
    async recent(n) {
      const [list] = await pipeline([["LRANGE", K_READINGS, 0, n - 1]]);
      const rs = ((list as string[] | null) ?? []).map((s) => JSON.parse(s) as Reading);
      return rs.sort((a, b) => a.t - b.t);
    },
    async clearReadings() {
      await pipeline([
        ["DEL", K_READINGS],
        ["DEL", K_ASSESSMENT],
      ]);
    },
    async getContext() {
      const [v] = await pipeline([["GET", K_CONTEXT]]);
      return (v as string | null) ?? "";
    },
    async setContext(text) {
      await pipeline([["SET", K_CONTEXT, text]]);
    },
    async getAssessment() {
      const [v] = await pipeline([["GET", K_ASSESSMENT]]);
      return v ? (JSON.parse(v as string) as Assessment) : null;
    },
    async setAssessment(a) {
      await pipeline([a ? ["SET", K_ASSESSMENT, JSON.stringify(a)] : ["DEL", K_ASSESSMENT]]);
    },
  };
}

export function getStore(): Store {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? redisStore(url, token) : memStore();
}

/** True when running on Vercel without Redis, where data would vanish between requests. */
export function storageIsEphemeral(store: Store): boolean {
  return store.kind === "memory" && !!process.env.VERCEL;
}
