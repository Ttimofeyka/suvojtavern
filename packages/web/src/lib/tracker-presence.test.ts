/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { MessageGroup, MessageVariant } from "./api-chats";
import { clearTrackerPresence, withTrackerPresence } from "./tracker-presence";

const variant = (id: string, hasTracker = false): MessageVariant => ({
  id,
  content: `content ${id}`,
  active: false,
  created_at: "2026-01-01T00:00:00.000Z",
  has_tracker: hasTracker,
});

const group = (seq: number, ids: string[], activeId = ids[0] ?? null): MessageGroup => ({
  seq,
  role: "assistant",
  name: null,
  active_id: activeId,
  variants: ids.map((id) => variant(id, false)),
});

describe("withTrackerPresence", () => {
  it("flags the matching variant true", () => {
    const groups = [group(1, ["a1", "a2"])];

    const next = withTrackerPresence(groups, "a2", true);

    expect(next[0].variants.map((v) => v.has_tracker)).toEqual([false, true]);
  });

  it("flags the matching variant false", () => {
    const groups = [group(1, ["a1", "a2"])];
    groups[0].variants[1] = variant("a2", true);

    const next = withTrackerPresence(groups, "a1", false);

    expect(next[0].variants.map((v) => v.has_tracker)).toEqual([false, true]);

    const cleared = withTrackerPresence(groups, "a2", false);
    expect(cleared[0].variants.map((v) => v.has_tracker)).toEqual([false, false]);
  });

  it("rebuilds only the owning group, keeping other groups by reference", () => {
    const first = group(1, ["a1"]);
    const second = group(2, ["b1", "b2"]);
    const third = group(3, ["c1"]);
    const groups = [first, second, third];

    const next = withTrackerPresence(groups, "b1", true);

    expect(next).not.toBe(groups);
    expect(next[0]).toBe(first);
    expect(next[1]).not.toBe(second);
    expect(next[2]).toBe(third);
  });

  it("keeps the owning group's other variants by reference", () => {
    const untouched = variant("a1");
    const groups = [{ ...group(1, ["a1"]), variants: [untouched, variant("a2")] }];

    const next = withTrackerPresence(groups, "a2", true);

    expect(next[0].variants[0]).toBe(untouched);
    expect(next[0].variants[1]?.has_tracker).toBe(true);
  });

  it("returns the input unchanged when no group owns the message", () => {
    const groups = [group(1, ["a1", "a2"])];
    expect(withTrackerPresence(groups, "missing", true)).toBe(groups);
  });

  it("returns the input unchanged for an empty list", () => {
    const groups: MessageGroup[] = [];
    expect(withTrackerPresence(groups, "a1", true)).toBe(groups);
  });

  it("does not mutate the input groups or variants", () => {
    const original = group(1, ["a1", "a2"]);
    const groups = [original];

    withTrackerPresence(groups, "a2", true);

    expect(original.variants.map((v) => v.has_tracker)).toEqual([false, false]);
  });
});

describe("clearTrackerPresence", () => {
  it("clears every flagged variant", () => {
    const groups = [
      { ...group(1, ["a1", "a2"]), variants: [variant("a1", true), variant("a2", true)] },
      { ...group(2, ["b1"]), variants: [variant("b1")] },
    ];

    const next = clearTrackerPresence(groups);

    expect(next[0].variants.map((v) => v.has_tracker)).toEqual([false, false]);
    expect(next[1].variants.map((v) => v.has_tracker)).toEqual([false]);
  });

  it("returns a new array, keeping unflagged groups and variants by reference", () => {
    const flagged = variant("a1", true);
    const plain = variant("a2");
    const untouchedGroup = group(2, ["b1"]);
    const groups = [{ ...group(1, ["a1", "a2"]), variants: [flagged, plain] }, untouchedGroup];

    const next = clearTrackerPresence(groups);

    expect(next).not.toBe(groups);
    expect(next[0]).not.toBe(groups[0]);
    expect(next[0].variants[0]).not.toBe(flagged);
    expect(next[0].variants[1]).toBe(plain);
    expect(next[1]).toBe(untouchedGroup);
  });

  it("does not mutate the input", () => {
    const original = { ...group(1, ["a1"]), variants: [variant("a1", true)] };
    const groups = [original];

    clearTrackerPresence(groups);

    expect(original.variants[0]?.has_tracker).toBe(true);
  });
});
