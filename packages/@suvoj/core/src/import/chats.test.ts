/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { exportChat } from "../export/chats";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { at, createTestDb } from "../test-utils";
import { importChat } from "./chats";

let repos: Repositories;

beforeEach(() => {
  repos = createRepositories(createTestDb());
  repos.characters.create({ name: "Seraphina" });
});

const CHAT_JSONL = [
  JSON.stringify({
    name: "Seraphina",
    user_name: "User",
    character_name: "Seraphina",
    is_user: false,
    is_system: false,
    send_date: 1730000000000,
    mes: "Hi there!",
    swipe_id: 1,
    swipes: ["Hello!", "Hi there!", "Greetings."],
  }),
  JSON.stringify({
    name: "User",
    is_user: true,
    is_system: false,
    send_date: 1730000001000,
    mes: "Who are you?",
  }),
  JSON.stringify({
    name: "Seraphina",
    is_user: false,
    is_system: true,
    send_date: "not a date",
    mes: "[system note]",
  }),
  JSON.stringify({
    name: "Seraphina",
    is_user: false,
    is_system: false,
    send_date: 1730000002000,
    mes: "How can I help?",
    swipe_id: 0,
    swipes: ["How can I help?", "At your service."],
  }),
].join("\n");

/** Real-ST shape: a leading `chat_metadata` header line, then message lines. */
const REAL_ST_CHAT = [
  JSON.stringify({
    chat_metadata: {
      integrity: "b2394bd8-4378-42bf-9020-0ada0e083f5c",
      note_prompt: "stay in character",
    },
    user_name: "User",
    character_name: "seraphina",
  }),
  JSON.stringify({
    name: "Seraphina",
    is_user: false,
    mes: "Good evening.",
    send_date: 1730000000000,
  }),
  JSON.stringify({ name: "User", is_user: true, mes: "Evening!" }),
  JSON.stringify({ name: "Seraphina", is_user: false, mes: "Shall we begin?" }),
].join("\n");

describe("importChat", () => {
  it("maps roles, swipes and the active variant", () => {
    const { chat, messages } = importChat(CHAT_JSONL, repos, { title: "Imported" });
    expect(chat.title).toBe("Imported");
    expect(chat.character_id).toBe(at(repos.characters.list(), 0).id);

    // One active message per position, in order.
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "system",
      "assistant",
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "Hi there!", // swipe_id 1
      "Who are you?",
      "[system note]",
      "How can I help?",
    ]);
    expect(messages.map((message) => message.name)).toEqual([
      "Seraphina",
      "User",
      "Seraphina",
      "Seraphina",
    ]);

    // All swipes kept as siblings of the first group.
    const all = repos.messages.listAll(chat.id);
    expect(all).toHaveLength(7); // 3 + 1 + 1 + 2
    const siblings = repos.messages.listMessageWithSiblings(messages[0]?.id ?? "");
    expect(siblings.map((message) => message.content)).toEqual([
      "Hello!",
      "Hi there!",
      "Greetings.",
    ]);
    expect(siblings.filter((message) => message.active)).toHaveLength(1);
    expect(siblings.find((message) => message.active)?.content).toBe("Hi there!");
  });

  it("parses send_date into metadata, keeping unparseable values raw", () => {
    const { messages } = importChat(CHAT_JSONL, repos);
    expect(at(messages, 0).metadata?.created_at).toBe("2024-10-27T03:33:20.000Z");
    expect(at(messages, 2).metadata?.send_date).toBe("not a date");
  });

  it("resolves the character by character_name case-insensitively", () => {
    const lowered = CHAT_JSONL.replace(
      '"character_name":"Seraphina"',
      '"character_name":"seraphina"',
    );
    const { chat } = importChat(lowered, repos);
    expect(chat.character_id).toBe(at(repos.characters.list(), 0).id);
  });

  it("errors without a resolvable character", () => {
    expect(() => importChat('{"name":"X","mes":"m"}', repos)).toThrow(
      "requires a target character",
    );
    expect(() => importChat('{"name":"X","character_name":"Nobody","mes":"m"}', repos)).toThrow(
      'no character named "Nobody"',
    );
  });

  it("round-trips through exportChat", () => {
    const { chat, messages } = importChat(CHAT_JSONL, repos, { title: "RT" });
    const exported = exportChat(repos.messages.listAll(chat.id), {
      userName: "User",
      characterName: "Seraphina",
    });

    const lines = exported
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(4);
    expect(lines[0]?.user_name).toBe("User");
    expect(lines[0]?.character_name).toBe("Seraphina");
    expect(lines[0]?.mes).toBe("Hi there!");
    expect(lines[0]?.swipe_id).toBe(1);
    expect(lines[0]?.swipes).toEqual(["Hello!", "Hi there!", "Greetings."]);
    expect(lines[3]?.swipes).toEqual(["How can I help?", "At your service."]);
    expect(lines[3]?.swipe_id).toBe(0);
    expect(lines[2]?.is_system).toBe(true);

    // Re-import reproduces the same native state (ids/timestamps aside).
    const again = importChat(exported, repos, { title: "RT2" });
    const shape = (message: (typeof messages)[number]) => ({
      role: message.role,
      name: message.name,
      content: message.content,
      active: message.active,
      metadata: message.metadata,
    });
    expect(again.messages.map(shape)).toEqual(messages.map(shape));
    expect(repos.messages.listAll(again.chat.id).map((message) => message.content)).toEqual(
      repos.messages.listAll(chat.id).map((message) => message.content),
    );
  });

  it("skips a real-ST chat_metadata header instead of importing an empty message", () => {
    const { messages } = importChat(REAL_ST_CHAT, repos);

    // Three message lines in → three positions out; the header adds none.
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages.map((message) => message.content)).toEqual([
      "Good evening.",
      "Evening!",
      "Shall we begin?",
    ]);
    // The real first message is position 1 — no spurious empty header message.
    expect(messages[0]?.content).toBe("Good evening.");
    expect(messages.some((message) => message.content === "")).toBe(false);
  });

  it("still keeps a legitimately empty mes (mes is a string)", () => {
    const jsonl = REAL_ST_CHAT.replace('"Shall we begin?"', '""');
    const { messages } = importChat(jsonl, repos);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.content).toBe("");
  });

  it("resolves the character from a character_name on the header line", () => {
    // Not resolvable through the explicit opts, so it must come from the header
    // (the only line carrying character_name) — case-insensitively.
    const { chat } = importChat(REAL_ST_CHAT, repos);
    expect(chat.character_id).toBe(at(repos.characters.list(), 0).id);
  });
});
