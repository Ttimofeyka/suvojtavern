/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { animate, motion, useAnimationControls, useMotionValue } from "motion/react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import {
  memo,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { blobUrl } from "../../lib/api";
import type { MessageGroup, MessageVariant } from "../../lib/api-chats";
import { deleteMessage } from "../../lib/api-chats";
import { renderMarkdown } from "../../lib/chat-markdown";
import { copyText } from "../../lib/clipboard";
import { mergeContinue } from "../../lib/continue-text";
import { cx } from "../../lib/cx";
import { INSTANT, type MotionVariants, useAppMotion } from "../../lib/motion";
import {
  resolveSwipe,
  type SwipeDirection,
  swipeFromTouch,
  type TouchPoint,
} from "../../lib/swipe-gesture";
import { isTouchDevice } from "../../lib/touch";
import { useIsMobile } from "../../lib/use-viewport";
import {
  activateVariant,
  chatGroupsAtom,
  chatIdAtom,
  chatStreamingAtom,
  chatStreamModeAtom,
  chatSummariesAtom,
  chatsAtom,
  continueMessage,
  deleteFromSeqAtom,
  editMessage,
  enterDeleteFrom,
  forkFrom,
  markSummarizedAtom,
  openChat,
  personaAvatarPathAtom,
  personaNameAtom,
  regenerate,
  streamingChatIdAtom,
  streamTextNonEmptyAtom,
} from "../../stores/chat";
import { formatTimestamp, formattingAtom, timestampsAtom } from "../../stores/formatting";
import { layoutAvatarsAtom, layoutSwipeGesturesAtom } from "../../stores/layout";
import { streamRevealAtom } from "../../stores/stream-reveal";
import { writingStyleAtom } from "../../stores/writing";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  EyeOff,
  GitFork,
  Layers,
  Pencil,
  Radar,
  Trash2,
} from "../ui/icons";
import MessageTrackerViewer from "./MessageTrackerViewer";

interface MessageBubbleProps {
  group: MessageGroup;
  isLastAssistant: boolean;
  /** Stagger index for the entrance animation; null = no entrance. */
  enter: number | null;
  /** Called on every token of an in-place live stream (replace/continue) so
   *  the list can re-pin a pinned viewport; stable across renders. */
  onLiveGrow: () => void;
}

/** The group's chosen swipe: active flag first, then active_id, then any survivor. */
function chosenVariant(group: MessageGroup): MessageVariant | null {
  return (
    group.variants.find((variant) => variant.active) ??
    group.variants.find((variant) => variant.id === group.active_id) ??
    group.variants[0] ??
    null
  );
}

/** Grows the edit textarea with its content, capped by the CSS max-height. */
function growTextarea(input: HTMLTextAreaElement): void {
  input.style.height = "";
  input.style.height = `${input.scrollHeight}px`;
}

/** Replace-mode live body: the stream text painted into the bubble with the
 *  blinking cursor, mirroring MessageList's trailing live bubble. It is its
 *  own component so only this bubble subscribes to the paced stream text. Its
 *  growth effect keeps a pinned viewport glued to the bottom, like the
 *  append-mode trailing bubble. */
