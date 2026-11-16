/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Repositories } from "../repositories";
import type { Character } from "../schema/characters";
import type { Chat } from "../schema/chats";
import type { Persona } from "../schema/personas";
import { applyChoices, choiceMacroValues, settingsChoices, settingsControls } from "./controls";
import type { LorebookRunResult } from "./lorebook";
import type { MacroContext } from "./macros";
import { presetDefinedTags } from "./macros";
import type { MemorySummary } from "./memory";
import { resolveMemorySettings } from "./memory/resolve";
import type { PromptContext } from "./pipeline";
import type { GenerationType, Preset, Sampling } from "./preset";
import { defaultPreset, fromStoredPreset } from "./preset";
import type { PromptBudget, PromptMessage } from "./prompt";
import { buildPrompt } from "./prompt";

/**
 * Orchestration facade — what the server calls once per generation.
 * Loads the chat, character, persona and preset from the repositories, runs
 * the context pipeline and assembles the prompt. Purely repository-driven:
 * no HTTP, no gateway calls (summarization is injected via `summarizeFn`).
 */

/** Budget fallbacks mirroring the assembler's defaults (engine/prompt.ts). */
const DEFAULT_CONTEXT_SIZE = 128000;
const DEFAULT_MAX_TOKENS = 4096;

export interface PrepareGenerationInput {
  repos: Repositories;
  chatId: string;
  /**
   * Explicit preset id; defaults to the `default_preset_id` setting (when it
   * names a live preset), else the first stored preset (or built-in).
   */
  presetId?: string;
  /** Persona override; defaults to the chat's persona. */
  personaId?: string | null;
  /**
   * Active generation type for ST `injection_trigger` gating. Undefined →
   * `normal`. Swipes are regenerates in Suvoj, so the server maps both to
   * `"regenerate"`.
   */
  generationType?: GenerationType;
  /**
   * Connection-profile samplers — the ONLY sampling source (presets carry
   * none). They drive the prompt budget (context_size / max_tokens) and are
   * returned as the generation's sampling. Omitted → `{}` (the gateway
   * applies its own defaults).
   */
  sampling?: Sampling;
  /** Gateway-backed summarizer for the summaries memory strategy. */
  summarizeFn?: (rangeText: string) => Promise<string>;
  /**
   * Extra `{{ui:<key>}}` values merged OVER the preset's own control values.
   * Plugin-contributed controls (phase 3) arrive under namespaced keys
   * (`plugin:<pluginId>:<controlId>`), so a collision with a preset control's
   * bare id is impossible; the merged map order below is documented rather
   * than relied on. Core stays plugin-agnostic: this is a plain data input.
   */
  uiValues?: Record<string, string>;
  rng?: () => number;
}

export interface PreparedGeneration {
  chat: Chat;
  character: Character;
  persona: Persona | null;
  preset: Preset;
  sampling: Sampling;
  messages: PromptMessage[];
  tokenCount: number;
  budget: PromptBudget;
  /** Lorebook activations + `commitTurn` (sticky bookkeeping). */
  lorebook: LorebookRunResult | null;
  summary?: MemorySummary;
}

/**
 * Loads a native preset from the repository (throws when an explicit id is
 * unknown). Without an explicit id: the `default_preset_id` setting wins
 * when it names a live preset, else the first stored preset, else the
 * built-in default. This is the engine's one shared preset resolution —
 * `prepareGeneration` and consumers that must match generation's preset
 * (e.g. the server's `summariesConfigFor`) both resolve through it.
 */
/**
 * Applies the preset's UI-control choices to its prompt rows, so every
 * consumer of `loadPreset` sees the EFFECTIVE pipeline (a prompt switched
 * off by an unchosen option must not render). Settings survive verbatim
 * because the engine reads the resolved choices from them, not from here.
 */
function withControlChoices(preset: Preset): Preset {
  const controls = settingsControls(preset.settings);
  if (controls.length === 0) {
    return preset;
  }
  const choices = settingsChoices(preset.settings);
  return { ...preset, prompts: applyChoices(preset.prompts, controls, choices) };
}

export function loadPreset(repos: Repositories, presetId?: string): Preset {
  if (presetId !== undefined) {
    const stored = repos.presets.get(presetId);
    if (!stored) {
      throw new Error(`preset ${presetId} not found`);
    }
    return withControlChoices(fromStoredPreset(stored));
  }
  const defaultId = repos.settings.get("default_preset_id");
  if (typeof defaultId === "string") {
    const stored = repos.presets.get(defaultId);
    if (stored) {
      return withControlChoices(fromStoredPreset(stored));
    }
  }
  const stored = repos.presets.list()[0];
  return stored ? withControlChoices(fromStoredPreset(stored)) : defaultPreset();
}

/**
 * Prepares a full generation: pipeline + assembly over repository state.
 * Call `result.lorebook.commitTurn()` after the reply lands to advance
 * sticky/cooldown/delay turn state.
 */
