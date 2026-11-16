/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JanitorBrowserHandle, RouteDeps } from "../routes-deps";
import { JanitorBrowser } from "./browser";

/**
 * Resolve the JanitorAI browser for a RouteDeps instance.
 *
 * An injected handle (tests, or an explicit `createApp` option) always wins.
 * Otherwise one {@link JanitorBrowser} is constructed lazily and memoised per
 * deps object — construction only resolves a Chrome path (it never spawns a
 * process), and the actual Chrome launch happens the first time a route calls
 * `withView`. Each app instance gets its own browser, and its profile lives
 * under `<dataDir>/janitor-browser` so sessions persist across restarts.
 *
 * Every real browser created here is also tracked for process shutdown: `bun
 * --watch` restarts (and Ctrl-C) would otherwise orphan a headful Chrome that
 * still holds the persistent profile — including a leftover login window.
 */

const instances = new WeakMap<RouteDeps, JanitorBrowserHandle>();

/** Real browsers created by this process (fakes injected for tests are not tracked). */
const liveBrowsers = new Set<JanitorBrowserHandle>();
let shutdownInstalled = false;

/** How long shutdown waits for Chrome to die before exiting regardless. */
const SHUTDOWN_GRACE_MS = 2_000;

/** Dispose every tracked browser (idempotent; the set is cleared last). */
export async function disposeLiveJanitorBrowsers(): Promise<void> {
  const browsers = [...liveBrowsers];
  liveBrowsers.clear();
  await Promise.all(browsers.map((browser) => browser.dispose().catch(() => {})));
}

function installShutdownHooks(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  // A natural exit (no signal) still runs `beforeExit`; dispose best-effort but
  // never call process.exit from here (that would recurse).
  process.on("beforeExit", () => {
    void disposeLiveJanitorBrowsers();
  });
}

/**
 * Dispose on a signal, then exit. The hard timer guarantees the process exits
 * even if a stuck CDP call makes a clean dispose hang.
 */
function shutdown(): void {
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  void disposeLiveJanitorBrowsers().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

export function getJanitorBrowser(deps: RouteDeps): JanitorBrowserHandle {
  const injected = deps.janitorBrowser;
  if (injected) return injected;
  let browser = instances.get(deps);
  if (browser === undefined) {
    const created = new JanitorBrowser({ profileDir: `${deps.dataDir ?? "data"}/janitor-browser` });
    installShutdownHooks();
    liveBrowsers.add(created);
    browser = created;
    instances.set(deps, browser);
  }
  return browser;
}
