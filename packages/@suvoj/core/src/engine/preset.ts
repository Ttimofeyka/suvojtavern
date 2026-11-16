/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import type { Preset as StoredPreset } from "../schema/presets";
import { slugify, uniqueSlug } from "../util";

// The shared sampler schema lives in the schema layer so connection
// profiles (schema/profiles) can reuse it; re-exported for engine consumers.
export { type Sampling, samplingSchema } from "../schema/profiles";

/**
 * Native preset format (v2) — the engine-agnostic prompt pipeline.
 *
 * A preset is: a name, a description, the ORDERED `prompts` array (array
 * order IS the layout — there is no separate `order` array) and engine
 * `settings`. Markers occupy slots in the array and render character/chat
 * data at their position; non-marker prompts render their own content at
 * their slot (or, with `injection_position: 1`, inside the chat history at
 * `injection_depth` counted from the end). Presets carry NO sampling —
 * connection profiles own every sampler/model setting.
 */

export const promptRoleSchema = z.enum(["system", "user", "assistant"]);
export type PromptRole = z.infer<typeof promptRoleSchema>;

/**
 * Slot markers. `main` and `jailbreak` render their own prompt content (the
 * system prompt / post-history instructions come from the preset only, never
 * from the character); the rest render lorebook/persona/character/history
 * blocks.
 */
export const promptMarkerSchema = z.enum([
  "main",
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
  "jailbreak",
]);
export type PromptMarker = z.infer<typeof promptMarkerSchema>;

/**
 * Generation types a prompt can be gated to (ST's `injection_trigger`).
 * `quiet` and `impersonate` exist in SillyTavern's set but have no Suvoj
 * equivalent: they are accepted on import and never match, so a prompt gated
 * only to them is simply never sent (see ./prompt).
 */
export type GenerationType = "normal" | "continue" | "regenerate" | "swipe";

/**
 * ST `injection_trigger` values Suvoj knows about. The stored field is a
 * permissive string array, NOT an enum: ST may add trigger values in future
 * versions and a hard enum would reject the entire preset on import. A value
 * absent from this list is carried through and behaves like any other
 * non-matching trigger.
 */
export const KNOWN_INJECTION_TRIGGERS = [
  "normal",
  "continue",
  "impersonate",
  "swipe",
  "regenerate",
  "quiet",
] as const;

/**
 * A mutually-exclusive prompt group. PURE METADATA: the assembler never reads
 * it — `enabled` alone decides what is sent. Editors use it to present one
 * choice per group; export/import round-trip it for free because the exporter
 * embeds `prompts` verbatim.
 */
export const promptGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
});
export type PromptGroup = z.infer<typeof promptGroupSchema>;

/** One prompt block of the preset. */
export const promptSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  role: promptRoleSchema.default("system"),
  content: z.string().default(""),
  enabled: z.boolean().default(true),
  /** Present → this block is a layout marker. */
  marker: promptMarkerSchema.optional(),
  /** 0 = relative (rendered at its array position), 1 = in-chat depth injection. */
  injection_position: z.number().int().min(0).max(1).default(0),
  /** Depth from the end of the chat history (injection_position 1 only). */
  injection_depth: z.number().int().min(0).default(4),
  /** Ordering among injections sharing a depth (higher = closer to the end). */
  injection_order: z.number().int().default(100),
  /**
   * Generation types this prompt applies to (ST `injection_trigger`). An
   * EMPTY array means "every type" — today's behaviour, and ST's own
   * semantics for an unset trigger.
   */
  injection_trigger: z.array(z.string()).default([]),
  /** Optional mutually-exclusive group (editor metadata only; see promptGroupSchema). */
  group: promptGroupSchema.optional(),
});
export type PresetPrompt = z.infer<typeof promptSchema>;

/** Memory strategy wiring (see ./memory). */
export const memorySettingsSchema = z.object({
  /** Registered strategy id (built-ins: `trim`, `summaries`). */
  strategy: z.string().default("trim"),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

/** Engine settings carried by a preset. */
export const presetSettingsSchema = z.looseObject({
  /** World info scan depth in messages (from the end of the history). */
  scan_depth: z.number().int().min(1).default(2),
  /** World info budget in tokens. */
  wi_budget: z.number().int().min(0).default(1024),
  /** System message inserted at the start of the chat history. */
  new_chat_prompt: z.string().default("[Start a new chat]"),
  /** System message inserted before each example dialogue block. */
  new_example_chat_prompt: z.string().default("[Example Chat]"),
  personality_format: z.string().default("{{char}}'s personality: {{personality}}"),
  scenario_format: z.string().default("{{scenario}}"),
  memory: memorySettingsSchema.prefault({}),
});
export type PresetSettings = z.infer<typeof presetSettingsSchema>;

/** The native preset. */
export const presetSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().default(""),
  prompts: z.array(promptSchema).default([]),
  settings: presetSettingsSchema.prefault({}),
});
export type Preset = z.infer<typeof presetSchema>;

/** Parses a repository row (format v2) into a native preset (throws on invalid data). */
export function fromStoredPreset(stored: StoredPreset): Preset {
  return presetSchema.parse({
    id: stored.id,
    name: stored.name,
    description: stored.description,
    prompts: stored.prompts,
    settings: stored.settings,
  });
}

/** Friendly display names for the default marker skeleton. */
const MARKER_NAMES: Record<PromptMarker, string> = {
  main: "Main prompt",
  worldInfoBefore: "Lorebook (before)",
  personaDescription: "Persona description",
  charDescription: "Character description",
  charPersonality: "Character personality",
  scenario: "Scenario",
  worldInfoAfter: "Lorebook (after)",
  dialogueExamples: "Example dialogues",
  chatHistory: "Chat history",
  jailbreak: "Post-history instructions",
};

