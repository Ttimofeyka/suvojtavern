/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useState } from "react";
import { cx } from "../../../lib/cx";
import { INSTANT, useAppMotion } from "../../../lib/motion";
import type { TrackerSchemaPreset } from "../../../lib/tracker-config";
import { Pencil, Plus, Trash2 } from "../../ui/icons";
import { Presence } from "../../ui/presence";
import { Stagger, StaggerItem } from "../../ui/stagger";

/** Shared-layout id for the selected-preset pill. One rail instance exists at
 *  a time, so a fixed id is safe and lets Motion fly the pill between rows. */
const INDICATOR_ID = "tracker-preset-indicator";

/**
 * The editor's left rail: every preset as a selectable row (the selected one
 * carries an animated shared-layout pill), plus create/rename/delete.
 *
 * Create/rename keep their form state here — they are rail-local UI, and the
 * parent owns only the actual commit (`onCreate` validates and returns an
 * error string, `onRename`/`onDelete` mutate the config). Selection and the
 * management actions are blocked while the raw JSON is invalid, matching the
 * old editor's semantics.
 */
export function PresetRail(props: {
  presets: Record<string, TrackerSchemaPreset>;
  selectedKey: string | null;
  /** The stored active key, marked distinctly from the row being edited. */
  activeKey: string;
  disabled: boolean;
  /** Commits a new preset; returns a validation message, or null on success. */
  onCreate: (key: string, name: string) => string | null;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSelect: (key: string) => void;
}) {
  const app = useAppMotion();

  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const keys = Object.keys(props.presets);
  const selected = props.selectedKey;

  const startCreate = (): void => {
    setCreating(true);
    setRenaming(false);
    setNewKey("");
    setNewName("");
    setCreateError(null);
  };

  const submitCreate = (): void => {
    const error = props.onCreate(newKey.trim(), newName.trim());
    if (error !== null) {
      setCreateError(error);
      return;
    }
    setCreating(false);
  };

  const startRename = (): void => {
    if (selected === null) {
      return;
    }
    setRenameValue(props.presets[selected]?.name ?? "");
    setRenaming(true);
    setCreating(false);
  };

  const submitRename = (): void => {
    props.onRename(renameValue.trim());
    setRenaming(false);
  };

  return (
    <aside className="tracker-rail" aria-label="Schema presets">
      <div className="tracker-rail-head">
        <span className="tracker-rail-title">Presets</span>
        <span className="tracker-rail-count tnum">{keys.length}</span>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="New preset"
          title="New preset"
          disabled={props.disabled}
          onClick={() => startCreate()}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* The create/rename forms are rail-local: they animate in over the list
          head and collapse back out without shifting the list itself. */}
      <Presence>
        {creating && (
          <motion.form
            key="create"
            className="tracker-rail-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={app.reduce ? INSTANT : { ...app.transition, duration: app.duration.med }}
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <label className="field">
              <span className="field-label">Key</span>
              <input
                className="input"
                type="text"
                placeholder="my-preset"
                aria-label="New preset key"
                value={newKey}
                onChange={(event) => setNewKey(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="input"
                type="text"
                placeholder="My preset"
                aria-label="New preset name"
                value={newName}
                onChange={(event) => setNewName(event.currentTarget.value)}
              />
            </label>
            {createError !== null && (
              <p className="field-error" role="alert">
                {createError}
              </p>
            )}
            <div className="row tracker-rail-form-actions">
              <button type="submit" className="btn btn-primary">
                Create
              </button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </motion.form>
        )}

        {renaming && selected !== null && (
          <motion.form
            key="rename"
            className="tracker-rail-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={app.reduce ? INSTANT : { ...app.transition, duration: app.duration.med }}
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <label className="field">
              <span className="field-label">Preset name</span>
              <input
                className="input"
                type="text"
                placeholder="Preset name"
                aria-label="Preset name"
                value={renameValue}
                onChange={(event) => setRenameValue(event.currentTarget.value)}
              />
            </label>
            <div className="row tracker-rail-form-actions">
              <button type="submit" className="btn btn-primary">
                Save name
              </button>
              <button type="button" className="btn" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </div>
          </motion.form>
        )}
      </Presence>

      {keys.length === 0 ? (
        <p className="caption muted tracker-rail-empty">No presets yet.</p>
      ) : (
        <Stagger>
          {keys.map((key) => {
            const preset = props.presets[key];
            const name = preset?.name ?? "";
            const isSelected = key === selected;
            return (
              <StaggerItem key={key}>
                <button
                  type="button"
                  className={cx("tracker-rail-item", isSelected && "is-selected")}
                  aria-current={isSelected ? "true" : undefined}
                  disabled={props.disabled}
                  onClick={() => props.onSelect(key)}
                >
                  {isSelected && (
                    <motion.span
                      layoutId={INDICATOR_ID}
                      className="tracker-rail-pill"
                      aria-hidden="true"
                      transition={app.reduce ? INSTANT : app.spring.snappy}
                    />
                  )}
                  <span className="tracker-rail-item-main">
                    <span className="tracker-rail-item-name">{name === "" ? key : name}</span>
                    {name !== "" && <span className="tracker-rail-item-key">{key}</span>}
                  </span>
                  {key === props.activeKey && (
                    <span
                      className="tracker-rail-dot"
                      title="Active preset"
                      role="img"
                      aria-label="Active preset"
                    />
                  )}
                </button>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}

      <div className="tracker-rail-actions">
        <button
          type="button"
          className="btn"
          disabled={props.disabled || selected === null}
          onClick={() => startRename()}
        >
          <Pencil size={13} />
          Rename
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={props.disabled || selected === null}
          onClick={() => props.onDelete()}
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
    </aside>
  );
}
