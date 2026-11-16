/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { getSettings } from "../lib/api";
import type { ChatSummaryInfo, MessageGroup } from "../lib/api-chats";
import {
  activateMessage,
  addMessage,
  CHAT_PAGE_SIZE,
  createChat,
  deleteChat,
  deleteMessagesFrom,
  editMessage as editMessageApi,
  forkChat,
  getChat,
  listChats,
  listMessages,
  updateChat,
} from "../lib/api-chats";
import type { GenerateEvent, GenerateInput, SummaryInfo } from "../lib/api-generate";
import { listSummaries } from "../lib/api-generate";
import { getPersona } from "../lib/api-personas";
import type { ChatTrackerResponse } from "../lib/api-tracker";
import {
  deleteChatTracker,
  deleteMessageTracker as deleteMessageTrackerApi,
  generateChatTracker,
  getChatTracker,
  setChatTrackerEnabled as setChatTrackerEnabledApi,
} from "../lib/api-tracker";
import { setActiveVariantLocal } from "../lib/chat-groups";
import { mergeChatPages, nextChatPage } from "../lib/chat-paging";
import { rememberPersonaId } from "../lib/persona-preference";
import { streamGenerate } from "../lib/sse";
import { clearTrackerPresence, withTrackerPresence } from "../lib/tracker-presence";
import { chatHistoryAtom } from "./chat-history";
import { appStore } from "./store";
import { pushStreamText, resetStreamText, revealCompletion, setStreamText } from "./stream-reveal";

/** Token budget snapshot reported while a generation runs. */
export interface BudgetInfo {
  tokenCount: number;
  context: number;
  used: number;
  remaining: number;
}

/**
 * Granular state atoms — one per former module-level signal, so a component
 * can subscribe to just the slice it renders instead of the whole store.
 *
 * Naming: the signal's own name plus `Atom`, with a `chat` prefix on the
 * chat-domain slices whose bare name would be ambiguous outside this module
 * (`chatGroupsAtom`, `chatStreamingAtom`, `chatStreamTextAtom`,
 * `chatStreamModeAtom`, `chatSummariesAtom`, `chatTracker*Atom`,
 * `chatErrorAtom`). The rest keep the signal's name (`chatsAtom`,
 * `chatsLoadedAtom`, `chatIdAtom`, `budgetAtom`, …). `useChatStore()` still
 * returns every slice as a plain value alongside the action functions, for
 * callers that want the whole store at once.
 */
export const chatsAtom = atom<ChatSummaryInfo[]>([]);
// True once a chats fetch has settled (list swapped in or error raised).
// Module-level like the list it guards, it survives route remounts, so a
// revisit of the Chats view skips its skeletons instead of flashing them.
export const chatsLoadedAtom = atom(false);
// Unpaged server count for the current list query — the "Y" in the load-more
// footer's "Showing X of Y" and the end-of-list signal the pager reads.
export const chatsTotalAtom = atom(0);
// True while a follow-up page is in flight (guards concurrent load-more).
export const chatsLoadingMoreAtom = atom(false);
// True while another page can still be requested. Derived from the server row
// count, not chatsAtom.length, so the open chat's retained row never marks the
// list complete early.
export const chatsHasMoreAtom = atom(false);
export const chatIdAtom = atom<string | null>(null);
export const chatGroupsAtom = atom<MessageGroup[]>([]);
export const chatHasOlderAtom = atom(false);
// True while the open chat's transcript is being fetched. openChat arms it when
// it switches chats (and drops the previous chat's rows in the same tick, so the
// stale transcript never flashes before the new history lands); loadChatData
// clears it once that fetch settles (success or failure), so MessageList can hold
// its skeleton — never the empty state — until the history arrives. removeChat
// also clears it when it closes the open chat: nulling chatIdAtom defeats
// loadChatData's still-open guard, so without this the flag would latch true.
// Reset per open because, unlike the module-level chatsLoadedAtom it parallels,
// the transcript itself is per chat.
export const chatGroupsLoadingAtom = atom(false);
export const chatStreamingAtom = atom(false);
export const chatSendPendingAtom = atom(false);
// Chat the held stream text belongs to — keeps the live bubble (and a failed
// stream's kept partial) rendering only in its own chat.
export const streamingChatIdAtom = atom<string | null>(null);
export const chatStreamTextAtom = atom("");
/**
 * Boolean projection of the held stream text. A bubble only needs to know
 * *whether* text is held (a failed run keeps its partial on screen) to pick
 * its live surface — subscribing to the raw text atom would re-render every
 * bubble on every token. Jotai only notifies when this boolean actually
 * flips, so the transcript stays still while tokens flow into the live body.
 */
