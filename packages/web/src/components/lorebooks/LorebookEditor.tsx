/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../components/ui/Modal";
import type {
  Lorebook,
  LorebookDetail,
  LorebookEntry,
  LorebookSection,
} from "../../lib/api-lorebooks";
import {
  attachLorebook,
  createLorebook,
  createSection,
  deleteEntry,
  deleteSection,
  detachLorebook,
  listEntries,
  listSections,
  reorderEntries,
  reorderSections,
  updateEntry,
  updateLorebook,
  updateSection,
} from "../../lib/api-lorebooks";
import { useCharacterPager } from "../../lib/character-paging";
import { cx } from "../../lib/cx";
import type { LorebookBlock } from "../../lib/lorebook-sections";
import {
  buildBlocks,
  clampBlockPage,
  containerEntries,
  moveInOrder,
  pageCountBlocks,
  pageUnits,
  paginateBlocks,
} from "../../lib/lorebook-sections";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { mergeRowsById } from "../../lib/row-merge";
import CharacterListMore from "../characters/CharacterListMore";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { Collapsible } from "../ui/collapsible";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Info,
  Plus,
  Search,
  Trash2,
} from "../ui/icons";
import { Presence } from "../ui/presence";
import { Stagger, StaggerItem } from "../ui/stagger";
import EntryCard from "./EntryCard";
import EntryEditor from "./EntryEditor";
import "../../styles/lorebooks.css";

interface EditorProps {
  /** Existing book to edit, or null to draft a brand-new one. */
  lorebook: LorebookDetail | null;
  /** Fired after a brand-new draft is created — the view closes and refreshes. */
  onSaved: (lorebook: Lorebook) => void;
  /** Fired only for mutations the list itself renders (name, description and
   *  entry count) so the view revalidates the list without a redundant fetch
   *  on every editor close. */
  onMetaChanged: () => void;
  /** `changed` is true when anything was mutated; the view skips its list
   *  revalidate on a plain open→close. */
  onClose: (changed: boolean) => void;
}

/** Which entry the nested EntryEditor addresses: undefined = closed, a null
 *  `entry` = creating, and `sectionId` is the container a new entry joins. */
interface EditingState {
  entry: LorebookEntry | null;
  sectionId: string | null;
}

/** Page-size choices for the entry pager (default 24 — see DEFAULT_PAGE_SIZE). */
const PAGE_SIZES = [12, 24, 48] as const;
/** 24 cards roughly fill the xl modal's 3-column grid without forcing a
 *  scroll on a typical laptop viewport; 12 is the quick-scan size and 48 the
 *  "show me everything" size for big imported world info books. */
const DEFAULT_PAGE_SIZE = 24;
/** The Entries section only exists once the book itself is saved. */
const UNSAVED_ENTRIES_CAPTION =
  "Save this lorebook first — entries (and the sections that group them) need a saved book to attach to.";

const ENTRIES_TIP =
  "Each entry is a snippet injected into the prompt when its keys appear in recent messages. Order breaks token-budget ties and Position decides where the text lands. Sections are purely organizational — they group these cards and never change what activates.";
const SECTION_TIP =
  "A named block that groups entries in this editor only. Sections never affect generation — an entry activates the same whether or not it sits in one. Reorder entries inside a section with their up/down buttons.";
const UNGROUPED_TIP = "Entries not filed under any section.";
const EMPTY_ENTRIES_TIP =
  "No entries yet. Add one below, or import a SillyTavern world info file from the Lorebooks page.";

/** Stable render key for a block: sections by id, the ungrouped bucket fixed. */
const blockKey = (block: LorebookBlock): string =>
  block.kind === "section" ? `section:${block.section.id}` : "ungrouped";

/** One sticky-header status tone + text. Mirrors the character editor. */
interface EditorStatus {
  tone: "clean" | "dirty" | "danger";
  text: string;
}

/**
 * Full lorebook editor: metadata, entry management, section grouping, and
 * character attachment.
 *
 * With `props.lorebook === null` this is a draft: nothing exists server-side
 * until Save, so only the Details form renders (there is no book id to hang
 * entries or attachments off yet). Saving creates the book and hands the row
 * back through `onSaved`.
 */
