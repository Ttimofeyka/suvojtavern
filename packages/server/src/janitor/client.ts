/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { st } from "@suvoj/core";
import { JANITOR_ORIGIN, JANITOR_USER_AGENT, type JanitorView } from "./browser";

/**
 * Thin, typed JanitorAI calls over a live {@link JanitorView}.
 *
 * Every API call runs through `view.fetch`, i.e. inside the page, so it shares
 * the logged-in cookie jar and the Cloudflare clearance the browser obtained.
 * These helpers never throw on an HTTP failure — they return null (or false)
 * and leave the decision to the orchestrator, which knows whether the failure
 * is fatal (metadata for a real import) or merely a warning (one lorebook).
 */

/** The authenticated-profile probe: 200 while a session is live, 401 when not. */
export const JANITOR_PROFILES_MINE_URL = `${JANITOR_ORIGIN}/hampter/profiles/mine`;

/** True when the browser session is authenticated (probe errors count as "no"). */
export async function probeLogin(view: JanitorView): Promise<boolean> {
  try {
    const res = await view.fetch(JANITOR_PROFILES_MINE_URL);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** The `/hampter/characters/:id` catalog record, or null on any non-200/bad JSON. */
export async function fetchCharacterMetadata(
  view: JanitorView,
  id: string,
): Promise<unknown | null> {
  return fetchJsonOrNull(view, st.janitorCharacterApiUrl(id));
}

/** The `/hampter/script/:id` public-lorebook record, or null when unavailable. */
export async function fetchLorebookScript(view: JanitorView, id: string): Promise<unknown | null> {
  return fetchJsonOrNull(view, st.janitorScriptApiUrl(id));
}

/**
 * The lorebook's human-readable description, scraped from its public
 * `/scripts/<id>` page. The `/hampter` record's own `description` is usually
 * empty, so this mirrors JAR's `fetchScriptDescription`. Never throws: a
 * closed/unavailable page (or a logged-out session) yields "" and the caller
 * falls back to the record description.
 */
export async function fetchLorebookDescription(view: JanitorView, id: string): Promise<string> {
  try {
    const res = await view.fetch(`${JANITOR_ORIGIN}/scripts/${encodeURIComponent(id)}`);
    if (res.status >= 400) return "";
    return st.parseScriptPublishedContent(res.body);
  } catch {
    return "";
  }
}

async function fetchJsonOrNull(view: JanitorView, url: string): Promise<unknown | null> {
  try {
    const res = await view.fetch(url);
    if (res.status !== 200) return null;
    return JSON.parse(res.body) as unknown;
  } catch {
    // A hung evaluate, a mid-navigation page or malformed JSON all read as
    // "no record" — the caller decides whether that is fatal.
    return null;
  }
}

// --- avatar download ---------------------------------------------------------

/** Generous ceiling for a bot avatar; anything larger is rejected untouched. */
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 30_000;

/**
 * Download a character's avatar from the public `ella.janitorai.com` CDN.
 *
 * Deliberately SERVER-SIDE via the injected fetch (unlike the API calls above):
 * the avatar CDN is public and needs neither the JanitorAI cookies nor the
 * Cloudflare clearance, so it must not drag the browser into the picture. Any
 * failure — bad status, non-image content type, oversized body, network error —
 * yields null so the character still imports without an avatar.
 */
export async function downloadAvatar(
  fetchImpl: typeof fetch,
  avatarFile: string | null | undefined,
): Promise<Uint8Array | null> {
  const file = String(avatarFile ?? "").trim();
  if (file === "") return null;
  try {
    const res = await fetchImpl(st.janitorAvatarUrl(file), {
      headers: { "User-Agent": JANITOR_USER_AGENT, Accept: "image/*" },
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;
    return await readCapped(res, AVATAR_MAX_BYTES);
  } catch {
    return null;
  }
}

/** Stream a response body into one buffer, aborting past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
