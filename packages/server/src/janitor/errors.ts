/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Errors thrown by the JanitorAI import orchestration.
 *
 * Routes map these onto HTTP responses: `status` is the response code and
 * `details` rides along as the `details` field of the app's standard
 * `{ error, details? }` envelope. The two `kind`-tagged failures let the web
 * client branch without parsing a message — `definition-private` in particular
 * drives the UI's "Extract anyway" button, which calls POST /api/janitor/capture.
 *
 * Nothing here uses 401: the whole app sits behind HTTP Basic auth, so a 401
 * would pop the browser's native credential dialog instead of reaching the SPA.
 * A missing JanitorAI login is a plain 400 like every other unusable-input case.
 */

/** Discriminator carried in `details.kind` for the failures the UI branches on. */
export type JanitorErrorKind = "not-logged-in" | "definition-private";

export class JanitorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
    readonly details?: { kind: JanitorErrorKind },
  ) {
    super(message);
    this.name = "JanitorError";
  }
}

/** The user has no live JanitorAI session; the UI points at the Log in button. */
export function notLoggedInError(): JanitorError {
  return new JanitorError(
    "Not logged into JanitorAI — open the JanitorAI panel and click Log in first",
    400,
    { kind: "not-logged-in" },
  );
}

/** The character's definition is private; full extraction is the only path. */
export function definitionPrivateError(): JanitorError {
  return new JanitorError(
    "This character's definition is private — use full extraction to reconstruct the card",
    400,
    { kind: "definition-private" },
  );
}

/** Plain-Error message extraction (core importers throw bare Errors). */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a thrown orchestration error onto the `{ error, details? }` envelope and
 * its HTTP status. A `JanitorError` carries both; anything else (core importer
 * failures, browser lifecycle errors) is an unusable-request 400.
 */
export function janitorErrorResponse(err: unknown): {
  body: { error: string; details?: unknown };
  status: 400 | 409;
} {
  if (err instanceof JanitorError) {
    return {
      body:
        err.details === undefined
          ? { error: err.message }
          : { error: err.message, details: err.details },
      status: err.status,
    };
  }
  return { body: { error: messageOf(err) }, status: 400 };
}
