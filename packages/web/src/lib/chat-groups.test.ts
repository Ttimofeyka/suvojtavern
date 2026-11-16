/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { MessageGroup, MessageVariant } from "./api-chats";
import { setActiveVariantLocal } from "./chat-groups";

const variant = (id: string, active: boolean): MessageVariant => ({
  id,
  content: `content ${id}`,
  active,
  created_at: "2026-01-01T00:00:00.000Z",
  has_tracker: false,
});

const group = (seq: number, activeId: string, ids: string[]): MessageGroup => ({
  seq,
  role: "assistant",
  name: null,
  active_id: activeId,
  variants: ids.map((id) => variant(id, id === activeId)),
});

describe("setActiveVariantLocal", () => {
  it("switches the active flags and active_id of the owning group", () => {
    const groups = [group(1, "a1", ["a1", "a2"])];
    const next = setActiveVariantLocal(groups, "a2");

    expect(next).toHaveLength(1);
    expect(next[0].active_id).toBe("a2");
    expect(next[0].variants.map((v) => v.active)).toEqual([false, true]);
  });

  it("returns a new array and a new owning group, but keeps other groups by reference", () => {
    const first = group(1, "a1", ["a1", "a2"]);
    const second = group(2, "b1", ["b1", "b2"]);
    const third = group(3, "c1", ["c1"]);
    const groups = [first, second, third];

    const next = setActiveVariantLocal(groups, "b2");

    expect(next).not.toBe(groups);
    expect(next[0]).toBe(first);
    expect(next[1]).not.toBe(second);
    expect(next[2]).toBe(third);
  });

  it("returns the input unchanged when no group owns the message", () => {
    const groups = [group(1, "a1", ["a1", "a2"])];
    expect(setActiveVariantLocal(groups, "missing")).toBe(groups);
  });

  it("returns the input unchanged for an empty list", () => {
    const groups: MessageGroup[] = [];
    expect(setActiveVariantLocal(groups, "a1")).toBe(groups);
  });

  it("does not mutate the input groups or variants", () => {
    const original = group(1, "a1", ["a1", "a2"]);
    const groups = [original];

    setActiveVariantLocal(groups, "a2");

    expect(original.active_id).toBe("a1");
    expect(original.variants.map((v) => v.active)).toEqual([true, false]);
  });
});
