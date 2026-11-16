/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import type { ChatSummaryInfo } from "./api-chats";
import { CHAT_PAGE_SIZE, listChats } from "./api-chats";
import { mergeChatPages, nextChatPage } from "./chat-paging";

/** A slim chat-summary fixture; only the fields the helpers read are meaningful. */
function row(id: string): ChatSummaryInfo {
  return {
    id,
    character_id: "char-1",
    persona_id: null,
    title: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    branch_root_id: null,
    active_branch: null,
    character_name: "Char",
    character_avatar_path: null,
    message_count: 0,
    last_preview: null,
  };
}

describe("mergeChatPages", () => {
  it("appends new rows in order", () => {
    expect(mergeChatPages([row("a")], [row("b"), row("c")]).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips ids already present, so an overlapping page cannot duplicate", () => {
    expect(mergeChatPages([row("a"), row("b")], [row("b"), row("c")]).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps a retained row's first position when a later page repeats it", () => {
    // The open chat's retained row sits at the end; a later page that includes
    // it must not move or duplicate it ("first occurrence wins").
    expect(
      mergeChatPages([row("a"), row("open")], [row("open"), row("b")]).map((r) => r.id),
    ).toEqual(["a", "open", "b"]);
  });

  it("returns the existing array content for an empty incoming page", () => {
    const existing = [row("a")];
    expect(mergeChatPages(existing, [])).toEqual(existing);
  });
});

describe("nextChatPage", () => {
  it("reports more, the loaded boundary, and the page limit while rows remain", () => {
    expect(nextChatPage(0, 50, 120)).toEqual({ hasMore: true, offset: 0, limit: 50 });
  });

  it("advances the offset by the loaded server rows across pages", () => {
    expect(nextChatPage(50, 50, 120)).toEqual({ hasMore: true, offset: 50, limit: 50 });
    // The final page asks only for what is left of the total.
    expect(nextChatPage(100, 50, 120)).toEqual({ hasMore: true, offset: 100, limit: 20 });
  });

  it("stops once loaded reaches total", () => {
    const page = nextChatPage(120, 50, 120);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(120);
  });

  it("stops (and never goes negative) when loaded exceeds total", () => {
    expect(nextChatPage(130, 50, 120).hasMore).toBe(false);
  });
});

describe("listChats", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Captures the request URL and answers with a canned envelope. */
  function stubFetch(page: { items: ChatSummaryInfo[]; total: number }): () => string {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ ...page, limit: CHAT_PAGE_SIZE, offset: 0 }) satisfies Record<
          string,
          unknown
        >,
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return () => url;
  }

  it("returns the page envelope, not a bare array", async () => {
    const url = stubFetch({ items: [row("a")], total: 7 });
    const page = await listChats();
    expect(page.items.map((r) => r.id)).toEqual(["a"]);
    expect(page.total).toBe(7);
    expect(url()).toContain(`limit=${CHAT_PAGE_SIZE}`);
  });

  it("always sends limit and forwards character_id", async () => {
    const url = stubFetch({ items: [], total: 0 });
    await listChats({ characterId: "char 1", limit: 25, offset: 50 });
    const captured = url();
    expect(captured).toContain("character_id=char+1");
    expect(captured).toContain("limit=25");
    expect(captured).toContain("offset=50");
  });

  it("omits offset at 0 and character_id when unset", async () => {
    const url = stubFetch({ items: [], total: 0 });
    await listChats({ offset: 0 });
    expect(url()).not.toContain("offset=");
    expect(url()).not.toContain("character_id=");
  });
});
