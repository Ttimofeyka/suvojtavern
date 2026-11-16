/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pageCount } from "../../lib/pagination";
import { ChevronLeft, ChevronRight } from "../ui/icons";

export interface CharacterPageNavProps {
  /** 1-based page the loaded rows belong to. */
  page: number;
  /** Rows requested per page (viewport-derived: the pickers use
   *  characterPickerPageSize, the management screen charactersViewPageSize). */
  pageSize: number;
  /** Rows currently rendered (one page's worth in pages mode). */
  loaded: number;
  /** Unpaged match count for the committed query. */
  total: number;
  /** True while a page fetch is airborne — the nav disables both buttons. */
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Discrete prev/next footer for the page-mode character lists — the pickers
 * (New Chat / welcome wizard) and the Characters management screen. A dumb
 * presentational mirror of the lorebook editor's `.entry-pagination` controls:
 * it owns no paging state (the owner does) and derives every displayed value
 * from its props, so it stays trivially testable and reusable across surfaces.
 * The range caption is always shown; the page controls only appear once there
 * is more than one page to navigate.
 */
export default function CharacterPageNav(props: CharacterPageNavProps) {
  if (props.total <= 0) {
    return null;
  }

  const pages = pageCount(props.total, props.pageSize);
  // 1-based inclusive range of the rows on this page. An empty page (a jump
  // that landed after a deletion, before its fetch settles) reports 0–0 like
  // the lorebook's `pageSlice`, rather than a negative end.
  const start = props.loaded === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const end = props.loaded === 0 ? 0 : start + props.loaded - 1;

  return (
    <div className="char-page-nav">
      {pages > 1 && (
        <div className="char-page-controls">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Previous page"
            data-tip="Previous page"
            disabled={props.busy || props.page <= 1}
            onClick={() => props.onPrev()}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="char-page-status tnum">
            Page {props.page} of {pages}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Next page"
            data-tip="Next page"
            disabled={props.busy || props.page >= pages}
            onClick={() => props.onNext()}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <span className="caption muted char-page-range tnum">
        Showing {start}–{end} of {props.total}
      </span>
    </div>
  );
}
