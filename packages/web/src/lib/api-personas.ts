/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ApiError, api } from "./api";

/** A stored persona row — the user's own character (GET /api/personas/:id, …). */
export interface Persona {
  id: string;
  name: string;
  description: string;
  avatar_path: string | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/personas body — only `name` is required. */
export interface CreatePersonaInput {
  name: string;
  description?: string;
  avatar_path?: string | null;
}

/** PATCH /api/personas/:id body — absent fields are left untouched. */
export type UpdatePersonaInput = Partial<CreatePersonaInput>;

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** All personas sorted by name. */
export function listPersonas(): Promise<Persona[]> {
  return api("/api/personas");
}

export function getPersona(id: string): Promise<Persona> {
  return api(`/api/personas/${id}`);
}

export function createPersona(input: CreatePersonaInput): Promise<Persona> {
  return api("/api/personas", jsonInit("POST", input));
}

export function updatePersona(id: string, patch: UpdatePersonaInput): Promise<Persona> {
  return api(`/api/personas/${id}`, jsonInit("PATCH", patch));
}

export function deletePersona(id: string): Promise<{ ok: boolean }> {
  return api(`/api/personas/${id}`, { method: "DELETE" });
}

/** Uploads an avatar image as multipart `file` (the server normalizes it to a
 * WebP blob) and returns its path for the persona create/PATCH body. Uses
 * fetch directly — `api` would force a JSON content-type — so the browser
 * sets the multipart boundary. */
export async function uploadPersonaAvatar(file: File): Promise<{ avatar_path: string }> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/personas/avatar", { method: "POST", body: form });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? "Avatar upload failed", response.status);
  }
  return (await response.json()) as { avatar_path: string };
}
