/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useState } from "react";
import type { CardImportResult, ImportConflict } from "../../lib/api-transfer";
import { importCard } from "../../lib/api-transfer";
import { fadeVariants, riseVariants, useAppMotion } from "../../lib/motion";
import { Check, Drama, ExternalLink, FileImage, MessageCircle, TriangleAlert } from "../ui/icons";
import Modal from "../ui/Modal";
import { Presence } from "../ui/presence";
import type { SegmentedOption } from "../ui/segmented";
import { Segmented } from "../ui/segmented";
import ChatImportPanel from "./ChatImportPanel";
import ConflictPicker from "./ConflictPicker";
import DropZone from "./DropZone";
import UrlImportSection from "./UrlImportSection";
import "../../styles/characters.css";

interface TransferProps {
  onClose: () => void;
  onChanged: () => void;
}

/** The three jobs the old single form mixed together. */
type TransferTab = "card" | "link" | "chat";

const TABS: readonly SegmentedOption<TransferTab>[] = [
  {
    value: "card",
    label: (
      <span className="char-transfer-tab">
        <Drama size={14} />
        Character card
      </span>
    ),
  },
  {
    value: "link",
    label: (
      <span className="char-transfer-tab">
        <ExternalLink size={14} />
        From link
      </span>
    ),
  },
  {
    value: "chat",
    label: (
      <span className="char-transfer-tab">
        <MessageCircle size={14} />
        Chat
      </span>
    ),
  },
];

/** Import dialog: one tab per source, each with its own explanation, action,
 *  and feedback. The duplicate-name choice is shared by both card tabs. */
export default function ImportExport(props: TransferProps) {
  const app = useAppMotion();
  const [tab, setTab] = useState<TransferTab>("card");
  const [conflict, setConflict] = useState<ImportConflict>("rename");
  const [cardMsg, setCardMsg] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyOwner, setBusyOwner] = useState<TransferTab | null>(null);

  /** One import lock for the whole dialog: a running import disables every
   *  action, while `busyOwner` lets the tab that started it show a spinner. */
  const run = (owner: TransferTab, action: () => Promise<void>): void => {
    setBusy(true);
    setBusyOwner(owner);
    void action()
      .catch((err: unknown) => {
        // Sections handle their own failures; this only keeps a card import
        // from rejecting into the void.
        if (owner === "card") {
          setCardError(err instanceof Error ? err.message : "Import failed");
        }
      })
      .finally(() => {
        setBusy(false);
        setBusyOwner(null);
      });
  };

  const importCardFile = (file: File): void => {
    setCardMsg(null);
    setCardError(null);
    run("card", async () => {
      const result: CardImportResult = await importCard(file, conflict);
      const lorebook = result.lorebook === null ? "" : ` with lorebook "${result.lorebook.name}"`;
      setCardMsg(
        `Imported "${result.character.name}"${result.renamed ? " (renamed)" : ""}${lorebook}`,
      );
      props.onChanged();
    });
  };

  return (
    <Modal title="Import" onClose={props.onClose}>
      <div className="stack char-transfer">
        <p className="caption muted char-transfer-intro">
          Bring a character card or a SillyTavern chat into this library.
        </p>

        <Segmented
          className="char-transfer-tabs"
          options={TABS}
          value={tab}
          onChange={setTab}
          ariaLabel="Import source"
        />

        <Presence mode="wait">
          <motion.div
            key={tab}
            className="char-transfer-panel"
            variants={riseVariants(app, 6)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {tab === "card" && (
              <>
                <header className="char-transfer-panel-head">
                  <span className="char-transfer-panel-icon" aria-hidden="true">
                    <Drama size={20} />
                  </span>
                  <div className="char-transfer-panel-copy">
                    <h4 className="char-transfer-panel-title">Import a character card</h4>
                    <p className="char-transfer-panel-desc">
                      A SillyTavern PNG or any card JSON. The avatar, every field, and an embedded
                      lorebook come along.
                    </p>
                  </div>
                </header>

                <DropZone
                  accept=".png,.json"
                  icon={<FileImage size={22} />}
                  title="Drop a card file here"
                  hint="PNG or JSON · or click to browse"
                  busy={busyOwner === "card"}
                  busyTitle="Importing card…"
                  disabled={busy && busyOwner !== "card"}
                  onFile={importCardFile}
                />

                <Presence>
                  {cardMsg !== null && (
                    <motion.p
                      className="transfer-msg"
                      variants={fadeVariants(app)}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <Check size={14} />
                      {cardMsg}
                    </motion.p>
                  )}
                </Presence>

                {cardError !== null && (
                  <p className="error-banner" role="alert">
                    <TriangleAlert size={16} />
                    {cardError}
                  </p>
                )}

                <div className="char-group">
                  <div className="char-group-head">
                    <h5 className="char-group-title">Card options</h5>
                  </div>
                  <ConflictPicker value={conflict} disabled={busy} onChange={setConflict} />
                </div>
              </>
            )}

            {tab === "link" && (
              <UrlImportSection
                conflict={conflict}
                onConflictChange={setConflict}
                busy={busy}
                run={(action) => run("link", action)}
                onChanged={props.onChanged}
              />
            )}

            {tab === "chat" && (
              <ChatImportPanel
                busy={busy}
                importing={busyOwner === "chat"}
                run={(action) => run("chat", action)}
                onChanged={props.onChanged}
              />
            )}
          </motion.div>
        </Presence>
      </div>
    </Modal>
  );
}
