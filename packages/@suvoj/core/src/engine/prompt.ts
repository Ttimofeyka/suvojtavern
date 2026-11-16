/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character } from "../schema/characters";
import type { Message, MessageRole } from "../schema/messages";
import type { RegexPlacement } from "../schema/regex";
import { LorebookPosition, type LorebookRunResult } from "./lorebook";
import { evaluateMacros } from "./macros";
import type { MemorySummary } from "./memory";
import { type PromptContext, runPipeline } from "./pipeline";
import type { PresetPrompt } from "./preset";
import {
  applyRegexRules,
  type CompiledRegexRule,
  compileRegexRules,
  getRegexRules,
  hasRulesFor,
} from "./regex";
import { countTokens } from "./tokens";

/**
 * The prompt assembler — SillyTavern-compatible ordering.
 *
 * The layout is the `preset.prompts` array order: markers render
 * character / chat / lorebook blocks at their array position, non-marker
 * prompts render their content at their slot. `main` and `jailbreak`
 * render their own prompt content — the system prompt and post-history
 * instructions come from the preset only, never from the character (the
 * character fields are kept for SillyTavern card round-trip). Prompts with
 * `injection_position: 1` do NOT render at their slot — they are inserted
 * into the chat history at `injection_depth` counted from the end (depth
 * 0 = after the last message), together with `LorebookPosition.AtDepth`
 * entries. The same-depth ordering rule mirrors ST: higher
 * `injection_order` renders closer to the end of the history.
 *
 * CACHE-STABLE LAYOUT. The two "dynamic" blocks — the memory summary and the
 * injected state rows (`ctx.tail`, filled by the tracker stage) — render at
 * the TAIL of the chatHistory section rather than its head, in the order
 * summary → state → (the blocks that follow the marker, normally the
 * post-history instructions). Everything before them is the canon prefix:
 * the preset's system prompt, the card, and the lorebook. Provider-side
 * prefix caching (OpenAI-compatible automatic caching, Anthropic breakpoints)
 * reuses an unchanged prompt PREFIX, so:
 *
 * - a summary change — which only happens when a chunk boundary lands —
 *   invalidates the tracker/state block and the post-history instructions,
 *   never the long conversation that precedes it;
 * - the newest scene state sits at the end of the prompt, where a long
 *   context's attention does not decay.
 *
 * Volatile macros (`{{time}}`, `{{date}}`, `{{idle_duration}}`, `{{random}}`,
 * …) in the canon prefix defeat that caching: they change the prefix on every
 * turn. `volatileMacrosIn` (./macros) is what the preset editor warns with.
 * `{{pick}}` is deliberately NOT volatile — it is seeded per chat + text, so
 * it renders the same value on every build.
 *
 * Every rendered text (character fields, prompt contents, history
 * messages) passes through the macro engine. After assembly the
 * `context − max_tokens` budget is enforced by trimming the oldest history
 * messages first.
 */

/** One message of the final prompt, ready for the gateway. */
export interface PromptMessage {
  role: MessageRole;
  content: string;
  /** Speaker name for chat-completions `name` fields. */
  name?: string;
}

export type { PromptBuildOptions } from "./pipeline";

export interface PromptBudget {
  context: number;
  used: number;
  remaining: number;
}

export interface PromptBuildResult {
  messages: PromptMessage[];
  tokenCount: number;
  budget: PromptBudget;
  lorebook: LorebookRunResult | null;
  summary?: MemorySummary;
}

const DEFAULT_CONTEXT_SIZE = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Internal assembled message with bookkeeping for budget trimming. */
interface Assembled {
  message: PromptMessage;
  tokens: number;
  /** True for real chat history messages (trimmable, oldest first). */
  history: boolean;
}

/** A depth insertion into the chat history. */
interface DepthInjection {
  depth: number;
  order: number;
  encounter: number;
  message: PromptMessage;
}

