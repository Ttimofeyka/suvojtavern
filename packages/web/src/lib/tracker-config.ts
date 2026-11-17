/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Web-side tracker configuration (the Suvoj Tracker surface).
 *
 * Mirrors `@suvoj/core`'s `trackerConfigSchema` (schema/tracker.ts): the
 * web package cannot import core (it never leaves the browser bundle), so
 * the defaults and the system-prompt/schema/template constants are
 * deliberate VERBATIM copies of core's `tracker/defaults.ts` — do not
 * reflow or "fix" their wording. `normalizeTrackerConfig` applies the same
 * per-field catch rules as the server's zod schema, so whatever the panel
 * holds can round-trip through PUT /api/settings without surprises.
 */

/** Hard cap on parallel tracker requests (cost/latency guard). */
export const MAX_TRACKER_PARTS = 8;

/** Stored, user-configured split of one schema preset (raw shape). */
export interface TrackerPartsConfig {
  /** Number of parallel generation requests (>= 1). */
  count: number;
  /**
   * Top-level schema property name -> 1-based request index. Only entries > 1
   * are stored; a missing name means request 1.
   */
  fields: Record<string, number>;
}

/** One user-defined tracker schema preset (schema + its rendering). */
export interface TrackerSchemaPreset {
  name: string;
  schema: Record<string, unknown>;
  html: string;
  css: string;
  parts: TrackerPartsConfig;
}

/**
 * Per-plugin tracker/drawer contributions the server's GET /api/plugins
 * carries (its PublicPlugin already emits them; web's `PluginInfo` types
 * only the pre-tracker fields, so the tracker UIs intersect this locally
 * instead of touching the shared api-plugins module).
 */
export interface PluginTrackerContributions {
  trackerMechanisms?: Array<{ id: string; name: string; description?: string }>;
  drawerTabs?: Array<{ id: string; label: string; icon?: string }>;
}

