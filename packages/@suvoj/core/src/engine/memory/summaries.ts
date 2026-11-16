/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import type { SummariesRepository } from "../../repositories/summaries";
import type { Message } from "../../schema/messages";
import type { Summary } from "../../schema/summaries";
import { countTokens } from "../tokens";
import type { MemoryResult, MemoryStrategy } from "./index";

/**
 * Built-in strategy #2 — `summaries` (Layered Summaries): hierarchical
 * memory. Level-0 rows are created AFTER a reply lands (the server's
 * post-response step) or on demand ("Summarize now") — never during prompt
 * assembly. Everything a stored summary covers is replaced by the
 * hierarchical summary block: ghosted turns never render verbatim again.
 * The block is injected at the prompt's TAIL — after the live window, before
 * the tracker state block — so a rewrite on a chunk boundary invalidates
 * only the blocks after it, never the cached canon prefix and conversation
 * ahead of it.
 * Each snippet renders through the `injection_template`; when level-0
 * summaries themselves grow too numerous (`max_snippets_per_layer`), the
 * server's promotion pass merges the oldest `snippets_per_promotion` of
 * them into a level-1 snippet (and so on, never beyond `max_layer_depth`).
 * This assembly-time roll-up is the budget-pressure fallback of the same
 * mechanics.
 *
 * Assembly stays deterministic: the strategy itself never creates level-0
 * summaries. It keeps every position no summary row covers live (the
 * newest `summarize_after` messages are never summarized at all), and
 * calls the injected `summarizeFn` only for roll-ups when the assembly is
 * over budget — after roll-ups are exhausted it hard-trims the oldest live
 * messages. Without a `summarizeFn` it degrades to plain trimming.
 *
 * Generated summaries persist in the `summaries` table and are reused
 * (never regenerated) on later runs; the engine itself never calls HTTP.
 */

/**
 * The exact string a compliant summarizer outputs for a passage with
 * nothing worth storing. Rows holding it still cover their range (the
 * range is never re-summarized) but inject nothing and never promote.
 */
export const NO_CONTENT_MARKER = "[NO SIGNIFICANT CONTENT]";

/** True when `text` is exactly the {@link NO_CONTENT_MARKER} (whitespace-trimmed). */
export function isNoContent(text: string): boolean {
  return text.trim() === NO_CONTENT_MARKER;
}

export const summariesConfigSchema = z.object({
  /** Messages per level-0 summary chunk. */
  chunk_size: z.number().int().min(1).default(8),
  /**
   * The newest N messages always stay verbatim; summarization of older
   * messages begins once they form a full `chunk_size` group (with the
   * defaults, the first summary lands at message 38: 1–8 summarized,
   * 9–38 verbatim).
   */
  summarize_after: z.number().int().min(1).default(30),
  /**
   * Connection profile the server routes the summarizer model through.
   * The engine ignores it; it only needs to survive parsing so
   * `memory_config` round-trips.
   */
  profile_id: z.string().optional(),
  /**
   * Max snippets per layer: when the uncovered snippet count of a layer
   * exceeds this, the oldest snippets get promoted to the next layer.
   */
  max_snippets_per_layer: z.number().int().min(1).default(15),
  /**
   * Snippets per promotion: how many older snippets merge into one
   * snippet of the next layer.
   */
  snippets_per_promotion: z.number().int().min(2).default(3),
  /**
   * Maximum layer depth: the number of summary layers. Levels
   * 0..max_layer_depth-1 are allowed — promotions and roll-ups must never
   * create a level >= max_layer_depth.
   */
  max_layer_depth: z.number().int().min(1).default(3),
  /**
   * Regex source, ONE pattern per line, stripped from message content
   * before it is handed to the summarizer (invalid regex lines are
   * ignored, never fatal). Stored messages are untouched — only the
   * summarizer input is stripped.
   */
  strip_patterns: z.string().default(""),
  /** System prompt of the summarizer model (level-0 chunks and promotions). */
  system_prompt: z
    .string()
    .default(
      "You are a precise narrative-state tracker. Condense the core plot progression, changing dynamics, character motivations, and situational context into a single, high-density line. Output only this summary line, no preamble, no commentary, no markdown.",
    ),
  /**
   * User prompt template of the summarizer model. Placeholders (all
   * occurrences, literal string replacement): `{{player_name}}`, and the
   * `{{context_str}}` → `{{story_txt}}` pair framing the passage to
   * condense.
   */
  user_prompt: z.string().default(
    `<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage_in_question>{{story_txt}}</passage_in_question>

You are a Narrative Compression Specialist. Your task is to condense the <passage_in_question> into a dense, coherent summary that seamlessly continues from <prior_context>.

CRITICAL FILTERING RULES:
1. IGNORE all <details> and <summary>blocks. Do not summarize technical data or hidden mechanics.
2. IGNORE empty passages or repetitive sensory details already present in <prior_context>.

SUMMARIZATION PRIORITIES (Preserve in this order):
1. PLOT & ACTION: Key physical events, decisions made, and their immediate consequences.
2. RELATIONSHIP SHIFTS: Any change in relationships between NPCs including love, hate, friendship and other specifics.
3. CHARACTER STATE: Significant changes in NPC mood or revealed motivations.
4. ATMOSPHERIC ANCHORS: 2-3 most distinctive sensory details (smell, sound, lighting) that define the scene's tone. Avoid generic descriptions.
5. DIALOGUE ESSENCE: Paraphrase key exchanges. Preserve direct quotes ONLY if they reveal character voice or contain critical information.

OUTPUT GUIDELINES:
- Write as a single, fluid paragraph (not bullet points).
- Target length: 50-100 words for standard passages; up to 175 words for complex scenes.
- Use specific names, locations, and time references.
- Maintain the original narrative tone (e.g., gritty, romantic, tense).
- If the passage contains no significant new information, output exactly: [NO SIGNIFICANT CONTENT]

Output only the summary text. No preamble, no markdown, no commentary.`,
  ),
  /**
   * Wraps EACH summary snippet at prompt-injection time: every literal
   * `{{summary}}` occurrence is replaced by the snippet's text; a template
   * without the placeholder falls back to template + "\n" + text.
   */
  injection_template: z.string().default("[Summary of past events: {{summary}}]"),
  /**
   * Display-only flag: the web UI marks messages covered by summaries;
   * the engine ignores it.
   */
  mark_summarized: z.boolean().default(false),
});
export type SummariesConfig = z.infer<typeof summariesConfigSchema>;

