/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * zTracker-style tracker-response parsing: fenced-block extraction plus
 * cumulative JSON repair.
 *
 * The tracker model is asked for one ```json fenced block, but real output
 * drifts — prose around the block, smart quotes, trailing commas, repeated
 * fences. The strategy (mirroring the zTracker extension):
 *
 * 1. extract the fenced block (```json … ```, case-insensitive lang tag, or
 *    a bare fence); without one, the whole raw string is the candidate;
 * 2. `JSON.parse`; on failure apply repair steps CUMULATIVELY (each step
 *    transforms the previous state and re-parses; first success wins):
 *    (a) line-ending normalization, (b) BOM/zero-width stripping at the
 *    edges, (c) repeated full-fence stripping, (d) balanced-brace substring
 *    extraction, (e) smart-quote normalization outside string literals,
 *    (f) trailing-comma removal, (g) quoting bare string values;
 * 3. the result must be a non-null, non-array object — otherwise throw.
 *
 * Steps (d)–(g) share a string/escape-state-aware scanner: braces inside
 * string literals never affect the balance, and smart quotes inside string
 * literals always survive verbatim.
 */

/** Opening fence: ``` plus optional `json` lang tag (any case) + newline. */
const FENCE_OPEN = /```[ \t]*(?:json)?[ \t]*(?:\r?\n|$)/i;

/** A full fence wrapper around the entire candidate (stripped repeatedly). */
const FENCE_WRAPPER = /^```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i;

/** BOM and zero-width characters stripped from the candidate's edges. */
const EDGE_INVISIBLE = /^[\uFEFF\u200B\u200C\u200D]+|[\uFEFF\u200B\u200C\u200D]+$/g;

/** Smart double quotes normalized to `"` outside string literals. */
const SMART_QUOTES = new Set(["\u201C", "\u201D", "\u201E", "\u201F"]);

/** True for plain JSON objects (what a tracker snapshot must be). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** (1) The first complete fenced block, or null when there is none. */
function extractFencedBlock(raw: string): string | null {
  const open = FENCE_OPEN.exec(raw);
  if (!open) {
    return null;
  }
  const start = open.index + open[0].length;
  const close = raw.indexOf("```", start);
  if (close === -1) {
    return null;
  }
  return raw.slice(start, close);
}

/** (a) Normalizes CRLF / CR line endings to LF. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** (b) Strips BOM / zero-width characters from the edges. */
function stripEdgeInvisibles(text: string): string {
  return text.replace(EDGE_INVISIBLE, "");
}

/** (c) Strips repeated full-fence wrappers, outermost first. */
function stripRepeatedFences(text: string): string {
  let current = text;
  for (;;) {
    const match = FENCE_WRAPPER.exec(current);
    if (!match || match[1] === undefined) {
      return current;
    }
    current = match[1];
  }
}

/**
 * (d) The substring from the first `{` to its matching close — braces inside
 * string literals do not count. Unmatched (no `{`, or never closing) leaves
 * the text unchanged.
 */
function extractBalancedObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    return text;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return text;
}

/**
 * (e) Smart double quotes (U+201C/201D/201E/201F) become `"` — only outside
 * string literals, so smart quotes inside string values survive verbatim.
 * A replaced quote does NOT open a string: the scanner only tracks `"`
 * delimiters, which keeps `{"a": “hi”}` → `{"a": "hi"}` correct.
 */
function normalizeSmartQuotes(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += SMART_QUOTES.has(ch) ? '"' : ch;
  }
  return out;
}

/** (f) Removes `,` directly followed (modulo whitespace) by `}` or `]`. */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && " \t\r\n".includes(text.charAt(j))) {
        j += 1;
      }
      const next = text.charAt(j);
      if (next === "}" || next === "]") {
        continue; // drop the comma (the whitespace after it survives)
      }
    }
    out += ch;
  }
  return out;
}

