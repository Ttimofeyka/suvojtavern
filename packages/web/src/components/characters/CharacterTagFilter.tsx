/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { INSTANT, useAppMotion } from "../../lib/motion";
import { pageCount, pageSlice } from "../../lib/pagination";
import { useIsMobile } from "../../lib/use-viewport";
import { ChevronLeft, ChevronRight, Search, X } from "../ui/icons";

/** Tag chips shown per page. A cast can carry tens or hundreds of distinct
 *  tags, so the filter strip paginates instead of dumping every chip into the
 *  toolbar; the breakpoint maps to a shorter window on a phone, mirroring the
 *  grid's viewport-derived page size. */
const TAG_PAGE_SIZE_MOBILE = 8;
const TAG_PAGE_SIZE_DESKTOP = 16;

export interface CharacterTagFilterProps {
  /** Distinct tags across the whole filtered set (the server facet, which
   *  ignores paging) — not just the tags on the loaded rows. */
  tags: string[];
  /** The selected tags. A character must carry ALL of them (AND), so each
   *  added chip narrows the result; empty means no tag filter. */
  value: string[];
  /** Replaces the selection: a chip toggle, "All tags"/clear ([]), or a
   *  removal of a pinned chip. */
  onChange: (next: string[]) => void;
}

/** Toggles one tag in/out of the selection, keeping the existing order. */
function toggleTag(value: string[], tag: string): string[] {
  return value.includes(tag) ? value.filter((item) => item !== tag) : [...value, tag];
}

/**
 * The tag filter strip: a mini name search, an always-present "All tags" chip,
 * one bounded page of tag chips, and a compact pager when more tags exist.
 * Chips are multi-select — clicking one toggles it, and a character must carry
 * every selected tag. The mini search narrows the tags client-side (the facet
 * is already loaded whole). Any selected tag that is not on the visible page is
 * pinned beside "All tags", so the whole selection is always on screen — and
 * always removable — even after a search or a narrowed facet hides its chip.
 */
export default function CharacterTagFilter(props: CharacterTagFilterProps) {
  const app = useAppMotion();
  const isMobile = useIsMobile();
  const pageSize = isMobile ? TAG_PAGE_SIZE_MOBILE : TAG_PAGE_SIZE_DESKTOP;
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");

  // Case-insensitive name filter over the facet. A blank query shows every tag.
  const needle = query.trim().toLowerCase();
  const matches =
    needle === "" ? props.tags : props.tags.filter((tag) => tag.toLowerCase().includes(needle));

  const pages = pageCount(matches.length, pageSize);
  // A search or tag filter can shrink the facet under the page on screen;
  // settle on the last page that still exists instead of rendering an empty
  // strip. The effect writes the clamp back so the pager never lies.
  const current = Math.min(page, pages);
  useEffect(() => {
    if (page !== current) {
      setPage(current);
    }
  }, [page, current]);

  const slice = pageSlice(matches, current, pageSize);
  // Selected tags with no chip on the visible page, kept in selection order.
  const pinned = props.value.filter((tag) => !slice.items.includes(tag));

  return (
    <fieldset className="chip-row tag-filter" aria-label="Filter by tag">
      {props.tags.length > 0 && (
        <div className="tag-filter-search">
          <span className="search-icon" aria-hidden="true">
            <Search size={14} />
          </span>
          <input
            className="input"
            type="search"
            placeholder="Find a tag…"
            aria-label="Search tags"
            value={query}
            // A new query re-pages the (now shorter) result from the top.
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
            }}
          />
        </div>
      )}
      <motion.button
        type="button"
        className="chip"
        layout
        aria-pressed={props.value.length === 0}
        whileTap={app.reduce ? undefined : { scale: 0.96 }}
        transition={app.reduce ? INSTANT : app.spring.snappy}
        onClick={() => props.onChange([])}
      >
        All tags
      </motion.button>
      {pinned.map((tag) => (
        <motion.button
          type="button"
          className="chip"
          key={tag}
          layout
          aria-pressed
          whileTap={app.reduce ? undefined : { scale: 0.96 }}
          transition={app.reduce ? INSTANT : app.spring.snappy}
          onClick={() => props.onChange(toggleTag(props.value, tag))}
        >
          {tag}
          <X size={12} aria-hidden="true" />
        </motion.button>
      ))}
      {slice.items.map((tag) => (
        <motion.button
          type="button"
          className="chip"
          key={tag}
          layout
          aria-pressed={props.value.includes(tag)}
          whileTap={app.reduce ? undefined : { scale: 0.96 }}
          transition={app.reduce ? INSTANT : app.spring.snappy}
          onClick={() => props.onChange(toggleTag(props.value, tag))}
        >
          {tag}
        </motion.button>
      ))}
      {needle !== "" && matches.length === 0 && (
        <span className="caption tag-filter-empty">No tags match</span>
      )}
      {pages > 1 && (
        <span className="tag-filter-pager">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Previous tags"
            data-tip="Previous tags"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="caption tag-filter-count tnum">
            {current}/{pages}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Next tags"
            data-tip="Next tags"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </span>
      )}
    </fieldset>
  );
}
