/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { DEFAULT_TRACKER_SYSTEM_PROMPT } from "../tracker/defaults";
import { MAX_TRACKER_PARTS, type TrackerPartsConfig } from "../tracker/parts";
import { parseJsonOr } from "../util";

/**
 * Tracker snapshot creation data (parent chat id passed to the repo). A
 * snapshot is one generated tracker state: the JSON the tracker model
 * produced, tagged with the schema preset it was generated against and the
 * message it followed (nullable — manual runs may not follow one).
 */
export const trackerSnapshotInputSchema = z.object({
  message_id: z.string().nullable().default(null),
  data: z.record(z.string(), z.unknown()),
  schema_key: z.string().default("default"),
});

export type TrackerSnapshotInput = z.input<typeof trackerSnapshotInputSchema>;

export const trackerSnapshotSchema = trackerSnapshotInputSchema.extend({
  id: z.string(),
  chat_id: z.string(),
  /** 1-based position in the chat; snapshots form a monotonic chain. */
  seq: z.number().int(),
  created_at: z.string(),
});

export type TrackerSnapshot = z.infer<typeof trackerSnapshotSchema>;

/** A raw `tracker_snapshots` row (JSON columns still serialized). */
export interface TrackerSnapshotRow {
  id: string;
  chat_id: string;
  message_id: string | null;
  seq: number;
  data: string | null;
  schema_key: string;
  created_at: string;
}

/** Parses a repository row into a snapshot (throws on invalid data). */
export function parseTrackerSnapshot(row: TrackerSnapshotRow): TrackerSnapshot {
  return trackerSnapshotSchema.parse({
    id: row.id,
    chat_id: row.chat_id,
    message_id: row.message_id,
    seq: row.seq,
    data: parseJsonOr<Record<string, unknown>>(row.data, {}),
    schema_key: row.schema_key,
    created_at: row.created_at,
  });
}

/**
 * One field's request assignment. Tolerant per ENTRY, not per record: a
 * non-integer (or non-number) value falls back to 1 — the 1-based first
 * request — and an integer is clamped into `[1, MAX_TRACKER_PARTS]`. The
 * clamp runs after the catch, so a value that survives as an integer can
 * never exceed the parallelism cap.
 */
const trackerPartIndexSchema = z
  .number()
  .int()
  .catch(1)
  .transform((value) => Math.min(Math.max(value, 1), MAX_TRACKER_PARTS));

/**
 * The stored split config of one preset: how many parallel tracker requests
 * to run and which top-level field each belongs to. Parsed by the tracker
 * parts resolver (`buildTrackerParts`).
 *
 * Tolerant PER ENTRY: a malformed `count` falls back to 1, a non-object
 * `fields` to `{}`, and each field value falls back/clamps independently —
 * one bad sibling can never discard the other assignments (unlike a single
 * `.catch` over the whole record). The web mirror (`readParts` in
 * `@suvoj/web`'s tracker-config.ts) must match this table exactly.
 */
export const trackerPresetPartsSchema = z.object({
  count: z.number().int().min(1).max(MAX_TRACKER_PARTS).catch(1),
  fields: z.record(z.string(), trackerPartIndexSchema).catch({}),
});

/** One user-defined tracker schema preset (schema + its rendering). */
export const trackerSchemaPresetSchema = z.object({
  name: z.string().catch(""),
  schema: z.record(z.string(), z.unknown()).catch({}),
  html: z.string().catch(""),
  css: z.string().catch(""),
  parts: trackerPresetPartsSchema.catch({ count: 1, fields: {} } satisfies TrackerPartsConfig),
});

export type TrackerSchemaPreset = z.infer<typeof trackerSchemaPresetSchema>;

/** How tracker snapshots are injected into normal generations. */
export const trackerInjectionSchema = z.object({
  /**
   * How many SELECTED-swipe trackers are injected, one per newest message
   * position (0 disables injection).
   */
  include_last: z.number().int().min(0).catch(1),
  role: z.enum(["user", "assistant", "system"]).catch("system"),
  /**
   * How each injected snapshot is rendered: "plain" emits compact key/value
   * lines plus a read-only guard (the default — the guard keeps a roleplay
   * model from echoing the tracker into its reply); "json" wraps it in a
   * fenced ```json block, byte-identical to what the tracker generator is
   * asked to produce. "json" is the opt-in legacy/compat rendering.
   */
  format: z.enum(["json", "plain"]).catch("plain"),
  header: z.string().catch("Tracker:"),
});

/** The default injection settings (also the catch fallback). */
export const DEFAULT_TRACKER_INJECTION = {
  include_last: 1,
  role: "system",
  format: "plain",
  header: "Tracker:",
} as const;

/**
 * How the tracker is generated and rendered (stored under the
 * `tracker_config` settings key). Every field catches to its default, so
 * parsing a missing, partial or partially-invalid object yields a complete
 * config (invalid values fall back per-field, not wholesale).
 */
export const trackerConfigSchema = z.object({
  enabled: z.boolean().catch(false),
  /** Mechanism id (built-in `suvoj-tracker` or plugin-registered). */
  mechanism: z.string().catch("suvoj-tracker"),
  /** When a new tracker snapshot is generated. */
  auto_mode: z.enum(["after_reply", "before_reply", "manual"]).catch("after_reply"),
  /** Connection profile for the tracker generator; '' → default profile. */
  profile_id: z.string().catch(""),
  system_prompt: z.string().catch(DEFAULT_TRACKER_SYSTEM_PROMPT),
  /** Window of chat messages sent to the tracker generator; 0 = all. */
  include_last_messages: z.number().int().min(0).catch(6),
  /**
   * Previous trackers (selected-swipe, by message position) included in the
   * generation prompt; 0 = none. Two gives the tracker one older snapshot to
   * recover a detail the off-stage cap dropped.
   */
  include_last_trackers: z.number().int().min(0).catch(2),
  /**
   * Retention: the newest tracker per swipe row is kept across this many
   * newest message positions that carry a snapshot; everything older is
   * pruned on create.
   */
  keep_last: z.number().int().min(1).catch(2),
  /** Tracker generation max_tokens override. */
  max_response_tokens: z.number().int().min(1).catch(8192),
  /** When true, tracker UI is hidden (snapshots still inject into prompts). */
  invisible: z.boolean().catch(false),
  injection: trackerInjectionSchema.catch(DEFAULT_TRACKER_INJECTION),
  schema_presets: z.record(z.string(), trackerSchemaPresetSchema).catch({}),
  active_schema_key: z.string().catch("default"),
});

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;
