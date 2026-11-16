/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DragEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { cx } from "../../lib/cx";

export interface DropZoneProps {
  accept: string;
  icon: ReactNode;
  title: string;
  hint: string;
  /** Shows a spinner in place of the icon and swallows picks and drops. */
  busy?: boolean;
  /** Copy shown while a running import keeps the zone locked. */
  busyTitle?: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}

/**
 * File target shared by the card and chat tabs: dropping anywhere on the zone
 * or pressing the single focusable button opens the picker. The input itself
 * stays display:none and out of the tab order, so keyboard users get one
 * obvious control instead of an invisible one.
 */
export default function DropZone(props: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);
  const busy = props.busy === true;
  const disabled = props.disabled === true;
  const locked = busy || disabled;

  const pick = (file: File | undefined): void => {
    if (file !== undefined) {
      props.onFile(file);
    }
  };

  const allowDrop = (event: DragEvent<HTMLButtonElement>): boolean => {
    // Always swallow the browser default: a drop while the zone is locked must
    // not navigate away to the file, even though no import starts.
    event.preventDefault();
    return !locked;
  };

  return (
    <div
      className={cx(
        "char-dropzone",
        "char-transfer-drop",
        over && "is-over",
        disabled && "is-disabled",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={props.accept}
        className="file-hidden"
        disabled={locked}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          pick(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="char-dropzone-target"
        aria-disabled={locked || undefined}
        aria-describedby={hintId}
        onClick={() => {
          if (!locked) {
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => {
          if (allowDrop(event)) {
            setOver(true);
          }
        }}
        onDragOver={(event) => {
          allowDrop(event);
        }}
        onDragLeave={(event) => {
          // Ignore the transient leave fired when the drag crosses into a child.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOver(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (locked) {
            return;
          }
          setOver(false);
          pick(event.dataTransfer.files?.[0]);
        }}
      >
        <span className={cx("char-dropzone-badge", over && "is-over")} aria-hidden="true">
          {busy ? <span className="spinner" /> : props.icon}
        </span>
        <span className="char-dropzone-title">
          {busy ? (props.busyTitle ?? "Importing…") : props.title}
        </span>
        <span className="char-dropzone-hint" id={hintId}>
          {busy ? "This can take a moment." : props.hint}
        </span>
      </button>
    </div>
  );
}
