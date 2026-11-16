/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CharacterListItem, CharacterSort } from "./api-characters";
import { CHARACTER_PAGE_SIZE, listCharacters } from "./api-characters";
import { pageCount } from "./pagination";

/** How long a picker's search box waits for a pause before it hits the server. */
export const CHARACTER_SEARCH_DEBOUNCE_MS = 250;

/**
 * Discrete page sizes for the page-by-page pickers: fewer tiles per page on a
 * phone, a fuller grid on desktop. {@link characterPickerPageSize} maps the
 * breakpoint so both pickers derive the same number from the viewport.
 */
export const CHARACTER_PAGE_SIZE_MOBILE = 5;
export const CHARACTER_PAGE_SIZE_DESKTOP = 20;

/** The page size a page-mode picker should use at the given breakpoint. */
export function characterPickerPageSize(isMobile: boolean): number {
  return isMobile ? CHARACTER_PAGE_SIZE_MOBILE : CHARACTER_PAGE_SIZE_DESKTOP;
}

/**
 * Discrete page sizes for the Characters management screen. Kept separate from
 * the picker sizes above because that screen lays out full cards (not picker
 * tiles), so its page fill is tuned on its own; {@link charactersViewPageSize}
 * maps the breakpoint so the screen derives its number from the viewport the
 * same way the pickers do.
 */
export const CHARACTERS_VIEW_PAGE_SIZE_MOBILE = 5;
export const CHARACTERS_VIEW_PAGE_SIZE_DESKTOP = 10;

/** The page size the Characters management screen should use at the given
 *  breakpoint. */
export function charactersViewPageSize(isMobile: boolean): number {
  return isMobile ? CHARACTERS_VIEW_PAGE_SIZE_MOBILE : CHARACTERS_VIEW_PAGE_SIZE_DESKTOP;
}

// `setTimeout`'s handle type is ambient and divergent in this program (the DOM
// returns a number, Bun/Node return an object), while `clearTimeout` resolves
// to the DOM signature. The handle is opaque to us — it is only ever handed
// back to the matching clear call — so bridge the two ambient typings with one
// assertion instead of threading the mismatch through every call site.
function clearTimer(handle: ReturnType<typeof setTimeout> | undefined): void {
  if (handle !== undefined) {
    clearTimeout(handle as unknown as number);
  }
}

/**
 * Appends `incoming` to `existing`, skipping ids already present. A refetch
 * that overlaps what is already rendered (or a racing search reset) can then
 * never duplicate a tile.
 *
 * The id-dedup is also what makes the offset window visible: pages are
 * requested at `offset = items.length`, so a row deleted before the boundary
 * shifts every later row up by one and the next page skips it (the dedup only
 * hides duplicates, it cannot recover the skipped row). A skip can therefore
 * leave `items.length < total` even after every page has been fetched; the
 * `reachedEnd` guard in {@link createCharacterPagerCore} stops the resulting
 * empty-page loop, and a refresh/reload (which restarts from offset 0)
 * recovers the row.
 */
export function mergeCharacterPages(
  existing: CharacterListItem[],
  incoming: CharacterListItem[],
): CharacterListItem[] {
  const seen = new Set(existing.map((character) => character.id));
  return existing.concat(incoming.filter((character) => !seen.has(character.id)));
}

/** The reactive slice a picker renders. Plain values (no accessors): the core
 *  caches one immutable object so React can diff it by identity. */
export interface CharacterPagerState {
  /** Rows loaded so far (across pages). */
  items: CharacterListItem[];
  /** Unpaged match count for the committed search. */
  total: number;
  /** True while a page-0 fetch is in flight AND nothing is on screen yet.
   *  A search refetch keeps the previously loaded rows visible and leaves this
   *  false, so the UI never flashes a skeleton over results it already has. */
  loading: boolean;
  /** True while a follow-up page is in flight. */
  loadingMore: boolean;
  /** Last fetch failure (null when the latest request succeeded). */
  error: string | null;
  /** True when another page can still be requested. */
  hasMore: boolean;
  /** 1-based page the loaded rows belong to. Always 1 in append mode, where
   *  the window only ever grows. */
  page: number;
  /** Rows requested per page in the current mode. Fixed at mount in append
   *  mode; page mode's {@link CharacterPagerActions.setPageSize} can change it. */
  pageSize: number;
  /** Raw search input value (updates immediately, unlike the fetch it drives). */
  search: string;
  /** The order the displayed rows belong to. Changing it restarts paging at
   *  offset 0, so it always matches the last page-0 request, not a pending one. */
  sort: CharacterSort;
  /** The query the displayed rows belong to (the last committed search). Unlike
   *  {@link CharacterPagerState.search}, this lags the input by the debounce, so
   *  a consumer can tell "still filtering" from "genuinely empty" without
   *  unmounting its input. */
  committed: string;
}

