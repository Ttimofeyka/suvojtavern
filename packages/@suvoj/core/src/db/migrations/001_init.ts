/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 001 — initial schema.
 *
 * Conventions: TEXT ids (UUIDs), ISO 8601 timestamps, JSON stored as TEXT
 * and (de)serialized at the repository boundary. `messages.variant_of` /
 * `active` implement swipes (sibling rows share the id of the group's first
 * variant; one sibling per group is active). `chats.branch_root_id` /
 * `active_branch` implement branching (see ChatsRepository.forkChat).
 * `lorebook_entries.extra` preserves any ST fields not mapped to columns so
 * imports stay lossless.
 */
export const migration001Init: Migration = {
  id: 1,
  name: "init",
  up: (db) => {
    db.exec(`
      CREATE TABLE characters (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        personality TEXT NOT NULL DEFAULT '',
        scenario TEXT NOT NULL DEFAULT '',
        first_mes TEXT NOT NULL DEFAULT '',
        mes_example TEXT NOT NULL DEFAULT '',
        creator_notes TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        post_history_instructions TEXT NOT NULL DEFAULT '',
        alternate_greetings TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        avatar_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        card_raw TEXT
      );

      CREATE TABLE character_images (
        id TEXT PRIMARY KEY NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        blob_path TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE personas (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chats (
        id TEXT PRIMARY KEY NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id),
        persona_id TEXT REFERENCES personas(id),
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        branch_root_id TEXT,
        active_branch TEXT
      );

      CREATE INDEX idx_chats_character ON chats (character_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
        name TEXT,
        content TEXT NOT NULL,
        variant_of TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_messages_chat_seq ON messages (chat_id, seq);
      CREATE INDEX idx_messages_variant_of ON messages (variant_of);

      CREATE TABLE lorebooks (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE lorebook_entries (
        id TEXT PRIMARY KEY NOT NULL,
        lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
        keys TEXT NOT NULL DEFAULT '[]',
        secondary TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL DEFAULT '',
        comment TEXT,
        constant INTEGER NOT NULL DEFAULT 0,
        selective INTEGER NOT NULL DEFAULT 0,
        logic INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 100,
        position INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL DEFAULT 4,
        role TEXT,
        probability INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        sticky INTEGER NOT NULL DEFAULT 0,
        cooldown INTEGER NOT NULL DEFAULT 0,
        delay INTEGER NOT NULL DEFAULT 0,
        vectorized INTEGER NOT NULL DEFAULT 0,
        case_sensitive INTEGER NOT NULL DEFAULT 0,
        match_whole_words INTEGER NOT NULL DEFAULT 1,
        scan_depth INTEGER,
        "group" TEXT,
        group_weight INTEGER,
        recursion TEXT,
        match_fields TEXT,
        character_filter TEXT,
        display_index INTEGER NOT NULL DEFAULT 0,
        extra TEXT
      );

      CREATE INDEX idx_lorebook_entries_book ON lorebook_entries (lorebook_id);

      CREATE TABLE character_lorebooks (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
        PRIMARY KEY (character_id, lorebook_id)
      );

      CREATE TABLE summaries (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        level INTEGER NOT NULL,
        seq_from INTEGER NOT NULL,
        seq_to INTEGER NOT NULL,
        summary TEXT NOT NULL,
        tokens INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_summaries_chat ON summaries (chat_id, level, seq_from);

      CREATE TABLE presets (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        sampling TEXT NOT NULL DEFAULT '{}',
        prompts TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE auth (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE variables (
        scope TEXT NOT NULL,
        scope_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, key)
      );
    `);
  },
};