/** Lowercase kebab-case — the shape new preset keys must take. */
export const TRACKER_PRESET_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The `tracker_config` settings value (see core's trackerConfigSchema). */
export interface TrackerConfig {
  enabled: boolean;
  /** Mechanism id (built-in `suvoj-tracker` or plugin-registered). */
  mechanism: string;
  /**
   * `after_user_message` is the lazy cadence: when the user advances the
   * conversation, the PREVIOUS reply is tracked (prompt scoped through it),
   * so discarded swipes and abandoned replies cost nothing.
   */
  auto_mode: "after_reply" | "before_reply" | "after_user_message" | "manual";
  /** Connection profile for the tracker generator; "" → default profile. */
  profile_id: string;
  system_prompt: string;
  /** Window of chat messages sent to the tracker generator; 0 = all. */
  include_last_messages: number;
  /** Selected-swipe snapshots from earlier positions sent to the tracker
   *  generator; 0 = none. */
  include_last_trackers: number;
  /** Retention: newest snapshot per swipe row kept across this many newest
   *  positions (older pruned on create). */
  keep_last: number;
  /** Tracker generation max_tokens override. */
  max_response_tokens: number;
  /** When true, tracker UI is hidden (snapshots still inject into prompts). */
  invisible: boolean;
  injection: {
    /** How many newest positions' selected-swipe snapshots are injected
     *  (0 disables injection). */
    include_last: number;
    role: "user" | "assistant" | "system";
    /**
     * Rendering of each injected snapshot: "plain" emits compact key/value
     * lines with a read-only guard line and no fence (the default), so the
     * roleplay model is far less likely to echo the tracker into its reply;
     * "json" wraps the snapshot in a fenced ```json block (legacy/opt-in).
     */
    format: "json" | "plain";
    /** Prepended line; "" = no header line. */
    header: string;
  };
  schema_presets: Record<string, TrackerSchemaPreset>;
  active_schema_key: string;
}

/**
 * The default (user-editable) tracker system prompt — a verbatim copy of
 * core's DEFAULT_TRACKER_SYSTEM_PROMPT (scene-tracking instructions; the
 * `suvoj-tracker` mechanism appends its own JSON-conformance prompt after this
 * text). The "Reset to default" button restores this text.
 */
export const DEFAULT_TRACKER_SYSTEM_PROMPT = `You are a Scene Tracker Assistant. You maintain one structured snapshot of the current roleplay scene: who is present, what they wear, what they want, what they know, and what they are doing. Use the latest message, the recent messages, and the previous tracker snapshots.

Key instructions:
* Copy, do not re-derive. If a field is unchanged, copy it verbatim from the previous tracker. Never re-infer pronouns, voice, or identity from a name, role, or description.
* Pronouns are facts. Copy them from the previous tracker or the card. If a new character's pronouns are not stated, record them once and keep them for the rest of the chat.
* Present characters get the full block: name, pronouns, outfit, posture, wants, knows, voice. "posture" includes how put-together or disheveled the character appears; there is no separate state-of-dress field.
* Off-stage characters get at most five entries, each as name + pronouns + one line of current activity. Do not re-describe their outfit, posture, or agenda. Update the activity line only when the recent messages mention it; otherwise copy it verbatim. Do not simulate off-screen events.
* knownCast is a names-only list of every named character established in the chat. Append new names; never drop a name. Cap the list at 20 names, oldest first.
* Knowledge is a licence. For each present character's "knows", list only what they witnessed, were told, or found as evidence. A belief may be wrong; record it as a belief. "secrets" holds two or three live facts, each attributed with "knows", "suspects", and optionally "misled".
* NPC-only internals: never infer {{user}}'s thoughts, wants, or knowledge. For {{user}}'s "wants" and "knows", write "N/A".
* Never invent. If a fact is not in the transcript or the previous tracker, write "unknown" rather than filling it in. Do not use reasonable assumptions or default character details.
* Include underwear in "outfit" when the scene establishes it. If the character is undressed, list the removed outfit.
* Location: a specific primary scene location with increasing specificity.
* Respond with the full tracker every time. Do not emit a partial object.`;

/**
 * The default tracker schema (draft-07 style) — Suvoj's own scene-tracking
 * shape; verbatim copy of core's DEFAULT_TRACKER_SCHEMA.
 */
export const DEFAULT_TRACKER_SCHEMA: Record<string, unknown> = {
  title: "SceneTracker",
  type: "object",
  description: "Snapshot of the current roleplay scene",
  properties: {
    location: {
      type: "string",
      description: "Specific scene location with increasing specificity",
    },
    characters: {
      type: "array",
      description: "Characters present in the immediate scene. One full block per character.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Character name" },
          pronouns: {
            type: "string",
            description:
              "Pronouns copied verbatim from the previous tracker or the card (e.g. she/her). Never re-inferred.",
          },
          outfit: {
            type: "string",
            description: "Complete outfit including underwear when the scene establishes it",
          },
          posture: {
            type: "string",
            description:
              "Physical posture and interaction, plus how put-together or disheveled the character appears",
          },
          wants: {
            type: "string",
            description: "One goal this scene. Write 'N/A' for {{user}}",
          },
          knows: {
            type: "string",
            description:
              "What this character witnessed, was told, or found as evidence. Short fact tags. Write 'N/A' for {{user}}",
          },
          voice: {
            type: "string",
            description:
              "One line of speech style: register, rhythm, vocabulary. Copy verbatim once established.",
          },
        },
        required: ["name", "pronouns", "outfit", "posture", "wants", "knows"],
      },
    },
    offstage: {
      type: "array",
      description: "At most five off-stage characters, most recently active first",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Character name" },
          pronouns: {
            type: "string",
            description: "Copied verbatim; never re-inferred",
          },
          doing: {
            type: "string",
            description:
              "One line: current activity. Update only on evidence; otherwise copy verbatim.",
          },
        },
        required: ["name", "pronouns", "doing"],
      },
    },
    knownCast: {
      type: "array",
      description:
        "Names only: every named character established in the chat. Append-only, capped at 20.",
      items: { type: "string" },
    },
    secrets: {
      type: "array",
      description: "Two or three live facts that someone is hiding or acting on",
      items: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact, stated plainly" },
          knows: {
            type: "array",
            description: "Characters who know the fact",
            items: { type: "string" },
          },
          suspects: {
            type: "array",
            description: "Characters who suspect the fact",
            items: { type: "string" },
          },
          misled: {
            type: "array",
            description: "Characters who believe something false about it",
            items: { type: "string" },
          },
        },
        required: ["fact", "knows", "suspects"],
      },
    },
  },
  required: ["location", "characters", "offstage", "knownCast", "secrets"],
};

