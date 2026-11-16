/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginControl, PluginControlOption } from "./api-plugins";
import { type PresetControl, resolveChoices } from "./preset-controls";

/**
 * Plugin UI controls — the client mirror of the server's `PluginHost`
 * resolution (packages/server/src/plugins/host.ts, `resolvedControls` /
 * `resolvedControlText`), which is the source of truth. Unlike a preset
 * control, a plugin control is a pure app-level value: it never switches
 * prompt rows and carries no `prompts` field, so there are no flags to
 * apply — only a chosen option id to resolve and a switch/select to render.
 *
 * The resolution chain is byte-for-byte the preset chain — stored option →
 * control `default` → first option — so {@link resolvePluginChoices} shares
 * core's preset helper rather than re-deriving it. A garbage stored value
 * never throws; the declaration is the authority.
 *
 * Everything here is pure, so the panel keeps no control semantics inline.
 */

/** Plain-object guard (the stored map is arbitrary JSON read back from a row). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The label a control's option shows — never blank: an empty label falls
 * back to the id. Mirrors the preset surface's `optionLabel`.
 *
 * The SDK marks `label` required, but the server's loader accepts an omitted
 * one (showing the id) and serves the raw declaration, so a JS plugin can
 * still deliver `undefined` here — the read is defensive for that case.
 */
export function pluginOptionLabel(option: PluginControlOption): string {
  const label = typeof option.label === "string" ? option.label.trim() : "";
  return label === "" ? option.id : label;
}

/** The label a control shows — never blank: an empty label falls back to the id. */
export function pluginControlLabel(control: PluginControl): string {
  const label = typeof control.label === "string" ? control.label.trim() : "";
  return label === "" ? control.id : label;
}

/**
 * What `{{ui:plugin:<pluginId>:<controlId>}}` expands to for one chosen
 * option: its `value`, else its raw `label`, else its id. Deliberately the
 * RAW label (not the trimmed display one), matching core's
 * `choiceMacroValues` and the server's `resolvedControlText` exactly — the
 * macro text is what generation inserts, so it must not drift.
 */
function optionMacroText(option: PluginControlOption): string {
  const value = option.value ?? "";
  if (value !== "") {
    return value;
  }
  // Same defensive read as the label helper: the loader tolerates an omitted
  // label on a JS-authored declaration, so treat it as "" rather than
  // letting `undefined` leak into the resolved map.
  const label = typeof option.label === "string" ? option.label : "";
  return label !== "" ? label : option.id;
}

/**
 * Control id → chosen OPTION id, exactly as the server resolves it: the
 * stored value when it names a real option; else the control's `default`
 * when it names one; else the first option. Tolerant of a missing or
 * malformed stored map. `{}` for no controls.
 *
 * Shares `resolveChoices` with the preset surface — the rule is identical
 * (the server's `PluginHost` calls core's `chosenOption`, the same chain).
 * That helper only reads `id`/`options`/`default`/`option.id`, which every
 * plugin control has; the cast is a type-level formality because plugin
 * options carry no `prompts`.
 */
export function resolvePluginChoices(
  controls: readonly PluginControl[],
  stored: unknown,
): Record<string, string> {
  return resolveChoices(controls as readonly PresetControl[], stored);
}

/** The presentation data one plugin control needs to render. */
export interface PluginControlDisplay {
  /** The declaration being rendered (options, type, description). */
  control: PluginControl;
  /** The row label — never blank (falls back to the control id). */
  label: string;
  /** The resolved chosen option id (stored → `default` → first). */
  value: string;
  /** The chosen option's never-blank label, for the switcher / toggle caption. */
  chosenLabel: string;
  /** What `{{ui:…}}` renders for the choice (value → label → id). */
  macroText: string;
  /** True when the control renders as a switch (`toggle`). */
  toggle: boolean;
  /** A toggle's "on" option (its first), for the switch bindings. */
  on: PluginControlOption | undefined;
  /** A toggle's "off" option (its second); the switch is unchecked for it. */
  off: PluginControlOption | undefined;
}

/**
 * Resolves ONE control to its display data against a (pre-resolved) choice
 * map. Pair it with a stable `For each` over the declarations and a reactive
 * choices map — the way the preset card renders — so a single control's write
 * does not remount every sibling row.
 */
export function pluginControlDisplay(
  control: PluginControl,
  choices: Readonly<Record<string, string>>,
): PluginControlDisplay {
  const value = choices[control.id] ?? "";
  const chosen = control.options.find((option) => option.id === value);
  return {
    control,
    label: pluginControlLabel(control),
    value,
    // A control with no renderable options resolves to "" — show the id
    // rather than a blank caption, mirroring the preset card's fallback.
    chosenLabel: chosen ? pluginOptionLabel(chosen) : value,
    macroText: chosen ? optionMacroText(chosen) : "",
    toggle: control.type === "toggle",
    on: control.options[0],
    off: control.options[1],
  };
}

/**
 * Resolves every declared control to the display data the card renders.
 * Convenience over {@link pluginControlDisplay} for callers that want the
 * whole list at once.
 */
export function pluginControlState(
  controls: readonly PluginControl[],
  stored: unknown,
): PluginControlDisplay[] {
  const choices = resolvePluginChoices(controls, stored);
  return controls.map((control) => pluginControlDisplay(control, choices));
}

/**
 * The stored control map a card should render from, tolerant of the
 * server's `null` (a plugin with no controls) and of a non-object readback.
 * The server's `controlValues` is already resolved, so this is only about
 * shape, never about applying fallbacks.
 */
export function storedControlValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}
