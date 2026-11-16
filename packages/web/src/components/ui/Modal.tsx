/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AnimatePresence, motion } from "motion/react";
import type { MouseEvent, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import { backdropVariants, panelVariants, useAppMotion } from "../../lib/motion";
import { X } from "./icons";

/** Centered dialog overlay with a close button, Escape-to-close,
 *  backdrop-click-to-close, and minimal focus management (focus enters
 *  the panel on mount and returns to the previously focused element on
 *  close). Entrance and exit both run through Motion (a spring panel pop over
 *  a fading scrim) so the close is a real animation rather than an unmount;
 *  the panel keeps its base.css surface via the modal-* classes.
 *  Rendered through a portal into <body>: views run entrance animations
 *  and any transformed ancestor would become the containing block of the
 *  overlay's position: fixed, breaking viewport centering.
 *
 *  Animated close for panel-owned buttons: Modal's own close paths (the X,
 *  Escape, the backdrop) already run through `requestClose`, but a panel's
 *  Cancel/Save/Apply button typically calls the parent `onClose` directly and
 *  the modal then unmounts with no exit. Panels should call `useModalClose()`
 *  for those buttons so their exit plays too. `requestClose` is idempotent and
 *  stable: repeated calls after the first are no-ops and the identity never
 *  changes, so it is safe to read once and hand to several handlers. The hook
 *  resolves by React tree to the NEAREST enclosing <Modal> (nested editors get
 *  their own, not the outer modal's) and throws when used outside one — see
 *  ModalCloseContext below. */

// Open Modal instances, in mount order. Parents register before the children
// they open (an EntryEditor inside a LorebookEditor), so the last entry is
// always the innermost open modal. Window listeners fire in registration
// order — the outer modal of a stack registers first — so onKey must
// explicitly hand the Escape key to the stack top, or one press would close
// the outer modal and take the nested ones down with it. The acting handler
// calls preventDefault, consuming the event for any other Escape listener.
const closers: (() => void)[] = [];

/**
 * The open Modal's animated close, exposed to everything rendered inside its
 * panel (the header actions AND the body children). Consume it with
 * `useModalClose()`; the raw context is exported so a panel can lower the
 * provider or assert on it in a test.
 *
 * The default is `null` rather than a no-op: an accidental use outside a
 * modal should fail loudly at development time, not silently drop the click.
 */
export const ModalCloseContext = createContext<(() => void) | null>(null);

/**
 * Route a panel-owned button (Cancel/Save/Apply) through the enclosing
 * <Modal>'s animated close instead of the parent's `onClose`, so the panel's
 * exit animation actually plays before the parent unmounts it.
 *
 * Call it from a component rendered inside the modal — the header actions or
 * any body child. Do NOT call it in the component that renders the <Modal>:
 * that component sits above the provider, so a top-level modal would throw and
 * a nested one would resolve to the OUTER modal's close. Extract the buttons
 * into a child component instead.
 *
 * The returned function is stable for the modal's lifetime and idempotent
 * (backed by `requestClose`), so it is safe to read once and reuse.
 *
 * @throws if called outside any <Modal> descendant.
 */
export function useModalClose(): () => void {
  const close = useContext(ModalCloseContext);
  if (close === null) {
    throw new Error(
      "useModalClose() must be called by a component rendered inside a <Modal> " +
        "(a header action or a body child). The component that renders the " +
        "<Modal> sits above its provider and cannot use this hook.",
    );
  }
  return close;
}

export default function Modal(props: {
  title: string;
  /** Body content; a fixed cross-agent contract, hence the loose ReactNode. */
  children?: ReactNode;
  onClose: () => void;
  /** Wide variant for large editors (adds .modal-wide — see base.css). */
  wide?: boolean;
  /** Extra-wide near-fullscreen variant (adds .modal-xl — see base.css):
   *  a pinned header with only the body scrolling, for big visual editors. */
  xl?: boolean;
  /** Optional header actions rendered before the close button. */
  actions?: ReactNode;
}) {
  const { onClose } = props;
  const app = useAppMotion();

  // `requestClose` must keep one identity for the component's lifetime — the
  // Escape stack and its cleanup key entries by identity — so route the latest
  // `onClose` prop through a ref instead of recreating the callback per render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Exit choreography: a close request does NOT call props.onClose immediately.
  // It flips this local flag, AnimatePresence plays the panel's `exit`, and only
  // when that finishes do we hand control back to the parent (which normally
  // unmounts us). This is what gives every existing call site a real close
  // animation without changing a single one of them.
  const [closing, setClosing] = useState(false);
  // Mirror of `closing` for the stable callback: reading state would re-create
  // `requestClose` (and re-register the Escape listener) on every close.
  const closingRef = useRef(false);

  const requestClose = useCallback((): void => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
  }, []);

  const handleExitComplete = useCallback((): void => {
    onCloseRef.current();
  }, []);

  // Minimal dialog focus management (no full trap): the panel receives
  // focus on mount (it is programmatically focusable via tabIndex={-1}
  // despite role="dialog"), and cleanup hands focus back to the element
  // that had it when the modal opened.
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    closers.push(requestClose);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        // Not an Escape, or someone already consumed it.
        return;
      }
      if (closers[closers.length - 1] !== requestClose) {
        // A modal is stacked above this one — it owns the Escape.
        return;
      }
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);

    const restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", onKey);
      // Guarded: the remembered element may have left the document while the
      // modal was open (its view unmounted, its row deleted).
      if (restoreFocus?.isConnected) {
        restoreFocus.focus();
      }
      const index = closers.indexOf(requestClose);
      if (index !== -1) {
        closers.splice(index, 1);
      }
    };
  }, [requestClose]);

  // Close only on direct clicks on the scrim itself, not the panel.
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  };

  return createPortal(
    // `initial` is explicit: unlike most Presence call sites, a modal's mount
    // IS the entrance and must play.
    <AnimatePresence initial onExitComplete={handleExitComplete}>
      {!closing && (
        <motion.div
          key="overlay"
          className="modal-overlay"
          variants={backdropVariants(app)}
          initial="hidden"
          animate="visible"
          exit="exit"
          onMouseDown={onBackdrop}
        >
          <motion.div
            ref={panelRef}
            className={cx(
              "card stack modal-panel",
              props.wide === true && "modal-wide",
              props.xl === true && "modal-xl",
            )}
            role="dialog"
            aria-modal="true"
            aria-label={props.title}
            tabIndex={-1}
            variants={panelVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {/* The provider wraps the whole panel — header BEFORE body — so a
                panel can route BOTH its header actions (the usual
                Cancel/Save/Apply row) and any body child through the animated
                close. Scoping it to just the body would leave header buttons
                unable to animate; the value is a stable callback so wrapping
                one extra DOM branch costs nothing. Nested modals mount their
                own provider deeper in the tree, so a consumer always resolves
                to the nearest <Modal>. */}
            <ModalCloseContext.Provider value={requestClose}>
              <div className="row modal-head" style={{ justifyContent: "space-between" }}>
                <h3>{props.title}</h3>
                {/* Header actions and the close button share one flex group. The
                    head uses space-between, so direct children would scatter the
                    action into the middle; grouping keeps it next to Close, and
                    with no actions this is visually identical to before. */}
                <div className="row">
                  {props.actions}
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label="Close dialog"
                    onClick={requestClose}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              {/* The body wrapper keeps the old single-stack layout (same gaps
                  with the header) while giving .modal-xl a scroll container. */}
              <div className="stack modal-body">{props.children}</div>
            </ModalCloseContext.Provider>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
