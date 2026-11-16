/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { MessageGroup } from "../../lib/api-chats";
import { renderMarkdown } from "../../lib/chat-markdown";
import { cx } from "../../lib/cx";
import { INSTANT, riseVariants, useAppMotion } from "../../lib/motion";
import {
  cancelDeleteFrom,
  chatGroupsAtom,
  chatGroupsLoadingAtom,
  chatHasOlderAtom,
  chatIdAtom,
  chatStreamingAtom,
  chatStreamModeAtom,
  chatsAtom,
  deleteFromSeqAtom,
  loadOlderMessages,
  performDeleteFrom,
  settledVariantIdsAtom,
  stop,
  streamingChatIdAtom,
  streamTextNonEmptyAtom,
} from "../../stores/chat";
import { chatHistoryAtom } from "../../stores/chat-history";
import { formattingAtom, timestampsAtom } from "../../stores/formatting";
import { layoutAvatarsAtom, layoutMessageViewAtom } from "../../stores/layout";
import { streamRevealAtom } from "../../stores/stream-reveal";
import { writingStyleAtom } from "../../stores/writing";
import { MessageCircle, Square } from "../ui/icons";
import { Presence } from "../ui/presence";
import MessageBubble from "./MessageBubble";

/** Entrance bookkeeping carried between evaluations of the entrance memo:
 *  which chat it last saw, and how many groups were already on screen. */
interface EntranceState {
  chatId: string | null;
  baseline: number;
  seqs: Map<number, number>;
}

/** The group's chosen swipe id — the message the done event names when a
 *  stream settles into this group. Prefers the active flag and falls back
 *  to the group's active_id, mirroring MessageBubble's chosenVariant. */
function activeVariantId(group: MessageGroup): string | null {
  return group.variants.find((variant) => variant.active)?.id ?? group.active_id;
}

const noEntrance = new Map<number, number>();

/** Finger travel (px) that counts as a deliberate downward drag — the reader
 *  pulling the transcript toward older messages. Below it a touchmove reads as
 *  jitter, so a resting or tapping finger never stops the stream follow. */
const TOUCH_INTENT_PX = 8;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Tap-away dismissal for the floating action toolbar (`.msg-actions`). The
 * toolbar's reveal rides `:focus-within`, and each row is focusable
 * (`tabIndex={0}`), so a tap focuses the row and leaves the toolbar pinned
 * open — including when the reader tapped the empty space *beside* a bubble,
 * since `.msg` spans the transcript width. This blurs the focused row to
 * release `:focus-within` and let the toolbar hide.
 *
 * Two guards keep that blur from firing on the wrong target:
 *  - the meta line, the bubble, the inline editor and the toolbar ARE "the
 *    message" — tapping them must keep the toolbar, so those targets return
 *    early (a tap there bubbles up to this list-level handler);
 *  - only a focused element inside a `.msg` row is blurred, which preserves
 *    focus on the "Load earlier" button and the delete-confirm bar: both are
 *    list children but not row children.
 */
function dismissMessageActions(event: ReactMouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest(".msg-meta, .msg-bubble, .msg-edit, .msg-editing, .msg-actions") !== null) {
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".msg") !== null) {
    active.blur();
  }
}

/**
 * Trailing live bubble for an append run. It is its own component so it — and
 * only it — subscribes to the raw stream text: every token re-renders this
 * bubble's HTML while the transcript around it stays untouched. Its growth
 * effect also keeps a pinned viewport glued to the bottom without easing,
 * exactly the token-by-token follow the monolithic effect used to do.
 *
 * Structurally it mirrors the persisted assistant bubble from the first
 * token: the same `.msg-meta` row with the character's avatar and name, so the
 * settle swap only reveals the timestamp rather than adding a speaker line.
 * The Stop control rides that same row instead of a separate actions row — a
 * second row would make this bubble ~28px taller than the settled one and
 * introduce a downward jump when it is replaced.
 */
