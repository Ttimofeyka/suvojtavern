/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PresetPrompt } from "./api-presets";

/**
 * Mutually-exclusive prompt groups. Prompts sharing a `group.id` are
 * alternatives for ONE choice (e.g. Point of View: 3rd / 2nd / 1st), so the
 * editor offers a single control instead of asking the user to hand-toggle
 * sibling rows and risk leaving two variants on at once.
 *
 * `group` is metadata only: the prompt assembler ignores it entirely, and
 * `enabled` is still the only thing that decides whether a prompt is sent.
 * The helpers here never touch engine behaviour — they only read/rewrite the
 * `enabled` flags of a group's members.
 */

/** One group as the UI sees it: its id, shared label, and members in order. */
export interface PromptGroup {
  id: string;
  label: string;
  members: PresetPrompt[];
}

/**
 * Every group a pipeline defines, in pipeline order: a group appears at the
 * position of its first member. Deduped by id; ungrouped prompts are ignored.
 * Members share one label, taken from the first member that carries a
 * non-blank one (falling back to the raw id when every label is blank).
 */
export function listGroups(prompts: readonly PresetPrompt[]): PromptGroup[] {
  const order: string[] = [];
  const members = new Map<string, PresetPrompt[]>();
  for (const prompt of prompts) {
    const group = prompt.group;
    if (group === undefined) {
      continue;
    }
    const list = members.get(group.id);
    if (list === undefined) {
      order.push(group.id);
      members.set(group.id, [prompt]);
    } else {
      list.push(prompt);
    }
  }
  return order.map((id) => {
    const groupMembers = members.get(id) ?? [];
    return { id, label: groupLabel(groupMembers, id), members: groupMembers };
  });
}

/** First non-blank member label, else `fallback` — members share one label. */
function groupLabel(members: readonly PresetPrompt[], fallback: string): string {
  for (const member of members) {
    const label = member.group?.label.trim() ?? "";
    if (label !== "") {
      return label;
    }
  }
  return fallback;
}

/** Ids of a group's enabled members, in pipeline order. */
export function enabledMemberIds(prompts: readonly PresetPrompt[], groupId: string): string[] {
  return prompts
    .filter((prompt) => prompt.group?.id === groupId && prompt.enabled)
    .map((prompt) => prompt.id);
}

/**
 * The group with `groupId`, or `undefined` when the pipeline defines none.
 * `listGroups` returns fresh objects each call; a UI that keys its rows by the
 * stable group id can therefore look the row's contents up reactively without
 * remounting it whenever an unrelated prompt row is edited.
 */
export function findGroup(
  prompts: readonly PresetPrompt[],
  groupId: string,
): PromptGroup | undefined {
  return listGroups(prompts).find((group) => group.id === groupId);
}

/**
 * The single enabled member's id, or `null` when NONE or MORE THAN ONE is
 * enabled. A hand-edited preset can end up in either state; both mean "no
 * decided choice", so the UI shows that (and leaves the control unselected)
 * rather than silently picking one of the enabled rows.
 */
export function activeMemberId(prompts: readonly PresetPrompt[], groupId: string): string | null {
  const ids = enabledMemberIds(prompts, groupId);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/**
 * A NEW array with exactly `memberId` enabled and its group siblings disabled.
 * Non-members (including members of other groups) are returned by reference —
 * untouched — and neither the input array nor its objects are mutated.
 *
 * No-op-safe: when `memberId` is not a member of `groupId` (the control's
 * empty placeholder, a stale id, an unknown group) nothing is enabled or
 * disabled; the fresh shallow copy is returned unchanged.
 */
export function applyGroupChoice(
  prompts: readonly PresetPrompt[],
  groupId: string,
  memberId: string,
): PresetPrompt[] {
  const memberExists = prompts.some(
    (prompt) => prompt.group?.id === groupId && prompt.id === memberId,
  );
  if (!memberExists) {
    return [...prompts];
  }
  return prompts.map((prompt) => {
    if (prompt.group?.id !== groupId) {
      return prompt;
    }
    const enabled = prompt.id === memberId;
    // Keep identity when the flag already matches: callers diff the result
    // back into a store, and an unchanged row must not look like a change.
    return prompt.enabled === enabled ? prompt : { ...prompt, enabled };
  });
}
