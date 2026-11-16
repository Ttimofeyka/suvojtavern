/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Message, Profile, Summary } from "@suvoj/core";
import { emitSummariesCreated, engine } from "@suvoj/core";
import type { z } from "zod";
import type { Endpoint } from "../gateway";
import type { Gateway, Repos } from "../routes-deps";
import { makeSummarizer } from "./generate-helpers";

/** Summaries memory-strategy config (the engine strategy's own schema). */
export type SummariesConfig = z.infer<typeof engine.summariesConfigSchema>;

/**
 * Resolves the summaries config from the preset that generation would use
 * — the same chain as engine/chat.ts `loadPreset`, which this calls:
 * explicit id → that preset, else the `default_preset_id` setting (when it
 * names a live preset), else the first stored preset, else the built-in
 * default. The global `memory_strategy`/`memory_config` settings then
 * apply exactly like at generation time (engine/memory/resolve.ts).
 * When the resolved strategy is `summaries`, its config is validated
 * through the strategy's schema (defaults fill the gaps); any other
 * strategy gets the schema defaults. Throws on an unknown preset id.
 */
export function summariesConfigFor(repos: Repos, presetId?: string): SummariesConfig {
  const preset = engine.loadPreset(repos, presetId);
  const memory = engine.resolveMemorySettings(repos, preset);
  return engine.summariesConfigSchema.parse(memory.strategy === "summaries" ? memory.config : {});
}

/**
 * Uncovered message ranges for level-0 summarization, mirroring the coverage
 * rule of the engine's summaries strategy (engine/memory/summaries.ts):
 * - a position is covered iff some summary row (any level) spans it
 *   (`seq_from <= seq <= seq_to`);
 * - active-history messages at covered positions are never re-summarized
 *   — and a mid-range message deletion, which drops the covering row,
 *   re-opens its surviving positions here once they age out of the
 *   verbatim window (a repaired chunk re-covers the gap);
 * - the newest `summarize_after` active-history positions are never
 *   summarized;
 * - the remaining uncovered messages chunk into consecutive `chunk_size`
 *   groups, oldest first.
 *
 * `fullOnly` drops the trailing partial chunk: the post-response step
 * summarizes only once a whole chunk has aged out of the window (no call
 * after every turn), while the manual "Summarize now" route also covers a
 * pending partial chunk.
 */
export function uncoveredChunks(
  history: ReadonlyArray<Message>,
  rows: ReadonlyArray<Summary>,
  config: SummariesConfig,
  opts?: { fullOnly?: boolean },
): Message[][] {
  const candidates = history.filter(
    (message, index) =>
      !engine.coveredByAny(rows, message.seq) && index < history.length - config.summarize_after,
  );
  const chunks: Message[][] = [];
  for (let i = 0; i < candidates.length; i += config.chunk_size) {
    chunks.push(candidates.slice(i, i + config.chunk_size));
  }
  if (opts?.fullOnly) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length < config.chunk_size) {
      chunks.pop();
    }
  }
  return chunks;
}

/**
 * Compiles the config's `strip_patterns` (one regex source per line) into
 * global regexes. Lines that are empty (or whitespace-only) or fail to
 * compile are skipped — an invalid pattern never fails the run.
 */
export function compileStripPatterns(source: string): RegExp[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => {
      try {
        return [new RegExp(line, "g")];
      } catch {
        return [];
      }
    });
}

/**
 * Range text format of the engine strategy: `name (or role): content`
 * lines, with the strip patterns removed from every content first. Only
 * the summarizer input is stripped — stored messages are untouched.
 */
function rangeText(messages: ReadonlyArray<Message>, patterns: ReadonlyArray<RegExp>): string {
  return messages
    .map((message) => {
      const content = patterns.reduce(
        (text, pattern) => text.replace(pattern, ""),
        message.content,
      );
      return `${message.name ?? message.role}: ${content}`;
    })
    .join("\n");
}

/** Replaces every literal `placeholder` occurrence in `text` (split/join, never a regex replace). */
function replaceAll(text: string, placeholder: string, value: string): string {
  return text.split(placeholder).join(value);
}

/**
 * The chat's active persona name for the `{{player_name}}` placeholder
 * (chat → persona row); "User" when the chat has no persona.
 */
function personaNameOf(repos: Repos, chatId: string): string {
  const chat = repos.chats.get(chatId);
  const persona = chat?.persona_id ? repos.personas.get(chat.persona_id) : null;
  return persona?.name ?? "User";
}

/**
 * Renders the config's user prompt: every `{{player_name}}`,
 * `{{context_str}}`, and `{{story_txt}}` occurrence replaced with its
 * value.
 */
function renderUserPrompt(
  config: SummariesConfig,
  playerName: string,
  contextStr: string,
  storyTxt: string,
): string {
  return replaceAll(
    replaceAll(
      replaceAll(config.user_prompt, "{{player_name}}", playerName),
      "{{context_str}}",
      contextStr,
    ),
    "{{story_txt}}",
    storyTxt,
  );
}

