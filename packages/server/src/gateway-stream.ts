/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  authHeadersFor,
  causeChain,
  type Endpoint,
  ERROR_EXCERPT_CHARS,
  type GatewayDeps,
  GatewayError,
} from "./gateway-shared";
import { createReasoningSplitter } from "./reasoning";
import { readSseStream } from "./sse";

export interface ChatCompletionOpts {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** Fires for each reasoning portion — API-native reasoning deltas and
   *  think-tag text alike — in arrival order, interleaved with onDelta. */
  onReasoning?: (text: string) => void;
  model?: string;
  /** Upstream to call; absent means no connection profile is configured. */
  endpoint?: Endpoint;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      // API-native reasoning deltas — upstreams disagree on the field name,
      // so all three are checked; per chunk, the first non-empty string wins
      // (see reasoningOf in onLine).
      reasoning?: unknown;
      reasoning_content?: unknown;
      thinking?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: unknown;
  // Some upstreams report failures as an {"error": ...} chunk mid-stream.
  error?: unknown;
}

const MAX_ATTEMPTS = 4;
/** Effort sent when a profile has no explicit `reasoning_effort` choice. */
const DEFAULT_REASONING_EFFORT = "low";
// Keys stripped from the sampling map before it reaches the upstream API:
// request plumbing, plus samplers removed from the schema — legacy stored
// profiles may still carry the removed values.
const DROP_SAMPLING_KEYS = new Set([
  "context_size",
  "stream",
  "model",
  "messages",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
]);

