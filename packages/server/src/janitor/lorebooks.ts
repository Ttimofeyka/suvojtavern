/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character, Lorebook, LorebookEntryInput } from "@suvoj/core";
import { st } from "@suvoj/core";
import type { Repos } from "../routes-deps";
import type { JanitorView } from "./browser";
import { fetchLorebookDescription, fetchLorebookScript } from "./client";
import { messageOf } from "./errors";

/**
 * Public-lorebook handling shared by both janitor phases.
 *
 * Reading and persisting are deliberately separate: Phase B must know the
 * public books' verbatim entry contents (to subtract them from the captured
 * closed-lorebook text) *before* the character exists, yet the imported books
 * can only be attached to a character row that has been created. So
 * {@link readLorebooks} fetches + parses everything into memory, and
 * {@link persistLorebooks} writes it once the character id is known.
 *
 * A character's `scripts` can be:
 *  - a downloadable public book — `/hampter/script/:id` yields a JSON entries
 *    array → import it as a native lorebook ("imported");
 *  - an "advanced"/Nine API book — the record's `script` is JavaScript source,
 *    not entries → "js" (a rebuild concern, not handled here);
 *  - a book we cannot download (private, or a closed book that never surfaces
 *    a record) → "closed"; Phase B rebuilds these from the captured prompt.
 *
 * One bad book never fails the character import: its failure becomes a warning.
 */

/** Per-book outcome reported in {@link JanitorImportResult.lorebooks}. */
export type JanitorLorebookStatus = "imported" | "closed" | "empty" | "js";

export interface JanitorLorebookOutcome {
  /** The imported lorebook row id, or the source script id for closed/js/empty. */
  id: string;
  title: string;
  status: JanitorLorebookStatus;
  /** Entry count, present only for "imported". */
  entries?: number;
}

/** A ref that could not be downloaded, kept for the closed-lorebook rebuild. */
export interface ClosedLorebookRef {
  ref: st.JanitorLorebookRef;
  /** The outcome already placed in `scan.outcomes` (updated in place on rebuild). */
  outcome: JanitorLorebookOutcome;
}

export interface LorebookScan {
  outcomes: JanitorLorebookOutcome[];
  /** The first imported book row — the result's `lorebook`. */
  first: Lorebook | null;
  warnings: string[];
  /** Verbatim contents of imported public entries (subtracted from closed text). */
  publicContents: string[];
  /** Refs that could not be downloaded (Phase B rebuild candidates). */
  closed: ClosedLorebookRef[];
}

/** A parsed book, before any repository writes. */
export type ReadLorebookItem =
  | {
      kind: "entries";
      ref: st.JanitorLorebookRef;
      title: string;
      description: string;
      entries: LorebookEntryInput[];
    }
  | { kind: "js"; ref: st.JanitorLorebookRef; title: string }
  | { kind: "empty"; ref: st.JanitorLorebookRef; title: string };

export interface LorebookRead {
  items: ReadLorebookItem[];
  /** Verbatim contents of every public entry (for `separate()`). */
  publicContents: string[];
  warnings: string[];
  /** Refs that yielded no downloadable record (closed-book candidates). */
  closed: st.JanitorLorebookRef[];
}

/** An empty read, used when lorebook handling is opted out. */
export function emptyLorebookRead(): LorebookRead {
  return { items: [], publicContents: [], warnings: [], closed: [] };
}

/**
 * Fetch and parse every attached lorebook ref in the caller's browser session.
 * Never throws: a failed fetch is recorded as a warning (and as a closed ref).
 */
export async function readLorebooks(
  view: JanitorView,
  refs: st.JanitorLorebookRef[],
): Promise<LorebookRead> {
  const read = emptyLorebookRead();
  for (const ref of refs) {
    const fallbackTitle = ref.title || `JanitorAI lorebook ${ref.id}`;
    let record: unknown | null;
    try {
      record = await fetchLorebookScript(view, ref.id);
    } catch (err) {
      // fetchLorebookScript already swallows its own failures; this is belt
      // and braces so a future throwing helper cannot sink the whole import.
      read.warnings.push(`lorebook "${fallbackTitle}" could not be read: ${messageOf(err)}`);
      record = null;
    }
    if (record === null) {
      read.closed.push(ref);
      continue;
    }
    const script = st.janitorScriptEntries(record);
    const title = script.title || fallbackTitle;
    if (script.isJs) {
      read.items.push({ kind: "js", ref, title });
      continue;
    }
    // JAR's buildWorldInfo drops entries with empty content, so a book whose
    // entries are all empty is "empty" rather than a book full of blank rows.
    const entries = script.entries.filter((entry) => String(entry.content ?? "").trim() !== "");
    if (entries.length === 0) {
      read.items.push({ kind: "empty", ref, title });
      continue;
    }
    for (const entry of entries) {
      read.publicContents.push(entry.content ?? "");
    }
    // The real description lives on the lorebook's public /scripts page; the
    // /hampter record's is usually empty. Fall back to the record, then a default.
    const pageDescription = await fetchLorebookDescription(view, ref.id);
    read.items.push({
      kind: "entries",
      ref,
      title,
      description: pageDescription || script.description || "Imported from JanitorAI",
      entries,
    });
  }
  return read;
}

/** Write a {@link LorebookRead} into the repositories, attached to `character`. */
export function persistLorebooks(
  read: LorebookRead,
  repos: Repos,
  character: Pick<Character, "id" | "name">,
): LorebookScan {
  const scan: LorebookScan = {
    outcomes: [],
    first: null,
    warnings: [...read.warnings],
    publicContents: [...read.publicContents],
    closed: [],
  };
  for (const item of read.items) {
    if (item.kind === "js") {
      scan.outcomes.push({ id: item.ref.id, title: item.title, status: "js" });
      continue;
    }
    if (item.kind === "empty") {
      scan.outcomes.push({ id: item.ref.id, title: item.title, status: "empty" });
      continue;
    }
    const book = repos.lorebooks.create({ name: item.title, description: item.description });
    repos.lorebooks.replaceEntries(book.id, item.entries);
    repos.lorebooks.attachToCharacter(character.id, book.id);
    if (scan.first === null) scan.first = book;
    scan.outcomes.push({
      id: book.id,
      title: book.name,
      status: "imported",
      entries: item.entries.length,
    });
  }
  for (const ref of read.closed) {
    const outcome: JanitorLorebookOutcome = {
      id: ref.id,
      title: ref.title || `JanitorAI lorebook ${ref.id}`,
      status: "closed",
    };
    scan.outcomes.push(outcome);
    scan.closed.push({ ref, outcome });
  }
  return scan;
}
