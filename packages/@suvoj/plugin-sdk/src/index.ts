/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  Character,
  Chat,
  ChatHookPayload,
  engine,
  Persona,
  Summary,
  tracker,
} from "@suvoj/core";
import { BUILT_IN_THEMES } from "./themes";

/**
 * @suvoj/plugin-sdk — the authoring surface for SuvojTavern server plugins.
 *
 * A plugin is one folder inside the repo's `plugins/` directory with an
 * `index.ts` entry (see docs/PLUGINS.md for the full reference). The plugin
 * exports a {@link PluginDefinition} — normally produced by wrapping it in
 * {@link definePlugin}, which is a typed identity function: it adds no
 * runtime behavior, only compile-time checking of the shape you wrote.
 *
 * Everything a plugin can do is declarative on the definition plus the
 * hooks its `setup` returns:
 *
 * - intercept and rewrite the prompt before generation (`onBeforeGenerate`),
 * - observe streamed deltas (`onDelta`) and rewrite the final reply
 *   (`onResponse`),
 * - observe message insert/edit/delete lifecycle (`onChatEvent`),
 * - supply chat-drawer panel data (`onPanelData`),
 * - observe control changes (`onControlChange`),
 * - contribute memory strategies, tracker mechanisms and pipeline stages,
 * - contribute controls (app-level values prompt text reads through
 *   `{{ui:plugin:<id>:<control>}}` and hooks receive on their `controls` map),
 * - contribute settings (typed form fields the Settings UI renders), UI
 *   additions such as sidebar items and drawer tabs, and appearance
 *   contributions: full themes plus a global stylesheet.
 *
 * The server's PluginHost guarantees error isolation: a throwing hook is
 * logged and skipped — generation never fails because of a plugin.
 *
 * This module has no runtime dependencies: the types below are re-exports
 * and structural aliases of @suvoj/core's types, so importing the SDK never
 * loads the engine at runtime.
 */

// --- engine types (re-aliased from the `engine` namespace) ----------------

/** One message of the assembled prompt, ready for the gateway. */
export type PromptMessage = engine.PromptMessage;
/** A custom history-compaction strategy registrable via `memoryStrategies`. */
export type MemoryStrategy = engine.MemoryStrategy;
/** A custom context-pipeline stage registrable via `pipelineStages`. */
export type PipelineStage = engine.PipelineStage;
/** A custom tracker generation mechanism registrable via `trackerMechanisms`. */
export type TrackerMechanism = tracker.TrackerMechanism;
/** Everything a tracker mechanism needs to build its generation prompt. */
export type TrackerGenerationInput = tracker.TrackerGenerationInput;
/** One request a multi-request tracker mechanism asks the server to run. */
export type TrackerGenerationRequest = tracker.TrackerGenerationRequest;
/** One resolved request of a (possibly split) tracker generation. */
export type TrackerSchemaPart = tracker.TrackerSchemaPart;
/** Stored, user-configured split of one tracker schema preset (raw shape). */
export type TrackerPartsConfig = tracker.TrackerPartsConfig;
/** The tracker state of one snapshot (the `data` column, parsed). */
export type TrackerData = tracker.TrackerData;

export type { Character, Chat, Message, Persona } from "@suvoj/core";

/**
 * A stored layered-summary row — core's `Summary` (level, covered seq
 * range, text). Level 0 summarizes a raw message range, level 1 covers
 * level-0 rows, and so on.
 */
export type SummaryInfo = Summary;

/** Plugin ids must be non-empty kebab-case (`^[a-z0-9-]+$`) and unique. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/;

// --- themes ----------------------------------------------------------------

/** Plugin themes cannot shadow a built-in palette. */
export const PLUGIN_THEME_RESERVED_IDS: readonly string[] = BUILT_IN_THEMES.map(({ id }) => id);

/** Every token a plugin theme must define (mirrors the built-in contract in packages/web/src/styles/themes.css; --bg-image is optional/decorative and deliberately absent). */
export const PLUGIN_THEME_REQUIRED_TOKENS: readonly string[] = [
  "--bg",
  "--bg-elev",
  "--bg-subtle",
  "--fg",
  "--fg-muted",
  "--fg-faint",
  "--accent",
  "--accent-hover",
  "--accent-fg",
  "--focus",
  "--border",
  "--border-strong",
  "--danger",
  "--success",
  "--warning",
  "--msg-quote",
  "--msg-em",
  "--msg-underline",
  "--badge-bg",
  "--badge-fg",
  "--shadow-card",
  "--shadow-deep",
  "--scrim",
  "--scrollbar",
];

