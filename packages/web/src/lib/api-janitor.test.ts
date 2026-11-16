/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "./api";
import {
  cancelJanitorLogin,
  getJanitorStatus,
  isJanitorCharacterUrl,
  isJanitorError,
  janitorErrorKind,
} from "./api-janitor";

describe("isJanitorCharacterUrl", () => {
  it("accepts a full JanitorAI character URL", () => {
    expect(
      isJanitorCharacterUrl(
        "https://janitorai.com/characters/12345678-1234-1234-1234-123456789abc_slug",
      ),
    ).toBe(true);
  });

  it("accepts the www host", () => {
    expect(
      isJanitorCharacterUrl(
        "https://www.janitorai.com/characters/12345678-1234-1234-1234-123456789abc",
      ),
    ).toBe(true);
  });

  it("accepts a scheme-less JanitorAI host path", () => {
    expect(
      isJanitorCharacterUrl("janitorai.com/characters/12345678-1234-1234-1234-123456789abc_slug"),
    ).toBe(true);
  });

  it("accepts a bare UUID", () => {
    expect(isJanitorCharacterUrl("12345678-1234-1234-1234-123456789abc")).toBe(true);
  });

  it("rejects non-JanitorAI sources", () => {
    expect(isJanitorCharacterUrl("https://chub.ai/characters/creator/name")).toBe(false);
    expect(isJanitorCharacterUrl("creator/name")).toBe(false);
    expect(isJanitorCharacterUrl("https://example.com/card.png")).toBe(false);
    expect(isJanitorCharacterUrl("")).toBe(false);
  });

  it("rejects a non-http(s) JanitorAI host", () => {
    expect(isJanitorCharacterUrl("ftp://janitorai.com/characters/abc")).toBe(false);
  });
});

describe("janitorErrorKind", () => {
  it("reads a recoverable kind out of ApiError.details", () => {
    expect(janitorErrorKind(new ApiError("Sign in first", 400, { kind: "not-logged-in" }))).toBe(
      "not-logged-in",
    );
    expect(
      janitorErrorKind(new ApiError("Private definition", 400, { kind: "definition-private" })),
    ).toBe("definition-private");
  });

  it("returns null for anything that is not an ApiError", () => {
    expect(janitorErrorKind(new Error("boom"))).toBeNull();
    expect(janitorErrorKind(null)).toBeNull();
    expect(janitorErrorKind("nope")).toBeNull();
    expect(janitorErrorKind(undefined)).toBeNull();
  });

  it("returns null when details are missing, non-object, or carry an unknown kind", () => {
    expect(janitorErrorKind(new ApiError("No details", 500))).toBeNull();
    expect(janitorErrorKind(new ApiError("Null details", 400, null))).toBeNull();
    expect(janitorErrorKind(new ApiError("String details", 400, "oops"))).toBeNull();
    expect(
      janitorErrorKind(new ApiError("Other kind", 400, { kind: "something-else" })),
    ).toBeNull();
  });
});

describe("isJanitorError", () => {
  it("matches only the requested kind", () => {
    const err = new ApiError("Private", 400, { kind: "definition-private" });
    expect(isJanitorError(err, "definition-private")).toBe(true);
    expect(isJanitorError(err, "not-logged-in")).toBe(false);
    expect(isJanitorError(new Error("boom"), "definition-private")).toBe(false);
  });
});

describe("cancelJanitorLogin", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the cancel endpoint and passes its payload through", async () => {
    let url = "";
    let method = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = typeof input === "string" ? input : input.toString();
      method = init?.method ?? "GET";
      return new Response(JSON.stringify({ cancelled: true, loggedIn: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await cancelJanitorLogin()).toEqual({ cancelled: true, loggedIn: false });
    expect(url).toBe("/api/janitor/login/cancel");
    expect(method).toBe("POST");
  });
});

describe("getJanitorStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes the cache-only payload through, including checked", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          supported: true,
          loggedIn: false,
          checked: false,
          browser: "/usr/bin/chrome",
          busy: false,
          loginInProgress: false,
          loginWindowOpen: false,
          message: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const status = await getJanitorStatus();
    expect(status).toMatchObject({ supported: true, loggedIn: false, checked: false });
  });
});
