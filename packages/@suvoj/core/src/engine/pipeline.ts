/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Repositories } from "../repositories";
import type { Character } from "../schema/characters";
import type { Chat } from "../schema/chats";
import type { LorebookEntry } from "../schema/lorebooks";
import type { Message } from "../schema/messages";
import type { Persona } from "../schema/personas";
import { trackerStage } from "../tracker/injection";
import type { LorebookRunResult } from "./lorebook";
import { runLorebook } from "./lorebook";
import type { MacroContext } from "./macros";
import { getMemoryStrategy, type MemorySummary, registerMemoryStrategy } from "./memory";
import { summariesStrategy } from "./memory/summaries";
import { trimStrategy } from "./memory/trim";
import type { GenerationType, Preset } from "./preset";
import type { CompiledRegexRule } from "./regex";

/**
 * Context-pipeline stage registry (the tracker surface).
 *
 * Stages run in order before prompt assembly and receive the mutable build
 * context — a stage can inject or rewrite blocks (history, tail state,
 * lorebook result, summary, macro inputs). The default pipeline is
 * `lorebook → memory → persona → history → tracker`; `registerPipelineStage`
 * inserts custom stages relative to existing ones. No plugin loading: the
 * registry is internal and typed.
 *
 * `history` and `tail` are deliberately separate sinks: history is the
 * conversation (trimmable, rewritten by memory stages), while `tail` is
 * injected STATE rendered after the summary. A stage that injects state
 * belongs in `tail` — putting it in `history` would let the budget pass trim
 * it and would move it ahead of the summary in the assembled prompt.
 */

/** Build-time overrides for the assembler. */
export interface PromptBuildOptions {
  /** Context window in tokens for the budget computation. */
  contextSize?: number;
  /** Response reservation in tokens for the budget computation. */
  maxTokens?: number;
}

/** The mutable prompt-build context handed to every stage. */
export interface PromptContext {
  chat: Chat;
  character: Character;
  persona: Persona | null;
  preset: Preset;
  /** Active-swipe chat history, seq-ordered; memory stages rewrite it. */
  history: Message[];
  /**
   * Transient STATE rows rendered after the conversation and the memory
   * summary, just before the post-history instructions — the tracker stage
   * fills it with its snapshots. Deliberately separate from `history`:
   * injected state is not conversation, so it must neither be trimmed as
   * history nor re-rendered when the live window moves. Keeping it after the
   * summary is what lets a summary change (which only happens on chunk
   * boundaries) invalidate nothing but this block and the instructions that
   * follow it.
   */
  tail?: Message[];
  /** Set by the lorebook stage (activations + `commitTurn`). */
  lorebook: LorebookRunResult | null;
  /** Summary block produced by a memory strategy. */
  summary?: MemorySummary;
  /**
   * Active generation type for ST `injection_trigger` gating. Undefined →
   * `normal`; a prompt whose non-empty trigger list omits the active type is
   * skipped entirely (see ./prompt). `quiet` / `impersonate` have no Suvoj
   * equivalent and therefore never match.
   */
  generationType?: GenerationType;
  /**
   * The `messages.seq` this generation REPLACES — set only for a regenerate /
   * swipe whose trailing active message is an assistant row. The tracker stage
   * must not inject snapshots at this position: they describe the swipe being
   * replaced, and the model writing its replacement must not see them.
   * Undefined for every other generation type (and for a non-assistant tail,
   * which the persistence path appends instead of replacing).
   */
  replacedSeq?: number;
  /** Macro inputs shared by every macro evaluation of this build. */
  macros: MacroContext;
  /** Server-injected summarizer for the summaries memory strategy. */
  summarizeFn?: (rangeText: string) => Promise<string>;
  rng: () => number;
  repos: Repositories;
  /**
   * Lazily-memoized compiled regex rules for this build. Read + compiled on
   * first use and cached on the context, so rendering dozens of blocks does
   * not re-read settings or recompile the same patterns per block.
   */
  regexRules?: CompiledRegexRule[];
  /** Assembler overrides (context window, response size). */
  options?: PromptBuildOptions;
}

export interface PipelineStage {
  id: string;
  run(ctx: PromptContext): Promise<void>;
}

export interface RegisterStageOptions {
  /** Insert before the stage with this id. */
  before?: string;
  /** Insert after the stage with this id. */
  after?: string;
  /** Replace the stage with this id. */
  insteadOf?: string;
}

/** Settings key holding global (character-independent) lorebook ids. */
export const GLOBAL_LOREBOOKS_KEY = "lorebooks:global";

/** Budget fallbacks (tokens) used when no build options carry the sizes. */
const DEFAULT_CONTEXT_SIZE = 128000;
const DEFAULT_MAX_TOKENS = 4096;