const MESSAGE_OVERHEAD_TOKENS = 4;

function messageTokens(message: Message): number {
  return countTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** True when a higher-level row fully covers `row`'s seq range. */
export function coveredBy(row: Summary, higher: ReadonlyArray<Summary>): boolean {
  return higher.some(
    (other) =>
      other.level > row.level && other.seq_from <= row.seq_from && other.seq_to >= row.seq_to,
  );
}

/**
 * True when some row (any level) covers message position `seq`. This is
 * THE hiding rule — deliberately range-based, not a scalar frontier: when a
 * mid-range message is deleted, the deletion cascade removes its covering
 * row, and the surviving rows' ranges need not reach the old frontier. A
 * frontier rule would keep hiding positions that nothing covers anymore
 * (never sent verbatim, never re-summarized).
 */
export function coveredByAny(rows: ReadonlyArray<Summary>, seq: number): boolean {
  return rows.some((row) => row.seq_from <= seq && seq <= row.seq_to);
}

function maxLevel(rows: ReadonlyArray<Summary>): number {
  let level = 0;
  for (const row of rows) {
    if (row.level > level) {
      level = row.level;
    }
  }
  return level;
}

/**
 * Wraps `summary` with the `injection_template`: every literal
 * `{{summary}}` occurrence is replaced (split/join, never a regex replace —
 * a summary may contain `$` patterns a regex would otherwise interpret). A
 * template without the placeholder falls back to template + "\n" + text.
 */
function inject(summary: string, template: string): string {
  if (!template.includes("{{summary}}")) {
    return `${template}\n${summary}`;
  }
  return template.split("{{summary}}").join(summary);
}

/**
 * Builds the hierarchical summary text: rows covered by a higher level are
 * skipped, the rest render chronologically (wider/older ranges first),
 * each wrapped by the `injection_template`. The rows are taken as-is —
 * under coverage semantics every stored row covers only hidden positions
 * (the deletion cascade guarantees any row intersecting a deleted position
 * dies), so no frontier-style filter applies. Rows holding the no-content
 * marker stay in the coverage chain (they still cover their range) but
 * inject nothing — when no visible rows exist the text is "". The returned
 * `included` rows (markers among them) span the summary block's seq range.
 */
function buildSummaryText(
  rows: ReadonlyArray<Summary>,
  injectionTemplate: string,
): { text: string; tokens: number; included: Summary[] } {
  const included: Summary[] = [];
  for (let level = maxLevel(rows); level >= 0; level--) {
    for (const row of rows) {
      if (row.level === level && !coveredBy(row, included)) {
        included.push(row);
      }
    }
  }
  included.sort((a, b) => a.seq_from - b.seq_from || b.level - a.level);
  const text = included
    .filter((row) => !isNoContent(row.summary))
    .map((row) => inject(row.summary, injectionTemplate))
    .join("\n\n");
  return { text, tokens: text === "" ? 0 : countTokens(text) + MESSAGE_OVERHEAD_TOKENS, included };
}

export const summariesStrategy: MemoryStrategy = {
  id: "summaries",
  name: "Layered Summaries",
  configSchema: summariesConfigSchema,
  apply: async (history, budget, ctx) => {
    const config = summariesConfigSchema.parse(ctx.config);

    if (history.length === 0) {
      return { history: [] };
    }

    // No summarizer injected: degrade to keeping the verbatim window.
    if (!ctx.summarizeFn) {
      return { history: history.slice(-config.summarize_after) };
    }

    const summarize = ctx.summarizeFn;
    // Coverage is per-position: a message is hidden iff some summary row
    // (any level) covers its seq (see {@link coveredByAny}). A scalar
    // frontier would also hide positions whose covering row died with a
    // mid-range deletion — messages that then neither render verbatim nor
    // through a summary.
    const rows = ctx.summaries.list(ctx.chatId);
    const live = history.filter((message) => !coveredByAny(rows, message.seq));
    // Whether ANY position of this history is covered decides the summary
    // block's existence: rows whose ranges fall entirely outside the
    // history (e.g. a plugin stage pre-trimmed it) cover nothing here.
    const anyCovered = history.some((message) => coveredByAny(rows, message.seq));

    // Precompute each live message's token cost once. The roll-up loop below
    // compares the SAME live window on every iteration, and the hard-trim
    // walk drops one message at a time; re-tokenizing the array in each step
    // (via the old historyTokens helper) made both loops O(n²).
    const liveTokens = live.map(messageTokens);
    const liveTotal = liveTokens.reduce((sum, value) => sum + value, 0);

    // Over budget: roll the oldest uncovered summaries up a level (which
    // shrinks the summary block) until the assembly fits or no roll-up is
    // possible — the only remaining AI call at assembly time. This is the
    // budget-pressure fallback of the layered mechanics; the rich templated
    // prompting (system/user pair, strip patterns, growing prior context)
    // lives in the server's summarizeUncovered (generate-summaries.ts) —
    // here `summarize` receives the plain merged range text.
    const current = [...rows];
    for (;;) {
      const block = buildSummaryText(current, config.injection_template);
      if (liveTotal + block.tokens <= budget) {
        break;
      }
      const created = await rollUp(current, config, summarize, ctx.chatId, ctx.summaries);
      if (!created) {
        break;
      }
      current.push(created);
    }

    // Roll-ups exhausted and still over budget: hard-trim the oldest live
    // messages, always keeping the newest `summarize_after` verbatim.
    const block = buildSummaryText(current, config.injection_template);
    // A single O(n) walk: `tailTokens` is the running total of the surviving
    // suffix, so each dropped message subtracts its precomputed cost instead
    // of re-summing (and re-slicing) the whole tail.
    const maxDrop = Math.max(0, live.length - config.summarize_after);
    let start = 0;
    let tailTokens = liveTotal;
    while (start < maxDrop && tailTokens + block.tokens > budget) {
      tailTokens -= liveTokens[start] ?? 0;
      start++;
    }
    const tail = start === 0 ? live : live.slice(start);

    if (!anyCovered) {
      // No row covers any position of this history — the (possibly
      // trimmed) history speaks for itself, with no summary block.
      return { history: tail };
    }

    const result: MemoryResult = {
      history: tail.length > 0 ? tail : history.slice(-config.summarize_after),
      summary: {
        // The block's span: the included rows' combined range (markers
        // included — they cover their range even when they inject nothing).
        seqFrom: Math.min(...block.included.map((row) => row.seq_from)),
        seqTo: Math.max(...block.included.map((row) => row.seq_to)),
        text: block.text,
      },
    };
    return result;
  },
};

/**
 * Rolls the oldest `snippets_per_promotion` uncovered snippets of the
 * lowest rollable level into a single level+1 summary. Marker rows never
 * promote (a marker covers its range but carries nothing worth
 * promoting), and a level+1 row is never created at or beyond
 * `max_layer_depth`. Returns `null` when no roll-up is possible (fewer
 * than 2 / `snippets_per_promotion` uncovered snippets at every allowed
 * level).
 */
async function rollUp(
  rows: ReadonlyArray<Summary>,
  config: SummariesConfig,
  summarize: ((rangeText: string) => Promise<string>) | undefined,
  chatId: string,
  repo: SummariesRepository,
): Promise<Summary | null> {
  if (!summarize) {
    return null;
  }
  // The deepest ALLOWED level is max_layer_depth - 1, so only levels below
  // it can roll up (level + 1 must stay <= max_layer_depth - 1).
  const deepest = config.max_layer_depth - 1;
  for (let level = 0; level <= maxLevel(rows) && level < deepest; level++) {
    const rollable = rows
      .filter((row) => row.level === level && !coveredBy(row, rows) && !isNoContent(row.summary))
      .sort((a, b) => a.seq_from - b.seq_from);
    if (rollable.length < 2 || rollable.length < config.snippets_per_promotion) {
      continue;
    }
    const group = rollable.slice(0, config.snippets_per_promotion);
    const text = await summarize(group.map((row) => row.summary).join("\n\n"));
    return repo.create(chatId, {
      level: level + 1,
      seq_from: group[0]?.seq_from ?? 1,
      seq_to: group[group.length - 1]?.seq_to ?? 1,
      summary: text,
      tokens: countTokens(text),
    });
  }
  return null;
}