/** A layer's snippet texts, chronological by seq_from, joined with blank lines. */
function snippetsText(rows: ReadonlyArray<Summary>): string {
  return [...rows]
    .sort((a, b) => a.seq_from - b.seq_from)
    .map((row) => row.summary)
    .join("\n\n");
}

/**
 * A layer's uncovered snippets: rows of that level not covered by a higher
 * level (the engine's coveredBy logic) and not holding the no-content
 * marker (a marker covers its range but carries nothing worth promoting),
 * oldest first.
 */
function uncoveredSnippets(rows: ReadonlyArray<Summary>, level: number): Summary[] {
  return rows
    .filter(
      (row) =>
        row.level === level && !engine.coveredBy(row, rows) && !engine.isNoContent(row.summary),
    )
    .sort((a, b) => a.seq_from - b.seq_from);
}

/**
 * True when a `summarizeUncovered` run would create anything: at least one
 * uncovered chunk (with the caller's `fullOnly` rule), or a layer already
 * over its promotion cap — the overflow a capped run left behind. The
 * generate route announces its `summarizing` status only when this is
 * true: a fresh chat has every message inside the verbatim window, and
 * announcing the stage there would flash the "Summarizing…" pill while
 * nothing runs.
 */
export function hasSummarizationWork(
  repos: Repos,
  chatId: string,
  config: SummariesConfig,
  opts?: { fullOnly?: boolean },
): boolean {
  const rows = repos.summaries.list(chatId);
  const chunks = uncoveredChunks(repos.messages.listActive(chatId), rows, config, {
    fullOnly: opts?.fullOnly,
  });
  if (chunks.length > 0) {
    return true;
  }
  // Mirrors the promotion loop's condition (promoteLayers): any layer with
  // more uncovered snippets than its cap will at least seed its target.
  for (let level = 0; level + 1 < config.max_layer_depth; level++) {
    if (uncoveredSnippets(rows, level).length > config.max_snippets_per_layer) {
      return true;
    }
  }
  return false;
}

/**
 * Constant default of the `maxChunks` option: at most this many chunks
 * summarized per `summarizeUncovered` call. A long chat freshly switched
 * to the summaries strategy catches up over successive calls (one batch
 * per AI response / "Summarize now" click) instead of one unbounded burst
 * of gateway calls before `done`.
 */
const DEFAULT_MAX_CHUNKS = 8;

/**
 * Constant cap of LLM promotions per `summarizeUncovered` call, mirroring
 * {@link DEFAULT_MAX_CHUNKS}: overflow is picked up by the next run. Seed
 * promotions make no gateway call and do not count.
 */
const MAX_PROMOTIONS_PER_CALL = 8;

/**
 * Promotion pass, run after level-0 creation: a layer holding more than
 * `max_snippets_per_layer` uncovered snippets sheds its oldest
 * `snippets_per_promotion` snippets into the next layer. A brand-new
 * layer is SEEDED from its oldest single snippet verbatim (no LLM call);
 * afterwards a promotion merges the batch through the gateway with the
 * config's prompts — `{{context_str}}` is the target layer's existing
 * snippets, `{{story_txt}}` the batch's texts. Levels at or beyond
 * `max_layer_depth` are never created; marker rows never promote. At most
 * {@link MAX_PROMOTIONS_PER_CALL} LLM promotions run per call. Returns
 * the created rows.
 */
async function promoteLayers(
  repos: Repos,
  summarize: (system: string, user: string) => Promise<string>,
  chatId: string,
  config: SummariesConfig,
  playerName: string,
): Promise<Summary[]> {
  const created: Summary[] = [];
  // Fresh snapshot: the pass sees the level-0 rows created above too.
  const rows = repos.summaries.list(chatId);
  let llmPromotions = 0;
  for (let level = 0; level + 1 < config.max_layer_depth; level++) {
    for (;;) {
      // Recomputed every iteration: each promotion covers its batch, and
      // a promotion can cascade the next layer over its own cap (handled
      // when the outer loop reaches it).
      const uncovered = uncoveredSnippets(rows, level);
      if (uncovered.length <= config.max_snippets_per_layer) {
        break;
      }
      const batch = uncovered.slice(0, config.snippets_per_promotion);
      const oldest = batch[0];
      const newest = batch[batch.length - 1];
      if (!oldest || !newest) {
        break;
      }
      // The target layer's existing snippets are the promotion's prior
      // context — markers are skipped (a marker row carries nothing
      // forward), so a marker-only target layer counts as empty and the
      // seed path (no LLM call) starts the layer's real content.
      const target = rows.filter(
        (row) => row.level === level + 1 && !engine.isNoContent(row.summary),
      );
      let text: string;
      let seqTo = newest.seq_to;
      if (target.length === 0) {
        // Seed promotion: the oldest snippet's text becomes the first
        // snippet of the brand-new layer, covering just its range — no
        // LLM call.
        text = oldest.summary;
        seqTo = oldest.seq_to;
      } else {
        if (llmPromotions >= MAX_PROMOTIONS_PER_CALL) {
          // Over the per-call LLM cap: stop here, the next run picks up.
          return created;
        }
        const user = renderUserPrompt(
          config,
          playerName,
          snippetsText(target),
          batch.map((row) => row.summary).join("\n\n"),
        );
        text = await summarize(config.system_prompt, user);
        llmPromotions += 1;
      }
      const row = repos.summaries.create(chatId, {
        level: level + 1,
        seq_from: oldest.seq_from,
        seq_to: seqTo,
        summary: text,
        tokens: engine.countTokens(text),
      });
      rows.push(row);
      created.push(row);
    }
  }
  return created;
}

