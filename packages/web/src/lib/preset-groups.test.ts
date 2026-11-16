/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PresetPrompt } from "./api-presets";
import {
  activeMemberId,
  applyGroupChoice,
  enabledMemberIds,
  findGroup,
  listGroups,
  type PromptGroup,
} from "./preset-groups";

/** A prompt fixture; group members pass `group` explicitly. */
function prompt(overrides: Partial<PresetPrompt> & { id: string }): PresetPrompt {
  return {
    name: overrides.id,
    role: "system",
    content: "",
    enabled: false,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
    ...overrides,
  };
}

/** A 3-member group with no member enabled. */
function povGroup(): PresetPrompt[] {
  return [
    prompt({ id: "main" }),
    prompt({ id: "pov-3rd", group: { id: "pov", label: "Point of view" } }),
    prompt({ id: "pov-2nd", group: { id: "pov", label: "Point of view" } }),
    prompt({ id: "pov-1st", group: { id: "pov", label: "Point of view" } }),
    prompt({ id: "tail" }),
  ];
}

describe("listGroups", () => {
  it("returns nothing for an ungrouped pipeline", () => {
    expect(listGroups([prompt({ id: "a" }), prompt({ id: "b" })])).toEqual([]);
  });

  it("dedupes by id and preserves pipeline order of first appearance", () => {
    const prompts = [
      prompt({ id: "x", group: { id: "style", label: "Style" } }),
      prompt({ id: "a", group: { id: "pov", label: "Point of view" } }),
      prompt({ id: "y", group: { id: "style", label: "Style" } }),
      prompt({ id: "b", group: { id: "pov", label: "Point of view" } }),
      prompt({ id: "z", group: { id: "style", label: "Style" } }),
    ];
    const groups: PromptGroup[] = listGroups(prompts);
    expect(groups.map((group) => group.id)).toEqual(["style", "pov"]);
    expect(groups[0]?.members.map((member) => member.id)).toEqual(["x", "y", "z"]);
    expect(groups[1]?.members.map((member) => member.id)).toEqual(["a", "b"]);
  });

  it("takes the label from a member that has one, falling back to the id", () => {
    const labelled = listGroups([
      prompt({ id: "a", group: { id: "pov", label: "" } }),
      prompt({ id: "b", group: { id: "pov", label: "Point of view" } }),
    ]);
    expect(labelled[0]?.label).toBe("Point of view");

    const blank = listGroups([prompt({ id: "a", group: { id: "pov", label: "  " } })]);
    expect(blank[0]?.label).toBe("pov");
  });

  it("gives one group per id even with a singleton member", () => {
    const groups = listGroups([prompt({ id: "only", group: { id: "solo", label: "Solo" } })]);
    expect(groups).toEqual([
      { id: "solo", label: "Solo", members: [expect.objectContaining({ id: "only" })] },
    ]);
  });
});

