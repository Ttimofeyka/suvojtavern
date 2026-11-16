/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LorebookEditor from "../components/lorebooks/LorebookEditor";
import LorebookList from "../components/lorebooks/LorebookList";
import MobileNavButton from "../components/MobileNavButton";
import { Plus, TriangleAlert, Upload } from "../components/ui/icons";
import type { Lorebook, LorebookDetail } from "../lib/api-lorebooks";
import {
  deleteLorebook,
  getLorebook,
  importLorebook,
  listLorebooks,
  setLorebookGlobal,
} from "../lib/api-lorebooks";
import { mergeRowsById } from "../lib/row-merge";
import { appStore } from "../stores/store";

// Module scope — the router unmounts this view on every navigation, which
// would otherwise drop the fetched list and replay the skeleton on each
// revisit. These Jotai atoms live in the shared module store, so they survive
// the unmount: a revisit renders instantly from cache while a background
// refresh revalidates (stale-while-revalidate). The list is reconciled by id,
// not swapped wholesale — see `mergeRowsById` in lib/row-merge: a refresh
// returns fresh row objects, and replacing the array would make every card a
// new element (replaying its entrance animation and dropping the Global
// switch's focus). The optimistic flip in toggleGlobal composes with it: only
// the toggled row becomes a fresh object, the rest keep their identity.
const lorebooksAtom = atom<Lorebook[]>([]);
// True only after a *successful* fetch — a failed first load leaves it false
// so the next mount retries the full skeleton flow instead of trusting
// nothing as cache.
const lorebooksLoadedAtom = atom(false);
/** Entry counts per lorebook id — filled opportunistically from the detail
 *  route. Cached module-level so the count pills don't pop in late on
 *  revisits; unknown ids are still fetched lazily on every refresh. */
const countsAtom = atom<Record<string, number>>({});
/** Ids whose cached count is known to be out of date. Kept alongside the
 *  value (rather than deleted) so the pill shows its last known number while
 *  the refetch is in flight instead of blinking out. */
const staleCounts = new Set<string>();

/** Marks a book's cached entry count stale. The cache only ever grows
 *  otherwise (loadCounts skips known ids), which would leave the count pill
 *  stale forever after entries change. */
const invalidateCount = (id: string): void => {
  staleCounts.add(id);
};

/** Fetches the entry count of each lorebook not counted yet (or marked
 *  stale); failures just skip the pill and leave it stale for a retry.
 *  Module-level and atom-read through `appStore`: it runs from async
 *  continuations, so it must see the live cache rather than a render's copy. */
const loadCounts = (items: Lorebook[]): void => {
  const known = appStore.get(countsAtom);
  for (const item of items) {
    if (item.id in known && !staleCounts.has(item.id)) {
      continue;
    }
    getLorebook(item.id)
      .then((detail) => {
        staleCounts.delete(item.id);
        appStore.set(countsAtom, (prev) => ({ ...prev, [item.id]: detail.entries.length }));
      })
      .catch(() => {});
  }
};

