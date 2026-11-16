/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { VariablesRepository } from "../repositories/kv";

/**
 * SillyTavern-compatible macro engine.
 *
 * Supported macros (names are case-insensitive, like ST):
 * `{{char}}`, `{{user}}`, `{{persona}}`, `{{time}}`, `{{isotime}}`,
 * `{{date}}`, `{{isodate}}`, `{{weekday}}`, `{{idle_duration}}`,
 * `{{lastMessage}}`, `{{random:a,b,c}}`, `{{pick:a,b,c}}`, `{{roll}}`,
 * `{{roll:NdM}}`, `{{roll:X-Y}}`, `{{setvar::name::value}}`,
 * `{{getvar::name}}` (with optional `::default`), `{{addvar::name::value}}`,
 * `{{incvar::name}}`, `{{decvar::name}}`, `{{newline}}`, `{{trim}}`,
 * `{{noop}}`, `{{ui:<controlId>}}` (a preset UI control's chosen value),
 * `{{#has:<tag>}}…{{/has}}` / `{{^has:<tag>}}…{{/has}}` (presence-conditional
 * blocks) and `{{//comment}}` (removed).
 *
 * `{{#has:<tag>}}` renders its contents only when some ENABLED preset block
 * defines the XML tag `<tag>…</tag>` (see {@link extractDefinedTags});
 * `{{^has:<tag>}}` renders only when none does. An unrendered block disappears
 * entirely — contents included — so an instruction block can reference optional
 * machinery (a banned-word list, a graphics protocol, a voice block) without
 * leaving a dangling reference to a tag the model never receives, and without
 * spending tokens on it. A block stays verbatim when the condition cannot be
 * resolved because the context carries no {@link MacroContext.definedTags}
 * list, like any other unknown macro, so nothing is ever blanked silently by a
 * caller that did not resolve the set.
 *
 * Variables write through the {@link VariablesRepository}: when the context
 * carries a `chatId`, writes land in the chat scope and reads fall back from
 * chat scope to global; otherwise everything uses the global scope.
 *
 * Unknown macros are left in the text verbatim (ST behavior). `{{getvar}}` of
 * an unset variable evaluates to the empty string (ST behavior), or to the
 * provided default in the `{{getvar::name::default}}` form.
 */

/** Context needed to evaluate macros against a chat. */
export interface MacroContext {
  /** Character name ({{char}}). */
  char: string;
  /** User/persona display name ({{user}}). */
  user: string;
  /** Persona description text ({{persona}}). */
  persona?: string;
  /** Present → variables use the chat scope (with global fallback). */
  chatId?: string;
  /** Scoped variable store — the same store chat hooks use. */
  vars: VariablesRepository;
  /** RNG for `{{random}}` / `{{roll}}` (defaults to `Math.random`). */
  rng?: () => number;
  /**
   * Stable seed for `{{roll}}` — the generation target's message position.
   * When set, the same text + occurrence rolls the same value on every build
   * of that target, so a regenerate and its sibling swipes share the number.
   * Omitted keeps `{{roll}}` random (the legacy behavior).
   */
  rollSeed?: string | number;
  /** "Now" for time macros (defaults to the current time). */
  now?: Date;
  /** Content of the most recent chat message ({{lastMessage}}). */
  lastMessage?: string;
  /** When the last user message happened ({{idle_duration}}). */
  lastMessageAt?: Date | null;
  /** Resolved preset control values, read by `{{ui:<controlId>}}`. */
  ui?: Readonly<Record<string, string>>;
  /**
   * XML tag names (lowercased) the enabled preset blocks define — the names
   * `{{#has:<tag>}}` tests. `undefined` means "not resolved": conditional
   * blocks then stay verbatim instead of being silently dropped. An EMPTY set
   * is a resolved answer (no optional block is on), so every conditional
   * collapses.
   */
  definedTags?: ReadonlySet<string>;
}

const MACRO_PATTERN = /\{\{([^{}]*)\}\}/g;

/** FNV-1a string hash — cheap, stable seeds for `{{pick}}`. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
function seededRng(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** e.g. "3:45 PM" */
function formatTime(date: Date): string {
  const hours24 = date.getHours();
  const period = hours24 < 12 ? "AM" : "PM";
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours}:${twoDigits(date.getMinutes())} ${period}`;
}

/** e.g. "September 4, 2026" */
function formatDate(date: Date): string {
  const month = MONTHS[date.getMonth()] ?? "?";
  return `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/** e.g. "2026-09-04" */
