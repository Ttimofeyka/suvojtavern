/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type ChatHookBus,
  chatHooks,
  engine,
  type Repositories,
  type SummaryEventBus,
  summaryEvents,
  tracker,
} from "@suvoj/core";
import type {
  BeforeGenerateEvent,
  ControlChangeEvent,
  ControlValues,
  DeltaEvent,
  PanelDataEvent,
  PluginContext,
  PluginControl,
  PluginDefinition,
  PluginRuntimeHooks,
  PromptMessage,
  ResponseEvent,
  SettingField,
  SidebarItem,
  SummariesChangedEvent,
} from "@suvoj/plugin-sdk";
import { loadChatContext } from "../tracker/service";
import { discoverPlugins, pluginFolderName, validateSettingValue } from "./loader";

/**
 * The server-side plugin host: discovers plugins in a folder, tracks their
 * enabled state, activates/deactivates them, and routes the generation and
 * message lifecycle surfaces through the active plugins' hooks.
 *
 * Guarantees:
 *
 * - a broken plugin (unreadable, invalid, throwing setup) becomes a listed
 *   entry with an `error` — the server and other plugins keep running;
 * - every hook invocation is wrapped: a throwing hook is logged as
 *   `[plugin:<id>]` and skipped — generation never fails because of a
 *   plugin;
 * - enabled state and settings persist in the settings store under
 *   `plugin:<id>:enabled` / `plugin:<id>:settings`; newly discovered
 *   plugins default to disabled — opt-in: nothing runs until the user
 *   enables it.
 */

/** Settings-store key holding a plugin's persisted enabled flag. */
export const enabledKey = (id: string): string => `plugin:${id}:enabled`;

/** Settings-store key holding a plugin's stored settings object. */
export const settingsKey = (id: string): string => `plugin:${id}:settings`;

/**
 * Settings-store key holding a plugin's chosen control values: a
 * `Record<controlId, optionId>` for the controls the plugin declares. Kept
 * separate from `settings` so a settings replace can never wipe control
 * choices (and vice versa) — the same split presets use for
 * `controls`/`control_values`.
 */
export const controlValuesKey = (id: string): string => `plugin:${id}:control_values`;

/**
 * The prefix namespacing a plugin control in the merged value map (and so in
 * `{{ui:…}}` prompt text). A plugin control is addressed
 * `plugin:<pluginId>:<controlId>`; preset controls keep their bare id.
 */
export const pluginControlPrefix = (pluginId: string): string => `plugin:${pluginId}:`;

/**
 * How many nested `onControlChange` notifications a single change may trigger
 * before the host stops re-firing. A plugin whose handler writes another
 * control (or its own) would otherwise recurse without bound and hang the
 * server — the nesting is natural for cascades, so this is a safety cap, not
 * a prohibition. The write itself always persists; only the notification is
 * dropped past the cap.
 */
const MAX_CONTROL_NOTIFY_DEPTH = 16;

/** One hosted plugin — its definition, state, and live runtime. */
interface HostedPlugin {
  /** Definition id, or the folder name for broken plugins. */
  id: string;
  /** Absolute plugin folder. */
  dir: string;
  /** Null for plugins that failed discovery (see `error`). */
  definition: PluginDefinition | null;
  /** Persisted enablement (false for plugins the user never touched). */
  enabled: boolean;
  /** Discovery or activation failure; null while healthy. */
  error: string | null;
  /** Runtime hooks while active (setup succeeded); null otherwise. */
  hooks: PluginRuntimeHooks | null;
  /** Reverse-run disposal: strategy/stage registrations + bus subscription. */
  disposers: Array<() => void>;
}

/** Sanitized list entry served by GET /api/plugins. */
export interface PublicPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  error?: string;
  /**
   * True when the definition was imported and validated — even when a later
   * `setup` threw. False only for discovery/validation failures (broken
   * folder): those entries have no definition to toggle, while a
   * setup-failed one can still be disabled or re-enabled.
   */
  loaded: boolean;
  settingsSchema: SettingField[] | null;
  settings: Record<string, unknown> | null;
  /**
   * Controls the plugin contributes — full declarations (including options)
   * so the web client can render them on the plugin's card. Absent when the
   * plugin declares none.
   */
  controls?: PluginControl[];
  /**
   * The plugin's resolved control values (bare control id → option id), or
   * `null` when the plugin declares no controls. Always the effective values
   * (stored choice, else `default`, else the first option).
   */
  controlValues: Record<string, string> | null;
  ui: { sidebarItems: SidebarItem[] } | null;
  /**
   * Drawer tabs the plugin contributes — metadata only (the declared
   * htmlTemplate/css ship via the panel-data route instead).
   */
  drawerTabs?: Array<{ id: string; label: string; icon?: string }>;
  /** Tracker mechanisms the plugin contributes — metadata only. */
  trackerMechanisms?: Array<{ id: string; name: string; description?: string }>;
  /** Themes the plugin contributes — the full `vars` map so the web client can apply them. */
  themes?: Array<{
    id: string;
    name: string;
    kind: "dark" | "light";
    vars: Record<string, string>;
  }>;
  /** Trusted-CSS stylesheet injected into the host document while enabled. */
  globalCss?: string;
}

