/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositories,
  engine,
  migrations,
  openDatabase,
  runMigrations,
  st,
  tracker,
  trackerConfigSchema,
} from "@suvoj/core";

/**
 * Database seeding: the built-in "Suvoj Default" preset (converted from
 * START_PRESET.json), the sample lorebook (EXAMPLE_LOREBOOK.json), a
 * default persona, and the default connection profile. All steps are safe
 * to re-run; the preset is additionally version-gated (see below).
 */

/** Seed assets: the canonical copies shipped with the app (tests read them too). */
const SEED_DIR = join(import.meta.dir, "../../seed");

const BUILTIN_PRESET_NAME = "Suvoj Default";
const BUILTIN_PRESET_DESCRIPTION =
  "Built-in roleplay base: lean core rules with a Point of View switcher and grouped prose, NSFW, and reasoning toggles.";
const EXAMPLE_LOREBOOK_NAME = "Example: Drone World";
const DEFAULT_PROFILE_NAME = "Default";

/**
 * Revision of the built-in preset SHIPPED with this build. Bump it whenever
 * the shipped preset changes — START_PRESET.json, its prompt groups, or its
 * controls — so an existing install refreshes its row.
 */
const BUILTIN_PRESET_VERSION = 7;
/** Settings key holding the version most recently seeded into this database. */
const BUILTIN_PRESET_VERSION_KEY = "builtin_preset_version";

/**
 * Revision of the built-in TRACKER defaults shipped with this build. The
 * tracker config is a settings blob, not part of the preset, so a preset
 * version bump cannot reach it — this gate drives {@link migrateTrackerDefaults}.
 */
export const TRACKER_DEFAULTS_VERSION = 4;
/** Settings key holding the tracker-defaults revision last applied. */
export const TRACKER_DEFAULTS_VERSION_KEY = "tracker_defaults_version";

/**
 * Mutually-exclusive roleplay groups for the built-in preset (id → group).
 *
 * Groups are pure UI metadata, so they cannot ride in the ST-format JSON the
 * preset is converted from (see `convertStPreset`) — the importer has no ST
 * field to read them from. They are applied here, by prompt id, after the
 * conversion and before the row is persisted. The ids are the converter's
 * slugified names (verified against `convertStPreset`), and every group has
 * exactly one member enabled in the shipped preset.
 *
 * The four POV rows are deliberately NOT here: the built-in preset declares
 * a Point of View control for them ({@link BUILTIN_PRESET_CONTROLS}), and
 * the control already switches those rows at generation time. A group would
 * be a second mechanism driving the same rows — the chosen control option
 * always wins, so the group's manual switch would silently do nothing.
 */
export const BUILTIN_PROMPT_GROUPS: Record<string, { id: string; label: string }> = {
  "realism-mode-jailbreak": { id: "nsfw", label: "NSFW Mode" },
  "freaky-mode-jailbreak": { id: "nsfw", label: "NSFW Mode" },
  "cinematic-realism": { id: "prose-style", label: "Prose Style" },
  "story-mode": { id: "prose-style", label: "Prose Style" },
  "anti-parrot-and-anti-echo": { id: "echo", label: "Echo / Anti-Echo" },
  "embellish-mode-experimental": { id: "echo", label: "Echo / Anti-Echo" },
  "bolt-chain-of-thought": { id: "cot", label: "Chain of Thought" },
  "micro-chain-of-thought": { id: "cot", label: "Chain of Thought" },
};

/** Stamps every mapped prompt with its built-in group; leaves the rest alone. */
function applyBuiltinPromptGroups(prompts: engine.PresetPrompt[]): void {
  for (const prompt of prompts) {
    const group = BUILTIN_PROMPT_GROUPS[prompt.id];
    if (group) {
      prompt.group = group;
    }
  }
}

/**
 * UI controls declared by the built-in preset, applied to `settings` after
 * the ST conversion (see `applyBuiltinControls`).
 *
 * Like the prompt groups, a control is pure preset metadata with nowhere to
 * live in the ST-format JSON `convertStPreset` reads — ST's own fields cover
 * prompts and a handful of generation settings, not UI controls. So the
 * declaration is hand-authored here, next to the ids the converter produces,
 * and stamped onto the converted preset. The option ids must satisfy
 * {@link engine.CONTROL_ID_PATTERN}; the prompt ids must match the rows in
 * START_PRESET.json (verified against `convertStPreset`'s slugs).
 *
 * Point of View is the one built-in control: four mutually-exclusive rows,
 * Hybrid by default (the same row the shipped preset leaves enabled). Making
 * it a control lets a user switch POV from the preset card without touching
 * the pipeline, and lets prompt text read the choice through `{{ui:pov}}`.
 */
