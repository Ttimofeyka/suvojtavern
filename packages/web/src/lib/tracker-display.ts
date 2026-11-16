/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display-only normalization for tracker snapshot values: the tracker model
 * often returns all-lowercase prose ("alice", "blue cotton shirt"), which the
 * card renders verbatim. Capitalize the first letter of a string when it looks
 * like prose: it starts with a lowercase letter (Unicode-aware, so "école" →
 * "École"), carries no uppercase letter anywhere, and contains none of "@",
 * "/", "\" or ":" — those mark URLs, emails, file paths/slugs and "scheme:"
 * forms, which must survive verbatim (and a "n/a"-style value keeps its
 * lowercase on purpose). Any string with an uppercase letter is left as-is, so
 * proper nouns, acronyms ("N/A") and camel case ("iPhone") stay intact.
 * Recurses into arrays and plain objects; keys, numbers, booleans, null and
 * undefined pass through unchanged. Pure: never mutates its input.
 */

/** Capitalizes `text` only when it is prose-like and all-lowercase. */
function capitalize(text: string): string {
  // Prose guard: "@"/"/"/"\"/":" mark URLs, emails, paths and "scheme:" forms,
  // none of which are prose. The lowercase-lead / any-uppercase pair is
  // Unicode-aware: "école" capitalizes while "N/A" and "iPhone" stay as-is.
  if (/^\p{Ll}/u.test(text) && !/\p{Lu}/u.test(text) && !/[@/\\:]/.test(text)) {
    // slice, not charAt: a leading astral/surrogate pair must not be split.
    return text.slice(0, 1).toUpperCase() + text.slice(1);
  }
  return text;
}

/** Recursively normalizes one value (strings, arrays and plain objects). */
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    return capitalize(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = normalize(child);
    }
    return out;
  }
  return value;
}

/** Returns a display-ready copy of a snapshot's data (input left untouched). */
export function capitalizeSnapshot(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = normalize(value);
  }
  return out;
}
