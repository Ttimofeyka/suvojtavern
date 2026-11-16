/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  type PluginControl,
  type PluginInfo,
  putPluginControls,
  putPluginSettings,
  type SettingErrorDetail,
  type SettingField,
} from "../../lib/api-plugins";
import { cx } from "../../lib/cx";
import { INSTANT, useAppMotion } from "../../lib/motion";
import {
  pluginControlDisplay,
  pluginOptionLabel,
  storedControlValues,
} from "../../lib/plugin-controls";
import { usePlugins } from "../../stores/plugins";
import { Collapsible } from "../ui/collapsible";
import { ChevronDown, Puzzle, RotateCcw } from "../ui/icons";
import "../../styles/plugins.css";
import "../../styles/settings.css";
import { SettingsEmpty, SettingsError, SettingsLoading, SettingsSaved } from "./SettingsStates";

/** Draft values the schema-driven form edits (a `string[]` for multiselect). */
type DraftValue = boolean | string | number | string[];

/**
 * Whether a stored JSON value is a usable draft of the field's `type`, so the
 * form renders the stored value rather than a broken control. Exact per type:
 * a `string`/`textarea` needs a string, a `boolean` a boolean, a `number` a
 * number, a `multiselect` an array of strings, and a `select` a string or
 * number (its option value may be either). Anything else — a hand-edited row,
 * an older schema — falls back to the field's `default`.
 */
function matchesDraftType(type: SettingField["type"], value: unknown): value is DraftValue {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "multiselect":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "select":
      return typeof value === "string" || typeof value === "number";
    default:
      // string / textarea
      return typeof value === "string";
  }
}

/**
 * In-progress settings drafts, keyed by plugin id. The card list is keyed by
 * reference on purpose (see PluginsPanel), so every store reconcile — a
 * toggle, a failed-toggle revert — remounts the cards; without this cache a
 * remount would wipe a half-edited form back to server state. Entries are
 * created lazily on the first edit, dropped on successful save (the server now
 * holds the values) and on Reload (fresh truth wins), so a remount restores
 * exactly the user's unsaved edits.
 */
const drafts = new Map<string, Record<string, DraftValue>>();

/**
 * The last control values the server echoed for a plugin, keyed by plugin id.
 * Like `drafts`, this survives the card remounts a store reconcile causes: a
 * control write does NOT reconcile the store, so without it a later remount
 * (a toggle, say) would fall back to the stale list entry and snap a switch
 * back to a choice the server no longer holds. Cleared on Reload (fresh truth
 * wins), exactly like `drafts`.
 */
const controlValues = new Map<string, Record<string, string>>();

/**
 * Stable remount token per plugin object. Solid keyed its `<For>` by object
 * reference, so a store reconcile that built a fresh plugin object remounted
 * exactly that card (and restored its edits from the caches above). React keys
 * are strings, so a WeakMap hands each object identity a token: unchanged rows
 * keep their key, while a toggled/reverted row gets a new one and remounts.
 * Writing the WeakMap during render is safe because it is idempotent: the same
 * object always maps to the same token, so under StrictMode a double render
 * would only re-set the same entry harmlessly.
 */
const pluginTokens = new WeakMap<PluginInfo, number>();
let nextPluginToken = 0;
function pluginKey(plugin: PluginInfo): string {
  let token = pluginTokens.get(plugin);
  if (token === undefined) {
    token = nextPluginToken;
    nextPluginToken += 1;
    pluginTokens.set(plugin, token);
  }
  return `${plugin.id}#${token}`;
}