export const streamTextNonEmptyAtom = atom((get) => get(chatStreamTextAtom) !== "");
// How the running generation joins the transcript: "append" adds a new
// message at the bottom, "replace" swaps the last assistant message in
// place (a regenerate), "continue" extends that message in place (a
// continue — the live surface shows its stored content plus the deltas).
// Picked per run before streaming starts, so the live surface renders the
// right way from the first delta.
export const chatStreamModeAtom = atom<"append" | "replace" | "continue">("append");
// Ids of messages the server reported as persisted from the just-settled
// stream (the done event's message_id). The transcript's entrance
// choreography reads this to skip the rise-in animation for those groups:
// their content was already on screen through the live bubble, so
// animating the stored copy would replay an entrance the reader just
// watched. A run adds at most one id; the next run clears it (runGenerate)
// and another chat's open clears it too (openChat). It must survive the
// settle render itself — the transcript reads it a microtask after the
// groups update — so it is not dropped on settle, and a stale id can never
// suppress an unrelated entrance because message ids are unique.
export const settledVariantIdsAtom = atom<ReadonlySet<string>>(new Set<string>());
export const budgetAtom = atom<BudgetInfo | null>(null);
// Latest status stage of the running generation (preparing → prompt →
// summarizing → tracking) — drives the header's progress label; null while
// idle.
export const statusStageAtom = atom<"preparing" | "prompt" | "summarizing" | "tracking" | null>(
  null,
);
export const chatSummariesAtom = atom<SummaryInfo[]>([]);
// Tracker surface of the open chat: the GET/POST tracker payload (config
// flags, latest snapshot, rendering); null until the open fetch lands.
export const chatTrackerAtom = atom<ChatTrackerResponse | null>(null);
// True while a tracker snapshot is being generated — the SSE "tracking"
// stage of a running reply, or the panel's manual Generate action.
export const chatTrackerGeneratingAtom = atom(false);
// True while a summary is being generated — the SSE "summarizing" stage of a
// running reply, or the Summaries panel's manual "Summarize now".
export const chatSummarizingAtom = atom(false);
// Gentle ok:false notice from the generate stream (e.g. "No connection
// profile configured"). A tracker hiccup must never steal attention from
// the chat, so it surfaces inside the tracker panel only — never the
// shared error banner — and clears on the next ok or new generation.
export const chatTrackerNoticeAtom = atom<string | null>(null);
// Manual generate/delete failure message (the tracker panel's inline
// warning card), kept off the shared banner for the same reason.
export const chatTrackerErrorAtom = atom<string | null>(null);
export const memoryStrategyAtom = atom("trim");
// Display-only ghost-mark flag (settings.memory_config.summaries.
// mark_summarized): when on, transcript rows covered by summaries wear the
// eye-off chip. Read with the same settings hydration as memoryStrategy —
// one fetch per page load, defensively defaulted off.
export const markSummarizedAtom = atom(false);
export const chatErrorAtom = atom<string | null>(null);
// Persona of the open chat — the name labels outgoing messages, the avatar
// renders on user message bubbles; null while none is resolved (no persona,
// unknown chat row, or failed fetch).
export const personaNameAtom = atom<string | null>(null);
export const personaAvatarPathAtom = atom<string | null>(null);
// Bulk delete boundary: the seq a confirmed "delete from here" drops from
// (inclusive), or null while the mode is off. Entering it again with a new
// seq moves the boundary.
export const deleteFromSeqAtom = atom<number | null>(null);

// Aborts the in-flight generation; null while idle.
let controller: AbortController | null = null;
// True once the running generation reported the post-response summarization
// stage. The stage means the server may have stored new summary rows, so the
// settle refreshes the coverage list; a non-summaries strategy never sets it
// and pays no extra fetch.
let runSummarized = false;
let initialized = false;
// True while a delete-from run is in flight — performDeleteFrom overlaps
// are no-ops until it settles.
let deletingFrom = false;
// True while a per-message tracker delete is in flight — overlaps are
// no-ops until it settles, mirroring `deletingFrom`.
let deletingMessageTracker = false;
// Monotonic token for optimistic swipe activations: the newest activation
// wins, so a slow reconcile from an older swipe is dropped instead of
// overwriting the row the user just moved to.
let variantActivationSeq = 0;

// Server rows currently loaded across the chat list's pages. Tracked apart
// from chatsAtom because the displayed array may also hold the open chat's
// retained row (see refreshChats); feeding that back into the next page's
// offset would skip a real server row.
let chatsServerRowCount = 0;
// Bumped by every refreshChats. A load-more captures it before its request and
// drops the response if a refresh replaced the window meanwhile.
let chatsToken = 0;
// True while a page-0 refresh is airborne. loadMoreChats is inert during it:
// the refresh is about to replace the whole window, so appending at the old
// list's offset would mix two windows.
let chatsRefreshing = false;

// Last persona resolved for the open chat (id → name and avatar path).
// Memoizes the fetch so re-opening a chat keeps it at one persona request;
// a failed fetch leaves the cache untouched so the next open retries
// silently.
let personaCacheId: string | null = null;
let personaCacheName: string | null = null;
let personaCachePath: string | null = null;

// Settings promise shared for the store's lifetime (the memory strategy and
// ghost-mark hydration read it). A failed read is forgotten so a later open
// retries silently.
let settingsPromise: Promise<Record<string, unknown>> | null = null;

function fetchSettings(): Promise<Record<string, unknown>> {
  settingsPromise ??= getSettings().catch((err: unknown) => {
    settingsPromise = null;
    throw err;
  });
  return settingsPromise;
}

/**
 * True only for an explicit `summaries.mark_summarized: true` inside the
 * memory_config — anything malformed (missing keys, wrong types) means the
 * flag's default, off. The mark must never appear for a config the schema
 * would strip.
 */
function readMarkSummarized(memoryConfig: unknown): boolean {
  if (typeof memoryConfig !== "object" || memoryConfig === null) {
    return false;
  }
  const summaries = (memoryConfig as Record<string, unknown>).summaries;
  if (typeof summaries !== "object" || summaries === null) {
    return false;
  }
  return (summaries as Record<string, unknown>).mark_summarized === true;
}

function messageFrom(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : "Request failed";
}

