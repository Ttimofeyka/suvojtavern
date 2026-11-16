/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ApiError, api } from "./api";

/** A stored character row (GET /api/characters/:id, POST /api/characters, …). */
export interface Character {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  avatar_path: string | null;
  /** Imported card JSON kept verbatim; null for characters created in-app. */
  card_raw: unknown;
  created_at: string;
  updated_at: string;
}

/** Identity + avatar, the minimum pickers (tiles, gallery, selects) need. */
export interface CharacterRef {
  id: string;
  name: string;
  avatar_path: string | null;
}

/**
 * GET /api/characters list row: a slim projection (no card bodies/prompts)
 * plus the flat `chat_count` the route adds from one grouped query. Fetch the
 * full {@link Character} via `getCharacter(id)` when opening the editor.
 */
export interface CharacterListItem extends CharacterRef {
  tags: string[];
  created_at: string;
  updated_at: string;
  chat_count: number;
}

/** Envelope returned by GET /api/characters. `total` ignores limit/offset;
 *  `tags` is the distinct-tag facet across every match, also ignoring paging. */
export interface CharacterListPage {
  items: CharacterListItem[];
  total: number;
  tags: string[];
  limit: number;
  offset: number;
}

/** Default page size for the character list and every picker. */
export const CHARACTER_PAGE_SIZE = 100;

/** Ordering accepted by the characters list query, mirroring the server enum:
 *  `name` (alphabetical), `created` (newest first), `recent` (latest chat
 *  activity first). The full enum lives here even though the UI only exposes
 *  `created`/`recent`, so the API surface stays in lockstep with the server. */
export type CharacterSort = "name" | "created" | "recent";

/** Filters and paging accepted by {@link listCharacters}. */
export interface CharacterListParams {
  /** Exact tags a character must ALL carry (AND); empty/absent means no filter. */
  tags?: string[];
  search?: string;
  sort?: CharacterSort;
  limit?: number;
  offset?: number;
}

/** Gallery image row of a character (upload / list / patch responses). */
export interface CharacterImage {
  id: string;
  character_id: string;
  blob_path: string | null;
  sort: number;
  created_at: string;
}

/** POST /api/characters body — every field but `name` falls back to a default. */
export interface CreateCharacterInput {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  tags?: string[];
  avatar_path?: string | null;
  card_raw?: unknown;
}

/** PATCH /api/characters/:id body — absent fields are left untouched. */
export type UpdateCharacterInput = Partial<CreateCharacterInput>;

/** PATCH /api/characters/:id/images/:imageId body per the gallery route. */
export interface SetCharacterImageInput {
  avatar?: boolean;
  sort?: number;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Characters filtered by exact `tags` (ALL must be present) or name substring
 * `search`, ordered by `sort` (defaults to the server's name order). Returns
 * the requested page plus the unpaged `total`, so consumers can append pages
 * and stop at the end.
 *
 * `limit` defaults to {@link CHARACTER_PAGE_SIZE}; the endpoint caps it at 500
 * and rejects an out-of-range `offset` with 400.
 */
export function listCharacters(params?: CharacterListParams): Promise<CharacterListPage> {
  const query = new URLSearchParams();
  // Repeated `tag` params — the server ANDs them (see the characters route).
  for (const tag of params?.tags ?? []) {
    query.append("tag", tag);
  }
  if (params?.search !== undefined) {
    query.set("search", params.search);
  }
  // An explicit "name" must still be forwarded: the server treats it as a
  // distinct order, and omitting it would silently fall back to a default that
  // may not be name.
  if (params?.sort !== undefined) {
    query.set("sort", params.sort);
  }
  query.set("limit", String(params?.limit ?? CHARACTER_PAGE_SIZE));
  if (params?.offset !== undefined) {
    query.set("offset", String(params.offset));
  }
  return api<CharacterListPage>(`/api/characters?${query.toString()}`);
}

export function getCharacter(id: string): Promise<Character> {
  return api(`/api/characters/${id}`);
}

export function createCharacter(input: CreateCharacterInput): Promise<Character> {
  return api("/api/characters", jsonInit("POST", input));
}

export function updateCharacter(id: string, patch: UpdateCharacterInput): Promise<Character> {
  return api(`/api/characters/${id}`, jsonInit("PATCH", patch));
}

export function deleteCharacter(id: string): Promise<{ ok: boolean }> {
  return api(`/api/characters/${id}`, { method: "DELETE" });
}

/** With `ids`: exactly those characters. Without: every chat-less one (chats go too). */
export function purgeCharacters(ids?: string[]): Promise<{ deleted_ids: string[] }> {
  return api("/api/characters/purge", jsonInit("POST", ids === undefined ? {} : { ids }));
}

/** Gallery images of a character, ordered by `sort`. */
export function listImages(characterId: string): Promise<CharacterImage[]> {
  return api(`/api/characters/${characterId}/images`);
}

/** Uploads an image into a character's gallery as multipart `file` (the server normalizes
 * it to a WebP blob). Uses fetch directly — `api` would force a JSON content-type — so
 * the browser sets the multipart boundary. First image becomes the avatar. */
export async function uploadImage(characterId: string, file: File): Promise<CharacterImage> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/characters/${characterId}/images`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? "Image upload failed", response.status);
  }
  return (await response.json()) as CharacterImage;
}

/** Patches an image's `sort` and/or points the character's avatar at it. */
export function setCharacterImage(
  characterId: string,
  imageId: string,
  patch: SetCharacterImageInput,
): Promise<CharacterImage> {
  return api(`/api/characters/${characterId}/images/${imageId}`, jsonInit("PATCH", patch));
}

/** Deletes a gallery image; a deleted avatar falls back to the first remaining. */
export function deleteCharacterImage(
  characterId: string,
  imageId: string,
): Promise<{ ok: boolean }> {
  return api(`/api/characters/${characterId}/images/${imageId}`, { method: "DELETE" });
}