/** One schema-driven settings row; `type` picks the control. */
function SettingFieldRow(props: {
  error?: string;
  field: SettingField;
  onEdit: (value: DraftValue) => void;
  value: DraftValue;
}) {
  const { field } = props;
  const inputId = `plugin-setting-${field.key}`;
  const groupLabelId = `${inputId}-label`;

  /** Coerces the draft into what an input's `value` accepts (string | number). */
  const inputValue = (value: DraftValue): string | number =>
    field.type === "number" ? (typeof value === "number" ? value : "") : String(value);

  /** The draft as a multiselect array (tolerant: a non-array draft is empty). */
  const multi = (): string[] => (Array.isArray(props.value) ? props.value : []);

  /** Only string-valued options can occupy a `string[]` slot (server's rule). */
  const multiOptions = (): Array<{ label: string; value: string }> =>
    (field.options ?? []).filter(
      (option): option is { label: string; value: string } => typeof option.value === "string",
    );

  const toggleMulti = (value: string, checked: boolean): void => {
    const current = multi();
    // Set semantics: checking an already-checked option must not duplicate it.
    const next = checked
      ? current.includes(value)
        ? current
        : [...current, value]
      : current.filter((entry) => entry !== value);
    props.onEdit(next);
  };

  if (field.type === "boolean") {
    return (
      <label className="switch-row" htmlFor={inputId}>
        <span className="set-row-main">
          <span className="set-row-label">{field.label}</span>
          {field.hint && <span className="set-row-hint">{field.hint}</span>}
        </span>
        <span className="switch">
          <input
            id={inputId}
            type="checkbox"
            className="switch-input"
            checked={props.value === true}
            onChange={(event) => props.onEdit(event.currentTarget.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
        </span>
      </label>
    );
  }

  return (
    <div className="field">
      {field.type === "multiselect" ? (
        // A multiselect is a checkbox GROUP, so its label is a <span>
        // referenced by aria-labelledby — a `for` label would point at
        // no single input.
        <span className="field-label" id={groupLabelId}>
          {field.label}
        </span>
      ) : (
        <label className="field-label" htmlFor={inputId}>
          {field.label}
        </label>
      )}
      {field.hint && <p className="field-hint">{field.hint}</p>}
      {field.type === "select" ? (
        <select
          id={inputId}
          className="select"
          value={String(props.value)}
          onChange={(event) => {
            const option = field.options?.find(
              (candidate) => String(candidate.value) === event.currentTarget.value,
            );
            if (option) {
              props.onEdit(option.value);
            }
          }}
        >
          {(field.options ?? []).map((option) => (
            <option value={option.value} key={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "multiselect" ? (
        <fieldset className="plugins-check-group" aria-labelledby={groupLabelId}>
          {multiOptions().map((option) => {
            const on = multi().includes(option.value);
            return (
              <label
                className={cx("plugins-check-option", on && "is-on")}
                htmlFor={`${inputId}-${option.value}`}
                key={option.value}
              >
                <input
                  id={`${inputId}-${option.value}`}
                  type="checkbox"
                  className="plugins-check-input"
                  checked={on}
                  onChange={(event) => toggleMulti(option.value, event.currentTarget.checked)}
                />
                <span className="plugins-check-label">{option.label}</span>
              </label>
            );
          })}
        </fieldset>
      ) : field.type === "textarea" ? (
        <textarea
          id={inputId}
          className="textarea"
          placeholder={field.placeholder}
          value={String(props.value)}
          onChange={(event) => props.onEdit(event.currentTarget.value)}
        />
      ) : (
        <input
          id={inputId}
          className="input"
          type={field.type === "number" ? "number" : "text"}
          value={inputValue(props.value)}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          onChange={(event) => {
            if (field.type !== "number") {
              props.onEdit(event.currentTarget.value);
              return;
            }
            // An emptied number input reads as NaN — keep it as "" so
            // the save round-trip surfaces the server's "must be a
            // number" detail instead of silently sending null.
            const raw = event.currentTarget.value;
            props.onEdit(raw === "" ? "" : event.currentTarget.valueAsNumber);
          }}
        />
      )}
      {props.error && (
        <p className="field-error" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}

/**
 * One plugin card: identity + enablement + (when declared) its schema-driven
 * settings form. Remounted whenever its plugin object is rebuilt — a toggle or
 * reload — with unsaved edits surviving through the panel-level `drafts` cache,
 * seeded into the card's state on mount.
 */
function PluginCard(props: {
  plugin: PluginInfo;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleError: (message: string | null) => void;
}) {
  const { plugin, expanded, onToggleExpanded, onToggleError } = props;
  const { setEnabled } = usePlugins();
  const app = useAppMotion();
  const schema = plugin.settingsSchema ?? [];

  /** Draft state seeded from a preserved in-progress draft when one exists
   *  (a remount restores the user's edits), else from the plugin's effective
   *  settings. A stored value of the wrong JSON type falls back to the
   *  schema `default`, so a hand-edited row can never poison the form. */
  const seedDraft = (): Record<string, DraftValue> => {
    const preserved = drafts.get(plugin.id);
    if (preserved !== undefined) {
      return { ...preserved };
    }
    const out: Record<string, DraftValue> = {};
    for (const field of schema) {
      const stored = plugin.settings?.[field.key];
      out[field.key] = matchesDraftType(field.type, stored) ? stored : field.default;
    }
    return out;
  };
  const [draft, setDraft] = useState<Record<string, DraftValue>>(() => seedDraft());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // --- controls ------------------------------------------------------------

  const declaredControls = (): PluginControl[] => plugin.controls ?? [];
  const hasControls = (): boolean => declaredControls().length > 0;

  /**
   * The stored control map this card renders from: the module-level cache when
   * a write echoed fresh values (surviving this card's remounts), else the
   * server's resolved `controlValues`. `null` is a plugin with no controls.
   */
  const seedControlValues = (): Record<string, string> =>
    controlValues.get(plugin.id) ?? storedControlValues(plugin.controlValues);

  const [controls, setControls] = useState<Record<string, string>>(() => seedControlValues());
  const [controlError, setControlError] = useState<string | null>(null);
  // The control currently in flight — its switch/select is disabled so a
  // double-click cannot race two writes; the others stay live.
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  /** A plugin whose contributions are not actually live must not look flippable. */
  const controlsDisabled = (): boolean => !plugin.enabled || plugin.error != null;

  /**
   * Stores one control's choice and mirrors the server's echoed map back into
   * local state. Deliberately NOT optimistic: on failure the previous state
   * stays and the status line reports it, so the card never shows a choice
   * that was not actually saved.
   */
  const chooseControl = (controlId: string, optionId: string): void => {
    setControlError(null);
    setPendingControl(controlId);
    putPluginControls(plugin.id, { [controlId]: optionId })
      .then((result) => {
        const values = storedControlValues(result.control_values);
        // Cache before the state so a remount mid-render sees the same truth.
        controlValues.set(plugin.id, values);
        setControls(values);
      })
      .catch((err) => {
        setControlError(
          err instanceof Error ? err.message : `Failed to save "${controlId}" choice`,
        );
      })
      .finally(() => setPendingControl(null));
  };

  const editField = (key: string, value: DraftValue): void => {
    setSaved(false);
    const next = { ...draft, [key]: value };
    // Preserve the edit across the card remounts a store reconcile causes.
    drafts.set(plugin.id, next);
    setDraft(next);
  };

  const toggle = (enabled: boolean): void => {
    // A stale failure from an earlier toggle must not outlive the retry
    // that is about to run — clear the panel-level banner first.
    onToggleError(null);
    // The store flips optimistically and reverts on failure; the message
    // lives at panel level because this card remounts either way.
    setEnabled(plugin.id, enabled).catch(() => {
      onToggleError(`Failed to ${enabled ? "enable" : "disable"} "${plugin.name}"`);
    });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setFieldErrors({});
    setFormError(null);
    // Only schema keys — the server 400s anything it doesn't declare.
    const payload: Record<string, unknown> = {};
    for (const field of schema) {
      payload[field.key] = draft[field.key] ?? field.default;
    }
    try {
      await putPluginSettings(plugin.id, payload);
      setSaved(true);
      // The server now holds these values — stop preserving the draft.
      drafts.delete(plugin.id);
    } catch (err) {
      // A 400 carries per-key issues ({path, message}) — map them onto fields.
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const perField: Record<string, string> = {};
        for (const detail of err.details as SettingErrorDetail[]) {
          perField[detail.path] = detail.message;
        }
        setFieldErrors(perField);
      }
      setFormError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={cx("plugins-card", plugin.error != null && "plugins-card-broken")}>
      <header className="plugins-card-head row">
        <div className="stack plugins-card-title">
          <div className="row">
            <h3 className="plugins-card-name">{plugin.name}</h3>
            <span className="badge plugins-card-version">v{plugin.version}</span>
            {plugin.error != null && <span className="badge badge-danger">Failed to load</span>}
            {/* Enable/disable feedback: the card remounts on a toggle (the
                reference-keyed list), so this chip's own mount transition is
                the motion cue that the state actually changed. */}
            <motion.span
              key={String(plugin.enabled)}
              className={cx("badge", "plugins-card-state", plugin.enabled && "badge-success")}
              initial={app.reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={app.reduce ? INSTANT : app.spring.snappy}
            >
              {plugin.enabled ? "Enabled" : "Disabled"}
            </motion.span>
          </div>
          <span className="caption">
            <code className="plugins-card-id">{plugin.id}</code>
            {plugin.author && <span> · by {plugin.author}</span>}
          </span>
        </div>
        <div className="row plugins-card-head-actions">
          <label className="plugins-toggle" htmlFor={`plugin-enabled-${plugin.id}`}>
            <span className="plugins-toggle-label">Enabled</span>
            <span className="switch">
              <input
                id={`plugin-enabled-${plugin.id}`}
                type="checkbox"
                className="switch-input"
                checked={plugin.enabled}
                disabled={!plugin.loaded}
                onChange={(event) => toggle(event.currentTarget.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
          </label>
          <button
            type="button"
            className="btn btn-icon plugins-card-expand"
            aria-expanded={expanded}
            aria-controls={`plugin-body-${plugin.id}`}
            aria-label={expanded ? `Collapse ${plugin.name}` : `Expand ${plugin.name}`}
            onClick={() => onToggleExpanded()}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </header>

      <Collapsible open={expanded} id={`plugin-body-${plugin.id}`}>
        <div className="stack plugins-card-body">
          {plugin.description && <p className="caption plugins-card-desc">{plugin.description}</p>}

          {plugin.error != null && (
            <p className="error-banner" role="alert">
              {plugin.error}
            </p>
          )}

          {schema.length > 0 && (
            <form
              className="stack plugins-settings"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {schema.map((field) => (
                <SettingFieldRow
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? field.default}
                  error={fieldErrors[field.key]}
                  onEdit={(value) => editField(field.key, value)}
                />
              ))}
              <div className="row">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <span className="spinner btn-spinner" aria-hidden="true" />
                      Saving…
                    </>
                  ) : (
                    "Save"
                  )}
                </button>
                <SettingsSaved note={saved ? "Saved" : null} />
                {formError && (
                  <span className="field-error" role="alert">
                    {formError}
                  </span>
                )}
              </div>
            </form>
          )}

          {hasControls() && (
            <div className="plugins-controls">
              <div className="plugins-controls-head">
                <span className="caption muted">
                  {declaredControls().length} control{declaredControls().length === 1 ? "" : "s"}
                </span>
              </div>
              {declaredControls().map((control) => {
                // Re-derived per control from the reactive choices map, so a
                // write re-renders only the changed row (the declarations
                // array is the store's stable reference).
                const row = pluginControlDisplay(control, controls);
                const labelId = `plugin-control-label-${plugin.id}-${control.id}`;
                const busy = pendingControl === control.id;
                const disabled = controlsDisabled() || busy;
                return (
                  <div className="plugins-control-row" key={control.id}>
                    <span className="plugins-control-row-main">
                      <span className="plugins-control-label" id={labelId}>
                        {row.label}
                      </span>
                      {control.description?.trim() && (
                        <span className="caption muted plugins-control-desc">
                          {control.description}
                        </span>
                      )}
                    </span>
                    {row.toggle ? (
                      // A toggle's two options map onto the switch: [on, off]
                      // per the two-option rule, so the first is checked and
                      // the second unchecked. The stored choice is never
                      // guessed — it is the server's resolved option id.
                      <label className="switch plugins-control-switch">
                        <input
                          type="checkbox"
                          className="switch-input"
                          checked={row.on != null && row.value === row.on?.id}
                          disabled={disabled}
                          aria-labelledby={labelId}
                          onChange={(event) => {
                            const target = event.currentTarget.checked ? row.on : row.off;
                            if (target) {
                              chooseControl(control.id, target.id);
                            }
                          }}
                        />
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                      </label>
                    ) : (
                      <select
                        className="select plugins-control-select"
                        aria-labelledby={labelId}
                        disabled={disabled}
                        value={row.value}
                        onChange={(event) => chooseControl(control.id, event.currentTarget.value)}
                      >
                        {control.options.map((option) => (
                          <option value={option.id} key={option.id}>
                            {pluginOptionLabel(option)}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* The switch alone cannot say what "on" means — name the
                        option in effect, exactly as the preset card does. */}
                    {row.toggle && (
                      <span className="caption muted plugins-control-state">{row.chosenLabel}</span>
                    )}
                  </div>
                );
              })}
              {controlError && (
                <p className="field-error" role="alert">
                  {controlError}
                </p>
              )}
            </div>
          )}
        </div>
      </Collapsible>
    </article>
  );
}

/** The Plugins settings section: list, enable/disable, per-plugin settings. */
export default function PluginsPanel() {
  const { plugins, loaded, error, reloading, load, reloadAll } = usePlugins();
  // Panel-level (not card-level) so it survives the card remounts a toggle
  // triggers — the store is the shared truth, this is just the message.
  const [toggleError, setToggleError] = useState<string | null>(null);
  // Collapse state lives here, not in the card: a toggle remounts the card
  // (the list is keyed by reference), so a card-level state would reset to
  // collapsed on every enable/disable.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isExpanded = (id: string): boolean => expanded[id] === true;

  const toggleExpanded = (id: string): void => {
    setExpanded((map) => ({ ...map, [id]: !map[id] }));
  };

  /** Reload drops every preserved draft and cached control value — the
   *  rescan brings fresh truth, which must win over a stale echo. */
  const reload = (): void => {
    drafts.clear();
    controlValues.clear();
    void reloadAll();
  };

  // Fresh list every visit — unlike app settings, the plugins folder can
  // change server-side (restart, another client's reload) between views.
  useEffect(() => {
    void load();
  }, [load]);

  const list = plugins ?? [];

  return (
    <div className="set-stack">
      <div className="plugins-toolbar row">
        <p className="caption muted set-intro">
          Plugins extend the app from the repo's <code>plugins/</code> folder — they start disabled;
          toggling one loads or unloads it immediately.
        </p>
        <button type="button" className="btn" disabled={reloading} onClick={() => reload()}>
          {reloading ? (
            <span className="spinner btn-spinner" aria-hidden="true" />
          ) : (
            <RotateCcw size={16} />
          )}
          {reloading ? "Reloading…" : "Reload"}
        </button>
      </div>

      {/* A failed reload over an already-loaded list keeps the stale cards and
          surfaces the error beside them; a first-load failure replaces the
          spinner with the retryable error box below. */}
      {loaded && error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {toggleError && (
        <p className="error-banner" role="alert">
          {toggleError}
        </p>
      )}

      {!loaded && error === null && <SettingsLoading label="Loading plugins…" rows={3} />}

      {!loaded && error !== null && (
        <SettingsError title="Couldn't load plugins" details={error} onRetry={() => void load()} />
      )}

      {loaded && list.length > 0 && (
        <div className="stack plugins-list">
          {list.map((plugin) => (
            <PluginCard
              key={pluginKey(plugin)}
              plugin={plugin}
              expanded={isExpanded(plugin.id)}
              onToggleExpanded={() => toggleExpanded(plugin.id)}
              onToggleError={setToggleError}
            />
          ))}
        </div>
      )}

      {loaded && list.length === 0 && (
        <SettingsEmpty
          icon={<Puzzle size={36} />}
          title="No plugins found"
          hint={
            <>
              Place a folder in the repo's <code>plugins/</code> folder, press Reload, then enable
              it. See <code>docs/PLUGINS.md</code> for how to write one.
            </>
          }
          action={
            <button type="button" className="btn" disabled={reloading} onClick={() => reload()}>
              <RotateCcw size={16} />
              Reload
            </button>
          }
        />
      )}
    </div>
  );
}