function LiveReplaceBody({ onLiveGrow }: { onLiveGrow: () => void }) {
  // The paced reveal text (see MessageList's LiveBubble): the writing style may
  // hold characters back so the reply flows in smoothly; identical to the raw
  // stream text under the default "instant" style.
  const streamText = useAtomValue(streamRevealAtom);
  const writingStyle = useAtomValue(writingStyleAtom);
  const formatting = useAtomValue(formattingAtom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderMarkdown reads the live formatting toggles from the store, so a formatting change must recompute even though it is not a syntactic argument.
  const html = useMemo(() => renderMarkdown(streamText), [streamText, formatting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: streamText is the trigger — each token re-pins a pinned viewport; onLiveGrow reads no other value.
  useLayoutEffect(() => {
    onLiveGrow();
  }, [streamText, onLiveGrow]);

  return (
    <div className="msg-bubble">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes prose and filters HTML-mode markup. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <span className="live-cursor" data-writing={writingStyle} aria-hidden="true" />
    </div>
  );
}

/** Continue-mode live body: the stored content plus the held deltas, joined by
 *  the shared `mergeContinue` rule, with the same cursor. */
function LiveContinueBody({ stored, onLiveGrow }: { stored: string; onLiveGrow: () => void }) {
  const streamText = useAtomValue(streamRevealAtom);
  const writingStyle = useAtomValue(writingStyleAtom);
  const formatting = useAtomValue(formattingAtom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderMarkdown reads the live formatting toggles from the store, so a formatting change must recompute even though it is not a syntactic argument.
  const html = useMemo(
    () => renderMarkdown(mergeContinue(stored, streamText)),
    [stored, streamText, formatting],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: streamText is the trigger — each token re-pins a pinned viewport; onLiveGrow reads no other value.
  useLayoutEffect(() => {
    onLiveGrow();
  }, [streamText, onLiveGrow]);

  return (
    <div className="msg-bubble">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes prose and filters HTML-mode markup. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <span className="live-cursor" data-writing={writingStyle} aria-hidden="true" />
    </div>
  );
}

/** One chat position: speaker, active swipe content, swipe switcher, actions. */
function MessageBubbleInner({ group, isLastAssistant, enter, onLiveGrow }: MessageBubbleProps) {
  const chatId = useAtomValue(chatIdAtom);
  const chats = useAtomValue(chatsAtom);
  const groups = useAtomValue(chatGroupsAtom);
  const streaming = useAtomValue(chatStreamingAtom);
  const streamingChatId = useAtomValue(streamingChatIdAtom);
  const streamMode = useAtomValue(chatStreamModeAtom);
  const streamTextNonEmpty = useAtomValue(streamTextNonEmptyAtom);
  const personaName = useAtomValue(personaNameAtom);
  const personaAvatarPath = useAtomValue(personaAvatarPathAtom);
  const deleteFromSeq = useAtomValue(deleteFromSeqAtom);
  const markSummarized = useAtomValue(markSummarizedAtom);
  const summaries = useAtomValue(chatSummariesAtom);
  const avatars = useAtomValue(layoutAvatarsAtom);
  const swipeGestures = useAtomValue(layoutSwipeGesturesAtom);
  const timestamps = useAtomValue(timestampsAtom);
  const formatting = useAtomValue(formattingAtom);
  const app = useAppMotion();
  const isMobile = useIsMobile();

  // Entrance choreography, driven imperatively rather than with a declarative
  // `initial`: the transcript reuses DOM nodes across a chat switch (the new
  // history's seqs collide with the old one's), so an `initial` variant would
  // never replay. `controls.set`/`start` in a layout effect runs before paint,
  // so the rise lands without a flash; when `enter` is null the element is
  // never touched, which keeps an already-settled bubble's inline-edit and
  // copy state intact across ordinary re-renders.
  //
  // The row animates opacity + y + a hair of scale (never x: the row's `x`
  // is the swipe MotionValue, and a variant would fight it). The scale is
  // deliberately tiny (0.98) so the settle reads as the bubble "landing"
  // rather than a pop, and the per-index delay staggers a freshly opened
  // history the way the CSS `.anim-rise` utilities do elsewhere.
  const controls = useAnimationControls();
  const messageVariants = useMemo<MotionVariants>(
    () => ({
      hidden: { opacity: 0, y: 12, scale: 0.98 },
      visible: (index = 0) => ({
        opacity: 1,
        y: 0,
        scale: 1,
        transition: app.reduce ? INSTANT : { ...app.transition, delay: index * 0.055 },
      }),
    }),
    [app],
  );
  useLayoutEffect(() => {
    if (enter === null) {
      return;
    }
    controls.set("hidden");
    void controls.start("visible");
  }, [enter, controls]);

  // Press feedback for the action-bar controls; the hover reveal itself stays
  // in CSS so `:focus-within` (keyboard) and `:active` (touch) keep working
  // without duplicating hover state in React.
  const tap = app.reduce ? undefined : { scale: 0.86 };

  const variant = useMemo(() => chosenVariant(group), [group]);
  const activeIndex = useMemo(() => {
    const index = group.variants.findIndex((candidate) => candidate.active);
    return index === -1 ? 0 : index;
  }, [group]);

  // The persisted name wins (it rode along at send time); otherwise the user
  // speaks as the open chat's persona — the classic "You" only while none is
  // resolved — and assistants keep the bare role label.
  const speaker = group.name ?? (group.role === "user" ? (personaName ?? "You") : group.role);

  const settledContent = variant?.content ?? "";

  /** The chosen swipe's timestamp, or null when nothing should render: mode
   *  "off" skips the element entirely ("hover" still renders it — CSS does
   *  the hiding), and an empty or unparseable created_at yields no <time>.
   *  formatTimestamp reads the live timestamps store, so the label follows
   *  the format setting. */
  const timestamp = useMemo((): { iso: string; label: string } | null => {
    if (timestamps.mode === "off") {
      return null;
    }
    const iso = variant?.created_at ?? "";
    if (iso === "") {
      return null;
    }
    const label = formatTimestamp(iso);
    return label === "" ? null : { iso, label };
  }, [timestamps, variant]);

  // The open chat's row: chats are organized BY CHARACTER, so the store's
  // list is where the character's identity lives.
  const chat = useMemo(() => chats.find((row) => row.id === chatId) ?? null, [chats, chatId]);

  /** Mirrors the store's mode pick (stores/chat.ts runGenerate): a continue
   *  is an in-place edit only when the LAST message of the transcript is an
   *  assistant one, otherwise the server falls back to appending a fresh
   *  reply. `isLastAssistant` marks the last assistant bubble, which is
   *  NOT the tail when the chat ends in a user message — there the Continue
   *  control must disappear, or it would promise to extend a message while
   *  actually appending a new one, exactly what the store does not do. */
  const canContinue = isLastAssistant && groups[groups.length - 1]?.role === "assistant";

  /** The bubble avatar's image, when one is available: the open chat's
   *  character for assistants, its persona (store-resolved) for the user. */
  const avatarImage =
    group.role === "user" ? personaAvatarPath : (chat?.character_avatar_path ?? null);
  const avatarUrl = blobUrl(avatarImage);

  /** The avatar circle's letter fallback: the persona's initial for the
   *  user (a plain "U" while none is resolved), else the group's initial —
   *  shown whenever no avatar image resolves. */
  const avatarInitial =
    group.role === "user"
      ? (personaName ?? "").charAt(0).toUpperCase() || "U"
      : (group.name ?? group.role).charAt(0).toUpperCase();

  /** A regenerate streams INTO the last assistant bubble instead of
   *  appending a fresh one below it: the store picks "replace" before the
   *  run starts and clears the held text, so the bubble first visibly
   *  empties and then fills token by token. Live while the stream belongs
   *  to this chat — including a failed run's kept partial, the same
   *  contract as MessageList's trailing live bubble. */
  const liveReplace =
    isLastAssistant &&
    streamMode === "replace" &&
    streamingChatId === chatId &&
    (streaming || streamTextNonEmpty);

  /** A continue (SillyTavern's, not a regenerate) streams INTO the last
   *  assistant bubble too, but keeps its stored content on screen: the
   *  surface below renders the chosen swipe joined to the held deltas by
   *  `mergeContinue` (the same SillyTavern `continue_postfix` rule the server
   *  persists with — see lib/continue-text.ts), so the message never empties,
   *  the continuation never starts mid-word, and the live text matches the
   *  stored truth at settle. Same liveness contract as liveReplace, including
   *  a failed run's kept partial. */
  const liveContinue =
    isLastAssistant &&
    streamMode === "continue" &&
    streamingChatId === chatId &&
    (streaming || streamTextNonEmpty);
  const liveActive = liveReplace || liveContinue;

  // --- Swipe transition ------------------------------------------------------
  // SillyTavern's slide, not a drag-tilt: the row's horizontal offset lives in
  // a MotionValue driven imperatively by `animate`, so the transition costs no
  // React renders and the gesture and the chevrons share exactly one path.
  const swipeX = useMotionValue(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The hover action toolbar. It is not its own tab stop: the row (rootRef) is
  // the single stop, and arrow keys rove INTO the toolbar's buttons (all of
  // which are tabIndex={-1}). A full transcript therefore costs one stop per
  // message instead of one per control.
  const actionsRef = useRef<HTMLDivElement | null>(null);
  // One swipe at a time, exactly like SillyTavern's single global slide: a
  // second commit mid-slide would fight the first over `swipeX`.
  const swipingRef = useRef(false);

  /** True while the right chevron sits on the group's last swipe. */
  const atLastVariant = activeIndex >= group.variants.length - 1;

  /** What a committed swipe does — the single source of truth for the
   *  chevrons and the gesture. The last assistant group's last swipe
   *  GENERATES a fresh one instead of switching, and only while idle
   *  (mirrors the old nextVariant). */
  const swipeAction = (direction: SwipeDirection): "switch" | "generate" | null => {
    if (direction === "next") {
      const canNext = isLastAssistant || group.variants.length > 1;
      if (!canNext) {
        return null;
      }
      if (isLastAssistant && atLastVariant) {
        return !streaming ? "generate" : null;
      }
      return "switch";
    }
    return group.variants.length > 1 ? "switch" : null;
  };

  /** Fires the change itself — SYNCHRONOUS, so the local flip lands in the same
   *  task as the slide's turn-around: a variant switch (the store updates the
   *  active swipe before it awaits the network, so the row slides back in with
   *  fresh content instead of stalling on a round-trip) or a fresh generation
   *  (fired and forgotten — the live stream owns the bubble). */
  const commitSwipe = (action: "switch" | "generate", direction: SwipeDirection): void => {
    if (action === "generate") {
      void regenerate();
      return;
    }
    const variants = group.variants;
    const delta = direction === "next" ? 1 : -1;
    const next = variants[(activeIndex + delta + variants.length) % variants.length];
    if (next) {
      void activateVariant(next.id);
    }
  };

  /** SillyTavern's swipe transition: the row slides out to one side, the
   *  content changes, then it slides back in from the opposite side. Next goes
   *  out left and in from the right; previous mirrors it. The commit is
   *  synchronous and optimistic — `activateVariant` flips the active swipe
   *  locally before its network round-trip — so the two legs run back-to-back
   *  with no stall between them. */
  const runSwipe = async (direction: SwipeDirection): Promise<void> => {
    const action = swipeAction(direction);
    if (action === null || swipingRef.current) {
      return;
    }
    swipingRef.current = true;
    try {
      if (app.reduce) {
        commitSwipe(action, direction);
        return;
      }
      const width = rootRef.current?.offsetWidth ?? window.innerWidth;
      const outX = direction === "next" ? -width : width;
      const tween = { duration: app.duration.fast, ease: "easeInOut" } as const;
      await animate(swipeX, outX, tween).finished;
      // Local flip is synchronous; the network persist/reconcile continues in
      // the background, so the fresh content is up before the return leg.
      commitSwipe(action, direction);
      // The exit leg parked the row at `outX`; place the fresh content at
      // `-outX` and slide it home, so it enters from the opposite side — the
      // two legs read as one continuous push (SillyTavern's "swipe in from
      // the opposite side").
      swipeX.set(-outX);
      await animate(swipeX, 0, tween).finished;
    } finally {
      swipeX.set(0);
      swipingRef.current = false;
    }
  };

  /** The right chevron's label follows what a click would do: "Next swipe"
   *  while it can still advance, "Generate a new swipe" once it would run
   *  off the end of the last assistant group — always the case there for a
   *  single-variant group, whose row shows only this chevron. */
  const nextTip = isLastAssistant && atLastVariant ? "Generate a new swipe" : "Next swipe";

  // --- Inline edit ------------------------------------------------------------
  // The SillyTavern-style correction loop: one click swaps the rendered
  // bubble for a textarea carrying the swipe's RAW text — never its rendered
  // markdown — so a fix costs an edit instead of a resend. The editor is
  // local to this bubble, and it targets the group's chosen swipe: switch
  // swipes first, edit the one on screen.
  const [editing, setEditing] = useState(false);
  // True while the save request is in flight — blocks Enter and the Save
  // button against a double submit.
  const [savingEdit, setSavingEdit] = useState(false);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // The transcript's scroll offset and the bubble's height, captured just
  // before the editor swaps in. Opening the editor replaces the bubble with a
  // textarea (plus a Save pair); without these the browser answers the row's
  // new height with a scroll clamp or anchor adjustment, nudging the
  // transcript. The editor keeps the bubble's footprint and the offset is
  // restored in the same commit, so the reader stays exactly where they were.
  const beforeEditRef = useRef<{ scrollTop: number; height: number } | null>(null);
  // The ref callback below reads the chosen swipe's raw text at mount time;
  // routing it through a ref keeps the callback identity stable, so React
  // never detaches/reattaches the field (which would refill and refocus it on
  // every keystroke).
  const variantRef = useRef(variant);
  // Written in an insertion effect (which runs before the field's ref callback
  // can fire) rather than during render, so a render React discards cannot
  // leave the ref ahead of committed output.
  useInsertionEffect(() => {
    variantRef.current = variant;
  });

  /** Leaves edit mode without any request. */
  const cancelEdit = () => setEditing(false);

  /** Opens the editor, remembering the transcript's scroll offset and the
   *  bubble's height so the swap can hold both. Captured here, before React
   *  commits, because by the time the textarea's ref callback runs the browser
   *  has already reacted to the row's new height. */
  const startEdit = () => {
    const row = rootRef.current;
    const list = row?.closest<HTMLElement>(".msg-list") ?? null;
    const bubble = row?.querySelector<HTMLElement>(".msg-bubble") ?? null;
    beforeEditRef.current =
      list !== null && bubble !== null
        ? { scrollTop: list.scrollTop, height: bubble.offsetHeight }
        : null;
    setEditing(true);
  };

  /** Grows the edit textarea with its content, capped by the CSS max-height. */
  const autoGrowEdit = () => {
    const input = editInputRef.current;
    if (input) {
      growTextarea(input);
    }
  };

  /** Persists the textarea's text as the displayed swipe's new content.
   *  Unchanged text just leaves edit mode — nothing to PATCH, and a no-op
   *  save must not bump the chat's updated_at. A failed request keeps the
   *  editor open (the shared error banner reports it), so the draft
   *  survives. */
  const saveEdit = () => {
    if (savingEdit) {
      return;
    }
    const input = editInputRef.current;
    const target = variant;
    if (!input || !target) {
      return;
    }
    if (input.value === target.content) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    void editMessage(target.id, input.value).then((ok) => {
      setSavingEdit(false);
      // On success the store's refetch has already repainted the bubble —
      // drop the editor. A failure leaves it up, draft intact.
      if (ok) {
        setEditing(false);
      }
    });
  };

  // Prefill with the swipe's raw text — never its rendered markdown — and park
  // the caret at its end. The value is set here rather than through a prop so
  // the field stays uncontrolled, exactly like the composer's.
  const attachEditInput = useCallback((el: HTMLTextAreaElement | null) => {
    editInputRef.current = el;
    if (el === null) {
      return;
    }
    el.value = variantRef.current?.content ?? "";
    // preventScroll: focusing a freshly inserted field makes the browser scroll
    // it into view, which nudges a transcript the reader had parked anywhere.
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // Keep the editor's footprint at least as tall as the bubble it replaced:
    // that removes the row's height drop, which is what the browser reacts to
    // with a clamp or an anchor adjustment. The wrapper (not the textarea)
    // takes the floor, so deleting text never shrinks the box mid-edit, and the
    // field may use that height instead of capping at eight rows and leaving
    // dead space (with an inner scrollbar) under the text.
    const list = el.closest<HTMLElement>(".msg-list");
    const wrapper = el.parentElement;
    const before = beforeEditRef.current;
    beforeEditRef.current = null;
    if (before !== null && wrapper !== null) {
      wrapper.style.minHeight = `${before.height}px`;
      const rowCap = Number.parseFloat(getComputedStyle(el).maxHeight) || 0;
      el.style.maxHeight = `${Math.max(before.height, rowCap)}px`;
    }
    growTextarea(el);
    // Put the transcript back exactly where the reader left it. With the
    // footprint held this is normally a no-op, but a message taller than the
    // viewport can still hit the clamp, where keeping the value would leave a
    // bottom-pinned view slightly above the new bottom.
    if (before !== null && list !== null) {
      list.scrollTop = before.scrollTop;
    }
  }, []);

  // --- Touch swipe gestures --------------------------------------------------
  // SillyTavern's swipe-by-touch, restricted to phone widths and gated exactly
  // like the swipe arrows. The right chevron's condition is the model: the
  // LAST assistant group can advance even with a single variant, because its
  // right chevron generates a fresh swipe, so that group is swipable too.
  const canSwipeNext = isLastAssistant || group.variants.length > 1;
  const canSwipePrevious = group.variants.length > 1;
  const swipeEnabled =
    swipeGestures && isMobile && !liveActive && !editing && (canSwipeNext || canSwipePrevious);

  // A drag-to-swipe is followed by a click the browser synthesizes at the end
  // of a touch gesture, and the browser does not suppress it — without this
  // guard a swipe that ended over an action (copy/edit/delete) would also
  // press it. The short timer clears the flag after the trailing click (which
  // can arrive after the touch handler) has had its chance to be swallowed.
  const swipeConsumingClickRef = useRef(false);
  // Gesture origin recorded on touchstart and consumed on touchend. A ref, not
  // state, so a touch never re-renders the transcript.
  const touchStartRef = useRef<TouchPoint | null>(null);

  /** Passive touchstart: remember where a single finger landed. A multi-touch
   *  gesture (pinch/zoom) is not a swipe, so its start is dropped and the
   *  matching touchend is ignored. No preventDefault — the browser keeps
   *  ownership of scrolling and long-press text selection. */
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    if (event.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      touchStartRef.current = null;
      return;
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  };

  /** Passive touchend: decide the swipe from the recorded endpoints, never
   *  touching the event — a mostly-vertical gesture is left to scroll and a
   *  long-press selection is never hijacked. */
  const onTouchEnd = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (start === null) {
      return;
    }
    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }
    // A non-collapsed selection means the user long-pressed to select/copy
    // text: that gesture is theirs, not a swipe. Scoped to THIS bubble — a
    // selection elsewhere on the page must not block this row's swipe.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && rootRef.current?.contains(selection.anchorNode)) {
      return;
    }
    const gesture = swipeFromTouch(start, { x: touch.clientX, y: touch.clientY, t: Date.now() });
    if (gesture === null) {
      return;
    }
    const direction = resolveSwipe(gesture.offsetX, gesture.velocityX, {
      canNext: canSwipeNext,
      canPrevious: canSwipePrevious,
    });
    if (direction === null) {
      return;
    }
    swipeConsumingClickRef.current = true;
    window.setTimeout(() => {
      swipeConsumingClickRef.current = false;
    }, 400);
    // Only the gesture sets the click guard above; a chevron click needs no
    // suppression (and must not move the delete-from boundary).
    void runSwipe(direction);
  };
  const consumeSwipeClick = (event: ReactMouseEvent): void => {
    if (!swipeConsumingClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /** Delete-from selection: while a boundary is set, this bubble wears the
   *  danger wash once at/after it. */
  const selectedForDelete = deleteFromSeq !== null && group.seq >= deleteFromSeq;

  /** Ghost mark: true only while the setting is on AND some loaded summary
   *  row covers this position — the message is hidden from the AI behind
   *  the injected summaries. The rule is purely positional (the greeting
   *  can be covered too); with the setting off (the default) nothing below
   *  renders at all, so messages look exactly as they always did. */
  const summarized =
    markSummarized && summaries.some((row) => row.seq_from <= group.seq && group.seq <= row.seq_to);

  /** A click anywhere on the message while a delete-from boundary is set
   *  moves that boundary to this seq (enterDeleteFrom doubles as the mover).
   *  Clicks that begin on the actions row are left alone — its buttons keep
   *  their own meanings — the inline editor is pure caret work, so while it
   *  is open this message's whole surface is left alone too, and outside
   *  the mode a click on the body is nothing. */
  const moveDeleteBoundary = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // Defense in depth: a swipe's trailing click is also swallowed here, so
    // ending a swipe can never move the delete-from boundary either.
    if (swipeConsumingClickRef.current) {
      return;
    }
    if (deleteFromSeq === null) {
      return;
    }
    if (editing) {
      return;
    }
    if (event.target instanceof Element && event.target.closest(".msg-actions") !== null) {
      return;
    }
    enterDeleteFrom(group.seq);
  };

  /** Enabled controls of the hover toolbar, in DOM order. The swipe counter
   *  is a <span>, so this list is exactly the buttons. */
  const toolbarButtons = (): HTMLButtonElement[] =>
    Array.from(actionsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter(
      (button) => !button.disabled,
    );

  /** Roving-tabindex entry: from the focused row, ArrowDown lands on the first
   *  control and ArrowUp on the last (the toolbar sits below the bubble), so a
   *  keyboard user reaches every action without the row adding tab stops. */
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Only the row itself reacts; keys typed in the inline editor (or pressed
    // on a toolbar button) are left alone.
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const buttons = toolbarButtons();
    const target = event.key === "ArrowDown" ? buttons[0] : buttons[buttons.length - 1];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    target.focus();
  };

  /** Roving within the toolbar: Left/Right step (wrapping), Home/End jump, and
   *  Escape returns focus to the row that owns it. */
  const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      rootRef.current?.focus();
      return;
    }
    const buttons = toolbarButtons();
    if (buttons.length === 0) {
      return;
    }
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowRight") {
      next = (current + 1) % buttons.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = buttons.length - 1;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  const fork = () => {
    if (variant) {
      forkFrom(variant.id);
    }
  };

  /**
   * The store contract has no delete action, so this calls deleteMessage
   * directly and reloads the conversation via openChat. The endpoint removes
   * the whole message — the target row and every other swipe at its position
   * — so the trash deletes the message itself, never a single swipe.
   */
  const remove = async () => {
    const target = variant;
    if (!target || !chatId || !window.confirm("Delete this message and all its swipes?")) {
      return;
    }
    try {
      await deleteMessage(target.id);
    } catch {
      return; // the message stays visible when the request fails
    }
    openChat(chatId);
  };

  // Tracker viewer (the hover action's Radar): a modal, so its open flag is
  // pure local state like the editor's. The button only appears when the
  // shown swipe's ROW carries a snapshot (variant.has_tracker).
  const [viewerOpen, setViewerOpen] = useState(false);

  // Copy feedback: the action shows a check for a moment after a successful
  // write. `copyText` falls back to `execCommand` in an insecure context (LAN
  // HTTP), so a `false` result is a real failure, not just a blocked API.
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const copy = async (): Promise<void> => {
    const text = variant?.content ?? "";
    if (text === "") {
      return;
    }
    if (!(await copyText(text))) {
      return;
    }
    setCopied(true);
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  // Settled markdown, memoized on the raw source string: an unrelated render
  // (a stream token landing in the live body, a sibling's state) never pays
  // for repainting this bubble's HTML.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderMarkdown reads the live formatting toggles from the store, so a formatting change must recompute even though it is not a syntactic argument.
  const settledHtml = useMemo(() => renderMarkdown(settledContent), [settledContent, formatting]);

  return (
    // The delete-from boundary moving is a pointer convenience; keyboard users
    // set the boundary with the per-message Delete-from-here buttons, so the
    // row itself only needs to be focusable (tabIndex below, a11y intent kept
    // from the original div).
    <motion.div
      ref={rootRef}
      className={cx(
        "msg",
        group.role === "user" ? "msg-user" : "msg-assistant",
        liveActive && "msg-live",
        editing && "msg-editing",
        selectedForDelete && "selected-for-delete",
        summarized && "msg-summarized",
      )}
      /* The row's horizontal offset: the swipe transition drives this through
         `animate`. A MotionValue rather than state keeps the slide off React. */
      style={{ x: swipeX }}
      variants={messageVariants}
      custom={enter ?? 0}
      initial={false}
      animate={controls}
      /* Focusable so keyboard users can reach the delete-from boundary it
         hosts; the action buttons remain the named controls. */
      tabIndex={0}
      onClick={moveDeleteBoundary}
      onKeyDown={onRowKeyDown}
      /* Passive touch listeners, only while the swipe is enabled. They never
         call preventDefault, so vertical scrolling and long-press text
         selection stay the browser's; the gesture is judged on touchend and
         only DECIDES — the row sits still until `runSwipe` slides it
         (SillyTavern gives no drag feedback either). */
      onTouchStart={swipeEnabled ? onTouchStart : undefined}
      onTouchEnd={swipeEnabled ? onTouchEnd : undefined}
      onClickCapture={consumeSwipeClick}
    >
      <div className="msg-meta">
        {avatars && (
          // Static: the avatar is part of the speaker line from the first
          // frame. Animating it separately from the bubble made it land a beat
          // late on every send and again when a stream settled.
          <span className="msg-avatar" aria-hidden="true">
            {avatarUrl ? (
              <img className="avatar-image" src={avatarUrl} alt="" loading="lazy" />
            ) : (
              avatarInitial
            )}
          </span>
        )}
        <span className="msg-speaker caption">{speaker}</span>
        {timestamp && (
          <time className="msg-time" dateTime={timestamp.iso}>
            {timestamp.label}
          </time>
        )}
        {/* The ghost chip rides the meta row after the timestamp: an
            inline-flex mark that shifts nothing else (the meta row is its
            own line), readable as an icon for sighted users and as the
            aria-label for assistive tech. Only rendered while the memory
            setting is on and this position is covered. */}
        {summarized && (
          <span
            className="msg-summarized-chip"
            role="img"
            aria-label="Summarized — hidden from the AI, replaced by summaries"
            data-tip="Summarized — hidden from the AI, replaced by summaries"
          >
            <EyeOff size={12} />
          </span>
        )}
      </div>
      {/* The bubble body has four exclusive states: a replace-mode stream
          painting this bubble live (the stored content steps aside for the
          growing stream text — empty at first, the message visibly clears —
          plus the blinking cursor, mirroring MessageList's live bubble), a
          continue-mode stream growing from the stored content's end (the
          chosen swipe plus the held deltas, same cursor), the inline editor,
          or the settled markdown. Guarded so exactly one renders: a live
          stream never paints the settled content underneath itself, the
          editor never paints alongside either stream, and a live run begun
          mid-edit simply wins the surface (the editor comes back, prefilled
          with the settled text, once the stream ends). */}
      {liveReplace && <LiveReplaceBody onLiveGrow={onLiveGrow} />}
      {liveContinue && <LiveContinueBody stored={settledContent} onLiveGrow={onLiveGrow} />}
      {!liveActive && !editing && (
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes prose and filters HTML-mode markup. */
        <div className="msg-bubble" dangerouslySetInnerHTML={{ __html: settledHtml }} />
      )}
      {!liveActive && editing && (
        // The editor swaps in for the bubble; a short rise makes the swap
        // read as the bubble reshaping rather than a hard cut. The ref-callback
        // still prefills and focuses on mount, so the entrance cannot race it.
        <motion.div
          className="msg-edit"
          initial={app.reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={app.reduce ? INSTANT : { ...app.transition, duration: app.duration.fast }}
        >
          <textarea
            ref={attachEditInput}
            className="msg-edit-input"
            rows={1}
            aria-label="Edit message text"
            onChange={autoGrowEdit}
            onKeyDown={(event) => {
              // Enter saves on a hardware keyboard; on a touch device it must insert
              // a newline (the Save button below is the exit, and it stays visible
              // while editing). Shift+Enter always inserts a newline.
              if (event.key === "Enter" && !event.shiftKey && !isTouchDevice()) {
                event.preventDefault();
                saveEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
            }}
          />
        </motion.div>
      )}
      {/* The action toolbar yields while either live stream owns the
          surface — the running stream's own controls take over. */}
      {!liveActive && !editing && (
        <div
          className="msg-actions"
          role="toolbar"
          aria-label="Message actions"
          ref={actionsRef}
          onKeyDown={onToolbarKeyDown}
        >
          {/* The swipe row: chevrons plus counter whenever there is anything
              to switch — and on the LAST assistant group also with a single
              variant, where it degenerates to one right chevron that
              generates the second swipe. */}
          {(group.variants.length > 1 || isLastAssistant) && (
            <span className="swipe-arrows">
              {group.variants.length > 1 && (
                <>
                  <motion.button
                    type="button"
                    className="btn-icon-mini"
                    tabIndex={-1}
                    aria-label="Previous swipe"
                    data-tip="Previous swipe"
                    whileTap={tap}
                    onClick={() => void runSwipe("previous")}
                  >
                    <ChevronLeft size={14} />
                  </motion.button>
                  <span className="swipe-count badge-text">
                    {activeIndex + 1}/{group.variants.length}
                  </span>
                </>
              )}
              <motion.button
                type="button"
                className="btn-icon-mini"
                tabIndex={-1}
                aria-label={nextTip}
                data-tip={nextTip}
                whileTap={tap}
                onClick={() => void runSwipe("next")}
              >
                <ChevronRight size={14} />
              </motion.button>
            </span>
          )}
          {/* The tracker snapshot attached to the shown swipe's row, when it
              has one — opens a read-only modal regardless of the tracker's
              enabled switch or injection settings. Absent while the row was
              never tracked, so the row stays uncluttered. */}
          {variant?.has_tracker && (
            <motion.button
              type="button"
              className="btn-icon-mini"
              tabIndex={-1}
              aria-label="View this swipe's tracker"
              data-tip="View tracker"
              whileTap={tap}
              onClick={() => setViewerOpen(true)}
            >
              <Radar size={14} />
            </motion.button>
          )}
          <motion.button
            type="button"
            className="btn-icon-mini"
            tabIndex={-1}
            aria-label="Copy message text"
            data-tip="Copy"
            whileTap={tap}
            onClick={() => void copy()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </motion.button>
          {/* Inline edit (see the edit section above): every message,
              either speaker, any position — a correction should not cost a
              resend. Hidden while a generation runs, like the other
              transcript-mutating controls. */}
          {!streaming && (
            <motion.button
              type="button"
              className="btn-icon-mini"
              tabIndex={-1}
              aria-label="Edit message text"
              data-tip="Edit"
              whileTap={tap}
              onClick={startEdit}
            >
              <Pencil size={14} />
            </motion.button>
          )}
          <motion.button
            type="button"
            className="btn-icon-mini"
            tabIndex={-1}
            aria-label="Fork chat from this message"
            data-tip="Fork from here"
            whileTap={tap}
            onClick={fork}
          >
            <GitFork size={14} />
          </motion.button>
          {/* Continue (SillyTavern's): extends this message in place instead
              of replacing or appending it. Gated like Regenerate — only while
              idle — plus canContinue, the store's own condition for an
              in-place edit: a chat ending in a user message has nothing to
              extend, so the button is hidden rather than misdescribed. A right
              arrow, as in ST. */}
          {canContinue && !streaming && (
            <motion.button
              type="button"
              className="btn-icon-mini"
              tabIndex={-1}
              aria-label="Continue the message"
              data-tip="Continue"
              whileTap={tap}
              onClick={() => continueMessage()}
            >
              <ArrowRight size={14} />
            </motion.button>
          )}
          {/* Bulk delete: the stack of messages from this one down. Layers
              stands in for the scissors — the icon set has neither Scissors
              nor ListX, and the stacked plates read as "the rest from
              here". Hidden on the first message (nothing to bulk-delete
              before it) and while a generation runs. */}
          {group.seq > 1 && !streaming && (
            <motion.button
              type="button"
              className="btn-icon-mini btn-icon-danger"
              tabIndex={-1}
              aria-label="Delete messages from here"
              data-tip="Delete from here"
              whileTap={tap}
              onClick={() => enterDeleteFrom(group.seq)}
            >
              <Layers size={14} />
            </motion.button>
          )}
          <motion.button
            type="button"
            className="btn-icon-mini btn-icon-danger"
            tabIndex={-1}
            aria-label="Delete message"
            data-tip="Delete"
            whileTap={tap}
            onClick={remove}
          >
            <Trash2 size={14} />
          </motion.button>
        </div>
      )}
      {/* While editing, the row trades the hover toolbar for a plain
          Save/Cancel pair — always shown (chat.css drops the hover gate
          under .msg-editing): an open editor must not hide its own exit.
          Only a live stream takes this pair away, exactly as before. */}
      {!liveActive && editing && (
        <div className="msg-actions">
          <motion.button
            type="button"
            className="btn"
            aria-label="Save the edited message"
            disabled={savingEdit}
            whileTap={tap}
            onClick={saveEdit}
          >
            Save
          </motion.button>
          <motion.button
            type="button"
            className="btn btn-ghost"
            aria-label="Discard the edits and leave edit mode"
            whileTap={tap}
            onClick={cancelEdit}
          >
            Cancel
          </motion.button>
        </div>
      )}
      {/* The viewer portals into <body>, so its place in the tree only gates
          when it mounts: only while the flag is set and a variant exists
          (a corrupted group has none). */}
      {viewerOpen && variant && (
        <MessageTrackerViewer messageId={variant.id} onClose={() => setViewerOpen(false)} />
      )}
    </motion.div>
  );
}

/** Memoized: a bubble re-renders only when its own props or its subscribed
 *  atoms change, never because a sibling (or a stream token) re-rendered. */
const MessageBubble = memo(MessageBubbleInner);
export default MessageBubble;