/** Runs fn, routing any rejection to the shared error atom. Resolves
 *  with fn's value — undefined on failure, so the few callers that need
 *  to know (the inline editor keeps its draft when a save fails) can
 *  check. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    // Durable record in the browser console — the banner is dismissible
    // and otherwise leaves no trace of what went wrong.
    console.error("[chat]", err);
    appStore.set(chatErrorAtom, messageFrom(err));
    return undefined;
  }
}

function handleGenerateEvent(ev: GenerateEvent): void {
  if (ev.type === "delta") {
    appStore.set(chatStreamTextAtom, (text) => text + ev.content);
    // Feed the paced reveal that the live surfaces actually paint.
    pushStreamText(ev.content);
  } else if (ev.type === "error") {
    // Durable record in the browser console — the banner is dismissible
    // and otherwise leaves no trace of what went wrong.
    console.error("[generate]", ev.message);
    appStore.set(chatErrorAtom, ev.message);
  } else if (ev.type === "status") {
    appStore.set(statusStageAtom, ev.stage);
    // The dedicated summarizing pill tracks its own stage, and is cleared when
    // the stream ends (see the finally in runGenerate) rather than by any
    // later status: when the tail has work, it announces `summarizing` and
    // `tracking` together before either task starts, so a blanket
    // "clear on every other stage" would kill the pill the moment the
    // batch's second event landed.
    if (ev.stage === "summarizing") {
      appStore.set(chatSummarizingAtom, true);
      runSummarized = true;
    }
    if (ev.stage === "prompt") {
      appStore.set(budgetAtom, { tokenCount: ev.tokenCount, ...ev.budget });
    } else if (ev.stage === "tracking") {
      appStore.set(chatTrackerGeneratingAtom, true);
    }
  } else if (ev.type === "tracker") {
    // Scoped to the streamed chat like the done handler below: a snapshot
    // belongs to the chat it was generated for, never the one switched to.
    if (appStore.get(streamingChatIdAtom) === appStore.get(chatIdAtom)) {
      if (ev.ok) {
        // Flags the GET already resolved stay; only the snapshot/render move.
        // The SSE stage only runs for a chat whose switches are both on, so
        // `chat_enabled` defaults true when no payload loaded yet.
        appStore.set(chatTrackerAtom, (current) => ({
          enabled: true,
          chat_enabled: current?.chat_enabled ?? true,
          invisible: current?.invisible ?? false,
          mechanism: current?.mechanism ?? "suvoj-tracker",
          snapshot: ev.snapshot,
          render: ev.render,
        }));
        // The stream attached the snapshot to a specific row; flag it so that
        // swipe's hover action appears immediately, before the settle reload.
        const snapshotMessageId = ev.snapshot.message_id;
        if (snapshotMessageId != null) {
          appStore.set(chatGroupsAtom, (groups) =>
            withTrackerPresence(groups, snapshotMessageId, true),
          );
        }
        appStore.set(chatTrackerNoticeAtom, null);
      } else {
        appStore.set(chatTrackerNoticeAtom, ev.error);
      }
    }
    appStore.set(chatTrackerGeneratingAtom, false);
  } else if (ev.type === "done") {
    // A plugin's onResponse may have rewritten the reply after the raw
    // deltas already streamed out. Both live surfaces read streamText —
    // the append-mode trailing bubble and the replace-mode in-place bubble
    // — so swapping the accumulated deltas for the final content here
    // makes the upcoming swap to the persisted bubble seamless instead of
    // a content jump. Guarded by the same condition those surfaces render
    // under; without plugins the final content equals the accumulated
    // deltas, making this a no-op.
    //
    // Continue is exempt: its live surface renders `stored content +
    // streamText`, so assigning the merged content here would paint the
    // first half twice for one frame (the delta text is only the
    // continuation). Leaving the deltas alone keeps the live surface equal
    // to the settled content when nothing rewrote the reply; a plugin's
    // onResponse rewrite (the example plugin appends a signature) lands as a
    // one-frame content jump at settle instead — an acceptable wart append/
    // replace avoid by adopting ev.content. The settle below still swaps to
    // stored truth unconditionally.
    if (
      appStore.get(streamingChatIdAtom) === appStore.get(chatIdAtom) &&
      appStore.get(chatStreamModeAtom) !== "continue"
    ) {
      appStore.set(chatStreamTextAtom, ev.content);
      // Adopt the settled content as the reveal target too, so the paced
      // surfaces drain to exactly what will be persisted.
      setStreamText(ev.content);
    }
    // The persisted message joins the transcript a moment later, through
    // the post-stream reload below. Recording its id lets the entrance
    // choreography skip the rise-in for that group — a fresh animation on
    // content the reader just watched build up in the live bubble is the
    // end-of-generation flicker. (The transcript itself still reconciles
    // from the unconditional reload; this only steers the animation.)
    appStore.set(settledVariantIdsAtom, (ids) => new Set(ids).add(ev.message_id));
    // The server's post-response summarization runs BEFORE `done`, so its new
    // rows are already stored. Pull the coverage list now: the transcript's
    // ghost marks and an open Summaries drawer both read it, and nothing else
    // would tell them until the chat is reopened. Scoped to the open chat and
    // to a run that actually summarized — a trim-strategy run pays no fetch.
    if (runSummarized && appStore.get(streamingChatIdAtom) === appStore.get(chatIdAtom)) {
      void refreshSummaries();
    }
    runSummarized = false;
  }
}

let transcriptRequest = 0;

async function fetchTranscript(id: string): Promise<(() => void) | undefined> {
  if (appStore.get(chatIdAtom) !== id) {
    return;
  }
  const request = ++transcriptRequest;
  const from = appStore.get(chatGroupsAtom)[0]?.seq;
  const size = appStore.get(chatHistoryAtom).maxMessages;
  let groups = from === undefined ? [] : await listMessages(id, { from });
  const loadTail = groups.length === 0;
  if (loadTail) {
    groups = await listMessages(id, { limit: size + 1 });
  }
  return () => {
    if (request !== transcriptRequest || appStore.get(chatIdAtom) !== id) {
      return;
    }
    if (loadTail) {
      appStore.set(chatHasOlderAtom, groups.length > size);
      groups = groups.slice(-size);
    }
    // An older page can finish while this range is being refreshed. Keep
    // the prepended rows that lie outside the requested range.
    appStore.set(chatGroupsAtom, (current) =>
      loadTail ? groups : [...current.filter((group) => group.seq < (from ?? 1)), ...groups],
    );
  };
}

async function reloadTranscript(id: string): Promise<void> {
  (await fetchTranscript(id))?.();
}

export async function loadOlderMessages(): Promise<number> {
  const id = appStore.get(chatIdAtom);
  const groups = appStore.get(chatGroupsAtom);
  const before = groups[0]?.seq;
  if (id === null || before === undefined || !appStore.get(chatHasOlderAtom)) {
    return 0;
  }
  const request = transcriptRequest;
  const size = appStore.get(chatHistoryAtom).maxMessages;
  return (
    (await attempt(async () => {
      const page = await listMessages(id, { before, limit: size + 1 });
      if (
        request !== transcriptRequest ||
        appStore.get(chatIdAtom) !== id ||
        appStore.get(chatGroupsAtom)[0]?.seq !== before
      ) {
        return 0;
      }
      const older = page.slice(-size);
      appStore.set(chatHasOlderAtom, page.length > size);
      appStore.set(chatGroupsAtom, (current) => [...older, ...current]);
      return older.length;
    })) ?? 0
  );
}

/** Loads the messages and summaries of `id`, ignoring a lost open race. */
const loadChatData = (id: string) =>
  attempt(async () => {
    const [transcript, summaries] = await Promise.allSettled([
      fetchTranscript(id),
      listSummaries(id),
    ]);
    if (appStore.get(chatIdAtom) !== id) {
      return;
    }
    if (transcript.status === "fulfilled") {
      transcript.value?.();
    }
    if (summaries.status === "fulfilled") {
      appStore.set(chatSummariesAtom, summaries.value);
    }
    if (transcript.status === "rejected") throw transcript.reason;
    if (summaries.status === "rejected") throw summaries.reason;
  }).then(() => {
    // attempt never rejects (a failure lands in the shared error atom), so this
    // clears the transcript's loading state on success and failure alike. Only
    // the still-open chat clears it: a load superseded by a newer open (or a
    // delete that closed the chat) must not blank the skeleton of the chat
    // that is now loading.
    if (appStore.get(chatIdAtom) === id) {
      appStore.set(chatGroupsLoadingAtom, false);
    }
  });

