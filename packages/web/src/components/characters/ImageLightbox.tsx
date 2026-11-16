/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { MouseEvent } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { backdropVariants, scaleVariants, useAppMotion } from "../../lib/motion";
import { X } from "../ui/icons";

interface ImageLightboxProps {
  /** Served blob URL of the full-size image. */
  src: string;
  /** Accessible label / alt text (e.g. "Character gallery image 2 of 5"). */
  label: string;
  onClose: () => void;
}

/** Full-screen, contain-fit image viewer. Presentational only — no fetching,
 *  prev/next or zoom/pan (explicitly out of scope). Both entrance and exit run
 *  through Motion (the parent wraps it in Presence, so a close is a real
 *  animation rather than an unmount); the panel keeps its views.css layout.
 *  Rendered through a portal into <body>: the gallery lives inside a modal
 *  whose ancestors can carry a transform, and a transformed ancestor would
 *  become the containing block of the overlay's position: fixed, breaking
 *  viewport centering. */
export default function ImageLightbox(props: ImageLightboxProps) {
  const app = useAppMotion();
  // Minimal dialog focus management, mirroring Modal: the panel receives
  // focus on mount (programmatically focusable via tabIndex={-1}) and cleanup
  // hands focus back to whatever had it when the viewer opened.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Keep the latest onClose reachable from the mount-once key listener without
  // re-registering it on every render (the Solid handler read the live prop).
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    // Capture-phase on purpose. The gallery modal underneath registers a
    // BUBBLE-phase Escape handler (Modal's `closers` stack); a capture listener
    // on window always runs first regardless of registration order, so stopping
    // propagation here keeps a single Escape press from also closing the modal
    // we were opened from. preventDefault marks the event consumed for any
    // other listener that still sees it.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      onCloseRef.current();
    };

    window.addEventListener("keydown", onKey, true);
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Guarded: the remembered element may have left the document while the
      // viewer was open (its tile deleted, its view unmounted).
      const restoreFocus = restoreFocusRef.current;
      if (restoreFocus?.isConnected) {
        restoreFocus.focus();
      }
    };
  }, []);

  // Close only on direct clicks on the backdrop itself, not the panel/image,
  // so dragging off the image does not dismiss the viewer.
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  };

  return createPortal(
    <motion.div
      className="lightbox-overlay char-lightbox"
      variants={backdropVariants(app)}
      initial="hidden"
      animate="visible"
      exit="exit"
      onMouseDown={onBackdrop}
    >
      <motion.div
        ref={panelRef}
        className="lightbox-panel char-lightbox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        variants={scaleVariants(app, 0.96)}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <button
          type="button"
          className="btn btn-icon lightbox-close"
          aria-label="Close image"
          onClick={() => props.onClose()}
        >
          <X size={18} />
        </button>
        <img className="lightbox-image" src={props.src} alt={props.label} />
      </motion.div>
    </motion.div>,
    document.body,
  );
}
