/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import type { CharacterListItem, CharacterSort } from "./api-characters";
import { CHARACTER_PAGE_SIZE, listCharacters } from "./api-characters";
import {
  CHARACTER_PAGE_SIZE_DESKTOP,
  CHARACTER_PAGE_SIZE_MOBILE,
  CHARACTERS_VIEW_PAGE_SIZE_DESKTOP,
  CHARACTERS_VIEW_PAGE_SIZE_MOBILE,
  characterPickerPageSize,
  charactersViewPageSize,
  createCharacterPagerCore,
  mergeCharacterPages,
} from "./character-paging";

/** A slim list row fixture; only the fields the helpers read are meaningful. */
function row(id: string): CharacterListItem {
  return {
    id,
    name: `Name ${id}`,
    avatar_path: null,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    chat_count: 0,
  };
}

describe("mergeCharacterPages", () => {
  it("appends new rows in order", () => {
    expect(mergeCharacterPages([row("a")], [row("b"), row("c")]).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips ids already present, so an overlapping refetch cannot duplicate", () => {
    expect(
      mergeCharacterPages([row("a"), row("b")], [row("b"), row("c")]).map((r) => r.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("returns the existing array content for an empty incoming page", () => {
    const existing = [row("a")];
    expect(mergeCharacterPages(existing, [])).toEqual(existing);
  });
});

describe("listCharacters", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Captures the request URL and answers with a canned envelope. */
  function stubFetch(page: { items: CharacterListItem[]; total: number }): () => string {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ ...page, tags: [], limit: 100, offset: 0 }) satisfies Record<
          string,
          unknown
        >,
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return () => url;
  }

  it("returns the envelope (items + total), not a bare array", async () => {
    const url = stubFetch({ items: [row("a")], total: 7 });
    const page = await listCharacters();
    expect(page.items.map((r) => r.id)).toEqual(["a"]);
    expect(page.total).toBe(7);
    expect(url()).toContain(`limit=${CHARACTER_PAGE_SIZE}`);
  });

  it("defaults to CHARACTER_PAGE_SIZE and forwards filters", async () => {
    const url = stubFetch({ items: [], total: 0 });
    await listCharacters({ tags: ["elf", "mage"], search: "ali", limit: 25, offset: 50 });
    const captured = url();
    // Each selected tag rides its own `tag=` param (the server ANDs them).
    expect(captured).toContain("tag=elf");
    expect(captured).toContain("tag=mage");
    expect(captured).toContain("search=ali");
    expect(captured).toContain("limit=25");
    expect(captured).toContain("offset=50");
  });

  it("omits empty filters", async () => {
    const url = stubFetch({ items: [], total: 0 });
    await listCharacters({ offset: 0 });
    expect(url()).not.toContain("tag=");
    expect(url()).not.toContain("search=");
  });

  it("forwards an explicit sort, including the server-only name order", async () => {
    const url = stubFetch({ items: [], total: 0 });
    await listCharacters({ sort: "recent" });
    expect(url()).toContain("sort=recent");

    await listCharacters({ sort: "name" });
    expect(url()).toContain("sort=name");
  });
});

// --- createCharacterPagerCore state machine ---------------------------------
//
// The paging math lives in a React-free core, so these tests drive it directly:
// no DOM, no React renderer, and no module mocking are needed.

/** A promise whose settlement the test controls. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One in-flight request: its URL plus the deferred the stub returned. */
interface PendingCall {
  url: string;
  deferred: Deferred<Response>;
}

/** Replaces `globalThis.fetch` with a stub that hands back controllable
 *  deferreds, one per call, so tests decide the network's response order. */
function stubDeferredFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: PendingCall = { url, deferred: deferred<Response>() };
    calls.push(call);
    return call.deferred.promise;
  }) as typeof fetch;
  return calls;
}