function formatIsoDate(date: Date): string {
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  return `${date.getFullYear()}-${month}-${day}`;
}

/** e.g. "15:45" */
function formatIsoTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** Humanized duration like "3 minutes" / "2 hours" (moment-like). */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) {
    return "a few seconds";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 45) {
    return minutes <= 1 ? "a minute" : `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 22) {
    return hours <= 1 ? "an hour" : `${hours} hours`;
  }
  const days = Math.floor(hours / 24);
  if (days < 26) {
    return days <= 1 ? "a day" : `${days} days`;
  }
  const months = Math.floor(days / 30);
  if (months < 11) {
    return months <= 1 ? "a month" : `${months} months`;
  }
  const years = Math.floor(days / 365);
  return years <= 1 ? "a year" : `${years} years`;
}

/** Placeholder protecting escaped commas while splitting a macro list. */
const ESCAPED_COMMA = "";

/** Splits a `random`/`pick` list: `::`-separated, else commas (ST rule). */
function splitMacroList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  if (trimmed.includes("::")) {
    return trimmed.split("::");
  }
  return trimmed
    .replace(/\\,/g, ESCAPED_COMMA)
    .split(",")
    .map((item) => item.trim().replaceAll(ESCAPED_COMMA, ","));
}

/** Parses `NdM` / `X-Y` / `N` roll arguments. `null` when malformed. */
function rollFormula(formula: string, rng: () => number): (() => number) | null {
  const trimmed = formula.trim();
  if (trimmed === "") {
    return () => 1 + Math.floor(rng() * 20);
  }
  const dice = /^(\d*)d(\d+)$/i.exec(trimmed);
  if (dice) {
    const count = Math.min(Number(dice[1] === "" ? "1" : dice[1]) || 1, 1000);
    const sides = Number(dice[2]) || 1;
    return () => {
      let total = 0;
      for (let i = 0; i < count; i++) {
        total += 1 + Math.floor(rng() * sides);
      }
      return total;
    };
  }
  const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(trimmed);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    const min = Math.min(low, high);
    const max = Math.max(low, high);
    return () => min + Math.floor(rng() * (max - min + 1));
  }
  if (/^\d+$/.test(trimmed)) {
    const sides = Number(trimmed);
    return () => 1 + Math.floor(rng() * sides);
  }
  return null;
}

/** Variable scope used by the context: chat scope when a chatId is present. */
function varScope(ctx: MacroContext): { scope: "chat" | "global"; scopeId: string | null } {
  return ctx.chatId === undefined || ctx.chatId === null
    ? { scope: "global", scopeId: null }
    : { scope: "chat", scopeId: ctx.chatId };
}

/** Reads a variable: chat scope first (when scoped), then global. */
function readVar(ctx: MacroContext, name: string): unknown {
  const { scope, scopeId } = varScope(ctx);
  if (scope === "chat") {
    const own = ctx.vars.get<unknown>("chat", scopeId, name);
    if (own !== null && own !== undefined) {
      return own;
    }
  }
  return ctx.vars.get<unknown>("global", null, name);
}

function writeVar(ctx: MacroContext, name: string, value: unknown): void {
  const { scope, scopeId } = varScope(ctx);
  ctx.vars.set(scope, scopeId, name, value);
}

/** Coerces a stored variable to its macro string form. */
function varToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** `{{addvar}}` semantics: numeric add when both sides parse, else concat. */
function addVar(ctx: MacroContext, name: string, value: string): string {
  const current = readVar(ctx, name);
  const currentNumber = Number(current ?? 0);
  const valueNumber = Number(value);
  let result: string;
  if (
    current !== null &&
    current !== undefined &&
    current !== "" &&
    !Number.isNaN(currentNumber) &&
    !Number.isNaN(valueNumber)
  ) {
    result = String(currentNumber + valueNumber);
  } else {
    result = varToString(current) + value;
  }
  writeVar(ctx, name, result);
  return result;
}

/** Matches one opening `<tag …>` (attributes allowed). */
const TAG_OPEN_PATTERN = /<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^>]*)?>/g;
/** Matches one closing `</tag>`. */
const TAG_CLOSE_PATTERN = /<\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*>/g;
/** A `{{// … }}` author comment (no braces inside, like any macro body). */
const COMMENT_PATTERN = /\{\{\/\/[^{}]*\}\}/g;
/** `{{#has:…}}` / `{{^has:…}}` / `{{/has}}`: presence-conditional delimiters. */
const HAS_GATE_PATTERN = /\{\{([#^]has:[^{}]*|\/has)\}\}/gi;

/**
 * The XML tags a block of prompt text DEFINES: names appearing both as an
 * opening `<tag …>` and a closing `</tag>`. A bare mention — `<npc_voice>`
 * cited inside an instruction, or the escaped `` \`<npc_voice>\` `` form the
 * Frankenstein CoT blocks use — never counts, so a reference can never be
 * mistaken for a definition. Author comments are stripped first: a
 * commented-out example is not part of the prompt. Names come back
 * lowercased, matching {@link MacroContext.definedTags}.
 */
export function extractDefinedTags(text: string): Set<string> {
  const tags = new Set<string>();
  if (text === "" || !text.includes("<")) {
    return tags;
  }
  const source = text.replace(COMMENT_PATTERN, "");
  const opened = new Set<string>();
  for (const match of source.matchAll(TAG_OPEN_PATTERN)) {
    const name = match[1]?.toLowerCase();
    // A self-closing `<br />` opens nothing, so it can never pair.
    if (name !== undefined && !match[0].trimEnd().endsWith("/>")) {
      opened.add(name);
    }
  }
  if (opened.size === 0) {
    return tags;
  }
  for (const match of source.matchAll(TAG_CLOSE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && opened.has(name)) {
      tags.add(name);
    }
  }
  return tags;
}

/**
 * The tags defined by the ENABLED rows of a preset — the set
 * `{{#has:<tag>}}` tests against. Rows are the ones generation would actually
 * render, so a block switched off (a banned-word list, a graphics protocol)
 * contributes nothing and its references collapse. Slots carry no editable text
 * of their own, and depth injections still render, so both count here.
 */
export function presetDefinedTags(prompts: ReadonlyArray<{ enabled: boolean; content: string }>): {
  definedTags: Set<string>;
} {
  const definedTags = new Set<string>();
  for (const prompt of prompts) {
    if (!prompt.enabled) {
      continue;
    }
    for (const tag of extractDefinedTags(prompt.content)) {
      definedTags.add(tag);
    }
  }
  return { definedTags };
}

/**
 * Locates the `{{/has}}` closing the `{{#has:…}}` whose opening token ended at
 * `from`, honoring nesting. Returns the inner content's end (the closing
 * token's start) and the position past the closing token, or `null` when the
 * block is unbalanced — an unbalanced block is left verbatim rather than
 * swallowing the rest of the prompt.
 */
function findHasBlock(text: string, from: number): { contentEnd: number; end: number } | null {
  const scanner = new RegExp(HAS_GATE_PATTERN.source, "gi");
  scanner.lastIndex = from;
  let depth = 1;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    const token = match[1] ?? "";
    if (token.startsWith("#") || token.startsWith("^")) {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return { contentEnd: match.index, end: scanner.lastIndex };
    }
  }
  return null;
}

interface ParsedMacro {
  name: string;
  /** Text after the first `:` / `::` separator (already normalized). */
  args: string;
}

/** Splits a macro body into lowercase name + raw args. */
function parseMacro(body: string): ParsedMacro {
  const colon = body.indexOf(":");
  if (colon === -1) {
    return { name: body.trim().toLowerCase(), args: "" };
  }
  let args = body.slice(colon + 1);
  if (args.startsWith(":")) {
    args = args.slice(1);
  }
  return { name: body.slice(0, colon).trim().toLowerCase(), args };
}

/**
 * Macro names whose value changes on every build: the clock (`{{time}}`,
 * `{{date}}`, `{{isotime}}`, `{{isodate}}`, `{{weekday}}`), the gap since the
 * last turn (`{{idle_duration}}`), the newest message (`{{lastMessage}}`), and
 * the RNG-backed forms (`{{random}}`, `{{roll}}`).
 *
 * `{{pick}}` is deliberately absent: it seeds a deterministic PRNG from the
 * chat id, the text, and the occurrence index, so it renders the same value
 * on every build of the same prompt. `{{getvar}}` is absent too — a variable
 * only changes when something writes it, which is an authored decision rather
 * than an unavoidable per-turn change.
 */
export const VOLATILE_MACRO_NAMES: readonly string[] = [
  "time",
  "isotime",
  "date",
  "isodate",
  "weekday",
  "idle_duration",
  "lastmessage",
  "random",
  "roll",
];

const VOLATILE_MACROS = new Set(VOLATILE_MACRO_NAMES);

/**
 * The volatile macros `text` evaluates, in first-appearance order, lowercased
 * and deduplicated. Used by the preset editor to warn that a block rendering
 * BEFORE the chat history defeats provider-side prefix caching: the prefix
 * changes every turn, so nothing after it can be reused.
 */
export function volatileMacrosIn(text: string): string[] {
  const found = new Set<string>();
  if (!text.includes("{{")) {
    return [];
  }
  MACRO_PATTERN.lastIndex = 0;
  for (let match = MACRO_PATTERN.exec(text); match !== null; match = MACRO_PATTERN.exec(text)) {
    const name = parseMacro(match[1] ?? "").name;
    if (VOLATILE_MACROS.has(name)) {
      found.add(name);
    }
  }
  return [...found];
}

/**
 * Replaces every macro in `text`. Single pass over one precompiled regex —
 * macro side effects (`{{setvar}}` …) become visible to later macros in the
 * same string, matching ST's sequential substitution.
 */
export function evaluateMacros(text: string, ctx: MacroContext): string {
  if (!text.includes("{{")) {
    return text;
  }
  const now = ctx.now ?? new Date();
  const rng = ctx.rng ?? Math.random;
  const chatId = ctx.chatId ?? "";
  let occurrence = 0;
  let out = "";
  let cursor = 0;

  MACRO_PATTERN.lastIndex = 0;
  for (let match = MACRO_PATTERN.exec(text); match !== null; match = MACRO_PATTERN.exec(text)) {
    const body = match[1] ?? "";
    const raw = match[0];

    // Comments: `{{// ...}}` disappears entirely.
    if (body.startsWith("//")) {
      out += text.slice(cursor, match.index);
      cursor = MACRO_PATTERN.lastIndex;
      occurrence += 1;
      continue;
    }

    const { name, args } = parseMacro(body);

    // Presence-conditional block: `{{#has:<tag>}}…{{/has}}` (render when the
    // tag is defined) or `{{^has:<tag>}}…{{/has}}` (render when it is NOT).
    // The whole span — delimiters and contents — is consumed here, so a block
    // whose condition fails costs exactly zero prompt tokens. Its contents are
    // evaluated RECURSIVELY only when the condition holds, which keeps
    // `{{char}}` & co. working inside a kept block; a dropped block is skipped
    // without evaluation (no `setvar` side effects from text the model never
    // sees). An unresolvable tag (no `definedTags` on the context, or an
    // unbalanced block) stays verbatim, like any unknown macro.
    if (name === "#has" || name === "^has") {
      const tag = args.trim().toLowerCase();
      const closing = findHasBlock(text, MACRO_PATTERN.lastIndex);
      if (closing !== null && ctx.definedTags !== undefined) {
        const present = ctx.definedTags.has(tag);
        out += text.slice(cursor, match.index);
        if (name === "#has" ? present : !present) {
          // Recursive: `MACRO_PATTERN` is module-level and stateful, but the
          // nested pass resets and advances it; `lastIndex` is overwritten
          // with the block's end below, so the outer scan resumes correctly.
          out += evaluateMacros(text.slice(MACRO_PATTERN.lastIndex, closing.contentEnd), ctx);
        }
        MACRO_PATTERN.lastIndex = closing.end;
        cursor = closing.end;
        occurrence += 1;
        continue;
      }
    }

    // A stray `{{/has}}` with no opening token: dropped as a delimiter, but
    // only once the tag set is resolved — an unresolved context leaves every
    // conditional construct verbatim rather than half-consuming it.
    if (name === "/has" && ctx.definedTags !== undefined) {
      out += text.slice(cursor, match.index);
      cursor = MACRO_PATTERN.lastIndex;
      occurrence += 1;
      continue;
    }

    let replacement: string | null = null;
    let trimSurroundingNewlines = false;

    switch (name) {
      case "char":
        replacement = ctx.char;
        break;
      case "user":
        replacement = ctx.user;
        break;
      case "persona":
        replacement = ctx.persona ?? "";
        break;
      case "time":
        replacement = formatTime(now);
        break;
      case "isotime":
        replacement = formatIsoTime(now);
        break;
      case "date":
        replacement = formatDate(now);
        break;
      case "isodate":
        replacement = formatIsoDate(now);
        break;
      case "weekday":
        replacement = WEEKDAYS[now.getDay()] ?? "";
        break;
      case "idle_duration":
        replacement = ctx.lastMessageAt
          ? formatDuration(now.getTime() - ctx.lastMessageAt.getTime())
          : "just now";
        break;
      case "lastmessage":
        replacement = ctx.lastMessage ?? "";
        break;
      case "random": {
        const list = splitMacroList(args);
        const index = list.length === 0 ? -1 : Math.floor(rng() * list.length);
        replacement = index === -1 ? "" : (list[index] ?? "");
        break;
      }
      case "pick": {
        const list = splitMacroList(args);
        // Stable per chat + whole text + occurrence order: the same
        // `{{pick}}` yields the same value on every re-render.
        const index =
          list.length === 0
            ? -1
            : Math.floor(
                seededRng(`pick:${chatId}:${hashString(text)}:${occurrence}`)() * list.length,
              );
        replacement = index === -1 ? "" : (list[index] ?? "");
        break;
      }
      case "roll": {
        // A per-target seed makes dice stable across regenerate/swipe siblings;
        // a new turn gets a new seed, so the roll still changes per turn.
        const rollRng =
          ctx.rollSeed === undefined
            ? rng
            : seededRng(`roll:${chatId}:${ctx.rollSeed}:${hashString(text)}:${occurrence}`);
        const roll = rollFormula(args, rollRng);
        replacement = roll === null ? "" : String(roll());
        break;
      }
      case "setvar": {
        const sep = args.indexOf("::");
        const varName = (sep === -1 ? args : args.slice(0, sep)).trim();
        const value = sep === -1 ? "" : args.slice(sep + 2);
        if (varName !== "") {
          writeVar(ctx, varName, value);
        }
        replacement = "";
        break;
      }
      case "getvar": {
        const sep = args.indexOf("::");
        const varName = (sep === -1 ? args : args.slice(0, sep)).trim();
        const fallback = sep === -1 ? "" : args.slice(sep + 2);
        const value = varName === "" ? null : readVar(ctx, varName);
        // Unknown variable → empty string (ST behavior), or the default.
        replacement = value === null || value === undefined ? fallback : varToString(value);
        break;
      }
      case "addvar": {
        const sep = args.indexOf("::");
        const varName = (sep === -1 ? args : args.slice(0, sep)).trim();
        const value = sep === -1 ? "" : args.slice(sep + 2);
        if (varName !== "") {
          addVar(ctx, varName, value);
        }
        replacement = "";
        break;
      }
      case "incvar":
        replacement = args.trim() === "" ? "" : addVar(ctx, args.trim(), "1");
        break;
      case "decvar":
        replacement = args.trim() === "" ? "" : addVar(ctx, args.trim(), "-1");
        break;
      case "newline":
        replacement = "\n";
        break;
      case "trim":
        replacement = "";
        trimSurroundingNewlines = true;
        break;
      case "noop":
        replacement = "";
        break;
      case "ui": {
        // A blank key, or one the preset's controls do not resolve, stays
        // verbatim like any unknown macro — there is no fallback convention
        // here. A resolved empty string IS a legitimate value, so the
        // `undefined` check (not truthiness) decides. `Object.hasOwn` (not a
        // bare read) keeps inherited `Object.prototype` members out: a plain
        // object literal would otherwise resolve `{{ui:constructor}}` to the
        // Object constructor's source and inject it into the prompt.
        const key = args.trim();
        const value = key === "" || !Object.hasOwn(ctx.ui ?? {}, key) ? undefined : ctx.ui?.[key];
        replacement = value === undefined ? null : value;
        break;
      }
      default:
        // Unknown macro: kept verbatim (ST behavior).
        replacement = null;
        break;
    }

    out += text.slice(cursor, match.index);
    if (replacement === null) {
      out += raw;
      cursor = MACRO_PATTERN.lastIndex;
    } else if (trimSurroundingNewlines) {
      // ST: `(?:\r?\n)*{{trim}}(?:\r?\n)*` — the macro and the newlines
      // hugging it on both sides collapse to nothing.
      out = out.replace(/(?:\r?\n)+$/, "");
      let skip = MACRO_PATTERN.lastIndex;
      while (skip < text.length && (text[skip] === "\n" || text[skip] === "\r")) {
        skip += 1;
      }
      MACRO_PATTERN.lastIndex = skip;
      cursor = skip;
    } else {
      out += replacement;
      cursor = MACRO_PATTERN.lastIndex;
    }
    occurrence += 1;
  }
  return out + text.slice(cursor);
}
