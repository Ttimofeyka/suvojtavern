/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { engine, tracker } from "@suvoj/core";
import {
  PLUGIN_ID_PATTERN,
  PLUGIN_THEME_HEX_TOKENS,
  PLUGIN_THEME_REQUIRED_TOKENS,
  PLUGIN_THEME_RESERVED_IDS,
  type PluginDefinition,
  type SettingField,
} from "@suvoj/plugin-sdk";

/**
 * Plugin discovery — the loader half of the server's plugin host.
 *
 * A plugin is one subfolder of the plugins root. The entry point is the
 * folder's `index.ts` (or `index.js`), or whatever a sibling `package.json`
 * points at with its `main` field. Modules load through Bun's synchronous
 * `require` — Bun transpiles TypeScript and supports requiring ES modules,
 * which keeps the whole host deterministic (no half-loaded plugins while
 * requests are already being served).
 *
 * Every failure mode — unreadable folder, missing entry, throwing module,
 * invalid definition — becomes a `DiscoveredPlugin` with an `error`; the
 * host then lists the plugin as broken instead of crashing the server.
 */

export interface DiscoveredPlugin {
  /** Absolute plugin folder. */
  dir: string;
  /** Validated definition; null when discovery failed. */
  definition: PluginDefinition | null;
  /** Failure description; null on success. */
  error: string | null;
}

/** True when the path exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when the path exists and is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Throws when `entry`'s resolved real path escapes the plugin folder `dir`.
 * A `package.json` `main` of `"../../elsewhere"` (or a symlinked entry)
 * would otherwise pull foreign code into the server process — plugins run
 * with the server's full permissions, so the entry must stay inside the
 * folder that declared it.
 */
function assertEntryInside(dir: string, entry: string): void {
  const folder = realpathSync(dir);
  const resolved = realpathSync(entry);
  if (resolved !== folder && !resolved.startsWith(`${folder}${sep}`)) {
    throw new Error(
      `package.json main must stay inside the plugin folder (resolved to ${resolved})`,
    );
  }
}

/**
 * Resolves a plugin folder's entry file: the `package.json` `main` when it
 * names an existing file (with or without extension, or pointing at a
 * folder's index), else `index.ts` / `index.js`. A resolvable `main` that
 * escapes the folder throws (see `assertEntryInside`) — the caller lists
 * the plugin as an error entry instead of loading outside code.
 */
function resolveEntry(dir: string): string | null {
  const manifest = join(dir, "package.json");
  let mainEntry: string | null = null;
  if (isFile(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { main?: unknown };
      if (typeof parsed.main === "string" && parsed.main.trim() !== "") {
        const main = parsed.main.trim();
        const candidates = [
          main,
          `${main}.ts`,
          `${main}.js`,
          join(main, "index.ts"),
          join(main, "index.js"),
        ];
        for (const candidate of candidates) {
          const full = join(dir, candidate);
          if (isFile(full)) {
            mainEntry = full;
            break;
          }
        }
        // A declared but unresolvable main falls through to the index files.
      }
    } catch {
      // Malformed package.json — treat as if absent.
    }
  }
  if (mainEntry !== null) {
    assertEntryInside(dir, mainEntry);
    return mainEntry;
  }
  for (const name of ["index.ts", "index.js"]) {
    const full = join(dir, name);
    if (isFile(full)) {
      return full;
    }
  }
  return null;
}

/** `err` as a single-line human message. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message === "" ? "unknown error" : message;
}

/** The setting field types the server validates; an unknown one is rejected. */
const SETTING_FIELD_TYPES: ReadonlySet<string> = new Set([
  "boolean",
  "string",
  "number",
  "select",
  "textarea",
  "multiselect",
]);

/**
 * Validates one setting value against its schema field; null when valid,
 * otherwise a human-readable reason. Covers every `SettingField.type`; an
 * unknown type is rejected at discovery (see `SETTING_FIELD_TYPES`).
 */
