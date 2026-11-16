/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JanitorAI character sources (JAR parity): URL / bare-id parsing, the
 * `/hampter/characters/:id` metadata → TavernCardV2 mapping, and the
 * `/hampter/script/:id` public-lorebook record → native entries mapping.
 * Pure helpers only — the HTTP orchestration lives in the server route; core
 * never does network I/O.
 *
 * Unlike chub.ai (whose catalog hides the card until you fetch the full
 * definition), JanitorAI's `/hampter/characters/:id` response *is* the card
 * when the creator left the definition public (`showdefinition`), so the
 * mapping below is exact — no reconstruction from a captured prompt.
 */

import type { LorebookEntryInput } from "../schema/lorebooks";
import { stEntryToNative } from "./lorebook";

/** Hostnames whose `/characters/{id}` pages we import from. */
const JANITOR_HOSTS = new Set(["janitorai.com", "www.janitorai.com"]);

/** A JanitorAI character UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `{id}[_{slug}]` tail of a character URL. */
const CHARACTER_TAIL_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_(.*))?$/i;

/** A JanitorAI character identified by its UUID and optional URL slug. */
export interface JanitorRef {
  id: string;
  /** The text after `<uuid>_` in a URL, else null. */
  slug: string | null;
}

/** Classification of a user-supplied import source. */
export type JanitorSource =
  | { kind: "ref"; ref: JanitorRef } // a janitorai character — import via the API
  | { kind: "other" } // not janitorai — the caller's generic direct-link path
  | { kind: "error"; message: string }; // janitorai-shaped but unusable

// --- coercion helpers --------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The URL pieces the classification reads. Structural on purpose: core's
 * lib set has no DOM `URL` interface (the value constructor is fine).
 */
interface UrlParts {
  protocol: string;
  hostname: string;
  pathname: string;
}

/** Splits one `/characters/<id>[_<slug>]` segment into a ref, or null. */
function refFromCharacterSegment(segment: string): JanitorRef | null {
  const match = segment.match(CHARACTER_TAIL_RE);
  if (!match) {
    return null;
  }
  const slug = match[2];
  return { id: match[1] ?? "", slug: slug && slug !== "" ? slug : null };
}

/** Classifies a parsed URL: janitor host + `/characters/{id}`, or not. */
function janitorSourceFromUrl(url: UrlParts): JanitorSource {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "other" };
  }
  if (!JANITOR_HOSTS.has(url.hostname.toLowerCase())) {
    return { kind: "other" };
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] === "characters") {
    if (segments.length === 2) {
      const ref = refFromCharacterSegment(segments[1] ?? "");
      if (ref) {
        return { kind: "ref", ref };
      }
    }
    return {
      kind: "error",
      message: "janitorai.com character URL must be /characters/{id} or /characters/{id}_{slug}",
    };
  }
  return { kind: "error", message: "not a janitorai.com character URL" };
}

/**
 * Classifies `input` as a JanitorAI source: a URL on a janitor host
 * (`/characters/{uuid}[_{slug}]` — trailing slashes, query strings and a
 * missing `https://` are tolerated) or a bare UUID. Non-character janitor
 * paths (e.g. `/scripts/{id}`, `/profile/...`) are rejected explicitly;
 * anything that is not janitorai at all is `{ kind: "other" }` for the
 * caller's generic direct-link import.
 */
export function parseJanitorSource(input: string): JanitorSource {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      return janitorSourceFromUrl(new URL(trimmed));
    } catch {
      return { kind: "error", message: "invalid url" };
    }
  }
  // A bare UUID (case-insensitive) — the same shape a character URL embeds.
  if (UUID_RE.test(trimmed)) {
    return { kind: "ref", ref: { id: trimmed, slug: null } };
  }
  // Scheme-less: a pasted host path (`janitorai.com/characters/<uuid>`) that
  // we promote to https:// ourselves. Anything else is not a janitor source.
  const host = (trimmed.split("/")[0] ?? "").toLowerCase();
  if (!JANITOR_HOSTS.has(host)) {
    return { kind: "other" };
  }
  try {
    return janitorSourceFromUrl(new URL(`https://${trimmed}`));
  } catch {
    return { kind: "error", message: "invalid url" };
  }
}

/** The JanitorAI catalog metadata endpoint for a character. */
export function janitorCharacterApiUrl(id: string): string {
  return `https://janitorai.com/hampter/characters/${encodeURIComponent(id)}`;
}

/** The JanitorAI public-lorebook script endpoint. */
export function janitorScriptApiUrl(id: string): string {
  return `https://janitorai.com/hampter/script/${encodeURIComponent(id)}`;
}

/** The full-res avatar URL for a bot-avatars filename (`?width=1200`). */
export function janitorAvatarUrl(avatarFile: string): string {
  return `https://ella.janitorai.com/bot-avatars/${encodeURIComponent(avatarFile)}?width=1200`;
}

/**
 * Flattens JanitorAI's HTML catalog blurb into plain text.
 *
 * JanitorAI's catalog `description` (the card's public blurb, and each
 * lorebook item's `description`) is HTML. Block-level closers become
 * newlines, tags are stripped, the handful of entities JanitorAI emits are
 * decoded, and whitespace is collapsed. Ported verbatim from JAR.
 */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// --- card metadata → TavernCardV2 --------------------------------------------