export interface PluginHostOptions {
  /** Plugins root (each subfolder is one plugin); null disables discovery. */
  pluginsDir: string | null;
  repos: Repositories;
  /** Hook bus the repositories emit on; defaults to the process-wide bus. */
  hooks?: ChatHookBus;
  /**
   * Summary lifecycle bus the repositories' cascade emits on; defaults to
   * the process-wide bus.
   */
  summaryEvents?: SummaryEventBus;
}

export type PutSettingsResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; status: 400 | 404; error: string; details?: unknown };

/** `putControlValues` results: the new resolved values, or a 400/404 shape. */
export type PutControlValuesResult =
  | { ok: true; controlValues: Record<string, string> }
  | { ok: false; status: 400 | 404; error: string; details?: unknown };

/**
 * The panel-data route's render envelope: the tab's DECLARED template and
 * stylesheet (from the `DrawerTab`) plus `data` — the `onPanelData` hook
 * result the web renders `htmlTemplate` with, as the template's data root.
 */
export interface PanelDataEnvelope {
  htmlTemplate: string;
  css: string;
  data: Record<string, unknown>;
}

/** `panelData` results: 404-shaped for unknown plugin/tab/chat, the render
 *  envelope otherwise. */
export type PanelDataResult =
  | { ok: true; envelope: PanelDataEnvelope }
  | { ok: false; status: 404; error: string };

