/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from "react";
import { useState } from "react";
import { type CharacterFieldKey, generateCharacterField } from "../../lib/api-character-generation";
import { Check, RotateCcw, Sparkles } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";

interface StudioEnhanceModalProps {
  /** Gates the dialog; the studio keeps the component mounted. */
  open: boolean;
  field: CharacterFieldKey;
  label: string;
  characterName: string;
  tags: string[];
  currentText: string;
  /** A compact block of the card's other fields. */
  context: string;
  /** Writes the accepted text into the studio draft. */
  onApply: (text: string) => void;
  onClose: () => void;
}

/**
 * Apply is a child of <Modal> so `useModalClose()` resolves to THIS dialog and
 * the panel's exit animation plays before the studio clears its state.
 */
function ApplyButton(props: { text: string; onApply: (text: string) => void }): ReactElement {
  const close = useModalClose();
  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => {
        props.onApply(props.text);
        close();
      }}
    >
      <Check size={15} />
      Apply
    </button>
  );
}

/**
 * One AI pass over a single card field. Generate when the field is empty,
 * Enhance when it has text; either way the result lands in an editable preview
 * the author can accept or regenerate. The direction box is optional — leaving
 * it empty lets the model follow the card's existing concept.
 */
export default function StudioEnhanceModal(props: StudioEnhanceModalProps) {
  const { open } = props;
  const [idea, setIdea] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every transient field when the dialog opens. Adjusting state during
  // render keeps the reset synchronous, so a previous preview can never flash
  // into the next launch for a frame.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setIdea("");
      setText(null);
      setBusy(false);
      setError(null);
    }
  }

  if (!open) {
    return null;
  }

  const hasName = props.characterName.trim() !== "";
  const enhancing = props.currentText.trim() !== "";
  const verb = enhancing ? "Enhance" : "Generate";

  const run = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await generateCharacterField({
        field: props.field,
        name: props.characterName,
        tags: props.tags,
        idea,
        current_text: props.currentText,
        context: props.context,
      });
      setText(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${verb} ${props.label.toLowerCase()}`} onClose={props.onClose}>
      <p className="caption muted studio-enhance-intro">
        {enhancing ? "Rewrites" : "Writes"} the <strong>{props.label.toLowerCase()}</strong> for{" "}
        <strong>{props.characterName.trim() || "this character"}</strong> from the name, tags, the
        card's other fields, and any direction you give. The result is a preview — Apply writes it
        into the studio draft.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="studio-enhance-direction">
          Direction <span className="studio-enhance-optional">optional</span>
        </label>
        <textarea
          id="studio-enhance-direction"
          className="textarea studio-enhance-direction"
          rows={3}
          placeholder="Keep it terse. Lean into the rivalry. Make the city feel alive."
          value={idea}
          disabled={busy}
          onChange={(event) => setIdea(event.currentTarget.value)}
        />
        <span className="field-hint">
          A tone, a constraint, or a beat to keep. Leave it empty to follow the card as written.
        </span>
      </div>

      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {!hasName && (
        <p className="field-hint" role="status">
          Add a character name first — the generator needs it.
        </p>
      )}

      {text === null ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !hasName}
            onClick={() => void run()}
          >
            {busy ? (
              <span className="spinner btn-spinner" aria-hidden="true" />
            ) : (
              <Sparkles size={16} />
            )}
            {busy ? "Writing…" : verb}
          </button>
        </div>
      ) : (
        <>
          <div className="field">
            <label className="field-label" htmlFor="studio-enhance-preview">
              Preview
            </label>
            <textarea
              id="studio-enhance-preview"
              className="textarea studio-enhance-preview"
              rows={12}
              aria-label={`Generated ${props.label.toLowerCase()} preview`}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
            <span className="field-hint">
              Edit the result before applying — Apply replaces this field in the draft.
            </span>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={busy || !hasName}
              onClick={() => void run()}
            >
              {busy ? (
                <span className="spinner btn-spinner" aria-hidden="true" />
              ) : (
                <RotateCcw size={16} />
              )}
              {busy ? "Writing…" : "Regenerate"}
            </button>
            <ApplyButton text={text} onApply={props.onApply} />
          </div>
        </>
      )}
    </Modal>
  );
}
