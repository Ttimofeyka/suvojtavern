/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from "react";
import { useState } from "react";
import {
  type GenerateLorebookEntryInput,
  generateLorebookEntry,
} from "../../lib/api-lorebook-generation";
import { RotateCcw, Sparkles } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";

interface GenerateEntryModalProps {
  /** The entry's current content, sent so the model can extend or rewrite it. */
  currentContent: string;
  /** Writes the accepted text into the editor's content draft. */
  onApply: (text: string) => void;
  onClose: () => void;
}

/**
 * The generator's action row, sharing the app's `.form-footer` convention.
 * Extracted so Apply/Cancel can call `useModalClose()` — the hook must run in a
 * child of <Modal>, never in the component that renders it — so the panel's
 * exit animation plays before the editor unmounts it.
 */
function GenerateEntryFooter(props: {
  busy: boolean;
  hasDescription: boolean;
  hasPreview: boolean;
  onRun: () => void;
  onApply: () => void;
}): ReactElement {
  const close = useModalClose();
  return (
    <div className="form-footer">
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      {props.hasPreview ? (
        <>
          <button
            type="button"
            className="btn"
            disabled={props.busy || !props.hasDescription}
            onClick={props.onRun}
          >
            {props.busy ? (
              <span className="spinner btn-spinner" aria-hidden="true" />
            ) : (
              <RotateCcw size={16} />
            )}
            {props.busy ? "Generating…" : "Regenerate"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              props.onApply();
              close();
            }}
          >
            Apply
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={props.busy || !props.hasDescription}
          onClick={props.onRun}
        >
          {props.busy ? (
            <span className="spinner btn-spinner" aria-hidden="true" />
          ) : (
            <Sparkles size={16} />
          )}
          {props.busy ? "Generating…" : "Generate"}
        </button>
      )}
    </div>
  );
}

/**
 * AI-assisted lorebook-entry generator: a description (plus optional shaping
 * instructions) → a generated preview the user can edit, regenerate, or apply
 * back to the entry editor. Rendered through the shared Modal, so Escape,
 * backdrop close and the exit animation all come from there. Mounted only while
 * open (see the editor), so every transient field resets on a fresh mount.
 */
export default function GenerateEntryModal(props: GenerateEntryModalProps): ReactElement {
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  /** The generated (editable) text; null until the first successful run. */
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The endpoint requires a non-empty description (min 1) and answers 400
  // otherwise; blocking here turns that cryptic server error into an
  // in-context hint. Instructions are deliberately optional — the concept is
  // the only required input.
  const hasDescription = description.trim() !== "";

  /** One generation pass, shared by Generate and Regenerate. */
  const run = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: GenerateLorebookEntryInput = {
        description,
        instructions,
        current_content: props.currentContent,
      };
      const result = await generateLorebookEntry(input);
      setText(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Generate entry content" onClose={props.onClose}>
      <p className="caption muted">
        Generates the entry's <strong>content</strong> from your description. The result is a
        preview — Apply writes it into the editor's content draft.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="entry-gen-description">
          Describe the entry
        </label>
        <textarea
          id="entry-gen-description"
          className="textarea"
          rows={5}
          placeholder="A smuggling guild in the lower docks…"
          aria-label="Entry description"
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <span className="field-hint">
          The lore concept to write about — places, factions, people, rules.
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="entry-gen-instructions">
          Instructions
        </label>
        <textarea
          id="entry-gen-instructions"
          className="textarea"
          rows={3}
          aria-label="Transformation instructions"
          value={instructions}
          disabled={busy}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
        <span className="field-hint">
          Optional — shape or transform the description (tone, length, angle).
        </span>
      </div>

      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {!hasDescription && (
        <p className="field-hint" role="status">
          Describe the entry first — the generator needs a concept.
        </p>
      )}

      {text !== null && (
        <div className="field">
          <label className="field-label" htmlFor="entry-gen-preview">
            Preview
          </label>
          <textarea
            id="entry-gen-preview"
            className="textarea"
            rows={12}
            aria-label="Generated entry content preview"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
          <span className="field-hint">
            Edit the result before applying — Apply replaces the entry content draft.
          </span>
        </div>
      )}

      <GenerateEntryFooter
        busy={busy}
        hasDescription={hasDescription}
        hasPreview={text !== null}
        onRun={() => void run()}
        onApply={() => {
          if (text !== null) {
            props.onApply(text);
          }
        }}
      />
    </Modal>
  );
}
