// Minimal Claude Messages API client using fetch (no SDK dependency).
// Docs: https://docs.claude.com/en/api/messages

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export function model(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: Tool[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  stream?: boolean;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

export interface MessagesResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export class ClaudeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeError(500, "ANTHROPIC_API_KEY is not set. Add it to your environment variables.");
  return key;
}

function explain(status: number, body: string): string {
  let detail = body.slice(0, 300);
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    /* not JSON */
  }
  if (status === 401) return "The Claude API rejected the API key. Check ANTHROPIC_API_KEY.";
  if (status === 404) return `Model not found: ${detail}. Check ANTHROPIC_MODEL.`;
  if (status === 429) return "Claude API rate limit reached. Try again in a minute.";
  if (status === 529) return "The Claude API is overloaded right now. Try again shortly.";
  return `Claude API error ${status}: ${detail}`;
}

async function post(body: MessagesRequest): Promise<Response> {
  const key = apiKey();
  let lastErr: ClaudeError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    const text = await res.text();
    lastErr = new ClaudeError(res.status, explain(res.status, text));
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr!;
}

export async function createMessage(body: MessagesRequest): Promise<MessagesResponse> {
  const res = await post({ ...body, stream: false });
  return (await res.json()) as MessagesResponse;
}

/** Streams only the text deltas of a response, as UTF-8 bytes. */
export async function streamText(body: MessagesRequest): Promise<ReadableStream<Uint8Array>> {
  const res = await post({ ...body, stream: true });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // Server-sent events are separated by a blank line.
        let sep: number;
        let emitted = false;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let payload: {
            type?: string;
            delta?: { type?: string; text?: string };
            error?: { message?: string };
          };
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta" && payload.delta.text) {
            controller.enqueue(encoder.encode(payload.delta.text));
            emitted = true;
          } else if (payload.type === "error") {
            controller.enqueue(encoder.encode(`\n\n[Error from Claude: ${payload.error?.message ?? "unknown"}]`));
            controller.close();
            return;
          }
        }
        if (emitted) return;
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
