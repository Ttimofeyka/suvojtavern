/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ControlOption, PresetControl, PresetPrompt } from "./api-presets";

/**
 * Preset UI controls — the client mirror of core's `engine/controls.ts`,
 * which is the source of truth for every rule here. The web package does not
 * depend on `@suvoj/core`, so the semantics are copied rather than imported,
 * exactly as `lib/preset-groups.ts` mirrors core's group semantics.
 *
 * A control is a switcher between mutually exclusive options (Point of
 * View = 1st / 2nd / 3rd / Hybrid, or a simple on/off flag). It is declared
 * on the preset's `settings` JSON:
 *
 * - `controls` — the declarations (`PresetControl[]`)
 * - `control_values` — the chosen option id per control id
 *
 * At generation time the engine resolves the effective choice as "stored
 * value → control default → first option", switches the chosen option's
 * prompt rows on (and every sibling option's rows off), and expands
 * `{{ui:<controlId>}}` from that same resolution.
 *
 * Everything here is pure and TOLERANT: a hand-edited, imported or older
 * preset must never break the UI, so malformed entries are dropped rather
 * than rejected. The editor validates ids separately through
 * {@link controlIdProblem}. The engine remains the authority on generation —
 * these helpers only read/write the settings blob and the editor draft.
 */

// The shapes live on the API surface (api-presets.ts) with the rest of the
// preset row types; re-exported here so consumers of the control semantics
// get the types from one import, mirroring how core exports them together.
export type { ControlOption, PresetControl, PresetControlType } from "./api-presets";

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
 * untouched row). Same wording as core so the error never drifts from the
 * rule the engine enforces.
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
 * A required non-empty string field (zod's `z.string().min(1)`): a `string`
 * on success, `undefined` when the stored value fails the rule.
 */
function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A string field with a `""` default (zod's `.default("")`): `undefined` when
 * the stored value is neither a string nor absent. Reading `undefined` into
 * `""` matches zod, which applies the default only for `undefined` input.
 */
function defaultedString(value: unknown): string | undefined {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * Tolerant parse of one stored option, mirroring core's
 * `controlOptionSchema.safeParse`. Unknown keys are dropped (zod strips
 * them); a field of the wrong type fails the whole entry. `null` = malformed.
 */
function parseOption(value: unknown): ControlOption | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = requiredString(value.id);
  const label = defaultedString(value.label);
  const optionValue = defaultedString(value.value);
  if (id === undefined || label === undefined || optionValue === undefined) {
    return null;
  }
  const rawPrompts = value.prompts === undefined ? [] : value.prompts;
  if (!Array.isArray(rawPrompts) || !rawPrompts.every((item) => typeof item === "string")) {
    return null;
  }
  return { id, label, value: optionValue, prompts: [...rawPrompts] };
}

/**
 * Tolerant parse of one stored control, mirroring core's
 * `presetControlSchema.safeParse`. `null` = malformed.
 */
function parseControl(value: unknown): PresetControl | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = requiredString(value.id);
  const label = defaultedString(value.label);
  const description = defaultedString(value.description);
  if (id === undefined || label === undefined || description === undefined) {
    return null;
  }
  const rawType = value.type === undefined ? "select" : value.type;
  if (rawType !== "select" && rawType !== "toggle") {
    return null;
  }
  const rawOptions = value.options === undefined ? [] : value.options;
  if (!Array.isArray(rawOptions)) {
    return null;
  }
  const options: ControlOption[] = [];
  for (const entry of rawOptions) {
    const option = parseOption(entry);
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  const fallback = defaultedString(value.default);
  if (fallback === undefined) {
    return null;
  }
  return { id, label, description, type: rawType, options, default: fallback };
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
    const control = parseControl(entry);
    if (control === null) {
      continue;
    }
    // First declaration of an id wins; a later duplicate is ignored — and it
    // still reserves the id, exactly like core's `seenIds.add` placement.
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
 * The choices actually stored on a preset's settings (tolerant). Raw, not
 * resolved: the editor must carry the stored map through a save untouched,
 * and resolution is a separate step ({@link resolveChoices}). Non-string
 * entries are ignored — the engine only ever reads string choices.
 */
export function settingsControlValues(settings: unknown): Record<string, string> {
  if (!isRecord(settings) || !isRecord(settings.control_values)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.control_values)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
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
 * controls), so a card never has to guess a missing choice.
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

/**
 * Returns a NEW `prompts` array with the controls' effective `enabled`
 * flags. For each control the chosen option's prompt ids become enabled and
 * every other option's ids become disabled; ids naming no prompt row are
 * ignored. Controls are applied in order and LATER CONTROLS WIN: a row named
 * by two controls keeps the last one's flag (within one control the chosen
 * option is applied last, so it beats a sibling sharing a row). Rows no
 * option names are returned by reference, so a caller can detect untouched
 * entries by identity.
 *
 * The UI never applies this to the stored preset — the engine does that at
 * generation time. It exists to mirror the semantics and to keep the editor's
 * preview/round-trip logic honest.
 */
export function applyChoices(
  prompts: readonly PresetPrompt[],
  controls: readonly PresetControl[],
  choices: Readonly<Record<string, string>>,
): PresetPrompt[] {
  if (controls.length === 0) {
    return [...prompts];
  }
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
  return prompts.map((prompt) => {
    const enabled = overrides.get(prompt.id);
    return enabled === undefined ? prompt : { ...prompt, enabled };
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

/**
 * Prompt id → the id of the control that switches it, for the editor's row
 * badges. Mirrors `applyChoices`' precedence: controls are walked in order
 * and a row named by two of them is governed by the LATER one. Within a
 * control, ANY option naming the row governs it — the flag it ends up with
 * depends on which option is chosen, but the row is still that control's.
 *
 * Ids that match no prompt row are recorded too; the badge simply has no row
 * to render on, and keeping them lets the editor surface a typo instead of
 * quietly hiding it.
 */
export function governedPromptIds(controls: readonly PresetControl[]): Map<string, string> {
  const governed = new Map<string, string>();
  for (const control of controls) {
    for (const option of control.options) {
      for (const promptId of option.prompts) {
        governed.set(promptId, control.id);
      }
    }
  }
  return governed;
}

/**
 * The `settings` object a save should end up with: `control_values` merged
 * over the existing object with EVERY other key preserved. The client-side
 * twin of the `PUT /api/presets/:id/controls` route's merge — a malformed or
 * missing `control_values` is replaced outright, anything else survives.
 */
export function withControlValues(
  settings: unknown,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const base = isRecord(settings) ? settings : {};
  const existing = isRecord(base.control_values) ? base.control_values : {};
  return { ...base, control_values: { ...existing, ...values } };
}
