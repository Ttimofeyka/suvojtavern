/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PresetPrompt } from "./api-presets";

/**
 * Prefix-cache diagnostics for the preset editor.
 *
 * Providers cache an unchanged prompt PREFIX (OpenAI-compatible automatic
 * caching, Anthropic explicit breakpoints), so anything that changes every
 * turn near the top of the prompt throws away the reuse for everything after
 * it. In Suvoj the canon prefix is the preset's system prompt, the card, and
 * the lorebook — all rendered before the `chatHistory` marker. A volatile
 * macro in any of those blocks therefore costs a full cache miss on every
 * single turn.
 *
 * The memory summary and the tracker snapshots deliberately render AFTER the
 * live window (see `engine/prompt.ts`), so they are not diagnosed here: a
 * summary that changes on a chunk boundary only invalidates the blocks after
 * it.
 */

/**
 * The engine's volatile macro names, mirrored for the browser bundle (web has
 * no runtime dependency on `@suvoj/core`). `preset-cache.test.ts` holds this
 * list to the engine's own `VOLATILE_MACRO_NAMES` so the two cannot drift.
 */
export const VOLATILE_MACROS: readonly string[] = [
  "time",
  "isotime",
  "date",
  "isodate",
  "weekday",
  "idle_duration",
  "lastmessage",
  "random",
  "roll",
];

const VOLATILE = new Set(VOLATILE_MACROS);

/** Matches one `{{…}}` macro body, mirroring the engine's pattern. */
const MACRO_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * The volatile macro names `text` evaluates, in first-appearance order and
 * deduplicated. Unknown macros never match, matching the engine's
 * case-insensitive name handling.
 */
export function volatileMacrosIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MACRO_PATTERN)) {
    const body = match[1] ?? "";
    const colon = body.indexOf(":");
    const name = (colon === -1 ? body : body.slice(0, colon)).trim().toLowerCase();
    if (VOLATILE.has(name)) {
      found.add(name);
    }
  }
  return [...found];
}

/** A prefix block that changes on every turn, and the macros that do it. */
export interface VolatilePrefixBlock {
  /** The row's id (the editor's stable key). */
  promptId: string;
  /** What to call the row — its name, never blank. */
  label: string;
  /** The volatile macros it renders, in first-appearance order. */
  macros: string[];
}

/** Markers whose own `content` is what renders at their slot. */
const CONTENT_MARKERS = new Set(["main", "jailbreak"]);

/**
 * The rows rendering before the chat history whose content carries volatile
 * macros.
 *
 * A row can change the prefix only when it actually renders there:
 *
 * - it must be enabled (a switched-off row is left out of every generation);
 * - it must render at its ARRAY POSITION — a depth injection is placed inside
 *   the live window, and a summary/state block is rewritten each turn by
 *   design, so neither belongs in a prefix diagnosis;
 * - it must appear before the `chatHistory` marker in the array (the array
 *   order IS the layout);
 * - it must own the text it renders: a regular prompt's `content`, or the
 *   `main` / `jailbreak` marker's own content. The data-rendering markers
 *   (character fields, persona, lorebook) carry no editable text here.
 *
 * Returning every offender (not just the first) lets the editor mark each
 * row, which is where the user can act on it.
 */
export function volatilePrefixBlocks(prompts: readonly PresetPrompt[]): VolatilePrefixBlock[] {
  const historyIndex = prompts.findIndex(
    (prompt) => prompt.enabled && prompt.marker === "chatHistory",
  );
  if (historyIndex === -1) {
    // No history slot: every row renders in the prefix.
    return collect(prompts, prompts.length);
  }
  return collect(prompts, historyIndex);
}

/** Scans `prompts[0…limit)` for rendering rows with volatile macros. */
function collect(prompts: readonly PresetPrompt[], limit: number): VolatilePrefixBlock[] {
  const blocks: VolatilePrefixBlock[] = [];
  for (const prompt of prompts.slice(0, limit)) {
    if (!prompt.enabled) {
      continue;
    }
    if (prompt.marker !== undefined) {
      if (!CONTENT_MARKERS.has(prompt.marker)) {
        continue;
      }
    } else if (prompt.injection_position !== 0) {
      continue;
    }
    const macros = volatileMacrosIn(prompt.content);
    if (macros.length === 0) {
      continue;
    }
    const label = prompt.name.trim() === "" ? "unnamed prompt" : prompt.name.trim();
    blocks.push({ promptId: prompt.id, label, macros });
  }
  return blocks;
}

/** The editor's one-line explanation for a diagnosed row. */
export function prefixWarningText(macros: readonly string[]): string {
  const names = macros.map((macro) => `{{${macro}}}`).join(", ");
  return `This prompt renders before the chat history, so ${names} changes the prompt prefix every turn and prevents the provider from reusing its cache. Move it after the chat history, or use a value that does not change per turn.`;
}
