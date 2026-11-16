/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/**
 * Plugin management API — typed wrappers for the server's /api/plugins routes.
 * Shapes mirror the server's PublicPlugin (packages/server/src/plugins/host.ts)
 * and the SDK's SettingField/SidebarItem (packages/@suvoj/plugin-sdk).
 */

/** A sidebar link a plugin contributes while enabled (icon is a Lucide NAME string). */
export interface PluginSidebarItem {
  label: string;
  href: string;
  icon?: string;
}

/** A chat-drawer tab a plugin contributes while enabled (icon is a Lucide
 *  NAME string; metadata only — the declared template/css ship via the
 *  panel-data route, GET /api/plugins/:id/tabs/:tabId/data). */
export interface PluginDrawerTab {
  id: string;
  label: string;
  icon?: string;
}

/** One plugin-contributed theme as GET /api/plugins reports it. */
export interface PluginThemeInfo {
  id: string;
  name: string;
  kind: "dark" | "light";
  vars: Record<string, string>;
}

/**
 * One schema field of a plugin's settings form. The `type` discriminator
 * drives the control the panel renders (switch / input / number / select /
 * textarea / multiselect). The server validates every value against `type`
 * on write and rejects an unrecognized `type` at plugin load, so the union
 * here is exhaustive.
 */
export interface SettingField {
  key: string;
  label: string;
  type: "boolean" | "string" | "number" | "select" | "textarea" | "multiselect";
  /**
   * Value used when the user never touched the setting. A `string[]` only for
   * `multiselect`; the other types keep their single-value default.
   */
  default: boolean | string | number | string[];
  hint?: string;
  placeholder?: string;
  /**
   * Selectable values — required for `select`/`multiselect` (a `multiselect`
   * holds an array of these `value`s). `value` may be a number, but only
   * string values can occupy a `multiselect`'s `string[]` slot.
   */
  options?: Array<{ label: string; value: string | number }>;
  /** Number bounds (applied when `type` is `"number"`). */
  min?: number;
  max?: number;
}

/** A control's rendered form: a dropdown or a two-position switch. */
export type PluginControlType = "select" | "toggle";

/**
 * One option of a plugin control. Mirrors the SDK's `PluginControlOption`
 * minus the `prompts` half: a plugin never owns preset prompt rows, so an
 * option is purely a value — unlike a preset option there is nothing to
 * switch on or off.
 */
export interface PluginControlOption {
  /** Stable option id — the value stored and written back through the API. */
  id: string;
  /** Shown in the switcher. Empty → the id. */
  label: string;
  /**
   * Text `{{ui:plugin:<pluginId>:<controlId>}}` expands to while this option
   * is chosen. Empty/omitted → the label, else the id (core's rule).
   */
  value?: string;
}

/**
 * A control a plugin contributes — an APP-LEVEL value the plugin owns, read
 * by the plugin through `ctx.controls` and by prompt text through
 * `{{ui:plugin:<pluginId>:<controlId>}}`. Unlike a preset control it never
 * touches `enabled` flags, which is exactly why it carries no `prompts`
 * field: there is no preset prompt row for it to govern.
 *
 * Stored under the settings key `plugin:<id>:control_values` as a map of
 * control id → chosen option id.
 */
export interface PluginControl {
  id: string;
  label: string;
  description?: string;
  type: PluginControlType;
  /** At least two options; a `toggle` declares exactly two (`[on, off]`). */
  options: PluginControlOption[];
  /** Option id used when the user never chose one. Empty → the first option. */
  default: string;
}

