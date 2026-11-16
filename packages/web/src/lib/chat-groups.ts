/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageGroup } from "./api-chats";

/**
 * Returns `groups` with the group containing `messageId` switched to it as the
 * active variant (immutable; unmatched groups are returned by reference).
 *
 * This is the local half of an optimistic variant switch: the store flips the
 * visible swipe synchronously so the row can slide back in with fresh content
 * instead of waiting on the activate round-trip. A new array (and new group) is
 * built so Jotai sees a changed reference; every other group keeps its exact
 * identity so unrelated bubbles do not re-render.
 */
export function setActiveVariantLocal(groups: MessageGroup[], messageId: string): MessageGroup[] {
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
      active_id: messageId,
      variants: group.variants.map((variant) => ({
        ...variant,
        active: variant.id === messageId,
      })),
    };
  });
}
