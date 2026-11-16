/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/** Chat role a prompt block renders as. */
export type PresetPromptRole = "system" | "user" | "assistant";

/** Fixed pipeline slots that render character / chat / lorebook data. */
export type PresetPromptMarker =
  | "main"
  | "worldInfoBefore"
  | "personaDescription"
  | "charDescription"
  | "charPersonality"
  | "scenario"
  | "worldInfoAfter"
  | "dialogueExamples"
  | "chatHistory"
  | "jailbreak";

/**
 * One prompt block of a preset. `id` is a stable slug the user never sees.
 * `marker` present → a fixed pipeline slot: `main` and `jailbreak` carry
 * their own editable content, the rest render their data and ignore
 * `content`. `injection_position: 1` injects the block into the chat
 * history at `injection_depth` from the end instead of its array slot.
 * `injection_trigger` gates the block to generation types (empty = all).
 */
export interface PresetPrompt {
  id: string;
  name: string;
  role: PresetPromptRole;
  content: string;
  enabled: boolean;
  marker?: PresetPromptMarker;
  /** 0 = in place (array position), 1 = in-chat depth injection. */
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
  /**
   * ST `injection_trigger` — generation types this block applies to; an
   * empty list means "every type". Legacy rows may omit it.
   */
  injection_trigger?: string[];
  /**
   * Optional mutually-exclusive group membership. Purely UI metadata: it
   * lets the editor offer one choice per group (see lib/preset-groups) and
   * is ignored by the prompt assembler — `enabled` alone decides whether a
   * prompt is sent. Members of one group share `label`; `id` identifies the
   * group.
   */
  group?: { id: string; label: string };
}

/** Memory strategy wiring (mirrors core's `memorySettingsSchema`). Passthrough:
 *  the preset editor preserves it on save but never edits it. */
export interface PresetMemorySettings {
  strategy: string;
  config: Record<string, unknown>;
}

/**
 * One option of a preset UI control: a choice users can pick from the
 * Presets page. `value` is what `{{ui:<controlId>}}` expands to while the
 * option is chosen; `prompts` lists the pipeline rows the option switches on
 * (its siblings' rows are switched off at the same time).
 */
export interface ControlOption {
  id: string;
  /** Shown in the switcher. Empty → the id. */
  label: string;
  /** Text `{{ui:<control>}}` expands to while this option is chosen. Empty → the label, else the id. */
  value: string;
  /** Prompt rows switched ON (and siblings switched OFF) while this option is chosen. */
  prompts: string[];
}

/** A control's rendered form: a dropdown or a two-position switch. */
export type PresetControlType = "select" | "toggle";

/**
 * One UI control declared by a preset (mirrors core's `presetControlSchema`).
 * Stored under `settings.controls`; the chosen option id lives under
 * `settings.control_values`. A `select` renders a dropdown, a `toggle` a
 * switch, which is why a toggle carries exactly two options.
 */
export interface PresetControl {
  id: string;
  label: string;
  description: string;
  type: PresetControlType;
  options: ControlOption[];
  /** Option id used when the preset stores no choice. Empty → the first option. */
  default: string;
}

/**
 * Engine settings carried by a preset (mirrors core's `presetSettingsSchema`).
 * The API replaces the whole settings object on write, so any unknown key
 * (memory wiring, a future setting) must be merged over and preserved.
 */
export interface PresetGenerationSettings {
  scan_depth: number;
  wi_budget: number;
  new_chat_prompt: string;
  new_example_chat_prompt: string;
  personality_format: string;
  scenario_format: string;
  /** Memory strategy wiring. Opaque here — the editor preserves it verbatim,
   *  never edits it, and the server prefaults it when absent. */
  memory?: PresetMemorySettings;
  /**
   * UI controls the preset declares (see lib/preset-controls). Loose JSON on
   * the row, but these shapes when present; the editor rounds them through
   * every save, and the engine applies them at generation time.
   */
  controls?: PresetControl[];
  /** The chosen option id per control id (see `controls`). */
  control_values?: Record<string, string>;
  /** Unknown engine keys from imported/older presets survive verbatim. */
  [key: string]: unknown;
}