export function validateSettingValue(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "string":
    case "textarea":
      return typeof value === "string" ? null : "must be a string";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "must be a finite number";
      }
      if (field.min !== undefined && value < field.min) {
        return `must be >= ${field.min}`;
      }
      if (field.max !== undefined && value > field.max) {
        return `must be <= ${field.max}`;
      }
      return null;
    }
    case "select": {
      const options = field.options ?? [];
      const allowed = options.some((option) => option.value === value);
      if (!allowed) {
        const list = options.map((option) => JSON.stringify(option.value)).join(", ");
        return `must be one of: ${list}`;
      }
      return null;
    }
    case "multiselect": {
      if (!Array.isArray(value)) {
        return "must be an array of strings";
      }
      // Only string-valued options can occupy a `string[]` slot; a
      // number-valued option is unreachable from a multiselect by design.
      const allowed = new Set(
        (field.options ?? [])
          .map((option) => option.value)
          .filter((option): option is string => typeof option === "string"),
      );
      for (const entry of value) {
        if (typeof entry !== "string") {
          return "must be an array of strings";
        }
        if (!allowed.has(entry)) {
          const list = [...allowed].map((option) => JSON.stringify(option)).join(", ");
          return `must only contain one of: ${list}`;
        }
      }
      return null;
    }
  }
}

/**
 * Validates one `themes[]` entry; throws Error with a precise message.
 * `seenIds` carries the ids already accepted within the same definition, so
 * a duplicate is caught at the declaration instead of surfacing later as a
 * confusing cross-plugin collision.
 */
function validatePluginTheme(theme: unknown, index: number, seenIds: Set<string>): void {
  if (typeof theme !== "object" || theme === null) {
    throw new Error(`themes[${index}] must be an object`);
  }
  const record = theme as Record<string, unknown>;
  if (typeof record.id !== "string" || !PLUGIN_ID_PATTERN.test(record.id)) {
    throw new Error(
      `themes[${index}].id must be a non-empty kebab-case string (a-z, 0-9, -), got ${JSON.stringify(record.id)}`,
    );
  }
  // Built-in ids are reserved: the web client ships those palettes itself, so
  // a plugin theme reusing one would shadow (or never reach) the built-in.
  if (PLUGIN_THEME_RESERVED_IDS.includes(record.id)) {
    throw new Error(`themes[${index}].id "${record.id}" is reserved by a built-in theme`);
  }
  if (seenIds.has(record.id)) {
    throw new Error(`themes[${index}].id "${record.id}" is declared twice`);
  }
  seenIds.add(record.id);
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error(`themes[${index}].name must be a non-empty string`);
  }
  if (record.kind !== "dark" && record.kind !== "light") {
    throw new Error(`themes[${index}].kind must be "dark" or "light"`);
  }
  const vars = record.vars;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    throw new Error(`themes[${index}].vars must be an object`);
  }
  const tokens = vars as Record<string, unknown>;
  for (const [key, value] of Object.entries(tokens)) {
    // Keys are applied as CSS custom properties, so a bare `bg` would be
    // silently dropped by the browser; requiring the `--` prefix catches
    // that typo while still allowing optional decorative tokens
    // (`--bg-image`, ...).
    if (!key.startsWith("--")) {
      throw new Error(
        `themes[${index}].vars["${key}"] must be a CSS custom property name (start with "--")`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(`themes[${index}].vars["${key}"] must be a string`);
    }
    // A plugin's full `vars` map ships in every GET /api/plugins response, so
    // one pathological token would bloat every client payload — cap it well
    // above any real declaration (the longest built-in shadow is ~200 chars).
    if (value.length > 8192) {
      throw new Error(`themes[${index}].vars["${key}"] must be shorter than 8192 characters`);
    }
    // `""` is not a palette value: the property would be registered empty and
    // every consumer falling back to it would silently paint nothing.
    if (value === "") {
      throw new Error(`themes[${index}].vars["${key}"] must not be an empty string`);
    }
  }
  for (const token of PLUGIN_THEME_REQUIRED_TOKENS) {
    if (!Object.hasOwn(tokens, token)) {
      throw new Error(`themes[${index}].vars is missing required token "${token}"`);
    }
  }
  // The web client parses --bg/--bg-elev/--bg-subtle out of the computed
  // style for its WCAG accent/badge contrast math, so a gradient or a
  // keyword there would silently break it — the same reason themes.css's
  // contract test pins those three to concrete hex.
  for (const token of PLUGIN_THEME_HEX_TOKENS) {
    const value = tokens[token];
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
      throw new Error(`themes[${index}].vars["${token}"] must be a 6-digit #rrggbb hex`);
    }
  }
}

