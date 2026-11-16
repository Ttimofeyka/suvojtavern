/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { Persona } from "../../lib/api-personas";
import { createPersona, updatePersona, uploadPersonaAvatar } from "../../lib/api-personas";
import { cx } from "../../lib/cx";
import { fadeVariants, INSTANT, useAppMotion } from "../../lib/motion";
import { Trash2, User } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import "../../styles/characters.css";

interface PersonaEditorProps {
  /** Existing persona to edit, or null to create a new one. */
  persona: Persona | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * The persona editor's header actions. Extracted so Cancel can call
 * `useModalClose()` — the hook must run in a child of <Modal>, never in the
 * component that renders it — so the panel's exit animation plays before the
 * parent unmounts it. Save submits the body form through its id, matching
 * CharacterEditor's header Save (the two editors share one footer placement).
 */
function PersonaEditorActions(props: { saving: boolean }): ReactElement {
  const close = useModalClose();
  return (
    <>
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      <button
        type="submit"
        form="persona-editor-form"
        className="btn btn-primary"
        disabled={props.saving}
      >
        {props.saving ? "Saving…" : "Save"}
      </button>
    </>
  );
}

/** Modal editor for a persona's fields; the avatar is picked or dropped, never typed. */
export default function PersonaEditor(props: PersonaEditorProps) {
  const app = useAppMotion();
  // The editor is mounted per open and reads its persona exactly once (the
  // Solid setup contract): a re-render from the parent must never reset the
  // draft, so the prop is captured on first render and the fields below seed
  // their lazy initial state from it.
  const personaRef = useRef(props.persona);
  const persona = personaRef.current;

  const [name, setName] = useState(() => persona?.name ?? "");
  const [description, setDescription] = useState(() => persona?.description ?? "");
  /** Pending avatar pick, uploaded only when the form is saved. */
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  /** True once the user cleared the avatar, so save writes `avatar_path: null`. */
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** Object URL of the pending pick; revoked on replace and on unmount. The
   *  ref is the source of truth so the unmount cleanup and a same-tick replace
   *  both read the live URL instead of a lagging render snapshot. */
  const avatarUrlRef = useRef<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never leak a preview URL: whichever one is live at unmount gets revoked.
  // An unmount-only effect over the ref, so picking a replacement revokes the
  // previous URL in setAvatar and never the freshly created one here.
  useEffect(
    () => () => {
      const url = avatarUrlRef.current;
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  /** Points the preview at `file` (or nothing), revoking the object URL it replaces. */
  const setAvatar = (file: File | null): void => {
    const url = file === null ? null : URL.createObjectURL(file);
    const previous = avatarUrlRef.current;
    avatarUrlRef.current = url;
    setAvatarFile(file);
    setAvatarUrl(url);
    if (previous !== null) {
      URL.revokeObjectURL(previous);
    }
  };

  /** Accepts a picked or dropped file after checking it is an image. */
  const pickAvatar = (file: File | undefined): void => {
    if (file === undefined || !file.type.startsWith("image/")) {
      setError("Avatar must be an image file");
      return;
    }
    setAvatar(file);
    setAvatarRemoved(false);
    setError(null);
  };

  /** Clears the pending or stored avatar; the stored blob itself stays on the server. */
  const removeAvatar = (): void => {
    setAvatar(null);
    setAvatarRemoved(true);
  };

  /** What the preview shows: the pending pick, the stored blob, or nothing. */
  const previewUrl: string | null =
    avatarUrl ?? (avatarRemoved ? null : blobUrl(persona?.avatar_path ?? null));

  const hasAvatar: boolean =
    avatarFile !== null || (!avatarRemoved && (persona?.avatar_path ?? null) !== null);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    const file = avatarFile;
    let uploadedPath: string | null = null;
    if (file !== null) {
      try {
        const uploaded = await uploadPersonaAvatar(file);
        uploadedPath = uploaded.avatar_path;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Avatar upload failed");
        setSaving(false);
        return;
      }
    }
    const input = {
      name: trimmed,
      description,
      avatar_path:
        file !== null ? uploadedPath : avatarRemoved ? null : (persona?.avatar_path ?? null),
    };
    try {
      if (persona) {
        await updatePersona(persona.id, input);
      } else {
        await createPersona(input);
      }
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save persona");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={persona ? `Edit ${persona.name}` : "New persona"}
      onClose={props.onClose}
      actions={<PersonaEditorActions saving={saving} />}
    >
      <form
        id="persona-editor-form"
        className="stack char-persona"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Error rides the top of the body, matching CharacterEditor's
            placement. */}
        {error !== null && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {/* Avatar first: a persona is identified by its face before its prose.
            The whole zone is a drop target and a click-to-select label. */}
        <div className="char-avatar-zone">
          <label
            className={cx("persona-avatar-drop", dragOver && "is-over")}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(event) => {
              // Ignore the transient leave fired when the drag crosses into a child.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              pickAvatar(event.dataTransfer?.files?.[0]);
            }}
          >
            <motion.span
              className="persona-avatar-preview char-avatar-preview-lg"
              aria-hidden="true"
              // Motivated motion: the preview lifts while a drag hovers, so the
              // drop target answers the pointer. Still under reduced motion.
              animate={{ scale: dragOver && !app.reduce ? 1.06 : 1 }}
              transition={app.reduce ? INSTANT : app.spring.snappy}
            >
              {previewUrl !== null ? (
                <img className="avatar-image" src={previewUrl} alt="" />
              ) : (
                <User size={28} />
              )}
            </motion.span>
            <span className="caption">Drag &amp; drop or click to select</span>
            <input
              type="file"
              accept="image/*"
              className="file-hidden"
              aria-label="Select avatar image"
              onChange={(event) => {
                pickAvatar(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <Presence>
            {hasAvatar && (
              <motion.button
                type="button"
                className="btn btn-icon btn-danger char-avatar-remove"
                aria-label="Remove avatar"
                data-tip="Remove"
                variants={fadeVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
                onClick={removeAvatar}
              >
                <Trash2 size={16} />
              </motion.button>
            )}
          </Presence>
        </div>
        <div className="char-group">
          <div className="char-group-head">
            <h5 className="char-group-title">Profile</h5>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="persona-name">
              Name
            </label>
            <input
              id="persona-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <p className="field-hint">How this persona is labeled across chats.</p>
          </div>
          <div className="field">
            <div className="char-field-foot">
              <label className="field-label" htmlFor="persona-description">
                Description
              </label>
              <span className="char-counter">{description.length.toLocaleString()} chars</span>
            </div>
            <textarea
              id="persona-description"
              className="textarea"
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            <p className="field-hint">
              Injected as the {"{{user}}"} description when this persona is active.
            </p>
          </div>
        </div>
      </form>
    </Modal>
  );
}