/** Engine defaults mirrored from core's `presetSettingsSchema` — what a new
 *  preset's editor opens on before any stored settings exist. */
export const PRESET_SETTINGS_DEFAULTS: PresetGenerationSettings = {
  scan_depth: 2,
  wi_budget: 1024,
  new_chat_prompt: "[Start a new chat]",
  new_example_chat_prompt: "[Example Chat]",
  personality_format: "{{char}}'s personality: {{personality}}",
  scenario_format: "{{scenario}}",
  memory: { strategy: "trim", config: {} },
};

/** A stored preset row; the `prompts` array order IS the generation layout. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  prompts: PresetPrompt[];
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** POST /api/presets body — only `name` is required. */
export interface CreatePresetInput {
  name: string;
  description?: string;
  prompts?: PresetPrompt[];
  settings?: PresetGenerationSettings;
}

/**
 * PATCH /api/presets/:id body — absent fields are left untouched; a patched
 * `prompts` replaces the whole stored array (send the full array on save).
 */
export type UpdatePresetInput = Partial<CreatePresetInput>;

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** All presets sorted by name. */
export function listPresets(): Promise<Preset[]> {
  return api("/api/presets");
}

export function getPreset(id: string): Promise<Preset> {
  return api(`/api/presets/${encodeURIComponent(id)}`);
}

export function createPreset(input: CreatePresetInput): Promise<Preset> {
  return api("/api/presets", jsonInit("POST", input));
}

export function updatePreset(id: string, patch: UpdatePresetInput): Promise<Preset> {
  return api(`/api/presets/${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
}

export function deletePreset(id: string): Promise<{ ok: boolean }> {
  return api(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Sets a preset's UI-control choices. Only the given control ids change —
 * the route merges them over the preset's raw settings, so other keys and
 * other controls' choices survive. The response echoes the stored map, which
 * callers use as the new local state (never an optimistic guess), plus the
 * full stored `prompts` array. `prompts` is included because the choice is
 * materialized onto the rows it governs: a flip rewrites their `enabled`
 * flags, so a caller that mirrored only `control_values` would leave its cache
 * stale. That matters because Presets.tsx hands its cached row straight to
 * the editor via `setEditing(preset)` — stale rows would render pre-flip
 * switches.
 */
export function putPresetControls(
  id: string,
  values: Record<string, string>,
): Promise<{ control_values: Record<string, string>; prompts: PresetPrompt[] }> {
  return api(`/api/presets/${encodeURIComponent(id)}/controls`, jsonInit("PUT", { values }));
}

/** Where a preset file was read from (mirrors core's PresetImportSource). */
export type PresetImportSource = "suvoj" | "sillytavern";

/** Duplicate-name policy on import (mirrors the server). */
export type PresetImportConflict = "error" | "rename" | "replace";

/** Result of POST /api/import/preset. */
export interface PresetImportResult {
  preset: Preset;
  /** True when `onConflict: "rename"` produced a suffixed name. */
  renamed: boolean;
  /** True when `onConflict: "replace"` overwrote the same-name preset. */
  replaced: boolean;
  source: PresetImportSource;
}

/** Download URL of a preset's native JSON export. */
export function exportPresetUrl(id: string): string {
  return `/api/export/preset/${encodeURIComponent(id)}`;
}

/**
 * Imports a preset file (native Suvoj document or a SillyTavern preset) as
 * JSON text. `onConflict` decides duplicate-name handling: "error" (default)
 * fails with 409, "rename" suffixes, "replace" overwrites in place.
 */
export function importPreset(
  raw: string,
  onConflict?: PresetImportConflict,
): Promise<PresetImportResult> {
  return api("/api/import/preset", jsonInit("POST", { raw, onConflict }));
}
