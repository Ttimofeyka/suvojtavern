/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { createRepositories } from "@suvoj/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    // Human-readable context line, e.g. "upstream 429 from api.example.com,
    // attempt 2/4" — appended to client-facing messages by the routes.
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Messages of an error's cause chain, joined with ": " — for a failed
 * fetch, "connect ENOTFOUND api.example.com". The error's own message is
 * excluded (callers prepend it); the walk is cycle-guarded and depth-capped
 * so a malformed chain can neither loop nor grow unbounded. Empty string
 * when there is no cause to report.
 */
export function causeChain(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cause = (err as { cause?: unknown } | undefined)?.cause;
  for (let depth = 0; depth < 5 && cause !== undefined && cause !== null; depth++) {
    if (seen.has(cause)) break;
    seen.add(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message !== "") parts.push(message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(": ");
}

export interface GatewayDeps {
  repos: ReturnType<typeof createRepositories>;
  fetchImpl?: typeof fetch;
}

export interface GatewayModel {
  id: string;
  name?: string;
  context_length?: number;
}

export const ERROR_EXCERPT_CHARS = 200;

/**
 * Canonical API base used for building request URLs. When the value parses as
 * a URL, `new URL` supplies the canonical scheme/host casing and drops a
 * default port (`:443` for https, `:80` for http) — so `HTTPS://X.EXAMPLE`,
 * `https://x.example:443/v1` and the plain default all collapse to the same
 * base. Userinfo, query and hash are dropped: a base is scheme + host + path,
 * and keeping `https://…@evil.com` userinfo would let a lookalike read as a
 * different host here than the fetch actually targets. Then every trailing `/`
 * is dropped and one trailing `/v1` is dropped, so `https://x`, `https://x/v1`
 * and `https://x/v1/` all normalize to `https://x`. An empty input stays empty
 * (the caller treats it as "no endpoint configured"); unparseable input falls
 * back to the old string-only path so this never throws on arbitrary user
 * input.
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const stripV1 = (path: string): string => (path.endsWith("/v1") ? path.slice(0, -3) : path);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Unparseable: keep the previous text-level behavior, trimmed and
    // slash-stripped, so a malformed setting can never crash generation.
    return stripV1(trimmed.replace(/\/+$/, ""));
  }
  // Non-special schemes (`mailto:`, `data:`, …) report a "null" origin and
  // have no meaningful host; treat them as unparseable text rather than
  // fabricating one.
  if (url.origin === "null") return stripV1(trimmed.replace(/\/+$/, ""));
  return `${url.origin}${stripV1(url.pathname.replace(/\/+$/, ""))}`;
}

/**
 * Everything needed to reach one OpenAI-compatible upstream: where to send
 * the request and which bearer token (if any) to attach.
 */
export interface Endpoint {
  /** Normalized API base, no trailing slash, no trailing /v1 (gateway appends /v1/...). */
  baseUrl: string;
  /** Profile-supplied key, or null. */
  apiKey: string | null;
}

/**
 * Resolves the endpoint a call should use from a connection profile. An empty
 * (or whitespace-only) `base_url` means the profile has no endpoint configured
 * — surfaced as a clean 400 rather than a doomed upstream call. The secret
 * `api_key` is read only through `profiles.getSecret`, so it never rides on
 * the client-facing read shape.
 */
export async function resolveEndpoint(
  repos: GatewayDeps["repos"],
  profile: { id: string; base_url: string },
): Promise<Endpoint> {
  const baseUrl = normalizeBaseUrl(profile.base_url);
  if (baseUrl === "") {
    throw new GatewayError("No endpoint configured for this profile", 400);
  }
  // `getSecret` returns null for a profile that vanished between the caller
  // resolving it and this call, so the key degrades to absent rather than
  // throwing mid-generation.
  const apiKey = repos.profiles.getSecret(profile.id)?.api_key || null;
  return { baseUrl, apiKey };
}

/**
 * Bearer header for an endpoint, if one is required: a profile-supplied key
 * always wins (it is an explicit per-endpoint credential); a keyless endpoint
 * (Ollama, LM Studio, …) sends none by design.
 */
export function authHeadersFor(endpoint: Endpoint): Record<string, string> {
  if (endpoint.apiKey !== null && endpoint.apiKey !== "") {
    return { Authorization: `Bearer ${endpoint.apiKey}` };
  }
  return {};
}

/** True for client-visible error statuses (400–499) that pass through. */
function isClientError(status: number | undefined): status is ContentfulStatusCode {
  return typeof status === "number" && Number.isInteger(status) && 400 <= status && status < 500;
}

/**
 * The HTTP status an upstream error surfaces as: a `GatewayError`'s own status
 * passes through when it is a client-visible code (400–499, e.g. the 400 for an
 * unconfigured profile, or an upstream 401/429). A missing, invalid, or
 * server-side status — and any non-GatewayError — becomes 502 Bad Gateway.
 * Messages are already excerpt-capped upstream. Shared by the app's error
 * middleware and the routes that translate gateway failures by hand.
 */
export function gatewayStatus(err: unknown): ContentfulStatusCode {
  return err instanceof GatewayError && isClientError(err.status) ? err.status : 502;
}