/** Resolves a pending call with a full list envelope. */
function respond(call: PendingCall, items: CharacterListItem[], total: number): void {
  call.deferred.resolve(
    new Response(
      JSON.stringify({ items, total, tags: [], limit: 100, offset: 0 }) satisfies Record<
        string,
        unknown
      >,
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

/** Yields to the microtask queue (and the pager's promise callbacks). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits past the debounce window a pager was constructed with. */
const settleDebounce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe("createCharacterPagerCore", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Creates a core and runs its mount fetch, mirroring the React hook. */
  function makePager(
    options: { debounceMs?: number; initialSort?: CharacterSort; autoload?: boolean } = {},
  ) {
    const core = createCharacterPagerCore(options);
    core.start();
    return core;
  }

  it("fetches page 0 on start and reports the loaded page", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager();
    // The mount fetch has run: one page-0 request is airborne, loading on.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`limit=${CHARACTER_PAGE_SIZE}`);
    expect(calls[0]?.url).not.toContain("offset=");
    expect(pager.getState().loading).toBe(true);

    respond(calls[0] as PendingCall, [row("a")], 1);
    await flush();
    expect(pager.getState().items.map((r) => r.id)).toEqual(["a"]);
    expect(pager.getState().total).toBe(1);
    expect(pager.getState().loading).toBe(false);
    pager.dispose();
  });

  it("defaults to name order and sends it on the page-0 fetch", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager();
    expect(pager.getState().sort).toBe("name");
    expect(calls[0]?.url).toContain("sort=name");
    pager.dispose();
  });

  it("honors initialSort on the page-0 fetch", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ initialSort: "recent" });
    expect(pager.getState().sort).toBe("recent");
    expect(calls[0]?.url).toContain("sort=recent");
    pager.dispose();
  });

  it("setSort refetches page 0 in the new order and updates state", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager();
    respond(calls[0] as PendingCall, [row("a")], 2);
    await flush();

    pager.setSort("recent");
    expect(pager.getState().sort).toBe("recent");
    expect(calls).toHaveLength(2);
    // A fresh ordering starts at offset 0, so no offset is sent.
    expect(calls[1]?.url).toContain("sort=recent");
    expect(calls[1]?.url).not.toContain("offset=");
    pager.dispose();
  });

  it("setSort flushes a pending search debounce into the refetch", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ debounceMs: 1 });
    respond(calls[0] as PendingCall, [row("a")], 3);
    await flush();

    // Type but switch order before the debounce fires: the switch must commit
    // the live input itself instead of letting a stale timer fire later.
    pager.onSearch("bo");
    pager.setSort("recent");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("search=bo");
    expect(calls[1]?.url).toContain("sort=recent");
    await settleDebounce();
    // The flushed timer must not issue a third request.
    expect(calls).toHaveLength(2);
    pager.dispose();
  });

  it("setSort is a no-op for the current order", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ initialSort: "recent" });
    respond(calls[0] as PendingCall, [row("a")], 1);
    await flush();

    pager.setSort("recent");
    expect(calls).toHaveLength(1);
    pager.dispose();
  });

  it("drops a superseded page-0 response instead of applying it", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ debounceMs: 1 });
    respond(calls[0] as PendingCall, [row("old")], 1);
    await flush();

    // Commit query "b", then immediately commit "c": the "b" page is airborne
    // when "c" is requested, and must be discarded when it lands late.
    pager.onSearch("b");
    await settleDebounce();
    pager.onSearch("c");
    await settleDebounce();
    expect(calls).toHaveLength(3);

    // "c" resolves first and wins; the late "b" response must not overwrite it.
    respond(calls[2] as PendingCall, [row("c")], 1);
    await flush();
    respond(calls[1] as PendingCall, [row("b")], 1);
    await flush();

    expect(pager.getState().items.map((r) => r.id)).toEqual(["c"]);
    expect(pager.getState().committed).toBe("c");
    pager.dispose();
  });

  it("ignores loadMore while a page-0 refetch is pending", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ debounceMs: 1 });
    respond(calls[0] as PendingCall, [row("a"), row("b")], 4);
    await flush();
    expect(pager.getState().hasMore).toBe(true);

    // Commit a search; its page-0 request is in flight (calls[1]).
    pager.onSearch("x");
    await settleDebounce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("search=x");

    // A load-more fired during that window must do nothing: appending the new
    // query's rows at the old list's offset would mix the two result sets.
    pager.loadMore();
    expect(calls).toHaveLength(2);
    pager.dispose();
  });

  it("keeps loading false on a search refetch when rows are already present", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ debounceMs: 1 });
    respond(calls[0] as PendingCall, [row("a")], 3);
    await flush();
    expect(pager.getState().loading).toBe(false);

    pager.onSearch("a");
    await settleDebounce();
    // A second page-0 fetch is airborne, but the loaded rows stay mounted and
    // the skeleton must not flash over them.
    expect(calls).toHaveLength(2);
    expect(pager.getState().loading).toBe(false);

    respond(calls[1] as PendingCall, [row("a")], 1);
    await flush();
    expect(pager.getState().loading).toBe(false);
    pager.dispose();
  });

  it("reload re-fetches the committed query", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager({ debounceMs: 1 });
    respond(calls[0] as PendingCall, [row("a")], 3);
    await flush();

    pager.onSearch("bo");
    await settleDebounce();
    respond(calls[1] as PendingCall, [row("bob")], 1);
    await flush();

    pager.reload();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain("search=bo");
    respond(calls[2] as PendingCall, [row("bob")], 1);
    await flush();
    expect(pager.getState().items.map((r) => r.id)).toEqual(["bob"]);
    pager.dispose();
  });

  it("reports hasMore while items.length < total and stops at the end", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager();
    respond(calls[0] as PendingCall, [row("a"), row("b")], 4);
    await flush();
    expect(pager.getState().hasMore).toBe(true);

    pager.loadMore();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("offset=2");
    respond(calls[1] as PendingCall, [row("c")], 4);
    await flush();
    expect(pager.getState().items).toHaveLength(3);
    expect(pager.getState().hasMore).toBe(true);

    pager.loadMore();
    respond(calls[2] as PendingCall, [row("d")], 4);
    await flush();
    expect(pager.getState().items).toHaveLength(4);
    // At the end: no more pages, despite total never dropping below items.
    expect(pager.getState().hasMore).toBe(false);
    pager.dispose();
  });

  it("latches hasMore off when an appended page yields no new rows", async () => {
    const calls = stubDeferredFetch();
    const pager = makePager();
    respond(calls[0] as PendingCall, [row("a"), row("b")], 5);
    await flush();
    expect(pager.getState().hasMore).toBe(true);

    // The offset window ran out (e.g. a deletion shifted the boundary) and the
    // page comes back with only already-seen ids: stop offering load-more so
    // the footer cannot loop on empty pages.
    pager.loadMore();
    respond(calls[1] as PendingCall, [row("b")], 5);
    await flush();
    expect(pager.getState().items).toHaveLength(2);
    expect(pager.getState().hasMore).toBe(false);

    pager.loadMore();
    expect(calls).toHaveLength(2); // no new request
    pager.dispose();
  });

  it("re-issues page 0 after a StrictMode dispose/start and drops the stale response", async () => {
    const calls = stubDeferredFetch();
    const core = createCharacterPagerCore();
    core.start();
    expect(calls).toHaveLength(1);
    expect(core.getState().loading).toBe(true);

    // StrictMode tears the first setup down (invalidating its in-flight page),
    // then runs setup again.
    core.dispose();
    core.start();
    // The second setup MUST issue a fresh page-0 request rather than hang on
    // the discarded one — otherwise `loading` (set by that stale fetch) would
    // stay true and the skeleton would never clear.
    expect(calls).toHaveLength(2);
    expect(core.getState().loading).toBe(true);

    // The first invocation's response lands late and is discarded by the token
    // guard...
    respond(calls[0] as PendingCall, [row("stale")], 1);
    await flush();
    expect(core.getState().items).toEqual([]);

    // ...while the fresh page is the one that paints.
    respond(calls[1] as PendingCall, [row("fresh")], 1);
    await flush();
    expect(core.getState().items.map((r) => r.id)).toEqual(["fresh"]);
    expect(core.getState().loading).toBe(false);
    core.dispose();
  });
});

