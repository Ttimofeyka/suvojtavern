/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Lorebook } from "../../lib/api-lorebooks";
import { exportLorebookUrl } from "../../lib/api-transfer";
import { cx } from "../../lib/cx";
import { INSTANT, scaleVariants, staggerContainer, useAppMotion } from "../../lib/motion";
import ConfirmDialog from "../ui/ConfirmDialog";
import { BookOpen, Download, Layers, Plus, Search, Trash2, Upload } from "../ui/icons";
import { Presence } from "../ui/presence";
import { Stagger, StaggerItem } from "../ui/stagger";
import "../../styles/lorebooks.css";

interface ListProps {
  lorebooks: Lorebook[];
  /** True while the first load is in flight — skeleton rows stand in. */
  loading: boolean;
  /** Entry counts by lorebook id, filled opportunistically by the view. */
  counts: Record<string, number>;
  query: string;
  onQuery: (value: string) => void;
  /** Id of the book whose detail fetch is in flight, or null. */
  busyId: string | null;
  onOpen: (lorebook: Lorebook) => void;
  onDelete: (lorebook: Lorebook) => void;
  /** Optimistically flips the book's global (every-chat) flag. */
  onToggleGlobal: (lorebook: Lorebook, enabled: boolean) => void;
  /** Opens the blank "New lorebook" editor (empty-state call to action). */
  onCreate: () => void;
  /** Triggers the header's hidden file picker (empty-state call to action). */
  onImport: () => void;
}

/** Placeholder items for the loading skeleton rows. */
const SKELETONS = Array.from({ length: 3 }, (_, i) => i);

/** How long the "global changed" glow ring plays on a card (matches the
 *  lore-global-pulse keyframe duration in lorebooks.css). */
const PULSE_MS = 600;

