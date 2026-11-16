/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef } from "react";
import { cx } from "../../../lib/cx";

/**
 * The raw-JSON editing surface: a real code editor rather than a bare
 * textarea — a line-number gutter, monospace + tabular figures, no soft wrap
 * (so every logical line is exactly one visual row and the gutter stays in
 * register), and a scroll-linked gutter.
 *
 * Validation is NOT owned here: the caller keeps the `editRaw` → `rawError` →
 * `commitSchema` flow and passes the current parse error down, so this
 * component stays a presentation shell around one controlled textarea.
 */
export function JsonEditor(props: {
  value: string;
  onChange: (value: string) => void;
  /** Live parse failure, or null when the current text parses. */
  error: string | null;
  /** Accessible name for the textarea. */
  ariaLabel: string;
  /** DOM id for an external `<label htmlFor>`. */
  id?: string;
}) {
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Every newline is a line; a trailing newline still shows its (empty) next
  // line number, which is what editors do.
  const lineNumbers = props.value.split("\n").map((_, index) => index + 1);

  /** Mirror the textarea's vertical scroll onto the (non-scrolling) gutter.
   *  `white-space: pre` guarantees the two share a line height, so their
   *  scroll offsets line up exactly. */
  const syncScroll = (): void => {
    if (gutterRef.current !== null && areaRef.current !== null) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  };

  return (
    <div className={cx("tracker-json", props.error !== null && "is-invalid")}>
      <div className="tracker-json-gutter" aria-hidden="true" ref={gutterRef}>
        {lineNumbers.map((line) => (
          <span className="tracker-json-lineno tnum" key={line}>
            {line}
          </span>
        ))}
      </div>
      <textarea
        id={props.id}
        ref={areaRef}
        className="textarea tracker-code tracker-json-area"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        wrap="off"
        aria-label={props.ariaLabel}
        value={props.value}
        onScroll={syncScroll}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}
