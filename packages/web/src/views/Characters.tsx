/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import CharacterGrid from "../components/characters/CharacterGrid";
import GalleryManager from "../components/characters/GalleryManager";
import ImportExport from "../components/characters/ImportExport";
import PurgeUnused from "../components/characters/PurgeUnused";
import MobileNavButton from "../components/MobileNavButton";
import { Plus, TriangleAlert, Upload, WandSparkles } from "../components/ui/icons";
import type { CharacterListItem, CharacterListPage, CharacterSort } from "../lib/api-characters";
import { listCharacters } from "../lib/api-characters";
import { charactersViewPageSize } from "../lib/character-paging";
import { getCharacterSort, rememberCharacterSort } from "../lib/character-sort-preference";
import { pageCount } from "../lib/pagination";
import { useIsMobile } from "../lib/use-viewport";
import { appStore } from "../stores/store";
import "../styles/views.css";

/** How long the search input waits for the user to stop typing before it
 *  syncs the ?search= param — and the server fetch it drives. */
const SEARCH_DEBOUNCE_MS = 250;

// Module scope — the router unmounts this view on every navigation, which
// would otherwise drop the fetched grid and replay the skeleton on each
// revisit. Only the *unfiltered* first page is cached (a filtered result, or a
// deeper page, depends on its ?search=/tag inputs), so a plain revisit renders
// instantly from cache while a background refresh revalidates
// (stale-while-revalidate). Jotai atoms stand in for the Solid module signals:
// the same survive-remount singleton, readable/writable from module code.
const allCharactersCacheAtom = atom<CharacterListItem[]>([]);
// The unfiltered `total` that came with the cached first page, so the
// "Showing X of Y" caption is correct on a cached revisit instead of claiming
// the page length is the whole cast.
const allCharactersCacheTotalAtom = atom(0);
// The distinct-tag facet that came with the cached first page, so the filter
// chips are complete on a cached revisit instead of showing only tags that
// happen to be on the cached page.
const allCharactersCacheTagsAtom = atom<string[]>([]);
// The order the cached first page was built under. The cache is only reused
// when it matches the order about to be rendered, so a grid is never painted
// with rows from one order while the toolbar claims another (the stale-while-
// revalidate read below would otherwise show the wrong sequence until the
// background refresh lands). Defaults to the server's historical `name` order.
const allCharactersCacheSortAtom = atom<CharacterSort>("name");
// True only after a *successful* unfiltered fetch — a failed first load
// leaves it false so the next mount retries the full skeleton flow instead
// of trusting nothing as cache.
const charactersCacheLoadedAtom = atom(false);

