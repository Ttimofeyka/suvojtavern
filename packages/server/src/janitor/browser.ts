/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Browser engine for the native JanitorAI importer.
 *
 * This is the Bun.WebView replacement for the standalone JAR tool's Playwright
 * engine (`src/capture.js`). The public surface, window modes and Chrome flags
 * mirror JAR 1:1; only the driving mechanism changed.
 *
 * Why we spawn Chrome ourselves instead of letting `new Bun.WebView()` do it:
 * Bun's own Chrome spawn is headless-only (`headless: false` throws), and
 * JanitorAI sits behind Cloudflare, which blocks headless Chrome. So we launch a
 * real headful Chrome with a persistent `--user-data-dir`
 * (`--remote-debugging-port=0`), read the port + WebSocket path from
 * `<profile>/DevToolsActivePort`, and hand that `ws://` URL to Bun.WebView as a
 * `backend: { type: "chrome", url }`. Bun then creates one tab per WebView in
 * the Chrome we own. Cloudflare clearance and login cookies persist in the
 * profile directory between runs.
 */

export type JanitorWindowMode = "visible" | "background";

export const JANITOR_ORIGIN = "https://janitorai.com";

/**
 * A normal desktop Chrome UA. This is mostly cosmetic, but it must NOT look like
 * a headless browser: Cloudflare flags the default `HeadlessChrome/...` token,
 * and JAR likewise always launched headful for the same reason.
 */
export const JANITOR_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** Error surfaced by every operation when no usable Chrome binary exists. */
const NO_CHROME_MESSAGE = "no Chrome/Chromium found; install one or set BUN_CHROME_PATH";

/** How long to wait for Chrome to write `DevToolsActivePort` after spawning. */
const DEVTOOLS_PORT_TIMEOUT_MS = 15_000;
const DEVTOOLS_PORT_POLL_MS = 100;

/** Operation timeouts. Generous: JanitorAI + Cloudflare navigations are slow. */
const NAVIGATE_TIMEOUT_MS = 60_000;
const EVALUATE_TIMEOUT_MS = 30_000;
const CDP_TIMEOUT_MS = 15_000;
const WAIT_FOR_TIMEOUT_MS = 30_000;
const WAIT_FOR_INTERVAL_MS = 250;

/** Grace period between SIGTERM and SIGKILL when tearing Chrome down. */
const KILL_GRACE_MS = 3_000;

/**
 * A stale singleton lock blocks a fast relaunch (close → immediately reopen,
 * e.g. switching visible→background after login); a stale `DevToolsActivePort`
 * would otherwise be read as this launch's port.
 */
const STALE_PROFILE_FILES = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "DevToolsActivePort",
];

/** Window geometry per mode, mirroring JAR's `startCapture`. */
const WINDOW_SIZES: Record<JanitorWindowMode, { width: number; height: number }> = {
  visible: { width: 1100, height: 820 },
  background: { width: 1280, height: 800 },
};

export interface JanitorBrowserOptions {
  /** Persistent Chrome profile (cookies/localStorage survive restarts). */
  profileDir: string;
  /** Explicit Chrome/Chromium path; when omitted it is auto-detected. */
  chromePath?: string | null;
}

/** A thin page facade handed to callers; wraps one BrowserView tab. */
export interface JanitorView {
  readonly url: string;
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** In-page fetch — shares the browser's cookies AND Cloudflare clearance. */
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string }>;
  /** Poll an expression until it is truthy (or the timeout elapses). */
  waitFor(expression: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<boolean>;
  /**
   * Register a Network.responseReceived hook; the body is fetched on
   * loadingFinished. Resolves once the Network domain is enabled (or the
   * retry-on-next-navigation fallback is armed), so a caller can `await` it
   * before sending the request whose response it needs.
   */
  onResponse(
    predicate: (url: string) => boolean,
    handler: (url: string, body: string) => void,
  ): Promise<void>;
  /**
   * Rewrite an outgoing request body via CDP Fetch interception (used to inject
   * a persona). `matches` decides whether a paused request is rewritten;
   * `cdpPattern` is the CDP-side URL glob that scopes which requests are paused
   * at all — keep it narrow (`"*generateAlpha*"`) rather than `"*"`, since every
   * paused request round-trips through CDP and a lost one deadlocks the page.
   * Resolves once `Fetch.enable` is acknowledged.
   */
  interceptRequest(
    matches: (url: string) => boolean,
    rewrite: (body: string) => string | null,
    cdpPattern?: string,
  ): Promise<void>;
}

