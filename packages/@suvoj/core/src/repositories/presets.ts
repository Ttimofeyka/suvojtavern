/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
// `engine/controls` is pure (zod + a type from `./preset`), so this layer
// crossing creates no runtime cycle: no engine module imports a repository
// VALUE (the engine's repository imports are all `import type`). Sharing the
// switch semantics here — rather than re-deriving them — is the point:
// stored flags and generation can never diverge.
import { applyChoicesToRows, resolveChoices, settingsControls } from "../engine/controls";
import { type Preset, type PresetInput, presetInputSchema } from "../schema/presets";
import { jsonOrNull, newId, nowIso, parseJsonOr } from "../util";

interface PresetRow {
  id: string;
  name: string;
  description: string;
  prompts: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

/** Plain-object guard for a raw JSON column (a string/array is not settings). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Materializes a preset's UI-control choices onto its STORED prompt rows, so
 * the stored `enabled` flags always equal the flags `loadPreset` applies at
 * generation time. A row named by a control option has no independent state —
 * the control decides it — and without this the editor (which renders the
 * stored rows) silently disagrees with what actually gets sent.
 *
 * The inputs are the EFFECTIVE settings + rows the write will leave behind
 * (for an update: `patch.settings ?? current.settings`). Rows and the
 * tolerant readers stay raw: a stored row is loose JSON and may be
 * hand-edited, so nothing here is force-parsed. Returns the normalized array,
 * or `null` when there is nothing to write (no resolvable controls, or the
 * flags already match) so an unrelated write never churns the column.
 */
function normalizeControlRows(rows: unknown, settings: unknown): Record<string, unknown>[] | null {
  // The `prompts` column is loose JSON too — `toPreset` does not object-check
  // it — so a hand-edited non-array is left exactly as given rather than
  // mapped over.
  if (!Array.isArray(rows)) {
    return null;
  }
  const controls = settingsControls(settings);
  if (controls.length === 0) {
    return null;
  }
  const choices = resolveChoices(
    controls,
    isRecord(settings) ? settings.control_values : undefined,
  );
  const normalized = applyChoicesToRows(rows, controls, choices);
  // Only rewrite when some row's `enabled` actually changed: `prompts` is a
  // whole-column JSON write, so an unrelated update (a rename, or a settings
  // change no control governs) must leave it byte-for-byte alone.
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.enabled !== normalized[index]?.enabled) {
      return normalized;
    }
  }
  return null;
}

function toPreset(row: PresetRow): Preset {
  const settings = parseJsonOr(row.settings, {});
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompts: parseJsonOr(row.prompts, []),
    // The `settings` column is loose JSON (`presetSettingsSchema` is a
    // looseObject), so a hand-edited or legacy row can hold a non-object.
    // Normalize it here: every consumer (and the web `PresetEditor`) spreads
    // this value, and spreading a string/array yields index-keyed junk.
    settings: isRecord(settings) ? settings : {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Prompt-pipeline presets (format v2): the ordered `prompts` array IS the
 * layout; `settings` holds engine settings. The legacy `sampling` column
 * stays in the schema for hygiene — it is always written as `'{}'` and
 * never read (connection profiles own samplers).
 */
export class PresetsRepository {
  constructor(private readonly db: Database) {}

  create(input: PresetInput): Preset {
    const data = presetInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    // A freshly created preset's flags must already agree with its controls:
    // the editor renders the stored rows, so a default choice has to be
    // materialized now, not just applied at generation time.
    const prompts = normalizeControlRows(data.prompts, data.settings) ?? data.prompts;
    stmt(
      this.db,
      `INSERT INTO presets (id, name, description, prompts, settings, sampling, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
    ).run(id, data.name, data.description, jsonOrNull(prompts), jsonOrNull(data.settings), ts, ts);
    return { id, ...data, prompts, created_at: ts, updated_at: ts };
  }

  get(id: string): Preset | null {
    const row = stmt<PresetRow>(this.db, "SELECT * FROM presets WHERE id = ?").get(id);
    return row ? toPreset(row) : null;
  }

  list(): Preset[] {
    return stmt<PresetRow>(this.db, "SELECT * FROM presets ORDER BY name COLLATE NOCASE, rowid")
      .all()
      .map(toPreset);
  }

  update(id: string, patch: Partial<PresetInput>): Preset | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    // Normalize the governed flags against the state the write will LEAVE
    // BEHIND: a settings-only patch (the controls route) resolves the
    // controls/choices from the settings it is about to store, while a
    // rows-only patch normalizes the incoming rows against the settings that
    // survive. `null` means "already consistent" — never churn the column.
    const effectiveSettings = patch.settings ?? current.settings;
    const effectivePrompts = patch.prompts ?? current.prompts;
    const normalized = normalizeControlRows(effectivePrompts, effectiveSettings);
    const prompts = normalized ?? patch.prompts;
    const set = assignSql([
      ["name", patch.name],
      ["description", patch.description],
      ["prompts", prompts === undefined ? undefined : jsonOrNull(prompts)],
      ["settings", patch.settings === undefined ? undefined : jsonOrNull(patch.settings)],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE presets SET ${set.assignments}, updated_at = ? WHERE id = ?`).run(
      ...set.params,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM presets WHERE id = ?").run(id).changes > 0;
  }
}
