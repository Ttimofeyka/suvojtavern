/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageGroup } from "./api-chats";

/**
 * Local `has_tracker` patching for the chat store.
 *
 * A full transcript reload repaints every variant's `has_tracker` from the
 * server, but four flows produce or drop a snapshot without reloading: the
 * SSE tracker event, the panel's manual generate, a per-row delete, and the
 * chat-wide clear. These helpers fold those flips into `chatGroupsAtom`
 * without a network round-trip.
 *
 * Both are PURE: they never mutate their input and keep every unaffected
 * group/variant by reference, so a Jotai subscriber only wakes when its own
 * bubble's flag actually changed (memoized bubbles skip the re-render).
 */

/**
 * Returns `groups` with the variant holding `messageId` flagged
 * `has_tracker = has` (immutable). A message id names at most one variant, so
 * only its owning group is rebuilt — every other group keeps its exact
 * identity. No owning variant (stale id, empty list) returns the input
 * unchanged, so a no-op patch never wakes a subscriber.
 */
export function withTrackerPresence(
  groups: MessageGroup[],
  messageId: string,
  has: boolean,
): MessageGroup[] {
  const index = groups.findIndex((group) =>
    group.variants.some((variant) => variant.id === messageId),
  );
  if (index === -1) {
    return groups;
  }
  return groups.map((group, groupIndex) => {
    if (groupIndex !== index) {
      return group;
    }
    return {
      ...group,
      variants: group.variants.map((variant) =>
        variant.id === messageId ? { ...variant, has_tracker: has } : variant,
      ),
    };
  });
}

/**
 * Returns a new array with every variant's `has_tracker` cleared (the
 * chat-wide clear). Variants that were not flagged — and any group with none —
 * keep their identity, so clearing an already-empty chat wakes no bubble.
 */
export function clearTrackerPresence(groups: MessageGroup[]): MessageGroup[] {
  return groups.map((group) => {
    if (!group.variants.some((variant) => variant.has_tracker)) {
      return group;
    }
    return {
      ...group,
      variants: group.variants.map((variant) =>
        variant.has_tracker ? { ...variant, has_tracker: false } : variant,
      ),
    };
  });
}