/** Reloads the open chat's summary rows alone — the transcript keeps its
 *  groups. Called after the drawer's summarize/import actions so the
 *  coverage (and the ghost marks reading it) catches up; the delete flows
 *  already go through loadChatData, which refetches both. */
export const refreshSummaries = (): Promise<void> => {
  const id = appStore.get(chatIdAtom);
  if (id === null) {
    return Promise.resolve();
  }
  return attempt(async () => {
    const rows = await listSummaries(id);
    if (appStore.get(chatIdAtom) === id) {
      appStore.set(chatSummariesAtom, rows);
    }
  });
};

/**
 * Coverage predicate for the open chat's transcript: true iff some loaded
 * summary row (any level) spans `seq` — the positions the AI sees through
 * the summary block instead of verbatim. Range-based on purpose (not a
 * scalar frontier): a summary whose covering row died with a mid-range
 * deletion no longer hides its surviving positions. Derived from the same
 * fetch that feeds the transcript (loadChatData / refreshSummaries), so
 * the marks can never disagree with the rows on screen.
 */
const isSeqCovered = (seq: number): boolean =>
  appStore.get(chatSummariesAtom).some((row) => row.seq_from <= seq && seq <= row.seq_to);

/** Loads the open chat's tracker payload, ignoring a lost open race. */
export const refreshTracker = (id: string) =>
  attempt(async () => {
    const response = await getChatTracker(id);
    if (appStore.get(chatIdAtom) === id) {
      appStore.set(chatTrackerAtom, response);
    }
  });

export const refreshChats = (): Promise<void> => {
  const token = ++chatsToken;
  chatsRefreshing = true;
  return attempt(async () => {
    const page = await listChats({ limit: CHAT_PAGE_SIZE });
    // A newer refresh superseded this one while its page was airborne; the
    // newer response owns the window (and will clear the refreshing gate).
    if (token !== chatsToken) {
      return;
    }
    // INVARIANT: several components resolve the open chat's character identity
    // via `chats.find(row => row.id === chatId)`. Page 0 is only the newest
    // window, so an older open chat may sort past it — keep its prior row
    // rather than letting it vanish from the atom. The retained row is display
    // only: chatsServerRowCount counts the server rows alone, so it can never
    // skew the next page's offset.
    const openId = appStore.get(chatIdAtom);
    const current = appStore.get(chatsAtom);
    const items =
      openId === null || page.items.some((row) => row.id === openId)
        ? page.items
        : (() => {
            const prior = current.find((row) => row.id === openId);
            return prior === undefined ? page.items : [...page.items, prior];
          })();
    chatsServerRowCount = page.items.length;
    appStore.set(chatsAtom, items);
    appStore.set(chatsTotalAtom, page.total);
    appStore.set(
      chatsHasMoreAtom,
      nextChatPage(chatsServerRowCount, CHAT_PAGE_SIZE, page.total).hasMore,
    );
  }).then(() => {
    // Only the newest refresh opens the gate; a superseded one must not while
    // the newer request is still airborne.
    if (token === chatsToken) {
      chatsRefreshing = false;
    }
    // attempt() never rejects (a failed fetch lands in the shared error
    // atom), so this marks the fetch settled on success and failure alike.
    appStore.set(chatsLoadedAtom, true);
  });
};

/**
 * Appends the next server page to the loaded chat window. Inert while a
 * refresh or another append is in flight, or once every server row is loaded.
 * A page that comes back empty latches `chatsHasMoreAtom` off so the footer
 * can't loop on pages the server window no longer has.
 */
export const loadMoreChats = (): Promise<void> =>
  attempt(async () => {
    if (chatsRefreshing || appStore.get(chatsLoadingMoreAtom)) {
      return;
    }
    const { hasMore, limit, offset } = nextChatPage(
      chatsServerRowCount,
      CHAT_PAGE_SIZE,
      appStore.get(chatsTotalAtom),
    );
    if (!hasMore) {
      return;
    }
    const token = chatsToken;
    appStore.set(chatsLoadingMoreAtom, true);
    try {
      const page = await listChats({ limit, offset });
      // A refresh replaced the window while this page was airborne; appending
      // it now would mix two windows and corrupt the offset.
      if (token !== chatsToken) {
        return;
      }
      // Advance by the rows the server returned (not by the deduped display
      // count): each page occupies that many server positions.
      chatsServerRowCount += page.items.length;
      appStore.set(chatsAtom, mergeChatPages(appStore.get(chatsAtom), page.items));
      appStore.set(chatsTotalAtom, page.total);
      appStore.set(
        chatsHasMoreAtom,
        // An empty page means the offset window ran out (e.g. a deletion
        // shifted the boundary); latch off instead of re-requesting forever.
        page.items.length > 0 &&
          nextChatPage(chatsServerRowCount, CHAT_PAGE_SIZE, page.total).hasMore,
      );
    } finally {
      appStore.set(chatsLoadingMoreAtom, false);
    }
  });

/** Resolves the persona of the chat being opened (`id`) — its name (labels
 *  outgoing messages) and avatar (user message bubbles). The chat row comes
 *  from the shared list when present, with a direct fetch fallback for rows
 *  the list doesn't know yet (a fresh fork, opened before its refresh
 *  lands). A chat's persona comes solely from its own `persona_id`; a
 *  persona-less chat resolves to null — messages keep the server's default
 *  name and letter avatar. Failures are silent, and a lost race (the user
 *  switched away again) never writes a stale persona into the new chat. */
const loadPersonaInfo = async (id: string): Promise<void> => {
  const chat =
    appStore.get(chatsAtom).find((row) => row.id === id) ?? (await getChat(id).catch(() => null));
  const personaId = chat?.persona_id ?? null;
  if (personaId !== null && personaId !== personaCacheId) {
    try {
      const persona = await getPersona(personaId);
      personaCacheId = personaId;
      personaCacheName = persona.name;
      personaCachePath = persona.avatar_path;
    } catch {
      return; // uncached, so a later open retries; this one stays null
    }
  }
  if (appStore.get(chatIdAtom) === id) {
    appStore.set(personaNameAtom, personaId === null ? null : personaCacheName);
    appStore.set(personaAvatarPathAtom, personaId === null ? null : personaCachePath);
  }
};

