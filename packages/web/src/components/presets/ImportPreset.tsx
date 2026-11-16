/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import type { PresetImportConflict, PresetImportResult } from "../../lib/api-presets";
import { importPreset } from "../../lib/api-presets";
import { cx } from "../../lib/cx";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { Check, Info, TriangleAlert, Upload, X } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import { Stagger, StaggerItem } from "../ui/stagger";

interface ImportPresetProps {
  onClose: () => void;
  /** Called after a successful import so the view can revalidate its list. */
  onImported: () => void;
}

/**
 * Tooltip for the conflict policy. Each option is also spelled out in the
 * <option> text; this tip explains what actually happens to the stored row.
 */
const CONFLICT_TIP =
  "What to do when a preset of the same name is already stored. Fail leaves your presets untouched and reports the clash; keep both stores the new file under a numbered name; replace overwrites the existing preset in place.";

/**
 * File picker styled as a button; reports the chosen file, then resets so
 * re-picking the same file fires the change event again. A local copy of the
 * character importer's control — that one is not exported, and this picker
 * only needs the small subset used here.
 *
 * Picking does NOT import: it reads the file as text into the caller, which
 * arms it for the Import button so the conflict policy can still be chosen.
 */
function FileInput(props: { disabled: boolean; onFile: (file: File) => void }): ReactNode {
  return (
    <label className={cx("btn file-button", props.disabled && "disabled")}>
      <Upload size={16} />
      <span>Choose preset file</span>
      <input
        type="file"
        accept=".json,application/json"
        className="file-hidden"
        disabled={props.disabled}
        aria-label="Choose preset file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            props.onFile(file);
          }
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

/**
 * The import dialog's action row. Extracted so Cancel/Import can call
 * `useModalClose()` — the hook must run in a child of <Modal>, never in the
 * component that renders it — so the panel's exit animation plays before the
 * parent unmounts it. `onSubmit` receives the close callback so a SUCCESSFUL
 * import can hand off to the animated close (a failure stays open on the
 * observed error message).
 */
function ImportFooter(props: {
  busy: boolean;
  canImport: boolean;
  onSubmit: (close: () => void) => void;
}): ReactElement {
  const close = useModalClose();
  return (
    <div className="form-footer">
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={props.busy || !props.canImport}
        aria-busy={props.busy}
        onClick={() => props.onSubmit(close)}
      >
        {props.busy && <span className="spinner btn-spinner" aria-hidden="true" />}
        {props.busy ? "Importing…" : "Import"}
      </button>
    </div>
  );
}

/**
 * Modal for importing a preset file. A native Suvoj export and a SillyTavern
 * chat-completion preset are both accepted — the server detects which shape
 * the JSON is, so the UI never asks. The file is parsed client-side and sent
 * as text (a JSON body, not a multipart upload), mirroring lorebook import.
 */
export default function ImportPreset(props: ImportPresetProps) {
  const app = useAppMotion();
  /** Pasted JSON text — used when no file is armed. */
  const [raw, setRaw] = useState("");
  /** The armed file's name + text, read on pick; null until one is chosen. */
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [conflict, setConflict] = useState<PresetImportConflict>("rename");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The JSON text Import sends. Precedence is strict: an armed file always
   * wins over the textarea — the pick was deliberate and its content is
   * exactly the document the user chose (Clear file drops back to the
   * textarea). Whitespace-only content counts as absent, so the button stays
   * disabled rather than letting a blank body reach the server's 400.
   */
  const subject = (): string | null => {
    const text = file?.text ?? raw;
    return text.trim() === "" ? null : text;
  };

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    action()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Import failed"))
      .finally(() => setBusy(false));
  };

  const pickFile = (picked: File): void => {
    setMessage(null);
    setError(null);
    run(async () => {
      const text = await picked.text();
      setFile({ name: picked.name, text });
    });
  };

  const clearFile = (): void => {
    setFile(null);
  };

  /** "Imported <name> (renamed) (replaced existing) (converted from SillyTavern)". */
  const importMessage = (result: PresetImportResult): string => {
    const renamed = result.renamed ? " (renamed)" : "";
    const replaced = result.replaced ? " (replaced existing)" : "";
    const converted = result.source === "sillytavern" ? " (converted from SillyTavern)" : "";
    return `Imported "${result.preset.name}"${renamed}${replaced}${converted}`;
  };

  const submit = (close: () => void): void => {
    const text = subject();
    if (busy || text === null) {
      return;
    }
    setMessage(null);
    run(async () => {
      const result = await importPreset(text, conflict);
      setMessage(importMessage(result));
      // Revalidate the list, then hand off to the modal's animated close.
      props.onImported();
      close();
    });
  };

  return (
    <Modal title="Import preset" onClose={props.onClose}>
      <div className="stack preset-import">
        <p className="field-hint">
          Accepts a preset exported from Suvoj (JSON) or a SillyTavern chat-completion preset — the
          shape is detected automatically. Importing never changes your existing presets unless you
          choose “Replace”.
        </p>

        {/* One disclosure per decision, rising in together on open. The
            container owns the cascade; each section is a StaggerItem so the
            rhythm is identical to every other list reveal in the app. */}
        <Stagger>
          <StaggerItem>
            <section className="transfer-section">
              <h4 className="transfer-title">Preset file</h4>
              <div className="transfer-row">
                <FileInput disabled={busy} onFile={pickFile} />
                <Presence>
                  {file !== null && (
                    <motion.span
                      key="file"
                      className="transfer-file"
                      variants={riseVariants(app)}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <span className="caption muted">{file.name}</span>
                      <button
                        type="button"
                        className="btn btn-icon btn-danger"
                        aria-label="Clear the chosen file"
                        data-tip="Clear file"
                        onClick={clearFile}
                      >
                        <X size={16} />
                      </button>
                    </motion.span>
                  )}
                </Presence>
              </div>
            </section>
          </StaggerItem>

          <StaggerItem>
            <section className="transfer-section">
              <h4 className="transfer-title">Or paste preset JSON</h4>
              <textarea
                className="textarea"
                rows={6}
                placeholder='Paste the preset file contents here, e.g. {"name": …}'
                aria-label="Preset JSON to import"
                value={raw}
                onChange={(event) => setRaw(event.currentTarget.value)}
                disabled={busy}
              />
            </section>
          </StaggerItem>

          <StaggerItem>
            <section className="transfer-section">
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label" htmlFor="preset-import-conflict">
                    If a preset with this name exists
                  </label>
                  <button
                    type="button"
                    className="info-tip"
                    aria-label={CONFLICT_TIP}
                    data-tip={CONFLICT_TIP}
                  >
                    <Info size={13} aria-hidden="true" />
                  </button>
                </div>
                <select
                  id="preset-import-conflict"
                  className="select"
                  aria-label="Duplicate handling"
                  value={conflict}
                  onChange={(event) =>
                    setConflict(event.currentTarget.value as PresetImportConflict)
                  }
                >
                  <option value="error">Fail if a preset with this name exists</option>
                  <option value="rename">Keep both — add a number to the new one</option>
                  <option value="replace">Replace the existing preset</option>
                </select>
              </div>
            </section>
          </StaggerItem>
        </Stagger>

        {/* One shared channel: the stale result clears the moment a new import
            starts, so success and failure can never be shown together. */}
        <Presence mode="wait">
          {message !== null && (
            <motion.p
              key="import-message"
              className="transfer-msg"
              variants={riseVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <Check size={14} />
              {message}
            </motion.p>
          )}
          {error !== null && (
            <motion.p
              key="import-error"
              className="error-banner"
              role="alert"
              variants={riseVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <TriangleAlert size={16} />
              {error}
            </motion.p>
          )}
        </Presence>

        <ImportFooter busy={busy} canImport={subject() !== null} onSubmit={submit} />
      </div>
    </Modal>
  );
}