/** The actions a picker/select needs; all are stable across renders. */
export interface CharacterPagerActions {
  /** Feeds the search input; the server fetch settles after the debounce. */
  onSearch: (value: string) => void;
  /** Switches the ordering and refetches page 0; a no-op for the current one. */
  setSort: (sort: CharacterSort) => void;
  /** Requests the next page (no-op at the end or while another is in flight).
   *  Append mode only; a no-op in pages mode, which navigates by page. */
  loadMore: () => void;
  /** Jumps to a 1-based page, clamped to the range that exists. Pages mode
   *  only; a no-op in append mode. */
  goToPage: (page: number) => void;
  /** `goToPage(page + 1)` — a no-op on the last page or in append mode. */
  nextPage: () => void;
  /** `goToPage(page - 1)` — a no-op on page 1 or in append mode. */
  prevPage: () => void;
  /** Switches the page size and refetches page 1. A no-op when unchanged or in
   *  append mode, whose size is fixed at mount. */
  setPageSize: (size: number) => void;
  /** Re-fetches page 0 for the current committed query (used after a mutation). */
  reload: () => void;
  /** Inserts or replaces a row locally — keeps a just-imported character visible
   *  in a select even if it sorts beyond the loaded page. */
  upsert: (character: CharacterListItem) => void;
}

/**
 * Framework-free paging state machine. It owns the debounce, page appends,
 * stale-response guard, and end-of-list latch; {@link useCharacterPager} is a
 * thin React binding over it. Keeping the state machine React-free lets the
 * paging math be unit-tested without a DOM.
 */
export interface CharacterPagerCore extends CharacterPagerActions {
  /** Current immutable render snapshot. */
  getState: () => CharacterPagerState;
  /** Subscribes a listener; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Runs the initial page-0 fetch when created with `autoload: true`. */
  start: () => void;
  /** Stops the debounce and invalidates any in-flight response. */
  dispose: () => void;
}

/**
 * How a pager presents its rows: `"append"` grows one long list via
 * {@link CharacterPagerActions.loadMore}; `"pages"` shows a single page and
 * navigates with {@link CharacterPagerActions.goToPage} and friends.
 */
export type CharacterPagerMode = "append" | "pages";