function evaluate(text: string, ctx: PromptContext, target: RegexPlacement = "prompt"): string {
  return applyRegex(evaluateMacros(text, ctx.macros), ctx, target);
}

/**
 * Lazily resolves the compiled rule list for this build (see PromptContext's
 * `regexRules` field): read + compile once, then reuse for every block.
 */
function regexRulesFor(ctx: PromptContext): CompiledRegexRule[] {
  if (ctx.regexRules === undefined) {
    ctx.regexRules = compileRegexRules(getRegexRules(ctx.repos));
  }
  return ctx.regexRules;
}

/**
 * Regex-only pass (macros untouched). Used where the text was ALREADY
 * macro-evaluated upstream — lorebook activations evaluate macros inside
 * `runLorebook` and must not be re-evaluated — and for the memory summary,
 * which no macro engine has touched and must stay untouched to keep a
 * no-rules build byte-identical.
 */
function applyRegex(text: string, ctx: PromptContext, target: RegexPlacement): string {
  const rules = regexRulesFor(ctx);
  if (!hasRulesFor(rules, target)) {
    return text;
  }
  return applyRegexRules(text, rules, target);
}

/** Maps a chat message role to the regex placement class it belongs to. */
function placementForRole(role: MessageRole): RegexPlacement {
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "ai";
  }
  return "prompt";
}

/**
 * ST `injection_trigger` gate. An empty trigger list means "all generation
 * types"; otherwise the active type must be listed. An undefined context
 * type is `normal` (the default the server sends). `quiet`/`impersonate`
 * are accepted on import but never match, so a prompt gated only to them is
 * dropped from every build.
 */
function matchesGenerationType(prompt: PresetPrompt, ctx: PromptContext): boolean {
  if (prompt.injection_trigger.length === 0) {
    return true;
  }
  return prompt.injection_trigger.includes(ctx.generationType ?? "normal");
}

/**
 * Renders one history row: macros always run; the regex pass runs by role.
 * Assistant rows carrying `metadata.regex_applied === true` were already
 * transformed when the reply was persisted, so the `ai` pass is SKIPPED for
 * them — re-running it (e.g. a quote-escaping rule) would double-apply.
 */
function evaluateMessage(message: Message, ctx: PromptContext): string {
  const content = evaluateMacros(message.content, ctx.macros);
  if (message.role === "assistant" && message.metadata?.regex_applied === true) {
    return content;
  }
  return applyRegex(content, ctx, placementForRole(message.role));
}

/**
 * Parses `mes_example` into example dialogue blocks (ST behavior):
 * `<START>` separates blocks; lines beginning with `{{char}}:` / `{{user}}:`
 * start a new message, continuation lines extend it.
 */
function parseExampleDialogues(
  mesExample: string,
  ctx: PromptContext,
): Array<Array<PromptMessage>> {
  const speakerPattern = /^\s*\{\{(char|user)\}\}\s*:\s?/i;
  const blocks: Array<Array<PromptMessage>> = [];
  for (const rawBlock of mesExample.split(/<START>/i)) {
    const block: PromptMessage[] = [];
    for (const line of rawBlock.split("\n")) {
      const speaker = speakerPattern.exec(line);
      if (speaker) {
        const who =
          (speaker[1] ?? "char").toLowerCase() === "user" ? ctx.macros.user : ctx.macros.char;
        block.push({
          role: "system",
          name: who,
          content: line.slice(speaker[0].length),
        });
      } else {
        const last = block[block.length - 1];
        if (last) {
          last.content = `${last.content}\n${line}`;
        }
      }
    }
    if (block.length > 0) {
      blocks.push(block);
    }
  }
  return blocks;
}