/**
 * Validates one `controls[]` entry; throws Error with a precise message.
 * `seenIds` carries the ids already accepted within the same definition, so
 * a duplicate is caught at the declaration (the storage key is namespaced by
 * plugin id, so cross-plugin duplicates are impossible anyway). Mirrors
 * core's `parseControls` renderability rules: at least two options, unique
 * option ids, a toggle exactly binary. Unlike core (which tolerates a
 * hand-edited preset row) an authoring mistake is rejected outright — a
 * control whose `default` names no option is a typo, not a runtime state.
 */
function validatePluginControl(control: unknown, index: number, seenIds: Set<string>): void {
  if (typeof control !== "object" || control === null) {
    throw new Error(`controls[${index}] must be an object`);
  }
  const record = control as Record<string, unknown>;
  if (typeof record.id !== "string" || !engine.CONTROL_ID_PATTERN.test(record.id)) {
    throw new Error(
      `controls[${index}].id must be a non-empty slug (a-z, 0-9, -), got ${JSON.stringify(record.id)}`,
    );
  }
  if (seenIds.has(record.id)) {
    throw new Error(`controls[${index}].id "${record.id}" is declared twice`);
  }
  seenIds.add(record.id);
  if (typeof record.label !== "string" || record.label.trim() === "") {
    throw new Error(`controls[${index}].label must be a non-empty string`);
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new Error(`controls[${index}].description must be a string`);
  }
  if (record.type !== "select" && record.type !== "toggle") {
    throw new Error(`controls[${index}].type must be "select" or "toggle"`);
  }
  if (!Array.isArray(record.options)) {
    throw new Error(`controls[${index}].options must be an array`);
  }
  // A control with fewer than two options cannot switch; a toggle is strictly
  // binary ([on, off]) — core renders the same rule.
  if (record.options.length < 2) {
    throw new Error(`controls[${index}].options must have at least two entries`);
  }
  if (record.type === "toggle" && record.options.length !== 2) {
    throw new Error(`controls[${index}].options must have exactly two entries for a toggle`);
  }
  const optionIds = new Set<string>();
  for (const [optionIndex, option] of record.options.entries()) {
    if (typeof option !== "object" || option === null) {
      throw new Error(`controls[${index}].options[${optionIndex}] must be an object`);
    }
    const optionRecord = option as Record<string, unknown>;
    if (typeof optionRecord.id !== "string" || optionRecord.id === "") {
      throw new Error(`controls[${index}].options[${optionIndex}].id must be a non-empty string`);
    }
    // Option ids ARE the stored values, so a duplicate is unresolvable.
    if (optionIds.has(optionRecord.id)) {
      throw new Error(
        `controls[${index}].options[${optionIndex}].id "${optionRecord.id}" is declared twice`,
      );
    }
    optionIds.add(optionRecord.id);
    // `label` is optional like core's (missing → the id is shown); only a
    // present non-string is a mistake.
    if (optionRecord.label !== undefined && typeof optionRecord.label !== "string") {
      throw new Error(`controls[${index}].options[${optionIndex}].label must be a string`);
    }
    if (optionRecord.value !== undefined && typeof optionRecord.value !== "string") {
      throw new Error(`controls[${index}].options[${optionIndex}].value must be a string`);
    }
  }
  if (record.default !== undefined && typeof record.default !== "string") {
    throw new Error(`controls[${index}].default must be a string`);
  }
  // `""`/absent means "the first option" (core's fallback); any other value
  // must name a real option, or the declaration points at an unresolvable
  // choice.
  const defaultId = record.default ?? "";
  if (defaultId !== "" && !optionIds.has(defaultId)) {
    throw new Error(`controls[${index}].default "${defaultId}" names no option of "${record.id}"`);
  }
}

