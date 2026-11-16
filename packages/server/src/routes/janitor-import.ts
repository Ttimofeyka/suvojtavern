/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import { z } from "zod";
import { JANITOR_ORIGIN, type JanitorBrowserStatus } from "../janitor/browser";
import { getJanitorBrowser } from "../janitor/browser-instance";
import { probeLogin } from "../janitor/client";
import { janitorErrorResponse, messageOf } from "../janitor/errors";
import { importPublicCard } from "../janitor/import";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";
import {
  type JanitorLoginState,
  janitorLoginState,
  markJanitorLoggedIn,
  markJanitorLoggedOut,
} from "./janitor-state";

/**
 * Phase A janitor routes: status, login, logout and the public-definition
 * import. The browser is created lazily by {@link getJanitorBrowser}.
 *
 * Status is cache-only: it reports what the process already observed (a
 * completed login or a successful import) and NEVER launches Chrome. Mounting
 * the Import dialog polls status, so probing here would spawn a browser window
 * for every user who merely opens the dialog. Chrome starts only for an
 * explicit login or an import/capture, both of which authenticate on their own.
 *
 * A missing JanitorAI session is a 400 (never 401): the whole app sits behind
 * HTTP Basic auth, so a 401 would surface the browser's native credential
 * dialog instead of reaching the SPA.
 */

/** No Chrome binary → the feature is unsupported until one is installed. */
const NO_CHROME_MESSAGE = "No Chrome/Chromium found — install one or set BUN_CHROME_PATH";

const LOGIN_POLL_INTERVAL_MS = 1_500;
const LOGIN_TIMEOUT_MS = 180_000;

/** Body of POST /api/janitor/import. */
const importSchema = z.object({
  url: z.string().min(1),
  onConflict: z.enum(["error", "rename", "replace"]).optional(),
  includeLorebooks: z.boolean().optional(),
});

/** Linux without a display cannot show the visible login window. */
function displayWarning(): string | null {
  if (process.platform !== "linux") return null;
  const display = (process.env.DISPLAY ?? "").trim();
  const wayland = (process.env.WAYLAND_DISPLAY ?? "").trim();
  if (display !== "" || wayland !== "") return null;
  return "No display detected (DISPLAY/WAYLAND_DISPLAY unset) — the login window may not appear";
}

/** Join the non-empty messages with a period, or null when there are none. */
function joinMessages(...parts: (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== "");
  return kept.length === 0 ? null : kept.join(". ");
}

/**
 * The two login-liveness flags every status response carries.
 *
 * `loginWindowOpen` is a browser that is up but idle: only a login leaves
 * Chrome running without an operation owning it (an import/capture always
 * disposes), so it means a sign-in window survived its poll and is still open.
 * `status.running` (Chrome up) plus a clear `status.busy` is exactly that
 * situation; a poll in flight is reported separately as `loginInProgress`.
 */
function loginFlags(
  browserStatus: JanitorBrowserStatus,
  state: JanitorLoginState,
): { loginInProgress: boolean; loginWindowOpen: boolean } {
  return {
    loginInProgress: state.running,
    loginWindowOpen: !state.running && !browserStatus.busy && browserStatus.running,
  };
}