/** The default tracker HTML template — verbatim copy of core's constant. */
export const DEFAULT_TRACKER_HTML = `<div class="tracker-card">
  <div class="tracker-row"><span class="tracker-label">Location</span><span class="tracker-value">{{location}}</span></div>
  {{#if knownCast}}<div class="tracker-row"><span class="tracker-label">Known Cast</span><span class="tracker-value">{{join knownCast ", "}}</span></div>{{/if}}
  {{#each characters}}
  <details class="tracker-section tracker-character">
    <summary class="tracker-character-name">{{this.name}}{{#if this.pronouns}} · {{this.pronouns}}{{/if}}</summary>
    <div class="tracker-row"><span class="tracker-label">Outfit</span><span class="tracker-value">{{this.outfit}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Posture</span><span class="tracker-value">{{this.posture}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Wants</span><span class="tracker-value">{{this.wants}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Knows</span><span class="tracker-value">{{this.knows}}</span></div>
    {{#if this.voice}}<div class="tracker-row"><span class="tracker-label">Voice</span><span class="tracker-value">{{this.voice}}</span></div>{{/if}}
  </details>
  {{/each}}
  {{#if offstage}}
  <details class="tracker-section tracker-offstage">
    <summary class="tracker-section-name">Off-stage</summary>
    {{#each offstage}}
    <div class="tracker-row"><span class="tracker-label">{{this.name}}{{#if this.pronouns}} ({{this.pronouns}}){{/if}}</span><span class="tracker-value">{{this.doing}}</span></div>
    {{/each}}
  </details>
  {{/if}}
  {{#if secrets}}
  <details class="tracker-section tracker-secrets">
    <summary class="tracker-section-name">Secrets</summary>
    {{#each secrets}}
    <details class="tracker-section tracker-secret">
      <summary class="tracker-secret-summary">
        <span class="tracker-secret-fact">{{this.fact}}</span>
      </summary>
      {{#if this.knows}}<div class="tracker-row"><span class="tracker-label">Knows</span><span class="tracker-value">{{join this.knows ", "}}</span></div>{{/if}}
      {{#if this.suspects}}<div class="tracker-row"><span class="tracker-label">Suspects</span><span class="tracker-value">{{join this.suspects ", "}}</span></div>{{/if}}
      {{#if this.misled}}<div class="tracker-row"><span class="tracker-label">Misled</span><span class="tracker-value">{{join this.misled ", "}}</span></div>{{/if}}
    </details>
    {{/each}}
  </details>
  {{/if}}
</div>`;

/** The default tracker stylesheet — verbatim copy of core's constant. It reads
 *  the frame's theme-aware `--tf-*` palette (TemplateFrame injects it from the
 *  active theme's kind) with the dark values as fallbacks, so a light theme
 *  gets a light card. */
