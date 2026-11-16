/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Error for non-2xx responses (`status` from the server) and network failures (`status` 0). */
export class ApiError extends Error {
  status: number;
  /**
   * Structured error payload when the endpoint provides one (e.g. per-field
   * validation details on a 400). Free-form — each endpoint documents its shape.
   */
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/** Fetches `path`, sets a JSON content-type on bodies, and normalizes failures to `ApiError`. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    if (init?.body != null && !(init.body instanceof FormData) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError("Network error", 0);
  }
  if (!res.ok) {
    let message = "Request failed";
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: string; details?: unknown };
      message = body.error ?? "Request failed";
      details = body.details;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(message, res.status, details);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/** Served URL of a stored blob path (`data/blobs/x.webp` → `/blobs/x.webp`). */
export function blobUrl(path: string | null | undefined): string | null {
  const name = path?.split("/").pop();
  return name ? `/blobs/${name}` : null;
}

export function getSettings(): Promise<Record<string, unknown>> {
  return api("/api/settings");
}

export function putSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
}

/** A model row from GET /api/models (mirrors the server's GatewayModel). */
export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
}

export function getModels(): Promise<{ models: ModelInfo[] }> {
  return api("/api/models");
}

/** Variable values are arbitrary JSON (mirrors the server's variableValue union). */
export type VariableValue = string | number | boolean | null | unknown[] | Record<string, unknown>;

export function getVariables(): Promise<Record<string, unknown>> {
  return api("/api/variables");
}

export function setVariable(key: string, value: VariableValue): Promise<{ ok: boolean }> {
  return api(`/api/variables/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function deleteVariable(key: string): Promise<{ ok: boolean }> {
  return api(`/api/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export function getChatVariables(chatId: string): Promise<Record<string, unknown>> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/variables`);
}

export function setChatVariable(
  chatId: string,
  key: string,
  value: VariableValue,
): Promise<{ ok: boolean }> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/variables/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function deleteChatVariable(chatId: string, key: string): Promise<{ ok: boolean }> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/variables/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}
