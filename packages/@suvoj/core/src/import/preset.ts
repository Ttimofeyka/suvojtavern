/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  convertStPreset,
  type Preset as NativePreset,
  presetSchema,
  promptMarkerSchema,
} from "../engine/preset";
import type { PresetsRepository } from "../repositories/presets";
import type { Preset } from "../schema/presets";
import { slugify, uniqueSlug } from "../util";

/**
 * Preset import: a native Suvoj document (see ../export/preset) OR a
 * SillyTavern chat-completion preset (the `START_PRESET.json` shape).
 *
 * The native path normalizes through the engine's `presetSchema` — so stored
 * rows and downloaded files share one validated shape — and heals ids that are
 * missing or invalid (a slug derived from the prompt name, unique against the
 * layout markers). The ST path delegates to the engine's `convertStPreset`;
 * this module never re-detects or re-maps ST's fields itself.
 */

/** Which shape a preset file was read as. */
export type PresetImportSource = "suvoj" | "sillytavern";

export interface ParsedPresetFile {
  /** Normalized native document (defaults filled, ids healed). */
  preset: NativePreset;
  source: PresetImportSource;
}

/** True when `raw` is a plain (non-array, non-null) object. */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * ST detection. A `prompt_order` array is the smoking gun; otherwise an ST
 * preset is identified by a `prompts` entry carrying a string `identifier`
 * with no string `id` (native prompts always have `id`, never `identifier`).
 */
function looksLikeStPreset(obj: Record<string, unknown>): boolean {
  if (Array.isArray(obj.prompt_order)) {
    return true;
  }
  if (!Array.isArray(obj.prompts)) {
    return false;
  }
  return obj.prompts.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return typeof entry.identifier === "string" && typeof entry.id !== "string";
  });
}

/**
 * Normalizes a native document through the engine schema, filling every
 * default and healing prompt ids. The taken set is pre-seeded with the layout
 * markers (so a name-derived slug can never shadow a marker) and with every
 * explicit id in the document (so a healed slug can never collide with an id
 * that appears later in the array).
 */
function normalizeNativePreset(obj: Record<string, unknown>): NativePreset {
  const rawPrompts = Array.isArray(obj.prompts) ? obj.prompts : [];
  const prompts = rawPrompts.map((entry) => (isRecord(entry) ? entry : {}));
  const isUsableId = (value: unknown): value is string => typeof value === "string" && value !== "";

  const taken = new Set<string>(promptMarkerSchema.options);
  for (const prompt of prompts) {
    if (isUsableId(prompt.id)) {
      taken.add(prompt.id);
    }
  }
  const healed = prompts.map((prompt) => {
    if (isUsableId(prompt.id)) {
      return prompt;
    }
    const name = typeof prompt.name === "string" ? prompt.name : "";
    return { ...prompt, id: uniqueSlug(slugify(name, "prompt"), taken) };
  });
  // `presetSchema` strips unknown keys (format/version/id) and throws when the
  // document is not a usable native preset (e.g. no name) — the server maps
  // that to a 400.
  return presetSchema.parse({ ...obj, prompts: healed });
}

/** Parses a preset file: a native Suvoj document, or a SillyTavern chat-completion preset. */
export function parsePresetFile(raw: unknown): ParsedPresetFile {
  if (!isRecord(raw)) {
    throw new Error("not a preset file");
  }
  if (looksLikeStPreset(raw)) {
    return { preset: convertStPreset(raw), source: "sillytavern" };
  }
  return { preset: normalizeNativePreset(raw), source: "suvoj" };
}

/** Duplicate-name policy on import. */
export type PresetImportConflict = "error" | "rename" | "replace";

export interface PresetImportOptions {
  onConflict?: PresetImportConflict; // default "error"
  /** Overrides the document's own name. */
  name?: string;
}

export interface PresetImportResult {
  preset: Preset; // the repository row (schema/presets.ts Preset)
  renamed: boolean; // true when a numeric suffix was applied
  replaced: boolean; // true when an existing row was overwritten
  source: PresetImportSource;
}

/** Thrown when onConflict is "error" and a same-name preset exists. The server maps this to HTTP 409. */
export class PresetConflictError extends Error {}

/** "Name 2", "Name 3", … — the first suffix whose lowercase form is free. */
function uniqueName(name: string, takenLower: ReadonlySet<string>): string {
  let candidate = name;
  for (let suffix = 2; takenLower.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${name} ${suffix}`;
  }
  return candidate;
}

/** Imports a preset document into the repository under the conflict policy. */
export function importPreset(
  raw: unknown,
  presets: PresetsRepository,
  opts: PresetImportOptions = {},
): PresetImportResult {
  const { preset, source } = parsePresetFile(raw);
  // The parsed name is guaranteed non-empty: native requires min(1) and
  // convertStPreset falls back to "Imported ST preset".
  const name = opts.name?.trim() || preset.name;
  const existing = presets.list().find((row) => row.name.toLowerCase() === name.toLowerCase());
  const payload = {
    name,
    description: preset.description,
    prompts: preset.prompts,
    settings: preset.settings,
  };

  if (existing) {
    const onConflict = opts.onConflict ?? "error";
    if (onConflict === "error") {
      throw new PresetConflictError(`a preset named "${name}" already exists`);
    }
    if (onConflict === "replace") {
      const updated = presets.update(existing.id, payload);
      if (!updated) {
        // Only possible if the row vanished between list and update.
        throw new Error(`preset "${name}" disappeared during import`);
      }
      return { preset: updated, renamed: false, replaced: true, source };
    }
    // "rename" — and any unrecognized value — gets a fresh suffixed name.
    const renamed = uniqueName(name, new Set(presets.list().map((row) => row.name.toLowerCase())));
    const created = presets.create({ ...payload, name: renamed });
    return { preset: created, renamed: true, replaced: false, source };
  }

  const created = presets.create(payload);
  return { preset: created, renamed: false, replaced: false, source };
}
