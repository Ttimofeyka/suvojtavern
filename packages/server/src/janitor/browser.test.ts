/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  buildChromeArgs,
  buildFetchExpression,
  type ChromeLookupEnv,
  FIND_TOKEN_SOURCE,
  findChromePath,
  interceptContinueParams,
  JANITOR_ORIGIN,
  JANITOR_USER_AGENT,
  JanitorBrowser,
  parseCharacterId,
  parseDevToolsActivePort,
} from "./browser";

// ---------------------------------------------------------------------------
// parseCharacterId
// ---------------------------------------------------------------------------

describe("parseCharacterId", () => {
  it("extracts the uuid from a character URL with a slug", () => {
    expect(
      parseCharacterId(
        "https://janitorai.com/characters/6b1f0d2a-9c34-4c7e-8a1b-2f3d4e5f6a7b_some-slug",
      ),
    ).toBe("6b1f0d2a-9c34-4c7e-8a1b-2f3d4e5f6a7b");
  });

  it("accepts a bare uuid (and uppercases stay intact)", () => {
    expect(parseCharacterId("6B1F0D2A-9C34-4C7E-8A1B-2F3D4E5F6A7B")).toBe(
      "6B1F0D2A-9C34-4C7E-8A1B-2F3D4E5F6A7B",
    );
    expect(parseCharacterId("  6b1f0d2a-9c34-4c7e-8a1b-2f3d4e5f6a7b  ")).toBe(
      "6b1f0d2a-9c34-4c7e-8a1b-2f3d4e5f6a7b",
    );
  });

  it("throws when no uuid is present", () => {
    expect(() => parseCharacterId("https://janitorai.com/characters/not-a-uuid")).toThrow(
      "no character id found",
    );
    expect(() => parseCharacterId("")).toThrow("no character id found");
  });
});

// ---------------------------------------------------------------------------
// parseDevToolsActivePort
// ---------------------------------------------------------------------------

