/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Greeting-list helpers for the character editor.
 *
 * The stored character shape keeps the default greeting in `first_mes` and the
 * extras in `alternate_greetings`, but the editor shows ONE ordered list of
 * cards so the user can reorder freely — card 0 IS the default. These functions
 * are the two directions of that fold: `greetingsFromCharacter` unfolds the
 * stored fields into the editor's list, `greetingFields` folds an edited list
 * back into the fields on save. `moveGreeting` is the list's reorder step.
 *
 * Everything here is pure, DOM-free and non-mutating, mirroring the role of
 * lib/lorebook-sections.ts and lib/tracker-config.ts: the editor holds the
 * state, these functions only compute.
 */

/** One greeting card in the editor's ordered list: index 0 is the default
 *  (the character's `first_mes`), the rest are the alternates. */
export type GreetingList = string[];

/** The editor's ordered greeting list from a character's stored fields:
 *  the default first, then the alternates in stored order. */
export function greetingsFromCharacter(input: {
  first_mes: string;
  alternate_greetings: string[];
}): string[] {
  // The default must stay exactly as stored (no trim): it is what the server
  // sends verbatim, and an empty one still renders the always-present card 0.
  return [input.first_mes, ...input.alternate_greetings];
}

/** Splits an edited greeting list back into the two stored fields.
 *  Blank/whitespace-only cards are dropped (the server would ignore them);
 *  the FIRST remaining card becomes `first_mes` and the rest become
 *  `alternate_greetings`. An all-blank list leaves `first_mes` empty and no
 *  alternates. Trims each kept card. */
export function greetingFields(list: string[]): {
  first_mes: string;
  alternate_greetings: string[];
} {
  const kept = list.map((greeting) => greeting.trim()).filter((greeting) => greeting !== "");
  // The list is ordered — whatever card sits first becomes the default, which
  // is what makes reordering a card to the top change `first_mes`.
  return {
    first_mes: kept[0] ?? "",
    alternate_greetings: kept.slice(1),
  };
}

/** Immutably moves `from` to `to`. Out-of-range indices or a no-op move
 *  return the SAME array reference unchanged. */
export function moveGreeting(list: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const next = [...list];
  const moved = next.splice(from, 1)[0];
  if (moved === undefined) {
    return list; // unreachable after the bounds check; keeps `moved` meaningful
  }
  next.splice(to, 0, moved);
  return next;
}