/** The Characters management screen: toolbar, paged grid, and the modal tools. */
export default function Characters() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The selected tag filter: a character must carry ALL of them (AND), so each
  // added chip narrows the list. Empty means no tag filter.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Page size follows the viewport: fewer cards per page on a phone. It is a
  // reset input — a resize across the breakpoint restarts at page 1 — so it
  // joins the refresh dependency set below.
  const isMobile = useIsMobile();
  const pageSize = charactersViewPageSize(isMobile);

  const allCharactersCache = useAtomValue(allCharactersCacheAtom);
  const allCharactersCacheTotal = useAtomValue(allCharactersCacheTotalAtom);
  const allCharactersCacheTags = useAtomValue(allCharactersCacheTagsAtom);
  const allCharactersCacheSort = useAtomValue(allCharactersCacheSortAtom);
  const charactersCacheLoaded = useAtomValue(charactersCacheLoadedAtom);

  // The user's ordering choice, seeded from the remembered preference so this
  // page and the New Chat modal open in the same order.
  const [sort, setSort] = useState<CharacterSort>(() => getCharacterSort());

  // React Router's get() returns the first occurrence, matching the Solid
  // code's array-aware read (first entry).
  const search = searchParams.get("search") ?? "";

  // Hydrate from the module cache only for the plain, unfiltered visit —
  // entering with a live ?search= param (or a selected tag, though tags never
  // persist across mounts) can't reuse the unfiltered cache, so it falls back
  // to the skeleton flow. The cache must also have been built under the current
  // order, or the cached rows would paint in the wrong sequence. Evaluated at
  // setup, before the first render, so a matching cached grid paints
  // immediately with no skeleton flash.
  const fromCache =
    charactersCacheLoaded &&
    search === "" &&
    selectedTags.length === 0 &&
    allCharactersCacheSort === sort;
  const [characters, setCharacters] = useState<CharacterListItem[]>(() =>
    fromCache ? allCharactersCache : [],
  );
  // Unpaged match count for the current query, reported by the server so the
  // grid can stop at the end and caption "showing X of Y".
  const [total, setTotal] = useState(() => (fromCache ? allCharactersCacheTotal : 0));
  // Distinct-tag facet for the current filters (ignoring paging), so the chips
  // offer tags that only occur beyond the loaded first page.
  const [tags, setTags] = useState<string[]>(() => (fromCache ? allCharactersCacheTags : []));
  // Per-mount loading: a cached mount starts loaded (no skeleton), a first
  // mount runs the skeleton flow. A filter change or a background revalidate
  // never flips this back to true — that's what keeps them silent, and what
  // makes this the *first-load* skeleton flag rather than a per-page one.
  const [loading, setLoading] = useState(() => !fromCache);
  // 1-based page the loaded rows belong to. A filter/order/size change resets
  // it to 1 up front (refresh); a nav jump commits it only once the page lands.
  const [page, setPage] = useState(1);
  // True while ANY page fetch is airborne — the footer nav disables both
  // buttons on it, so a jump can't be issued on top of one already in flight.
  const [busy, setBusy] = useState(false);
  // A failed fetch — the first load, or a page jump — replaces the grid with
  // this message; every later successful fetch clears it, so a filter/order
  // change (or a mutation's reload) is the way back.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [galleryCharacter, setGalleryCharacter] = useState<CharacterListItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);

  // The raw input value keeps typing responsive; the URL param — and with
  // it the fetch — settles once the user pauses for the debounce window.
  const [searchInput, setSearchInput] = useState(() => search);
  const searchTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimerRef.current), []);

  // Guards against out-of-order responses: every page fetch bumps the token,
  // and a stale response (an older filter, or a jump racing the query change
  // that already reset the list) is dropped on arrival.
  const requestTokenRef = useRef(0);
  // Mirrors `busy` synchronously. The nav's handlers are events, not render, so
  // they must read the flag that updates without React's lag: a double click
  // (or a mutation landing in the same tick) must not slip a second fetch past
  // the state's late update.
  const busyRef = useRef(false);

  /** The single page-fetch path, shared by every entry point (refresh, jump,
   *  reload). `mode` decides how the response lands:
   *
   *   - "reset" — a fresh ?search=/tag/order/size: page 1 at offset 0, with
   *     `page` committed optimistically so the nav reflects the target while
   *     the request is airborne (mirroring the core's reset).
   *   - "jump" — a prev/next, or a post-mutation reload: the current rows stay
   *     mounted, `busy` flags the nav, and `page` is committed only on success,
   *     so a failed request leaves the old page (and its rows) in place. */
  const requestPage = useCallback(
    (target: number, mode: "reset" | "jump"): void => {
      const token = ++requestTokenRef.current;
      // Only the plain, unfiltered visit belongs in the module cache. Captured
      // before the fetch: the tag selection or search may change mid-flight.
      const unfiltered = selectedTags.length === 0 && search === "";
      if (mode === "reset") {
        setPage(1);
      }
      busyRef.current = true;
      setBusy(true);

      /** Requests the server window for a 1-based page at the current size. */
      const fetchAt = (pageToLoad: number) =>
        listCharacters({
          tags: selectedTags.length > 0 ? selectedTags : undefined,
          search: search || undefined,
          sort,
          limit: pageSize,
          offset: (pageToLoad - 1) * pageSize,
        });

      /** Paints a landed page, and revalidates the module cache when unfiltered. */
      const commit = (landed: number, response: CharacterListPage): void => {
        setCharacters(response.items);
        setTotal(response.total);
        setTags(response.tags);
        // Only a page-1 ("reset") landing may seed the module cache: a jump to
        // a deeper page would otherwise store pages 2+ as if they were page 1,
        // and the next revisit would hydrate the grid with the wrong rows. The
        // cache is also unfiltered-only — a filtered result depends on its
        // ?search=/tag inputs, which the cache key does not carry.
        if (mode === "reset" && unfiltered) {
          appStore.set(allCharactersCacheAtom, response.items);
          appStore.set(allCharactersCacheTotalAtom, response.total);
          appStore.set(allCharactersCacheTagsAtom, response.tags);
          appStore.set(allCharactersCacheSortAtom, sort);
          appStore.set(charactersCacheLoadedAtom, true);
        }
        if (mode === "jump") {
          setPage(landed);
        }
        setLoadError(null);
      };

      fetchAt(target)
        .then((response) => {
          if (token !== requestTokenRef.current) {
            return;
          }
          const lastPage = pageCount(response.total, pageSize);
          // The window can shift under a page number that was valid when it was
          // requested: a delete/gallery/import on another surface shrinks the
          // cast, and the server then answers with zero rows even though
          // matches remain. Re-ask for the last page that still exists instead
          // of committing an empty screen. One retry suffices — `total > 0`
          // guarantees that page has rows.
          if (response.items.length === 0 && response.total > 0 && target > lastPage) {
            return fetchAt(lastPage).then((retry) => {
              if (token === requestTokenRef.current) {
                commit(lastPage, retry);
              }
            });
          }
          commit(target, response);
          return undefined;
        })
        .catch((err: unknown) => {
          if (token !== requestTokenRef.current) {
            return;
          }
          setLoadError(err instanceof Error ? err.message : "Failed to load characters");
        })
        .finally(() => {
          if (token === requestTokenRef.current) {
            busyRef.current = false;
            setBusy(false);
            setLoading(false);
          }
        });
    },
    [selectedTags, search, sort, pageSize],
  );

  /** Reloads page 1 for the current ?search=, tags, order, and page size. Each of
   *  those is a reset input; {@link requestPage}'s identity already tracks
   *  exactly them, so this callback (and hence the mount effect below) re-runs —
   *  and the list restarts at page 1 — whenever any changes, including a
   *  viewport-driven page-size flip. */
  const refresh = useCallback((): void => {
    requestPage(1, "reset");
  }, [requestPage]);

  /** Jumps to a 1-based page, clamped to the range that currently exists. A
   *  repeat of the current page, or any jump while a fetch is airborne, is a
   *  no-op so the nav cannot queue redundant requests. */
  const goToPage = (target: number): void => {
    if (busyRef.current) {
      return;
    }
    const clamped = Math.min(Math.max(1, target), pageCount(total, pageSize));
    if (clamped === page) {
      return;
    }
    requestPage(clamped, "jump");
  };

  /** Re-fetches the page the user is on — clamped to the range that now exists —
   *  after a mutation (editor save, gallery, import, purge), so their place
   *  survives it. Unlike a nav jump this always requests, even when the clamp
   *  lands back on the current page, because the point is to pull the mutated
   *  rows. */
  const reload = (): void => {
    requestPage(Math.min(Math.max(1, page), pageCount(total, pageSize)), "jump");
  };

  // Tracks the settled ?search= param, the tag filter, the order, AND the page
  // size, so all four drive refetches. A change to any of them resets to page 1.
  // refresh's identity changes exactly when those four do (it is keyed on
  // requestPage, whose deps are exactly them), so the effect is the Solid
  // createEffect's dependency set.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSearch = (value: string): void => {
    setSearchInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === "") {
            next.delete("search");
          } else {
            next.set("search", value);
          }
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
  };

  /** Opening a card hands the whole editing flow to the studio route, so the
   *  full-card fetch, draft, and save all live in one place. */
  const openInStudio = (character: CharacterListItem): void => {
    navigate(`/characters/studio/${character.id}`);
  };
  const createInStudio = (): void => {
    navigate("/characters/studio/new");
  };

  return (
    <section className="stack page">
      <div className="page-header">
        <MobileNavButton />
        <div className="page-heading">
          <h1>Characters</h1>
          <p className="caption page-desc">
            Build your cast — open any card in Character Studio, or import a card to get started.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn studio-launch"
            onClick={() => navigate("/characters/studio")}
            data-tip="Open Character Studio"
          >
            <WandSparkles size={16} />
            Character Studio
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={createInStudio}
            data-tip="Create a character"
          >
            <Plus size={16} />
            New character
          </button>
          <button type="button" className="btn" onClick={() => setTransferOpen(true)}>
            <Upload size={16} />
            Import
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setPurgeOpen(true)}>
            <TriangleAlert size={16} />
            Purge unused
          </button>
        </div>
      </div>

      {loadError === null ? (
        <CharacterGrid
          characters={characters}
          tagOptions={tags}
          loading={loading}
          page={page}
          pageSize={pageSize}
          busy={busy}
          total={total}
          search={searchInput}
          onSearch={onSearch}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          sort={sort}
          onSort={(next) => {
            setSort(next);
            rememberCharacterSort(next);
          }}
          onOpen={openInStudio}
          onCreate={createInStudio}
          onGallery={setGalleryCharacter}
          onChanged={reload}
          onPrev={() => goToPage(page - 1)}
          onNext={() => goToPage(page + 1)}
        />
      ) : (
        <p className="error-banner" role="alert">
          {loadError}
        </p>
      )}
      {galleryCharacter !== null && (
        <GalleryManager
          character={galleryCharacter}
          onClose={() => setGalleryCharacter(null)}
          onChanged={reload}
        />
      )}
      {transferOpen && <ImportExport onClose={() => setTransferOpen(false)} onChanged={reload} />}
      {purgeOpen && <PurgeUnused onClose={() => setPurgeOpen(false)} onChanged={reload} />}
    </section>
  );
}