export const DEFAULT_TRACKER_CSS = `.tracker-card {
  font: inherit;
  color: var(--tf-card-fg, #d8d5cd);
  background: var(--tf-card-bg, #15171d);
  border: 1px solid var(--tf-card-border, #2b2f3a);
  border-radius: 10px;
  padding: 14px 16px;
  margin: 0;
  display: grid;
  gap: 12px;
}

.tracker-section {
  border: 1px solid var(--tf-section-border, #262a34);
  border-radius: 6px;
  background: var(--tf-section-bg, #1b1e26);
  padding: 10px 12px;
}

.tracker-section + .tracker-section {
  border-top: 1px solid var(--tf-section-border, #262a34);
}

.tracker-scene {
  border-left: 3px solid var(--tf-scene-accent, #8a7a4f);
}

.tracker-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}

.tracker-label {
  color: var(--tf-label, #8b8fa3);
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: right;
  white-space: nowrap;
}

.tracker-value {
  color: var(--tf-card-fg, #d8d5cd);
  text-align: left;
}

.tracker-topic {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tracker-topic > span {
  color: var(--tf-topic-fg, #c8b878);
  background: var(--tf-topic-bg, rgba(138, 122, 79, 0.12));
  border: 1px solid var(--tf-topic-border, rgba(138, 122, 79, 0.35));
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.78em;
  letter-spacing: 0.04em;
}

.tracker-character {
  border-left: 3px solid var(--tf-character-accent, #4f6a8a);
}

.tracker-offstage {
  border-left: 3px solid var(--tf-scene-accent, #8a7a4f);
}

.tracker-secrets {
  border-left: 3px solid var(--tf-topic-border, rgba(138, 122, 79, 0.35));
}

/* Inside the Secrets well each secret is a light list item, not another
   card — the outer block keeps the same weight as Off-stage. */
.tracker-secrets .tracker-secret {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 2px 0;
}

.tracker-secrets .tracker-secret + .tracker-secret {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--tf-section-border, #262a34);
}

.tracker-secret > summary {
  align-items: flex-start;
}

.tracker-secret > summary::before {
  margin-top: 3px;
}

.tracker-secret-fact {
  color: var(--tf-card-fg, #d8d5cd);
  font-size: 0.9em;
  line-height: 1.35;
  min-width: 0;
  overflow-wrap: anywhere;
}

.tracker-secret > summary:hover .tracker-secret-fact {
  color: var(--tf-topic-fg, #c8b878);
}

.tracker-character-name {
  color: var(--tf-character-name, #9fc2e8);
  font-size: 0.85em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--tf-card-border, #2b2f3a);
}

/* Collapsible sections (object fields and list-of-objects items): closed
   by default — the summary is the section's heading. */
.tracker-section > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.tracker-section > summary::-webkit-details-marker {
  display: none;
}

.tracker-section > summary:focus-visible {
  outline: 2px solid var(--tf-scene-accent, #8a7a4f);
  outline-offset: 2px;
  border-radius: 4px;
}

/* Caret: a small triangle that points right and rotates down when open. */
.tracker-section > summary::before {
  content: "";
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--tf-label, #8b8fa3);
  transition: transform 120ms ease-out;
}

.tracker-section[open] > summary::before {
  transform: rotate(90deg);
}

/* A closed section reads as a single header line — no bottom border. */
.tracker-section:not([open]) > summary {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

/* Heading for object-field sections without a natural name. */
.tracker-section-name {
  color: var(--tf-section-name, #a9adc0);
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Variables inside collapsible sections stack — small label on top, the
   value below it at full width. No left/right positioning (space-between
   pushed values to the right and squeezed long text); just breathing
   room between variables. */
details.tracker-section .tracker-row {
  display: block;
  padding: 4px 0;
}

details.tracker-section .tracker-label {
  display: block;
  margin: 0 0 2px;
  text-align: left;
  white-space: normal;
}

details.tracker-section .tracker-value {
  display: block;
}`;

/**
 * The built-in preset ("default" → SceneTracker schema + template), used by
 * the "Create the default preset" button when the stored config has no
 * presets. Verbatim copy of core's defaults.
 */
export const DEFAULT_TRACKER_SCHEMA_PRESETS: Record<string, TrackerSchemaPreset> = {
  default: {
    name: "Default",
    schema: DEFAULT_TRACKER_SCHEMA,
    html: DEFAULT_TRACKER_HTML,
    css: DEFAULT_TRACKER_CSS,
    parts: { count: 1, fields: {} },
  },
};

/** True for plain JSON objects (the tracker_config value shape). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a boolean field, falling back to the default (zod `.catch`). */
function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  return typeof record?.[key] === "boolean" ? record[key] : fallback;
}