export default function LorebookEditor(props: EditorProps): ReactElement {
  const app = useAppMotion();
  const { confirm, dialog } = useConfirmDialog();
  // The book is plain for this mount: the view opens the editor with a fixed
  // row, so a `const` narrows cleanly for JSX and async continuations.
  const book = props.lorebook;
  // Entries and sections are reconciled by id, not swapped wholesale: a
  // mutation returns fresh row objects, and replacing the array would rebuild
  // every card (replaying entrance animations across the whole page). Every
  // write goes through `mergeRowsById`, which diffs by id AND content and
  // keeps each unchanged row's object identity — the same mechanism
  // views/Lorebooks.tsx uses for its list. A toggle or single edit then
  // repaints just the affected card instead of restarting the grid's entrance.
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [sections, setSections] = useState<LorebookSection[]>([]);
  const [name, setName] = useState(() => props.lorebook?.name ?? "New lorebook");
  const [description, setDescription] = useState(() => props.lorebook?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [metaSaved, setMetaSaved] = useState(false);
  /** True while a Details save is in flight. A latch, not decoration: without
   *  it a double-click on a brand-new draft POSTs two books, and the second
   *  onSaved would run on top of the first. */
  const [saving, setSaving] = useState(false);
  // Character attach target: a paged, server-searchable list. autoload is off
  // because the picker only exists for an already-saved book; the mount effect
  // below triggers the first page when it does.
  const pager = useCharacterPager({ autoload: false });
  const [attachTarget, setAttachTarget] = useState("");
  /** Which attach/detach request is in flight, or null. A latch so a double
   *  click cannot fire two links while one is airborne, and the trigger. */
  const [linking, setLinking] = useState<"attach" | "detach" | null>(null);
  /** undefined = closed, an object = the open EntryEditor (entry null = new). */
  const [editing, setEditing] = useState<EditingState | undefined>(undefined);
  /** Ids of the sections whose body is EXPANDED. The set is the exception list,
   *  so an empty set means every section is collapsed — the intended default on
   *  every editor open, and for a section created mid-session (it is never
   *  added here). Replaced, never mutated, so React sees the change. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);

  // Plain (non-reactive) bookkeeping: true while a mutation has left the
  // view's list stale and it has not yet been told. The close handler reads it
  // at click time; a ref, not state, because a re-render is never needed.
  const changedRef = useRef(false);

  /** Reports a mutation the list itself renders (name, description, entry
   *  count) through onMetaChanged, which revalidates the list. The dirty flag
   *  is deliberately cleared: that refresh IS this mutation's revalidation,
   *  so close must not fire a second list fetch on top of it. */
  const reportMetaChange = (): void => {
    changedRef.current = false;
    props.onMetaChanged();
  };

  const fail =
    (fallback: string) =>
    (err: unknown): void => {
      setError(err instanceof Error ? err.message : fallback);
    };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once — the editor is remounted per open, so the draft is deliberately seeded only from the first render's book and the first page of characters. Later prop identities must not clobber edits.
  useEffect(() => {
    if (props.lorebook !== null) {
      // Seed from the open book's own rows, reconciling into the empty list so
      // the initial objects are the server's (no needless clones).
      setEntries((current) => mergeRowsById(current, props.lorebook?.entries ?? []));
      setSections((current) => mergeRowsById(current, props.lorebook?.sections ?? []));
      pager.reload();
    }
  }, []);

  // Keep the attach select on a real option: when the visible page no longer
  // contains the current pick (first load, a search refetch), fall back to the
  // first row.
  useEffect(() => {
    const items = pager.items;
    if (!items.some((character) => character.id === attachTarget)) {
      setAttachTarget(items[0]?.id ?? "");
    }
  }, [pager.items, attachTarget]);

  // A pager error lands in the editor's shared error banner, matching the
  // previous listCharacters failure handling.
  useEffect(() => {
    if (pager.error !== null) {
      setError(pager.error);
    }
  }, [pager.error]);

  // --- Blocks and pagination -------------------------------------------------

  /** Render blocks: sections in display_index order, then the ungrouped bucket
   *  last (see lib/lorebook-sections). Empty for an unsaved draft. */
  const blocks = useMemo(() => buildBlocks(entries, sections), [entries, sections]);

  /** Pagination units: a whole section is one unit, each ungrouped entry its
   *  own — so a section is never split while a sectionless book pages exactly
   *  as it did before sections existed. */
  const units = useMemo(() => pageUnits(blocks), [blocks]);

  const totalPages = pageCountBlocks(units.length, pageSize);

  // Page-reset rule: when the block list shrinks below what the current page
  // covers, snap back to page 1 (see clampBlockPage). Page 1 always exists, so
  // a delete on the last page can never strand the grid on an empty page.
  // Depends on the unit count and page size; the functional update reads the
  // previous page without listing it as a dependency, so the effect only
  // re-runs on those two inputs.
  useEffect(() => {
    setPage((current) => clampBlockPage(current, units.length, pageSize));
  }, [units.length, pageSize]);

  /** The units on the current page, plus the "Showing A–B" range. Units (not
   *  entries) are the page currency, so the range counts blocks. */
  const paged = useMemo(() => paginateBlocks(units, page, pageSize), [units, page, pageSize]);

  /** Fold the page's units back into render blocks: consecutive single-entry
   *  ungrouped units rejoin one grid so their cards keep flowing 3/2/1-up
   *  instead of one grid per card. Sections always precede the ungrouped
   *  bucket, so only the trailing run ever merges. */
  const pageBlocks = useMemo<LorebookBlock[]>(() => {
    const merged: LorebookBlock[] = [];
    for (const unit of paged.items) {
      if (unit.kind === "section") {
        merged.push(unit);
        continue;
      }
      const last = merged[merged.length - 1];
      if (last !== undefined && last.kind === "ungrouped") {
        last.entries.push(...unit.entries);
      } else {
        merged.push({ kind: "ungrouped", entries: [...unit.entries] });
      }
    }
    return merged;
  }, [paged]);

  // Keyed lookup rather than iterating pageBlocks directly: pageBlocks rebuilds
  // its objects on every mutation, and a list keyed by those fresh references
  // would remount each block — and the cards inside it — on every change.
  // Keying by a stable primitive (the section id) keeps the DOM mounted, so
  // the reconciled entry identity actually reaches the cards.
  const blockKeys = useMemo(() => pageBlocks.map(blockKey), [pageBlocks]);
  const blockByKey = useMemo(
    () => new Map(pageBlocks.map((block) => [blockKey(block), block] as const)),
    [pageBlocks],
  );

  /** The page's entries of a container — null is the ungrouped bucket. */
  const entriesOf = (sectionId: string | null): LorebookEntry[] =>
    blockByKey.get(sectionId === null ? "ungrouped" : `section:${sectionId}`)?.entries ?? [];

  // Entry id → its position and container size, for the card move buttons.
  // Containers come from `containerEntries`, which matches on the RAW
  // `section_id` — the exact split the server's reorder route enforces
  // (`section_id IS ?`, null = ungrouped). Rendering goes through
  // `buildBlocks`, which additionally folds an entry with a foreign
  // section_id into the ungrouped block; such an entry (only possible while
  // this list is stale — the FK is ON DELETE SET NULL) is rendered ungrouped
  // but is absent from every container here, so its move buttons disable
  // instead of sending a reorder the server would reject.
  const containerOrder = useMemo(() => {
    const map = new Map<string, { index: number; size: number }>();
    const containers: (string | null)[] = [...sections.map((section) => section.id), null];
    for (const sectionId of containers) {
      const list = containerEntries(entries, sectionId);
      list.forEach((entry, index) => {
        map.set(entry.id, { index, size: list.length });
      });
    }
    return map;
  }, [entries, sections]);

  const sectionIndexOf = (sectionId: string): number =>
    sections.findIndex((section) => section.id === sectionId);

  const changePageSize = (size: number): void => {
    setPageSize(size);
    // A new page size renumbers every page; page 1 is the only sane anchor.
    setPage(1);
  };

  // --- Metadata --------------------------------------------------------------

  const saveMeta = (): void => {
    // A blank name is invalid; `saving` is the double-submit latch (a second
    // click while the first request is airborne must not fire another create).
    if (saving || name.trim() === "") {
      return;
    }
    setSaving(true);
    // A null book is a brand-new draft: nothing exists server-side until this
    // create, after which the view takes over (there is no id to PATCH yet).
    if (book === null) {
      createLorebook({ name, description })
        .then((created) => {
          setSaving(false);
          props.onSaved(created);
        })
        .catch((err: unknown) => {
          // Clear the latch on failure too, or the button wedges on "Saving…".
          setSaving(false);
          fail("Failed to create lorebook")(err);
        });
      return;
    }
    updateLorebook(book.id, { name, description })
      .then((updated) => {
        setSaving(false);
        setMetaSaved(true);
        setName(updated.name);
        setDescription(updated.description);
        // The list renders the name/description, so this mutation rides the
        // meta refresh rather than leaving the dirty flag set for a second
        // fetch on close.
        reportMetaChange();
      })
      .catch((err: unknown) => {
        setSaving(false);
        fail("Failed to save lorebook")(err);
      });
  };

  // --- Entries ---------------------------------------------------------------

  const refreshEntries = (): void => {
    // merge by id, not a plain swap: listEntries returns fresh row objects,
    // and replacing the array wholesale would remount every card after any
    // create/edit/delete/toggle.
    if (book === null) {
      return;
    }
    listEntries(book.id)
      .then((items) => setEntries((current) => mergeRowsById(current, items)))
      .catch(fail("Failed to load entries"));
  };

  const removeEntry = (entry: LorebookEntry): void => {
    if (book === null) {
      return;
    }
    const bookId = book.id;
    confirm({
      title: "Delete entry?",
      description: "This entry will be removed from the lorebook. This cannot be undone.",
      confirmLabel: "Delete entry",
      tone: "danger",
      onConfirm: () => {
        deleteEntry(bookId, entry.id)
          .then(() => {
            refreshEntries();
            // Deletion shifts the list's entry count, so it takes the meta
            // refresh (and clears the dirty flag with it) rather than triggering
            // a second fetch on close.
            reportMetaChange();
          })
          .catch(fail("Failed to delete entry"));
      },
    });
  };

  /** Quick enable/disable straight from the entry card. */
  const toggleEntry = (entry: LorebookEntry): void => {
    if (book === null) {
      return;
    }
    updateEntry(book.id, entry.id, { enabled: !entry.enabled })
      .then(() => {
        changedRef.current = true;
        refreshEntries();
      })
      .catch(fail("Failed to toggle entry"));
  };

  /**
   * Reorders one entry within its own container (null = ungrouped). The order
   * only affects generation tie-breaking and the list never renders it, so
   * this sets the dirty flag (close revalidates) instead of taking the meta
   * refresh — but the server echoes the full list, which mergeRowsById merges
   * so only the moved cards repaint.
   */
  const moveEntry = (sectionId: string | null, entry: LorebookEntry, delta: -1 | 1): void => {
    if (book === null) {
      return;
    }
    const container = containerEntries(entries, sectionId);
    const index = container.findIndex((item) => item.id === entry.id);
    const ids = moveInOrder(
      container.map((item) => item.id),
      index,
      delta,
    );
    if (ids === null) {
      return;
    }
    reorderEntries(book.id, sectionId, ids)
      .then((result) => {
        changedRef.current = true;
        setEntries((current) => mergeRowsById(current, result.entries));
      })
      .catch(fail("Failed to reorder entries"));
  };

  // --- Sections --------------------------------------------------------------

  const refreshSections = (): void => {
    if (book === null) {
      return;
    }
    listSections(book.id)
      .then((items) => setSections((current) => mergeRowsById(current, items)))
      .catch(fail("Failed to load sections"));
  };

  const addSection = (): void => {
    if (book === null) {
      return;
    }
    createSection(book.id, "New section")
      .then(() => {
        // Creating a section adds a block the list does not render, so this
        // only marks the editor dirty; close revalidates the list harmlessly.
        changedRef.current = true;
        refreshSections();
      })
      .catch(fail("Failed to create section"));
  };

  /** PATCHes a section's name on blur/Enter, and only when it actually changed. */
  const commitSectionName = (section: LorebookSection, input: HTMLInputElement): void => {
    const next = input.value.trim();
    // Blank is not a rename (the server requires a name), and an unchanged
    // value is not a request: put the field back and return.
    if (book === null || next === "" || next === section.name) {
      input.value = section.name;
      return;
    }
    updateSection(book.id, section.id, { name: next })
      .then(() => {
        changedRef.current = true;
        refreshSections();
      })
      .catch((err: unknown) => {
        // The list still holds the old name; show it rather than the text
        // that failed to save.
        input.value = section.name;
        fail("Failed to rename section")(err);
      });
  };

  const removeSection = (section: LorebookSection): void => {
    if (book === null) {
      return;
    }
    const bookId = book.id;
    confirm({
      title: "Delete section?",
      description: (
        <>
          <strong>{section.name}</strong> will be removed. Its entries are kept and become
          ungrouped.
        </>
      ),
      confirmLabel: "Delete section",
      tone: "danger",
      onConfirm: () => {
        deleteSection(bookId, section.id)
          .then(() => {
            // Deleting a section renumbers its entries into the ungrouped bucket,
            // so BOTH lists need a refresh. No meta refresh: the entry count the
            // list renders is unchanged (entries are preserved).
            changedRef.current = true;
            refreshSections();
            refreshEntries();
          })
          .catch(fail("Failed to delete section"));
      },
    });
  };

  /** Reorders sections; the order only affects the editor's blocks, so it sets
   *  the dirty flag rather than the meta refresh. */
  const moveSection = (sectionId: string, delta: -1 | 1): void => {
    if (book === null) {
      return;
    }
    const ids = moveInOrder(
      sections.map((section) => section.id),
      sectionIndexOf(sectionId),
      delta,
    );
    if (ids === null) {
      return;
    }
    reorderSections(book.id, ids)
      .then(() => {
        changedRef.current = true;
        refreshSections();
      })
      .catch(fail("Failed to reorder sections"));
  };

  const toggleExpanded = (sectionId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  // --- Attachment ------------------------------------------------------------

  const link = (attach: boolean): void => {
    if (book === null || attachTarget === "" || linking !== null) {
      return;
    }
    setLinking(attach ? "attach" : "detach");
    (attach ? attachLorebook(book.id, attachTarget) : detachLorebook(book.id, attachTarget))
      .then(() => {
        changedRef.current = true;
        setError(null);
        // The attachment list is idempotent on the server, so no local state
        // to refresh beyond clearing a previous error.
      })
      .catch(fail(attach ? "Failed to attach lorebook" : "Failed to detach lorebook"))
      // Cleared on both paths, or a failed link would wedge both buttons shut.
      .finally(() => setLinking(null));
  };

  // --- Status ----------------------------------------------------------------

  // The Details form is the only state this modal holds that is not already
  // committed to the server, so the dirty affordance tracks it (and a draft
  // that has not been created at all).
  const metaDirty = book !== null && (name !== book.name || description !== book.description);
  const status: EditorStatus = saving
    ? { tone: "clean", text: "Saving…" }
    : name.trim() === ""
      ? { tone: "danger", text: "Name is required" }
      : book === null
        ? { tone: "dirty", text: "Not saved yet" }
        : metaDirty
          ? { tone: "dirty", text: "Unsaved changes" }
          : metaSaved
            ? { tone: "clean", text: "Saved" }
            : { tone: "clean", text: "All changes saved" };

  // --- Rendering -------------------------------------------------------------

  /** One entry card, wired to its container so moves stay within it. The key
   *  lives on the StaggerItem that wraps this in the grid. */
  const card = (entry: LorebookEntry, index: number, sectionId: string | null): ReactNode => {
    // An entry in no live container (a stale foreign section_id, rendered
    // ungrouped) stays put: its up/down buttons disable rather than sending a
    // reorder the server would reject.
    const order = containerOrder.get(entry.id);
    const canMove = (delta: -1 | 1): boolean => {
      if (order === undefined) {
        return false;
      }
      const target = order.index + delta;
      return target >= 0 && target < order.size;
    };
    return (
      <EntryCard
        entry={entry}
        index={index}
        canMoveUp={canMove(-1)}
        canMoveDown={canMove(1)}
        onOpen={(target) => setEditing({ entry: target, sectionId: target.section_id })}
        onToggle={toggleEntry}
        onDelete={removeEntry}
        onMoveUp={(target) => moveEntry(sectionId, target, -1)}
        onMoveDown={(target) => moveEntry(sectionId, target, 1)}
      />
    );
  };

  /** The staggered grid of one container's cards. `Presence initial` (true)
   *  lets the cascade play on the editor's first paint; without it the
   *  wrapper's default `initial={false}` would render every card settled and
   *  only later additions would animate. */
  const grid = (sectionId: string | null): ReactNode => (
    <Stagger className="entry-grid">
      <Presence initial>
        {entriesOf(sectionId).map((entry, index) => (
          <StaggerItem key={entry.id}>{card(entry, index, sectionId)}</StaggerItem>
        ))}
      </Presence>
    </Stagger>
  );

  const sectionBlock = (sectionId: string): ReactNode => {
    const section = sections.find((candidate) => candidate.id === sectionId);
    const bodyId = `entry-section-body-${sectionId}`;
    const isExpanded = expanded.has(sectionId);
    return (
      <div className="entry-block entry-section">
        <div className="entry-section-head">
          <span className="entry-section-index tnum" aria-hidden="true">
            {sectionIndexOf(sectionId) + 1}
          </span>
          <button
            type="button"
            className="entry-section-toggle"
            aria-expanded={isExpanded}
            aria-controls={bodyId}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} section ${section?.name ?? ""}`}
            onClick={() => toggleExpanded(sectionId)}
          >
            <span className="entry-section-chevron" aria-hidden="true">
              <ChevronDown size={14} />
            </span>
          </button>
          {/* An inline rename field, not window.prompt: commits on blur/Enter
              and only when the text actually changed. It stays UNCONTROLLED
              (defaultValue) so typing is never reverted by a re-render; a
              failed save puts the stored name back on the element directly.
              The key remounts the field when the stored name changes out of
              band, re-seeding it from the server without clobbering an
              in-progress rename. */}
          <input
            className="input entry-section-name"
            key={section?.name ?? ""}
            defaultValue={section?.name ?? ""}
            aria-label={`Section name: ${section?.name ?? ""}`}
            data-tip={SECTION_TIP}
            onBlur={(event) => {
              const current = sections.find((candidate) => candidate.id === sectionId);
              if (current !== undefined) {
                commitSectionName(current, event.currentTarget);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="pill entry-section-count">
            {containerEntries(entries, sectionId).length}
          </span>
          <div className="entry-section-tools">
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Move section ${section?.name ?? ""} up`}
              data-tip="Move section up"
              disabled={sectionIndexOf(sectionId) <= 0}
              onClick={() => moveSection(sectionId, -1)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Move section ${section?.name ?? ""} down`}
              data-tip="Move section down"
              disabled={sectionIndexOf(sectionId) >= sections.length - 1}
              onClick={() => moveSection(sectionId, 1)}
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              className="btn btn-section-add"
              onClick={() => setEditing({ entry: null, sectionId })}
            >
              <Plus size={14} />
              Add entry
            </button>
            <button
              type="button"
              className="btn btn-icon btn-danger"
              aria-label={`Delete section ${section?.name ?? ""}`}
              data-tip="Delete section"
              onClick={() => {
                const current = sections.find((candidate) => candidate.id === sectionId);
                if (current !== undefined) {
                  removeSection(current);
                }
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        {/* Collapsible owns the height/opacity choreography; its inner keeps
            the id the toggle's aria-controls points at and renders even while
            closed, so the target is never a dangling reference. `lazy` keeps
            collapsed sections to just their header: the grid mounts on expand
            (so the card cascade plays then, not on every editor open) and
            unmounts only after the collapse animation finishes. */}
        <Collapsible open={isExpanded} id={bodyId} className="entry-section-body" lazy>
          {grid(sectionId)}
        </Collapsible>
      </div>
    );
  };

  const ungroupedBlock = (): ReactNode => (
    <div className="entry-block entry-ungrouped">
      {/* Only a book WITH sections shows the header: a sectionless book must
          render exactly as it did before sections existed (one flat grid). */}
      {sections.length > 0 && (
        <div className="entry-ungrouped-head">
          Ungrouped
          {/* A focusable <button class="info-tip">, not a bare data-tip div:
              lib/tooltip.ts reveals tips on :focus-visible, and a plain div is
              not focusable, so keyboard/AT users would never get the text. The
              aria-label gives assistive tech the same words as the tooltip. */}
          <button
            type="button"
            className="info-tip"
            aria-label={UNGROUPED_TIP}
            data-tip={UNGROUPED_TIP}
          >
            <Info size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {grid(null)}
    </div>
  );

  return (
    <>
      <Modal
        title={book === null ? "New lorebook" : `Lorebook — ${book.name}`}
        xl
        onClose={() => props.onClose(changedRef.current)}
        actions={
          <>
            <span className={cx("entry-status", `entry-status-${status.tone}`)} role="status">
              <span className="entry-status-dot" aria-hidden="true" />
              {status.text}
            </span>
            {/* Lives in the pinned header so the primary action never scrolls
              out of reach; creating a draft and saving an existing book share
              the one handler. */}
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || name.trim() === ""}
              aria-busy={saving}
              onClick={saveMeta}
            >
              {saving && <span className="spinner btn-spinner" aria-hidden="true" />}
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <div className="stack">
          <fieldset className="form-section">
            <legend className="form-section-title">Details</legend>
            <div className="field">
              <label className="field-label" htmlFor="lorebook-name">
                Name
              </label>
              <input
                id="lorebook-name"
                className="input"
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setMetaSaved(false);
                }}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="lorebook-description">
                Description
              </label>
              <textarea
                id="lorebook-description"
                className="textarea"
                rows={2}
                value={description}
                onChange={(event) => {
                  setDescription(event.currentTarget.value);
                  setMetaSaved(false);
                }}
              />
            </div>
          </fieldset>

          {error !== null && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}

          {book !== null ? (
            <>
              <section className="stack">
                <h4 className="sub-heading entry-heading">
                  Entries
                  <span className="pill">{entries.length}</span>
                  {/* A <button>, not a bare <span data-tip>: it is natively
                    focusable (so the tooltip controller's :focus-visible hook
                    reaches it) and its aria-label gives assistive tech the
                    same text the sighted tooltip shows. */}
                  <button
                    type="button"
                    className="info-tip"
                    aria-label={ENTRIES_TIP}
                    data-tip={ENTRIES_TIP}
                  >
                    <Info size={13} aria-hidden="true" />
                  </button>
                </h4>

                {entries.length === 0 && sections.length === 0 && (
                  <div className="entry-empty">
                    <p className="entry-empty-title">No entries yet</p>
                    <p className="entry-empty-hint">{EMPTY_ENTRIES_TIP}</p>
                  </div>
                )}

                {/* Two nested AnimatePresence layers: the outer crossfades whole
                  pages on a page change (mode="wait" so the outgoing page
                  settles before the next enters), the inner animates a block
                  being added/removed (a new section, a deleted one) without
                  touching its siblings. Blocks are keyed by a stable primitive
                  so a mutation repaints the changed block instead of
                  remounting the page's DOM. */}
                <Presence mode="wait" initial={false}>
                  <motion.div
                    key={`page-${page}`}
                    className="entry-page"
                    variants={riseVariants(app)}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <Presence initial={false}>
                      {blockKeys.map((key) => (
                        <motion.div
                          key={key}
                          variants={riseVariants(app)}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                        >
                          {key === "ungrouped"
                            ? ungroupedBlock()
                            : sectionBlock(key.slice("section:".length))}
                        </motion.div>
                      ))}
                    </Presence>
                  </motion.div>
                </Presence>

                {/* The picker and range caption exist as soon as there is
                  anything to page through: with exactly one page the user
                  must still reach "Per page" to create a second one. Only the
                  prev/next controls stay hidden while a single page holds
                  everything. */}
                {entries.length > 0 && (
                  <div className="entry-pagination">
                    <label className="field-label entry-page-size-label" htmlFor="entry-page-size">
                      Per page
                    </label>
                    <select
                      id="entry-page-size"
                      className="select entry-page-size"
                      value={pageSize}
                      onChange={(event) => changePageSize(Number(event.currentTarget.value))}
                    >
                      {PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                    {units.length > pageSize && (
                      <div className="entry-page-nav">
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label="Previous page"
                          data-tip="Previous page"
                          disabled={page <= 1}
                          onClick={() => setPage((current) => Math.max(1, current - 1))}
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="entry-page-status tnum">
                          Page {page} of {totalPages}
                        </span>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label="Next page"
                          data-tip="Next page"
                          disabled={page >= totalPages}
                          onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    )}
                    {/* The range and total are in page units: a section counts
                      once, and for a sectionless book units are one-per-entry
                      so this reads exactly as it did before sections. */}
                    <span className="caption muted entry-page-range tnum">
                      Showing {paged.start}–{paged.end} of {units.length}{" "}
                      {sections.length > 0 ? "blocks" : "entries"}
                    </span>
                  </div>
                )}

                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditing({ entry: null, sectionId: null })}
                  >
                    <Plus size={16} />
                    Add entry
                  </button>
                  <button type="button" className="btn" data-tip={SECTION_TIP} onClick={addSection}>
                    <Plus size={16} />
                    Add section
                  </button>
                </div>
              </section>

              <section className="stack">
                <h4 className="sub-heading">Attach to character</h4>
                <div className="search-field">
                  <span className="search-icon" aria-hidden="true">
                    <Search size={16} />
                  </span>
                  <input
                    className="input"
                    type="search"
                    placeholder="Search characters…"
                    aria-label="Search characters"
                    value={pager.search}
                    onChange={(event) => pager.onSearch(event.currentTarget.value)}
                  />
                </div>
                <div className="row">
                  <select
                    className="select"
                    aria-label="Character"
                    value={attachTarget}
                    onChange={(event) => setAttachTarget(event.currentTarget.value)}
                  >
                    {pager.items.map((character) => (
                      <option key={character.id} value={character.id}>
                        {character.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={attachTarget === "" || linking !== null}
                    aria-busy={linking === "attach"}
                    onClick={() => link(true)}
                  >
                    {linking === "attach" && (
                      <span className="spinner btn-spinner" aria-hidden="true" />
                    )}
                    Attach
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={attachTarget === "" || linking !== null}
                    aria-busy={linking === "detach"}
                    onClick={() => link(false)}
                  >
                    {linking === "detach" && (
                      <span className="spinner btn-spinner" aria-hidden="true" />
                    )}
                    Detach
                  </button>
                </div>
                <CharacterListMore
                  loaded={pager.items.length}
                  total={pager.total}
                  loadingMore={pager.loadingMore}
                  hasMore={pager.hasMore}
                  onLoadMore={pager.loadMore}
                />
              </section>

              {editing !== undefined && (
                <EntryEditor
                  key={editing.entry?.id ?? "new"}
                  lorebookId={book.id}
                  entry={editing.entry}
                  sections={sections}
                  defaultSectionId={editing.sectionId}
                  onSaved={() => {
                    // Creating an entry shifts the list's count pill and takes
                    // the meta refresh (which clears the dirty flag with it);
                    // editing one only changes fields the list never renders,
                    // so it leaves the flag set for the close refresh.
                    const created = editing.entry === null;
                    setEditing(undefined);
                    refreshEntries();
                    if (created) {
                      reportMetaChange();
                    } else {
                      changedRef.current = true;
                    }
                  }}
                  onClose={() => setEditing(undefined)}
                />
              )}
            </>
          ) : (
            // No Entries or Attach section at all while the book is unsaved —
            // there is no id to hang entries or attachments off yet. The caption
            // stands in their place so the empty state explains itself.
            <p className="caption muted">{UNSAVED_ENTRIES_CAPTION}</p>
          )}
        </div>
      </Modal>
      {dialog}
    </>
  );
}