export interface JanitorBrowserStatus {
  supported: boolean; // a Chrome binary was found
  chromePath: string | null;
  running: boolean; // a Chrome subprocess is currently up
  mode: JanitorWindowMode | null;
  busy: boolean; // an operation is in flight
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — not part of the stable public API)
// ---------------------------------------------------------------------------

/** Extract a character UUID from a JanitorAI character URL (or a bare UUID). */
export function parseCharacterId(input: string): string {
  const source = String(input ?? "").trim();
  const match = source.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (match === null) throw new Error(`no character id found in: ${source}`);
  return match[0];
}

export interface DevToolsPort {
  port: number;
  /** DevTools path, always leading with `/` (e.g. `/devtools/browser/<uuid>`). */
  wsPath: string;
}

/**
 * Parse Chrome's `DevToolsActivePort` file: line 1 is the port, line 2 the
 * browser WebSocket path. Returns null for every malformed shape — an empty
 * file, a single line (written but incomplete), a non-numeric or out-of-range
 * port — so the caller keeps polling during startup instead of connecting to a
 * half-written file.
 */
export function parseDevToolsActivePort(contents: string): DevToolsPort | null {
  const lines = contents.split(/\r?\n/);
  const portLine = lines[0];
  const pathLine = lines[1];
  if (portLine === undefined || pathLine === undefined) return null;
  const port = Number(portLine.trim());
  const wsPath = pathLine.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!wsPath.startsWith("/")) return null;
  return { port, wsPath };
}

export interface ChromeArgsOptions {
  mode: JanitorWindowMode;
  userDataDir: string;
  startUrl: string;
  userAgent: string;
}

/**
 * Chrome launch argv (without the executable itself). `--remote-debugging-port=0`
 * makes Chrome pick a free port and write it to `DevToolsActivePort`.
 *
 * The window modes mirror JAR: login gets a normal on-screen window; extraction
 * gets a real window pushed off-screen so it never steals focus, with background
 * throttling disabled so capture timing is not slowed while unfocused.
 */
export function buildChromeArgs(opts: ChromeArgsOptions): string[] {
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Chrome's own startup window would otherwise sit orphaned next to the tab
    // Bun later creates via `Target.createTarget` — the user sees two Chrome
    // windows, one a stray `about:blank` (with its unsupported-flag infobar).
    // Suppressing the startup window leaves Bun's page as the only one, while
    // `DevToolsActivePort` is still written so the CDP handshake is unchanged.
    "--no-startup-window",
    // The strongest automation tell Cloudflare checks; the normal UA above
    // handles the rest.
    "--disable-blink-features=AutomationControlled",
    `--user-agent=${opts.userAgent}`,
  ];
  if (opts.mode === "background") {
    args.push(
      "--window-position=-32000,-32000",
      "--window-size=1280,800",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    );
  } else {
    // Force an on-screen position so the login window can never come up
    // off-screen from a stale last-saved position.
    args.push("--window-position=80,60", "--window-size=1100,820");
  }
  args.push(opts.startUrl);
  return args;
}

/** Injectable filesystem/process seams so Chrome discovery is unit-testable. */
export interface ChromeLookupEnv {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  which(command: string): string | null;
  exists(path: string): boolean;
  readdir(path: string): string[];
}

/**
 * Resolve a Chrome-family executable, following Bun's documented precedence:
 * `BUN_CHROME_PATH` → `$PATH` → standard install locations → Playwright's cache.
 * Returns null when none is found (the caller reports `supported: false`).
 */
export function findChromePath(deps: ChromeLookupEnv): string | null {
  const fromEnv = deps.env.BUN_CHROME_PATH?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && deps.exists(fromEnv)) return fromEnv;

  for (const command of CHROME_COMMANDS) {
    const found = deps.which(command);
    if (found !== null && found !== "") return found;
  }

  for (const candidate of standardChromePaths(deps)) {
    if (deps.exists(candidate)) return candidate;
  }

  return playwrightChromePath(deps);
}

/** Command names tried on `$PATH`, in preference order. */
const CHROME_COMMANDS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "brave-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "chrome",
];