export const openChat = (id: string) =>
  attempt(async () => {
    // Arm the transcript skeleton only when switching chats: a re-open of the
    // chat already on screen keeps its rows rather than blinking a placeholder
    // over them. On a switch, drop the outgoing chat's rows in the same tick so
    // the stale transcript can never flash — the skeleton shows until the new
    // history lands. loadChatData clears the flag once it settles.
    if (appStore.get(chatIdAtom) !== id) {
      appStore.set(chatGroupsLoadingAtom, true);
      appStore.set(chatGroupsAtom, []);
      appStore.set(chatHasOlderAtom, false);
    }
    appStore.set(chatIdAtom, id);
    if (!appStore.get(chatSendPendingAtom)) {
      appStore.set(chatStreamTextAtom, "");
      resetStreamText();
    }
    appStore.set(budgetAtom, null);
    appStore.set(chatErrorAtom, null);
    // A delete-from boundary belongs to the chat it was set in — it never
    // carries across an open.
    appStore.set(deleteFromSeqAtom, null);
    // Same for a settled-stream id: the incoming chat's history staggers in
    // from zero by design, and an id left over from the previous chat's run
    // would leave one of those groups mysteriously still.
    appStore.set(settledVariantIdsAtom, new Set<string>());
    // Cleared now, resolved alongside the chat data so a slow fetch never
    // leaks the previous chat's persona onto the new one's user bubbles.
    appStore.set(personaNameAtom, null);
    appStore.set(personaAvatarPathAtom, null);
    // The tracker surface resets the same way — the chat being opened owns
    // its snapshot, notice, and error state, and a stale generating flag
    // from the previous chat's run must not spin the new one's button.
    appStore.set(chatTrackerAtom, null);
    appStore.set(chatTrackerNoticeAtom, null);
    appStore.set(chatTrackerErrorAtom, null);
    appStore.set(chatTrackerGeneratingAtom, false);
    // ...and the summarizing pill, so a stale flag from the previous chat's
    // run never spins the new one.
    appStore.set(chatSummarizingAtom, false);
    void refreshTracker(id);
    void loadPersonaInfo(id);
    await loadChatData(id);
  });

/** Creates a chat with `characterId` (plus optional persona), refreshes the
 *  list, and opens it. Resolves with the new chat id, or null when creation
 *  failed — the shared error atom carries the message either way. */
export const newChat = async (characterId: string, personaId?: string): Promise<string | null> => {
  try {
    const result = await createChat({ character_id: characterId, persona_id: personaId });
    // A new chat makes its persona the one the next new chat starts from. An
    // omitted persona is a no-op, so the previous memory is kept.
    rememberPersonaId(personaId ?? null);
    await refreshChats();
    await openChat(result.chat.id);
    return result.chat.id;
  } catch (err) {
    // Durable record in the browser console — the banner is dismissible
    // and otherwise leaves no trace of what went wrong.
    console.error("[chat]", err);
    appStore.set(chatErrorAtom, messageFrom(err));
    return null;
  }
};

/** Switches the open chat's persona (`null` clears it), then re-resolves the
 *  chat's persona info. The list refresh lands before the reload so the
 *  chat row lookup inside it already sees the new persona_id. */
export const setChatPersona = (personaId: string | null): Promise<void> =>
  attempt(async () => {
    const id = appStore.get(chatIdAtom);
    if (id === null) {
      return;
    }
    await updateChat(id, { persona_id: personaId });
    // Remember the pick for the next new chat; a null clear is a no-op by
    // design (see persona-preference), so clearing this chat never forgets.
    rememberPersonaId(personaId);
    // Dropped up front — the reload below resolves the new persona, but its
    // fetch shouldn't keep painting the old one on the chat meanwhile.
    appStore.set(personaNameAtom, null);
    appStore.set(personaAvatarPathAtom, null);
    await refreshChats();
    await loadPersonaInfo(id);
  });

async function withSendOperation(operation: (id: string) => Promise<void>): Promise<void> {
  const id = appStore.get(chatIdAtom);
  if (id === null || appStore.get(chatSendPendingAtom) || appStore.get(chatGroupsLoadingAtom)) {
    return;
  }
  appStore.set(chatSendPendingAtom, true);
  try {
    await attempt(async () => {
      try {
        await operation(id);
      } catch (err) {
        if (appStore.get(chatIdAtom) === id) {
          throw err;
        }
        console.error("[chat]", err);
      }
    });
  } finally {
    appStore.set(chatSendPendingAtom, false);
  }
}

