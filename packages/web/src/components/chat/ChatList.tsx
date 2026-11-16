/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { ChatSummaryInfo } from "../../lib/api-chats";
import { cx } from "../../lib/cx";
import { INSTANT, useAppMotion } from "../../lib/motion";
import {
  chatIdAtom,
  chatsAtom,
  chatsHasMoreAtom,
  chatsLoadedAtom,
  chatsLoadingMoreAtom,
  chatsTotalAtom,
  loadMoreChats,
  openChat,
  removeChat,
} from "../../stores/chat";
import { useMobileChats } from "../../stores/mobile-chats";
import CharacterListMore from "../characters/CharacterListMore";
import MobileNavButton from "../MobileNavButton";
import { ChevronDown, MessageCircle, SquarePen, Trash2 } from "../ui/icons";
import NewChatModal from "./NewChatModal";

/** How many placeholder group heads the first-load skeleton draws. Mirrors the
 *  real list's shape: one row per character, all collapsed (the default), so a
 *  head is an avatar + name + chevron toggle. */
const SKELETON_GROUPS = [0, 1, 2, 3, 4];

/** Picks a compact label for a chat's last activity: time today, date before. */
const formatUpdatedAt = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** One character's slice of the chat list. */
interface ChatGroup {
  character_id: string;
  character_name: string;
  character_avatar_path: string | null;
  chats: ChatSummaryInfo[];
}

/** Groups `chats` by character: groups ordered by their most recent chat
 *  activity, the chats inside a group left in the API's newest-first order.
 *  A chat itself has no name — the character is the grouping identity. */
const groupChats = (chats: ChatSummaryInfo[]): ChatGroup[] => {
  const byCharacter = new Map<string, ChatGroup>();
  for (const chat of chats) {
    let group = byCharacter.get(chat.character_id);
    if (group === undefined) {
      group = {
        character_id: chat.character_id,
        character_name: chat.character_name,
        character_avatar_path: chat.character_avatar_path,
        chats: [],
      };
      byCharacter.set(chat.character_id, group);
    }
    group.chats.push(chat);
  }
  const latestActivity = (group: ChatGroup): string =>
    group.chats.reduce((max, chat) => (chat.updated_at > max ? chat.updated_at : max), "");
  return [...byCharacter.values()].sort((a, b) =>
    latestActivity(b).localeCompare(latestActivity(a)),
  );
};

/** How a chat is referred to in labels and confirms: the character plus the
 *  chat's last activity, since a chat has no title of its own to show. */
const chatLabel = (chat: ChatSummaryInfo): string => {
  const when = formatUpdatedAt(chat.updated_at);
  return when === "" ? `with ${chat.character_name}` : `with ${chat.character_name} from ${when}`;
};

/** Left column of the Chats view: chats grouped BY CHARACTER under a header
 *  carrying the character's avatar and name, with each chat reduced to a
 *  timestamp + last-message preview. Every group starts collapsed: clicking
 *  the character row opens that character's most recent chat, while the
 *  chevron expands/collapses the group's chat lines. The no-chats empty state
 *  lives one level up (the Chats view swaps the whole column out for a
 *  full-screen empty state), so an empty-but-loaded list just renders the
 *  header area. */
