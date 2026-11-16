/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Token counting for the prompt pipeline.
 *
 * Uses the o200k_base encoding (GPT-4o family) from `gpt-tokenizer`, loaded
 * lazily on first use so importing the engine stays cheap. If the dependency
 * cannot be loaded for any reason, a chars/3.6 heuristic is used as a
 * fallback so the pipeline keeps working (with rougher budgets).
 */

interface TokenizerModule {
  encode: (text: string) => number[];
  decode: (tokens: number[]) => string;
}

/** `undefined` = not tried yet, `null` = tried and failed (use heuristic). */
let tokenizer: TokenizerModule | null | undefined;

/**
 * Memo of BPE counts keyed by exact text. Prompt assembly, trim/summaries and
 * lorebook all tokenize the same contents several times per generation; caching
 * avoids re-running the expensive `encode` on every call. Bounded by a simple
 * clear-at-cap (same policy as `regexKeyCache` in lorebook.ts) to stay bounded.
 */
const tokenCountCache = new Map<string, number>();
const TOKEN_CACHE_MAX_ENTRIES = 10_000;

function loadTokenizer(): TokenizerModule | null {
  if (tokenizer !== undefined) {
    return tokenizer;
  }
  try {
    // Lazy optional dependency, resolved from node_modules at first use.
    // (Biome has no CommonJS rule triggered here; Bun supports require.)
    const mod = require("gpt-tokenizer/encoding/o200k_base") as TokenizerModule;
    tokenizer = typeof mod?.encode === "function" ? mod : null;
  } catch {
    tokenizer = null;
  }
  return tokenizer;
}

/** Test hook: forces the heuristic fallback (`null`) or a fresh lazy load. */
export function resetTokenizer(): void {
  tokenizer = undefined;
  // Cached BPE counts must not survive into a heuristic-mode run.
  tokenCountCache.clear();
}

/** Forces the heuristic fallback for the rest of the process (tests only). */
export function disableTokenizer(): void {
  tokenizer = null;
  // Drop real-tokenizer counts so they can't leak into heuristic-mode tests.
  tokenCountCache.clear();
}

/** Rough token estimate used when the real tokenizer is unavailable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Number of tokens in `text` (0 for empty input). */
export function countTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const tok = loadTokenizer();
  if (!tok) {
    return estimateTokens(text);
  }
  const cached = tokenCountCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const count = tok.encode(text).length;
  if (tokenCountCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    tokenCountCache.clear();
  }
  tokenCountCache.set(text, count);
  return count;
}

/** Per-message overhead of the chat format (mirrors OpenAI's ~4 tokens). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Total tokens of a message list (contents + per-message overhead). */
export function countMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  let total = 0;
  for (const message of messages) {
    total += countTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Greedy trim from the start: returns the longest prefix of `text` that fits
 * in `budget` tokens. Prefers token-exact trimming via the tokenizer; falls
 * back to a character approximation when it is unavailable.
 */
export function trimToBudget(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  const tok = loadTokenizer();
  if (!tok) {
    return text.slice(0, Math.floor(budget * 3.6));
  }
  const tokens = tok.encode(text);
  if (tokens.length <= budget) {
    return text;
  }
  return tok.decode(tokens.slice(0, budget));
}