/** The tokens that must be a concrete 6-digit `#rrggbb` hex: the web client parses these out of the computed style for its WCAG accent/contrast math, so a gradient or keyword here would silently break it. */
export const PLUGIN_THEME_HEX_TOKENS: readonly string[] = ["--bg", "--bg-elev", "--bg-subtle"];

/**
 * A theme contributed by a plugin. `vars` are the CSS custom properties of
 * one palette; the web client applies them as `:root[data-theme="<id>"]`
 * for as long as the theme is selected and the plugin is enabled.
 */
export interface PluginTheme {
  /** Unique kebab-case id (`^[a-z0-9-]+$`); must not collide with a built-in theme id. */
  id: string;
  /** Display name in the appearance picker. */
  name: string;
  /** Drives `color-scheme` and the accent/contrast derivation on the web client. */
  kind: "dark" | "light";
  /**
   * CSS custom properties keyed by token name (`--bg`, `--accent`, ...).
   * Must define every token in PLUGIN_THEME_REQUIRED_TOKENS; the three tokens
   * in PLUGIN_THEME_HEX_TOKENS must be concrete `#rrggbb` hex.
   */
  vars: Record<string, string>;
}

// --- settings schema -------------------------------------------------------

/**
 * One form field of a plugin's settings schema. The `default` must match the
 * declared `type`: a boolean for `boolean`, a string for `string`/`textarea`,
 * a finite number for `number`, a string for `select`, and a `string[]` for
 * `multiselect`.
 */
export interface SettingField {
  /** Storage key; must be unique within the plugin's schema. */
  key: string;
  /** Human label shown in the Settings UI. */
  label: string;
  type: "boolean" | "string" | "number" | "select" | "textarea" | "multiselect";
  /**
   * Value used when the user never touched the setting. A `string[]` only for
   * `multiselect`; the other types keep their single-value default.
   */
  default: boolean | string | number | string[];
  /** One-line helper text shown under the field. */
  hint?: string;
  /** Placeholder for text inputs (string and textarea). */
  placeholder?: string;
  /**
   * Selectable values — required for `select`/`multiselect` (a `multiselect`
   * holds an array of these `value`s). `value` may be a number, but only
   * string values can be selected into a `multiselect`'s `string[]`.
   */
  options?: Array<{ label: string; value: string | number }>;
  /** Number bounds (applied when `type` is `"number"`). */
  min?: number;
  max?: number;
}

// --- plugin controls -------------------------------------------------------

/**
 * One option of a {@link PluginControl}. Mirrors core's `ControlOption` minus
 * the `prompts` half: a plugin never owns preset prompt rows, so an option is
 * purely a value.
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
 * A control a plugin contributes — an APP-LEVEL value (it belongs to the
 * plugin, not to a preset), read by the plugin itself through
 * `ctx.controls` and by prompt text through
 * `{{ui:plugin:<pluginId>:<controlId>}}`.
 *
 * Unlike a preset control a plugin control does not touch `enabled` flags:
 * it carries no `prompts` field and the plugin decides what the value means.
 * Stored under the settings key `plugin:<id>:control_values` as a map of
 * control id → chosen option id.
 */
export interface PluginControl {
  /** Bare, stable kebab-case id (`^[a-z0-9][a-z0-9-]*$`), unique per plugin. */
  id: string;
  /** Shown in the plugin's settings card. */
  label: string;
  /** Optional helper text under the control. */
  description?: string;
  /** `select` renders a dropdown; `toggle` a switch with exactly 2 options. */
  type: "select" | "toggle";
  /**
   * The selectable options. At least two, option ids unique within the
   * control; a `toggle` declares exactly two (on, off).
   */
  options: PluginControlOption[];
  /**
   * Option id used when the user never chose one. Falls back to the first
   * option when it names nothing (core's resolution chain).
   */
  default: string;
}