/** A lorebook script attached to a character (`meta.scripts` item). */
export interface JanitorLorebookRef {
  id: string;
  title: string;
  isPublic: boolean;
}

/**
 * The lorebook script refs attached to a character. Mirrors JAR's
 * `lorebookScriptRefs`: only `lorebook` / `advanced` items with an id count,
 * and `is_public` defaults to true (only an explicit `false` marks a book
 * private).
 */
export function janitorLorebooks(meta: unknown): JanitorLorebookRef[] {
  const record = asRecord(meta);
  if (!Array.isArray(record.scripts)) {
    return [];
  }
  const out: JanitorLorebookRef[] = [];
  for (const item of record.scripts) {
    const script = asRecord(item);
    if (script.type !== "lorebook" && script.type !== "advanced") {
      continue;
    }
    if (script.id === null || script.id === undefined) {
      continue;
    }
    out.push({
      id: String(script.id),
      title: asString(script.title),
      isPublic: script.is_public !== false,
    });
  }
  return out;
}

/** A JanitorAI card mapped onto V2, plus its avatar filename and books. */
export interface JanitorCharacterCard {
  /** TavernCardV2-shaped object, ready for `importCardFromJson`. */
  card: Record<string, unknown>;
  /** `meta.avatar` / `meta.raw_avatar` filename; null when absent. */
  avatarFile: string | null;
  /** Public/advanced lorebooks attached to the character. */
  lorebooks: JanitorLorebookRef[];
}

/**
 * Every opening message, de-duplicated and in order. Mirrors JAR's
 * `collectGreetings`: all of `first_messages[]`, then `first_message`, then
 * `alternate_greetings[]`; each is trimmed, blanks dropped, and duplicates
 * removed while preserving first-seen order.
 */
function collectGreetings(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text !== "" && !out.includes(text)) {
      out.push(text);
    }
  };
  if (Array.isArray(record.first_messages)) {
    for (const greeting of record.first_messages) {
      push(greeting);
    }
  }
  push(record.first_message);
  if (Array.isArray(record.alternate_greetings)) {
    for (const greeting of record.alternate_greetings) {
      push(greeting);
    }
  }
  return out;
}

/** First non-empty string among `avatar` then `raw_avatar`; null otherwise. */
function avatarFileOf(record: Record<string, unknown>): string | null {
  const avatar = typeof record.avatar === "string" ? record.avatar : "";
  if (avatar !== "") {
    return avatar;
  }
  const rawAvatar = typeof record.raw_avatar === "string" ? record.raw_avatar : "";
  return rawAvatar !== "" ? rawAvatar : null;
}

/**
 * Maps a `/hampter/characters/<id>` response onto a V2 card with JAR's
 * `buildPublicCharacter` field parity. This only makes sense for a public
 * definition (see {@link janitorIsCardPublic}), where the fields are the real
 * ones — hence "verbatim, trimmed", not reconstructed.
 *
 * Notable mappings: JanitorAI's `personality` is the card description, its
 * catalog `description` (HTML) the creator notes, `first_messages[]` the
 * ordered greetings. Returns null when the response carries no name.
 */
export function janitorCardFromMetadata(meta: unknown): JanitorCharacterCard | null {
  const record = asRecord(meta);
  const name = asString(record.name).trim();
  if (name === "") {
    return null;
  }
  const greetings = collectGreetings(record);
  const data: Record<string, unknown> = {
    name,
    // The definition body lives in `personality`; it is plain text, NOT html.
    description: asString(record.personality).trim(),
    personality: "",
    scenario: asString(record.scenario).trim(),
    first_mes: greetings[0] ?? "",
    alternate_greetings: greetings.slice(1),
    mes_example: asString(record.example_dialogs).trim(),
    // The catalog blurb IS html.
    creator_notes: htmlToText(asString(record.description)),
    system_prompt: "",
    post_history_instructions: "",
    tags: asStringArray(record.custom_tags),
    creator: asString(record.creator_name),
    character_version: "",
    extensions: {},
  };
  return {
    card: { spec: "chara_card_v2", spec_version: "2.0", data },
    avatarFile: avatarFileOf(record),
    lorebooks: janitorLorebooks(meta),
  };
}

/**
 * Whether the creator left the definition PUBLIC (`showdefinition`). Mirrors
 * JAR's `isCardPublic`: the flag alone is not enough — at least one of
 * `personality` / `scenario` must carry text for the fields to be usable.
 */
export function janitorIsCardPublic(meta: unknown): boolean {
  const record = asRecord(meta);
  if (!record.showdefinition) {
    return false;
  }
  return asString(record.personality).trim() !== "" || asString(record.scenario).trim() !== "";
}

/**
 * The lorebook's human-readable description from its public `/scripts/<id>`
 * page. JanitorAI does not expose it through `/hampter` (its `description`
 * there is usually empty); the page embeds the store as escaped JSON inside a
 * `window.mbxM.push(JSON.parse("…"))` call, so it is double-decoded here.
 * Returns "" when the page carries no content. Faithful port of JAR's
 * `parsePublishedContent`.
 */