/** Lorebooks management: list, create/import, and edit via modals. */
export default function Lorebooks() {
  const lorebooks = useAtomValue(lorebooksAtom);
  const lorebooksLoaded = useAtomValue(lorebooksLoadedAtom);
  const counts = useAtomValue(countsAtom);
  // Per-mount loading: a cached mount starts loaded (no skeleton), a first
  // mount runs the skeleton flow. The background revalidate never flips this
  // back to true — that's what makes it silent. The lazy initializer captures
  // the settled flag once, at setup.
  const [loading, setLoading] = useState(() => !lorebooksLoaded);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Id of the book whose detail fetch is in flight (the card shows a spinner
   *  so a click has visible feedback until the editor opens). */
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** Book open in the editor; null while closed OR drafting a new one. */
  const [editing, setEditing] = useState<LorebookDetail | null>(null);
  // Separate from `editing` because null means "new draft", not "closed": a
  // single nullable state could not tell the two apart. Mirrors Presets.
  const [editorOpen, setEditorOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const fail = useCallback(
    (fallback: string) =>
      (err: unknown): void => {
        setError(err instanceof Error ? err.message : fallback);
      },
    [],
  );

  const refresh = useCallback((): void => {
    listLorebooks()
      .then((items) => {
        // mergeRowsById (not a plain swap) keeps unchanged rows' identity, so
        // a revalidate after a close repaints only fields that actually moved.
        appStore.set(lorebooksAtom, (prev) => mergeRowsById(prev, items));
        appStore.set(lorebooksLoadedAtom, true);
        setError(null);
        // A deleted book can never come back, so its stale marker would pin a
        // dead id (and its counts entry) in the module-level cache for the
        // rest of the session. Prune against the fresh list; the counts value
        // itself is harmless to keep — lookups only ever use present ids.
        const present = new Set(items.map((item) => item.id));
        for (const id of staleCounts) {
          if (!present.has(id)) {
            staleCounts.delete(id);
          }
        }
        loadCounts(items);
      })
      .catch(fail("Failed to load lorebooks"))
      .finally(() => setLoading(false));
  }, [fail]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Client-side name/description filter over the loaded list. */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return lorebooks;
    }
    return lorebooks.filter(
      (lorebook) =>
        lorebook.name.toLowerCase().includes(q) || lorebook.description.toLowerCase().includes(q),
    );
  }, [lorebooks, query]);

  /** Optimistically flips the book's global (every-chat) flag; reverts with
   *  the error banner on failure (the pattern the old Settings panel used). */
  const toggleGlobal = (lorebook: Lorebook, enabled: boolean): void => {
    const flip = (value: boolean): void => {
      appStore.set(lorebooksAtom, (prev) =>
        prev.map((row) => (row.id === lorebook.id ? { ...row, global: value } : row)),
      );
    };
    flip(enabled);
    setLorebookGlobal(lorebook.id, enabled).catch(() => {
      flip(!enabled);
      setError(`Failed to ${enabled ? "enable" : "disable"} "${lorebook.name}" globally`);
    });
  };

  const openDetail = (id: string): void => {
    // One open at a time: the busy card already shows the click landed, and a
    // second click would race two details into the same `editing` slot.
    if (openingId !== null) {
      return;
    }
    setOpeningId(id);
    getLorebook(id)
      .then((detail) => {
        setEditing(detail);
        setEditorOpen(true);
      })
      .catch(fail("Failed to open lorebook"))
      .finally(() => setOpeningId(null));
  };

  /** Retries a failed first load: restore the skeleton while it is in flight,
   *  and clear the sticky error so the banner/state does not double up. */
  const retry = useCallback((): void => {
    setLoading(true);
    setError(null);
    refresh();
  }, [refresh]);

  /**
   * Opens the editor on a blank in-memory draft; nothing is created until
   * Save. The old behavior POSTed here, which created an empty lorebook even
   * if the user closed the editor without saving.
   */
  const create = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  const remove = (lorebook: Lorebook): void => {
    deleteLorebook(lorebook.id).then(refresh).catch(fail("Failed to delete lorebook"));
  };

  const onImportFile = (event: ChangeEvent<HTMLInputElement>): void => {
    // Capture the input synchronously: React resets `currentTarget` after the
    // handler returns, but the async continuation below still needs it.
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    file
      .text()
      .then((raw) => importLorebook(raw))
      .then(() => {
        input.value = ""; // allow re-picking the same file next time
        refresh();
      })
      .catch(fail("Import failed"));
  };

  return (
    <section className="stack page">
      <div className="page-header">
        <MobileNavButton />
        <div className="page-heading">
          <h1>Lorebooks</h1>
          <p className="caption page-desc">
            World info entries injected into your chats by keyword — a book runs when attached to
            its character or turned on globally. Global books apply in every chat.
          </p>
        </div>
        <div className="page-actions">
          {/* Hidden input so the header button can trigger a file picker. The
              input stays uncontrolled; the ref only fires its click. */}
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="file-hidden"
            onChange={onImportFile}
          />
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
            <Upload size={16} />
            Import lorebook
          </button>
          <button type="button" className="btn btn-primary" onClick={create}>
            <Plus size={16} />
            New lorebook
          </button>
        </div>
      </div>

      {/* A failed first load is a first-class failure, not an empty library:
          show the danger-tinted error state with a retry INSTEAD of the list
          (which would otherwise render its "No lorebooks yet" empty state
          underneath this banner). Once anything has loaded successfully, a
          later refresh/mutation error rides the banner over the live list. */}
      {error !== null && lorebooksLoaded && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {error !== null && !lorebooksLoaded ? (
        <div className="error-state" role="alert">
          <span className="empty-state-icon" aria-hidden="true">
            <TriangleAlert size={18} />
          </span>
          <span className="error-state-title">Couldn’t load lorebooks</span>
          <span className="error-state-hint">{error}</span>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : (
        <LorebookList
          lorebooks={filtered}
          loading={loading}
          counts={counts}
          query={query}
          onQuery={setQuery}
          busyId={openingId}
          onOpen={(lorebook) => openDetail(lorebook.id)}
          onDelete={remove}
          onToggleGlobal={toggleGlobal}
          onCreate={create}
          onImport={() => fileInput.current?.click()}
        />
      )}

      {/* editorOpen, not editing: editing === null is a valid "New
          lorebook" draft, so the open flag is what actually controls mounting. */}
      {editorOpen && (
        <LorebookEditor
          key={editing?.id ?? "new"}
          lorebook={editing}
          onSaved={(created) => {
            // A brand-new draft was created: close it and revalidate the list
            // so the new book shows up (mirrors Presets' close-after-create).
            setEditorOpen(false);
            setEditing(null);
            invalidateCount(created.id);
            refresh();
          }}
          onMetaChanged={() => {
            // The list renders the book's entry count, so a real entries
            // mutation must drop the cached value or the pill goes stale.
            if (editing !== null) {
              invalidateCount(editing.id);
            }
            refresh();
          }}
          onClose={(changed) => {
            setEditorOpen(false);
            setEditing(null);
            // A bare open→close of a never-saved draft fires NO request: that
            // is the point of the draft fix. refresh() only runs when the
            // editor actually mutated something (mergeRowsById keeps it
            // animation-free when it does run).
            if (changed) {
              refresh();
            }
          }}
        />
      )}
    </section>
  );
}
