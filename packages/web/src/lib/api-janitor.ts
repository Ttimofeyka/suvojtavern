/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JanitorAI import client.
 *
 * JanitorAI has no public API, so the server drives a real browser to read a
 * character page and (when the fast path cannot see the definition) to
 * reconstruct it. The browser lives on the server machine: `startJanitorLogin`
 * opens a visible window there and the rest of these calls operate that shared
 * session. Every endpoint shares the `{ error, details? }` failure shape;
 * two recoverable 400s carry `details.kind`, which `janitorErrorKind` reads.
 */

import { ApiError, api } from "./api";
import type { ImportConflict, ImportedCharacter, ImportedLorebook } from "./api-transfer";

/** Availability and session state of the server's JanitorAI browser. */
export interface JanitorStatus {
  /** False when the server has no usable browser (e.g. Chrome is not installed). */
  supported: boolean;
  loggedIn: boolean;
  /**
   * True once `loggedIn` reflects a real observation — a completed login or a
   * successful import. False on a fresh process, where status is answered from
   * an untouched cache without launching the browser to probe.
   */
  checked: boolean;
  /** Browser the server would drive, or null when unknown/unsupported. */
  browser: string | null;
  /** True while the server browser is mid-operation (login or capture). */
  busy: boolean;
  /** True while a login poll is in flight on the server. */
  loginInProgress: boolean;
  /**
   * True when a login window outlived its poll: the browser is up but idle
   * (a reloaded page can reattach to it, and Cancel can close it).
   */
  loginWindowOpen: boolean;
  /** Human-readable reason when unsupported or busy, else null. */
  message: string | null;
}

/** One attached JanitorAI lorebook and what the import did with it. */
export interface JanitorLorebook {
  id: string;
  title: string;
  /**
   * `imported` — entries were copied; `closed` — not readable without access;
   * `empty` — the book had no entries; `js` — script-driven, cannot be read.
   */
  status: "imported" | "closed" | "empty" | "js";
  /** Entry count, present when `status === "imported"`. */
  entries?: number;
}

/** Response of POST /api/janitor/import and /api/janitor/capture. */
export interface JanitorImportResult {
  /** Imported character row (same shape as `CardImportResult.character`). */
  character: ImportedCharacter;
  /**
   * First imported attached lorebook row, or null. Also present in `lorebooks`
   * (as its `imported` outcome) — janitor cards have no embedded
   * `character_book`.
   */
  lorebook: ImportedLorebook | null;
  /** Every lorebook the character attached on JanitorAI, and its outcome. */
  lorebooks: JanitorLorebook[];
  /** True when `onConflict: "rename"` produced a suffixed name. */
  renamed: boolean;
  source: "janitor";
  /** `public` — read straight from the page; `reconstructed` — rebuilt by capture. */
  definitionSource: "public" | "reconstructed";
  /** Non-fatal problems the import ran into (missing fields, skipped books…). */
  warnings: string[];
}

/** Recoverable JanitorAI failures carried in `ApiError.details.kind`. */
export type JanitorErrorKind = "not-logged-in" | "definition-private";

/** Options shared by the fast import and the slower full extraction. */
export interface JanitorImportOptions {
  /** Duplicate-name handling; omitted lets the server's default apply. */
  onConflict?: ImportConflict;
  /** Import the character's attached lorebooks too (server default: true). */
  includeLorebooks?: boolean;
}

/** Session/availability state of the server's JanitorAI browser. */
export function getJanitorStatus(): Promise<JanitorStatus> {
  return api("/api/janitor/status");
}

/**
 * Opens a VISIBLE browser window on the server machine and resolves as soon as
 * it starts (HTTP 202) — completion is not part of this response. Poll
 * `getJanitorStatus` to learn when the user has finished signing in.
 */
export function startJanitorLogin(): Promise<{ started: boolean }> {
  return api("/api/janitor/login", { method: "POST" });
}

/**
 * Stops an in-progress JanitorAI login poll and/or closes a login window the
 * server retained after its timeout. Never signs the session out — `loggedIn`
 * is the unchanged session state. Safe to call when nothing is pending.
 */
export function cancelJanitorLogin(): Promise<{ cancelled: boolean; loggedIn: boolean }> {
  return api("/api/janitor/login/cancel", { method: "POST" });
}

/** Closes the JanitorAI session in the server's browser. */
export function janitorLogout(): Promise<{ loggedIn: boolean }> {
  return api("/api/janitor/logout", { method: "POST" });
}

/**
 * Fast import: reads the character's definition straight from the public page.
 * Throws a `definition-private` error when the definition is not visible to an
 * anonymous visitor — the caller should then offer `captureJanitorCharacter`.
 */
export function importJanitorCharacter(
  url: string,
  opts: JanitorImportOptions = {},
): Promise<JanitorImportResult> {
  return api("/api/janitor/import", { method: "POST", body: janitorBody(url, opts) });
}

/**
 * Full extraction: drives the JanitorAI site to reconstruct a definition the
 * fast import cannot see. Much slower, and may rebuild attached lorebooks with
 * an LLM — use only as a fallback after a `definition-private` failure.
 */
export function captureJanitorCharacter(
  url: string,
  opts: JanitorImportOptions = {},
): Promise<JanitorImportResult> {
  return api("/api/janitor/capture", { method: "POST", body: janitorBody(url, opts) });
}

/** Hostnames whose `/characters/{id}` pages we import from (mirrors core). */
const JANITOR_HOSTS = new Set(["janitorai.com", "www.janitorai.com"]);

/** A JanitorAI character UUID (case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `input` looks like a JanitorAI character source, so the unified URL
 * section can route it to the JanitorAI flow instead of the generic direct-link
 * import. Mirrors core's `parseJanitorSource` classification (web must not
 * depend on `@suvoj/core`); only the coarse "is this JanitorAI?" answer is
 * needed here — the server re-validates the precise URL shape.
 */
export function isJanitorCharacterUrl(input: string): boolean {
  const trimmed = input.trim();
  // Has a scheme: require http(s) on a JanitorAI host with a `/characters/` path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    return JANITOR_HOSTS.has(url.hostname.toLowerCase()) && url.pathname.startsWith("/characters/");
  }
  // A bare UUID is the same shape a JanitorAI character URL embeds.
  if (UUID_RE.test(trimmed)) {
    return true;
  }
  // Scheme-less: the first `/`-separated segment is the host.
  const host = (trimmed.split("/")[0] ?? "").toLowerCase();
  return JANITOR_HOSTS.has(host);
}

/**
 * The recoverable JanitorAI failure `err` represents, or null for any other
 * error. Reads `ApiError.details.kind` so call sites never cast inline.
 */
export function janitorErrorKind(err: unknown): JanitorErrorKind | null {
  if (!(err instanceof ApiError)) {
    return null;
  }
  const details = err.details;
  if (details === null || typeof details !== "object") {
    return null;
  }
  const kind = (details as { kind?: unknown }).kind;
  return kind === "not-logged-in" || kind === "definition-private" ? kind : null;
}

/** True when `err` is a JanitorAI failure of exactly `kind`. */
export function isJanitorError(err: unknown, kind: JanitorErrorKind): boolean {
  return janitorErrorKind(err) === kind;
}

/** JSON.stringify drops undefined optionals, matching the omit-when-absent shape. */
function janitorBody(url: string, opts: JanitorImportOptions): string {
  return JSON.stringify({
    url,
    onConflict: opts.onConflict,
    includeLorebooks: opts.includeLorebooks,
  });
}