export default function ChatList() {
  const chats = useAtomValue(chatsAtom);
  const chatsLoaded = useAtomValue(chatsLoadedAtom);
  const chatsTotal = useAtomValue(chatsTotalAtom);
  const chatsHasMore = useAtomValue(chatsHasMoreAtom);
  const chatsLoadingMore = useAtomValue(chatsLoadingMoreAtom);
  const chatId = useAtomValue(chatIdAtom);
  const { closeChats } = useMobileChats();
  const [modalOpen, setModalOpen] = useState(false);
  // Expanded character groups (by character_id); every group starts collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Rows should rise in only when this mount began with a skeleton phase —
  // i.e. it mounted before the store had ever settled a fetch. A cached
  // revisit starts with chatsLoaded already true, so its rows render
  // statically: no entrance-animation replay on revisits, and none when a
  // send-triggered refreshChats swaps in fresh row objects either. The state
  // captures the settled flag once, at setup — later flips of the store flag
  // must not retro-activate the animation.
  const [animate] = useState(() => !chatsLoaded);
  const app = useAppMotion();

  const groups = useMemo(() => groupChats(chats), [chats]);

  const isExpanded = (characterId: string): boolean => expanded.has(characterId);

  /** Opens a chat and dismisses the mobile slide-over so the conversation is
   *  visible (the atom drives only the ≤760px drawer CSS, so this is a
   *  no-op on desktop). */
  const handleOpenChat = (id: string): void => {
    openChat(id);
    closeChats();
  };

  const toggleGroup = (characterId: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(characterId)) {
        next.delete(characterId);
      } else {
        next.add(characterId);
      }
      return next;
    });
  };

  return (
    <section className="chats-list" aria-label="Chats">
      <nav className="chat-history" aria-label="Chat history">
        {/* listChats already orders chats by newest activity; groupChats
            orders the character groups the same way. */}
        {/* Skeletons show only while the very first app-wide fetch is in
            flight — the Chats view's mount refresh is the single initial
            load, and the store's settled flag survives route remounts, so
            revisits render the list at once. */}
        {chatsLoaded ? (
          <>
            <div className="chat-history-head">
              <MobileNavButton />
              <span className="chat-history-caption">Recent</span>
              <span className="chat-history-spacer" />
              <motion.button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Start a new chat"
                data-tip="New chat"
                whileTap={app.reduce ? undefined : { scale: 0.92 }}
                onClick={() => setModalOpen(true)}
              >
                <SquarePen size={15} />
              </motion.button>
            </div>
            {groups.length === 0 ? (
              // Loaded-but-empty list: the app's standard empty-state
              // vocabulary (icon + title + hint) instead of a bare caption.
              <motion.div
                className="empty-state chat-history-empty"
                initial={app.reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={app.reduce ? INSTANT : app.transition}
              >
                <span className="empty-state-icon" aria-hidden="true">
                  <MessageCircle size={22} strokeWidth={1.5} />
                </span>
                <span className="empty-state-title">No chats yet</span>
                <span className="empty-state-hint">The pen above starts one.</span>
              </motion.div>
            ) : null}
            {groups.map((group) => {
              const avatarUrl = blobUrl(group.character_avatar_path);
              const expanded = isExpanded(group.character_id);
              return (
                <div className="chat-group" key={group.character_id}>
                  <div className="chat-group-head">
                    <motion.button
                      type="button"
                      className="chat-group-open"
                      aria-label={`Open most recent chat with ${group.character_name}`}
                      whileTap={app.reduce ? undefined : { scale: 0.99 }}
                      onClick={() => {
                        const latest = group.chats[0];
                        if (latest !== undefined) {
                          handleOpenChat(latest.id);
                        }
                      }}
                    >
                      <span className="chat-group-avatar" aria-hidden="true">
                        {avatarUrl ? (
                          <img className="avatar-image" src={avatarUrl} alt="" loading="lazy" />
                        ) : (
                          group.character_name.slice(0, 1)
                        )}
                      </span>
                      <span className="chat-group-name">{group.character_name}</span>
                    </motion.button>
                    <motion.button
                      type="button"
                      className="chat-group-toggle"
                      aria-expanded={expanded}
                      aria-controls={`chat-group-items-${group.character_id}`}
                      aria-label={
                        expanded
                          ? `${group.character_name}: collapse chats`
                          : `${group.character_name}: expand chats`
                      }
                      whileTap={app.reduce ? undefined : { scale: 0.9 }}
                      onClick={() => toggleGroup(group.character_id)}
                    >
                      <span className="chat-group-chevron" aria-hidden="true">
                        <ChevronDown size={14} />
                      </span>
                    </motion.button>
                  </div>
                  {/* Disclosure entrance: a group mounts its rows on expand,
                      so the wrapper rises while the chevron rotates (CSS). */}
                  {expanded && (
                    <motion.div
                      className="chat-group-items"
                      id={`chat-group-items-${group.character_id}`}
                      initial={app.reduce ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={
                        app.reduce ? INSTANT : { ...app.transition, duration: app.duration.fast }
                      }
                    >
                      {group.chats.map((chat, index) => (
                        // Rows rise only for a fresh visit that began with the
                        // skeleton (`animate`), never for a send-triggered
                        // refresh — same contract the CSS class carried.
                        <motion.div
                          className={cx("chat-item", chat.id === chatId && "chat-item-active")}
                          key={chat.id}
                          initial={animate && !app.reduce ? { opacity: 0, y: 8 } : false}
                          animate={{ opacity: 1, y: 0 }}
                          transition={
                            animate && !app.reduce
                              ? { ...app.transition, delay: Math.min(index, 9) * 0.06 }
                              : INSTANT
                          }
                        >
                          <motion.button
                            type="button"
                            className="chat-item-btn"
                            aria-label={`Open chat ${chatLabel(chat)}`}
                            whileTap={app.reduce ? undefined : { scale: 0.99 }}
                            onClick={() => handleOpenChat(chat.id)}
                          >
                            <span className="chat-item-preview">
                              {chat.last_preview ?? "No messages yet"}
                            </span>
                            <span className="chat-item-time">
                              {formatUpdatedAt(chat.updated_at)}
                            </span>
                          </motion.button>
                          <button
                            type="button"
                            className="chat-item-delete"
                            aria-label={`Delete chat ${chatLabel(chat)}`}
                            data-tip="Delete chat"
                            onClick={() => {
                              if (window.confirm(`Delete chat ${chatLabel(chat)}?`)) {
                                removeChat(chat.id);
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </motion.div>
                      ))}
                    </motion.div>
                  )}
                </div>
              );
            })}
            {/* Pagination footer below the groups: an IntersectionObserver
                sentinel (auto-load on scroll) plus an explicit button and a
                "Showing X of Y" caption. `loaded` is the displayed row count
                (the caption clamps to total itself); the pager's own offset is
                tracked separately in the store. */}
            {groups.length > 0 ? (
              <CharacterListMore
                loaded={chats.length}
                total={chatsTotal}
                loadingMore={chatsLoadingMore}
                hasMore={chatsHasMore}
                onLoadMore={loadMoreChats}
                sentinel
              />
            ) : null}
          </>
        ) : (
          <div className="stack" aria-hidden="true">
            {SKELETON_GROUPS.map((row) => (
              <div className="chat-group" key={row}>
                <div className="chat-group-head chat-group-head-skeleton">
                  <span className="skeleton chat-group-avatar" />
                  <span className="skeleton sk-line" style={{ flex: 1 }} />
                  <span className="skeleton chat-skeleton-toggle" />
                </div>
              </div>
            ))}
          </div>
        )}
      </nav>

      {modalOpen && <NewChatModal onClose={() => setModalOpen(false)} />}
    </section>
  );
}
