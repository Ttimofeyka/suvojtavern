/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from "react";

/** How far below the viewport the sentinel still counts as "near the bottom". */
const SENTINEL_MARGIN_PX = 300;

export interface CharacterListMoreProps {
  /** Rows already rendered, for the "Showing X of Y" caption. */
  loaded: number;
  /** Unpaged match count for the current query. */
  total: number;
  /** True while a follow-up page is in flight. */
  loadingMore: boolean;
  /** True when another page can still be requested. */
  hasMore: boolean;
  onLoadMore: () => void;
  /** Auto-fetch when this footer scrolls into view (grids and tile pickers).
   *  Left off for `<select>` pickers, where the button is the only affordance. */
  sentinel?: boolean;
}

/**
 * Shared "load more" footer for the paged character pickers: an optional
 * scroll sentinel (grids/tiles), an explicit button for keyboard/AT users and
 * as the fallback when the sentinel's page does not fill the viewport, and a
 * "Showing X of Y" status caption. The button and sentinel both route through
 * `onLoadMore`, whose caller guards against concurrent fetches.
 */
export default function CharacterListMore(props: CharacterListMoreProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Route the latest callback through a ref so the observer effect below keeps
  // a stable dependency set: a new onLoadMore identity each render must not
  // tear down and re-create the IntersectionObserver.
  const onLoadMoreRef = useRef(props.onLoadMore);
  onLoadMoreRef.current = props.onLoadMore;

  // Observes the sentinel while the footer offers another page. The effect
  // re-runs when that gate flips, so the observer is attached to (and
  // disconnected from) the live element instead of leaking across remounts —
  // e.g. when the last page unmounts the sentinel.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!props.sentinel || !props.hasMore || props.total <= 0 || el === null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: `0px 0px ${SENTINEL_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.sentinel, props.hasMore, props.total]);

  if (props.total <= 0) {
    return null;
  }

  return (
    <div className="char-list-more">
      {props.hasMore && (
        <>
          {/* The sentinel sits above the button; when the sentinel scrolls
              into view it triggers the same guarded loadMore. */}
          {props.sentinel && (
            <div ref={sentinelRef} className="char-list-more-sentinel" aria-hidden="true" />
          )}
          <button
            type="button"
            className="btn btn-ghost char-list-more-btn"
            disabled={props.loadingMore}
            onClick={() => props.onLoadMore()}
          >
            {props.loadingMore && <span className="spinner" aria-hidden="true" />}
            {props.loadingMore ? "Loading…" : "Load more"}
          </button>
        </>
      )}
      <span className="caption muted char-list-more-status">
        Showing {Math.min(props.loaded, props.total)} of {props.total}
      </span>
    </div>
  );
}
