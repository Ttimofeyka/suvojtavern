/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import PNGtext from "png-chunk-text";
import extractPngChunks from "png-chunks-extract";
import { saveBlob, toWebp } from "../images";
import type { CharactersRepository } from "../repositories/characters";
import type { LorebooksRepository } from "../repositories/lorebooks";
import type { Character, CharacterInput } from "../schema/characters";
import type { Lorebook } from "../schema/lorebooks";
import { characterBookToEntries } from "./lorebook";

/**
 * SillyTavern character card import (V1 flat JSON, V2 `chara_card_v2`,
 * V3 `chara_card_v3`) from either raw JSON or a PNG with `chara`/`ccv3`
 * tEXt chunks.
 *
 * Lossless by design: the whole source object is kept in `card_raw`, every
 * known field additionally maps to a native column, and an embedded
 * `character_book` becomes a linked lorebook.
 */

// --- coercion helpers --------------------------------------------------------

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// --- PNG extraction ------------------------------------------------------------

/** Reads one JSON value from a tEXt payload: plain JSON or base64-encoded. */
function parseTextChunk(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to base64
  }
  try {
    return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export interface PngTextChunkData {
  keyword: string;
  text: string;
}

/** All tEXt payloads of a PNG, decoded, in file order. */
export function pngTextChunks(buffer: Uint8Array): PngTextChunkData[] {
  return extractPngChunks(buffer)
    .filter((chunk) => chunk.name === "tEXt")
    .map((chunk) => PNGtext.decode(chunk.data));
}

/**
 * Extracts the character card JSON from PNG tEXt chunks. The `ccv3` chunk
 * (V3) wins over `chara` (V2), mirroring SillyTavern's reader; both plain
 * and base64 payloads are accepted for `ccv3`, base64 for `chara`.
 */
export function extractCardJsonFromPng(buffer: Uint8Array): unknown {
  const chunks = pngTextChunks(buffer);
  const byKeyword = (keyword: string): PngTextChunkData | undefined =>
    chunks.find((chunk) => chunk.keyword.toLowerCase() === keyword);
  for (const keyword of ["ccv3", "chara"]) {
    const chunk = byKeyword(keyword);
    const parsed = chunk ? parseTextChunk(chunk.text) : undefined;
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new Error("PNG contains no character data (no parseable chara/ccv3 tEXt chunk)");
}

// --- normalization --------------------------------------------------------------

/** The effective `data` object plus whether the card declared V2/V3. */
function cardDataOf(obj: Record<string, unknown>): Record<string, unknown> {
  const spec = asString(obj.spec);
  const data = asRecord(obj.data);
  const isSpecCard = spec === "chara_card_v2" || spec === "chara_card_v3";
  if (isSpecCard) {
    // Spec cards keep fields under `data`; tolerate a missing/empty `data`
    // by falling back to the top level.
    return Object.keys(data).length > 0 ? data : obj;
  }
  // Lenient: spec-less cards that still carry a `data.name` are V2-shaped.
  if (typeof data.name === "string" && data.name !== "") {
    return data;
  }
  return obj;
}

/** Maps a card (V1/V2/V3) onto native character columns. */
function cardToCharacterInput(obj: Record<string, unknown>, name: string): CharacterInput {
  const data = cardDataOf(obj);
  return {
    name,
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    first_mes: asString(data.first_mes),
    mes_example: asString(data.mes_example),
    creator_notes: asString(data.creator_notes),
    system_prompt: asString(data.system_prompt),
    post_history_instructions: asString(data.post_history_instructions),
    alternate_greetings: asStringArray(data.alternate_greetings),
    tags: asStringArray(data.tags),
    avatar_path: null,
    card_raw: obj,
  };
}

// --- dedup -----------------------------------------------------------------------

function findByName(characters: CharactersRepository, name: string) {
  return characters.list().find((existing) => existing.name.toLowerCase() === name.toLowerCase());
}

/** First free name: "Name (2)", "Name (3)", … */
function renamedCopy(characters: CharactersRepository, name: string): string {
  let suffix = 2;
  while (findByName(characters, `${name} (${suffix})`)) {
    suffix += 1;
  }
  return `${name} (${suffix})`;
}

// --- import ----------------------------------------------------------------------

/** The repositories the card importer touches. */
export interface CardImportRepos {
  characters: CharactersRepository;
  lorebooks: LorebooksRepository;
}

export interface CardImportOptions {
  /**
   * What to do when a character with the same name (case-insensitive)
   * already exists:
   * - `error` (default): throw — the server decides how to surface it;
   * - `rename`: import as "Name (2)", "Name (3)", …;
   * - `replace`: overwrite the existing character's mapped fields, card_raw
   *   and avatar in place (id, chats and gallery are kept; the avatar's own
   *   gallery row is repointed rather than appended to).
   */
  onConflict?: "error" | "rename" | "replace";
  /** Blob directory for the avatar and gallery images (default `data/blobs`). */
  blobDir?: string;
  /**
   * Original card image bytes; when present they become the character's
   * avatar and its first gallery image through the lossless-WebP pipeline
   * (used by {@link importCardFromPng}).
   */
  sourcePng?: Uint8Array;
}

export interface CardImportResult {
  character: Character;
  /** Lorebook imported from an embedded `character_book`, if the card had one. */
  lorebook: Lorebook | null;
  /** True when `onConflict: "rename"` produced a suffixed name. */
  renamed: boolean;
}

/**
 * Imports a character card from raw JSON (V1/V2/V3). The card's final avatar
 * (the source PNG, when one was supplied) is also mirrored into the gallery as
 * its first image, so no image-bearing import ends up with an empty gallery;
 * V3 `assets` with embedded `data:` image URIs follow it as gallery images.
 * Remote or packaged asset references stay in `card_raw` only (core never does
 * HTTP). A JSON card with no image has no avatar to mirror, so its gallery
 * legitimately stays empty.
 */
export async function importCardFromJson(
  obj: unknown,
  repos: CardImportRepos,
  opts: CardImportOptions = {},
): Promise<CardImportResult> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("card is not a JSON object");
  }
  const source = obj as Record<string, unknown>;
  const data = cardDataOf(source);
  const requestedName = asString(data.name).trim();
  if (requestedName === "") {
    throw new Error("card has no name");
  }

  const onConflict = opts.onConflict ?? "error";
  const existing = findByName(repos.characters, requestedName);
  if (existing && onConflict === "error") {
    throw new Error(`character "${requestedName}" already exists`);
  }
  const name =
    existing && onConflict === "rename"
      ? renamedCopy(repos.characters, requestedName)
      : requestedName;
  const renamed = name !== requestedName;

  const input = cardToCharacterInput(source, name);

  // The source PNG itself becomes the avatar (lossless WebP).
  if (opts.sourcePng) {
    input.avatar_path = saveBlob(await toWebp(opts.sourcePng), "webp", { dir: opts.blobDir });
  }

  // The pre-replace avatar, if any: when the source PNG is re-saved to a new
  // blob path, its existing gallery row is repointed instead of duplicated.
  const previousAvatarPath = existing && onConflict === "replace" ? existing.avatar_path : null;

  let character: Character | null;
  if (existing && onConflict === "replace") {
    character = repos.characters.update(existing.id, input);
  } else {
    character = repos.characters.create(input);
  }
  if (!character) {
    throw new Error(`character ${existing?.id} disappeared while replacing`);
  }

  // Embedded lorebook (V2/V3 `character_book`).
  const book = data.character_book;
  let lorebook: Lorebook | null = null;
  if (book && typeof book === "object") {
    const bookName = asString((book as Record<string, unknown>).name).trim();
    lorebook = repos.lorebooks.create({
      name: bookName !== "" ? bookName : `${name}'s book`,
      description: "Imported from an embedded character book",
    });
    repos.lorebooks.replaceEntries(lorebook.id, characterBookToEntries(book));
    repos.lorebooks.attachToCharacter(character.id, lorebook.id);
  }

  // Mirror the final avatar into the gallery so an image-bearing card never
  // imports with an empty gallery — every source (PNG, chub, Janitor, direct
  // links) funnels through here. The row references the very blob the avatar
  // already points at (no copy, no re-encode), exactly like the gallery route
  // when an image is promoted to avatar; deleting that row already falls the
  // avatar back to the first remaining image.
  //
  // Idempotent across `replace`, which deliberately keeps the gallery: skip a
  // blob already present, and repoint the old avatar's mirror row (rather than
  // append) when the avatar was re-saved. `sort` continues from the current
  // gallery length, so a fresh import gets the avatar at slot 0 and the V3
  // assets below follow it in order. A JSON card with no image has no
  // `avatar_path` to mirror, so its gallery stays empty.
  const gallery = repos.characters.listImages(character.id);
  let sort = gallery.length;
  if (
    character.avatar_path &&
    !gallery.some((image) => image.blob_path === character.avatar_path)
  ) {
    const mirror = previousAvatarPath
      ? gallery.find((image) => image.blob_path === previousAvatarPath)
      : undefined;
    if (mirror) {
      repos.characters.updateImage(mirror.id, { blob_path: character.avatar_path });
    } else {
      repos.characters.addImage(character.id, { blob_path: character.avatar_path, sort });
      sort += 1;
    }
  }

  // V3 image assets: only embedded data URIs (no HTTP in core).
  const assets = Array.isArray(data.assets) ? data.assets : [];
  for (const asset of assets) {
    const record = asRecord(asset);
    const type = asString(record.type);
    const uri = asString(record.uri);
    if (!type.startsWith("image/") || !uri.startsWith("data:")) {
      continue;
    }
    const buffer = decodeDataUri(uri);
    if (buffer) {
      const path = saveBlob(await toWebp(buffer), "webp", { dir: opts.blobDir });
      repos.characters.addImage(character.id, { blob_path: path, sort });
      sort += 1;
    }
  }

  return { character, lorebook, renamed };
}

/** Decodes a `data:[mime][;base64],payload` URI; null when malformed. */
function decodeDataUri(uri: string): Uint8Array | null {
  const comma = uri.indexOf(",");
  if (comma === -1) {
    return null;
  }
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    return meta.includes("base64")
      ? new Uint8Array(Buffer.from(payload, "base64"))
      : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Imports a character card from PNG bytes: extracts the card JSON
 * (`ccv3` chunk preferred, `chara` fallback) and converts the PNG itself
 * into the character's avatar.
 */
export async function importCardFromPng(
  buffer: Uint8Array,
  repos: CardImportRepos,
  opts: CardImportOptions = {},
): Promise<CardImportResult> {
  const card = extractCardJsonFromPng(buffer);
  return importCardFromJson(card, repos, { ...opts, sourcePng: buffer });
}