/**
 * Read/write access to a plugin's OWN controls. Values are resolved exactly
 * like core's preset control choices: the stored option when it names a real
 * one, else the control's `default` when it names one, else the first option.
 * A garbage stored value never throws.
 *
 * Reads and writes speak OPTION IDS (the value stored in
 * `plugin:<id>:control_values`), not the display text `{{ui:…}}` expands to —
 * that text comes from the option's `value`, else its label, else its id.
 */
export interface PluginControlsReader {
  /**
   * One control's resolved OPTION ID, keyed by its BARE id (the namespace is
   * implied). `null` when the plugin declares no control with that id.
   */
  get<T = string>(id: string): T | null;
  /**
   * Every one of this plugin's controls as bare id → resolved option id.
   */
  all(): Record<string, string>;
  /**
   * Persists a new choice for one of this plugin's controls and fires
   * `onControlChange`. `value` is an option ID. Throws when the control id is
   * unknown or the value is not one of that control's option ids — inside a
   * hook the host logs and skips the throw, so a bad write can never break
   * generation.
   */
  set(id: string, value: string): void;
}

/** Read access to a plugin's own settings (defaults merged with stored). */
export interface PluginSettingsReader {
  /**
   * One setting's current value: the stored value when the user set one,
   * otherwise the schema default, `undefined` for keys outside the schema.
   * Values are validated against the schema on write, so the type cast is
   * only as trustworthy as your `default`.
   */
  get<T = unknown>(key: string): T | undefined;
  /** Every setting as a plain object (schema defaults overlaid with stored values). */
  all(): Record<string, unknown>;
}

/** What a plugin's `setup` receives. */
export interface PluginContext {
  /** The plugin's own id (from its definition). */
  pluginId: string;
  /** The plugin's settings — reads are live, changes apply to new calls. */
  settings: PluginSettingsReader;
  /**
   * The plugin's own control values — live, addressed by BARE control id
   * (its namespace is implied). Reading happens here; writing fires
   * `onControlChange` and persists to `plugin:<id>:control_values`.
   */
  controls: PluginControlsReader;
  /** Prefixed, always-available logger (`[plugin:<id>] …`). */
  log(...args: unknown[]): void;
}

// --- hook events -----------------------------------------------------------

/**
 * The fully-resolved control values for the request: preset-declared controls
 * under their bare id (`"pov"`) and every plugin control under
 * `"plugin:<pluginId>:<controlId>"`. Plugin keys are namespaced, so a preset
 * control can never collide with a plugin one.
 */
export type ControlValues = Record<string, string>;

/** Fired after prompt assembly, before the gateway call. */
export interface BeforeGenerateEvent {
  chat: Chat;
  character: Character;
  persona: Persona | null;
  /** The assembled prompt messages. */
  messages: PromptMessage[];
  /** The resolved samplers for this generation. */
  sampling: Record<string, unknown>;
  /**
   * The resolved control values for this request. Plugin controls appear
   * namespaced (`plugin:<pluginId>:<controlId>`); read your OWN through
   * `ctx.controls` with bare ids.
   */
  controls: ControlValues;
}

/**
 * Fired whenever a control value changes — a preset control via
 * `PUT /api/presets/:id/controls`, a plugin control via the settings route or
 * the plugin's own `ctx.controls.set`. Observation only: the value is already
 * persisted when the event fires.
 */
export interface ControlChangeEvent {
  /** Which kind of control changed. */
  source: "preset" | "plugin";
  /** The preset id (source `preset`) or plugin id (source `plugin`). */
  ownerId: string;
  /** The control's own id — bare for a preset, bare for a plugin. */
  controlId: string;
  /** The newly chosen OPTION id (not the resolved macro text). */
  value: string;
  /**
   * The resolved values AFTER the change, namespaced exactly like
   * {@link BeforeGenerateEvent.controls} (so the changed preset control is
   * under its bare id and each plugin control under
   * `plugin:<pluginId>:<controlId>`).
   */
  values: ControlValues;
}

/** Fired for every streamed content chunk; observation only. */
export interface DeltaEvent {
  chatId: string;
  content: string;
}

/** Fired once when the model reply is complete, before it is persisted. */
export interface ResponseEvent {
  chatId: string;
  content: string;
  /** Message metadata (e.g. reasoning), or null when none was captured. */
  metadata: Record<string, unknown> | null;
}

