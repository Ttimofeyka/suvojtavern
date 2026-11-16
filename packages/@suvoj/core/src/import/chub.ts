/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * chub.ai character sources (SillyTavern parity): URL / bare-id parsing and
 * the API metadata → TavernCardV2 mapping. Pure helpers only — the HTTP
 * orchestration lives in the server route; core never does network I/O.
 */

/** Hostnames whose `/characters/{creator}/{project}` pages we import from. */
const CHUB_HOSTS = new Set([
  "chub.ai",
  "www.chub.ai",
  "venus.chub.ai",
  "characterhub.org",
  "www.characterhub.org",
]);

/** A chub character identified by its creator and project slugs. */
export interface ChubRef {
  creator: string;
  project: string;
}

/** Classification of a user-supplied import source. */
export type ChubSource =
  | { kind: "ref"; ref: ChubRef } // a chub character — import via the API
  | { kind: "other" } // not chub — the caller's generic direct-link path
  | { kind: "error"; message: string }; // chub-shaped but unusable

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

/** Classifies a parsed URL: chub host + `/characters` path, or not chub. */
function chubSourceFromUrl(url: UrlParts): ChubSource {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "other" };
  }
  if (!CHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return { kind: "other" };
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] === "characters") {
    // The filter guarantees non-empty; length 3 guarantees exactly two slugs.
    if (segments.length === 3) {
      return { kind: "ref", ref: { creator: segments[1] ?? "", project: segments[2] ?? "" } };
    }
    return {
      kind: "error",
      message: "chub.ai character URL must be /characters/{creator}/{project}",
    };
  }
  if (segments[0] === "lorebooks") {
    return { kind: "error", message: "chub lorebook import is not supported yet" };
  }
  return { kind: "error", message: "not a chub.ai character URL" };
}

/**
 * Classifies `input` as a chub source: a URL on a chub host
 * (`/characters/{creator}/{project}` — trailing slashes, query strings and a
 * missing `https://` are tolerated) or a bare `creator/project` id (exactly
 * two non-empty segments). Lorebook URLs are rejected explicitly; anything
 * that is not chub at all is `{ kind: "other" }` for the caller's generic
 * direct-link import.
 */
export function parseChubSource(input: string): ChubSource {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      return chubSourceFromUrl(new URL(trimmed));
    } catch {
      return { kind: "error", message: "invalid url" };
    }
  }
  // Scheme-less: a bare `creator/project` id, or a pasted host path
  // (`chub.ai/characters/a/b`) that we promote to https:// ourselves.
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  const [creator, project] = segments;
  if (!CHUB_HOSTS.has((segments[0] ?? "").toLowerCase())) {
    return segments.length === 2 && creator !== undefined && project !== undefined
      ? { kind: "ref", ref: { creator, project } }
      : { kind: "other" };
  }
  try {
    return chubSourceFromUrl(new URL(`https://${trimmed}`));
  } catch {
    return { kind: "error", message: "invalid url" };
  }
}

/** The chub API metadata endpoint (`?full=true` carries the definition). */
export function chubApiUrl(ref: ChubRef): string {
  const creator = encodeURIComponent(ref.creator);
  const project = encodeURIComponent(ref.project);
  return `https://api.chub.ai/api/characters/${creator}/${project}?full=true`;
}

/** A chub `node` mapped onto a V2 card, plus the avatar to download for it. */
export interface ChubCard {
  /** TavernCardV2-shaped object, ready for `importCardFromJson`. */
  card: Record<string, unknown>;
  /** `node.max_res_url` (the full-res avatar); null when absent. */
  avatarUrl: string | null;
}

/**
 * Maps a chub API `?full=true` response onto a V2 card with SillyTavern's
 * field parity: chub's "personality" is the card description, chub's
 * "description" the creator notes. Missing fields default to "" / []; a
 * non-object `embedded_lorebook` is dropped. Returns null when the response
 * carries no `node` object.
 */
export function chubCardFromResponse(raw: unknown, creatorName: string): ChubCard | null {
  const node = asRecord(raw).node;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  const record = node as Record<string, unknown>;
  const definition = asRecord(record.definition);
  const data: Record<string, unknown> = {
    name: asString(definition.name),
    description: asString(definition.personality),
    personality: asString(definition.tavern_personality),
    scenario: asString(definition.scenario),
    first_mes: asString(definition.first_message),
    mes_example: asString(definition.example_dialogs),
    creator_notes: asString(definition.description),
    system_prompt: asString(definition.system_prompt),
    post_history_instructions: asString(definition.post_history_instructions),
    alternate_greetings: asStringArray(definition.alternate_greetings),
    tags: asStringArray(record.topics),
    creator: creatorName,
    character_version: "",
    extensions: asRecord(definition.extensions),
  };
  const book = definition.embedded_lorebook;
  if (book && typeof book === "object") {
    data.character_book = book;
  }
  const maxResUrl = asString(record.max_res_url);
  return {
    card: { spec: "chara_card_v2", spec_version: "2.0", data },
    avatarUrl: maxResUrl !== "" ? maxResUrl : null,
  };
}