/**
 * Reads an integer field with a minimum, falling back to the default on any
 * invalid value (mirrors z.number().int().min(n).catch(default) — a value
 * below the minimum is replaced, not clamped).
 */
function readInt(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  min: number,
): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Reads a string field, falling back to the default. Unlike the memory
 * panel's readString, "" is KEPT: the server's z.string() accepts it (an
 * empty system prompt or injection header is a valid, meaningful value).
 */
function readString(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  return typeof record?.[key] === "string" ? record[key] : fallback;
}

function readRole(record: Record<string, unknown> | undefined): TrackerConfig["injection"]["role"] {
  const value = record?.role;
  return value === "user" || value === "assistant" || value === "system" ? value : "system";
}

/**
 * Reads the injection rendering mode; only the exact string "json" selects
 * the fenced JSON form, so a missing or unknown value falls back to "plain"
 * (matching core's z.enum(["json","plain"]).catch("plain")).
 */
function readFormat(
  record: Record<string, unknown> | undefined,
): TrackerConfig["injection"]["format"] {
  return record?.format === "json" ? "json" : "plain";
}

function readAutoMode(record: Record<string, unknown> | undefined): TrackerConfig["auto_mode"] {
  const value = record?.auto_mode;
  return value === "after_reply" ||
    value === "before_reply" ||
    value === "after_user_message" ||
    value === "manual"
    ? value
    : "after_reply";
}

/** Clamps a number into `[1, max]`, falling back to 1 for non-finite values. */
function clampPart(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Reads a raw `parts` value with core's `trackerPresetPartsSchema` per-entry
 * discipline: a `count` outside `[1, MAX_TRACKER_PARTS]` (or not an integer)
 * falls back to 1, and each field value falls back to 1 for a non-integer or
 * non-number and is otherwise clamped into `[1, MAX_TRACKER_PARTS]`. One bad
 * sibling never discards the other assignments. Entries equal to 1 are
 * omitted — a missing name already means request 1, so this is semantically
 * identical to core, which stores those entries literally. Core's
 * `schema/tracker.test.ts` pins the same table; keep the two in lockstep.
 */
export function readParts(raw: unknown): TrackerPartsConfig {
  const record = isRecord(raw) ? raw : {};
  const rawCount = record.count;
  const count =
    typeof rawCount === "number" &&
    Number.isInteger(rawCount) &&
    rawCount >= 1 &&
    rawCount <= MAX_TRACKER_PARTS
      ? rawCount
      : 1;
  const fields: Record<string, number> = {};
  if (isRecord(record.fields)) {
    for (const [name, value] of Object.entries(record.fields)) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        continue;
      }
      const part = Math.min(Math.max(value, 1), MAX_TRACKER_PARTS);
      if (part > 1) {
        fields[name] = part;
      }
    }
  }
  return { count, fields };
}

/**
 * The top-level property names of a splittable object schema, in declaration
 * order — or `[]` when the schema cannot be split (wrong/`array` type, no
 * plain `properties` map). Mirrors core's `buildTrackerParts` gate.
 */
export function presetFieldNames(schema: Record<string, unknown>): string[] {
  const typeOk = schema.type === undefined || schema.type === "object";
  if (!typeOk || !isRecord(schema.properties)) {
    return [];
  }
  return Object.keys(schema.properties);
}

/**
 * Resolves a stored split against the schema's CURRENT field list, so an
 * assignment can never point at a removed field or an out-of-range request:
 * `count` is clamped to `[1, MAX_TRACKER_PARTS]` and further capped at the
 * number of fields (a request with no fields is skipped), and only entries
 * naming a live field with a part > 1 survive.
 */
export function normalizeParts(parts: TrackerPartsConfig, fields: string[]): TrackerPartsConfig {
  const count = Math.min(clampPart(parts.count, MAX_TRACKER_PARTS), Math.max(fields.length, 1));
  const allowed = new Set(fields);
  const kept: Record<string, number> = {};
  for (const [name, value] of Object.entries(parts.fields)) {
    if (!allowed.has(name)) {
      continue;
    }
    const part = clampPart(value, count);
    if (part > 1) {
      kept[name] = part;
    }
  }
  return { count, fields: kept };
}

