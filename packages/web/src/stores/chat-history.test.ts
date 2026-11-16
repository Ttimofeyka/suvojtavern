/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  clampMaxMessages,
  DEFAULT_CHAT_HISTORY,
  MAX_MAX_MESSAGES,
  MIN_MAX_MESSAGES,
  storedChatHistory,
} from "./chat-history";

describe("storedChatHistory", () => {
  it("falls back to the default when the value is null", () => {
    expect(storedChatHistory(null)).toEqual(DEFAULT_CHAT_HISTORY);
  });

  it("falls back to the default when the value is garbage", () => {
    expect(storedChatHistory("nope")).toEqual(DEFAULT_CHAT_HISTORY);
    expect(storedChatHistory({})).toEqual(DEFAULT_CHAT_HISTORY);
    expect(storedChatHistory({ maxMessages: "120" })).toEqual(DEFAULT_CHAT_HISTORY);
    expect(storedChatHistory({ maxMessages: Number.NaN })).toEqual(DEFAULT_CHAT_HISTORY);
    expect(storedChatHistory({ maxMessages: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_CHAT_HISTORY,
    );
  });

  it("round-trips a valid maxMessages value", () => {
    expect(storedChatHistory({ maxMessages: 120 })).toEqual({ maxMessages: 120 });
  });

  it("clamps values below the minimum and above the maximum", () => {
    expect(storedChatHistory({ maxMessages: 1 }).maxMessages).toBe(MIN_MAX_MESSAGES);
    expect(storedChatHistory({ maxMessages: 9999 }).maxMessages).toBe(MAX_MAX_MESSAGES);
  });

  it("truncates fractional values", () => {
    expect(storedChatHistory({ maxMessages: 120.9 }).maxMessages).toBe(120);
  });
});

describe("clampMaxMessages", () => {
  it("clamps to the supported range", () => {
    expect(clampMaxMessages(1)).toBe(MIN_MAX_MESSAGES);
    expect(clampMaxMessages(9999)).toBe(MAX_MAX_MESSAGES);
  });

  it("truncates fractional values", () => {
    expect(clampMaxMessages(120.9)).toBe(120);
  });
});
