/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Isolate the injected closed-lorebook text from a captured JanitorAI
 * `generateAlpha` payload's system message. Faithful port of JAR's
 * `separate.js`.
 *
 * JanitorAI assembles `messages[0].content` (role: system) as:
 *   [ jailbreak / system prefix ]            <- leading bracketed block(s)
 *   <{{char}}'s Persona> ... </...Persona>   <- character card
 *   <UserPersona> ... </UserPersona>         <- user persona
 *   <Scenario> ... </Scenario>               <- roleplay setup
 *   <Example ...> ... </Example ...>         <- example dialogue
 *   <triggered lorebook entries ...>         <- everything else (what we want)
 *
 * We strip the known wrappers (tag-aware) and optionally subtract a
 * user-pasted known card / the verbatim contents of the character's PUBLIC
 * lorebooks, so only the genuinely closed entries remain. Pure — no I/O.
 */

/** One stripped chunk, labeled by what produced it. */
export interface SeparateRemoved {
  label: string;
  text: string;
}

/** The result of {@link separate}. */
export interface SeparateResult {
  /** The raw `messages[system].content`. */
  systemContent: string;
  /** The isolated closed-lorebook text. */
  lorebookText: string;
  /** Everything that was stripped, in strip order. */
  removed: SeparateRemoved[];
  /** `lorebookText` split into candidate entries (blank-line separated). */
  entries: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The `messages` array of a captured payload, as object rows. */
function asMessages(payload: unknown): Record<string, unknown>[] {
  const messages = asRecord(payload).messages;
  return Array.isArray(messages)
    ? messages.filter(
        (message): message is Record<string, unknown> =>
          !!message && typeof message === "object" && !Array.isArray(message),
      )
    : [];
}

/** Whitespace-normalized, lowercased comparison key. */
function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The captured payload's system-message content (`""` when absent). */
export function getSystemContent(payload: unknown): string {
  const sys = asMessages(payload).find((message) => message.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : "";
}

/** Remove leading bracketed jailbreak/system prefix and `<...Persona>` blocks. */
function stripWrappers(text: string): { out: string; removed: SeparateRemoved[] } {
  const removed: SeparateRemoved[] = [];
  let out = text;

  // Leading bracketed jailbreak prefix(es) at the very start of the prompt.
  out = out.replace(/^\s*(?:\[[^\]]*\]\s*)+/, (match) => {
    const trimmed = match.trim();
    if (trimmed) {
      removed.push({ label: "jailbreak", text: trimmed });
    }
    return "";
  });

  // Persona-style tag blocks: <Char's Persona>...</...Persona> and
  // <UserPersona>...</UserPersona>. Lazy match stops at the first matching close.
  out = out.replace(/<[^<>\n]*?Persona>[\s\S]*?<\/[^<>\n]*?Persona>/gi, (match) => {
    const label = /^<\s*userpersona/i.test(match) ? "userPersona" : "card";
    removed.push({ label, text: match });
    return "\n";
  });

  // Other JanitorAI scaffolding wrappers that are not lorebook content:
  // <Scenario>...</Scenario>, <Example dialogs>...</...>, etc.
  out = out.replace(/<Scenario>[\s\S]*?<\/Scenario>/gi, (match) => {
    removed.push({ label: "scenario", text: match });
    return "\n";
  });
  out = out.replace(/<Example[^<>\n]*>[\s\S]*?<\/Example[^<>\n]*>/gi, (match) => {
    removed.push({ label: "example", text: match });
    return "\n";
  });

  return { out, removed };
}

/** Drop lines from `text` that also appear (whitespace-normalized) in knownCard. */
function subtractKnownCard(text: string, knownCard: string): { out: string; removed: string[] } {
  if (!knownCard?.trim()) {
    return { out: text, removed: [] };
  }
  const known = new Set<string>();
  for (const line of knownCard.split("\n")) {
    const normalized = norm(line);
    if (normalized.length >= 12) {
      known.add(normalized);
    }
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const normalized = norm(line);
    if (normalized.length >= 12 && known.has(normalized)) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }
  return { out: kept.join("\n"), removed };
}

/**
 * Build a whitespace/punctuation-tolerant regex source from a verbatim string.
 *
 * The public-entry content is injected into `generateAlpha` verbatim, but the
 * server (and our own tidying) can change *whitespace* (collapse runs, swap
 * newlines for spaces, trim) and *glyphs* (straight vs. curly quotes/apostrophes,
 * hyphen vs. en/em dash). We match literally except that:
 *  - any whitespace run matches any other whitespace run (`\s+`),
 *  - quote/apostrophe/dash variants match each other.
 * Everything else (including regex metacharacters) is escaped to a literal.
 */
function loosePattern(needle: string): string {
  return needle
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape metachars
    .replace(/\s+/g, "\\s+") // any whitespace run
    .replace(/['‘’ʼ]/g, "['\\u2018\\u2019\\u02BC]") // ' ' ' ʼ
    .replace(/["“”]/g, '["\\u201C\\u201D]') // " " "
    .replace(/[-–—]/g, "[-\\u2013\\u2014]"); // - – —
}

/**
 * Remove PUBLIC-lorebook entry text from the isolated lorebook text.
 *
 * A character's public and closed lorebooks are injected into the SAME
 * `generateAlpha` system message, so the extracted text contains both. The
 * public entries' `content` is injected **verbatim**, so we just cut it back
 * out — no fuzzy matching, only the whitespace/glyph tolerance of
 * {@link loosePattern}. Entries that never triggered simply aren't found and
 * are skipped.
 */
function stripPublicEntries(
  text: string,
  publicContents: string[],
): { out: string; removed: string[] } {
  if (!Array.isArray(publicContents) || publicContents.length === 0) {
    return { out: text, removed: [] };
  }
  let out = text;
  const removed: string[] = [];
  for (const content of publicContents) {
    const needle = String(content || "").trim();
    if (needle.length < 12) {
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(loosePattern(needle), "gi");
    } catch {
      continue;
    }
    out = out.replace(re, (match) => {
      removed.push(match);
      return "\n";
    });
  }
  return { out, removed };
}

/** Collapse trailing spaces and big gaps, then trim. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n") // trailing spaces
    .replace(/\n{3,}/g, "\n\n") // collapse big gaps
    .trim();
}

/** Split lorebook text into candidate entry blocks (blank-line separated). */
export function splitEntries(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Pull the character-card text (inner of `<{{char}}'s Persona>…</…>`, NOT the
 * user persona) out of a captured payload. Used by auto-trigger to re-send the
 * card as a chat message so the closed lorebook fires on as many keys as
 * possible.
 */
export function extractCard(payload: unknown): string {
  const system = getSystemContent(payload);
  const re = /<([^<>\n]*?)Persona>([\s\S]*?)<\/[^<>\n]*?Persona>/gi;
  for (const match of system.matchAll(re)) {
    if (/^\s*user/i.test(match[1] ?? "")) {
      continue; // skip <UserPersona>
    }
    return (match[2] ?? "").trim();
  }
  return "";
}

/** The character name encoded in the `<{{char}}'s Persona>` opening tag. */
export function extractCharName(payload: unknown): string {
  const system = getSystemContent(payload);
  const match = system.match(/<([^<>\n]*?)Persona>/i);
  if (match) {
    const name = (match[1] ?? "").replace(/['’]s\s*$/i, "").trim();
    if (name.toLowerCase() !== "user") {
      return name;
    }
  }
  return "";
}

/** Inner text of `<Scenario>…</Scenario>` if JanitorAI injected one. */
export function extractScenario(payload: unknown): string {
  const system = getSystemContent(payload);
  const match = system.match(/<Scenario>([\s\S]*?)<\/Scenario>/i);
  return match ? (match[1] ?? "").trim() : "";
}

/** Inner text of `<Example…>…</Example…>` (example dialogue) if present. */
export function extractExample(payload: unknown): string {
  const system = getSystemContent(payload);
  const match = system.match(/<Example[^<>\n]*?>([\s\S]*?)<\/Example[^<>\n]*?>/i);
  return match ? (match[1] ?? "").trim() : "";
}

/** The bot's first message — the first assistant turn in the captured payload. */
export function extractFirstMessage(payload: unknown): string {
  const assistant = asMessages(payload).find((message) => message.role === "assistant");
  return assistant && typeof assistant.content === "string" ? assistant.content.trim() : "";
}

/**
 * Isolate the closed-lorebook text from a captured `generateAlpha` payload.
 *
 * @param payload        captured generateAlpha body (or `{ messages }`)
 * @param knownCard      optional pasted character-card text to subtract
 * @param publicContents verbatim entry contents of the character's PUBLIC
 *                       lorebooks, always subtracted so they don't leak into
 *                       the closed book
 */
export function separate(
  payload: unknown,
  knownCard = "",
  publicContents: string[] = [],
): SeparateResult {
  const systemContent = getSystemContent(payload);
  const wrappers = stripWrappers(systemContent);
  const known = subtractKnownCard(wrappers.out, knownCard);
  const publics = stripPublicEntries(known.out, publicContents);
  const lorebookText = tidy(publics.out);
  const removed = wrappers.removed.concat(
    known.removed.length ? [{ label: "knownCard", text: known.removed.join("\n") }] : [],
    publics.removed.length ? [{ label: "publicLorebook", text: publics.removed.join("\n\n") }] : [],
  );
  return {
    systemContent,
    lorebookText,
    removed,
    entries: splitEntries(lorebookText),
  };
}
