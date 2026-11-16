/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import type { PresetPrompt } from "./preset";

/**
 * Preset UI controls — a switcher between mutually exclusive options (Point
 * of View = 1st/2nd/3rd/Hybrid, or a simple on/off flag). The chosen option
 * turns a subset of the preset's prompt rows on and off at generation time,
 * and prompt text reads the current choice through `{{ui:<controlId>}}`.
 *
 * Storage lives in the preset's `settings` JSON — declared as a loose object
 * by `presetSettingsSchema` — under exactly two keys:
 *
 * - `controls` — the control definitions (`PresetControl[]`)
 * - `control_values` — the chosen option id per control id
 *
 * Because the schema is loose, both keys survive CRUD, PATCH, export and
 * import untouched: no migration and no preset-format change.
 *
 * Everything here is pure and TOLERANT. A hand-edited, imported or older
 * preset must never make generation throw, so malformed entries are dropped
 * rather than rejected; the editor validates ids separately through
 * {@link controlIdProblem}.
 */

export const controlOptionSchema = z.object({
  id: z.string().min(1),
  /** Shown in the switcher. Empty → the id. */
  label: z.string().default(""),
  /** Text {{ui:<control>}} expands to while this option is chosen. Empty → the label, else the id. */
  value: z.string().default(""),
  /** Prompt rows switched ON (and siblings switched OFF) while this option is chosen. */
  prompts: z.array(z.string()).default([]),
});
export type ControlOption = z.infer<typeof controlOptionSchema>;

export const presetControlSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  description: z.string().default(""),
  /** "select" renders a dropdown, "toggle" a switch. A toggle carries exactly 2 options: [on, off]. */
  type: z.enum(["select", "toggle"]).default("select"),
  options: z.array(controlOptionSchema).default([]),
  /** Option id used when the preset stores no choice. Empty → the first option. */
  default: z.string().default(""),
});
export type PresetControl = z.infer<typeof presetControlSchema>;

/** A control's rendered form: a dropdown or a two-position switch. */
export type PresetControlType = z.infer<typeof presetControlSchema>["type"];

/**
 * Control ids are readable slugs. Plugin-contributed ids (`plugin:<id>:<id>`,
 * phase 3) intentionally fall outside this pattern — they are addressed
 * verbatim and never authored through the preset editor's id field.
 */
export const CONTROL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Editor validation for a new/renamed control id: a human-readable reason,
 * or `null` when the id is usable. `taken` holds the other control ids in
 * the preset being edited (the id itself may appear when re-validating an
 * untouched row).
 */
export function controlIdProblem(id: string, taken: ReadonlySet<string>): string | null {
  if (id === "") {
    return "Enter an id.";
  }
  if (!CONTROL_ID_PATTERN.test(id)) {
    return "Use lowercase letters, digits and hyphens, starting with a letter or digit.";
  }
  if (taken.has(id)) {
    return `The id "${id}" is already used by another control.`;
  }
  return null;
}

/** Plain-object guard (settings is arbitrary JSON parsed from storage). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant parse of a preset's `settings.controls`. Entries failing the
 * schema are skipped (never thrown), ids dedupe first-wins, and a control is
 * dropped when it cannot be rendered: fewer than two options, or a duplicate
 * option id (option ids ARE the stored choice values). A dangling `default`
 * naming no option falls back to "", i.e. to the first option. A toggle is
 * strictly binary, so extra options beyond the first two are ignored.
 */
export function parseControls(value: unknown): PresetControl[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PresetControl[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const parsed = presetControlSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const control = parsed.data;
    // First declaration of an id wins; a later duplicate is ignored.
    if (seenIds.has(control.id)) {
      continue;
    }
    seenIds.add(control.id);

    const options = control.type === "toggle" ? control.options.slice(0, 2) : control.options;
    const optionIds = new Set(options.map((option) => option.id));
    if (options.length < 2 || optionIds.size !== options.length) {
      continue;
    }
    // A dangling `default` (renamed/removed option) would name a choice that
    // cannot be resolved, so it collapses to "" (first option) instead.
    const fallback = optionIds.has(control.default) ? control.default : "";
    out.push({ ...control, options, default: fallback });
  }
  return out;
}

/** The control definitions carried by a preset's settings (tolerant). */
export function settingsControls(settings: unknown): PresetControl[] {
  return isRecord(settings) ? parseControls(settings.controls) : [];
}

/**
 * The option a control resolves to for a given choice map: the named option
 * when there is one, else `default` when it names an option, else the first.
 * Shared by {@link resolveChoices} and {@link applyChoices} so both tolerate
 * a missing/garbage choice the same way (`undefined` only when the control
 * has no options at all — impossible after parseControls).
 */
function chosenOption(
  control: PresetControl,
  choices: Readonly<Record<string, unknown>>,
): ControlOption | undefined {
  const candidate = choices[control.id];
  const named =
    typeof candidate === "string"
      ? control.options.find((option) => option.id === candidate)
      : undefined;
  if (named) {
    return named;
  }
  const fallback = control.options.find((option) => option.id === control.default);
  return fallback ?? control.options[0];
}

/**
 * Control id → chosen option id. The stored value wins when it names a real
 * option of that control; else the control's `default` when it names one;
 * else the first option. Always returns one entry per control (`{}` for no
 * controls), so generation never has to guess a missing choice.
 */
