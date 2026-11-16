/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Think-tag reasoning extraction.
 *
 * Some models wrap their chain-of-thought in text-level tags — `<thinking>`,
 * DeepSeek's `<think>`, the SillyTavern preset tokens below — instead of (or in
 * addition to) the API-native reasoning delta fields the gateway handles
 * separately (gateway-stream.ts). The splitter classifies raw content-delta
 * text into message content and reasoning as it arrives, so every consumer of
 * `chatCompletion` (chat replies, regen swipes, summaries) sees normalized,
 * tag-free content.
 *
 * Matching rules:
 * - Tags are case-insensitive; any open tag opens a block and any close tag
 *   closes it — models occasionally mix styles (open with `<think>\n`, close
 *   with a bare `</think>`), so tag identity is not enforced across a block.
 * - At the same start position the longest tag wins, so the preset variants
 *   carrying surrounding newlines take precedence over the bare tag.
 * - Each block's text is trimmed; blocks are joined with "\n\n"
 *   (see reasoningBlocks()).
 * - An unterminated block at end-of-stream swallows everything after its
 *   opening tag as reasoning (finalize()).
 * - Content is left-trimmed only when a block led the message — the usual
 *   `think ... ` shape otherwise leaves the reply starting with the
 *   close tag's whitespace padding.
 */

// Open tags, lowercase (matched case-insensitively). The special-token tags
// are copied verbatim from the `prefix` values of SillyTavern's default
// reasoning presets (default/content/presets/reasoning/*.json) so suvoj
// splits exactly what those presets inject; reasoning.test.ts pins every
// tag by char code so the bytes cannot drift silently. Keep these strings
// byte-exact when editing — agent transport has a history of mangling the
// plain think-tag form.
export const REASONING_OPEN_TAGS = [
  "<think>", // ASCII think tag; also the "Think XML" preset prefix (verbatim)
  "<thinking>", // ASCII
  "<reasoning>", // ASCII
  "<think>\n", // "DeepSeek" preset prefix (verbatim — includes the newline)
  "<|channel>thought\n", // "Gemma 4" preset prefix (verbatim)
  "<|start|>assistant<|channel|>analysis<|message|>", // "OpenAI Harmony" preset prefix (verbatim)
] as const;

// Close tags paired with the open tags above (same order). Any close tag may
// close any open block — see the matching rules in the header.
export const REASONING_CLOSE_TAGS = [
  "</think>", // ASCII think close tag; also the "Think XML" preset suffix (verbatim)
  "</thinking>", // ASCII
  "</reasoning>", // ASCII
  "\n</think>", // "DeepSeek" preset suffix (verbatim — leading newline)
  "<channel|>", // "Gemma 4" preset suffix (verbatim)
  "<|start|>assistant<|channel|>final<|message|>", // "OpenAI Harmony" preset suffix (verbatim)
] as const;

/** A slice of stream text, classified: visible message vs. model thinking. */
export interface ReasoningPortion {
  /** The part that is final message content ("" when the whole slice was reasoning or tag). */
  content: string;
  /** The part that is reasoning text ("" when none). */
  reasoning: string;
}

export interface ReasoningSplitter {
  /** Classifies one content delta. Either field may be "" — e.g. when the
   *  delta was pure tag, or its tail is held back as a potential partial tag
   *  that may complete in the next delta. */
  push(delta: string): ReasoningPortion;
  /** Flushes at end-of-stream: a buffered partial tag turns out to be plain
   *  text, and an open block swallows the remainder as reasoning. */
  finalize(): ReasoningPortion;
  /** Every reasoning block so far (an open one included), each trimmed;
   *  blocks that trimmed to nothing are dropped. */
  reasoningBlocks(): string[];
}

/** Longest tag on either side — bounds the partial-tag holdback. */
const MAX_TAG_LENGTH = Math.max(
  ...[...REASONING_OPEN_TAGS, ...REASONING_CLOSE_TAGS].map((tag) => tag.length),
);

// Case-insensitive matching compares per character instead of lowercasing the
// buffer: a character whose lowercase form has a different length (e.g. "İ")
// would shift buffer indexes and corrupt extraction — here it simply never
// matches a tag character.
function matchesAt(buf: string, pos: number, tag: string): boolean {
  if (pos + tag.length > buf.length) return false;
  for (let k = 0; k < tag.length; k += 1) {
    const ch = buf.slice(pos + k, pos + k + 1);
    const want = tag.slice(k, k + 1);
    if (ch !== want && ch.toLowerCase() !== want) return false;
  }
  return true;
}

