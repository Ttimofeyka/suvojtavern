/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { purgeCharacters } from "../../lib/api-characters";
import { fadeVariants, useAppMotion } from "../../lib/motion";
import { Check, TriangleAlert } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import "../../styles/characters.css";

interface PurgeProps {
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Purge dialog footer. Cancel/Done route through `useModalClose()` — extracted
 * into a child of <Modal> so the hook has a provider to resolve and the panel's
 * exit animation plays before the parent unmounts it.
 */
function PurgeFooter(props: {
  deleted: number | null;
  busy: boolean;
  onPurge: () => void;
}): ReactElement {
  const close = useModalClose();
  return (
    <div className="form-footer">
      <button type="button" className="btn" onClick={close}>
        {props.deleted === null ? "Cancel" : "Done"}
      </button>
      {props.deleted === null && (
        <button
          type="button"
          className="btn btn-danger"
          disabled={props.busy}
          onClick={props.onPurge}
        >
          {props.busy ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <TriangleAlert size={16} />
          )}
          {props.busy ? "Purging…" : "Purge"}
        </button>
      )}
    </div>
  );
}

/** Modal that deletes every chat-less character after an explicit confirm. */
export default function PurgeUnused(props: PurgeProps) {
  const app = useAppMotion();
  const [deleted, setDeleted] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purge = (): void => {
    setBusy(true);
    setError(null);
    purgeCharacters()
      .then((result) => {
        setDeleted(result.deleted_ids.length);
        props.onChanged();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Purge failed");
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Purge unused characters" onClose={props.onClose}>
      <div className="stack">
        <div className="purge-warning">
          <span className="purge-warning-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <div className="char-purge-copy">
            <p className="purge-warning-title">Delete every character that has zero chats?</p>
            <p className="caption muted">
              Their gallery images and any imported card data go with them. This cannot be undone.
            </p>
          </div>
        </div>
        <Presence>
          {deleted !== null && (
            <motion.p
              className="badge badge-success"
              variants={fadeVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <Check size={12} />
              Deleted {deleted} character(s)
            </motion.p>
          )}
        </Presence>
        {error !== null && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <PurgeFooter deleted={deleted} busy={busy} onPurge={purge} />
      </div>
    </Modal>
  );
}