export function resolveChoices(
  controls: readonly PresetControl[],
  stored: unknown,
): Record<string, string> {
  const values = isRecord(stored) ? stored : {};
  const choices: Record<string, string> = {};
  for (const control of controls) {
    const option = chosenOption(control, values);
    if (option) {
      choices[control.id] = option.id;
    }
  }
  return choices;
}

/** The user's stored choices for a preset's settings (tolerant). */
export function settingsChoices(settings: unknown): Record<string, string> {
  if (!isRecord(settings)) {
    return {};
  }
  return resolveChoices(parseControls(settings.controls), settings.control_values);
}

/**
 * The `enabled` values a set of controls dictates: prompt id → forced flag.
 * The ONE place the switch semantics live — {@link applyChoices} and
 * {@link applyChoicesToRows} both map rows through this map, so the engine's
 * effective pipeline and a stored row can never be governed differently.
 *
 * For each control the chosen option's ids are set to `true` and every
 * sibling option's ids to `false` (siblings first, chosen last, so the chosen
 * option wins when two options of one control name a shared row). Controls
 * are walked in order and LATER CONTROLS WIN: a row named by two controls
 * keeps the last one's flag.
 */
function controlOverrides(
  controls: readonly PresetControl[],
  choices: Readonly<Record<string, string>>,
): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  for (const control of controls) {
    // Resolution mirrors `resolveChoices`, so a garbage/absent stored choice
    // still applies the option the engine would actually render.
    const selected = chosenOption(control, choices);
    // Siblings off first, then the chosen option on — the chosen option wins
    // when two options of the same control name a shared row.
    for (const option of control.options) {
      if (option === selected) {
        continue;
      }
      for (const promptId of option.prompts) {
        overrides.set(promptId, false);
      }
    }
    for (const promptId of selected?.prompts ?? []) {
      overrides.set(promptId, true);
    }
  }
  return overrides;
}

/**
 * Returns a NEW `prompts` array with the controls' effective `enabled`
 * flags. For each control the chosen option's prompt ids become enabled and
 * every other option's ids become disabled; ids naming no prompt row are
 * ignored. Rows no option names are returned by reference, so an editor can
 * detect untouched entries by identity.
 *
 * The overrides come from {@link controlOverrides}, shared with
 * {@link applyChoicesToRows}.
 */
export function applyChoices(
  prompts: readonly PresetPrompt[],
  controls: readonly PresetControl[],
  choices: Readonly<Record<string, string>>,
): PresetPrompt[] {
  if (controls.length === 0) {
    return [...prompts];
  }
  const overrides = controlOverrides(controls, choices);
  return prompts.map((prompt) => {
    const enabled = overrides.get(prompt.id);
    return enabled === undefined ? prompt : { ...prompt, enabled };
  });
}

/**
 * Row-oriented twin of {@link applyChoices} for STORED prompt rows — the
 * loose `Record<string, unknown>[]` `presetInputSchema.prompts` carries.
 *
 * Why a sibling instead of reusing `applyChoices`: a stored row is
 * hand-editable JSON, so it may hold an `id` of any type or lack fields the
 * `PresetPrompt` schema requires, and `fromStoredPreset` would THROW on such
 * a row. A repository must never let a hand-edited file break a write, so
 * this variant parses nothing: it only ever writes the `enabled` key, treats
 * a non-string `id` as unmatchable (returned by reference), applies the SAME
 * {@link controlOverrides} map, and returns rows no option names by
 * reference (mirroring `applyChoices`, so identity-diffing callers can tell
 * which rows were touched).
 */
export function applyChoicesToRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  controls: readonly PresetControl[],
  choices: Readonly<Record<string, string>>,
): T[] {
  if (controls.length === 0) {
    return [...rows];
  }
  const overrides = controlOverrides(controls, choices);
  return rows.map((row) => {
    // A stored row is arbitrary JSON: a primitive/null entry cannot be named
    // by an option, so it is passed through rather than throwing (the column
    // is never object-checked on read, so this is a real shape).
    if (typeof row !== "object" || row === null) {
      return row;
    }
    const id = (row as Record<string, unknown>).id;
    // A stored row's `id` is arbitrary JSON: anything but a string can never
    // be named by an option, so it is never matched (and never thrown on).
    if (typeof id !== "string") {
      return row;
    }
    const enabled = overrides.get(id);
    return enabled === undefined ? row : { ...row, enabled };
  });
}

/**
 * What `{{ui:<controlId>}}` expands to for the current choices: the chosen
 * option's `value`, else its `label`, else its id — so a control is readable
 * in prompt text even when the author filled in nothing but the ids.
 */
export function choiceMacroValues(
  controls: readonly PresetControl[],
  choices: Readonly<Record<string, string>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const control of controls) {
    // Same resolution as the flags: an unresolved/stale value falls back to
    // the option generation actually used, so text and rows never disagree.
    const chosen = chosenOption(control, choices);
    if (!chosen) {
      continue;
    }
    if (chosen.value !== "") {
      values[control.id] = chosen.value;
    } else if (chosen.label !== "") {
      values[control.id] = chosen.label;
    } else {
      values[control.id] = chosen.id;
    }
  }
  return values;
}