describe("findGroup", () => {
  it("returns the named group and undefined for an unknown id", () => {
    const prompts = [
      prompt({ id: "a", group: { id: "pov", label: "Point of view" } }),
      prompt({ id: "b", group: { id: "pov", label: "Point of view" } }),
    ];
    expect(findGroup(prompts, "pov")?.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(findGroup(prompts, "style")).toBeUndefined();
    expect(findGroup([], "pov")).toBeUndefined();
  });
});

describe("enabledMemberIds / activeMemberId", () => {
  it("returns [] and null when no member is enabled", () => {
    const prompts = povGroup();
    expect(enabledMemberIds(prompts, "pov")).toEqual([]);
    expect(activeMemberId(prompts, "pov")).toBeNull();
  });

  it("returns the lone enabled member", () => {
    const prompts = povGroup().map((p) => (p.id === "pov-2nd" ? { ...p, enabled: true } : p));
    expect(enabledMemberIds(prompts, "pov")).toEqual(["pov-2nd"]);
    expect(activeMemberId(prompts, "pov")).toBe("pov-2nd");
  });

  it("returns null (not a guess) when multiple members are enabled", () => {
    const prompts = povGroup().map((p) =>
      p.id === "pov-3rd" || p.id === "pov-1st" ? { ...p, enabled: true } : p,
    );
    expect(enabledMemberIds(prompts, "pov")).toEqual(["pov-3rd", "pov-1st"]);
    expect(activeMemberId(prompts, "pov")).toBeNull();
  });

  it("ignores non-members and other groups' members", () => {
    const prompts = [
      ...povGroup().map((p) => (p.id === "pov-3rd" ? { ...p, enabled: true } : p)),
      prompt({ id: "style-a", group: { id: "style", label: "Style" }, enabled: true }),
    ];
    expect(activeMemberId(prompts, "pov")).toBe("pov-3rd");
    expect(activeMemberId(prompts, "style")).toBe("style-a");
    expect(enabledMemberIds(prompts, "missing")).toEqual([]);
  });
});

describe("applyGroupChoice", () => {
  it("enables exactly the chosen member and disables its siblings", () => {
    const prompts = povGroup().map((p) => (p.id === "pov-3rd" ? { ...p, enabled: true } : p));
    const next = applyGroupChoice(prompts, "pov", "pov-1st");
    expect(next.filter((p) => p.enabled).map((p) => p.id)).toEqual(["pov-1st"]);
    expect(next.filter((p) => p.group?.id === "pov").map((p) => p.enabled)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("leaves non-members untouched, by reference", () => {
    const prompts = povGroup();
    const next = applyGroupChoice(prompts, "pov", "pov-2nd");
    expect(next[0]).toBe(prompts[0]); // "main"
    expect(next[4]).toBe(prompts[4]); // "tail"
  });

  it("does not mutate the input array or its objects", () => {
    const prompts = povGroup().map((p) => (p.id === "pov-3rd" ? { ...p, enabled: true } : p));
    const before = JSON.stringify(prompts);
    const next = applyGroupChoice(prompts, "pov", "pov-1st");
    expect(JSON.stringify(prompts)).toBe(before);
    expect(next).not.toBe(prompts);
    // The changed members are fresh objects; unchanged ones keep identity.
    expect(next[2]).toBe(prompts[2]);
    expect(next[1]).not.toBe(prompts[1]);
    expect(next[3]).not.toBe(prompts[3]);
  });

  it("touches only the named group when several exist", () => {
    const prompts = [
      prompt({ id: "pov-a", group: { id: "pov", label: "POV" }, enabled: true }),
      prompt({ id: "pov-b", group: { id: "pov", label: "POV" } }),
      prompt({ id: "style-a", group: { id: "style", label: "Style" }, enabled: true }),
      prompt({ id: "style-b", group: { id: "style", label: "Style" } }),
    ];
    const next = applyGroupChoice(prompts, "pov", "pov-b");
    expect(next.find((p) => p.id === "pov-a")?.enabled).toBe(false);
    expect(next.find((p) => p.id === "pov-b")?.enabled).toBe(true);
    expect(next.find((p) => p.id === "style-a")?.enabled).toBe(true); // untouched
    expect(next.find((p) => p.id === "style-b")?.enabled).toBe(false);
  });

  it("is a no-op (fresh copy only) for a member id not in the group", () => {
    const prompts = povGroup().map((p) => (p.id === "pov-3rd" ? { ...p, enabled: true } : p));
    const next = applyGroupChoice(prompts, "pov", "not-a-member");
    expect(next).toEqual(prompts);
    expect(next).not.toBe(prompts);
    expect(next.every((p, i) => p === prompts[i])).toBe(true);
  });

  it("is a no-op for an unknown group id", () => {
    const prompts = povGroup();
    const next = applyGroupChoice(prompts, "missing", "pov-1st");
    expect(next.every((p, i) => p === prompts[i])).toBe(true);
  });

  it("re-applying the current choice keeps every member's identity", () => {
    const prompts = povGroup().map((p) => (p.id === "pov-2nd" ? { ...p, enabled: true } : p));
    const next = applyGroupChoice(prompts, "pov", "pov-2nd");
    expect(next.every((p, i) => p === prompts[i])).toBe(true);
  });

  it("can empty a group by choosing a member, leaving only that one on", () => {
    const prompts = povGroup();
    const next = applyGroupChoice(prompts, "pov", "pov-3rd");
    expect(activeMemberId(next, "pov")).toBe("pov-3rd");
  });
});