/** Inserts depth injections into the rendered history (depth from the end). */
function insertDepthInjections(
  history: ReadonlyArray<Assembled>,
  injections: ReadonlyArray<DepthInjection>,
): Assembled[] {
  if (injections.length === 0) {
    return [...history];
  }
  const result = [...history];
  const base = history.length;
  // Deepest first; at equal depth higher injection_order first — the
  // sequential splices leave higher orders closer to the end (ST rule).
  const ordered = [...injections].sort(
    (a, b) => b.depth - a.depth || b.order - a.order || a.encounter - b.encounter,
  );
  for (const injection of ordered) {
    const index = Math.max(0, base - injection.depth);
    result.splice(index, 0, {
      message: injection.message,
      tokens: countTokens(injection.message.content) + MESSAGE_OVERHEAD_TOKENS,
      // Depth injections are prompt blocks, not chat history: they are
      // never subject to history trimming.
      history: false,
    });
  }
  return result;
}

function messageName(
  message: Message,
  character: Character,
  ctx: PromptContext,
): string | undefined {
  if (message.name !== null && message.name !== undefined && message.name !== "") {
    return message.name;
  }
  if (message.role === "assistant") {
    return character.name;
  }
  if (message.role === "user") {
    return ctx.macros.user;
  }
  return undefined;
}

/** Builds the chat-history section (the `chatHistory` marker). */
function buildHistorySection(
  ctx: PromptContext,
  injections: ReadonlyArray<DepthInjection>,
): Assembled[] {
  const assembled: Assembled[] = [];
  const settings = ctx.preset.settings;

  if (settings.new_chat_prompt !== "") {
    const content = evaluate(settings.new_chat_prompt, ctx);
    if (content !== "") {
      assembled.push({
        message: { role: "system", content },
        tokens: countTokens(content) + MESSAGE_OVERHEAD_TOKENS,
        history: false,
      });
    }
  }

  for (const message of ctx.history) {
    const content = evaluateMessage(message, ctx);
    const promptMessage: PromptMessage = { role: message.role, content };
    const name = messageName(message, ctx.character, ctx);
    if (name !== undefined) {
      promptMessage.name = name;
    }
    assembled.push({
      message: promptMessage,
      tokens: countTokens(content) + MESSAGE_OVERHEAD_TOKENS,
      history: true,
    });
  }

  // Depth injections target the history itself, not the marker above.
  const historyStart = assembled.findIndex((item) => item.history);
  const head = assembled.slice(0, historyStart === -1 ? assembled.length : historyStart);
  const historyItems = assembled.slice(historyStart === -1 ? assembled.length : historyStart);
  const injected = insertDepthInjections(historyItems, injections);
  return [...head, ...injected];
}

/**
 * Builds the dynamic TAIL of the chat-history section: the memory summary and
 * the injected state rows (`ctx.tail`), in that order.
 *
 * Both are `history: false` — the summary already REPLACED the ranges it
 * covers, and state rows were never conversation — so the budget pass below
 * can never trim them. Rendering them here (rather than at the history head)
 * is what makes the layout cache-stable: a summary rewritten on a chunk
 * boundary only invalidates the blocks after it, and the scope/state the
 * model most needs to obey sits immediately before the post-history
 * instructions instead of buried under the live window.
 */
function buildDynamicTail(ctx: PromptContext): Assembled[] {
  const assembled: Assembled[] = [];

  // The summary text never passes through `evaluate` (it is generated, not
  // templated), so it gets an explicit `prompt` regex pass — and its tokens
  // are recounted so the budget reflects any change.
  if (ctx.summary && ctx.summary.text !== "") {
    const summaryText = applyRegex(ctx.summary.text, ctx, "prompt");
    assembled.push({
      message: { role: "system", content: summaryText },
      tokens: countTokens(summaryText) + MESSAGE_OVERHEAD_TOKENS,
      history: false,
    });
  }

  for (const message of ctx.tail ?? []) {
    const content = evaluateMessage(message, ctx);
    const promptMessage: PromptMessage = { role: message.role, content };
    const name = messageName(message, ctx.character, ctx);
    if (name !== undefined) {
      promptMessage.name = name;
    }
    assembled.push({
      message: promptMessage,
      tokens: countTokens(content) + MESSAGE_OVERHEAD_TOKENS,
      history: false,
    });
  }

  return assembled;
}