/** `err` as a single-line human message. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message === "" ? "unknown error" : message;
}

/** Non-array object check for JSON readback. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PluginHost {
  private readonly pluginsDir: string | null;
  private readonly repos: Repositories;
  private readonly hooks: ChatHookBus;
  private readonly summaryBus: SummaryEventBus;
  private readonly plugins = new Map<string, HostedPlugin>();
  /**
   * Bumped on every reload so re-imports bust Bun's module cache even when
   * a rewrite happened within mtime granularity (see loader.ts).
   */
  private reloadNonce = 0;
  /**
   * Drawer-tab id → owning plugin id, across every plugin currently
   * holding its tabs in the index (activated; disabled plugins' disposers
   * remove their entries). Uniqueness across loaded plugins is enforced
   * against this index at activation.
   */
  private readonly drawerTabs = new Map<string, string>();
  /**
   * Theme id → owning plugin id, across every plugin currently holding its
   * themes in the index (activated; disabled plugins' disposers remove
   * their entries). Uniqueness across loaded plugins is enforced against
   * this index at activation.
   */
  private readonly themeIds = new Map<string, string>();
  /**
   * Current nesting of `onControlChange` notifications: a handler that writes
   * a control re-enters synchronously, and this caps the recursion (see
   * {@link MAX_CONTROL_NOTIFY_DEPTH}).
   */
  private controlNotifyDepth = 0;

  constructor(opts: PluginHostOptions) {
    this.pluginsDir = opts.pluginsDir;
    this.repos = opts.repos;
    this.hooks = opts.hooks ?? chatHooks;
    this.summaryBus = opts.summaryEvents ?? summaryEvents;
    // Subscribed once for the host's lifetime (a reload never resubscribes
    // — unloadAll keeps the subscription, only the plugin hooks go away).
    this.summaryBus.register((event) => this.summariesChanged(event));
  }

  /**
   * Scans the plugins folder and activates every enabled plugin — newly
   * dropped-in folders start disabled (opt-in) until the user enables
   * them. Broken plugins are listed with their error. Safe to call
   * repeatedly.
   */
  loadAll(): void {
    this.unloadAll();
    this.plugins.clear();
    if (!this.pluginsDir) {
      return;
    }
    for (const discovered of discoverPlugins(this.pluginsDir, this.reloadNonce)) {
      if (!discovered.definition) {
        this.addErrorEntry(discovered.dir, discovered.error ?? "unknown error");
        continue;
      }
      const definition = discovered.definition;
      const existing = this.plugins.get(definition.id);
      if (existing) {
        this.addErrorEntry(
          discovered.dir,
          `duplicate plugin id "${definition.id}" (already provided by ${existing.dir})`,
        );
        continue;
      }
      const entry: HostedPlugin = {
        id: definition.id,
        dir: discovered.dir,
        definition,
        enabled: this.readEnabled(definition.id),
        error: null,
        hooks: null,
        disposers: [],
      };
      this.plugins.set(entry.id, entry);
      if (entry.enabled) {
        this.activate(entry);
      }
    }
  }

  /**
   * The reload button: unloads everything, rescans the folder (new plugins
   * appear, removed ones disappear, edited source is re-imported), and
   * re-activates whatever is still enabled.
   */
  reloadAll(): void {
    this.reloadNonce++;
    this.loadAll();
  }

  /** Unloads every active plugin (registrations, subscriptions, onUnload). */
  unloadAll(): void {
    for (const entry of this.plugins.values()) {
      this.unload(entry);
    }
  }

  /** Whether a plugin with this id is listed (enabled, disabled, or broken). */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /**
   * Enables/disables a plugin and persists the flag; enabling runs
   * `setup` + registrations, disabling runs `onUnload` + disposers.
   * Returns false for unknown ids.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.plugins.get(id);
    if (!entry) {
      return false;
    }
    this.repos.settings.set(enabledKey(id), enabled);
    entry.enabled = enabled;
    if (enabled) {
      this.activate(entry);
    } else {
      this.unload(entry);
    }
    return true;
  }

  /** Sanitized list for GET /api/plugins, sorted by name. */
  list(): PublicPlugin[] {
    return [...this.plugins.values()]
      .map((entry): PublicPlugin => {
        const definition = entry.definition;
        return {
          id: entry.id,
          name: definition?.name ?? entry.id,
          version: definition?.version ?? "0.0.0",
          description: definition?.description,
          enabled: entry.enabled,
          error: entry.error ?? undefined,
          loaded: definition !== null,
          settingsSchema: definition?.settings ?? null,
          settings: definition?.settings ? this.effectiveSettings(definition) : null,
          controls: definition?.controls,
          controlValues: definition?.controls ? this.resolvedControls(definition) : null,
          ui: definition?.ui ? { sidebarItems: definition.ui.sidebarItems ?? [] } : null,
          drawerTabs: definition?.drawerTabs?.map(({ id, label, icon }) => ({ id, label, icon })),
          trackerMechanisms: definition?.trackerMechanisms?.map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
          themes: definition?.themes?.map(({ id, name, kind, vars }) => ({ id, name, kind, vars })),
          globalCss: definition?.globalCss,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Effective settings (defaults overlaid with stored), or null without a schema. */
  getSettings(id: string): Record<string, unknown> | null {
    const entry = this.plugins.get(id);
    const definition = entry?.definition;
    if (!definition?.settings) {
      return null;
    }
    return this.effectiveSettings(definition);
  }

  /**
   * Replaces a plugin's stored settings. Only schema keys are accepted and
   * every value is type-checked (selects must match an option; numbers
   * respect min/max) — invalid input is a 400-shaped result with per-key
   * details, an unknown plugin a 404-shaped one.
   */
  putSettings(id: string, values: Record<string, unknown>): PutSettingsResult {
    const entry = this.plugins.get(id);
    if (!entry) {
      return { ok: false, status: 404, error: "Plugin not found" };
    }
    const { definition } = entry;
    const schema = definition?.settings ?? null;
    if (!definition || !schema) {
      return {
        ok: false,
        status: 400,
        error: definition
          ? "Plugin has no settings schema"
          : `Plugin failed to load: ${entry.error ?? "unknown error"}`,
      };
    }
    const issues: Array<{ path: string; message: string }> = [];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const field = schema.find((candidate) => candidate.key === key);
      if (!field) {
        issues.push({ path: key, message: "Unknown setting key" });
        continue;
      }
      const issue = validateSettingValue(field, value);
      if (issue !== null) {
        issues.push({ path: key, message: issue });
        continue;
      }
      out[key] = value;
    }
    if (issues.length > 0) {
      return { ok: false, status: 400, error: "Invalid plugin settings", details: issues };
    }
    this.repos.settings.set(settingsKey(id), out);
    return { ok: true, settings: this.effectiveSettings(definition) };
  }

  /**
   * Sets one or more of a plugin's control values, validating each against
   * the plugin's declared controls (unknown control or option → a 400-shaped
   * result naming the offender). Persists under `plugin:<id>:control_values`
   * and fires `onControlChange` for every accepted key. An unknown plugin or
   * a plugin declaring no controls is a 404/400-shaped result.
   */
  putControlValues(id: string, values: Record<string, string>): PutControlValuesResult {
    const entry = this.plugins.get(id);
    if (!entry) {
      return { ok: false, status: 404, error: "Plugin not found" };
    }
    const { definition } = entry;
    if (!definition) {
      return {
        ok: false,
        status: 400,
        error: `Plugin failed to load: ${entry.error ?? "unknown error"}`,
      };
    }
    const controls = definition.controls ?? [];
    if (controls.length === 0) {
      return { ok: false, status: 400, error: "Plugin has no controls" };
    }
    const issues: Array<{ path: string; message: string }> = [];
    const accepted: Array<{ control: PluginControl; value: string }> = [];
    for (const [controlId, value] of Object.entries(values)) {
      const control = controls.find((candidate) => candidate.id === controlId);
      if (!control) {
        issues.push({ path: controlId, message: "Unknown control" });
        continue;
      }
      if (!control.options.some((option) => option.id === value)) {
        const allowed = control.options.map((option) => option.id).join(", ");
        issues.push({ path: controlId, message: `Unknown option; expected one of: ${allowed}` });
        continue;
      }
      accepted.push({ control, value });
    }
    if (issues.length > 0) {
      return { ok: false, status: 400, error: "Invalid plugin control values", details: issues };
    }
    // Persist as one merged write, then notify — a stored read never sees a
    // half-applied batch.
    const stored = { ...this.storedControlValues(id) };
    for (const { control, value } of accepted) {
      stored[control.id] = value;
    }
    this.repos.settings.set(controlValuesKey(id), stored);
    // Notify AFTER persisting so `onControlChange.values` reads back fresh;
    // resolve the merged map once — every key in one batch sees the same
    // post-write state.
    const merged = this.mergedControlValues(this.loadPresetOrNull());
    for (const { control, value } of accepted) {
      this.notifyControlChange({
        source: "plugin",
        ownerId: id,
        controlId: control.id,
        value,
        values: merged,
      });
    }
    return { ok: true, controlValues: this.resolvedControls(definition) };
  }

  /**
   * The merged resolved control map for a request: preset-declared controls
   * under their bare id (`pov`), every plugin control under
   * `plugin:<pluginId>:<controlId>`. Entries are the DISPLAY text an option
   * expands to in prompt text (option `value`, else label, else id), exactly
   * like core's `choiceMacroValues`.
   *
   * `preset` omitted → the plugin half only. That is what `generate.ts` /
   * `prompt-preview.ts` pass as `prepareGeneration`'s `uiValues`; core then
   * merges the preset's own values UNDER the plugin keys (a collision is
   * impossible — plugin keys are namespaced). Pass the resolved preset to get
   * the full map for a hook event's `controls`.
   */
  mergedControlValues(preset?: engine.Preset): ControlValues {
    const values: ControlValues = preset
      ? engine.choiceMacroValues(
          engine.settingsControls(preset.settings),
          engine.settingsChoices(preset.settings),
        )
      : {};
    // Only plugins that are actually CONTRIBUTING: enabled, discovered
    // healthy, and not a broken (setup-threw) entry. A disabled plugin's
    // control values must not shape the prompt any more than its themes or
    // strategies do — enabling is what makes a contribution real.
    for (const entry of this.enabledDefinitions()) {
      const definition = entry.definition;
      if (!definition?.controls?.length) {
        continue;
      }
      const prefix = pluginControlPrefix(entry.id);
      for (const [controlId, text] of Object.entries(this.resolvedControlText(definition))) {
        values[`${prefix}${controlId}`] = text;
      }
    }
    return values;
  }

  /**
   * The default preset for the merged map, or `undefined` when the stored row
   * cannot be parsed. `engine.loadPreset` throws a `ZodError` on a corrupt row
   * (e.g. `prompts` is not an array — migration 003 deliberately leaves such
   * rows as-is, and PATCH can create one), and the plugin control routes must
   * never 500 — least of all AFTER a durable write. Degrading to the plugin
   * half (`mergedControlValues` accepts an omitted preset by contract) is the
   * same tolerant posture the rest of the controls layer takes: a hand-edited
   * or legacy preset row must never break an unrelated route.
   */
  private loadPresetOrNull(): engine.Preset | undefined {
    try {
      return engine.loadPreset(this.repos);
    } catch (err) {
      console.error("[plugin] preset load failed for control values:", err);
      return undefined;
    }
  }

  /**
   * Fires `onControlChange` across the active plugins. Observation only and
   * never throws; a throwing handler is logged `[plugin:<id>] onControlChange
   * failed` and skipped like every other observation hook. The presets route
   * calls this after a successful preset-control write; the plugin read/write
   * API fires it through the same path.
   */
  controlChanged(event: ControlChangeEvent): void {
    this.notifyControlChange(event);
  }

  /**
   * Serves one plugin drawer tab's panel data: resolves the plugin + tab,
   * loads the chat's context (chat/character/persona + active-variant
   * PromptMessages — the same history source the tracker service uses),
   * and runs the plugin's `onPanelData` hook (sync or async; returning
   * nothing renders the tab's empty state as `{}`). The result is the
   * render envelope — the tab's declared `htmlTemplate`/`css` wrapped
   * around the hook's data, so the web needs no other channel to reach
   * the declared template. Unknown plugin, tab, or chat → a 404-shaped
   * result. A throwing (or rejecting) hook is logged and rethrown — the
   * route answers 500 with its message.
   */
  async panelData(pluginId: string, tabId: string, chatId: string): Promise<PanelDataResult> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      return { ok: false, status: 404, error: "Plugin not found" };
    }
    const tab = entry.definition?.drawerTabs?.find((candidate) => candidate.id === tabId);
    if (!tab) {
      return { ok: false, status: 404, error: "Tab not found" };
    }
    const context = loadChatContext(this.repos, chatId);
    if (!context) {
      return { ok: false, status: 404, error: "Chat not found" };
    }
    // Positions the summaries currently cover (range-based, not a scalar
    // frontier): every position that still has message rows inside some
    // summary row's range (any level) — the complement of `messages`
    // above within the chat's active history. A mid-range deletion that
    // took a covering row with it re-opens exactly the surviving
    // positions of that row's range.
    const hiddenSeqs = [
      ...new Set(
        this.repos.summaries
          .list(chatId)
          .flatMap((row) => this.repos.messages.listSeqsBetween(chatId, row.seq_from, row.seq_to)),
      ),
    ].sort((a, b) => a - b);
    const event: PanelDataEvent = {
      pluginId,
      chatId,
      tab,
      chat: context.chat,
      character: context.character,
      persona: context.persona,
      messages: context.messages,
      hiddenSeqs,
      // The same merged map a generation's `controls` carries, so a tab can
      // render control-dependent data without a second hook or route.
      controls: this.mergedControlValues(this.loadPresetOrNull()),
    };
    const envelope = (data: Record<string, unknown>): PanelDataEnvelope => ({
      htmlTemplate: tab.htmlTemplate,
      css: tab.css ?? "",
      data,
    });
    const hook = entry.hooks?.onPanelData;
    if (!hook) {
      return { ok: true, envelope: envelope({}) };
    }
    try {
      const data = await hook(event);
      return { ok: true, envelope: envelope(data ?? {}) };
    } catch (err) {
      console.error(`[plugin:${pluginId}] onPanelData failed:`, err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Runs `onBeforeGenerate` through the active plugins, chaining message
   * arrays: a plugin returning a new array replaces the messages every
   * later plugin (and the gateway call) sees. Returns the (possibly
   * rewritten) messages — generation never fails here.
   */
  beforeGenerate(event: BeforeGenerateEvent): PromptMessage[] {
    let messages = event.messages;
    for (const entry of this.activePlugins()) {
      const hook = entry.hooks.onBeforeGenerate;
      if (!hook) {
        continue;
      }
      try {
        const result = hook({ ...event, messages });
        if (Array.isArray(result)) {
          messages = result;
        }
      } catch (err) {
        console.error(`[plugin:${entry.id}] onBeforeGenerate failed:`, err);
      }
    }
    return messages;
  }

  /** Fire-and-forget `onDelta` observation; never throws. */
  delta(event: DeltaEvent): void {
    for (const entry of this.activePlugins()) {
      const hook = entry.hooks.onDelta;
      if (!hook) {
        continue;
      }
      try {
        hook({ ...event });
      } catch (err) {
        console.error(`[plugin:${entry.id}] onDelta failed:`, err);
      }
    }
  }

  /**
   * Fire-and-forget `onSummariesChanged` observation: the core summary bus
   * (message-deletion cascade, summarize flows) forwards through every
   * active plugin. Never throws — a failing hook is logged and skipped.
   */
  summariesChanged(event: SummariesChangedEvent): void {
    for (const entry of this.activePlugins()) {
      const hook = entry.hooks.onSummariesChanged;
      if (!hook) {
        continue;
      }
      this.safeHook(entry, "onSummariesChanged", () => hook({ ...event }));
    }
  }

  /**
   * Runs `onResponse` through the active plugins, chaining content: a
   * plugin returning a string replaces the reply every later plugin (and
   * the persistence + `done` event) sees. Returns the final content —
   * generation never fails here.
   */
  response(event: ResponseEvent): string {
    let content = event.content;
    for (const entry of this.activePlugins()) {
      const hook = entry.hooks.onResponse;
      if (!hook) {
        continue;
      }
      try {
        const result = hook({ ...event, content });
        if (typeof result === "string") {
          content = result;
        }
      } catch (err) {
        console.error(`[plugin:${entry.id}] onResponse failed:`, err);
      }
    }
    return content;
  }

  // --- internals -----------------------------------------------------------

  /** Active plugins: enabled, discovered healthy, setup succeeded. */
  private activePlugins(): Array<HostedPlugin & { hooks: PluginRuntimeHooks }> {
    return [...this.plugins.values()].filter(
      (entry): entry is HostedPlugin & { hooks: PluginRuntimeHooks } => entry.hooks !== null,
    );
  }

  /**
   * Plugins whose declarative contributions are live: enabled, discovered
   * healthy, and not an errored (collision/setup-failed) entry. Controls are
   * data rather than a registration, so unlike {@link activePlugins} this does
   * not require `hooks` — a plugin that only contributes controls (setup
   * returns undefined) still contributes them, exactly as a theme-only plugin
   * still contributes its palette.
   */
  private enabledDefinitions(): HostedPlugin[] {
    return [...this.plugins.values()].filter(
      (entry) => entry.enabled && entry.error === null && entry.definition !== null,
    );
  }

  /**
   * Pre-flight validation of a definition's registrations against the live
   * registries: a tracker mechanism id must not collide with an already
   * REGISTERED mechanism (the built-ins are rejected at discovery — see
   * loader.ts), and a drawer-tab or theme id must be unique across the
   * plugins currently holding contributions in the index. Returns the
   * failure reason, or null when everything is free.
   *
   * Registrations the entry being activated ALREADY owns are ignored. A
   * redundant `enabled: true` re-activates a plugin whose `setup` returned
   * nothing (theme-only / drawer-tab-only plugins, e.g. plugins/theme-plugin,
   * keep `hooks === null` so `activate`'s guard cannot short-circuit it) while
   * its own entries are still in the index — without this, it would collide
   * with itself and be reported as enabled-but-broken, hiding its theme.
   * A genuinely foreign registration (another live plugin) still collides.
   */
  private contributionIssue(entry: HostedPlugin): string | null {
    const definition = entry.definition;
    if (!definition) {
      return null;
    }
    for (const mechanism of definition.trackerMechanisms ?? []) {
      // The registry has no owner column, but activation registers the exact
      // definition object — identity distinguishes "still mine" from a
      // different plugin's mechanism under the same id.
      const registered = tracker.getTrackerMechanism(mechanism.id);
      if (registered !== undefined && registered !== mechanism) {
        return `tracker mechanism "${mechanism.id}" is already registered`;
      }
    }
    for (const tab of definition.drawerTabs ?? []) {
      const owner = this.drawerTabs.get(tab.id);
      if (owner !== undefined && owner !== entry.id) {
        return `drawer tab "${tab.id}" is already contributed`;
      }
    }
    for (const theme of definition.themes ?? []) {
      const owner = this.themeIds.get(theme.id);
      if (owner !== undefined && owner !== entry.id) {
        return `theme "${theme.id}" is already contributed`;
      }
    }
    return null;
  }

  /** Runs setup + registers the declared contributions; failures isolate. */
  private activate(entry: HostedPlugin): void {
    const definition = entry.definition;
    if (!definition || entry.hooks) {
      return;
    }
    entry.error = null;
    // Contribution collisions are checked BEFORE setup runs: a rejected
    // plugin never executes (no half-initialized runtime to clean up).
    const issue = this.contributionIssue(entry);
    if (issue !== null) {
      entry.error = issue;
      return;
    }
    try {
      entry.hooks = definition.setup(this.makeContext(definition)) ?? null;
    } catch (err) {
      entry.hooks = null;
      entry.error = `setup failed: ${errorMessage(err)}`;
      return;
    }
    for (const strategy of definition.memoryStrategies ?? []) {
      engine.registerMemoryStrategy(strategy);
      entry.disposers.push(() => engine.unregisterMemoryStrategy(strategy.id));
    }
    for (const stage of definition.pipelineStages ?? []) {
      engine.registerPipelineStage(stage);
      entry.disposers.push(() => engine.unregisterPipelineStage(stage.id));
    }
    for (const mechanism of definition.trackerMechanisms ?? []) {
      tracker.registerTrackerMechanism(mechanism);
      entry.disposers.push(() => tracker.unregisterTrackerMechanism(mechanism.id));
    }
    for (const tab of definition.drawerTabs ?? []) {
      this.drawerTabs.set(tab.id, entry.id);
      const owner = entry.id;
      entry.disposers.push(() => {
        // Guarded: another plugin may have legitimately claimed the id in
        // the window between this plugin's unload and its disposer run.
        if (this.drawerTabs.get(tab.id) === owner) {
          this.drawerTabs.delete(tab.id);
        }
      });
    }
    for (const theme of definition.themes ?? []) {
      this.themeIds.set(theme.id, entry.id);
      const owner = entry.id;
      entry.disposers.push(() => {
        // Guarded: another plugin may have legitimately claimed the id in
        // the window between this plugin's unload and its disposer run.
        if (this.themeIds.get(theme.id) === owner) {
          this.themeIds.delete(theme.id);
        }
      });
    }
    const onChatEvent = entry.hooks?.onChatEvent;
    if (onChatEvent) {
      // ChatHookBus.emit is synchronous and a throwing listener would
      // abort the repository operation — wrap every forwarded event.
      const off = this.hooks.register({
        beforeInsert: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "beforeInsert", ...payload }),
          ),
        afterInsert: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "afterInsert", ...payload }),
          ),
        beforeEdit: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "beforeEdit", ...payload }),
          ),
        afterEdit: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "afterEdit", ...payload }),
          ),
        beforeDelete: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "beforeDelete", ...payload }),
          ),
        afterDelete: (payload) =>
          this.safeHook(entry, "onChatEvent", () =>
            onChatEvent({ event: "afterDelete", ...payload }),
          ),
      });
      entry.disposers.push(off);
    }
  }

  /** Runs onUnload + disposers (reverse registration order); never throws. */
  private unload(entry: HostedPlugin): void {
    const onUnload = entry.hooks?.onUnload;
    if (onUnload) {
      this.safeHook(entry, "onUnload", () => onUnload());
    }
    for (let i = entry.disposers.length - 1; i >= 0; i--) {
      const dispose = entry.disposers[i];
      if (!dispose) {
        continue;
      }
      try {
        dispose();
      } catch (err) {
        console.error(`[plugin:${entry.id}] disposal failed:`, err);
      }
    }
    entry.hooks = null;
    entry.disposers = [];
  }

  /** Runs `fn`, logging (never rethrowing) failures as `[plugin:<id>]`. */
  private safeHook(entry: HostedPlugin, hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[plugin:${entry.id}] ${hook} failed:`, err);
    }
  }

  /** The plugin-facing context: live settings + control readers, prefixed logging. */
  private makeContext(definition: PluginDefinition): PluginContext {
    return {
      pluginId: definition.id,
      settings: {
        get: <T>(key: string): T | undefined => {
          const stored = this.storedSettings(definition.id);
          if (Object.hasOwn(stored, key)) {
            return stored[key] as T;
          }
          const field = definition.settings?.find((candidate) => candidate.key === key);
          return field ? (field.default as T) : undefined;
        },
        all: () => this.effectiveSettings(definition),
      },
      controls: {
        // Bare ids: the plugin namespace is implied, mirroring how the
        // settings reader needs no `plugin:<id>:` prefix either. Reads are
        // live (stored map read per call) so a write is visible immediately.
        get: <T = string>(controlId: string): T | null => {
          const resolved = this.resolvedControls(definition);
          return Object.hasOwn(resolved, controlId) ? (resolved[controlId] as T) : null;
        },
        all: () => this.resolvedControls(definition),
        set: (controlId, value) => this.setControlValue(definition.id, controlId, value),
      },
      log: (...args: unknown[]) => console.log(`[plugin:${definition.id}]`, ...args),
    };
  }

  /**
   * Resolves one plugin's controls to their OPTION IDS, the value stored in
   * `plugin:<id>:control_values`. Resolution mirrors core's preset chain (see
   * engine/controls `resolveChoices`): the stored option when it names a real
   * one, else the control's `default` when it names one, else the first
   * option. A garbage stored choice never throws — the declaration is the
   * authority.
   */
  private resolvedControls(definition: PluginDefinition): Record<string, string> {
    const controls = definition.controls ?? [];
    if (controls.length === 0) {
      return {};
    }
    const stored = this.storedControlValues(definition.id);
    const out: Record<string, string> = {};
    for (const control of controls) {
      const candidate = stored[control.id];
      const named =
        typeof candidate === "string"
          ? control.options.find((option) => option.id === candidate)
          : undefined;
      const fallback = control.options.find((option) => option.id === control.default);
      const chosen = named ?? fallback ?? control.options[0];
      if (chosen) {
        out[control.id] = chosen.id;
      }
    }
    return out;
  }

  /**
   * Like {@link resolvedControls}, but the DISPLAY TEXT an option expands to
   * inside `{{ui:…}}` — the option's `value`, else its label, else its id,
   * mirroring core's `choiceMacroValues`. Used to build the merged macro map.
   */
  private resolvedControlText(definition: PluginDefinition): Record<string, string> {
    const controls = definition.controls ?? [];
    if (controls.length === 0) {
      return {};
    }
    const chosenIds = this.resolvedControls(definition);
    const out: Record<string, string> = {};
    for (const control of controls) {
      const chosen = control.options.find((option) => option.id === chosenIds[control.id]);
      if (!chosen) {
        continue;
      }
      // Same precedence core uses: an explicit value wins, then the label,
      // then the id — so an author who filled in only ids still gets text.
      // `label` is optional on the declaration (only a PRESENT non-string is
      // rejected), so it may be `undefined`: normalize it to `""` BEFORE the
      // comparison, or `undefined !== ""` would store `undefined` into this
      // `Record<string, string>` (dropped by JSON, throwing in plugin code).
      const text = chosen.value ?? "";
      const label = chosen.label ?? "";
      out[control.id] = text !== "" ? text : label !== "" ? label : chosen.id;
    }
    return out;
  }

  /**
   * The plugin's stored control values ({} when unset or malformed). Reads
   * the raw JSON; `resolvedControls` overlays the tolerant fallbacks.
   */
  private storedControlValues(id: string): Record<string, string> {
    const stored = this.repos.settings.get(controlValuesKey(id));
    if (!isRecord(stored)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * The `ctx.controls.set` write path: validates against the plugin's own
   * declaration, persists, and fires `onControlChange`. Throws on an unknown
   * control id or a value that names no option — inside a hook the throw is
   * caught and logged by `safeHook`, so a bad write can never break
   * generation; outside a hook a caller sees a real error.
   */
  private setControlValue(pluginId: string, controlId: string, value: string): void {
    const definition = this.plugins.get(pluginId)?.definition;
    const control = definition?.controls?.find((candidate) => candidate.id === controlId);
    if (!control) {
      throw new Error(`unknown control "${controlId}"`);
    }
    if (!control.options.some((option) => option.id === value)) {
      const allowed = control.options.map((option) => option.id).join(", ");
      throw new Error(`value "${value}" is not an option of "${controlId}" (expected: ${allowed})`);
    }
    const stored = { ...this.storedControlValues(pluginId), [controlId]: value };
    this.repos.settings.set(controlValuesKey(pluginId), stored);
    this.notifyControlChange({
      source: "plugin",
      ownerId: pluginId,
      controlId,
      value,
      values: this.mergedControlValues(this.loadPresetOrNull()),
    });
  }

  /**
   * Fires `onControlChange` across active plugins, isolating throwers through
   * the same `safeHook` path as every observation hook. A handler that writes
   * another control re-enters here synchronously; `controlNotifyDepth` caps
   * that nest so a mutual-write loop cannot exhaust the stack. Reaching the
   * cap logs and returns — the write itself has already persisted.
   */
  private notifyControlChange(event: ControlChangeEvent): void {
    if (this.controlNotifyDepth >= MAX_CONTROL_NOTIFY_DEPTH) {
      console.error(
        `[plugin] onControlChange cascade stopped after ${MAX_CONTROL_NOTIFY_DEPTH} levels`,
      );
      return;
    }
    this.controlNotifyDepth++;
    try {
      for (const entry of this.activePlugins()) {
        const hook = entry.hooks.onControlChange;
        if (!hook) {
          continue;
        }
        this.safeHook(entry, "onControlChange", () => hook({ ...event }));
      }
    } finally {
      this.controlNotifyDepth--;
    }
  }

  /** Stored settings object ({} when unset or malformed). */
  private storedSettings(id: string): Record<string, unknown> {
    const stored = this.repos.settings.get(settingsKey(id));
    return isRecord(stored) ? stored : {};
  }

  /** Schema defaults overlaid with stored values. */
  private effectiveSettings(definition: PluginDefinition): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of definition.settings ?? []) {
      out[field.key] = field.default;
    }
    return { ...out, ...this.storedSettings(definition.id) };
  }

  /** Persisted enablement; only an explicit `true` means enabled (opt-in). */
  private readEnabled(id: string): boolean {
    const stored = this.repos.settings.get(enabledKey(id));
    return typeof stored === "boolean" ? stored : false;
  }

  /** Lists a broken folder under its folder name (key collisions suffixed). */
  private addErrorEntry(dir: string, error: string): void {
    const base = pluginFolderName(dir);
    let key = base;
    for (let i = 2; this.plugins.has(key); i++) {
      key = `${base}-${i}`;
    }
    this.plugins.set(key, {
      id: key,
      dir,
      definition: null,
      enabled: false,
      error,
      hooks: null,
      disposers: [],
    });
  }
}