/** Validates a definition's shape; throws Error with a precise message. */
function validateDefinition(candidate: unknown): PluginDefinition {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("plugin export must be an object");
  }
  const def = candidate as Record<string, unknown>;
  if (typeof def.id !== "string" || !PLUGIN_ID_PATTERN.test(def.id)) {
    throw new Error(
      `id must be a non-empty kebab-case string (a-z, 0-9, -), got ${JSON.stringify(def.id)}`,
    );
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    throw new Error("name must be a non-empty string");
  }
  if (typeof def.version !== "string" || def.version.trim() === "") {
    throw new Error('version must be a non-empty string (e.g. "0.1.0")');
  }
  if (typeof def.setup !== "function") {
    throw new Error("setup must be a function (setup(ctx))");
  }
  if (def.settings !== undefined) {
    if (!Array.isArray(def.settings)) {
      throw new Error("settings must be an array of setting fields");
    }
    for (const [index, field] of def.settings.entries()) {
      if (typeof field !== "object" || field === null) {
        throw new Error(`settings[${index}] must be an object`);
      }
      if (typeof field.key !== "string" || field.key === "") {
        throw new Error(`settings[${index}].key must be a non-empty string`);
      }
      if (typeof field.label !== "string" || field.label === "") {
        throw new Error(`settings[${index}].label must be a non-empty string`);
      }
      // An unrecognized type would silently skip `validateSettingValue`'s
      // switch and let ANY value through — reject it at discovery instead.
      if (!SETTING_FIELD_TYPES.has(field.type as string)) {
        throw new Error(
          `settings[${index}] (${field.key}) has an unknown type ${JSON.stringify(field.type)}`,
        );
      }
      const typeIssue = validateSettingValue(field as SettingField, field.default);
      if (typeIssue !== null) {
        throw new Error(`settings[${index}] (${field.key}): default ${typeIssue}`);
      }
    }
  }
  if (def.ui !== undefined) {
    if (typeof def.ui !== "object" || def.ui === null) {
      throw new Error("ui must be an object");
    }
    const sidebarItems = (def.ui as Record<string, unknown>).sidebarItems;
    if (sidebarItems !== undefined) {
      if (!Array.isArray(sidebarItems)) {
        throw new Error("ui.sidebarItems must be an array");
      }
      for (const [index, item] of sidebarItems.entries()) {
        if (typeof item !== "object" || item === null) {
          throw new Error(`ui.sidebarItems[${index}] must be an object`);
        }
        if (typeof item.label !== "string" || typeof item.href !== "string") {
          throw new Error(`ui.sidebarItems[${index}] needs string label and href`);
        }
      }
    }
  }
  if (def.memoryStrategies !== undefined) {
    if (!Array.isArray(def.memoryStrategies)) {
      throw new Error("memoryStrategies must be an array");
    }
    for (const [index, strategy] of def.memoryStrategies.entries()) {
      if (typeof strategy !== "object" || strategy === null) {
        throw new Error(`memoryStrategies[${index}] must be an object`);
      }
      if (typeof strategy.id !== "string" || strategy.id === "") {
        throw new Error(`memoryStrategies[${index}].id must be a non-empty string`);
      }
      // Built-in ids are reserved: unregistering removes by id, so a plugin
      // strategy reusing one would delete the built-in on unload.
      if (engine.BUILTIN_MEMORY_STRATEGY_IDS.includes(strategy.id)) {
        throw new Error(
          `memoryStrategies[${index}].id "${strategy.id}" is reserved by a built-in strategy`,
        );
      }
      if (typeof strategy.name !== "string") {
        throw new Error(`memoryStrategies[${index}].name must be a string`);
      }
      if (typeof strategy.apply !== "function") {
        throw new Error(`memoryStrategies[${index}].apply must be a function`);
      }
    }
  }
  if (def.pipelineStages !== undefined) {
    if (!Array.isArray(def.pipelineStages)) {
      throw new Error("pipelineStages must be an array");
    }
    for (const [index, stage] of def.pipelineStages.entries()) {
      if (typeof stage !== "object" || stage === null) {
        throw new Error(`pipelineStages[${index}] must be an object`);
      }
      if (typeof stage.id !== "string" || stage.id === "") {
        throw new Error(`pipelineStages[${index}].id must be a non-empty string`);
      }
      // Built-in ids are reserved: unregistering removes the FIRST match by
      // id, so a plugin stage reusing one would remove the built-in on unload.
      if (engine.BUILTIN_PIPELINE_STAGE_IDS.includes(stage.id)) {
        throw new Error(
          `pipelineStages[${index}].id "${stage.id}" is reserved by a built-in stage`,
        );
      }
      if (typeof stage.run !== "function") {
        throw new Error(`pipelineStages[${index}].run must be a function`);
      }
    }
  }
  if (def.trackerMechanisms !== undefined) {
    if (!Array.isArray(def.trackerMechanisms)) {
      throw new Error("trackerMechanisms must be an array");
    }
    for (const [index, mechanism] of def.trackerMechanisms.entries()) {
      if (typeof mechanism !== "object" || mechanism === null) {
        throw new Error(`trackerMechanisms[${index}] must be an object`);
      }
      if (typeof mechanism.id !== "string" || !PLUGIN_ID_PATTERN.test(mechanism.id)) {
        throw new Error(
          `trackerMechanisms[${index}].id must be a non-empty kebab-case string (a-z, 0-9, -), got ${JSON.stringify(mechanism.id)}`,
        );
      }
      // Built-in ids are reserved: unregistering refuses them, so a plugin
      // mechanism reusing one would shadow the built-in forever.
      if (tracker.BUILTIN_TRACKER_MECHANISM_IDS.includes(mechanism.id)) {
        throw new Error(
          `trackerMechanisms[${index}].id "${mechanism.id}" is reserved by a built-in mechanism`,
        );
      }
      if (typeof mechanism.name !== "string") {
        throw new Error(`trackerMechanisms[${index}].name must be a string`);
      }
      if (typeof mechanism.buildGenerationMessages !== "function") {
        throw new Error(`trackerMechanisms[${index}].buildGenerationMessages must be a function`);
      }
      if (typeof mechanism.parseResponse !== "function") {
        throw new Error(`trackerMechanisms[${index}].parseResponse must be a function`);
      }
      // The optional multi-request pair: both methods opt the mechanism into
      // parallel generation, so a lone one is a wiring mistake — the server
      // would silently ignore it (or run the single path without the parser).
      if (
        mechanism.buildGenerationRequests !== undefined &&
        typeof mechanism.buildGenerationRequests !== "function"
      ) {
        throw new Error(`trackerMechanisms[${index}].buildGenerationRequests must be a function`);
      }
      if (
        mechanism.parseResponses !== undefined &&
        typeof mechanism.parseResponses !== "function"
      ) {
        throw new Error(`trackerMechanisms[${index}].parseResponses must be a function`);
      }
      const hasBuildRequests = mechanism.buildGenerationRequests !== undefined;
      const hasParseResponses = mechanism.parseResponses !== undefined;
      if (hasBuildRequests !== hasParseResponses) {
        throw new Error(
          `trackerMechanisms[${index}] must declare buildGenerationRequests and parseResponses together`,
        );
      }
    }
  }
  if (def.controls !== undefined) {
    if (!Array.isArray(def.controls)) {
      throw new Error("controls must be an array");
    }
    const seenControlIds = new Set<string>();
    for (const [index, control] of def.controls.entries()) {
      validatePluginControl(control, index, seenControlIds);
    }
  }
  if (def.drawerTabs !== undefined) {
    if (!Array.isArray(def.drawerTabs)) {
      throw new Error("drawerTabs must be an array");
    }
    for (const [index, tab] of def.drawerTabs.entries()) {
      if (typeof tab !== "object" || tab === null) {
        throw new Error(`drawerTabs[${index}] must be an object`);
      }
      if (typeof tab.id !== "string" || !PLUGIN_ID_PATTERN.test(tab.id)) {
        throw new Error(
          `drawerTabs[${index}].id must be a non-empty kebab-case string (a-z, 0-9, -), got ${JSON.stringify(tab.id)}`,
        );
      }
      // The web client's built-in drawer tabs.
      if (tab.id === "tracker" || tab.id === "summaries") {
        throw new Error(`drawerTabs[${index}].id "${tab.id}" is reserved`);
      }
      if (typeof tab.label !== "string" || tab.label === "") {
        throw new Error(`drawerTabs[${index}].label must be a non-empty string`);
      }
      if (typeof tab.htmlTemplate !== "string") {
        throw new Error(`drawerTabs[${index}].htmlTemplate must be a string`);
      }
    }
  }
  if (def.themes !== undefined) {
    if (!Array.isArray(def.themes)) {
      throw new Error("themes must be an array");
    }
    const seenThemeIds = new Set<string>();
    for (const [index, theme] of def.themes.entries()) {
      validatePluginTheme(theme, index, seenThemeIds);
    }
  }
  if (def.globalCss !== undefined && typeof def.globalCss !== "string") {
    throw new Error("globalCss must be a string");
  }
  // The whole stylesheet is inlined into every GET /api/plugins response, so
  // a runaway plugin could bloat every client; 64 KiB is far above the
  // reference theme plugin's ~150-char sheet but bounds the damage.
  if (typeof def.globalCss === "string" && def.globalCss.length > 65536) {
    throw new Error("globalCss must be shorter than 65536 characters");
  }
  return candidate as PluginDefinition;
}