/** Renders the lorebook blocks for a set of positions. */
function lorebookMessages(
  ctx: PromptContext,
  positions: ReadonlyArray<LorebookPosition>,
): Assembled[] {
  if (!ctx.lorebook) {
    return [];
  }
  // Lorebook activations are macro-evaluated inside `runLorebook`, so they
  // take the regex-only pass here (never `evaluate`, which would double-run
  // macros). Tokens are counted from the transformed text below.
  const contents = ctx.lorebook.activations
    .filter((activation) => positions.includes(activation.position))
    .map((activation) => applyRegex(activation.content, ctx, "prompt"))
    .filter((content) => content !== "");
  if (contents.length === 0) {
    return [];
  }
  const content = contents.join("\n\n");
  return [
    {
      message: { role: "system", content },
      tokens: countTokens(content) + MESSAGE_OVERHEAD_TOKENS,
      history: false,
    },
  ];
}

/** Assembles the full prompt for the context (runs the pipeline first). */
export async function buildPrompt(ctx: PromptContext): Promise<PromptBuildResult> {
  await runPipeline(ctx);

  const { preset, character, persona } = ctx;

  // Depth injections are position-independent (ST: they live in the chat
  // history, not at a layout slot), so they are collected up front from
  // every enabled prompt — regardless of where they sit in the array.
  const injections: DepthInjection[] = [];
  let encounter = 0;
  for (const prompt of preset.prompts) {
    if (!prompt.enabled || !matchesGenerationType(prompt, ctx)) {
      continue;
    }
    if (prompt.marker || prompt.injection_position !== 1) {
      continue;
    }
    const content = evaluate(prompt.content, ctx);
    if (content !== "") {
      injections.push({
        depth: prompt.injection_depth,
        order: prompt.injection_order,
        encounter: encounter++,
        message: { role: prompt.role, content },
      });
    }
  }

  const push = (assembled: Assembled[], message: PromptMessage): void => {
    if (message.content === "") {
      return;
    }
    assembled.push({
      message,
      tokens: countTokens(message.content) + MESSAGE_OVERHEAD_TOKENS,
      history: false,
    });
  };

  const assembled: Assembled[] = [];

  for (const prompt of preset.prompts) {
    if (!prompt.enabled) {
      continue;
    }
    // Trigger-gated prompts are skipped wherever they would render.
    if (!matchesGenerationType(prompt, ctx)) {
      continue;
    }
    // In-chat depth injections never render at their array position.
    if (!prompt.marker && prompt.injection_position === 1) {
      continue;
    }

    switch (prompt.marker) {
      case "main":
      case "jailbreak":
        // The system prompt and post-history instructions come from the
        // preset only — the character fields are kept for SillyTavern card
        // round-trip and never override the preset content.
        push(assembled, { role: prompt.role, content: evaluate(prompt.content, ctx) });
        break;
      case "worldInfoBefore":
        assembled.push(...lorebookMessages(ctx, [LorebookPosition.BeforeChar]));
        break;
      case "worldInfoAfter":
        // Native v1 has no author's-note block: AN positions render after
        // the character definitions, in order after/…, before AtDepth.
        assembled.push(
          ...lorebookMessages(ctx, [
            LorebookPosition.AfterChar,
            LorebookPosition.BeforeAN,
            LorebookPosition.AfterAN,
          ]),
        );
        break;
      case "personaDescription":
        push(assembled, {
          role: prompt.role,
          content: evaluate(persona?.description ?? "", ctx),
        });
        break;
      case "charDescription":
        push(assembled, { role: prompt.role, content: evaluate(character.description, ctx) });
        break;
      case "charPersonality": {
        if (character.personality !== "") {
          const format = preset.settings.personality_format;
          const content = evaluate(
            format.replaceAll("{{personality}}", character.personality),
            ctx,
          );
          push(assembled, { role: prompt.role, content });
        }
        break;
      }
      case "scenario": {
        if (character.scenario !== "") {
          const format = preset.settings.scenario_format;
          const content = evaluate(format.replaceAll("{{scenario}}", character.scenario), ctx);
          push(assembled, { role: prompt.role, content });
        }
        break;
      }
      case "dialogueExamples": {
        if (character.mes_example !== "") {
          for (const block of parseExampleDialogues(character.mes_example, ctx)) {
            if (preset.settings.new_example_chat_prompt !== "") {
              push(assembled, {
                role: "system",
                content: evaluate(preset.settings.new_example_chat_prompt, ctx),
              });
            }
            for (const message of block) {
              push(assembled, {
                role: message.role,
                name: message.name,
                content: evaluate(message.content, ctx),
              });
            }
          }
        }
        break;
      }
      case "chatHistory": {
        // Lorebook @depth entries join preset injections in the history.
        const lorebookInjections: DepthInjection[] = [];
        for (const activation of ctx.lorebook?.activations ?? []) {
          if (activation.position === LorebookPosition.AtDepth && activation.content !== "") {
            lorebookInjections.push({
              depth: activation.depth,
              order: activation.entry.order,
              encounter: encounter++,
              // Depth activations are prompt blocks: regex-only pass (their
              // macros already ran inside the lorebook engine).
              message: {
                role: activation.role,
                content: applyRegex(activation.content, ctx, "prompt"),
              },
            });
          }
        }
        assembled.push(...buildHistorySection(ctx, [...injections, ...lorebookInjections]));
        // The dynamic tail closes the section: summary, then injected state.
        // Rendering them AFTER the live window (not before it) keeps the whole
        // canon prefix + conversation byte-stable across ordinary turns.
        assembled.push(...buildDynamicTail(ctx));
        break;
      }
      case undefined:
        push(assembled, { role: prompt.role, content: evaluate(prompt.content, ctx) });
        break;
    }
  }

  // Depth injections whose history never rendered (no chatHistory marker
  // in the layout) have nowhere to land and are dropped — documented.

  // Budget enforcement: context − max_tokens, trimming oldest history first.
  const context = ctx.options?.contextSize ?? DEFAULT_CONTEXT_SIZE;
  const maxTokens = ctx.options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget = Math.max(0, context - maxTokens);

  // Record history positions and the total in one pass. Trimming must remove
  // history rows in array order, but depth injections (history: false) are
  // interleaved among them, so a contiguous prefix/suffix slice would drop the
  // wrong rows. Positions let us drop the first k history rows by index while
  // every other item keeps its place.
  const historyIndices: number[] = [];
  let total = 0;
  for (const [index, item] of assembled.entries()) {
    total += item.tokens;
    if (item.history) {
      historyIndices.push(index);
    }
  }

  // Drop the fewest oldest history rows that bring `total` back under budget.
  let dropped = 0;
  let removedTokens = 0;
  while (dropped < historyIndices.length && total - removedTokens > budget) {
    const index = historyIndices[dropped];
    if (index !== undefined) {
      removedTokens += assembled[index]?.tokens ?? 0;
    }
    dropped += 1;
  }

  // Filter by the dropped set (O(n)) rather than splicing per removal (O(n²)).
  const droppedIndices = dropped === 0 ? null : new Set(historyIndices.slice(0, dropped));
  const kept =
    droppedIndices === null
      ? assembled
      : assembled.filter((_, index) => !droppedIndices.has(index));
  const keptTokens = total - removedTokens;

  return {
    messages: kept.map((item) => item.message),
    tokenCount: keptTokens,
    budget: { context, used: keptTokens, remaining: budget - keptTokens },
    lorebook: ctx.lorebook,
    summary: ctx.summary,
  };
}