/**
 * Staggered container that can suppress its entrance. The shared <Stagger>
 * always animates on mount; this list mounts from a module-level cache on a
 * revisit, and replaying the cascade every navigation reads as noise. So the
 * container takes an explicit `initial` (false = render settled) and otherwise
 * reuses the same variant machinery as the shared primitive.
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

/** The lorebook browser: search box and the stacked list of lorebook cards. */
export default function LorebookList(props: ListProps): ReactElement {
  const app = useAppMotion();
  // Rows should rise in only when this mount began with a skeleton phase —
  // i.e. it mounted with loading true (a first fetch with nothing to show).
  // A cached mount starts with loading false and data already present, so its
  // rows render statically: no entrance-animation replay on revisits, and
  // none when the silent revalidate swaps in fresh row objects either. The
  // lazy initializer captures props.loading once, at setup — later flips of
  // the prop must not retro-activate the animation.
  const [animate] = useState(() => props.loading);

  // Id of the card currently playing the "global changed" glow; null = none.
  // The class drops after PULSE_MS so the animation replays on the next flip.
  // Symmetric: every toggle (on OR off) flashes, so the switch always answers
  // the click rather than only celebrating the enable direction.
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Lorebook | null>(null);
  // window.setTimeout (not the global) — bun-types pollutes the ambient
  // timer overloads with a Timeout return, which DOM clearTimeout rejects.
  const pulseTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pulseTimer.current), []);

  const confirmRemove = (): void => {
    const lorebook = pendingDelete;
    if (lorebook === null) {
      return;
    }
    setPendingDelete(null);
    props.onDelete(lorebook);
  };

  const toggleGlobal = (lorebook: Lorebook, enabled: boolean): void => {
    setPulseId(lorebook.id);
    window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulseId(null), PULSE_MS);
    props.onToggleGlobal(lorebook, enabled);
  };

  const countLabel = (): string =>
    `${props.lorebooks.length} ${props.lorebooks.length === 1 ? "lorebook" : "lorebooks"}`;

  /** Skeleton rows shown while the first load is in flight. */
  const skeletonRows = (): ReactNode => (
    <div aria-hidden="true">
      <Stagger className="lore-list">
        {SKELETONS.map((skeleton) => (
          <StaggerItem key={skeleton}>
            <div className="card skeleton-row">
              <div className="skeleton skeleton-avatar" />
              <div className="skeleton-row-lines">
                <div className="skeleton skeleton-line" style={{ width: "40%" }} />
                <div className="skeleton skeleton-line" style={{ width: "65%" }} />
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );

  /** The two empty variants share this animated shell; only the copy differs. */
  const emptyCard = (children: ReactNode): ReactNode => (
    <motion.div
      className="empty-card"
      variants={scaleVariants(app, 0.98)}
      initial="hidden"
      animate="visible"
    >
      <div className="empty-state">{children}</div>
    </motion.div>
  );

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
            placeholder="Search by name or description…"
            aria-label="Search lorebooks"
            value={props.query}
            onChange={(event) => props.onQuery(event.currentTarget.value)}
          />
        </div>
        <span className="caption muted">{countLabel()}</span>
      </div>

      {!props.loading ? (
        props.lorebooks.length > 0 ? (
          <ListStagger animate={animate} className="lore-list">
            {/* AnimatePresence keeps a deleted row mounted through its exit, so
                the list collapses instead of snapping. `initial={animate}`
                lets the cascade play only when this mount began loading —
                matching the container's own gating. */}
            <Presence initial={animate}>
              {props.lorebooks.map((lorebook) => {
                const count = props.counts[lorebook.id];
                const busy = props.busyId === lorebook.id;
                return (
                  <StaggerItem key={lorebook.id}>
                    <article
                      className={cx(
                        "card card-hover lore-card",
                        pulseId === lorebook.id && "lore-card-pulse",
                        busy && "lore-card-busy",
                      )}
                    >
                      {busy && (
                        <span className="lore-card-spinner" aria-hidden="true">
                          <span className="spinner" />
                        </span>
                      )}
                      <span className="lore-icon" aria-hidden="true">
                        <Layers size={18} />
                      </span>
                      <button
                        type="button"
                        className="lore-main"
                        onClick={() => props.onOpen(lorebook)}
                      >
                        <span className="lore-name">{lorebook.name}</span>
                        <span className="caption lore-desc">
                          {lorebook.description === "" ? "No description" : lorebook.description}
                        </span>
                      </button>
                      {/* Trailing controls grouped so mobile can move them as one
                          full-width row below the icon + name. */}
                      <div className="lore-actions">
                        {count !== undefined && (
                          <span className="pill tnum">
                            {count} {count === 1 ? "entry" : "entries"}
                          </span>
                        )}
                        {/* role=switch over the .switch checkbox pattern: the card
                            row owns no <label>, and state lives in the view's store. */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={lorebook.global}
                          className="lore-global"
                          data-tip="Global lorebooks apply in every chat"
                          onClick={() => toggleGlobal(lorebook, !lorebook.global)}
                        >
                          <span className="lore-global-label">Global</span>
                          <span className="lore-global-track" aria-hidden="true">
                            <motion.span
                              className="lore-global-thumb"
                              initial={false}
                              animate={{ x: lorebook.global ? 16 : 0 }}
                              transition={app.reduce ? INSTANT : app.spring.snappy}
                            />
                          </span>
                        </button>
                        {/* A real download: the URL carries the attachment
                            Content-Disposition, and the empty download attribute
                            keeps the browser from navigating away. */}
                        <a
                          className="btn btn-icon"
                          href={exportLorebookUrl(lorebook.id)}
                          download=""
                          aria-label={`Export ${lorebook.name}`}
                          data-tip="Export as JSON"
                        >
                          <Download size={16} />
                        </a>
                        <button
                          type="button"
                          className="btn btn-icon btn-danger"
                          aria-label={`Delete ${lorebook.name}`}
                          data-tip="Delete"
                          onClick={() => setPendingDelete(lorebook)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  </StaggerItem>
                );
              })}
            </Presence>
          </ListStagger>
        ) : props.query.trim() !== "" ? (
          // A search that matched nothing is NOT the same as an empty library:
          // say so and offer the way back rather than the create-first pitch.
          emptyCard(
            <>
              <span className="empty-state-icon" aria-hidden="true">
                <Search size={36} />
              </span>
              <span className="empty-state-title">No results for “{props.query}”</span>
              <span className="empty-state-hint">
                No lorebook name or description matches your search.
              </span>
              <div className="empty-state-actions">
                <button type="button" className="btn" onClick={() => props.onQuery("")}>
                  Clear search
                </button>
              </div>
            </>,
          )
        ) : (
          emptyCard(
            <>
              <span className="empty-state-icon" aria-hidden="true">
                <BookOpen size={36} />
              </span>
              <span className="empty-state-title">No lorebooks yet</span>
              <span className="empty-state-hint">
                Create one, or import SillyTavern world info as JSON.
              </span>
              <div className="empty-state-actions">
                <button type="button" className="btn btn-primary" onClick={props.onCreate}>
                  <Plus size={16} />
                  New lorebook
                </button>
                <button type="button" className="btn" onClick={props.onImport}>
                  <Upload size={16} />
                  Import lorebook
                </button>
              </div>
            </>,
          )
        )
      ) : (
        skeletonRows()
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete lorebook?"
          description={
            <>
              <strong>{pendingDelete.name}</strong> and all of its entries will be deleted.
              Characters using it will simply lose the link.
            </>
          }
          confirmLabel="Delete lorebook"
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmRemove}
        />
      )}
    </div>
  );
}