export function createCharacterPagerCore(options?: {
  pageSize?: number;
  debounceMs?: number;
  /** Initial ordering. Defaults to `"name"`, the historical picker order, so
   *  callers that don't opt in keep their existing behavior. */
  initialSort?: CharacterSort;
  /** When false, the caller drives the first load via {@link CharacterPagerActions.reload}. */
  autoload?: boolean;
  /** Paging strategy. Defaults to `"append"` so every existing caller keeps its
   *  infinite-scroll behavior byte-for-byte. */
  mode?: CharacterPagerMode;
}): CharacterPagerCore {
  const mode = options?.mode ?? "append";
  // `pageSize` is `let` (not the usual fixed const) because pages mode can
  // resize it at runtime; append mode never touches it after creation.
  let pageSize = options?.pageSize ?? CHARACTER_PAGE_SIZE;
  const debounceMs = options?.debounceMs ?? CHARACTER_SEARCH_DEBOUNCE_MS;
  const autoload = options?.autoload !== false;

  let snapshot: CharacterPagerState = {
    items: [],
    total: 0,
    loading: autoload,
    loadingMore: false,
    error: null,
    hasMore: false,
    page: 1,
    pageSize,
    search: "",
    sort: options?.initialSort ?? "name",
    committed: "",
  };
  const listeners = new Set<() => void>();

  // The committed query is what requests actually send; `search` is the live
  // input value. The token guards every response so a slow page from a
  // previous query cannot overwrite the current one.
  let query = "";
  let requestToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  // True while a page-0 fetch is airborne. `loading` cannot stand in for this:
  // a search refetch keeps `loading` false when rows are already on screen, yet
  // a load-more fired during that window would request the new query at the old
  // list's offset and mix the two results.
  let pendingPage0 = false;
  // Set when an appended page returned zero NEW rows (all duplicates, or an
  // empty page). Offset paging can land there after a deletion shifted the
  // window; without this the Load-more button would re-request the same empty
  // page forever. Reset on every page-0 fetch (a fresh query).
  let reachedEnd = false;
  let started = false;

  /** Applies a partial snapshot, recomputes `hasMore`, and notifies listeners. */
  const update = (patch: Partial<CharacterPagerState>): void => {
    const next = { ...snapshot, ...patch };
    // `hasMore` is an append-mode concept: pages mode navigates with explicit
    // page controls, so it always reports false there.
    next.hasMore = mode === "append" && !reachedEnd && next.items.length < next.total;
    snapshot = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const failure = (err: unknown): string =>
    err instanceof Error ? err.message : "Failed to load characters";

  // How a fetch relates to the visible window:
  // - "reset"  — a fresh query/order/size: page 1 at offset 0. Rows are kept
  //   mounted and replaced on landing (skeleton only on the empty→filled
  //   transition). Append mode's only non-append path.
  // - "append" — append mode's Load-more: appends to the visible window.
  // - "jump"   — pages-mode navigation: keeps the current rows mounted, flags
  //   `loadingMore` as busy, and commits `page` only once the response lands, so
  //   a failed jump keeps the old page.
  type PageRequest = "reset" | "append" | "jump";

  const fetchPage = (offset: number, kind: PageRequest, targetPage: number): void => {
    const token = ++requestToken;
    if (kind === "reset") {
      pendingPage0 = true;
      // A fresh page-1 query resets the end-of-list latch: the rows below are
      // about to be replaced. `page` moves to 1 immediately so the pages nav
      // reflects the target while the response is airborne.
      reachedEnd = false;
      // Only the empty→filled transition shows the skeleton. A search refetch
      // keeps the current rows mounted, so it must not flip `loading` on and
      // blank them out (which would also unmount the search input itself).
      const patch: Partial<CharacterPagerState> =
        snapshot.items.length === 0 ? { loading: true, page: 1 } : { page: 1 };
      // A pages-mode reset abandons any in-flight jump; clear its busy flag now,
      // since the stale jump's `finally` bails on the request token and would
      // otherwise leave the nav permanently disabled.
      if (mode === "pages") {
        patch.loadingMore = false;
      }
      update(patch);
    } else {
      // Both Load-more and a page jump keep the current rows visible while they
      // are airborne; `loadingMore` doubles as the "busy" flag the pages nav
      // disables its buttons on.
      update({ loadingMore: true });
    }
    // Offset paging window: `offset` is the *rendered* count in append mode, so
    // a deletion before the boundary shifts rows up and this request skips one.
    // The merge dedups overlaps but cannot recover a skip; a refresh recovers
    // it, and the zero-new-rows latch below stops an infinite empty-page loop.
    listCharacters({
      search: query === "" ? undefined : query,
      sort: snapshot.sort,
      limit: pageSize,
      offset: offset === 0 ? undefined : offset,
    })
      .then((page) => {
        if (token !== requestToken) {
          return;
        }
        if (kind === "append") {
          const current = snapshot.items;
          const merged = mergeCharacterPages(current, page.items);
          // No new ids on an append means the window has run out; latch so
          // hasMore stops offering pages that will keep returning nothing.
          if (merged.length === current.length) {
            reachedEnd = true;
          }
          update({ items: merged });
        } else if (kind === "jump") {
          // A jump REPLACES the window and commits its page only now, on
          // success; the catch path below leaves the old page (and rows) intact.
          update({ items: page.items, page: targetPage });
        } else {
          update({ items: page.items });
        }
        update({ total: page.total, error: null });
      })
      .catch((err: unknown) => {
        if (token !== requestToken) {
          return;
        }
        update({ error: failure(err) });
      })
      .finally(() => {
        if (token !== requestToken) {
          return;
        }
        if (kind === "reset") {
          pendingPage0 = false;
          update({ loading: false });
        } else {
          update({ loadingMore: false });
        }
      });
  };

  const onSearch = (value: string): void => {
    update({ search: value });
    clearTimer(searchTimer);
    searchTimer = setTimeout(() => {
      query = value.trim();
      update({ committed: query });
      // No local clear: the old rows stay visible until the new page arrives,
      // so a search refetch never flashes a skeleton over loaded results.
      fetchPage(0, "reset", 1);
    }, debounceMs);
  };

  const loadMore = (): void => {
    // Pages mode navigates with explicit page controls; there is no window to
    // grow, so Load-more is inert there.
    if (mode !== "append") {
      return;
    }
    if (
      pendingPage0 ||
      snapshot.loadingMore ||
      reachedEnd ||
      snapshot.items.length >= snapshot.total
    ) {
      return;
    }
    fetchPage(snapshot.items.length, "append", snapshot.page);
  };

  const reload = (): void => {
    clearTimer(searchTimer);
    query = snapshot.search.trim();
    update({ committed: query });
    fetchPage(0, "reset", 1);
  };

  const setSort = (sort: CharacterSort): void => {
    if (sort === snapshot.sort) {
      return;
    }
    // Switching order restarts paging at offset 0, so flush any pending search
    // debounce and the live input first — the same commit `reload` performs —
    // rather than letting a timer from the old order fire mid-refresh.
    clearTimer(searchTimer);
    query = snapshot.search.trim();
    update({ sort, committed: query });
    fetchPage(0, "reset", 1);
  };

  const goToPage = (target: number): void => {
    if (mode !== "pages") {
      return;
    }
    // `pageCount` treats an empty list as page 1, so the clamp also bounds a
    // jump issued before the first page has landed.
    const lastPage = pageCount(snapshot.total, pageSize);
    const page = Math.min(Math.max(1, target), lastPage);
    // Ignore a repeat of the current page and any jump while another fetch is
    // airborne (a reset or a prior jump): the request token would drop a
    // racing response anyway, but refusing up front keeps the busy nav honest
    // and avoids a pointless request.
    if (page === snapshot.page || pendingPage0 || snapshot.loadingMore) {
      return;
    }
    fetchPage((page - 1) * pageSize, "jump", page);
  };

  const nextPage = (): void => goToPage(snapshot.page + 1);
  const prevPage = (): void => goToPage(snapshot.page - 1);

  const setPageSize = (size: number): void => {
    // Append mode's size is fixed at mount; only pages mode can resize.
    if (mode !== "pages" || size === pageSize || size < 1) {
      return;
    }
    pageSize = size;
    // Resizing restarts at page 1: page N of the old size is a different window
    // than page N of the new one, so keeping the number would show the wrong
    // rows.
    update({ pageSize: size, page: 1 });
    fetchPage(0, "reset", 1);
  };

  const upsert = (character: CharacterListItem): void => {
    const current = snapshot.items;
    const index = current.findIndex((item) => item.id === character.id);
    if (index === -1) {
      update({ items: [character, ...current] });
    } else {
      update({ items: current.map((item) => (item.id === character.id ? character : item)) });
    }
  };

  return {
    getState: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (autoload && !started) {
        started = true;
        fetchPage(0, "reset", 1);
      }
    },
    dispose: () => {
      clearTimer(searchTimer);
      // Bump the token so an in-flight response is discarded instead of
      // notifying a listener set that no longer exists.
      requestToken++;
      listeners.clear();
      // Reset the one-way start latch. dispose() just invalidated any
      // in-flight page-0 response, so under StrictMode's setup→cleanup→setup
      // the second setup MUST re-issue the initial page; otherwise `loading`
      // (set by that discarded fetch) stays true and the skeleton hangs
      // forever. A real unmount never calls start() again, so this is inert
      // there.
      started = false;
    },
    onSearch,
    setSort,
    loadMore,
    goToPage,
    nextPage,
    prevPage,
    setPageSize,
    reload,
    upsert,
  };
}

