/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { jsonOrNull, parseJson, slugify, uniqueSlug } from "../../util";
import type { Migration } from "../migrate";
import { stmt } from "../sql";

/**
 * 003 — presets format v2.
 *
 * Presets become our own editable document: a `description` column is added
 * and the prompt layout (previously the `order` array riding inside the
 * `sampling` JSON under `__suvoj_layout`) collapses into the `prompts` array
 * itself — array order IS the layout now. Engine settings move to the new
 * `settings` column. The legacy `sampling` column becomes dead: it is kept
 * in the schema for hygiene, rewritten to `'{}'`, and never read again —
 * connection profiles carry all samplers.
 *
 * Per row: prompts referenced by the old layout `order` keep their relative
 * positions; prompts NOT in the order were never rendered before and are
 * appended at the end with `enabled: false` (visible-but-off in the new
 * format). Marker ids stay verbatim; every other id becomes a readable slug
 * derived from the prompt's name (same rules as the ST converter). One
 * corrupt row must not break startup — it is left as-is.
 */

/** The layout-marker ids of the prompt pipeline (engine/preset.ts). */
const MARKER_IDS = new Set([
  "main",
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
  "jailbreak",
]);

interface OldPresetRow {
  id: string;
  sampling: string;
  prompts: string;
}

/** The old prompt record's id: v1 engine rows use `id`, ST-style rows `identifier`. */
function recordId(record: Record<string, unknown>): string {
  const id = record.id;
  if (typeof id === "string" && id !== "") {
    return id;
  }
  const identifier = record.identifier;
  return typeof identifier === "string" ? identifier : "";
}

/**
 * A record is a layout marker when its id names one of the markers, or it
 * carries a `marker` field naming one. Markers keep their id verbatim and
 * get the `marker` field normalized to it.
 */
function markerOf(record: Record<string, unknown>, id: string): string | null {
  if (MARKER_IDS.has(id)) {
    return id;
  }
  const marker = record.marker;
  return typeof marker === "string" && MARKER_IDS.has(marker) ? marker : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rebuilds one row's `prompts`/`settings` in the v2 shape. Throws on
 * corrupt JSON so the caller can leave the row untouched.
 */
function migrateRow(db: Database, row: OldPresetRow): void {
  const parsedSampling = parseJson<unknown>(row.sampling);
  if (
    parsedSampling === null ||
    typeof parsedSampling !== "object" ||
    Array.isArray(parsedSampling)
  ) {
    throw new Error(`preset ${row.id}: sampling is not a JSON object`);
  }
  const sampling = parsedSampling as Record<string, unknown>;
  const layout = (sampling.__suvoj_layout ?? {}) as { order?: unknown; settings?: unknown };
  const order = Array.isArray(layout.order)
    ? layout.order.filter((id): id is string => typeof id === "string")
    : [];

  const parsedPrompts = parseJson<unknown>(row.prompts);
  if (parsedPrompts === null || !Array.isArray(parsedPrompts)) {
    throw new Error(`preset ${row.id}: prompts is not a JSON array`);
  }

  // Old records by id, first occurrence winning (like the ST converter).
  const records: Array<Record<string, unknown>> = [];
  const byOldId = new Map<string, Record<string, unknown>>();
  for (const entry of parsedPrompts) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const oldId = recordId(record);
    if (oldId === "" || byOldId.has(oldId)) {
      continue;
    }
    byOldId.set(oldId, record);
    records.push(record);
  }

  // Id assignment: markers keep theirs, everything else is slugified from
  // the name (falling back to the old id). Marker ids are reserved so a
  // slug can never shadow them.
  const taken = new Set<string>(MARKER_IDS);
  const newIdByOldId = new Map<string, string>();
  for (const record of records) {
    const oldId = recordId(record);
    const marker = markerOf(record, oldId);
    if (marker !== null) {
      record.marker = marker;
      newIdByOldId.set(oldId, oldId);
      continue;
    }
    newIdByOldId.set(oldId, uniqueSlug(slugify(asString(record.name) || oldId), taken));
  }

  // The array IS the layout: ordered entries first (in order positions),
  // then everything else appended disabled — it never rendered before.
  const placed = new Set<string>();
  const migrated: Array<Record<string, unknown>> = [];
  for (const oldId of order) {
    if (placed.has(oldId)) {
      continue;
    }
    const record = byOldId.get(oldId);
    if (!record) {
      continue;
    }
    placed.add(oldId);
    migrated.push({ ...record, id: newIdByOldId.get(oldId) });
  }
  for (const record of records) {
    const oldId = recordId(record);
    if (placed.has(oldId)) {
      continue;
    }
    migrated.push({ ...record, id: newIdByOldId.get(oldId), enabled: false });
  }

  const settings =
    typeof layout.settings === "object" &&
    layout.settings !== null &&
    !Array.isArray(layout.settings)
      ? (layout.settings as Record<string, unknown>)
      : {};

  stmt(
    db,
    "UPDATE presets SET prompts = ?, settings = ?, description = '', sampling = '{}' WHERE id = ?",
  ).run(jsonOrNull(migrated), jsonOrNull(settings), row.id);
}

export const migration003PresetsV2: Migration = {
  id: 3,
  name: "presets_v2",
  up: (db) => {
    db.exec(`
      ALTER TABLE presets ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE presets ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
    `);
    const rows = stmt<OldPresetRow>(db, "SELECT id, sampling, prompts FROM presets").all();
    for (const row of rows) {
      try {
        migrateRow(db, row);
      } catch {
        // One corrupt row must not break startup — it is left as-is.
      }
    }
  },
};