/**
 * Groups the schema's top-level fields by request for the editor preview:
 * every CONFIGURED request `1..count` gets a (possibly empty) group, in
 * order, and a field with no assignment belongs to request 1.
 *
 * This keeps empty groups so the UI can flag them; the generated prompt
 * instead drops them (core's `buildTrackerParts`) and re-numbers survivors,
 * so the effective part a group becomes can differ from its configured
 * number — see `effectivePartCount`.
 */
export function groupFieldsByPart(
  fields: string[],
  parts: TrackerPartsConfig,
): Array<{ part: number; fields: string[] }> {
  const count = clampPart(parts.count, MAX_TRACKER_PARTS);
  const groups = Array.from({ length: count }, (_, index) => ({
    part: index + 1,
    fields: [] as string[],
  }));
  for (const name of fields) {
    const index = clampPart(parts.fields[name] ?? 1, count) - 1;
    groups[index]?.fields.push(name);
  }
  return groups;
}

/**
 * The number of requests the generation will actually run: the non-empty
 * groups (core drops empty groups), floored at 1 so an empty schema still
 * yields the single whole-schema request. Mirrors the part count core's
 * `buildTrackerParts` resolves, so the editor's hint can say "N requests run
 * in parallel" without over-counting skipped requests.
 */
export function effectivePartCount(fields: string[], parts: TrackerPartsConfig): number {
  const nonEmpty = groupFieldsByPart(fields, parts).filter((group) => group.fields.length > 0);
  return Math.max(1, nonEmpty.length);
}

/** Normalizes one schema-preset entry with per-field catch fallbacks. */
function normalizePreset(raw: unknown): TrackerSchemaPreset {
  const record = isRecord(raw) ? raw : {};
  const schema = isRecord(record.schema) ? record.schema : {};
  return {
    name: readString(record, "name", ""),
    schema,
    html: readString(record, "html", ""),
    css: readString(record, "css", ""),
    // Prune against the schema so a stored split can never reference a field
    // that no longer exists (or an out-of-range request number).
    parts: normalizeParts(readParts(record.parts), presetFieldNames(schema)),
  };
}

/**
 * Merges an unknown `tracker_config` into a complete one, applying the same
 * per-field catch rules as the server's zod schema: a non-object yields all
 * defaults, and each invalid field falls back to its default (never to a
 * clamped version of itself). GET /api/settings already answers with a
 * complete object — this is the safety net for anything older or hand-made.
 */
export function normalizeTrackerConfig(raw: unknown): TrackerConfig {
  const record = isRecord(raw) ? raw : {};
  const injection = isRecord(record.injection) ? record.injection : {};
  const presets: Record<string, TrackerSchemaPreset> = {};
  if (isRecord(record.schema_presets)) {
    for (const [key, value] of Object.entries(record.schema_presets)) {
      presets[key] = normalizePreset(value);
    }
  }
  return {
    enabled: readBoolean(record, "enabled", false),
    mechanism: readString(record, "mechanism", "suvoj-tracker"),
    auto_mode: readAutoMode(record),
    profile_id: readString(record, "profile_id", ""),
    system_prompt: readString(record, "system_prompt", DEFAULT_TRACKER_SYSTEM_PROMPT),
    include_last_messages: readInt(record, "include_last_messages", 6, 0),
    include_last_trackers: readInt(record, "include_last_trackers", 2, 0),
    keep_last: readInt(record, "keep_last", 2, 1),
    max_response_tokens: readInt(record, "max_response_tokens", 8192, 1),
    invisible: readBoolean(record, "invisible", false),
    injection: {
      include_last: readInt(injection, "include_last", 1, 0),
      role: readRole(injection),
      format: readFormat(injection),
      header: readString(injection, "header", "Tracker:"),
    },
    schema_presets: presets,
    active_schema_key: readString(record, "active_schema_key", "default"),
  };
}