export function parseScriptPublishedContent(html: string): string {
  const re = /JSON\.parse\("((?:[^"\\]|\\.)*)"\)/g;
  for (const match of String(html ?? "").matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(JSON.parse(`"${match[1] ?? ""}"`));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      const record = asRecord(value);
      const content = asRecord(record.scriptPublishedContent).content;
      if (typeof content === "string" && content.trim() !== "") return content;
      const description = asRecord(record.script).description;
      if (typeof description === "string" && description.trim() !== "") return description;
    }
  }
  return "";
}

// --- public-lorebook script → native entries ---------------------------------

/** A parsed `/hampter/script/<id>` record, ready for storage or LLM rebuild. */
export interface JanitorScript {
  /** Structured entries (empty for a JS/"advanced" book). */
  entries: LorebookEntryInput[];
  /** True when `script` is non-JSON JavaScript source (Nine API book). */
  isJs: boolean;
  /** The raw JavaScript source when `isJs`; "" otherwise. */
  scriptSource: string;
  title: string;
  description: string;
  isCodePublic: boolean;
}

/** JAR's `asArray`: array of values, or a comma-separated string. */
function toKeyArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item !== "");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

/** `value` when it is a finite number, else null (`Number.isFinite` is typed). */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * JanitorAI's entry `probability` on SillyTavern's 0-100 scale. A 0-1 fraction
 * is scaled up; a numeric string is accepted (JanitorAI emits both). Anything
 * unparseable falls back to 100 (JAR's default).
 */
function coerceProbability(value: unknown): number {
  if (value === undefined || value === null) return 100;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return 100;
  return numeric <= 1 ? numeric * 100 : numeric;
}

/**
 * One JanitorAI-native entry reshaped into the SillyTavern World Info surface
 * `stEntryToNative` consumes. Mirrors JAR's `worldinfo.buildEntry` field by
 * field; `depth` is taken from the source when numeric (JAR hardcodes 4) so a
 * native entry that spells one out is not silently flattened.
 */
function buildStEntry(raw: Record<string, unknown>, uid: number): Record<string, unknown> {
  const constant = raw.constant === true;
  const order =
    finiteNumber(raw.order) ??
    finiteNumber(raw.priority) ??
    finiteNumber(raw.insertion_order) ??
    100;
  // SillyTavern stores probability on a 0-100 scale; tolerate a 0-1 fraction.
  // JanitorAI sometimes emits it as a numeric string ("0.5"), so coerce before
  // the `<= 1` test (JAR's loose comparison does the same) instead of letting
  // `asInt` fall back to 100.
  const rawProbability = raw.probability;
  const probability = coerceProbability(rawProbability);
  return {
    uid,
    key: toKeyArray(raw.key || raw.keys || raw.keywords || raw.keysRaw),
    keysecondary: toKeyArray(raw.keysecondary || raw.secondary_keys || raw.keySecondary),
    comment: String(raw.comment || raw.title || raw.name || raw.category || `Entry ${uid}`).trim(),
    content: String(raw.content || raw.text || "").trim(),
    constant,
    selective: !constant,
    selectiveLogic: finiteNumber(raw.selectiveLogic) ?? 0,
    order,
    position: finiteNumber(raw.position) ?? 0,
    depth: finiteNumber(raw.depth) ?? 4,
    probability,
    useProbability: true,
    disable: raw.enabled === false,
    caseSensitive: raw.case_sensitive !== undefined ? raw.case_sensitive : undefined,
    matchWholeWords: raw.matchWholeWords !== undefined ? raw.matchWholeWords : undefined,
  };
}

/**
 * The entry array inside a `script` field: it is already an array, or a JSON
 * string of one. Returns null when it is neither (→ JS source).
 */
function scriptEntryList(script: unknown): Record<string, unknown>[] | null {
  let value = script;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null; // non-JSON → JavaScript source
    }
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    );
  }
  return null;
}

/**
 * Parses a `/hampter/script/<id>` response. `record.script` is either a JSON
 * entries array (native JanitorAI shape → mapped through `stEntryToNative`) or
 * a non-JSON JavaScript string (a JanitorAI "advanced"/Nine API book → kept as
 * `scriptSource` for the LLM rebuild path). Never throws: malformed input
 * yields an empty result.
 */
export function janitorScriptEntries(record: unknown): JanitorScript {
  const rec = asRecord(record);
  const base = {
    title: asString(rec.title),
    description: asString(rec.description),
    isCodePublic: rec.is_code_public === true,
  };
  const list = scriptEntryList(rec.script);
  if (list) {
    return {
      ...base,
      entries: list.map((raw, uid) => stEntryToNative(buildStEntry(raw, uid))),
      isJs: false,
      scriptSource: "",
    };
  }
  if (typeof rec.script === "string" && rec.script.trim() !== "") {
    return { ...base, entries: [], isJs: true, scriptSource: rec.script };
  }
  return { ...base, entries: [], isJs: false, scriptSource: "" };
}