export async function prepareGeneration(
  input: PrepareGenerationInput,
): Promise<PreparedGeneration> {
  const { repos } = input;
  const chat = repos.chats.get(input.chatId);
  if (!chat) {
    throw new Error(`chat ${input.chatId} not found`);
  }
  const character = repos.characters.get(chat.character_id);
  if (!character) {
    throw new Error(`character ${chat.character_id} of chat ${chat.id} not found`);
  }
  const personaId = input.personaId !== undefined ? input.personaId : chat.persona_id;
  const persona = personaId ? (repos.personas.get(personaId) ?? null) : null;
  const preset = loadPreset(repos, input.presetId);

  // The connection profile's samplers are the only sampling source; they
  // drive the token budget via the build options (context_size /
  // max_tokens, falling back to the assembler's defaults).
  const sampling = input.sampling ?? {};

  // Global memory settings (Settings page) override the preset's wiring:
  // `memory_strategy` re-selects the strategy while keeping the preset's
  // config, and `memory_config` merges over that config per-field (see
  // ./memory/resolve). The pipeline's memory stage then reads the resolved
  // wiring from `preset.settings.memory` as before.
  preset.settings.memory = resolveMemorySettings(repos, preset);

  const active = repos.messages.listActive(chat.id);
  // A regenerate/swipe REPLACES the trailing assistant row: the server maps a
  // swipe to `generationType: "regenerate"`, and `persistAssistantMessage`
  // turns such a run into a new `variant_of` sibling of that row. Keeping the
  // row as the prompt's final assistant turn would make the model CONTINUE the
  // old option instead of writing a fresh one — mirroring SillyTavern and the
  // assistant-only gate in `persistAssistantMessage`. A non-assistant tail
  // stays: persistence appends there, so the user turn must remain visible.
  // `normal` and `continue` are unchanged — `continue` legitimately extends
  // the trailing assistant message and must still see it.
  const isReplace = input.generationType === "regenerate" || input.generationType === "swipe";
  const tail = active.at(-1);
  const replacesTail = isReplace && tail?.role === "assistant";
  const history = replacesTail ? active.slice(0, -1) : active;
  const replacedSeq = replacesTail ? tail.seq : undefined;
  // `last` must describe what the MODEL sees, not the dropped row: the
  // `{{lastMessage}}` / `{{idle_duration}}` macros would otherwise advertise
  // the very option this run replaces.
  const last = history[history.length - 1];
  // Stable `{{roll}}`: one seed per generation TARGET position. A regenerate
  // reuses the replaced row's seq, a continue extends the tail's seq, and a
  // normal send targets the next seq — so sibling swipes share a roll while a
  // new turn rolls anew.
  const rollSeed =
    replacedSeq !== undefined
      ? replacedSeq
      : input.generationType === "continue"
        ? (tail?.seq ?? 0)
        : (tail?.seq ?? 0) + 1;
  const macros: MacroContext = {
    char: character.name,
    user: persona?.name ?? "User",
    persona: persona?.description ?? "",
    chatId: chat.id,
    vars: repos.variables,
    rng: input.rng,
    rollSeed,
    lastMessage: last?.content,
    lastMessageAt: last ? new Date(last.created_at) : null,
    // `loadPreset` returned prompts already switched by the controls, but the
    // raw declarations/values still live in `settings` — resolve the macro
    // text from those (a stale choice falls back the same way generation did).
    // Plugin-contributed values (`input.uiValues`, namespaced) are spread
    // OVER the preset's bare-id values: plugin keys can never collide with a
    // preset control id, so the order only matters for identical keys.
    ui: {
      ...choiceMacroValues(settingsControls(preset.settings), settingsChoices(preset.settings)),
      ...input.uiValues,
    },
    // Which optional blocks are actually in the prompt, for `{{#has:<tag>}}`.
    // Read from the preset's EFFECTIVE rows (`loadPreset` already applied the
    // control choices above), so a block switched off by a control contributes
    // no tag — exactly like generation, which skips that row.
    definedTags: presetDefinedTags(preset.prompts).definedTags,
  };

  const ctx: PromptContext = {
    chat,
    character,
    persona,
    preset,
    history,
    lorebook: null,
    generationType: input.generationType,
    replacedSeq,
    macros,
    summarizeFn: input.summarizeFn,
    rng: input.rng ?? Math.random,
    repos,
    options: {
      contextSize: sampling.context_size ?? DEFAULT_CONTEXT_SIZE,
      maxTokens: sampling.max_tokens ?? DEFAULT_MAX_TOKENS,
    },
  };
  const result = await buildPrompt(ctx);

  return {
    chat,
    character,
    persona,
    preset,
    sampling,
    messages: result.messages,
    tokenCount: result.tokenCount,
    budget: result.budget,
    lorebook: result.lorebook,
    summary: result.summary,
  };
}
