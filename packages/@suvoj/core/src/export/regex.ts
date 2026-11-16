/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RegexRule } from "../schema/regex";

/**
 * Native → Suvoj regex document export.
 *
 * Like the preset interchange module (and unlike the SillyTavern modules),
 * regex rules are exported in our OWN native format and re-imported by the
 * same package (see ../import/regex). The document carries the full rules —
 * id included, so a round-trip preserves identity — but no timestamps, so a
 * downloaded file can be re-imported without accumulating bookkeeping
 * fields. There is no SillyTavern regex shape to convert: ST regex scripts
 * are a different, much larger surface, so v1 is native-only.
 */

/** Marker identifying a native Suvoj regex export document. */
export const REGEX_FILE_FORMAT = "suvoj.regex";
export const REGEX_FILE_VERSION = 1;

/** The downloadable regex document: the stored rules verbatim. */
export interface RegexFile {
  format: typeof REGEX_FILE_FORMAT; // "suvoj.regex"
  version: number; // REGEX_FILE_VERSION
  rules: RegexRule[];
}

/** Builds the native regex document for a download. */
export function buildRegexFile(rules: readonly RegexRule[]): RegexFile {
  return {
    format: REGEX_FILE_FORMAT,
    version: REGEX_FILE_VERSION,
    // Copy each rule: a caller mutating the returned document must not reach
    // back into the settings store's objects.
    rules: rules.map((rule) => ({ ...rule, placement: [...rule.placement] })),
  };
}