// --- createCharacterPagerCore in pages mode ----------------------------------
//
// Pages mode fetches one page at a time and REPLACES the window, rather than
// appending. These tests drive the core directly to pin the offset math, the
// page bookkeeping, and the reset rules the append tests above must keep seeing
// unchanged.

describe("createCharacterPagerCore pages mode", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Creates a pages-mode core and runs its mount fetch, like `makePager`. */
  function makePagesPager(pageSize = CHARACTER_PAGE_SIZE_MOBILE) {
    const core = createCharacterPagerCore({ mode: "pages", pageSize });
    core.start();
    return core;
  }

  /** `count` fixture rows with ids `<prefix>1..<prefix>count`. */
  function pageRows(prefix: string, count: number): CharacterListItem[] {
    return Array.from({ length: count }, (_, i) => row(`${prefix}${i + 1}`));
  }

  it("requests page 1 at the page size with no offset and reports it", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("limit=5");
    expect(calls[0]?.url).not.toContain("offset=");

    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();
    const state = pager.getState();
    expect(state.page).toBe(1);
    expect(state.pageSize).toBe(5);
    expect(state.items).toHaveLength(5);
    // hasMore is an append-mode concept; pages mode always reports false.
    expect(state.hasMore).toBe(false);
    pager.dispose();
  });

  it("nextPage requests offset=pageSize and REPLACES the rows", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    pager.nextPage();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("limit=5");
    expect(calls[1]?.url).toContain("offset=5");
    // The current rows stay mounted (and the nav busy) until the page lands.
    expect(pager.getState().loadingMore).toBe(true);
    expect(pager.getState().items.map((r) => r.id)).toEqual(pageRows("a", 5).map((r) => r.id));

    respond(calls[1] as PendingCall, pageRows("b", 5), 12);
    await flush();
    const state = pager.getState();
    expect(state.page).toBe(2);
    expect(state.loadingMore).toBe(false);
    // REPLACED, not appended: exactly the page-2 rows, no page-1 leftovers.
    expect(state.items.map((r) => r.id)).toEqual(pageRows("b", 5).map((r) => r.id));
    pager.dispose();
  });

  it("prevPage on page 1 and nextPage on the last page are no-ops", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12); // 12 / 5 → 3 pages
    await flush();

    pager.prevPage();
    expect(calls).toHaveLength(1);

    pager.goToPage(3);
    respond(calls[1] as PendingCall, pageRows("c", 2), 12);
    await flush();
    expect(pager.getState().page).toBe(3);

    pager.nextPage();
    expect(calls).toHaveLength(2);
    pager.dispose();
  });

  it("goToPage clamps an out-of-range page to the last one", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12); // 3 pages
    await flush();

    pager.goToPage(99);
    expect(calls).toHaveLength(2);
    // Clamped to page 3 → offset 10, not a request past the end.
    expect(calls[1]?.url).toContain("offset=10");
    respond(calls[1] as PendingCall, pageRows("c", 2), 12);
    await flush();
    expect(pager.getState().page).toBe(3);
    pager.dispose();
  });

  it("keeps the current page and rows when a jump fails", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    pager.nextPage();
    (calls[1] as PendingCall).deferred.reject(new Error("boom"));
    await flush();
    const state = pager.getState();
    expect(state.page).toBe(1);
    expect(state.loadingMore).toBe(false);
    expect(state.error).not.toBeNull();
    expect(state.items.map((r) => r.id)).toEqual(pageRows("a", 5).map((r) => r.id));
    pager.dispose();
  });

  it("committing a search resets to page 1 and refetches with no offset", async () => {
    const calls = stubDeferredFetch();
    const core = createCharacterPagerCore({ mode: "pages", pageSize: 5, debounceMs: 1 });
    core.start();
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    core.goToPage(2);
    respond(calls[1] as PendingCall, pageRows("b", 5), 12);
    await flush();
    expect(core.getState().page).toBe(2);

    core.onSearch("x");
    await settleDebounce();
    // Reset is immediate: page 1 while the fresh query is airborne.
    expect(core.getState().page).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain("search=x");
    expect(calls[2]?.url).not.toContain("offset=");
    core.dispose();
  });

  it("setSort resets to page 1", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    pager.goToPage(2);
    respond(calls[1] as PendingCall, pageRows("b", 5), 12);
    await flush();
    expect(pager.getState().page).toBe(2);

    pager.setSort("recent");
    expect(pager.getState().page).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain("sort=recent");
    expect(calls[2]?.url).not.toContain("offset=");
    pager.dispose();
  });

  it("setPageSize resizes, resets to page 1, and refetches with the new limit", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    pager.setPageSize(20);
    const resized = pager.getState();
    expect(resized.pageSize).toBe(20);
    expect(resized.page).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("limit=20");
    expect(calls[1]?.url).not.toContain("offset=");

    // Unchanged size is a no-op.
    pager.setPageSize(20);
    expect(calls).toHaveLength(2);
    pager.dispose();
  });

  it("loadMore is inert in pages mode", async () => {
    const calls = stubDeferredFetch();
    const pager = makePagesPager(5);
    respond(calls[0] as PendingCall, pageRows("a", 5), 12);
    await flush();

    pager.loadMore();
    expect(calls).toHaveLength(1);
    pager.dispose();
  });

  it("characterPickerPageSize maps the breakpoint to the shared sizes", () => {
    expect(CHARACTER_PAGE_SIZE_MOBILE).toBe(5);
    expect(CHARACTER_PAGE_SIZE_DESKTOP).toBe(20);
    expect(characterPickerPageSize(true)).toBe(CHARACTER_PAGE_SIZE_MOBILE);
    expect(characterPickerPageSize(false)).toBe(CHARACTER_PAGE_SIZE_DESKTOP);
  });
});

describe("charactersViewPageSize", () => {
  it("maps the breakpoint to the management screen's sizes", () => {
    expect(CHARACTERS_VIEW_PAGE_SIZE_MOBILE).toBe(5);
    expect(CHARACTERS_VIEW_PAGE_SIZE_DESKTOP).toBe(10);
    expect(charactersViewPageSize(true)).toBe(CHARACTERS_VIEW_PAGE_SIZE_MOBILE);
    expect(charactersViewPageSize(false)).toBe(CHARACTERS_VIEW_PAGE_SIZE_DESKTOP);
  });
});
