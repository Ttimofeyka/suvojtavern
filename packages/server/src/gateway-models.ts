/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  authHeadersFor,
  type Endpoint,
  ERROR_EXCERPT_CHARS,
  type GatewayDeps,
  GatewayError,
  type GatewayModel,
} from "./gateway-shared";

export const MODELS_TTL_MS = 60_000;

interface ModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    context_window?: unknown;
    context_length?: unknown;
  }>;
}

interface ModelsCache {
  fetchedAt: number;
  models: GatewayModel[];
}

export function createModelsGateway(deps: GatewayDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Cache keyed per endpoint identity: the normalized base URL AND the key.
  // Two profiles on the same base with different keys can see different model
  // lists (and an endpoint may serve different models per credential), and a
  // rotated key must not be served a stale list from its predecessor — hence
  // the NUL separator so neither field can collide with the other's text.
  const caches = new Map<string, ModelsCache>();
  const cacheKey = (endpoint: Endpoint): string =>
    `${endpoint.baseUrl}\u0000${endpoint.apiKey ?? ""}`;

  async function getModels(endpoint?: Endpoint): Promise<GatewayModel[]> {
    // The caller resolves the endpoint from a connection profile; there is no
    // default. Without one (no profile configured) this is a clean 400.
    if (endpoint === undefined) {
      throw new GatewayError("No connection profile configured", 400);
    }
    const key = cacheKey(endpoint);
    const cached = caches.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < MODELS_TTL_MS) {
      return cached.models;
    }
    const url = `${endpoint.baseUrl}/v1/models`;
    // Bearer header for the endpoint (empty when the profile supplied no key).
    // `authHeadersFor` is pure, so there is nothing to catch around it.
    const headers = authHeadersFor(endpoint);
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { headers });
      text = await res.text();
    } catch (err) {
      throw new GatewayError(`GET ${url} failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new GatewayError(
        `GET ${url} failed (${res.status}): ${text.slice(0, ERROR_EXCERPT_CHARS)}`,
        res.status,
      );
    }
    let json: ModelsResponse;
    try {
      json = JSON.parse(text) as ModelsResponse;
    } catch {
      throw new GatewayError(
        `GET ${url} returned non-JSON response: ${text.slice(0, ERROR_EXCERPT_CHARS)}`,
        502,
      );
    }
    const models: GatewayModel[] = (json.data ?? [])
      .filter(
        (
          m,
        ): m is {
          id: string;
          name?: unknown;
          context_window?: unknown;
          context_length?: unknown;
        } => {
          return typeof m?.id === "string";
        },
      )
      .map((m) => {
        // Suvoj sends `context_window`; keep `context_length` as a legacy fallback.
        const context = typeof m.context_window === "number" ? m.context_window : m.context_length;
        return {
          id: m.id,
          ...(typeof m.name === "string" ? { name: m.name } : {}),
          ...(typeof context === "number" ? { context_length: context } : {}),
        };
      });
    caches.set(key, { fetchedAt: Date.now(), models });
    return models;
  }

  return { getModels };
}