function standardChromePaths(deps: ChromeLookupEnv): string[] {
  if (deps.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(deps.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(deps.home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (deps.platform === "win32") {
    const programFiles = deps.env.ProgramFiles ?? deps.env.PROGRAMFILES ?? "";
    const programFilesX86 = deps.env["ProgramFiles(x86)"] ?? "";
    const localAppData = deps.env.LOCALAPPDATA ?? "";
    return [
      winPath(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      winPath(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      winPath(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      winPath(programFiles, "Chromium\\Application\\chrome.exe"),
      winPath(localAppData, "Chromium\\Application\\chrome.exe"),
      winPath(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      winPath(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      winPath(localAppData, "Microsoft\\Edge\\Application\\msedge.exe"),
    ].filter((candidate) => candidate !== "");
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/opt/google/chrome/google-chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ];
}

function winPath(base: string, rest: string): string {
  return base === "" ? "" : `${base}\\${rest}`;
}

function playwrightCacheDir(deps: ChromeLookupEnv): string | null {
  if (deps.platform === "darwin") return join(deps.home, "Library/Caches/ms-playwright");
  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA;
    return localAppData === undefined || localAppData === ""
      ? null
      : join(localAppData, "ms-playwright");
  }
  return join(deps.home, ".cache/ms-playwright");
}

/**
 * Newest Playwright Chromium build's executable, if the cache holds one. Full
 * `chromium-<build>` builds are preferred; `chromium_headless_shell-<build>` is
 * strictly headless (and thus Cloudflare-blocked) and only a last resort.
 */
function playwrightChromePath(deps: ChromeLookupEnv): string | null {
  const cache = playwrightCacheDir(deps);
  if (cache === null) return null;
  const entries = deps.readdir(cache);
  const full = entries.filter((name) => /^chromium-\d+$/.test(name)).sort(newestBuildFirst);
  for (const entry of full) {
    for (const segments of chromiumExecutableSegments(deps.platform)) {
      const candidate = join(cache, entry, ...segments);
      if (deps.exists(candidate)) return candidate;
    }
  }
  const shells = entries
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort(newestBuildFirst);
  for (const entry of shells) {
    for (const segments of headlessShellExecutableSegments(deps.platform)) {
      const candidate = join(cache, entry, ...segments);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

function newestBuildFirst(a: string, b: string): number {
  return buildNumber(b) - buildNumber(a);
}

function buildNumber(entry: string): number {
  const match = entry.match(/(\d+)$/);
  return match === null ? 0 : Number(match[1]);
}

function chromiumExecutableSegments(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") {
    return [
      ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
      ["chrome-mac-x64", "Chromium.app", "Contents", "MacOS", "Chromium"],
      ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
  }
  if (platform === "win32") {
    return [
      ["chrome-win64", "chrome.exe"],
      ["chrome-win", "chrome.exe"],
    ];
  }
  return [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
  ];
}

function headlessShellExecutableSegments(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") {
    return [
      ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
      ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
    ];
  }
  if (platform === "win32") {
    return [
      ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
      ["chrome-headless-shell-win", "chrome-headless-shell.exe"],
    ];
  }
  return [["chrome-headless-shell-linux64", "chrome-headless-shell"]];
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/**
 * Reject `promise` with a clear message if it has not settled within `ms`. The
 * timer is unref'd so a settled operation never keeps the server alive. Guards
 * every operation against a hung Chrome/renderer; a crashed subprocess is
 * rejected separately by Bun itself.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function closeView(view: Bun.WebView): void {
  try {
    view.close();
  } catch {
    // Already closed / renderer gone — nothing left to release.
  }
}

/**
 * SIGTERM Chrome, then SIGKILL if it lingers. `.kill()` on the spawned wrapper
 * reaches the real browser because the Chromium launcher `exec`s it.
 */
async function killProcess(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await raceExit(proc, KILL_GRACE_MS)) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await proc.exited.then(
    () => undefined,
    () => undefined,
  );
}

/** Resolve true when the subprocess exits within `ms`; unref'd timer. */
function raceExit(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    proc.exited.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Page facade + CDP wiring
// ---------------------------------------------------------------------------

interface ResponseHook {
  predicate: (url: string) => boolean;
  handler: (url: string, body: string) => void;
}

export interface InterceptRoute {
  matches: (url: string) => boolean;
  rewrite: (body: string) => string | null;
}

interface ViewState {
  networkWired: boolean;
  responses: ResponseHook[];
  /** requestId → url for responses a registered predicate matched. */
  pending: Map<string, string>;
  /** Fetch.requestPaused listener attached. */
  fetchWired: boolean;
  /**
   * CDP URL globs `Fetch.enable` is scoped to. Kept as a list so a successful
   * enable is not repeated, while a failed attempt (nothing recorded) retries.
   */
  fetchPatterns: string[];
  routes: InterceptRoute[];
}

interface NetworkResponseReceivedParams {
  requestId?: string;
  response?: { url?: string };
}

interface NetworkLoadingFinishedParams {
  requestId?: string;
}

interface NetworkLoadingFailedParams {
  requestId?: string;
}

interface ResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface FetchRequestPausedParams {
  requestId?: string;
  request?: { url?: string; method?: string; postData?: string };
}

/**
 * Subscribe to a CDP event with a typed `params` argument.
 *
 * `Bun.WebView.addEventListener` types its listener as `MessageEvent<T>` via
 * `Bun.MessageEvent<T>`, and with `lib: ["DOM"]` loaded bun-types'
 * `UseLibDomIfAvailable` infers the *constructor* type from `globalThis` rather
 * than the interface — so `event.data` is invisible to tsc (the runtime value is
 * a real MessageEvent, `data` is the CDP params). Read it through the `unknown`
 * cast here once instead of at every call site.
 */
function addCdpListener<T>(
  view: Bun.WebView,
  type: `${string}.${string}`,
  listener: (params: T) => void,
): void {
  view.addEventListener(type, (event) => {
    listener((event as unknown as { data: T }).data);
  });
}

/** Prefix that marks a page-side log line as ours; only these are forwarded. */
const JANITOR_LOG_PREFIX = "[janitor]";

/**
 * JAR's Supabase-token discovery (`autotrigger.js` `findToken`) ported verbatim
 * into a page-side function. JanitorAI's `/hampter/*` API authenticates with a
 * Supabase bearer token that the site's own client attaches — the session cookie
 * alone is not enough, so `profiles/mine` and the metadata endpoints answer 401
 * even while the UI looks signed in. The token lives in a `sb-<ref>-auth-token`
 * cookie (chunked across `.0`, `.1`, … cookies by size, hence the index-order
 * join) and, failing that, in localStorage.
 *
 * Kept as a source string rather than a chain of `evaluate()` calls so it runs
 * in the page, where `document.cookie` and `localStorage` are the real session,
 * and so it stays testable by evaluating the same source with synthetic globals.
 */
export const FIND_TOKEN_SOURCE = `function findToken() {
  const b64 = (s) => {
    try { return atob(s); } catch (e) {}
    try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch (e) {}
    return null;
  };
  const extract = (rawIn) => {
    let raw = rawIn;
    if (!raw) return null;
    try { raw = decodeURIComponent(raw); } catch (e) {}
    if (raw.indexOf("base64-") === 0) raw = raw.slice(7);
    if (raw.indexOf("eyJ") === 0 && raw.split(".").length === 3) return raw;
    for (const s of [b64(raw), raw]) {
      if (!s) continue;
      const mm = s.match(/"access_token":"(eyJ[^"]+)"/);
      if (mm) return mm[1];
      try {
        const o = JSON.parse(s);
        const c = o && (o.access_token || o.accessToken || o.token
          || (o.currentSession && o.currentSession.access_token));
        if (typeof c === "string" && c.indexOf("eyJ") === 0) return c;
      } catch (e) {}
    }
    return null;
  };
  try {
    const parts = {};
    for (const c of (document.cookie || "").split("; ")) {
      const eq = c.indexOf("=");
      if (eq < 0) continue;
      const mm = c.slice(0, eq).match(/^(sb-.*-auth-token)(?:\\.(\\d+))?$/);
      if (!mm) continue;
      const base = mm[1];
      const idx = mm[2] ? parseInt(mm[2], 10) : 0;
      (parts[base] = parts[base] || {})[idx] = c.slice(eq + 1);
    }
    for (const base in parts) {
      const idxs = Object.keys(parts[base]).map(Number).sort((a, b) => a - b);
      let joined = "";
      for (const j of idxs) joined += parts[base][j];
      const t = extract(joined);
      if (t) return t;
    }
  } catch (e) {}
  try {
    for (let k = 0; k < localStorage.length; k += 1) {
      const t = extract(localStorage.getItem(localStorage.key(k)));
      if (t) return t;
    }
  } catch (e) {}
  return null;
}`;

/** JanitorAI's host, used to scope where the bearer token may be attached. */
const JANITOR_HOST = new URL(JANITOR_ORIGIN).hostname;

/**
 * Build the in-page fetch expression for {@link JanitorView.fetch}. The request
 * runs inside the page so it inherits the logged-in cookie jar, Cloudflare
 * clearance and TLS fingerprint; `accept` is always JSON, and any caller header
 * is passed through verbatim.
 *
 * A Supabase bearer token discovered in the page is attached for janitorai.com
 * only — never another origin — and a caller-supplied `Authorization` header
 * still wins. The `[janitor] supabase token found: yes|no` line is a non-secret
 * diagnostic; the token itself is never logged.
 */
export function buildFetchExpression(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): string {
  const requestInit: Record<string, unknown> = {
    credentials: "include",
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  };
  if (init?.method !== undefined) requestInit.method = init.method;
  if (init?.body !== undefined) requestInit.body = init.body;
  return `(async () => {
    ${FIND_TOKEN_SOURCE}
    const init = ${JSON.stringify(requestInit)};
    if (new URL(${JSON.stringify(url)}).hostname === ${JSON.stringify(JANITOR_HOST)}) {
      const token = findToken();
      console.log("${JANITOR_LOG_PREFIX} supabase token found: " + (token === null ? "no" : "yes"));
      const hasAuthorization = Object.keys(init.headers)
        .some((key) => key.toLowerCase() === "authorization");
      if (token !== null && !hasAuthorization) init.headers.authorization = "Bearer " + token;
    }
    const response = await fetch(${JSON.stringify(url)}, init);
    return { status: response.status, body: await response.text() };
  })()`;
}

async function waitForExpression(
  view: Bun.WebView,
  expression: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? WAIT_FOR_TIMEOUT_MS;
  const intervalMs = opts?.intervalMs ?? WAIT_FOR_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  // `await (...)` is required: evaluate() itself awaits the outer value, but a
  // bare Boolean(<promise>) would read as `true`. An IIFE that awaits the
  // expression first keeps promise-returning probes honest.
  const script = `(async () => Boolean(await (${expression})))()`;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const value = await withTimeout(
        view.evaluate<unknown>(script),
        Math.min(remaining, timeoutMs),
        "waitFor",
      );
      if (value === true) return true;
    } catch {
      // The page may be mid-navigation or the element momentarily absent —
      // a transient evaluation error is retried until the deadline.
    }
    const sleepMs = Math.max(0, Math.min(intervalMs, deadline - Date.now()));
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }
  return false;
}

/**
 * Wire CDP Network capture for this view once, then register `hook`. The body
 * is fetched when the matching response finishes loading; `getResponseBody`
 * failures are logged and skipped so a page can never be broken by the capture.
 *
 * `Network.enable` needs a prior `navigate()` to have set up the CDP session, so
 * callers must navigate (e.g. `about:blank`) before the first `onResponse`.
 */
async function attachResponseCapture(
  view: Bun.WebView,
  state: ViewState,
  predicate: (url: string) => boolean,
  handler: (url: string, body: string) => void,
): Promise<void> {
  state.responses.push({ predicate, handler });
  if (state.networkWired) return;
  state.networkWired = true;

  addCdpListener<NetworkResponseReceivedParams>(view, "Network.responseReceived", (params) => {
    const url = params.response?.url;
    const requestId = params.requestId;
    if (typeof url !== "string" || typeof requestId !== "string") return;
    if (!state.responses.some((hook) => hook.predicate(url))) return;
    state.pending.set(requestId, url);
  });

  addCdpListener<NetworkLoadingFinishedParams>(view, "Network.loadingFinished", (params) => {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const url = state.pending.get(requestId);
    if (url === undefined) return;
    state.pending.delete(requestId);
    void deliverResponseBody(view, state, requestId, url);
  });

  // A failed matching request never fires loadingFinished, so drop its pending
  // entry here or the map leaks for the life of the view.
  addCdpListener<NetworkLoadingFailedParams>(view, "Network.loadingFailed", (params) => {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    state.pending.delete(requestId);
  });

  // `cdp()` needs a prior navigate() to have set up the session; await the
  // attempt so a caller can wait before triggering the request it needs. When
  // it fails (registered before the first navigate), arm a one-shot retry on
  // the next navigation instead of losing capture forever.
  if (await enableNetworkDomain(view)) return;
  view.onNavigated = () => {
    void enableNetworkDomain(view).then((enabled) => {
      if (enabled) view.onNavigated = null;
    });
  };
}

async function enableNetworkDomain(view: Bun.WebView): Promise<boolean> {
  try {
    // `onResponse` awaits this on the capture's critical path, so a wedged
    // renderer would otherwise hang the capture — and `withView`'s busy flag —
    // forever. Bound it like the sibling Fetch.enable; returning false keeps the
    // onNavigated retry/fallback path alive.
    await withTimeout(view.cdp("Network.enable"), CDP_TIMEOUT_MS, "Network.enable");
    return true;
  } catch {
    return false;
  }
}

async function deliverResponseBody(
  view: Bun.WebView,
  state: ViewState,
  requestId: string,
  url: string,
): Promise<void> {
  let body: string;
  try {
    const result = await view.cdp<ResponseBodyResult>("Network.getResponseBody", { requestId });
    const raw = result.body ?? "";
    body = result.base64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;
  } catch (error) {
    // The body may be evicted or the response a redirect/prefetch — skip it
    // rather than faulting the capture.
    console.warn(`[janitor] response body unavailable for ${url}:`, error);
    return;
  }
  for (const hook of state.responses) {
    if (!hook.predicate(url)) continue;
    try {
      hook.handler(url, body);
    } catch (error) {
      console.warn(`[janitor] response handler failed for ${url}:`, error);
    }
  }
}

/**
 * Enable CDP Fetch interception scoped to `cdpPattern` and register a rewrite
 * route. The CDP glob must stay narrow (e.g. `"*generateAlpha*"`): every paused
 * request round-trips through CDP, and a paused request whose session is lost
 * deadlocks the page. `matches` still makes the rewrite decision, since a CDP
 * glob cannot express an arbitrary predicate. Requests already enabled for this
 * pattern are not re-enabled; a failed enable is retried by a later call.
 */
async function attachInterceptor(
  view: Bun.WebView,
  state: ViewState,
  matches: (url: string) => boolean,
  rewrite: (body: string) => string | null,
  cdpPattern: string,
): Promise<void> {
  state.routes.push({ matches, rewrite });
  if (!state.fetchWired) {
    state.fetchWired = true;
    addCdpListener<FetchRequestPausedParams>(view, "Fetch.requestPaused", (params) => {
      void handleInterceptedRequest(view, state, params);
    });
  }
  if (state.fetchPatterns.includes(cdpPattern)) return;
  const patterns = [...state.fetchPatterns, cdpPattern];
  // Recorded only after the CDP call resolves, so a caller that races the first
  // navigate() gets a rejection here and can retry rather than silently losing
  // interception forever.
  await withTimeout(
    view.cdp("Fetch.enable", {
      patterns: patterns.map((pattern) => ({ urlPattern: pattern, requestStage: "Request" })),
    }),
    CDP_TIMEOUT_MS,
    "Fetch.enable",
  );
  state.fetchPatterns.push(cdpPattern);
}

/**
 * The `Fetch.continueRequest` payload for one paused request. Pure so the
 * deadlock-critical contract is unit-testable without CDP: EVERY paused request
 * yields a continue, a throwing rewriter is swallowed (logged) and continues
 * unchanged, and `postData` (base64) appears only when a matching POST was
 * actually rewritten. Returning the base object without `postData` means
 * "continue as-is".
 */
export function interceptContinueParams(
  routes: InterceptRoute[],
  request: { url: string; method: string; postData?: string },
): { postData?: string } {
  if (request.method !== "POST" || typeof request.postData !== "string") return {};
  const route = routes.find((candidate) => candidate.matches(request.url));
  if (route === undefined) return {};
  let next: string | null;
  try {
    next = route.rewrite(request.postData);
  } catch (error) {
    console.warn(`[janitor] request rewrite failed for ${request.url}:`, error);
    return {};
  }
  if (typeof next === "string" && next !== request.postData) {
    return { postData: Buffer.from(next, "utf8").toString("base64") };
  }
  return {};
}

async function handleInterceptedRequest(
  view: Bun.WebView,
  state: ViewState,
  params: FetchRequestPausedParams,
): Promise<void> {
  const requestId = params.requestId;
  if (typeof requestId !== "string") return;
  const url = params.request?.url ?? "";
  const method = (params.request?.method ?? "GET").toUpperCase();

  const continueParams: { requestId: string; postData?: string } = {
    requestId,
    ...interceptContinueParams(state.routes, {
      url,
      method,
      postData: params.request?.postData,
    }),
  };

  try {
    await view.cdp("Fetch.continueRequest", continueParams);
  } catch (error) {
    console.warn(`[janitor] failed to continue intercepted request ${url}:`, error);
  }
}

/**
 * Forward only our own `[janitor]`-prefixed page logs to the server console.
 * The page is a third-party site that logs freely, so mirroring its entire
 * console would drown the server log; the token diagnostic is exactly the kind
 * of page-side line worth surfacing.
 */
function forwardJanitorConsole(type: string, ...args: unknown[]): void {
  const first = args[0];
  if (typeof first !== "string" || !first.startsWith(JANITOR_LOG_PREFIX)) return;
  const sink = type === "error" ? console.error : type === "warn" ? console.warn : console.log;
  sink(...args);
}

function createJanitorView(raw: Bun.WebView): JanitorView {
  const state: ViewState = {
    networkWired: false,
    responses: [],
    pending: new Map(),
    fetchWired: false,
    fetchPatterns: [],
    routes: [],
  };
  return {
    get url() {
      return raw.url;
    },
    async navigate(url: string) {
      await withTimeout(raw.navigate(url), NAVIGATE_TIMEOUT_MS, `navigate(${url})`);
    },
    async evaluate<T = unknown>(expression: string) {
      return withTimeout(raw.evaluate<T>(expression), EVALUATE_TIMEOUT_MS, "evaluate");
    },
    async fetch(url, init) {
      const result = await withTimeout(
        raw.evaluate<{ status?: number; body?: string }>(buildFetchExpression(url, init)),
        EVALUATE_TIMEOUT_MS,
        "fetch",
      );
      return { status: result?.status ?? 0, body: result?.body ?? "" };
    },
    async waitFor(expression, opts) {
      return waitForExpression(raw, expression, opts);
    },
    async onResponse(predicate, handler) {
      await attachResponseCapture(raw, state, predicate, handler);
    },
    async interceptRequest(matches, rewrite, cdpPattern) {
      await attachInterceptor(raw, state, matches, rewrite, cdpPattern ?? "*");
    },
  };
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

export class JanitorBrowser {
  private readonly profileDir: string;
  private readonly chromePath: string | null;
  private chrome: Bun.Subprocess | null = null;
  private wsUrl: string | null = null;
  private mode: JanitorWindowMode | null = null;
  private busy = false;
  private starting: Promise<void> | null = null;
  private readonly views = new Set<Bun.WebView>();

  constructor(options: JanitorBrowserOptions) {
    this.profileDir = options.profileDir;
    this.chromePath = resolveChromePath(options.chromePath);
  }

  status(): JanitorBrowserStatus {
    return {
      supported: this.chromePath !== null,
      chromePath: this.chromePath,
      running: this.chrome !== null,
      mode: this.mode,
      busy: this.busy,
    };
  }

  /**
   * Run `fn` against a fresh tab, opening the browser in `mode` if needed.
   * One operation at a time: concurrent calls reject with a clear error.
   * Unless `keepOpen`, the browser is closed afterwards.
   */
  async withView<T>(
    fn: (view: JanitorView) => Promise<T>,
    opts?: {
      mode?: JanitorWindowMode;
      /**
       * Keep Chrome + its tab up after `fn` instead of tearing them down. A
       * predicate receives `fn`'s value (or `undefined` when it threw) so a
       * login keeps the window only on failure; the decision runs inside the
       * guarded teardown, so a concurrent call can never slip in between it and
       * the disposal.
       */
      keepOpen?: boolean | ((result: T | undefined) => boolean);
    },
  ): Promise<T> {
    if (this.chromePath === null) throw new Error(NO_CHROME_MESSAGE);
    if (this.busy) {
      throw new Error("the JanitorAI browser is busy (a login or extraction is already running)");
    }
    this.busy = true;
    const keepOpenOption = opts?.keepOpen;
    const mode = opts?.mode ?? "background";
    let view: Bun.WebView | null = null;
    let result: T | undefined;
    try {
      view = await this.openView(mode);
      const value = await fn(createJanitorView(view));
      result = value;
      return value;
    } finally {
      const keepOpen =
        typeof keepOpenOption === "function" ? keepOpenOption(result) : keepOpenOption === true;
      // keepOpen leaves both Chrome and its tab up (login needs the window to
      // stay visible); otherwise the tab and the whole browser go away.
      if (view !== null && !keepOpen) {
        this.views.delete(view);
        closeView(view);
      }
      if (keepOpen) {
        this.busy = false;
      } else {
        // Hold `busy` through teardown so a concurrent call cannot start a new
        // launch against a profile the old Chrome is still releasing.
        try {
          await this.dispose();
        } finally {
          this.busy = false;
        }
      }
    }
  }

  /** Kill Chrome (idempotent). */
  async dispose(): Promise<void> {
    await this.stopChrome();
  }

  /** Kill Chrome and delete the persistent profile (= logout). */
  async clearProfile(): Promise<void> {
    await this.dispose();
    await rm(this.profileDir, { recursive: true, force: true });
  }

  private async openView(mode: JanitorWindowMode): Promise<Bun.WebView> {
    await this.ensureChrome(mode);
    const wsUrl = this.wsUrl;
    if (wsUrl === null) throw new Error("JanitorAI browser is not connected");
    const { width, height } = WINDOW_SIZES[mode];
    const view = new Bun.WebView({
      backend: { type: "chrome", url: wsUrl },
      width,
      height,
      // Surface our in-page diagnostics (the Supabase token probe) in the server
      // log without mirroring the site's own console output.
      console: forwardJanitorConsole,
    });
    this.views.add(view);
    return view;
  }

  /**
   * Ensure Chrome is up in `mode`; a running browser in a DIFFERENT mode is
   * closed and relaunched, because one persistent profile can only be one
   * window mode at a time (exactly JAR's `ensureStarted`).
   */
  private async ensureChrome(mode: JanitorWindowMode): Promise<void> {
    if (this.chrome !== null && this.mode === mode && this.wsUrl !== null) return;
    if (this.chrome !== null) await this.stopChrome();
    if (this.starting === null) {
      this.starting = this.launch(mode).finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async stopChrome(): Promise<void> {
    const proc = this.chrome;
    const views = [...this.views];
    this.views.clear();
    this.chrome = null;
    this.wsUrl = null;
    this.mode = null;
    for (const view of views) closeView(view);
    if (proc !== null) await killProcess(proc);
  }

  private async launch(mode: JanitorWindowMode): Promise<void> {
    const chromePath = this.chromePath;
    if (chromePath === null) throw new Error(NO_CHROME_MESSAGE);
    // The profile holds live session cookies; 0700 keeps other local users out
    // (mkdir's mode only applies to a newly-created dir, hence the chmod too).
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.profileDir, 0o700);
    } catch {
      // Best-effort: a filesystem that cannot chmod must not block the launch.
    }
    for (const name of STALE_PROFILE_FILES) {
      rmSync(join(this.profileDir, name), { force: true });
    }

    const args = buildChromeArgs({
      mode,
      userDataDir: this.profileDir,
      startUrl: "about:blank",
      userAgent: JANITOR_USER_AGENT,
    });
    const proc = Bun.spawn([chromePath, ...args], { stdout: "ignore", stderr: "ignore" });
    this.chrome = proc;
    // A crash (bad flags, missing display) must not read as "running" forever.
    void proc.exited
      .then(() => {
        if (this.chrome === proc) {
          this.chrome = null;
          this.wsUrl = null;
          this.mode = null;
        }
      })
      .catch(() => {});

    try {
      const wsUrl = await this.waitForDevToolsPort(proc);
      if (this.chrome !== proc) throw new Error("the JanitorAI browser was stopped while starting");
      this.wsUrl = wsUrl;
      this.mode = mode;
    } catch (error) {
      if (this.chrome === proc) {
        this.chrome = null;
        this.wsUrl = null;
        this.mode = null;
      }
      await killProcess(proc);
      throw error;
    }
  }

  private async waitForDevToolsPort(proc: Bun.Subprocess): Promise<string> {
    const portFile = join(this.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + DEVTOOLS_PORT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`Chrome exited with code ${proc.exitCode} before exposing a DevTools port`);
      }
      if (this.chrome !== proc) throw new Error("the JanitorAI browser was stopped while starting");
      let parsed: DevToolsPort | null = null;
      try {
        parsed = parseDevToolsActivePort(readFileSync(portFile, "utf8"));
      } catch {
        // Not written yet — keep polling.
      }
      if (parsed !== null) return `ws://127.0.0.1:${parsed.port}${parsed.wsPath}`;
      await Bun.sleep(DEVTOOLS_PORT_POLL_MS);
    }
    throw new Error(`Chrome did not expose a DevTools port within ${DEVTOOLS_PORT_TIMEOUT_MS}ms`);
  }
}

/**
 * Resolve the executable eagerly, but never throw: an explicit path that does
 * not exist, a broken environment or a missing binary all degrade to `null`
 * (reported via `supported: false`) so constructing the browser is always safe.
 */
function resolveChromePath(explicit: string | null | undefined): string | null {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    return existsSync(trimmed) ? trimmed : null;
  }
  try {
    return findChromePath({
      env: process.env as Record<string, string | undefined>,
      platform: process.platform,
      home: homedir(),
      which: (command) => Bun.which(command),
      exists: (path) => existsSync(path),
      readdir: (dir) => {
        try {
          return readdirSync(dir);
        } catch {
          return [];
        }
      },
    });
  } catch {
    return null;
  }
}
