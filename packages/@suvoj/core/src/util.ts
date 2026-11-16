/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small shared helpers for the data layer: ids, timestamps, and JSON column
 * (de)serialization at the repository boundary.
 */

/** Entity ids are UUIDs. */
export function newId(): string {
  return crypto.randomUUID();
}

/** Timestamps are stored as ISO 8601 strings. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Booleans are stored as SQLite INTEGERs (0/1). */
export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Parses a JSON column; SQL NULL (or malformed text) yields `null`. */
export function parseJson<T = unknown>(text: string | null | undefined): T | null {
  if (text === null || text === undefined) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Like {@link parseJson} but returns `fallback` instead of `null`. */
export function parseJsonOr<T>(text: string | null | undefined, fallback: T): T {
  const parsed = parseJson<T>(text);
  return parsed === null ? fallback : parsed;
}

/** Serializes a JSON column value; `null`/`undefined` become SQL NULL. */
export function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

/**
 * Slug for preset prompt ids: lowercase, runs of non-alphanumerics become a
 * single hyphen, leading/trailing hyphens trimmed; `fallback` when nothing
 * remains. Preset v2 ids must be readable slugs (e.g. `anti-parrot-echo`),
 * never UUID-like strings.
 */
export function slugify(text: string, fallback = "prompt"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/**
 * Returns `candidate` unless `taken` already holds it, in which case `-2`,
 * `-3`, … are appended until a free id is found; the winner is added to
 * `taken`. Callers pre-seed `taken` with the ids that must never be
 * shadowed (the layout markers).
 */
export function uniqueSlug(candidate: string, taken: Set<string>): string {
  let slug = candidate;
  for (let suffix = 2; taken.has(slug); suffix += 1) {
    slug = `${candidate}-${suffix}`;
  }
  taken.add(slug);
  return slug;
}