/** Minimal sane built-in preset (used when the DB holds none). */
export function defaultPreset(): Preset {
  const markers: PromptMarker[] = [
    "main",
    "worldInfoBefore",
    "personaDescription",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
    "chatHistory",
    "jailbreak",
  ];
  return presetSchema.parse({
    name: "Default",
    description: "",
    prompts: markers.map((marker) => ({
      id: marker,
      name: MARKER_NAMES[marker],
      role: "system",
      marker,
    })),
    settings: {},
  });
}

// --- SillyTavern preset conversion -------------------------------------------

interface StPrompt {
  identifier?: unknown;
  name?: unknown;
  role?: unknown;
  content?: unknown;
  marker?: unknown;
  system_prompt?: unknown;
  injection_position?: unknown;
  injection_depth?: unknown;
  injection_order?: unknown;
  injection_trigger?: unknown;
  enabled?: unknown;
}

interface StOrderEntry {
  identifier?: unknown;
  enabled?: unknown;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * ST `injection_trigger` → string array. Absent, non-array, or containing
 * non-strings is coerced to `[]` (the permissive "all types" default) rather
 * than throwing; unknown trigger VALUES are kept verbatim so a future ST
 * value round-trips instead of breaking the import.
 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asRole(value: unknown): PromptRole {
  return value === "user" || value === "assistant" ? value : "system";
}

/**
 * Converts a SillyTavern chat-completion preset (the `START_PRESET.json`
 * shape) into the native v2 format — used by the seeder only (the UI has
 * no ST import). ST's `main` / `jailbreak` prompts become native markers
 * carrying ST's content (the only content source at runtime). The output
 * `prompts` array follows ST's `prompt_order[0].order` sequence; ST prompts
 * missing from the order are appended at the end with `enabled: false`
 * (visible-but-off). Marker identifiers stay verbatim; every other id is a
 * readable slug derived from the prompt's name, unique per preset. Each
 * prompt's ST `injection_trigger` is carried through verbatim (see
 * `promptSchema.injection_trigger`). No sampling is carried — connection
 * profiles own samplers.
 */
export function convertStPreset(raw: unknown): Preset {
  const source = (raw ?? {}) as Record<string, unknown>;
  const stPrompts = Array.isArray(source.prompts) ? (source.prompts as StPrompt[]) : [];
  const promptOrder = Array.isArray(source.prompt_order) ? (source.prompt_order as unknown[]) : [];
  const firstOrder = (promptOrder[0] ?? {}) as { order?: unknown };
  const orderEntries = Array.isArray(firstOrder.order) ? (firstOrder.order as StOrderEntry[]) : [];
  const enabledById = new Map<string, boolean>();
  for (const entry of orderEntries) {
    const identifier = asString(entry.identifier);
    if (identifier !== "") {
      enabledById.set(identifier, asBoolean(entry.enabled, true));
    }
  }
  const markerIds = new Set<string>(promptMarkerSchema.options);

  // Slug pool: marker identifiers are reserved so slugs never shadow them.
  const taken = new Set<string>(markerIds);

  const byIdentifier = new Map<string, PresetPrompt>();
  for (const st of stPrompts) {
    const identifier = asString(st.identifier);
    if (identifier === "" || byIdentifier.has(identifier)) {
      continue;
    }
    const isMarker =
      markerIds.has(identifier) &&
      (asBoolean(st.marker, false) || identifier === "main" || identifier === "jailbreak");
    const id = isMarker ? identifier : uniqueSlug(slugify(asString(st.name, identifier)), taken);
    byIdentifier.set(identifier, {
      id,
      name: asString(st.name, identifier),
      role: asRole(st.role),
      // Markers keep ST's content — the preset is the only runtime source.
      content: asString(st.content),
      enabled: enabledById.get(identifier) ?? asBoolean(st.enabled, false),
      marker: isMarker ? (identifier as PromptMarker) : undefined,
      injection_position: asNumber(st.injection_position, 0) === 1 ? 1 : 0,
      injection_depth: Math.max(0, Math.floor(asNumber(st.injection_depth, 4))),
      injection_order: Math.floor(asNumber(st.injection_order, 100)),
      // Absent/malformed → [] ("all types"); unknown strings survive.
      injection_trigger: asStringArray(st.injection_trigger),
    });
  }

  // The array IS the layout: ordered entries first (in the order's
  // sequence), then leftovers appended visible-but-off.
  const prompts: PresetPrompt[] = [];
  const placed = new Set<string>();
  for (const entry of orderEntries) {
    const identifier = asString(entry.identifier);
    const prompt = identifier === "" ? undefined : byIdentifier.get(identifier);
    if (!prompt || placed.has(identifier)) {
      continue;
    }
    placed.add(identifier);
    prompts.push(prompt);
  }
  for (const [identifier, prompt] of byIdentifier) {
    if (!placed.has(identifier)) {
      prompts.push({ ...prompt, enabled: false });
    }
  }

  const settings: Record<string, unknown> = {};
  if (typeof source.new_chat_prompt === "string") {
    settings.new_chat_prompt = source.new_chat_prompt;
  }
  if (typeof source.new_example_chat_prompt === "string") {
    settings.new_example_chat_prompt = source.new_example_chat_prompt;
  }
  if (typeof source.personality_format === "string") {
    settings.personality_format = source.personality_format;
  }
  if (typeof source.scenario_format === "string") {
    settings.scenario_format = source.scenario_format;
  }

  return presetSchema.parse({
    name: asString(source.name, "Imported ST preset"),
    description: "",
    prompts,
    settings,
  });
}