/**
 * Message lifecycle event, aligned with core's `ChatHookPayload` plus an
 * `event` discriminator. `message` carries the full row; `previous` holds
 * the pre-edit row for edit events. afterDelete fires once the deletion
 * is persisted.
 */
export interface ChatEvent extends ChatHookPayload {
  event:
    | "beforeInsert"
    | "afterInsert"
    | "beforeEdit"
    | "afterEdit"
    | "beforeDelete"
    | "afterDelete";
}

/**
 * Fired when a chat's summaries change. `unhiddenSeqs` lists the chat
 * positions whose messages returned to the live window because the
 * summaries covering them were deleted. Observation only — the rows are
 * already committed when the event fires.
 */
export interface SummariesChangedEvent {
  chatId: string;
  /** Newly created summary rows. */
  created: SummaryInfo[];
  /** Removed summary rows (all levels intersecting the deletion). */
  deleted: SummaryInfo[];
  /** Positions back in the live window (their summaries were deleted). */
  unhiddenSeqs: number[];
}

/**
 * A chat-drawer tab contributed by a plugin. `htmlTemplate` renders the
 * panel data (the object returned by `onPanelData`) through the tracker
 * template syntax: `{{path}}` (escaped), `{{{path}}}` (unescaped),
 * `{{#each array}}…{{/each}}` (`{{this}}`, `{{this.field}}`, `{{@index}}`),
 * `{{#if path}}…{{else}}…{{/if}}`, `{{join array ", "}}`. The data root is
 * the panel-data JSON itself.
 */
export interface DrawerTab {
  /** Unique kebab-case id; `tracker` and `summaries` are reserved. */
  id: string;
  /** Visible tab label. */
  label: string;
  /** Lucide icon name (the web client maps names, falling back to Puzzle). */
  icon?: string;
  /** Rendered with the panel-data JSON via the tracker template syntax. */
  htmlTemplate: string;
  /** Scoped stylesheet for the tab's content. */
  css?: string;
}

/**
 * Fired when the web client requests the panel data of a drawer tab.
 *
 * `messages` is the chat's active-variant history as PromptMessages (the
 * same active-variant source the prompt pipeline assembles from); the
 * hook should return the JSON object used to render the tab's
 * `htmlTemplate`.
 */
export interface PanelDataEvent {
  /** The id of the plugin whose tab is being opened. */
  pluginId: string;
  /** The id of the chat whose drawer is open. */
  chatId: string;
  /** The tab being opened (its own declaration). */
  tab: DrawerTab;
  /** The chat row (title, persona/character links) — null when unknown. */
  chat: Chat | null;
  /** The chat's character — null when unknown or none. */
  character: Character | null;
  /** The user's active persona — null when unknown or none. */
  persona: Persona | null;
  /** The chat's active-variant history as PromptMessages (seq-ordered). */
  messages: PromptMessage[];
  /**
   * Chat positions currently covered by a summary row (any level) — the
   * positions prompt building hides behind the summary block instead of
   * sending verbatim. Empty when the chat has no summaries.
   */
  hiddenSeqs: number[];
  /**
   * The resolved control values for the request, the same merged map a
   * generation's {@link BeforeGenerateEvent.controls} carries. Gives a drawer
   * tab access to the active preset/plugin controls without a second hook.
   */
  controls: ControlValues;
}

// --- runtime hooks ---------------------------------------------------------

/** Handlers a plugin's `setup` may return; every member is optional. */
export interface PluginRuntimeHooks {
  /** Called when the plugin is unloaded (disabled, or a folder reload). */
  onUnload?(): void;
  /**
   * Fired after prompt assembly. Returning a new array REPLACES the prompt
   * messages for both the gateway call and every later plugin; returning
   * nothing (or throwing — logged, skipped) leaves them as-is.
   */
  onBeforeGenerate?(event: BeforeGenerateEvent): PromptMessage[] | undefined;
  /**
   * Fired for every streamed delta chunk. Observation only: the return
   * value is ignored and deltas stream to the client unmodified.
   */
  onDelta?(event: DeltaEvent): void;
  /**
   * Fired when the model reply completes. Returning a string REPLACES the
   * content that is persisted and sent in the `done` event; returning
   * nothing leaves the model content unchanged.
   */
  onResponse?(event: ResponseEvent): string | undefined;
  /** Fired for message insert/edit/delete lifecycle; observation only. */
  onChatEvent?(event: ChatEvent): void;
  /**
   * Fired when a chat's summaries were created or deleted (see
   * {@link SummariesChangedEvent}). Observation only: the change is
   * already persisted when the event fires.
   */
  onSummariesChanged?(event: SummariesChangedEvent): void;
  /**
   * Fired when a control value changes (see {@link ControlChangeEvent}).
   * Observation only: the value is already persisted when the event fires.
   * A throwing handler is logged and skipped, never propagated.
   */
  onControlChange?(event: ControlChangeEvent): void;
  /**
   * Fired when the web client opens a plugin drawer tab and asks for its
   * panel data. Returning an object (or a promise of one) renders the tab's
   * `htmlTemplate` with it; returning nothing renders the empty state.
   */
  onPanelData?(
    event: PanelDataEvent,
  ): Record<string, unknown> | Promise<Record<string, unknown>> | undefined;
}

