/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `injection_trigger` handling for the preset editor. The stored field is a
 * permissive `string[]` (core's `promptSchema`): an EMPTY array means "every
 * generation type", a non-empty one gates the prompt to those types. The
 * engine matches with `includes`, so extra/unknown values are harmless but
 * must survive an edit here — an imported SillyTavern preset can carry
 * `impersonate` / `quiet` (never match in Suvoj) or a value a future ST adds.
 */

/** One selectable generation type: its stored value and its display text. */
export interface TriggerOption {
  id: string;
  label: string;
}

/**
 * The generation types this editor offers. Suvoj sends exactly one per run
 * (`normal` / `continue` / `regenerate`), so these are the values a checkbox
 * can meaningfully gate on. ST's `impersonate` / `quiet` are deliberately
 * absent: they never match a Suvoj run, so offering them would only create
 * prompts that are silently never sent (they are still preserved verbatim —
 * see `unknownTriggers`).
 */
export const TRIGGER_OPTIONS: readonly TriggerOption[] = [
  { id: "normal", label: "Normal" },
  { id: "continue", label: "Continue" },
  { id: "regenerate", label: "Regenerate" },
  { id: "swipe", label: "Swipe" },
];

/** The trigger values the checkboxes represent. */
const KNOWN_TRIGGER_IDS: ReadonlySet<string> = new Set(TRIGGER_OPTIONS.map((o) => o.id));

/** Normalizes a possibly-absent trigger list to a real array. */
function asTriggers(trigger: readonly string[] | undefined): readonly string[] {
  return trigger ?? [];
}

/** True when the list is empty — the engine's "applies to every type". */
export function triggersAllTypes(trigger: readonly string[] | undefined): boolean {
  return asTriggers(trigger).length === 0;
}

/**
 * The row's trigger values the checkbox set does not represent — imported ST
 * values like `impersonate` / `quiet`, or an unknown future trigger. Shown so
 * they are never silently dropped, and never silently kept either: the user
 * can remove each one explicitly. Order and duplicates are preserved.
 */
export function unknownTriggers(trigger: readonly string[] | undefined): string[] {
  return asTriggers(trigger).filter((value) => !KNOWN_TRIGGER_IDS.has(value));
}

/**
 * Adds or removes ONE trigger value, returning a new array. Any other value —
 * known or unknown — is preserved in its original relative order, so toggling
 * a checkbox never discards an imported `impersonate` or an unknown string.
 * `on` is explicit (not a toggle) so the caller passes the checkbox state.
 */
export function setTrigger(
  trigger: readonly string[] | undefined,
  value: string,
  on: boolean,
): string[] {
  const current = asTriggers(trigger);
  if (on) {
    return current.includes(value) ? [...current] : [...current, value];
  }
  return current.filter((item) => item !== value);
}