export const BUILTIN_PRESET_CONTROLS: engine.PresetControl[] = [
  {
    id: "pov",
    label: "Point of View",
    description: "How the narration addresses the scene — pick the one the story should read in.",
    type: "select",
    default: "hybrid",
    options: [
      {
        id: "first",
        label: "1st person",
        value: "first person",
        prompts: ["1st-person-pov"],
      },
      {
        id: "second",
        label: "2nd person",
        value: "second person",
        prompts: ["2nd-person-pov"],
      },
      {
        id: "third",
        label: "3rd person",
        value: "third person limited",
        prompts: ["3rd-person-pov"],
      },
      {
        id: "hybrid",
        label: "Hybrid",
        value: "hybrid (third-person narration, first-person internals)",
        prompts: ["hybrid-pov"],
      },
    ],
  },
];

/**
 * Declares the built-in controls on the converted preset's settings and
 * seeds each one's default as the stored choice, so a freshly seeded preset
 * carries an explicit `control_values` (`{ pov: "hybrid" }`) rather than
 * relying on resolution fallbacks. A stale `controls`/`control_values` from
 * an older row is overwritten wholesale — the shipped declarations are the
 * source of truth on a version bump, exactly like the prompts themselves.
 */
function applyBuiltinControls(settings: Record<string, unknown>): void {
  settings.controls = BUILTIN_PRESET_CONTROLS;
  const choices: Record<string, string> = {};
  for (const control of BUILTIN_PRESET_CONTROLS) {
    const fallback = control.options[0]?.id ?? "";
    choices[control.id] = control.default !== "" ? control.default : fallback;
  }
  settings.control_values = choices;
}

/**
 * Native generation settings the ST-format seed cannot carry. The shipped
 * preset scans four messages deep for lorebook keys (the native default is
 * 2); every other setting is left to the engine's schema defaults.
 */
function applyBuiltinSettings(settings: Record<string, unknown>): void {
  settings.scan_depth = 4;
}

function readSeedJson(file: string): unknown {
  return JSON.parse(readFileSync(join(SEED_DIR, file), "utf8"));
}

/**
 * Seeds the built-in preset (converted from START_PRESET.json), gated on
 * {@link BUILTIN_PRESET_VERSION}:
 *
 * - stored version already current → `"kept"`, row untouched;
 * - otherwise the row is created when absent, or UPDATED IN PLACE (same id,
 *   so `default_preset_id` and chat references survive) with the shipped
 *   description/prompts/settings → `"updated"` / `"created"`.
 *
 * The converted prompts are stamped with {@link BUILTIN_PROMPT_GROUPS} and
 * the converted settings with {@link BUILTIN_PRESET_CONTROLS} before the row
 * is written — the ST file has no field for either.
 *
 * The version gate is what lets a shipped preset evolve without silently
 * clobbering edits on every boot: a user who wants to keep their tweaks
 * across an upgrade should duplicate the preset (a copy is a normal row and
 * is never version-gated). `version` is injectable so tests can simulate a
 * bump without editing the constant.
 */
export function seedBuiltInPreset(
  db: Database,
  version: number = BUILTIN_PRESET_VERSION,
): "created" | "updated" | "kept" {
  const repos = createRepositories(db);
  if (repos.settings.get(BUILTIN_PRESET_VERSION_KEY) === version) {
    return "kept";
  }
  const preset = engine.convertStPreset(readSeedJson("START_PRESET.json"));
  applyBuiltinPromptGroups(preset.prompts);
  applyBuiltinControls(preset.settings);
  applyBuiltinSettings(preset.settings);
  const existing = repos.presets.list().find((row) => row.name === BUILTIN_PRESET_NAME);
  if (existing) {
    repos.presets.update(existing.id, {
      description: BUILTIN_PRESET_DESCRIPTION,
      prompts: preset.prompts,
      settings: preset.settings,
    });
    repos.settings.set(BUILTIN_PRESET_VERSION_KEY, version);
    return "updated";
  }
  repos.presets.create({
    name: BUILTIN_PRESET_NAME,
    description: BUILTIN_PRESET_DESCRIPTION,
    prompts: preset.prompts,
    settings: preset.settings,
  });
  repos.settings.set(BUILTIN_PRESET_VERSION_KEY, version);
  return "created";
}

/**
 * One-time upgrade of the BUILT-IN tracker defaults, gated on
 * {@link TRACKER_DEFAULTS_VERSION}.
 *
 * The tracker config lives under the `tracker_config` settings key, so the
 * preset version gate does not touch it. This forces the shipped surface onto
 * an existing install — the system prompt, the injection role, and the
 * `default` schema preset — while leaving every user choice (enabled, mode,
 * profile, retention, message window, injection format/header) and every
 * user-created schema key alone. `"seeded"` means no config was stored and
 * the (updated) constants already resolve; `"updated"` means a stored config
 * was rewritten; `"kept"` means this revision already ran.
 */
