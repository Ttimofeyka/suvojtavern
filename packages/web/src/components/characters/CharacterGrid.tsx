/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { blobUrl } from "../../lib/api";
import type { CharacterListItem, CharacterSort } from "../../lib/api-characters";
import { deleteCharacter } from "../../lib/api-characters";
import { exportCardUrl } from "../../lib/api-transfer";
import { cx } from "../../lib/cx";
import { INSTANT, scaleVariants, staggerContainer, useAppMotion } from "../../lib/motion";
import { chatActions } from "../../stores/chat";
import ConfirmDialog from "../ui/ConfirmDialog";
import {
  Drama,
  FileImage,
  FileJson,
  Image,
  LayoutGrid,
  List,
  MessageCirclePlus,
  Plus,
  Search,
  Trash2,
} from "../ui/icons";
import { StaggerItem } from "../ui/stagger";
import CharacterPageNav from "./CharacterPageNav";
import CharacterSortSelect from "./CharacterSortSelect";
import CharacterTagFilter from "./CharacterTagFilter";

/**
 * Staggered container that can suppress its entrance. The shared <Stagger>
 * always animates on mount; this grid mounts from a module-level cache on a
 * revisit, and replaying the cascade on every navigation reads as noise. So the
 * container takes an explicit `initial` (false = render settled) and otherwise
 * reuses the same variant machinery, mirroring LorebookList's local wrapper.
 *
 * The cards carry `content-visibility: auto`, which can skip or delay a one-shot
 * CSS entrance for an off-screen card; driving the rise-in through Motion on the
 * wrapper (which always renders) keeps it reliable. See `.char-grid > .stagger-item`.
 */
function ListStagger(props: {
  animate: boolean;
  className: string;
  children: ReactNode;
}): ReactElement {
  const app = useAppMotion();
  return (
    <motion.div
      className={cx("stagger", props.className)}
      variants={staggerContainer(app)}
      initial={props.animate ? "hidden" : false}
      animate="visible"
    >
      {props.children}
    </motion.div>
  );
}

interface GridProps {
  characters: CharacterListItem[];
  /** Distinct tags across the whole filtered set, from the server facet. When
   *  empty/absent the chips fall back to tags on the loaded rows. */
  tagOptions?: string[];
  /** True while the first load is in flight — skeleton cards stand in. */
  loading: boolean;
  /** 1-based page the loaded rows belong to. */
  page: number;
  /** Rows requested per page (viewport-derived; see charactersViewPageSize). */
  pageSize: number;
  /** True while a page fetch is airborne — the footer nav disables on it. */
  busy: boolean;
  /** Unpaged match count for the current filters (width of the full result). */
  total: number;
  search: string;
  onSearch: (value: string) => void;
  /** Tags currently selected; a character must carry ALL of them (AND). */
  selectedTags: string[];
  /** Replaces the tag selection — a toggle, or [] to clear it. */
  onTagsChange: (tags: string[]) => void;
  /** The server order the current rows were fetched under. */
  sort: CharacterSort;
  /** Switches the order; the owner re-fetches page 1 and remembers it. */
  onSort: (sort: CharacterSort) => void;
  onOpen: (character: CharacterListItem) => void;
  /** Opens the editor on a blank draft — the unfiltered empty state's CTA. */
  onCreate: () => void;
  onGallery: (character: CharacterListItem) => void;
  onChanged: () => void;
  /** Requests the page before the current one (no-op on the first page). */
  onPrev: () => void;
  /** Requests the page after the current one (no-op on the last page). */
  onNext: () => void;
}

/** Placeholder items for the loading skeleton grid. */
const SKELETONS = Array.from({ length: 6 }, (_, i) => i);

/** Distinct tags across the current list, for the filter chips. The server
 *  facet (see {@link GridProps.tags}) is preferred; this is the fallback for
 *  callers that do not pass one. */
const allTags = (items: CharacterListItem[]): string[] =>
  [...new Set(items.flatMap((character) => character.tags))].sort();

/** Card/row meta line: the chat count. A character's tags are deliberately
 *  absent — they live in the editor modal only, since a card can carry hundreds
 *  of them and would drown this line. `.tnum` keeps a changing digit count from
 *  reflowing it. */
function CharMeta({ character }: { character: CharacterListItem }): ReactNode {
  return (
    <span className="caption char-card-meta tnum">
      {character.chat_count} {character.chat_count === 1 ? "chat" : "chats"}
    </span>
  );
}

/** Avatar image, or the character's initial on a subtle surface. */
function Avatar(props: { path: string | null; name: string }) {
  const url = blobUrl(props.path);
  if (url !== null) {
    return <img className="avatar-image" src={url} alt="" loading="lazy" />;
  }
  return (
    <span className="avatar-fallback" aria-hidden="true">
      {props.name.slice(0, 1)}
    </span>
  );
}

