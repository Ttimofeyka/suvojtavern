/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement, ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import "../../styles/confirm.css";
import { cx } from "../../lib/cx";
import Modal, { useModalClose } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` paints the primary action in the destructive tint. */
  tone?: "default" | "danger";
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Animated replacement for `window.confirm`.
 *
 * The confirmation happens AFTER the panel's exit finishes: the body's confirm
 * button only flags the decision and asks <Modal> to close, then Modal's
 * `onClose` runs when the exit completes. That keeps the panel's Motion exit
 * intact instead of unmounting it on the same frame as the click.
 */
function ConfirmBody(props: {
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: "default" | "danger";
  onConfirm: () => void;
}): ReactElement {
  const close = useModalClose();
  return (
    <div className="confirm-dialog">
      <div className="confirm-dialog-copy">{props.description}</div>
      <div className="confirm-dialog-actions">
        <button type="button" className="btn" onClick={close}>
          {props.cancelLabel}
        </button>
        <button
          type="button"
          className={cx("btn", props.tone === "danger" ? "btn-danger" : "btn-primary")}
          onClick={() => {
            props.onConfirm();
            close();
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    </div>
  );
}

export default function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  // The flag lets Modal's single close path distinguish "confirmed" from
  // "dismissed" (X, Escape, backdrop, Cancel) when its exit completes.
  const confirmedRef = useRef(false);
  return (
    <Modal
      title={props.title}
      onClose={() => {
        if (confirmedRef.current) {
          props.onConfirm();
        } else {
          props.onClose();
        }
      }}
    >
      <ConfirmBody
        description={props.description}
        confirmLabel={props.confirmLabel}
        cancelLabel={props.cancelLabel ?? "Cancel"}
        tone={props.tone ?? "default"}
        onConfirm={() => {
          confirmedRef.current = true;
        }}
      />
    </Modal>
  );
}

/** The props one confirmation request carries, minus the close handlers. */
export interface ConfirmDialogRequest {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
}

/**
 * Own the pending request for a component that asks for one confirmation at a
 * time. Render `dialog` somewhere in the component's tree; call `confirm` from
 * the action that needs sign-off. Keeping the action in the request means the
 * delete/edit code stays where it already lives.
 */
export function useConfirmDialog(): {
  confirm: (request: ConfirmDialogRequest) => void;
  dialog: ReactElement | null;
} {
  const [pending, setPending] = useState<ConfirmDialogRequest | null>(null);
  const confirm = useCallback((request: ConfirmDialogRequest) => {
    setPending(request);
  }, []);

  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        title={pending.title}
        description={pending.description}
        confirmLabel={pending.confirmLabel}
        cancelLabel={pending.cancelLabel}
        tone={pending.tone}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const action = pending.onConfirm;
          setPending(null);
          action();
        }}
      />
    );

  return { confirm, dialog };
}