function LiveBubble({ onGrow }: { onGrow: () => void }) {
  // The paced reveal text, not the raw stream text: the writing style may
  // hold characters back so the reply flows in smoothly. Under the default
  // "instant" style the two are identical.
  const streamText = useAtomValue(streamRevealAtom);
  const streaming = useAtomValue(chatStreamingAtom);
  const writingStyle = useAtomValue(writingStyleAtom);
  const formatting = useAtomValue(formattingAtom);
  const chatId = useAtomValue(chatIdAtom);
  const chats = useAtomValue(chatsAtom);
  const avatars = useAtomValue(layoutAvatarsAtom);
  const app = useAppMotion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderMarkdown reads the live formatting toggles from the store, so a formatting change must recompute even though it is not a syntactic argument.
  const html = useMemo(() => renderMarkdown(streamText), [streamText, formatting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: streamText is the trigger — each token scrolls a pinned viewport; onGrow reads no other value.
  useLayoutEffect(() => {
    onGrow();
  }, [streamText, onGrow]);

  // The open chat's row carries the character identity (chats are organized by
  // character), mirroring MessageBubble's meta row so the live bubble wears the
  // same avatar + name the settled bubble will keep. There is no stored group
  // yet, so the speaker falls back to the bare role label exactly as a settled
  // assistant group with a null name does.
  const chat = chats.find((row) => row.id === chatId) ?? null;
  const speaker = chat?.character_name ?? "assistant";
  const avatarUrl = blobUrl(chat?.character_avatar_path ?? null);
  const avatarInitial = speaker.charAt(0).toUpperCase();

  // The parent renders this only for a scoped append run; the guard covers the
  // idle-but-held edge where a clean settle cleared the text first.
  if (!streaming && streamText === "") {
    return null;
  }
  return (
    // The live surface mounts once per run (its tokens only repaint the inner
    // HTML), so a plain declarative entrance can never replay per token. It
    // mirrors the settled bubble's entrance (rise + a hair of scale) so the
    // settle swap reads as the same bubble, not a replacement.
    <motion.div
      className="msg msg-assistant msg-live"
      initial={app.reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={app.reduce ? INSTANT : app.transition}
    >
      <div className="msg-meta">
        {avatars && (
          <span className="msg-avatar" aria-hidden="true">
            {avatarUrl ? (
              <img className="avatar-image" src={avatarUrl} alt="" loading="lazy" />
            ) : (
              avatarInitial
            )}
          </span>
        )}
        <span className="msg-speaker caption">{speaker}</span>
        {/* Only while tokens flow: a failed run keeps its partial text on
            screen but there is nothing left to stop, and the composer's own
            Send/Stop button already covers every mode. */}
        {streaming && (
          <motion.button
            type="button"
            className="btn btn-danger btn-stop"
            whileTap={app.reduce ? undefined : { scale: 0.94 }}
            onClick={() => stop()}
          >
            <Square size={11} />
            Stop
          </motion.button>
        )}
      </div>
      <div className="msg-bubble">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes prose and filters HTML-mode markup. */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <span className="live-cursor" data-writing={writingStyle} aria-hidden="true" />
      </div>
    </motion.div>
  );
}

/** The scrolling transcript of the open chat plus the live streaming bubble. */
export default function MessageList() {
  // Read the transcript through its own atom: a stream token never touches it.
  const groups = useAtomValue(chatGroupsAtom);
  const hasOlder = useAtomValue(chatHasOlderAtom);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // True only while the open chat's first transcript fetch is in flight; gates
  // the loading placeholder below so the empty state never flashes first.
  const groupsLoading = useAtomValue(chatGroupsLoadingAtom);
  const chatId = useAtomValue(chatIdAtom);
  const streamingChatId = useAtomValue(streamingChatIdAtom);
  const streaming = useAtomValue(chatStreamingAtom);
  const streamMode = useAtomValue(chatStreamModeAtom);
  const settledVariantIds = useAtomValue(settledVariantIdsAtom);
  const deleteFromSeq = useAtomValue(deleteFromSeqAtom);
  // Boolean projection: re-renders the list once when held text appears or
  // clears, never on the tokens themselves (those land in LiveBubble).
  const streamTextNonEmpty = useAtomValue(streamTextNonEmptyAtom);
  // Render-windowing settings (singleton store, like formatting): how many
  // messages stay mounted at once. Older groups load on scroll-up.
  const chatHistory = useAtomValue(chatHistoryAtom);
  // Formatting store — a singleton like the chat store, so this read hands
  // back the same live settings. The timestamps mode read below drives the
  // list root's .timestamps-hover class: chat.css hides each row's stamp
  // until its row is hovered or keyboard-focused while that class rides on
  // the root. The layout store's message-view read works the same way: it
  // drives the root's .msg-view-flat class, so the settled bubbles, the live
  // bubble, and the inline editor all inherit the flat look from one root.
  const timestamps = useAtomValue(timestampsAtom);
  const messageView = useAtomValue(layoutMessageViewAtom);
  const app = useAppMotion();

  const listRef = useRef<HTMLDivElement | null>(null);

  // Seq of the last assistant group — only that bubble offers Regenerate.
  const lastAssistantSeq = useMemo(
    () => groups.findLast((group) => group.role === "assistant")?.seq ?? null,
    [groups],
  );

  // --- Render windowing ------------------------------------------------------
  // Only a tail of the transcript stays in the DOM: `baseWindow` groups by
  // default, growing by that much per scroll-up. `windowSize` is 0 until the
  // reader (or the chat-switch reset below) sets it, which means "use the
  // base window". Local state keeps each mounted list independent.
  const baseWindow = chatHistory.maxMessages;
  const [windowSize, setWindowSize] = useState(0);
  const renderedGroups = useMemo(() => {
    const size = windowSize || baseWindow;
    return size >= groups.length ? groups : groups.slice(groups.length - size);
  }, [groups, windowSize, baseWindow]);
  const hiddenCount = groups.length - renderedGroups.length;

  // On a chat switch, restart the window at the base size. The store sets
  // chatId before the fresh groups land, so this reset runs against the old
  // (or empty) list and the new history renders already windowed. The reset
  // also re-syncs when the configured base changes (e.g. async hydration of
  // chatHistory.maxMessages landing after mount), so the configured limit is
  // never ignored until the next switch. Tracking both the last chat id and
  // the last base keeps unrelated re-runs from clobbering a grown window.
  const windowChatId = useRef<string | null | undefined>(undefined);
  const windowBase = useRef(0);
  useEffect(() => {
    if (chatId === windowChatId.current && baseWindow === windowBase.current) {
      return;
    }
    windowChatId.current = chatId;
    windowBase.current = baseWindow;
    setWindowSize(baseWindow);
  }, [chatId, baseWindow]);

  // Scroll-up loads older groups. `anchor` snapshots the scroll geometry just
  // before the DOM grows so the anchoring effect below can keep the reader's
  // viewport fixed while content is prepended.
  const LOAD_OLDER_PX = 120;
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const loadOlder = async (): Promise<void> => {
    const list = listRef.current;
    if (!list || anchorRef.current !== null || loadingOlderRef.current) {
      return;
    }
    if (hiddenCount > 0) {
      anchorRef.current = { top: list.scrollTop, height: list.scrollHeight };
      setWindowSize(Math.min(groups.length, renderedGroups.length + baseWindow));
    } else if (hasOlder) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      try {
        const added = await loadOlderMessages();
        if (added > 0 && windowChatId.current === chatId && listRef.current === list) {
          anchorRef.current = { top: list.scrollTop, height: list.scrollHeight };
          setWindowSize(renderedGroups.length + added);
        }
      } finally {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  };

  // Re-runs once windowSize changes, i.e. after the DOM has grown: shift the
  // scroll offset by exactly the height added above the viewport. A layout
  // effect because it reads scroll geometry and writes scrollTop synchronously
  // after commit, before the browser can paint the shifted content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowSize is the trigger — the DOM has already grown by the time this layout effect runs.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) {
      return;
    }
    const list = listRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = anchor.top + (list.scrollHeight - anchor.height);
    anchorRef.current = null;
  }, [windowSize]);

  // The live bubble belongs to the chat being streamed: while tokens flow, or
  // after a failure left its partial text behind. Append runs only — a
  // replace run (a regenerate aimed at the trailing assistant message)
  // paints its tokens straight into that message's own bubble, so a separate
  // live bubble here would render the same stream twice. Continue is excluded
  // for the same reason: it streams into that bubble's live surface too, so
  // there is no separate live bubble to show.
  const showLive =
    chatId === streamingChatId && streamMode === "append" && (streaming || streamTextNonEmpty);

  // Groups a confirmed delete-from would drop: the boundary group plus
  // everything after it. Feeds the confirm bar's count; zero whenever the
  // mode is off (the bar itself doesn't render then).
  const pendingDeleteCount =
    deleteFromSeq === null ? 0 : groups.filter((group) => group.seq >= deleteFromSeq).length;

  // --- Entrance choreography ------------------------------------------------
  // The store replaces the whole groups array on every reload, so DOM
  // identity can't tell "genuinely new messages" from "same messages,
  // re-fetched". This memo can: a chat switch arms the next batch to stagger
  // in from index zero (the initial history), a same-chat growth animates
  // only the appended tail (a sent exchange), and a same-or-smaller count
  // (swipe switch, regenerate, delete) re-renders with no entrance at all.
  // One growth is exempt: a group the server just persisted from the live
  // stream (its id recorded in settledVariantIds by the done event) enters
  // with no animation — its content was already on screen through the live
  // bubble, and animating the stored copy would replay an entrance the
  // reader watched happen token by token. Stagger indexes clamp at 9 so a
  // long history never queues hundreds of staggered delays. The baseline
  // bookkeeping rides in a ref instead of outer variables mutated during
  // render: the memo stays a pure function of its dependencies, and the ref
  // is advanced after commit, so a StrictMode double-invoke cannot arm or
  // consume an entrance twice. That purity is also why the settled ids are
  // only ever dropped by the store (runGenerate's settle, openChat) — never
  // consumed here: this memo just reads them, so re-evaluating it for
  // unchanged groups cannot flip an armed entrance.
  const entranceRef = useRef<EntranceState | undefined>(undefined);
  const entrance = useMemo<EntranceState>(() => {
    const prev = entranceRef.current;
    // First evaluation, or a switch to another chat: the baseline restarts
    // at zero.
    const switched = prev === undefined || chatId !== prev.chatId;
    const baseline = switched ? 0 : prev.baseline;
    if ((switched && groups.length > 0) || groups.length <= baseline) {
      // Nothing enters: either the groups still on screen belong to the
      // previous chat — the fresh history lands on the next update and
      // starts from zero — or the count didn't grow (swipe switch,
      // regenerate, delete).
      return { chatId, baseline: switched ? 0 : groups.length, seqs: noEntrance };
    }
    const seqs = new Map<number, number>();
    for (let i = baseline; i < groups.length; i++) {
      const group = groups[i];
      if (!group) {
        continue;
      }
      // A settled-stream group skips its entrance while still advancing the
      // baseline (the return below counts it as known content), so a later
      // growth never re-arms it either.
      const variantId = activeVariantId(group);
      if (variantId === null || !settledVariantIds.has(variantId)) {
        seqs.set(group.seq, Math.min(seqs.size, 9));
      }
    }
    return { chatId, baseline: groups.length, seqs };
  }, [chatId, groups, settledVariantIds]);
  // Layout effect (not passive): the memo above reads entranceRef.current
  // during render, so the baseline must be advanced in the same commit — a
  // passive effect could still be pending when a sync-lane render re-reads it.
  useLayoutEffect(() => {
    entranceRef.current = entrance;
  }, [entrance]);
  const entering = entrance.seqs;

  // --- Auto-scroll -----------------------------------------------------------
  // The transcript follows new output only while the reader is at the bottom.
  // Opening a chat always jumps, a newly arrived message glides, and
  // token-by-token stream growth follows without easing (see LiveBubble's
  // growth effect). Kicking off a generation (the live bubble appearing)
  // re-arms pinning: the reader asked for that output.
  //
  // Re-arming uses the *true* bottom, not a near-bottom band. Tokens grow the
  // content every frame, so "within 96px of the bottom" is the bottom: a
  // reader who nudged up a line or two was dragged straight back by the next
  // token until they fought their way past the band. Only landing on the
  // bottom (within REPIN_PX) resumes the follow.
  const REPIN_PX = 8;
  // Upward offset travel between two scroll events that counts as the reader
  // leaving the bottom. Wheel/touch/key gestures flip the ref synchronously
  // below; this catches the paths they never see (scrollbar drag, autoscroll).
  const SCROLL_UP_PX = 2;
  const pinnedRef = useRef(true);
  // Last scrollTop observed by onScroll, to detect an upward move.
  const lastScrollTopRef = useRef(0);
  const scrollChatIdRef = useRef<string | null | undefined>(undefined);
  const scrollGroupCountRef = useRef(0);
  const scrollLiveRef = useRef(false);
  // First touch's clientY for the gesture-intent handler below; null when no
  // single-finger drag is in progress.
  const touchStartYRef = useRef<number | null>(null);

  const groupCount = groups.length;

  // Unpinning when there is nothing above the viewport (a transcript shorter
  // than its column) would silently cut the follow the reader still wants:
  // they flicked up, but the list had no older content to reveal.
  const canScrollUp = (): boolean => {
    const list = listRef.current;
    return list !== null && list.scrollTop > 0;
  };

  const onScroll = (): void => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = list.scrollTop;
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= REPIN_PX) {
      // At the true bottom: follow again.
      pinnedRef.current = true;
    } else if (list.scrollTop < previousTop - SCROLL_UP_PX) {
      // The offset moved up between two events: the reader left the bottom.
      // The window-collapse branch below also lowers scrollTop, but it ends
      // pinned at the true bottom, so the check above claims it first.
      pinnedRef.current = false;
    }
    if (list.scrollTop <= LOAD_OLDER_PX) {
      // Near the top: bring older groups back into the window.
      void loadOlder();
    } else if (pinnedRef.current && !streaming && windowSize > baseWindow) {
      // Back at the bottom and idle: collapse to the base window. The browser
      // clamps scrollTop to the shrunken bottom, so the view stays pinned.
      setWindowSize(baseWindow);
    }
  };

  // --- Scroll-up intent ------------------------------------------------------
  // The handlers below unpin on the gesture itself, before the browser has
  // dispatched the scroll event it causes. `onScroll` is necessarily
  // after-the-fact (the offset has already moved by the time it runs), while
  // every token pins the viewport from a layout effect; a token that fires in
  // that window still sees pinnedRef === true and snaps the viewport back to
  // the bottom — the "teleport" the reader fights while scrolling up mid
  // stream. Flipping the ref here, synchronously, closes that window.
  //
  // Wheel and touch only ever flip the ref: no preventDefault (React attaches
  // both as passive root listeners anyway), so scrolling stays native and
  // `onScroll` owns the geometry re-pin — landing at the true bottom resumes
  // the follow there; nothing above it does.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    // Deltas are negative up / positive down. A zero (or horizontal-only)
    // delta is not a scroll toward older content, hence the strict test —
    // a trackpad's two-axis events must not unpin a reader sitting still.
    if (event.deltaY < 0 && canScrollUp()) {
      pinnedRef.current = false;
    }
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    // Only a single-finger drag scrolls the transcript; a multi-touch gesture
    // (pinch) is not a scroll, so forget any start point for it.
    touchStartYRef.current =
      event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const startY = touchStartYRef.current;
    if (startY === null || event.touches.length !== 1) {
      return;
    }
    const currentY = event.touches[0]?.clientY;
    if (currentY === undefined) {
      return;
    }
    // A finger moving DOWN drags the content up, toward older messages.
    if (currentY - startY > TOUCH_INTENT_PX && canScrollUp()) {
      pinnedRef.current = false;
      // One unpin is enough — the ref stays false until the reader lands back
      // on the bottom — so drop the start point instead of re-testing it
      // every remaining move.
      touchStartYRef.current = null;
    }
  };

  const onTouchEnd = (): void => {
    touchStartYRef.current = null;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed inside the inline message editor move its caret, not the
    // transcript, so they must not stop the follow.
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("textarea, input") !== null) {
      return;
    }
    if (
      (event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home") &&
      canScrollUp()
    ) {
      pinnedRef.current = false;
    }
  };

  // Layout effect: it reads scroll geometry and writes scrollTop in the same
  // commit, so a chat switch or a new message never paints mid-jump.
  // windowSize and groups are trigger-only deps (the body reads neither): a
  // grown render window prepends older groups, and a same-count repaint — a
  // swipe swapping in a taller or shorter variant — changes the last bubble's
  // height, so a pinned view must re-anchor either way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowSize/groups: triggers.
  useLayoutEffect(() => {
    // Track the render window too: when it grows (hydration or a base
    // increase) older groups are prepended and, while pinned, the view must
    // re-pin to the bottom. A no-op when unpinned (the load-older path).
    const list = listRef.current;
    if (!list || (chatId === null && groupCount === 0)) {
      return;
    }
    if (chatId !== scrollChatIdRef.current) {
      // Fresh chat view: land at the bottom immediately, without easing.
      scrollChatIdRef.current = chatId;
      scrollGroupCountRef.current = groupCount;
      scrollLiveRef.current = showLive;
      pinnedRef.current = true;
      list.scrollTop = list.scrollHeight;
      // Seed the upward-move tracker from this jump so the switch itself is
      // never read as the reader scrolling up out of the previous chat.
      lastScrollTopRef.current = list.scrollTop;
      return;
    }
    if (showLive && !scrollLiveRef.current) {
      pinnedRef.current = true;
    }
    scrollLiveRef.current = showLive;
    if (pinnedRef.current) {
      if (groupCount !== scrollGroupCountRef.current) {
        list.scrollTo({
          top: list.scrollHeight,
          behavior: app.reduce || prefersReducedMotion() ? "auto" : "smooth",
        });
      } else {
        list.scrollTop = list.scrollHeight;
      }
    }
    scrollGroupCountRef.current = groupCount;
  }, [windowSize, chatId, groupCount, showLive, groups, app.reduce]);

  // Token growth inside an already-pinned viewport: no easing, and no list
  // re-render — LiveBubble owns the subscription that triggers this.
  const pinLive = useCallback(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, []);

  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: the transcript is a scroll region, not a control — the click is a dismissal-only blur (see dismissMessageActions) and the gesture handlers only flip the pin ref, leaving scrolling native. Keyboard users already reveal and dismiss the toolbar through :focus-within. */
    <div
      className={cx(
        "msg-list",
        timestamps.mode === "hover" && "timestamps-hover",
        messageView === "transcript" && "msg-view-transcript",
        messageView === "flat" && "msg-view-flat",
      )}
      ref={listRef}
      onClick={dismissMessageActions}
      onScroll={onScroll}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onKeyDown={onKeyDown}
    >
      {groups.length > 0 || showLive ? (
        <>
          {(hiddenCount > 0 || hasOlder) && (
            <button
              type="button"
              className="btn btn-ghost load-older"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          )}
          {renderedGroups.map((group) => (
            <MessageBubble
              key={group.seq}
              group={group}
              isLastAssistant={group.seq === lastAssistantSeq}
              enter={entering.get(group.seq) ?? null}
              onLiveGrow={pinLive}
            />
          ))}
          {showLive && <LiveBubble onGrow={pinLive} />}
          {/* Bulk-delete confirm bar: rides as the scroll container's last
              child, so the sticky bottom pin (chat.css) keeps Delete reachable
              while the doomed tail is scrolled through. Presence lets the bar
              animate back out when the boundary is cancelled or committed. */}
          <Presence>
            {deleteFromSeq !== null && (
              <motion.div
                key="del-bar"
                className="del-bar"
                variants={riseVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <span className="del-bar-text">Delete {pendingDeleteCount} messages?</span>
                <motion.button
                  type="button"
                  className="btn btn-danger"
                  aria-label="Delete the selected messages"
                  whileTap={app.reduce ? undefined : { scale: 0.96 }}
                  onClick={() => void performDeleteFrom()}
                >
                  Delete
                </motion.button>
                <motion.button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Cancel deleting the selected messages"
                  whileTap={app.reduce ? undefined : { scale: 0.96 }}
                  onClick={() => cancelDeleteFrom()}
                >
                  Cancel
                </motion.button>
              </motion.div>
            )}
          </Presence>
        </>
      ) : groupsLoading ? (
        // Loading placeholder: echoes the bubble rhythm so the history has
        // something to settle into, and the empty state below never flashes
        // first. The .skeleton delayed fade-in keeps a fast load from blinking.
        <div className="msg-skeleton" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <div className="msg-skeleton-row" key={row}>
              <span className="skeleton sk-line" style={{ width: row % 2 === 0 ? "34%" : "48%" }} />
              <span
                className="skeleton msg-skeleton-bubble"
                style={{ width: row % 2 === 0 ? "62%" : "46%", height: row % 2 === 0 ? 56 : 44 }}
              />
            </div>
          ))}
        </div>
      ) : (
        <motion.div
          className="empty-state"
          variants={riseVariants(app)}
          initial="hidden"
          animate="visible"
        >
          <span className="empty-state-icon" aria-hidden="true">
            <MessageCircle size={28} strokeWidth={1.5} />
          </span>
          <span className="empty-state-title">Nothing here yet</span>
          <span className="empty-state-hint">Say hello — the first message starts the story.</span>
        </motion.div>
      )}
    </div>
  );
}