/** Paged character list state plus the actions a picker/select needs. Every
 *  field is a plain value; {@link useCharacterPager} owns the fetching. */
export type CharacterPager = CharacterPagerState & CharacterPagerActions;

/**
 * React binding for {@link createCharacterPagerCore}. Each consumer gets its
 * own core (state is per picker, not global) and the core owns the debounce,
 * paging, and stale-response guard. `autoload: false` skips the mount fetch so a
 * caller can defer it (the lorebook editor only loads the character list for an
 * existing book).
 *
 * Every option is mount-time configuration EXCEPT `pageSize`: pickers derive it
 * reactively from the viewport (see {@link characterPickerPageSize}), so a
 * resize across the breakpoint resizes the core in place.
 */
export function useCharacterPager(options?: {
  pageSize?: number;
  debounceMs?: number;
  /** Initial ordering; see {@link createCharacterPagerCore}. */
  initialSort?: CharacterSort;
  /** When false, the caller drives the first load via {@link CharacterPager.reload}. */
  autoload?: boolean;
  /** Paging strategy; see {@link createCharacterPagerCore}. */
  mode?: CharacterPagerMode;
}): CharacterPager {
  // The core is created once per mounted picker; other option changes are
  // ignored, so the initializer must run only on the first render.
  const [core] = useState(() => createCharacterPagerCore(options));

  // `pageSize` is the ONE reactive option. Destructuring the primitive keeps the
  // dependency stable across renders; the effect is inert on mount (the core was
  // born with this size, so `setPageSize` sees no change) and whenever a re-render
  // passes the same size. Append mode ignores it, as its core no-ops.
  const { pageSize } = options ?? {};
  useEffect(() => {
    if (pageSize !== undefined) {
      core.setPageSize(pageSize);
    }
  }, [core, pageSize]);

  useEffect(() => {
    core.start();
    return () => core.dispose();
  }, [core]);

  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  return {
    ...state,
    onSearch: core.onSearch,
    setSort: core.setSort,
    loadMore: core.loadMore,
    goToPage: core.goToPage,
    nextPage: core.nextPage,
    prevPage: core.prevPage,
    setPageSize: core.setPageSize,
    reload: core.reload,
    upsert: core.upsert,
  };
}