/**
 * (g) Quotes bare string values — the `"name": Lisbon` drift.
 *
 * Models occasionally omit the quotes around a value while keeping the keys
 * quoted (`"name": Lisbon`, `"knownCast": [Mira, Kael]`), which `JSON.parse`
 * rejects as `Unexpected identifier "Lisbon"`. The scanner walks the document
 * outside string literals, and only in a VALUE position (after `:` or a
 * comma inside an array) wraps a bare run in quotes. JSON literals
 * (`true`/`false`/`null`), numbers, and containers are left alone, and the
 * run may contain spaces or a colon (so `Lisbon, Portugal` only splits at the
 * comma — a known limit, but the common single-word case is fixed).
 */
function quoteUnquotedValues(text: string): string {
  let out = "";
  const stack: Array<"{" | "["> = [];
  let expectValue = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        const c = text.charAt(i);
        if (c === "\\") {
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') {
          break;
        }
      }
      out += text.slice(start, i);
      expectValue = false;
      continue;
    }
    if (ch === "{") {
      stack.push("{");
      expectValue = false;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      stack.push("[");
      expectValue = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      expectValue = false;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ":") {
      expectValue = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      // A comma inside an array starts the next value; inside an object it
      // starts the next KEY, which this repair must not quote.
      expectValue = stack[stack.length - 1] === "[";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }
    if (!expectValue) {
      out += ch;
      i += 1;
      continue;
    }

    // A bare value: spaces belong to it (`Lisbon Portugal`); a comma, a
    // closing bracket, or a newline ends it.
    const start = i;
    while (i < text.length && !",}]\n\r".includes(text.charAt(i))) {
      i += 1;
    }
    const raw = text.slice(start, i);
    const value = raw.trimEnd();
    const isLiteral =
      value === "true" ||
      value === "false" ||
      value === "null" ||
      /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
    if (value === "" || isLiteral) {
      out += raw;
    } else {
      out += `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      // Keep the whitespace that sat between the value and its delimiter.
      out += raw.slice(value.length);
    }
    expectValue = false;
  }
  return out;
}

/** The ordered repair pipeline; each step feeds the next. */
const REPAIRS: ReadonlyArray<(text: string) => string> = [
  normalizeLineEndings,
  stripEdgeInvisibles,
  stripRepeatedFences,
  extractBalancedObject,
  normalizeSmartQuotes,
  removeTrailingCommas,
  quoteUnquotedValues,
];

/**
 * Extracts the first JSON object from a model response, tolerating fences,
 * surrounding prose, smart quotes, trailing commas, and other common drift.
 * Throws `Error("Failed to parse JSON object: …")` when nothing yields a
 * non-null, non-array object — the message carries the FIRST parse error seen
 * along the way.
 *
 * Generic enough for any JSON-mode prompt (the character-seed generator uses
 * it too); the tracker wrapper below keeps its historical error prefix.
 */
export function parseJsonObject(raw: string): Record<string, unknown> {
  let firstError: string | null = null;

  const attempt = (text: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      if (isPlainObject(value)) {
        return value;
      }
      if (firstError === null) {
        firstError = "response is not a JSON object";
      }
    } catch (error) {
      if (firstError === null) {
        firstError = error instanceof Error ? error.message : String(error);
      }
    }
    return undefined;
  };

  let text = extractFencedBlock(raw) ?? raw;
  let parsed = attempt(text);
  if (parsed !== undefined) {
    return parsed;
  }
  for (const repair of REPAIRS) {
    text = repair(text);
    parsed = attempt(text);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new Error(`Failed to parse JSON object: ${firstError ?? "no JSON object found"}`);
}

/**
 * Parses a tracker model response into the tracker data object. Throws
 * `Error("Failed to parse tracker response: …")` when nothing yields a
 * non-null, non-array JSON object — the message carries the FIRST parse
 * error seen along the way.
 */
export function parseTrackerResponse(raw: string): Record<string, unknown> {
  try {
    return parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse tracker response: ${message.replace("Failed to parse JSON object: ", "")}`,
    );
  }
}