// --- UI contributions ------------------------------------------------------

/** One sidebar entry contributed by a plugin. */
export interface SidebarItem {
  /** Visible label. */
  label: string;
  /** Route the item links to (e.g. `/settings#plugins`). */
  href: string;
  /** Lucide icon name (e.g. `"Sparkles"`). */
  icon?: string;
}

/** Declarative UI contributions; rendered by the web client. */
export interface PluginUi {
  sidebarItems?: SidebarItem[];
}

// --- the definition ---------------------------------------------------------

/** Everything a plugin declares about itself. */
export interface PluginDefinition {
  /**
   * Unique, non-empty kebab-case id (`^[a-z0-9-]+$`, see
   * {@link PLUGIN_ID_PATTERN}). Used as the storage prefix for enabled
   * state/settings and as the API identifier.
   */
  id: string;
  name: string;
  /** Semver-ish version string, e.g. `"0.1.0"`. */
  version: string;
  description?: string;
  author?: string;
  /** UI contributions (sidebar items, ...). */
  ui?: PluginUi;
  /**
   * Settings schema: typed form fields the Settings UI renders. Stored
   * under the `plugin:<id>:settings` key; only schema keys are writable.
   */
  settings?: SettingField[];
  /**
   * App-level controls contributed while the plugin is enabled. Their values
   * persist under `plugin:<id>:control_values`, are readable through
   * `ctx.controls`, arrive on hook events' `controls` map, and are readable
   * in prompt text as `{{ui:plugin:<id>:<controlId>}}`.
   */
  controls?: PluginControl[];
  /**
   * Memory strategies registered while the plugin is enabled (the strategy
   * becomes selectable in the Memory settings and usable by presets).
   */
  memoryStrategies?: MemoryStrategy[];
  /**
   * Pipeline stages appended to the context pipeline while the plugin is
   * enabled (they run after the built-in stages, in declaration order).
   */
  pipelineStages?: PipelineStage[];
  /**
   * Tracker mechanisms registered while the plugin is enabled (selectable
   * as the tracker `mechanism` in the tracker settings).
   */
  trackerMechanisms?: TrackerMechanism[];
  /**
   * Chat-drawer tabs contributed while the plugin is enabled; each tab's
   * content is rendered from the object its `onPanelData` returns.
   */
  drawerTabs?: DrawerTab[];
  /**
   * Themes contributed while the plugin is enabled; they appear in
   * Settings -> Appearance alongside the built-ins. Each theme's `vars` are
   * applied as `:root[data-theme="<id>"]` custom properties for as long as
   * the theme is selected AND the plugin is enabled.
   */
  themes?: PluginTheme[];
  /**
   * A raw stylesheet applied to the host document while the plugin is
   * enabled. Plugins run as trusted local code, so this is intentionally
   * unscoped CSS (see docs/PLUGINS.md) — it can restyle anything.
   */
  globalCss?: string;
  /**
   * Called once when the plugin is activated (enabled and discovered).
   * Read the settings, capture whatever is needed, and return the runtime
   * hooks. Throwing here fails only this plugin — it becomes a listed
   * error entry, never a server crash.
   */
  setup(ctx: PluginContext): PluginRuntimeHooks | undefined;
}

/**
 * Typed identity function for plugin definitions: write a
 * {@link PluginDefinition} inside `definePlugin(...)` and TypeScript checks
 * every field and hook signature. Adds no runtime behavior.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