export function createStreamGateway(deps: GatewayDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function chatCompletion(
    messages: { role: string; content: string }[],
    sampling: Record<string, unknown>,
    opts?: ChatCompletionOpts,
  ): Promise<{
    content: string;
    /** Final reasoning (tag text + native deltas, trimmed) — present only when thinking was captured. */
    reasoning?: string;
    /** First reasoning arrival → first content after it (or completion). Present only with reasoning. */
    reasoningDurationMs?: number;
    finishReason?: string;
    usage?: Record<string, unknown>;
  }> {
    const signal = opts?.signal;
    // The endpoint and model are both supplied by the caller (the route
    // resolves them from the connection profile) — there is no global
    // fallback. A missing endpoint means no profile is configured; a missing
    // model means the profile carries none. Both fail fast with a clean 400
    // rather than a doomed upstream call.
    const endpoint = opts?.endpoint;
    if (endpoint === undefined) {
      throw new GatewayError("No connection profile configured", 400);
    }
    const model = opts?.model;
    if (!model) throw new GatewayError("No model configured", 400);
    const filtered = Object.fromEntries(
      Object.entries(sampling).filter(
        ([key, value]) => value !== undefined && !DROP_SAMPLING_KEYS.has(key),
      ),
    );
    // Thinking is on by default: a profile that never chose an effort runs at
    // "low". "off" is suvoj's own sentinel and sends no reasoning parameter at
    // all, which keeps non-reasoning models and strict upstreams working.
    const reasoningEffort = filtered.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    if (reasoningEffort === "off") {
      delete filtered.reasoning_effort;
    } else {
      filtered.reasoning_effort = reasoningEffort;
    }
    const url = `${endpoint.baseUrl}/v1/chat/completions`;
    // Log-safe identity of the upstream — auth travels in headers, so the
    // URL (and its host) carries no secrets.
    const host = new URL(url).host;
    // Resolved before the retry loop, like the checks above, so a bad endpoint
    // configuration fails fast instead of being caught and retried as if it
    // were a transient fetch failure. Real 401 responses from the API still
    // take the normal error path.
    const authHeaders = authHeadersFor(endpoint);
    let content = "";
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let gotDelta = false;
    // Reasoning plumbing. Native reasoning deltas (dedicated chunk fields)
    // and think-tag text inside content deltas both normalize into the same
    // onReasoning stream; the splitter strips the tags so every consumer of
    // `content` (replies, swipes, summaries) sees clean text. Like `content`,
    // these live across the whole call: the retry paths below only run
    // before any chunk was read (both gate on !gotDelta and precede
    // readSseStream), so there is nothing to reset mid-call.
    let nativeReasoning = "";
    let reasoningStartMs: number | undefined;
    let reasoningEndMs: number | undefined;
    const splitter = createReasoningSplitter();

    // Reasoning precedes content within one chunk: the usual mixed chunk is
    // a close tag followed by the start of the visible reply, so the start
    // timer (and onReasoning) must fire before the content that ends it.
    const fireReasoning = (text: string): void => {
      if (reasoningStartMs === undefined) reasoningStartMs = Date.now();
      opts?.onReasoning?.(text);
    };
    const fireContent = (text: string): void => {
      // First visible content after thinking started = the thinking's end.
      if (reasoningStartMs !== undefined && reasoningEndMs === undefined) {
        reasoningEndMs = Date.now();
      }
      content += text;
      gotDelta = true;
      opts?.onDelta?.(text);
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });

    const retryAfterMs = (res: Response): number => {
      const raw = res.headers.get("Retry-After");
      if (raw === null) return 0;
      const seconds = Number(raw);
      if (Number.isInteger(seconds)) return seconds * 1000;
      const date = Date.parse(raw);
      return Number.isNaN(date) ? 0 : date - Date.now();
    };

    const onLine = (line: string): void => {
      if (!line.startsWith("data")) return;
      const data = line.slice(4).replace(/^:/, "").trim();
      if (data === "[DONE]") return;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        return;
      }
      // Some upstreams fail mid-stream: HTTP 200, deltas (maybe), then an
      // {"error": ...} chunk. Swallowed, it reads as a clean — likely
      // empty — generation, so it must throw instead. The raw error value
      // (re-stringified JSON.parse output, so cycle-free) rides in the
      // detail — clients and logs see more than just the message.
      const streamError = chunk.error;
      if (streamError !== undefined && streamError !== null) {
        let message = "Upstream stream error";
        if (typeof streamError === "string") {
          message = streamError;
        } else if (typeof (streamError as { message?: unknown }).message === "string") {
          message = (streamError as { message: string }).message;
        }
        const raw = JSON.stringify(streamError);
        throw new GatewayError(
          message,
          502,
          `error chunk in stream from ${host}: ${raw.slice(0, ERROR_EXCERPT_CHARS)}`,
        );
      }
      const choice = chunk.choices?.[0];
      const deltaObj = choice?.delta;
      // Native reasoning extraction: check all three fields, first
      // non-empty string wins. Empty strings mean "no reasoning this
      // chunk" (some upstreams send the field explicitly empty).
      let reasoningDelta: string | null = null;
      for (const field of [deltaObj?.reasoning, deltaObj?.reasoning_content, deltaObj?.thinking]) {
        if (typeof field === "string" && field !== "") {
          reasoningDelta = field;
          break;
        }
      }
      if (reasoningDelta !== null) {
        nativeReasoning += reasoningDelta;
        fireReasoning(reasoningDelta);
      }
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta !== "") {
        // Content deltas pass through the splitter: think tags become
        // reasoning, the remainder stays content. In practice the two
        // channels are mutually exclusive per chunk, but both are handled
        // independently when upstreams fill them together.
        const portions = splitter.push(delta);
        if (portions.reasoning !== "") fireReasoning(portions.reasoning);
        if (portions.content !== "") fireContent(portions.content);
      }
      const reason = choice?.finish_reason;
      if (typeof reason === "string") finishReason = reason;
      if (typeof chunk.usage === "object" && chunk.usage !== null) {
        usage = chunk.usage as Record<string, unknown>;
      }
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, stream: true, ...filtered }),
          signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt + 1 >= MAX_ATTEMPTS || gotDelta) {
          console.error("[gateway] chat completion failed", {
            host,
            model,
            message,
            cause: causeChain(err),
          });
          throw err;
        }
        console.warn("[gateway] attempt failed", {
          host,
          model,
          attempt: attempt + 1,
          max: MAX_ATTEMPTS,
          message,
        });
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt + 1 < MAX_ATTEMPTS && !gotDelta) {
        console.warn("[gateway] attempt failed", {
          host,
          model,
          status: res.status,
          attempt: attempt + 1,
          max: MAX_ATTEMPTS,
          message: `upstream ${res.status}`,
        });
        await sleep(Math.max(500 * 2 ** attempt, retryAfterMs(res)));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        let message = text.slice(0, ERROR_EXCERPT_CHARS);
        try {
          const json = JSON.parse(text) as { error?: { message?: unknown } };
          if (typeof json.error?.message === "string") message = json.error.message;
        } catch {
          // keep the text excerpt
        }
        console.error("[gateway] chat completion failed", {
          host,
          model,
          status: res.status,
          message,
        });
        throw new GatewayError(
          message,
          res.status,
          `upstream ${res.status} from ${host}, attempt ${attempt + 1}/${MAX_ATTEMPTS}`,
        );
      }
      if (res.body === null) throw new GatewayError("Empty response body", 502);
      try {
        await readSseStream(res.body, onLine);
      } catch (err) {
        // A GatewayError here is the error-chunk throw in onLine — keep its
        // message and detail rather than burying them under "Stream failed".
        if (!gotDelta || err instanceof GatewayError) throw err;
        const failure = new GatewayError(
          `Stream failed: ${causeChain(err) || "unknown error"}`,
          502,
        );
        failure.cause = err;
        throw failure;
      }
      // End of stream: flush a trailing partial tag as plain text and close
      // an unterminated block — everything after its opening tag was
      // reasoning, and the reply is whatever preceded it.
      const tail = splitter.finalize();
      if (tail.reasoning !== "") fireReasoning(tail.reasoning);
      if (tail.content !== "") fireContent(tail.content);
      // Tag blocks are trimmed per block and joined with "\n\n"; the native
      // accumulation is its own leading part.
      const reasoning = [nativeReasoning.trim(), ...splitter.reasoningBlocks()]
        .filter((part) => part !== "")
        .join("\n\n");
      if (reasoning !== "" && reasoningStartMs !== undefined) {
        return {
          content,
          reasoning,
          // Reasoning that never yielded content is timed to completion.
          reasoningDurationMs: (reasoningEndMs ?? reasoningStartMs) - reasoningStartMs,
          finishReason,
          usage,
        };
      }
      return { content, finishReason, usage };
    }
  }

  return { chatCompletion };
}