export function migrateTrackerDefaults(db: Database): "kept" | "seeded" | "updated" {
  const repos = createRepositories(db);
  if (repos.settings.get(TRACKER_DEFAULTS_VERSION_KEY) === TRACKER_DEFAULTS_VERSION) {
    return "kept";
  }
  const stored = repos.settings.get<unknown>(tracker.TRACKER_CONFIG_KEY);
  if (stored === null || stored === undefined) {
    // Nothing stored: every field already resolves from the new constants.
    repos.settings.set(TRACKER_DEFAULTS_VERSION_KEY, TRACKER_DEFAULTS_VERSION);
    return "seeded";
  }
  const parsed = trackerConfigSchema.safeParse(stored);
  const current = parsed.success ? parsed.data : trackerConfigSchema.parse({});
  repos.settings.set(tracker.TRACKER_CONFIG_KEY, {
    ...current,
    system_prompt: tracker.DEFAULT_TRACKER_SYSTEM_PROMPT,
    include_last_trackers: 2,
    injection: { ...current.injection, role: "system" },
    schema_presets: {
      ...current.schema_presets,
      default: {
        name: "Default",
        schema: tracker.DEFAULT_TRACKER_SCHEMA,
        html: tracker.DEFAULT_TRACKER_HTML,
        css: tracker.DEFAULT_TRACKER_CSS,
        parts: { count: 1, fields: {} },
      },
    },
  });
  repos.settings.set(TRACKER_DEFAULTS_VERSION_KEY, TRACKER_DEFAULTS_VERSION);
  return "updated";
}

/** Upserts the sample lorebook by name (entries fully replaced). */
export function seedExampleLorebook(db: Database): "created" | "updated" {
  const repos = createRepositories(db);
  const existing = repos.lorebooks
    .list()
    .find((book) => book.name.toLowerCase() === EXAMPLE_LOREBOOK_NAME.toLowerCase());
  st.importLorebook(readSeedJson("EXAMPLE_LOREBOOK.json"), repos.lorebooks, {
    name: EXAMPLE_LOREBOOK_NAME,
    upsert: true,
  });
  return existing ? "updated" : "created";
}

/** Creates a default persona, but only when none exists at all. */
export function seedDefaultPersona(db: Database): "created" | "skipped" {
  const repos = createRepositories(db);
  if (repos.personas.list().length > 0) {
    return "skipped";
  }
  repos.personas.create({ name: "You", description: "" });
  return "created";
}

/**
 * Creates the default connection profile, but only when no profile is
 * `is_default` yet. A fresh profile carries no model or endpoint — the user
 * fills in `base_url` (plus an optional key) and the model in Settings — and
 * the sampling starts empty (presets carry none — profiles own samplers).
 */
export function seedDefaultProfile(db: Database): "created" | "skipped" {
  const repos = createRepositories(db);
  if (repos.profiles.list().some((profile) => profile.is_default)) {
    return "skipped";
  }
  repos.profiles.create({ name: DEFAULT_PROFILE_NAME, model: "" }, { is_default: true });
  return "created";
}

/**
 * Installs the built-in regex rule set (see core's `engine.defaultRegexRules`)
 * when the store has no rule ARRAY yet — missing or corrupt (a stale object,
 * a primitive). An existing array — even an EMPTY one — is the user's own
 * list and is never touched, so deleting every rule stays deleted across
 * restarts.
 *
 * No JSON seed asset backs this: unlike the preset/lorebook (large,
 * user-editable documents), the built-in is one deterministic rule defined
 * in core, so copying it into a seed file would only add a second, drifting
 * source of truth.
 */
export function seedDefaultRegexRules(db: Database): "created" | "skipped" {
  const repos = createRepositories(db);
  if (Array.isArray(repos.settings.get(engine.REGEX_RULES_KEY))) {
    return "skipped";
  }
  repos.settings.set(engine.REGEX_RULES_KEY, engine.defaultRegexRules());
  return "created";
}

/** Runs every seed step against an (already migrated) database. */
export function seedAll(db: Database): string[] {
  return [
    `preset '${BUILTIN_PRESET_NAME}': ${seedBuiltInPreset(db)}`,
    `tracker defaults: ${migrateTrackerDefaults(db)}`,
    `lorebook '${EXAMPLE_LOREBOOK_NAME}': ${seedExampleLorebook(db)}`,
    `default persona 'You': ${seedDefaultPersona(db)}`,
    `default profile '${DEFAULT_PROFILE_NAME}': ${seedDefaultProfile(db)}`,
    `regex rules 'Quote Cleaner': ${seedDefaultRegexRules(db)}`,
  ];
}

if (import.meta.main) {
  const db = openDatabase();
  try {
    const applied = runMigrations(db, migrations);
    if (applied.length > 0) {
      console.log(`db: applied migrations: ${applied.join(", ")}`);
    }
    for (const line of seedAll(db)) {
      console.log(`seed: ${line}`);
    }
  } finally {
    db.close();
  }
}