export function janitorImportRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/janitor/status", (c) => {
    const browser = getJanitorBrowser(deps);
    const state = janitorLoginState(deps);
    const status = browser.status();
    const warning = displayWarning();
    const busy = status.busy || state.running;
    // `loggedIn` is a cached observation, not a live one: it is only meaningful
    // once a login or import wrote it (`checkedAt > 0`).
    const checked = state.checkedAt > 0;

    // No usable Chrome: answer instantly, never touch the browser.
    if (!status.supported) {
      return c.json({
        supported: false,
        loggedIn: false,
        checked,
        browser: null,
        busy,
        ...loginFlags(status, state),
        message: joinMessages(NO_CHROME_MESSAGE, warning),
      });
    }

    // Never fight a login/extraction for the single browser instance.
    if (busy) {
      return c.json({
        supported: true,
        loggedIn: state.loggedIn,
        checked,
        browser: status.chromePath,
        busy: true,
        ...loginFlags(status, state),
        message: joinMessages(state.running ? "A JanitorAI login is in progress" : null, warning),
      });
    }

    // A running, non-busy browser belongs to a login session: only a login can
    // outlive its operation (keepOpen after a timeout). Answer from cache while
    // it is up — launching to probe would mode-switch and tear down the very
    // window the user may still be signing in through.
    if (status.running) {
      return c.json({
        supported: true,
        loggedIn: state.loggedIn,
        checked,
        browser: status.chromePath,
        busy: false,
        ...loginFlags(status, state),
        message: warning,
      });
    }

    // Idle browser, cold or warm cache: report what the process already knows.
    // Status must never launch Chrome just to check a session; the user asks for
    // that explicitly by pressing Log in, and an import/capture self-authenticates.
    return c.json({
      supported: true,
      loggedIn: state.loggedIn,
      checked,
      browser: status.chromePath,
      busy: false,
      ...loginFlags(status, state),
      message: warning,
    });
  });

  /**
   * Start an interactive login. The window opens in the real browser and a
   * background poll watches for the session; the HTTP response is immediate
   * (202) rather than held open for the poll's three-minute budget. On success
   * the browser is disposed — the session persists in the profile directory.
   */
  app.post("/api/janitor/login", (c) => {
    const browser = getJanitorBrowser(deps);
    const state = janitorLoginState(deps);
    if (state.running) {
      return c.json({ error: "A JanitorAI login is already in progress" }, 409);
    }
    if (!browser.status().supported) {
      return c.json(badRequest(NO_CHROME_MESSAGE), 400);
    }
    state.running = true;
    // Each login gets its own attempt id so a logout can invalidate exactly the
    // in-flight poll (and nothing newer).
    const attempt = ++state.loginAttempt;
    void runLogin(browser, state, attempt)
      .catch((err) => console.warn("[janitor] login failed:", messageOf(err)))
      .finally(() => {
        state.running = false;
      });
    return c.json({ started: true }, 202);
  });

  /**
   * Stop an in-progress login poll and/or close a login window the server
   * retained after its timeout. This NEVER signs the user out: it disposes
   * Chrome (`browser.dispose()`), never deletes the persistent session
   * (`clearProfile()`), and leaves `state.loggedIn` untouched.
   *
   * Idempotent: with nothing to cancel it still answers success, so the SPA can
   * fire it whenever it believes a login may be running.
   */
  app.post("/api/janitor/login/cancel", async (c) => {
    const browser = getJanitorBrowser(deps);
    const state = janitorLoginState(deps);
    const status = browser.status();
    // A running import/capture owns the browser and must not be killed by a
    // login cancel. A login holds BOTH `state.running` and `status.busy`, so
    // the foreign-operation case is exactly "busy with no login poll".
    if (status.busy && !state.running) {
      return c.json({ error: "Another JanitorAI operation is running" }, 409);
    }
    // Bump the poll's cancellation token so it exits at its next check instead
    // of polling to its three-minute deadline…
    if (state.running) state.loginAttempt += 1;
    // …and dispose now so the window closes immediately rather than up to one
    // poll interval later. Disposing under the login's in-flight `withView` is
    // safe and needs no coordination: the in-flight view ops reject, the view
    // body throws, and `withView`'s guarded teardown releases `busy` without
    // resurrecting the killed Chrome. `dispose` is idempotent, so a body that
    // instead notices the bumped token and returns normally disposes again
    // harmlessly.
    await browser.dispose();
    state.running = false;
    state.checkedAt = Date.now();
    return c.json({ cancelled: true, loggedIn: state.loggedIn });
  });

  /** Clear the persisted session (delete the profile dir) and report logged out. */
  app.post("/api/janitor/logout", async (c) => {
    const state = janitorLoginState(deps);
    // Abort an in-flight login poll BEFORE killing the window it drives;
    // otherwise it keeps probing to its three-minute deadline and leaves
    // `running` (status busy, login 409) set the whole time.
    if (state.running) state.loginAttempt += 1;
    const browser = getJanitorBrowser(deps);
    try {
      await browser.clearProfile();
    } catch (err) {
      console.warn("[janitor] clear profile failed:", messageOf(err));
    }
    markJanitorLoggedOut(deps);
    return c.json({ loggedIn: false });
  });

  /**
   * Import a character whose definition is public. The UI should have used
   * `/capture` for a private one, but a `definition-private` error here tells
   * the SPA to offer exactly that.
   */
  app.post("/api/janitor/import", async (c) => {
    const parsed = parseJsonBody(importSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    try {
      const result = await importPublicCard(parsed.value, deps);
      markJanitorLoggedIn(deps);
      return c.json(result, 201);
    } catch (err) {
      const mapped = janitorErrorResponse(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return app;
}

/**
 * Run the visible login window and poll for the session. The window is kept up
 * only when sign-in did not complete (timeout or an unexpected throw) so the
 * user can finish and retry; a success — or an abort from /logout — tears Chrome
 * down inside the guarded teardown, so no concurrent call can race the close.
 * `attempt` identifies this poll so a logout can cancel it.
 */
async function runLogin(
  browser: ReturnType<typeof getJanitorBrowser>,
  state: ReturnType<typeof janitorLoginState>,
  attempt: number,
): Promise<void> {
  const outcome = await browser.withView(
    async (view) => {
      await view.navigate(`${JANITOR_ORIGIN}/login`).catch(() => {});
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      for (;;) {
        if (state.loginAttempt !== attempt) return { loggedIn: false, keepWindow: false };
        // A transient navigation/CDP failure must read as "not signed in yet",
        // the way JAR's `checkLogin` swallows its probe error and returns false:
        // aborting the whole poll on one hiccup would strand the login window
        // (`withView`'s keepOpen sees an `undefined` result) and never retry.
        let loggedIn = false;
        try {
          loggedIn = await probeLogin(view);
        } catch (error) {
          console.warn("[janitor] login probe failed:", messageOf(error));
        }
        if (loggedIn) return { loggedIn: true, keepWindow: false };
        if (Date.now() >= deadline) return { loggedIn: false, keepWindow: true };
        await Bun.sleep(LOGIN_POLL_INTERVAL_MS);
      }
    },
    // `undefined` means the view body threw: keep the window too (matching the
    // previous always-keepOpen behavior on an unexpected failure).
    { mode: "visible", keepOpen: (result) => result === undefined || result.keepWindow },
  );
  state.loggedIn = outcome.loggedIn;
  state.checkedAt = Date.now();
}