/**
 * Requires a plugin module, busting Bun's module cache so reloads pick up
 * edited source. The cache key combines the file's mtime and size (handles
 * real edits) with a caller-bumped nonce (handles same-millisecond
 * rewrites, e.g. test fixtures).
 */
function requirePluginModule(entry: string, nonce: number): Record<string, unknown> {
  const stat = statSync(entry);
  const cacheKey = `${stat.mtimeMs}-${stat.size}-${nonce}`;
  return require(`${entry}?v=${cacheKey}`) as Record<string, unknown>;
}

/**
 * Scans the plugins root and loads every plugin folder. Each folder is
 * handled in isolation: any failure produces `{ definition: null, error }`
 * instead of throwing.
 */
export function discoverPlugins(pluginsDir: string, nonce = 0): DiscoveredPlugin[] {
  if (!isDirectory(pluginsDir)) {
    return [];
  }
  let folders: string[];
  try {
    folders = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return [
      { dir: pluginsDir, definition: null, error: `failed to read folder: ${errorMessage(err)}` },
    ];
  }

  const out: DiscoveredPlugin[] = [];
  for (const folder of folders) {
    const dir = join(pluginsDir, folder);
    try {
      const entry = resolveEntry(dir);
      if (!entry) {
        out.push({
          dir,
          definition: null,
          error: "no entry point found (expected index.ts, index.js, or a package.json main)",
        });
        continue;
      }
      const mod = requirePluginModule(entry, nonce);
      const candidate = mod.default ?? mod.plugin;
      out.push({ dir, definition: validateDefinition(candidate), error: null });
    } catch (err) {
      out.push({ dir, definition: null, error: errorMessage(err) });
    }
  }
  return out;
}

/**
 * The default plugins root: walking up from the working directory, the
 * first `plugins/` folder sitting next to a `package.json` (dev runs with
 * cwd `packages/server`, so the walk finds the repo root's `plugins/`).
 * Null when no such folder exists — the server then runs with zero
 * plugins.
 */
export function resolveDefaultPluginsDir(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (isDirectory(join(dir, "plugins")) && isFile(join(dir, "package.json"))) {
      return join(dir, "plugins");
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Folder name of a plugin directory (error entries are keyed by it). */
export function pluginFolderName(dir: string): string {
  return basename(dir);
}
