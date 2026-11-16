/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { openDatabase } from "../database";
import { runMigrations } from "../migrate";
import { stmt } from "../sql";
import { migration001Init } from "./001_init";
import { migration002Profiles } from "./002_profiles";
import { migrations } from "./index";

/** Fresh database at the v1 schema (migrations 001–002 only). */
function v1Db(): Database {
  const db = openDatabase(":memory:");
  runMigrations(db, [migration001Init, migration002Profiles]);
  return db;
}

interface V1Insert {
  id: string;
  sampling: unknown;
  prompts: unknown;
}

/** Inserts a v1-shaped presets row (name is irrelevant to the migration). */
function insertV1Preset(db: Database, row: V1Insert): void {
  stmt(
    db,
    "INSERT INTO presets (id, name, sampling, prompts, created_at, updated_at) VALUES (?, 'Old', ?, ?, 't', 't')",
  ).run(row.id, JSON.stringify(row.sampling), JSON.stringify(row.prompts));
}

interface MigratedRow {
  id: string;
  description: string;
  sampling: string;
  prompts: string;
  settings: string;
}

function migratedRow(db: Database, id: string): MigratedRow {
  const row = stmt<MigratedRow>(db, "SELECT * FROM presets WHERE id = ?").get(id);
  if (!row) {
    throw new Error(`expected preset ${id} after migration`);
  }
  return row;
}

describe("migration 003 (presets v2)", () => {
  it("adds the description and settings columns to a fresh database", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const columns = stmt<{ name: string }>(db, "PRAGMA table_info(presets)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("description");
    expect(columns).toContain("settings");
    db.close();
  });

  it("migrates a v1 row: order respected, leftovers appended disabled, ids slugged, settings moved", () => {
    const db = v1Db();
    insertV1Preset(db, {
      id: "p1",
      sampling: {
        temperature: 0.9,
        __suvoj_layout: {
          order: ["main", "uuid-2", "chatHistory", "uuid-1"],
          settings: { scan_depth: 7, wi_budget: 512 },
        },
      },
      prompts: [
        { id: "uuid-1", name: "Anti Parrot Echo!!!", role: "user", content: "A", enabled: true },
        { id: "uuid-2", name: "Style Hint", role: "system", content: "S", enabled: true },
        {
          id: "main",
          name: "Main prompt",
          role: "system",
          content: "M",
          enabled: true,
          marker: "main",
        },
        { id: "leftover", name: "Forgotten", role: "system", content: "F", enabled: true },
        { id: "chatHistory", name: "Chat history", marker: "chatHistory", enabled: true },
      ],
    });
    runMigrations(db, migrations);

    const row = migratedRow(db, "p1");
    // The legacy sampling column is dead: always rewritten to '{}'.
    expect(row.sampling).toBe("{}");
    expect(row.description).toBe("");
    expect(JSON.parse(row.settings)).toEqual({ scan_depth: 7, wi_budget: 512 });

    const prompts = JSON.parse(row.prompts) as Array<Record<string, unknown>>;
    // Array order IS the layout: ordered entries in order positions
    // (main, uuid-2 → style-hint, chatHistory, uuid-1 → anti-parrot-echo),
    // then the never-rendered leftover appended at the end (its id is the
    // slug of its name "Forgotten", like every non-marker id).
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "main",
      "style-hint",
      "chatHistory",
      "anti-parrot-echo",
      "forgotten",
    ]);
    // Markers keep their id and their marker field.
    expect(prompts[0]).toMatchObject({ id: "main", marker: "main", enabled: true });
    expect(prompts[2]).toMatchObject({ id: "chatHistory", marker: "chatHistory" });
    // Slugged records keep their other fields.
    expect(prompts[1]).toMatchObject({
      name: "Style Hint",
      role: "system",
      content: "S",
      enabled: true,
    });
    // The leftover was never rendered before: visible but off (its id is
    // the slug of its NAME — "Forgotten" — like every non-marker id).
    const leftover = prompts[4];
    expect(leftover).toMatchObject({ id: "forgotten", name: "Forgotten", enabled: false });
    db.close();
  });

  it("keeps slug collisions apart with numeric suffixes", () => {
    const db = v1Db();
    insertV1Preset(db, {
      id: "p1",
      sampling: { __suvoj_layout: { order: [], settings: {} } },
      prompts: [
        { id: "a", name: "Story Mode", enabled: true },
        { id: "b", name: "story  mode", enabled: true },
        { id: "c", name: "STORY MODE!", enabled: true },
      ],
    });
    runMigrations(db, migrations);
    const prompts = JSON.parse(migratedRow(db, "p1").prompts) as Array<Record<string, unknown>>;
    expect(prompts.map((prompt) => prompt.id)).toEqual([
      "story-mode",
      "story-mode-2",
      "story-mode-3",
    ]);
    db.close();
  });

  it("leaves corrupt rows as-is while migrating the rest", () => {
    const db = v1Db();
    // Corrupt sampling JSON…
    stmt(
      db,
      "INSERT INTO presets (id, name, sampling, prompts, created_at, updated_at) VALUES ('bad', 'Bad', '{not json', '[]', 't', 't')",
    ).run();
    // …and a prompts column that is valid JSON but not an array.
    insertV1Preset(db, { id: "bad2", sampling: {}, prompts: "not an array" });
    insertV1Preset(db, {
      id: "good",
      sampling: { __suvoj_layout: { order: ["main"], settings: {} } },
      prompts: [{ id: "main", name: "Main prompt", marker: "main", enabled: true }],
    });
    expect(runMigrations(db, migrations)).toEqual([
      "presets_v2",
      "lorebook_link_enabled",
      "tracker_snapshots",
      "profile_endpoints",
      "lorebook_sections",
      "characters_name_index",
      "tracker_message_index",
      "rename_ztracker_mechanism",
      "chat_tracker_enabled",
      "drop_auth",
      "theme_aware_tracker_preset_css",
    ]);

    // Corrupt rows are untouched (sampling/prompts kept verbatim).
    expect(migratedRow(db, "bad").sampling).toBe("{not json");
    expect(migratedRow(db, "bad2").prompts).toBe('"not an array"');
    // The healthy row still migrated.
    const good = JSON.parse(migratedRow(db, "good").prompts) as Array<Record<string, unknown>>;
    expect(good[0]).toMatchObject({ id: "main", marker: "main", enabled: true });
    db.close();
  });

  it("appends every prompt of a layout-less row disabled (nothing ever rendered)", () => {
    const db = v1Db();
    insertV1Preset(db, {
      id: "p1",
      sampling: { temperature: 0.7 }, // no __suvoj_layout key
      prompts: [{ id: "x", name: "X", enabled: true }],
    });
    runMigrations(db, migrations);
    const prompts = JSON.parse(migratedRow(db, "p1").prompts) as Array<Record<string, unknown>>;
    expect(prompts).toEqual([{ id: "x", name: "X", enabled: false }]);
    db.close();
  });
});