async function runGenerate(id: string, input: GenerateInput): Promise<void> {
  // How the run joins the transcript, picked before the run starts so the
  // live surface renders the right way from the first delta. Regenerate and
  // continue are both in-place edits of the trailing assistant message, so
  // both are gated on that message being an assistant one — the client
  // mirrors the server's append fallback, keeping the live surface and the
  // persisted row in agreement when the last message is a user/system one.
  // Regenerate wins when both flags are set, matching the server's
  // precedence (see generate-helpers.ts).
  const list = appStore.get(chatIdAtom) === id ? appStore.get(chatGroupsAtom) : [];
  const lastAssistant = list[list.length - 1]?.role === "assistant";
  appStore.set(
    chatStreamModeAtom,
    input.regenerate === true && lastAssistant
      ? "replace"
      : input.continue === true && lastAssistant
        ? "continue"
        : "append",
  );
  const run = new AbortController();
  controller = run;
  appStore.set(chatStreamingAtom, true);
  appStore.set(streamingChatIdAtom, id);
  // A new run starts from a clean slate. The previous run's settled id has
  // already kept its own group from replaying an entrance, and it must not
  // outlive the next run (which records its own id on `done`). The id from
  // THIS run stays until then on purpose: clearing it right after the settle
  // reload raced the transcript render (React applies the group update a
  // microtask later than the store set), so the persisted bubble re-armed its
  // entrance and faded in again after the stream — the end-of-generation
  // flicker the id exists to prevent.
  appStore.set(settledVariantIdsAtom, new Set<string>());
  // ...and so is the previous run's summarization bookkeeping: this run's
  // `summarizing` stage arms it again if the server summarizes.
  runSummarized = false;
  appStore.set(chatStreamTextAtom, "");
  resetStreamText();
  appStore.set(statusStageAtom, null);
  if (appStore.get(chatIdAtom) === id) {
    appStore.set(budgetAtom, null);
    appStore.set(chatErrorAtom, null);
    appStore.set(chatTrackerNoticeAtom, null);
  }
  let failed = false;
  try {
    await streamGenerate(id, input, {
      signal: run.signal,
      onEvent: (event) => {
        if (event.type === "error") {
          failed = true;
        }
        if (appStore.get(chatIdAtom) === id || event.type === "delta") {
          handleGenerateEvent(event);
        }
      },
    });
  } catch (err) {
    // stop() aborts the fetch — not an error; the server kept what it kept.
    if (!(err instanceof Error && err.name === "AbortError")) {
      // Durable record in the browser console — the banner is dismissible
      // and otherwise leaves no trace of what went wrong.
      console.error("[generate]", err);
      failed = true;
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatErrorAtom, messageFrom(err));
      }
    }
  } finally {
    controller = null;
    appStore.set(chatStreamingAtom, false);
    appStore.set(statusStageAtom, null);
    // The stream's tracking stage set this; its tracker event normally
    // clears it, but an abort mid-tracking ends the stream without one —
    // drop the flag here so the panel never spins forever.
    appStore.set(chatTrackerGeneratingAtom, false);
    // Same for the summarizing pill: an abort mid-summarize ends the stream
    // without a later stage to clear it.
    appStore.set(chatSummarizingAtom, false);
    if (appStore.get(chatIdAtom) === id) {
      // Let a paced reveal finish painting the tail BEFORE the transcript
      // reloads: the groups update and the held text clear run back-to-back
      // below (so no frame renders both the live and the settled bubble), and
      // draining first keeps a smooth style from popping the un-typed
      // remainder into view at the settle. Instant styles resolve at once.
      await revealCompletion();
      // Reconcile from server truth on every settle, success or failure:
      // groups land before the held stream text clears (nothing flashes),
      // and a failed run still picks up anything persisted on the way down
      // (e.g. summaries written while the prompt was being assembled).
      await loadChatData(id);
      // The done-event id is deliberately NOT dropped here: the transcript's
      // entrance memo reads it during React's render of the groups set above,
      // and a clear in this same run of microtasks can beat that render (see
      // the run-start clear). It stays until the next run replaces it.
      if (!failed || appStore.get(chatIdAtom) !== id) {
        // Clean settle (done or aborted) drops the held text HERE, before
        // the chats refresh: the groups update above and this clear run
        // back-to-back in one rendering task (microtask continuations
        // never paint), so the persisted bubble replaces the live one
        // with no frame rendering both. refreshChats is a network
        // round-trip — with the clear parked behind it, the browser
        // painted that duplicated frame. A failure keeps the partial
        // visible next to the error banner, scoped to its chat by
        // streamingChatId, until the next send/regenerate/open clears it.
        appStore.set(chatStreamTextAtom, "");
        resetStreamText();
        appStore.set(streamingChatIdAtom, null);
      }
    } else {
      // The run outlived its chat (deleted mid-stream) — the live bubble
      // was never showing, being scoped to the open chat — but the held
      // text still drops so nothing stale rides along.
      appStore.set(chatStreamTextAtom, "");
      resetStreamText();
      appStore.set(streamingChatIdAtom, null);
    }
    void refreshChats();
  }
}

/**
 * Sends the draft as a user message, then generates a reply. An EMPTY draft
 * (SillyTavern's empty send) skips the user turn and generates directly, so
 * the character speaks on its own — no empty message row is ever stored.
 */
export const sendMessage = (content: string, onAccepted?: () => void) =>
  withSendOperation(async (id) => {
    if (content.trim() !== "") {
      const message = await addMessage(id, {
        role: "user",
        content,
        name: appStore.get(personaNameAtom) ?? undefined,
      });
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatGroupsAtom, (groups) => [
          ...groups.filter((group) => group.seq !== message.seq),
          {
            seq: message.seq,
            role: message.role,
            name: message.name,
            active_id: message.id,
            variants: [{ ...message, has_tracker: false }],
          },
        ]);
      }
    }
    onAccepted?.();
    await runGenerate(id, {});
  });

export const regenerate = () => withSendOperation((id) => runGenerate(id, { regenerate: true }));
// The server appends when the trailing position is not an assistant message.
export const continueMessage = () => withSendOperation((id) => runGenerate(id, { continue: true }));
export const stop = () => controller?.abort();

export const activateVariant = (messageId: string) =>
  attempt(async () => {
    const id = appStore.get(chatIdAtom);
    // Monotonic token: a newer activation supersedes this one, so a late
    // reconcile from an older swipe can never overwrite the newer active row.
    const token = ++variantActivationSeq;
    // Flip the active swipe locally FIRST so the row can slide to fresh content
    // without waiting on the network (MessageBubble fires this without awaiting).
    if (id !== null) {
      appStore.set(chatGroupsAtom, setActiveVariantLocal(appStore.get(chatGroupsAtom), messageId));
    }
    try {
      await activateMessage(messageId);
      if (id !== null && token === variantActivationSeq && appStore.get(chatIdAtom) === id) {
        await reloadTranscript(id);
        // A tracker snapshot is attached to the swipe row, so switching
        // variants swaps which snapshot the panel shows (and the server
        // injects). Refresh it alongside the transcript.
        await refreshTracker(id);
      }
    } catch (err) {
      // Persist failed: the optimistic flip is wrong — restore server truth.
      // Only when this is still the newest activation for the still-open chat.
      if (id !== null && token === variantActivationSeq && appStore.get(chatIdAtom) === id) {
        try {
          await reloadTranscript(id);
        } catch {
          // keep current
        }
      }
      throw err;
    }
  });

/** Rewrites one swipe's text in place — any role, the chosen variant only
 *  (an edit targets the message on screen, never its hidden siblings) —
 *  then repaints the transcript from server truth. Resolves false when the
 *  request failed; the shared error banner reports why, and the inline
 *  editor stays open so the draft is not lost. */
