/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GenerateEvent } from "./api-generate";

/** Extracts the server's JSON error body (`{ error }`) when the request fails. */
async function streamHttpError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error !== "") {
      return new Error(`${parsed.error} (HTTP ${res.status})`);
    }
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return new Error(`generation request failed (HTTP ${res.status})`);
}

/**
 * Runs one streaming generation against POST /api/chats/:id/generate.
 *
 * The server emits each event as a single `data: <json>` line, blocks
 * separated by blank lines (server sse.ts `encodeSseEvent`). Events are
 * handed to `opts.onEvent` in arrival order; malformed payloads are
 * skipped, never fatal. Resolves when the stream ends and rejects on HTTP
 * errors or transport failures. `opts.signal` aborts both the request and
 * the stream reads.
 */
export async function streamGenerate(
  chatId: string,
  body: unknown,
  opts: { onEvent: (ev: GenerateEvent) => void; signal?: AbortSignal },
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw await streamHttpError(res);
  }
  if (res.body === null) {
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleBlock = (block: string): void => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      try {
        opts.onEvent(JSON.parse(line.slice("data: ".length)) as GenerateEvent);
      } catch (err) {
        // Malformed payload — skip the event, keep the stream alive, but leave a
        // trace in the console.
        console.warn("[sse] skipped malformed event", {
          data: line.slice("data: ".length, "data: ".length + 200),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      handleBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    handleBlock(buffer);
  }
}