const lorebookStage: PipelineStage = {
  id: "lorebook",
  run: async (ctx) => {
    if (ctx.lorebook) {
      return;
    }
    const characterBooks = ctx.repos.lorebooks.listForCharacter(ctx.character.id);
    const global = ctx.repos.settings.get<{ ids?: unknown }>(GLOBAL_LOREBOOKS_KEY);
    const globalIds = Array.isArray(global?.ids)
      ? global.ids.filter((id): id is string => typeof id === "string")
      : [];
    const characterBookIds = new Set(characterBooks.map((book) => book.id));
    const entries: LorebookEntry[] = [];
    for (const book of characterBooks) {
      entries.push(...ctx.repos.lorebooks.listEntries(book.id));
    }
    for (const id of globalIds) {
      if (!characterBookIds.has(id)) {
        entries.push(...ctx.repos.lorebooks.listEntries(id));
      }
    }
    ctx.lorebook = runLorebook({
      entries,
      scanText: ctx.history.map((message) => message.content),
      settings: {
        scanDepth: ctx.preset.settings.scan_depth,
        budgetTokens: ctx.preset.settings.wi_budget,
      },
      character: { name: ctx.character.name, tags: ctx.character.tags },
      globalScan: {
        personaDescription: ctx.persona?.description,
        characterDescription: ctx.character.description,
        characterPersonality: ctx.character.personality,
        scenario: ctx.character.scenario,
        creatorNotes: ctx.character.creator_notes,
      },
      chatId: ctx.chat.id,
      vars: ctx.repos.variables,
      rng: ctx.rng,
      macros: ctx.macros,
    });
  },
};

const memoryStage: PipelineStage = {
  id: "memory",
  run: async (ctx) => {
    const settings = ctx.preset.settings.memory;
    const strategy = getMemoryStrategy(settings.strategy);
    if (!strategy) {
      return;
    }
    const contextSize = ctx.options?.contextSize ?? DEFAULT_CONTEXT_SIZE;
    const maxTokens = ctx.options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const result = await strategy.apply(ctx.history, Math.max(0, contextSize - maxTokens), {
      chatId: ctx.chat.id,
      config: settings.config,
      summaries: ctx.repos.summaries,
      summarizeFn: ctx.summarizeFn,
      rng: ctx.rng,
    });
    ctx.history = result.history;
    ctx.summary = result.summary;
  },
};

const personaStage: PipelineStage = {
  id: "persona",
  run: async (ctx) => {
    // Customization point: override/extend the persona block before
    // assembly (e.g. a tracker stage decorating the persona description).
    ctx.macros.persona = ctx.persona?.description ?? "";
    if (ctx.persona?.name) {
      ctx.macros.user = ctx.persona.name;
    }
  },
};

const historyStage: PipelineStage = {
  id: "history",
  // No-op mount point: stages appended after it (the built-in tracker)
  // rewrite the history blocks injected into the prompt.
  run: async () => {},
};

/** Rebuilds the default pipeline (also used by tests after resets). */
export function defaultPipelineStages(): PipelineStage[] {
  return [lorebookStage, memoryStage, personaStage, historyStage, trackerStage];
}

/**
 * Ids of the built-in stages, derived from the same objects the default
 * pipeline is built from (so the list cannot drift). Plugin-declared stages
 * must not use them: `unregisterPipelineStage` removes the FIRST match by
 * id, so a plugin stage reusing a built-in id would take the built-in down
 * with it on unload. The plugin loader rejects such definitions upfront.
 */
export const BUILTIN_PIPELINE_STAGE_IDS: readonly string[] = [
  lorebookStage.id,
  memoryStage.id,
  personaStage.id,
  historyStage.id,
  trackerStage.id,
];

let stages: PipelineStage[] = defaultPipelineStages();

/** Registers a stage into the pipeline (insert or replace by options). */
export function registerPipelineStage(
  stage: PipelineStage,
  options: RegisterStageOptions = {},
): void {
  if (options.insteadOf !== undefined) {
    const index = stages.findIndex((existing) => existing.id === options.insteadOf);
    if (index === -1) {
      throw new Error(`pipeline stage ${options.insteadOf} not found`);
    }
    stages[index] = stage;
    return;
  }
  if (options.before !== undefined && options.after !== undefined) {
    throw new Error("pass either before or after, not both");
  }
  const anchor = options.before ?? options.after;
  const insertAt =
    anchor !== undefined ? stages.findIndex((existing) => existing.id === anchor) : stages.length;
  if (anchor !== undefined && insertAt === -1) {
    throw new Error(`pipeline stage ${anchor} not found`);
  }
  const position = options.before !== undefined ? insertAt : insertAt + 1;
  stages.splice(position, 0, stage);
}

/** Removes a registered stage by id; returns whether one was registered. */
export function unregisterPipelineStage(id: string): boolean {
  const index = stages.findIndex((existing) => existing.id === id);
  if (index === -1) {
    return false;
  }
  stages.splice(index, 1);
  return true;
}

/** Current pipeline, in execution order. */
export function listPipelineStages(): PipelineStage[] {
  return [...stages];
}

/** Test hook: restores the default pipeline. */
export function resetPipelineStages(): void {
  stages = defaultPipelineStages();
}

/** Runs every stage in order. */
export async function runPipeline(ctx: PromptContext): Promise<void> {
  for (const stage of stages) {
    await stage.run(ctx);
  }
}

// Built-in memory strategies (registry lives in ./memory).
registerMemoryStrategy(trimStrategy);
registerMemoryStrategy(summariesStrategy);

/** Re-registers the built-in memory strategies (after a test reset). */
export function registerBuiltinMemoryStrategies(): void {
  registerMemoryStrategy(trimStrategy);
  registerMemoryStrategy(summariesStrategy);
}