export const editMessage = (messageId: string, content: string): Promise<boolean> =>
  attempt(async () => {
    const id = appStore.get(chatIdAtom);
    await editMessageApi(messageId, content);
    if (id !== null) {
      await reloadTranscript(id);
    }
    return true;
  }).then((ok) => ok === true);

export const forkFrom = (messageId: string) =>
  attempt(async () => {
    const id = appStore.get(chatIdAtom);
    if (id === null) {
      return;
    }
    const result = await forkChat(id, messageId);
    await openChat(result.id);
    await refreshChats();
  });

export const removeChat = (id: string) =>
  attempt(async () => {
    await deleteChat(id);
    if (appStore.get(chatIdAtom) === id) {
      appStore.set(chatIdAtom, null);
      // A load still in flight for this chat would clear the flag in
      // loadChatData's still-open guard, but that guard now reads null (the id
      // just cleared) and skips — so clear it here alongside the chat id.
      appStore.set(chatGroupsLoadingAtom, false);
    }
    await refreshChats();
  });

/** Enters delete-from mode at `seq` — or, while already in it, moves the
 *  boundary there. */
export const enterDeleteFrom = (seq: number): void => {
  appStore.set(deleteFromSeqAtom, seq);
};

/** Leaves delete-from mode without deleting anything. */
export const cancelDeleteFrom = (): void => {
  appStore.set(deleteFromSeqAtom, null);
};

/** Runs the pending delete-from: drops the boundary message and everything
 *  after it, reconciles from server truth, then leaves the mode. A confirm
 *  with no open chat, no boundary set, a running stream, or another
 *  delete-from in flight is a no-op. */
export const performDeleteFrom = (): Promise<void> =>
  attempt(async () => {
    const id = appStore.get(chatIdAtom);
    const seq = appStore.get(deleteFromSeqAtom);
    if (deletingFrom || id === null || seq === null || appStore.get(chatSendPendingAtom)) {
      return;
    }
    deletingFrom = true;
    try {
      await deleteMessagesFrom(id, seq);
      await loadChatData(id);
      // The tracker payload is keyed per message and survives the transcript
      // reload, so without this the drawer would keep rendering a snapshot
      // for a message that no longer exists (and its trash icon would target
      // a dead id). refreshTracker's own lost-open guard drops a raced result.
      await refreshTracker(id);
      await refreshChats();
      appStore.set(deleteFromSeqAtom, null);
    } finally {
      deletingFrom = false;
    }
  });

/** Marks the summarization indicator on/off for the Summaries panel's manual
 *  "Summarize now". The SSE "summarizing" stage flips the same atom from
 *  handleGenerateEvent, so both triggers share the one indicator. */
export function setSummarizing(value: boolean): void {
  appStore.set(chatSummarizingAtom, value);
}

/** Runs one manual tracker generation for the open chat (the panel's
 *  Generate/Regenerate action). Failures land on the panel's inline error
 *  surface, not the shared banner — a tracker hiccup must not steal
 *  attention from the chat. Concurrent runs (manual or the SSE stage) are
 *  no-ops while one is in flight. */
export const generateTracker = (): Promise<void> => {
  const id = appStore.get(chatIdAtom);
  if (id === null || appStore.get(chatTrackerGeneratingAtom)) {
    return Promise.resolve();
  }
  appStore.set(chatTrackerGeneratingAtom, true);
  appStore.set(chatTrackerErrorAtom, null);
  appStore.set(chatTrackerNoticeAtom, null);
  return generateChatTracker(id)
    .then((response) => {
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerAtom, response);
        // The fresh snapshot names the row it landed on; flag it so the hover
        // action appears without waiting for a transcript reload.
        const messageId = response.snapshot?.message_id;
        if (messageId != null) {
          appStore.set(chatGroupsAtom, (groups) => withTrackerPresence(groups, messageId, true));
        }
      }
    })
    .catch((err: unknown) => {
      // Durable record in the browser console — the warning card is
      // dismissible and otherwise leaves no trace of what went wrong.
      console.error("[tracker]", err);
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerErrorAtom, messageFrom(err));
      }
    })
    .finally(() => {
      appStore.set(chatTrackerGeneratingAtom, false);
    });
};

/** Flips the open chat's own tracker switch (the panel's toggle) — the global
 *  master lives in Settings → Tracker and is unaffected. Optimistically
 *  updates the payload so the switch and the disabled body react at once, then
 *  reconciles with server truth. A failure reverts the flip and lands on the
 *  panel's inline error surface. */
export const setChatTrackerEnabled = (enabled: boolean): Promise<void> => {
  const id = appStore.get(chatIdAtom);
  if (id === null) {
    return Promise.resolve();
  }
  appStore.set(chatTrackerErrorAtom, null);
  appStore.set(chatTrackerAtom, (current) =>
    current === null ? current : { ...current, chat_enabled: enabled },
  );
  return setChatTrackerEnabledApi(id, enabled)
    .then((response) => {
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerAtom, response);
      }
    })
    .catch((err: unknown) => {
      // Durable record in the browser console — the warning card is
      // dismissible and otherwise leaves no trace of what went wrong.
      console.error("[tracker]", err);
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerAtom, (current) =>
          current === null ? current : { ...current, chat_enabled: !enabled },
        );
        appStore.set(chatTrackerErrorAtom, messageFrom(err));
      }
    });
};

/** Clears every tracker in the open chat — all messages and swipes (the
 *  panel's Clear all action), returning the surface to its empty state. */
export const clearAllTrackers = (): Promise<void> => {
  const id = appStore.get(chatIdAtom);
  if (id === null) {
    return Promise.resolve();
  }
  return deleteChatTracker(id)
    .then(() => {
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerAtom, (current) =>
          current === null ? current : { ...current, snapshot: null },
        );
        // Every row's snapshot is gone; clear the whole transcript's flags so
        // no hover action lingers.
        appStore.set(chatGroupsAtom, (groups) => clearTrackerPresence(groups));
      }
    })
    .catch((err: unknown) => {
      // Durable record in the browser console — the warning card is
      // dismissible and otherwise leaves no trace of what went wrong.
      console.error("[tracker]", err);
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerErrorAtom, messageFrom(err));
      }
    });
};