/**
 * Summarizes uncovered ranges of the chat through the gateway and stores
 * level-0 summary rows, then promotes overflowing layers. Chunks run
 * oldest-first; each prompt is the config's `system_prompt` plus its
 * rendered `user_prompt` (persona name, the chat's level-0 snippets so
 * far as `{{context_str}}` — growing as this run creates chunks — and the
 * strip-pattern-cleaned chunk text as `{{story_txt}}`). A response that
 * is exactly the no-content marker is STILL stored verbatim: it covers
 * its chunk (never re-summarized) while injection and promotion skip it
 * later. `opts.fullOnly` drops a trailing partial chunk (post-response
 * mode); `opts.profile` routes the summarizer
 * model through a connection profile, and `opts.endpoint` (resolved by the
 * caller from that profile) routes the call to its upstream. At most
 * `opts.maxChunks` chunks
 * (default 8) and 8 LLM promotions run per call — the remainder is picked
 * up by later calls. Returns the created rows (level-0 + promotions) —
 * empty when nothing is uncovered — and emits one summary-lifecycle
 * creation event for them on the default bus.
 */
export async function summarizeUncovered(
  repos: Repos,
  gateway: Gateway,
  chatId: string,
  config: SummariesConfig,
  opts?: {
    /** Drop the trailing partial chunk (post-response mode). */
    fullOnly?: boolean;
    /** Connection profile for the summarizer model; `null` = none. */
    profile?: Profile | null;
    /** Upstream of `profile` (resolved by the caller); omitted = gateway default. */
    endpoint?: Endpoint;
    signal?: AbortSignal;
    /**
     * Max chunks summarized per call; defaults to {@link
     * DEFAULT_MAX_CHUNKS} (8) — a long chat freshly switched to summaries
     * catches up over successive turns, not one unbounded burst.
     */
    maxChunks?: number;
  },
): Promise<Summary[]> {
  const created: Summary[] = [];
  try {
    const summarize = makeSummarizer(gateway, {
      profile: opts?.profile,
      signal: opts?.signal,
      endpoint: opts?.endpoint,
    });
    const playerName = personaNameOf(repos, chatId);
    const strip = compileStripPatterns(config.strip_patterns);
    // {{context_str}}: the chat's level-0 snippets so far, chronological
    // by seq_from; every chunk created below appends to it. Marker rows
    // are skipped — a no-content chunk covered its range but carries
    // nothing forward, and its marker text must never reach a prompt.
    const contextParts = repos.summaries
      .list(chatId)
      .filter((row) => row.level === 0 && !engine.isNoContent(row.summary))
      .sort((a, b) => a.seq_from - b.seq_from)
      .map((row) => row.summary);

    const chunks = uncoveredChunks(
      repos.messages.listActive(chatId),
      repos.summaries.list(chatId),
      config,
      { fullOnly: opts?.fullOnly },
    ).slice(0, opts?.maxChunks ?? DEFAULT_MAX_CHUNKS);
    for (const chunk of chunks) {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      if (!first || !last) {
        continue;
      }
      const user = renderUserPrompt(
        config,
        playerName,
        contextParts.join("\n\n"),
        rangeText(chunk, strip),
      );
      const summary = await summarize(config.system_prompt, user);
      const row = repos.summaries.create(chatId, {
        level: 0,
        seq_from: first.seq,
        seq_to: last.seq,
        summary,
        tokens: engine.countTokens(summary),
      });
      created.push(row);
      // Same rule in-run: a chunk answered with the marker is stored
      // (covered) but never fed back into a later chunk's prior context.
      if (!engine.isNoContent(summary)) {
        contextParts.push(summary);
      }
    }

    created.push(...(await promoteLayers(repos, summarize, chatId, config, playerName)));
  } finally {
    // Emits whatever was stored even when a gateway call fails midway —
    // no-op on empty (the event only ever widens coverage).
    emitSummariesCreated(chatId, created);
  }
  return created;
}