/** The character browser: search/tag filters, view toggle, and the card grid/list. */
export default function CharacterGrid(props: GridProps) {
  const navigate = useNavigate();
  const app = useAppMotion();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CharacterListItem | null>(null);
  const [view, setView] = useState<"grid" | "list">("list");
  // Cards/rows should rise in only when this mount began with a skeleton
  // phase — i.e. it mounted with loading true (a first fetch with nothing to
  // show). A cached mount starts with loading false and data already present,
  // so its grid renders statically: no entrance-animation replay on
  // revisits, and none when the silent revalidate swaps in fresh row objects
  // either. The state captures props.loading once, at setup — later flips of
  // the prop must not retro-activate the animation.
  const [animate] = useState(() => props.loading);

  /** Filter chips come from the server facet when present (it covers tags on
   *  pages that are not loaded); otherwise fall back to the loaded rows. */
  const chipTags =
    props.tagOptions !== undefined && props.tagOptions.length > 0
      ? props.tagOptions
      : allTags(props.characters);

  /** Starts a fresh chat with the character, then heads to the Chats page —
   *  a failed create navigates nowhere (the store's error signal has the
   *  reason). The action buttons sit beside (not inside) the card's open
   *  button, so their clicks never trigger the open handler. */
  const startChat = (character: CharacterListItem): void => {
    chatActions.newChat(character.id).then((id) => {
      if (id) navigate("/");
    });
  };

  /** The confirmation modal is the only gate; its confirm callback runs after
   *  the panel's exit animation, then the delete request starts. */
  const confirmRemove = (): void => {
    const character = pendingDelete;
    if (character === null) {
      return;
    }
    setPendingDelete(null);
    setBusyId(character.id);
    deleteCharacter(character.id)
      .then(() => props.onChanged())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Delete failed"))
      .finally(() => setBusyId(null));
  };

  /** Icon actions shared by the grid cards and the list rows. */
  const actions = (character: CharacterListItem): ReactNode => (
    <div className="char-card-actions">
      <button
        type="button"
        className="btn btn-icon"
        aria-label={`Start a chat with ${character.name}`}
        data-tip="Start chat"
        onClick={() => startChat(character)}
      >
        <MessageCirclePlus size={16} />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={`Open gallery for ${character.name}`}
        data-tip="Gallery"
        onClick={() => props.onGallery(character)}
      >
        <Image size={16} />
      </button>
      {/* Downloads are plain anchors, not buttons — no onClick, so they can
          never bubble into the sibling open handler. */}
      <a
        className="btn btn-icon"
        href={exportCardUrl(character.id)}
        download=""
        aria-label={`Export ${character.name} as a card PNG`}
        data-tip="Export PNG"
      >
        <FileImage size={16} />
      </a>
      <a
        className="btn btn-icon"
        href={exportCardUrl(character.id, "json")}
        download=""
        aria-label={`Export ${character.name} as JSON`}
        data-tip="Export JSON"
      >
        <FileJson size={16} />
      </a>
      <button
        type="button"
        className="btn btn-icon btn-danger"
        aria-label={`Delete ${character.name}`}
        data-tip="Delete"
        disabled={busyId === character.id}
        onClick={() => setPendingDelete(character)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );

  /** Skeleton cards shown while the first load is in flight. */
  const skeletonGrid = (): ReactNode => (
    <div className="char-grid" aria-hidden="true">
      {SKELETONS.map((skeleton) => (
        <div className="card char-card char-skeleton" key={skeleton}>
          <div className="skeleton char-skeleton-media" />
          <div className="char-skeleton-body">
            <div className="skeleton skeleton-line" style={{ width: "70%" }} />
            <div className="skeleton skeleton-line" style={{ width: "45%" }} />
          </div>
          {/* Mirrors the card's action strip (five buttons) so the skeleton
              keeps the final card's height instead of collapsing short. */}
          <div className="char-skeleton-actions">
            <div className="skeleton skeleton-action" />
            <div className="skeleton skeleton-action" />
            <div className="skeleton skeleton-action" />
            <div className="skeleton skeleton-action" />
            <div className="skeleton skeleton-action" />
          </div>
        </div>
      ))}
    </div>
  );

  /** Compact rows with small avatars — the list view variant. */
  const listRows = (): ReactNode => (
    <ListStagger animate={animate} className="char-list">
      {props.characters.map((character) => (
        <StaggerItem key={character.id}>
          <article className="card card-hover char-row">
            <button type="button" className="char-row-open" onClick={() => props.onOpen(character)}>
              <span className="char-row-avatar">
                <Avatar path={character.avatar_path} name={character.name} />
              </span>
              <span className="char-row-main">
                <span className="char-row-name">{character.name}</span>
                <CharMeta character={character} />
              </span>
            </button>
            {actions(character)}
          </article>
        </StaggerItem>
      ))}
    </ListStagger>
  );

  // The empty state has three meanings: nothing exists yet, the search matched
  // nothing, or the active tag filter excludes everything. Each needs its own
  // copy; the filtered two get an escape hatch, the fresh one a create CTA.
  const searchQuery = props.search.trim();
  const filtered = searchQuery !== "" || props.selectedTags.length > 0;

  return (
    <div className="stack">
      <div className="chars-toolbar">
        <div className="search-field">
          <span className="search-icon" aria-hidden="true">
            <Search size={16} />
          </span>
          <input
            className="input"
            type="search"
            placeholder="Search by name…"
            aria-label="Search characters"
            value={props.search}
            onChange={(event) => props.onSearch(event.currentTarget.value)}
          />
        </div>
        <CharacterSortSelect className="chars-sort" value={props.sort} onChange={props.onSort} />
        <fieldset className="view-toggle" aria-label="Characters view">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            data-tip="Grid view"
            onClick={() => setView("grid")}
          >
            {/* The fill is a shared-layout indicator that slides between the
                two buttons; aria-pressed still carries the state, so the
                indicator is decoration (and snaps under reduced motion). */}
            {view === "grid" && (
              <motion.span
                className="view-toggle-indicator"
                layoutId="char-view-indicator"
                aria-hidden="true"
                transition={app.reduce ? INSTANT : app.spring.snappy}
              />
            )}
            <LayoutGrid size={16} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="List view"
            aria-pressed={view === "list"}
            data-tip="List view"
            onClick={() => setView("list")}
          >
            {view === "list" && (
              <motion.span
                className="view-toggle-indicator"
                layoutId="char-view-indicator"
                aria-hidden="true"
                transition={app.reduce ? INSTANT : app.spring.snappy}
              />
            )}
            <List size={16} />
          </button>
        </fieldset>
        {/* Last, and full-width (see `.tag-filter`), so the strip always owns
            its own toolbar row. Inline it would be a variable-width flex item:
            as a search or tag filter shrank the tag count, its content width
            would drop under the line threshold and the whole strip — mini
            search included — would hop up beside the name search mid-typing. */}
        <CharacterTagFilter
          tags={chipTags}
          value={props.selectedTags}
          onChange={props.onTagsChange}
        />
      </div>

      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {props.loading ? (
        skeletonGrid()
      ) : props.characters.length > 0 ? (
        <>
          {view === "grid" ? (
            <ListStagger animate={animate} className="char-grid">
              {props.characters.map((character) => (
                <StaggerItem key={character.id}>
                  <article className="card card-hover char-card">
                    <button
                      type="button"
                      className="char-card-open"
                      onClick={() => props.onOpen(character)}
                    >
                      <div className="char-card-media">
                        <Avatar path={character.avatar_path} name={character.name} />
                      </div>
                      <div className="char-card-body">
                        <span className="card-title char-name">{character.name}</span>
                        <CharMeta character={character} />
                      </div>
                    </button>
                    {actions(character)}
                  </article>
                </StaggerItem>
              ))}
            </ListStagger>
          ) : (
            listRows()
          )}
          <CharacterPageNav
            page={props.page}
            pageSize={props.pageSize}
            loaded={props.characters.length}
            total={props.total}
            busy={props.busy}
            onPrev={props.onPrev}
            onNext={props.onNext}
          />
        </>
      ) : (
        <motion.div
          className="empty-card"
          variants={scaleVariants(app, 0.98)}
          initial="hidden"
          animate="visible"
        >
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">
              {filtered ? <Search size={36} /> : <Drama size={36} />}
            </span>
            {searchQuery !== "" ? (
              <>
                <span className="empty-state-title">No results for “{searchQuery}”</span>
                <span className="empty-state-hint">Try a different name or clear the search.</span>
              </>
            ) : props.selectedTags.length > 0 ? (
              <>
                <span className="empty-state-title">
                  {props.selectedTags.length === 1
                    ? `No characters tagged “${props.selectedTags[0] ?? ""}”`
                    : "No characters carry every selected tag"}
                </span>
                <span className="empty-state-hint">Clear the tag filter to see everything.</span>
              </>
            ) : (
              <>
                <span className="empty-state-title">No characters yet</span>
                <span className="empty-state-hint">
                  Create one or import a card to get started.
                </span>
              </>
            )}
            <div className="empty-state-actions">
              {filtered ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    props.onSearch("");
                    props.onTagsChange([]);
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={props.onCreate}>
                  <Plus size={16} />
                  New character
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete character?"
          description={
            <>
              <strong>{pendingDelete.name}</strong> and every one of its chats will be deleted. This
              cannot be undone.
            </>
          }
          confirmLabel="Delete character"
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmRemove}
        />
      )}
    </div>
  );
}