describe("parseDevToolsActivePort", () => {
  it("parses the port and websocket path", () => {
    expect(parseDevToolsActivePort("37601\n/devtools/browser/abc-123\n")).toEqual({
      port: 37601,
      wsPath: "/devtools/browser/abc-123",
    });
  });

  it("tolerates CRLF line endings", () => {
    expect(parseDevToolsActivePort("9222\r\n/devtools/browser/x\r\n")).toEqual({
      port: 9222,
      wsPath: "/devtools/browser/x",
    });
  });

  it("rejects empty and half-written (stale) files", () => {
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("\n")).toBeNull();
    // Port written, path not yet — Chrome is mid-write.
    expect(parseDevToolsActivePort("37601")).toBeNull();
    expect(parseDevToolsActivePort("37601\n")).toBeNull();
  });

  it("rejects malformed or out-of-range ports", () => {
    expect(parseDevToolsActivePort("abc\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("12.5\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("0\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("-1\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("70000\n/devtools/browser/x")).toBeNull();
  });

  it("rejects a path that is not a devtools path", () => {
    expect(parseDevToolsActivePort("37601\ndevtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("37601\nnot-a-path")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildChromeArgs
// ---------------------------------------------------------------------------

describe("buildChromeArgs", () => {
  const base = {
    userDataDir: "/tmp/janitor-profile",
    startUrl: "about:blank",
    userAgent: JANITOR_USER_AGENT,
  };

  it("visible mode: on-screen window, no background-throttling flags", () => {
    const args = buildChromeArgs({ ...base, mode: "visible" });
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--user-data-dir=/tmp/janitor-profile");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain(`--user-agent=${JANITOR_USER_AGENT}`);
    expect(args).toContain("--window-position=80,60");
    expect(args).toContain("--window-size=1100,820");
    expect(args).not.toContain("--window-position=-32000,-32000");
    expect(args).not.toContain("--disable-background-timer-throttling");
    // Suppresses Chrome's own startup window, so only Bun's target remains.
    expect(args).toContain("--no-startup-window");
    expect(args.at(-1)).toBe("about:blank");
  });

  it("background mode: off-screen window with throttling disabled", () => {
    const args = buildChromeArgs({ ...base, mode: "background" });
    expect(args).toContain("--window-position=-32000,-32000");
    expect(args).toContain("--window-size=1280,800");
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).not.toContain("--window-position=80,60");
    expect(args).toContain("--no-startup-window");
    expect(args.at(-1)).toBe("about:blank");
  });
});

// ---------------------------------------------------------------------------
// findChromePath
// ---------------------------------------------------------------------------

function makeLookup(overrides: Partial<ChromeLookupEnv> = {}): ChromeLookupEnv {
  return {
    env: {},
    platform: "linux",
    home: "/home/tester",
    which: () => null,
    exists: () => false,
    readdir: () => [],
    ...overrides,
  };
}

describe("findChromePath", () => {
  it("prefers BUN_CHROME_PATH over $PATH", () => {
    const deps = makeLookup({
      env: { BUN_CHROME_PATH: "/custom/chrome" },
      which: () => "/path/chrome",
      exists: (path) => path === "/custom/chrome",
    });
    expect(findChromePath(deps)).toBe("/custom/chrome");
  });

  it("falls through when BUN_CHROME_PATH does not exist", () => {
    const deps = makeLookup({
      env: { BUN_CHROME_PATH: "/missing/chrome" },
      which: () => "/path/chrome",
    });
    expect(findChromePath(deps)).toBe("/path/chrome");
  });

  it("tries $PATH command names in preference order", () => {
    const seen: string[] = [];
    const deps = makeLookup({
      which: (command) => {
        seen.push(command);
        return command === "chromium" ? "/usr/bin/chromium" : null;
      },
    });
    expect(findChromePath(deps)).toBe("/usr/bin/chromium");
    expect(seen).toEqual(["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"]);
  });

  it("falls back to a standard install location when $PATH has nothing", () => {
    const deps = makeLookup({
      exists: (path) => path === "/usr/bin/chromium-browser",
    });
    expect(findChromePath(deps)).toBe("/usr/bin/chromium-browser");
  });

  it("finds the newest Playwright chromium build, preferring full over headless-shell", () => {
    const cache = join("/home/tester", ".cache/ms-playwright");
    const newest = join(cache, "chromium-1234", "chrome-linux64", "chrome");
    const shell = join(
      cache,
      "chromium_headless_shell-2000",
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    const deps = makeLookup({
      readdir: () => ["chromium-1000", "chromium_headless_shell-2000", "chromium-1234"],
      exists: (path) => path === newest || path === shell,
    });
    expect(findChromePath(deps)).toBe(newest);
  });

  it("uses a headless-shell build only when no full chromium exists", () => {
    const cache = join("/home/tester", ".cache/ms-playwright");
    const shell = join(
      cache,
      "chromium_headless_shell-2000",
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    const deps = makeLookup({
      readdir: () => ["chromium_headless_shell-2000"],
      exists: (path) => path === shell,
    });
    expect(findChromePath(deps)).toBe(shell);
  });

  it("resolves Windows standard install locations", () => {
    const expected = "C:\\PF\\Google\\Chrome\\Application\\chrome.exe";
    const deps = makeLookup({
      platform: "win32",
      env: { ProgramFiles: "C:\\PF" },
      exists: (path) => path === expected,
    });
    expect(findChromePath(deps)).toBe(expected);
  });

  it("returns null when nothing is found", () => {
    expect(findChromePath(makeLookup())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// interceptContinueParams (pure — every paused request must yield a continue)
// ---------------------------------------------------------------------------

describe("interceptContinueParams", () => {
  const matching = {
    matches: (url: string) => url.includes("/generateAlpha"),
    rewrite: (body: string) => body.replace("hello", "world"),
  };

  it("rewrites a matching POST body to base64 postData", () => {
    const params = interceptContinueParams([matching], {
      url: "https://janitorai.com/hampter/generateAlpha",
      method: "POST",
      postData: '{"hi":"hello"}',
    });
    expect(params.postData).toBe(Buffer.from('{"hi":"world"}', "utf8").toString("base64"));
  });

  it("continues unchanged when no route matches, method is not POST, or there is no body", () => {
    expect(
      interceptContinueParams([matching], {
        url: "https://janitorai.com/other",
        method: "POST",
        postData: "hello",
      }),
    ).toEqual({});
    expect(
      interceptContinueParams([matching], {
        url: "https://janitorai.com/hampter/generateAlpha",
        method: "GET",
        postData: "hello",
      }),
    ).toEqual({});
    expect(
      interceptContinueParams([matching], {
        url: "https://janitorai.com/hampter/generateAlpha",
        method: "POST",
      }),
    ).toEqual({});
  });

  it("continues unchanged when the rewrite returns null or an identical body", () => {
    const nullRewrite = { matches: () => true, rewrite: () => null };
    expect(
      interceptContinueParams([nullRewrite], { url: "u", method: "POST", postData: "same" }),
    ).toEqual({});
    const sameRewrite = { matches: () => true, rewrite: (body: string) => body };
    expect(
      interceptContinueParams([sameRewrite], { url: "u", method: "POST", postData: "same" }),
    ).toEqual({});
  });

  it("still continues (without postData) when a rewriter throws", () => {
    const throwing = {
      matches: () => true,
      rewrite: () => {
        throw new Error("boom");
      },
    };
    const params = interceptContinueParams([throwing], {
      url: "u",
      method: "POST",
      postData: "body",
    });
    expect(params).toEqual({});
    expect(params.postData).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Supabase token discovery (JAR's findToken, evaluated against fake globals)
// ---------------------------------------------------------------------------

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";

/**
 * Evaluate the exported page-side `findToken` with synthetic `document`/
 * `localStorage` globals. Passing them as `new Function` parameters is what
 * makes the same source that runs in the page testable hermetically.
 */
function findTokenIn(cookie: string, storage: Record<string, string> = {}): string | null {
  const entries = Object.entries(storage);
  const fakeLocalStorage = {
    length: entries.length,
    key: (index: number) => entries[index]?.[0] ?? null,
    getItem: (key: string) => storage[key] ?? null,
  };
  const fn = new Function(
    "document",
    "localStorage",
    `${FIND_TOKEN_SOURCE}\nreturn findToken();`,
  ) as (document: unknown, localStorage: unknown) => string | null;
  return fn({ cookie }, fakeLocalStorage);
}

describe("findToken (page-side Supabase token discovery)", () => {
  it("joins a chunked sb-*-auth-token cookie in index order", () => {
    const json = JSON.stringify({ access_token: JWT, refresh_token: "x" });
    const half = Math.floor(json.length / 2);
    // Deliberately out of order: the join must sort by the `.0`/`.1` suffix.
    const cookie = [
      `sb-abc-auth-token.1=${json.slice(half)}`,
      `sb-abc-auth-token.0=${json.slice(0, half)}`,
    ].join("; ");
    expect(findTokenIn(cookie)).toBe(JWT);
  });

  it("decodes a base64- prefixed cookie value", () => {
    const json = JSON.stringify({ access_token: JWT });
    const encoded = Buffer.from(json, "utf8").toString("base64");
    expect(findTokenIn(`sb-x-auth-token=base64-${encoded}`)).toBe(JWT);
  });

  it("accepts a raw three-part JWT cookie value", () => {
    expect(findTokenIn(`sb-x-auth-token=${JWT}`)).toBe(JWT);
  });

  it("reads access_token out of a JSON blob", () => {
    expect(findTokenIn(`sb-x-auth-token=${JSON.stringify({ access_token: JWT })}`)).toBe(JWT);
  });

  it("accepts accessToken / token / currentSession.access_token", () => {
    expect(findTokenIn(`sb-x-auth-token=${JSON.stringify({ accessToken: JWT })}`)).toBe(JWT);
    expect(findTokenIn(`sb-x-auth-token=${JSON.stringify({ token: JWT })}`)).toBe(JWT);
    expect(
      findTokenIn(`sb-x-auth-token=${JSON.stringify({ currentSession: { access_token: JWT } })}`),
    ).toBe(JWT);
  });

  it("falls back to scanning every localStorage value", () => {
    expect(
      findTokenIn("", { "sb-whatever-auth-token": JSON.stringify({ access_token: JWT }) }),
    ).toBe(JWT);
  });

  it("returns null when no token exists anywhere", () => {
    expect(findTokenIn("theme=dark; sb-x-auth-token=not-a-token")).toBeNull();
    expect(findTokenIn("", { theme: "dark" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildFetchExpression (token attachment + origin guard)
// ---------------------------------------------------------------------------

interface FetchCapture {
  url: string;
  init: { headers: Record<string, string>; credentials?: string; method?: string; body?: string };
}

/** Evaluate a generated fetch expression with fake page globals + a stub fetch. */
async function runFetchExpression(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  ctx: { cookie?: string; storage?: Record<string, string> },
): Promise<{ capture: FetchCapture; logs: string[] }> {
  const storage = ctx.storage ?? {};
  const entries = Object.entries(storage);
  const fakeLocalStorage = {
    length: entries.length,
    key: (index: number) => entries[index]?.[0] ?? null,
    getItem: (key: string) => storage[key] ?? null,
  };
  const logs: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    warn: () => {},
    error: () => {},
  };
  const captures: FetchCapture[] = [];
  const fakeFetch = async (u: string, i: FetchCapture["init"]) => {
    captures.push({ url: u, init: i });
    return new Response("{}", { status: 200 });
  };
  const fn = new Function(
    "document",
    "localStorage",
    "fetch",
    "console",
    `return ${buildFetchExpression(url, init)};`,
  ) as (
    document: unknown,
    localStorage: unknown,
    fetch: unknown,
    console: unknown,
  ) => Promise<{ status: number; body: string }>;
  await fn({ cookie: ctx.cookie ?? "" }, fakeLocalStorage, fakeFetch, fakeConsole);
  const capture = captures[0];
  if (capture === undefined) throw new Error("fetch was never called");
  return { capture, logs };
}

describe("buildFetchExpression", () => {
  const mine = `${JANITOR_ORIGIN}/hampter/profiles/mine`;
  const cookie = `sb-project-auth-token=${JSON.stringify({ access_token: JWT })}`;

  it("attaches the discovered Supabase token for janitorai.com", async () => {
    const { capture, logs } = await runFetchExpression(mine, undefined, { cookie });
    expect(capture.init.headers.authorization).toBe(`Bearer ${JWT}`);
    // Everything else about the request is unchanged.
    expect(capture.init.headers.accept).toBe("application/json");
    expect(capture.init.credentials).toBe("include");
    expect(logs).toEqual(["[janitor] supabase token found: yes"]);
  });

  it("never attaches the token to another origin", async () => {
    const { capture, logs } = await runFetchExpression("https://example.com/", undefined, {
      cookie,
    });
    expect(capture.init.headers.authorization).toBeUndefined();
    // The diagnostic only makes sense where the token would be used.
    expect(logs).toEqual([]);
  });

  it("lets a caller-supplied Authorization header win", async () => {
    const { capture } = await runFetchExpression(
      mine,
      { headers: { Authorization: "Bearer caller" } },
      { cookie },
    );
    expect(capture.init.headers.Authorization).toBe("Bearer caller");
    expect(capture.init.headers.authorization).toBeUndefined();
  });

  it("logs (but does not attach) when no token is found", async () => {
    const { capture, logs } = await runFetchExpression(mine, undefined, { cookie: "theme=dark" });
    expect(capture.init.headers.authorization).toBeUndefined();
    expect(logs).toEqual(["[janitor] supabase token found: no"]);
  });

  it("passes method, body and caller headers through to fetch", async () => {
    const { capture } = await runFetchExpression(
      mine,
      { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } },
      { cookie: "theme=dark" },
    );
    expect(capture.init.method).toBe("POST");
    expect(capture.init.body).toBe('{"a":1}');
    expect(capture.init.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// JanitorBrowser (no Chrome is launched)
// ---------------------------------------------------------------------------

describe("JanitorBrowser", () => {
  it("exposes the JanitorAI origin constant", () => {
    expect(JANITOR_ORIGIN).toBe("https://janitorai.com");
  });

  it("degrades to unsupported when the explicit chrome path does not exist", () => {
    const browser = new JanitorBrowser({
      profileDir: "/tmp/janitor-test-profile",
      chromePath: "/definitely/not/a/chrome",
    });
    expect(browser.status()).toEqual({
      supported: false,
      chromePath: null,
      running: false,
      mode: null,
      busy: false,
    });
  });

  it("rejects with a clear error when no Chrome is available", async () => {
    const browser = new JanitorBrowser({
      profileDir: "/tmp/janitor-test-profile",
      chromePath: "/definitely/not/a/chrome",
    });
    await expect(browser.withView(async () => 1)).rejects.toThrow(
      "no Chrome/Chromium found; install one or set BUN_CHROME_PATH",
    );
  });
});