/** Drops the tracker attached to one message/swipe row (the panel's
 *  per-message Delete action), leaving other swipes' trackers alone. The
 *  shared payload is only reconciled when the row on screen is the one just
 *  deleted — removing a hidden swipe must not disturb the visible panel.
 *  Overlapping deletes are no-ops. A DELETE failure lands on the panel's
 *  inline error surface (`chatTrackerErrorAtom`); the follow-up
 *  `refreshTracker` failure is routed by `attempt` to the shared chat error
 *  banner. */
export const deleteMessageTracker = (messageId: string): Promise<void> => {
  if (deletingMessageTracker) {
    return Promise.resolve();
  }
  const id = appStore.get(chatIdAtom);
  if (id === null) {
    return Promise.resolve();
  }
  deletingMessageTracker = true;
  return deleteMessageTrackerApi(messageId)
    .then(async () => {
      if (appStore.get(chatIdAtom) !== id) {
        return;
      }
      // The row's snapshots are gone server-side; clear its flag so the hover
      // action disappears — even when the deleted row was a hidden swipe, the
      // panel payload for the visible row is untouched below.
      appStore.set(chatGroupsAtom, (groups) => withTrackerPresence(groups, messageId, false));
      const current = appStore.get(chatTrackerAtom);
      if (current?.snapshot?.message_id !== messageId) {
        // The deleted row was not the one on screen — leave the visible
        // payload exactly as it is.
        return;
      }
      // The deleted row's tracker WAS the one shown, but the summary falls
      // back to the NEWEST selected-swipe tracker across the remaining
      // positions: an older position's snapshot can still be what the AI is
      // fed. Re-read server truth instead of blanking optimistically, so the
      // panel never reads "empty" while a tracker is actually injected.
      await refreshTracker(id);
    })
    .catch((err: unknown) => {
      // Durable record in the browser console — the warning card is
      // dismissible and otherwise leaves no trace of what went wrong.
      console.error("[tracker]", err);
      if (appStore.get(chatIdAtom) === id) {
        appStore.set(chatTrackerErrorAtom, messageFrom(err));
      }
    })
    .finally(() => {
      deletingMessageTracker = false;
    });
};

/** Dismisses the stream's ok:false notice shown inside the tracker panel. */
export const clearTrackerNotice = (): void => {
  appStore.set(chatTrackerNoticeAtom, null);
};

/** Reads the open chat's memory settings once per page load. Safe to call
 *  repeatedly; idempotent. Kept as a boot call so it no longer depends on a
 *  component happening to call useChatStore(). */
export function hydrateChatStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  fetchSettings()
    .then((settings) => {
      const strategy = settings.memory_strategy;
      if (typeof strategy === "string" && strategy !== "") {
        appStore.set(memoryStrategyAtom, strategy);
      }
      appStore.set(markSummarizedAtom, readMarkSummarized(settings.memory_config));
    })
    .catch(() => {});
}

/**
 * Chat store. The module-level atoms make it a singleton: every component
 * calling useChatStore() shares one open chat, one stream, one error
 * surface, and the open chat's persona (name and avatar). The memory
 * strategy and the ghost-mark flag are hydrated from settings once per page
 * load (see {@link hydrateChatStore}, called at app boot). The returned
 * values are plain snapshots; components that only need one slice can
 * subscribe to the granular atoms directly.
 */
export function useChatStore() {
  hydrateChatStore();

  return {
    chats: useAtomValue(chatsAtom),
    chatsLoaded: useAtomValue(chatsLoadedAtom),
    chatsTotal: useAtomValue(chatsTotalAtom),
    chatsHasMore: useAtomValue(chatsHasMoreAtom),
    chatsLoadingMore: useAtomValue(chatsLoadingMoreAtom),
    chatId: useAtomValue(chatIdAtom),
    groups: useAtomValue(chatGroupsAtom),
    streaming: useAtomValue(chatStreamingAtom),
    streamingChatId: useAtomValue(streamingChatIdAtom),
    streamText: useAtomValue(chatStreamTextAtom),
    streamMode: useAtomValue(chatStreamModeAtom),
    settledVariantIds: useAtomValue(settledVariantIdsAtom),
    budget: useAtomValue(budgetAtom),
    statusStage: useAtomValue(statusStageAtom),
    summaries: useAtomValue(chatSummariesAtom),
    isSeqCovered,
    markSummarized: useAtomValue(markSummarizedAtom),
    tracker: useAtomValue(chatTrackerAtom),
    trackerGenerating: useAtomValue(chatTrackerGeneratingAtom),
    summarizing: useAtomValue(chatSummarizingAtom),
    trackerNotice: useAtomValue(chatTrackerNoticeAtom),
    trackerError: useAtomValue(chatTrackerErrorAtom),
    memoryStrategy: useAtomValue(memoryStrategyAtom),
    error: useAtomValue(chatErrorAtom),
    personaName: useAtomValue(personaNameAtom),
    personaAvatarPath: useAtomValue(personaAvatarPathAtom),
    deleteFromSeq: useAtomValue(deleteFromSeqAtom),
    refreshChats,
    loadMoreChats,
    refreshSummaries,
    openChat,
    newChat,
    setChatPersona,
    sendMessage,
    regenerate,
    continueMessage,
    stop,
    activateVariant,
    editMessage,
    forkFrom,
    removeChat,
    enterDeleteFrom,
    cancelDeleteFrom,
    performDeleteFrom,
    refreshTracker,
    generateTracker,
    setSummarizing,
    setChatTrackerEnabled,
    clearAllTrackers,
    deleteMessageTracker,
    clearTrackerNotice,
  };
}

/**
 * The store's action functions, with NONE of {@link useChatStore}'s value
 * subscriptions. `useChatStore()` eagerly subscribes to every slice —
 * including the per-token `chatStreamTextAtom` — so a hot component (the
 * chat header) that reads granular atoms for state would still re-render on
 * every stream delta if it called the hook just to fire an action. These are
 * the same module-level closures the hook returns, so the two surfaces can
 * never drift.
 */
export const chatActions = {
  refreshChats,
  loadMoreChats,
  refreshSummaries,
  openChat,
  newChat,
  setChatPersona,
  sendMessage,
  regenerate,
  continueMessage,
  stop,
  activateVariant,
  editMessage,
  forkFrom,
  removeChat,
  enterDeleteFrom,
  cancelDeleteFrom,
  performDeleteFrom,
  refreshTracker,
  generateTracker,
  setSummarizing,
  setChatTrackerEnabled,
  clearAllTrackers,
  deleteMessageTracker,
  clearTrackerNotice,
};
