/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import {
  chatErrorAtom,
  chatGroupsAtom,
  chatIdAtom,
  chatSendPendingAtom,
  chatStreamingAtom,
  regenerate,
  sendMessage,
} from "./chat";
import { appStore } from "./store";

const originalFetch = globalThis.fetch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  appStore.set(chatIdAtom, "first");
  appStore.set(chatErrorAtom, null);
  appStore.set(chatGroupsAtom, []);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appStore.set(chatIdAtom, null);
});

it("saves only one user turn and generates in the chat that received it", async () => {
  const saved = deferred<Response>();
  const fetchMock = mock(async (url: string) => {
    if (url.endsWith("/messages")) return saved.promise;
    if (url.endsWith("/generate")) return new Response("");
    return Response.json({ items: [], total: 0 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const accepted = mock(() => {});
  const sending = sendMessage("Hello", accepted);
  expect(appStore.get(chatSendPendingAtom)).toBe(true);
  expect(accepted).not.toHaveBeenCalled();
  await sendMessage("Duplicate", accepted);
  appStore.set(chatIdAtom, "second");
  saved.resolve(Response.json({ id: "message", seq: 1 }));
  await sending;
  expect(fetchMock.mock.calls.map(([url]) => url).slice(0, 2)).toEqual([
    "/api/chats/first/messages",
    "/api/chats/first/generate",
  ]);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(appStore.get(chatGroupsAtom)).toEqual([]);
});

it("holds the send lock while a completed stream reloads its transcript", async () => {
  const reloading = deferred<void>();
  const transcript = deferred<Response>();
  const fetchMock = mock(async (url: string) => {
    if (url.endsWith("/generate")) return new Response("");
    if (url.includes("/messages?")) {
      reloading.resolve();
      return transcript.promise;
    }
    if (url.endsWith("/summaries")) return Response.json([]);
    return Response.json({ items: [], total: 0 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const sending = sendMessage("");
  await reloading.promise;
  expect(appStore.get(chatStreamingAtom)).toBe(false);
  expect(appStore.get(chatSendPendingAtom)).toBe(true);
  await regenerate();
  transcript.resolve(Response.json([]));
  await sending;
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/generate"))).toHaveLength(1);
  expect(appStore.get(chatSendPendingAtom)).toBe(false);
});

it("leaves the draft unaccepted when saving the user turn fails", async () => {
  const fetchMock = mock(async () => Response.json({ error: "Save failed" }, { status: 500 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const accepted = mock(() => {});
  await sendMessage("Keep this draft", accepted);
  expect(accepted).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(appStore.get(chatErrorAtom)).toContain("Save failed");
  expect(appStore.get(chatSendPendingAtom)).toBe(false);
});