/**
 * Longest suffix of `buf` that could still grow into one of `tags` — 0 when
 * nothing needs holding back. The suffix is always a proper prefix: a
 * complete tag would have been consumed by the scan before this runs, and a
 * proper prefix is shorter than the longest tag, hence the cap.
 */
function partialTagSuffix(buf: string, tags: readonly string[]): number {
  const max = Math.min(MAX_TAG_LENGTH - 1, buf.length);
  for (let k = max; k > 0; k -= 1) {
    if (tags.some((tag) => tag.startsWith(buf.slice(buf.length - k)))) return k;
  }
  return 0;
}

/** Splits streaming text into content and reasoning, buffering partial tags
 *  that straddle chunk boundaries. Pure state machine — no I/O. */
export function createReasoningSplitter(): ReasoningSplitter {
  // Unprocessed tail of the previous push: a potential tag start whose
  // completion may straddle the next chunk boundary.
  let pending = "";
  let inReasoning = false;
  let currentBlock = "";
  const blocks: string[] = [];
  // "A block led the message": the first open tag arrived before any content
  // had been emitted — only then is content left-trimmed.
  let blockLed = false;
  let sawContent = false;
  let sawNonWsContent = false;

  const emitContent = (text: string, out: ReasoningPortion): void => {
    if (blockLed && !sawNonWsContent) {
      // Strip the whitespace padding the close tag leaves before the reply;
      // once real text landed, later whitespace is the message's own.
      text = text.replace(/^\s+/, "");
      if (text === "") return;
    }
    sawNonWsContent = sawNonWsContent || text.trim() !== "";
    sawContent = true;
    out.content += text;
  };

  const emit = (text: string, out: ReasoningPortion): void => {
    if (text === "") return;
    if (inReasoning) {
      currentBlock += text;
      out.reasoning += text;
    } else {
      emitContent(text, out);
    }
  };

  const process = (buf: string): ReasoningPortion => {
    const out: ReasoningPortion = { content: "", reasoning: "" };
    let i = 0;
    while (i < buf.length) {
      const tags = inReasoning ? REASONING_CLOSE_TAGS : REASONING_OPEN_TAGS;
      // Earliest full match wins; at the same start position, the longest
      // tag wins (prefer `<think>\n` over `<think>`, `\n</think>` over `</think>`).
      let bestPos = -1;
      let bestLen = 0;
      for (let p = i; p < buf.length; p += 1) {
        for (const tag of tags) {
          if (tag.length > bestLen && matchesAt(buf, p, tag)) {
            bestPos = p;
            bestLen = tag.length;
          }
        }
        if (bestPos !== -1) break;
      }
      if (bestPos === -1) {
        // No complete tag: emit everything except a trailing partial-tag
        // candidate, which stays buffered until the next delta resolves it.
        const hold = partialTagSuffix(buf.slice(i), tags);
        if (hold > 0) {
          pending = buf.slice(buf.length - hold);
          emit(buf.slice(i, buf.length - hold), out);
        } else {
          emit(buf.slice(i), out);
        }
        break;
      }
      emit(buf.slice(i, bestPos), out);
      if (inReasoning) {
        blocks.push(currentBlock);
        currentBlock = "";
        inReasoning = false;
      } else {
        inReasoning = true;
        if (!sawContent) blockLed = true;
      }
      i = bestPos + bestLen;
    }
    return out;
  };

  return {
    push(delta: string): ReasoningPortion {
      const buf = pending + delta;
      pending = "";
      return process(buf);
    },

    finalize(): ReasoningPortion {
      // The held-back tail never resolved into a tag: plain text after all.
      const out: ReasoningPortion = { content: "", reasoning: "" };
      emit(pending, out);
      pending = "";
      if (inReasoning) {
        blocks.push(currentBlock);
        currentBlock = "";
        inReasoning = false;
      }
      return out;
    },

    reasoningBlocks(): string[] {
      return [...blocks, currentBlock].map((block) => block.trim()).filter((block) => block !== "");
    },
  };
}

/** One-shot convenience over the splitter: splits complete text into its
 *  trimmed reasoning (blocks joined with "\n\n") and normalized content. */
export function splitReasoning(text: string): ReasoningPortion {
  const splitter = createReasoningSplitter();
  const head = splitter.push(text);
  const tail = splitter.finalize();
  return {
    content: head.content + tail.content,
    reasoning: splitter.reasoningBlocks().join("\n\n"),
  };
}