/** A discovered plugin as GET /api/plugins reports it (broken ones carry `error`). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Only surfaced if the backend chooses to expose it; optional for forward-compat. */
  author?: string;
  enabled: boolean;
  /** Set when the plugin folder failed to import or activate. */
  error?: string;
  /**
   * True when the definition was imported and validated — even when a later
   * `setup` threw (error set, but the plugin can still be toggled). False
   * only for discovery/validation failures: no definition, no toggle.
   */
  loaded: boolean;
  settingsSchema: SettingField[] | null;
  /** Effective settings: schema defaults overlaid with stored values. */
  settings: Record<string, unknown> | null;
  /**
   * Controls the plugin contributes — full declarations (including options)
   * so the card can render them. Absent when the plugin declares none.
   */
  controls?: PluginControl[];
  /**
   * The plugin's resolved control values (bare control id → option id), or
   * `null` when the plugin declares no controls. Always the effective values
   * (stored choice, else `default`, else the first option).
   */
  controlValues: Record<string, string> | null;
  ui: { sidebarItems: PluginSidebarItem[] } | null;
  /** Chat-drawer tabs the plugin contributes (metadata only). */
  drawerTabs?: PluginDrawerTab[];
  /** Tracker mechanisms the plugin contributes (metadata only). */
  trackerMechanisms?: Array<{ id: string; name: string; description?: string }>;
  /** Themes the plugin contributes (full token maps — the picker and injector read them). */
  themes?: PluginThemeInfo[];
  /** Raw stylesheet applied to the host document while the plugin is enabled. */
  globalCss?: string;
}

/** Per-field validation failure from PUT settings (400), keyed by `path`. */
export interface SettingErrorDetail {
  path: string;
  message: string;
}

/** POST bodies need a JSON content-type; api() only sets it via this helper. */
function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function listPlugins(): Promise<{ plugins: PluginInfo[] }> {
  return api("/api/plugins");
}

/** Rescans the plugins folder server-side and returns the fresh list. */
export function reloadPlugins(): Promise<{ plugins: PluginInfo[] }> {
  return api("/api/plugins/reload", { method: "POST" });
}

/** Enables/disables (loads/unloads) a plugin; 404 when the id is unknown. */
export function setPluginEnabled(id: string, enabled: boolean): Promise<{ plugin: PluginInfo }> {
  return api(`/api/plugins/${encodeURIComponent(id)}`, jsonInit("PATCH", { enabled }));
}

export function getPluginSettings(
  id: string,
): Promise<{ settings: Record<string, unknown> | null }> {
  return api(`/api/plugins/${encodeURIComponent(id)}/settings`);
}

/**
 * Replaces the plugin's stored settings (validated against its schema).
 * On 400 the thrown `ApiError.details` is `SettingErrorDetail[]`.
 */
export function putPluginSettings(
  id: string,
  settings: Record<string, unknown>,
): Promise<{ settings: Record<string, unknown> }> {
  return api(`/api/plugins/${encodeURIComponent(id)}/settings`, jsonInit("PUT", { settings }));
}

/**
 * Sets the plugin's own control values. `values` maps a BARE control id to one
 * of that control's option ids; the route merges them over the stored map (a
 * focused route, so a settings replace can never clear control choices). The
 * response echoes the plugin's fresh resolved values — callers use it as the
 * new local state, never an optimistic guess.
 */
export function putPluginControls(
  id: string,
  values: Record<string, string>,
): Promise<{ control_values: Record<string, string> }> {
  return api(`/api/plugins/${encodeURIComponent(id)}/controls`, jsonInit("PUT", { values }));
}

/**
 * One drawer tab's render envelope (GET /api/plugins/:id/tabs/:tabId/data):
 * the tab's DECLARED `htmlTemplate`/`css` from the plugin definition, plus
 * `data` — the `onPanelData` hook result the web renders the template with
 * (as the template's data root). 400/404/500 throw `ApiError` carrying
 * the server's message.
 */
export interface PluginTabData {
  htmlTemplate: string;
  css: string;
  data: Record<string, unknown>;
}

export function fetchPluginTabData(
  pluginId: string,
  tabId: string,
  chatId: string,
): Promise<PluginTabData> {
  return api(
    `/api/plugins/${encodeURIComponent(pluginId)}/tabs/${encodeURIComponent(tabId)}` +
      `/data?chatId=${encodeURIComponent(chatId)}`,
  );
}
