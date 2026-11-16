/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Continue-text rule — the client twin of the server's separator, so the live
 * bubble and the persisted truth agree.
 *
 * The web package cannot import the server, so this is a deliberate copy of
 * `continueSeparator` in packages/server/src/routes/generate-helpers.ts
 * (cited from SillyTavern, whose `continue_postfix` — SPACE, the default in
 * scripts/openai.js — separates a cycle prompt from its continuation and is
 * mirrored into the displayed text too). This is a refinement of that rule,
 * not an exact mirror: ST inserts the postfix whenever the previous text does
 * not end in a space, even when it is empty, whereas we also skip the
 * separator for an empty previous (nothing to break) and accept any trailing
 * whitespace (`\s$` covers space, newline, and tab) so a genuinely separated
 * pair is not given a doubled gap. Continuing "Hello!" with "Hi there" must
 * render "Hello! Hi there", never "Hello!Hi there": without the separator the
 * continuation starts mid-word, and the bubble would visibly jump when the
 * stream settles onto the stored row.
 * Keep the two helpers in sync by hand — see also lib/tracker-config.ts's
 * header for the same mirrored-value convention.
 */

/**
 * The separator a continuation prepends to the text it extends: a single
 * space unless there is nothing to separate. Empty `previous` has no word to
 * break, and one already ending in whitespace (`\s$` covers space, newline,
 * and tab) would otherwise show a doubled gap.
 */
export function continueSeparator(previous: string): string {
  return previous !== "" && !/\s$/.test(previous) ? " " : "";
}

/** The live surface's merged text: `previous` plus the separator plus the
 *  streaming continuation — the client twin of the server's in-place merge. */
export function mergeContinue(previous: string, continuation: string): string {
  return previous + continueSeparator(previous) + continuation;
}
