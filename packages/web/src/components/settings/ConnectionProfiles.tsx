/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import type { ModelInfo } from "../../lib/api";
import { getModels } from "../../lib/api";
import type { Profile } from "../../lib/api-profiles";
import {
  createProfile,
  deleteProfile,
  getProfileModels,
  listProfiles,
  setActiveProfile,
  updateProfile,
} from "../../lib/api-profiles";
import { cx } from "../../lib/cx";
import { riseVariants, useAppMotion } from "../../lib/motion";
import {
  createInput,
  type Draft,
  draftFrom,
  endpointError,
  endpointHost,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type SamplerKey,
  type SamplingValues,
  updatePatch,
} from "../../lib/profile-draft";
import { appStore } from "../../stores/store";
import "../../styles/settings.css";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { Cable, KeyRound, Pencil, Plus, RotateCcw, Trash2, TriangleAlert } from "../ui/icons";
import { Presence } from "../ui/presence";
import { SettingsEmpty, SettingsError, SettingsLoading, SettingsSaved } from "./SettingsStates";

/** One sampler field's display + validation metadata. */
interface SamplerMeta {
  key: SamplerKey;
  label: string;
  hint: string;
  /** HTML step of the number input (0.01 for floats, 1 for ints). */
  step: string;
  min?: number;
  max?: number;
  integer?: boolean;
}

/** The editable samplers, in display order. Ranges mirror the server's schema. */
const SAMPLERS: readonly SamplerMeta[] = [
  {
    key: "temperature",
    label: "Temperature",
    hint: "Randomness; higher is more varied (0-2).",
    step: "0.01",
    min: 0,
    max: 2,
  },
  {
    key: "top_p",
    label: "Top P",
    hint: "Nucleus sampling: keep tokens within this probability mass (0-1).",
    step: "0.01",
    min: 0,
    max: 1,
  },
  {
    key: "repetition_penalty",
    label: "Repetition penalty",
    hint: "Penalizes repeated tokens; 1 is off.",
    step: "0.01",
    min: 0,
  },
  {
    key: "max_tokens",
    label: "Max tokens",
    hint: "Response tokens per message.",
    step: "1",
    min: 1,
    integer: true,
  },
  {
    key: "context_size",
    label: "Context size",
    hint: "Context window used for chats with this profile.",
    step: "1",
    min: 1,
    integer: true,
  },
];

/** Display labels for the reasoning-effort select (wire values are lowercase). */
const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** "gpt-4o-mini — GPT-4o mini (128000)" — the id always leads. */
const modelLabel = (info: ModelInfo): string => {
  const base = info.name ? `${info.id} — ${info.name}` : info.id;
  return info.context_length == null ? base : `${base} (${info.context_length})`;
};

/** Cache key of a suggestion list: the app-wide default, or one profile's endpoint. */
const modelSource = (id: string | null): string => (id === null ? "default" : `profile:${id}`);

/** One labeled sampler input; empty text means "leave unset". */
function SamplerField(props: {
  meta: SamplerMeta;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field profile-sampler">
      <span className="field-label">{props.meta.label}</span>
      <input
        className="input"
        type="number"
        step={props.meta.step}
        min={props.meta.min}
        max={props.meta.max}
        aria-label={props.meta.label}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <span className="field-hint">{props.meta.hint}</span>
    </label>
  );
}

/**
 * One profile row: the "Use for chats" radio pick on the left, its actions on
 * the right. A Motion child so an added or deleted profile animates in/out via
 * the `<Presence>` around the list, and a `layout` element so remaining rows
 * slide up when one above them leaves.
 */
function ProfileRow(props: {
  profile: Profile;
  active: boolean;
  /** Any list action is in flight — blocks switching the active profile. */
  busy: boolean;
  /** This row's own action is in flight — blocks only its Delete. */
  rowBusy: boolean;
  onSelect: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onRemove: (profile: Profile) => void;
}) {
  const app = useAppMotion();
  const { profile } = props;

  return (
    <motion.div
      className="set-row profile-row"
      variants={riseVariants(app)}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <label className={cx("profile-pick", props.active && "is-active")} data-tip="Use for chats">
        <input
          type="radio"
          name="active-profile"
          className="profile-radio"
          checked={props.active}
          disabled={props.busy}
          aria-label={`Use ${profile.name} for chats`}
          onChange={() => props.onSelect(profile)}
        />
        <span className="strategy-dot" aria-hidden="true" />
        <span className="profile-pick-main">
          <span className="profile-name">{profile.name}</span>
          {profile.is_default && <span className="badge">Default</span>}
          <code className="model-id">{profile.model !== "" ? profile.model : "no model set"}</code>
          {/* A custom endpoint is the profile's defining trait — show its host
              (the full URL on hover) so rows are tellable apart at a glance. */}
          {profile.base_url !== "" && (
            <code className="endpoint-id" data-tip={profile.base_url}>
              <Cable size={12} aria-hidden="true" />
              {endpointHost(profile.base_url)}
            </code>
          )}
          {profile.has_api_key && (
            <span
              className="profile-key-badge"
              role="img"
              aria-label="API key stored"
              data-tip="API key stored"
            >
              <KeyRound size={12} aria-hidden="true" />
            </span>
          )}
        </span>
      </label>
      <div className="row profile-actions">
        <button
          type="button"
          className="btn btn-icon"
          aria-label={`Edit ${profile.name}`}
          data-tip="Edit"
          onClick={() => props.onEdit(profile)}
        >
          <Pencil size={16} />
        </button>
        {!profile.is_default && (
          // Per-row, not list-wide: a delete in flight on another row must
          // not gray out this one's Delete.
          <button
            type="button"
            className="btn btn-icon btn-danger"
            aria-label={`Delete ${profile.name}`}
            data-tip="Delete"
            disabled={props.rowBusy}
            onClick={() => props.onRemove(profile)}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

// --- module-level profiles cache ---
// Settings remounts this component whenever the user switches sections or
// revisits the page, and component-local state meant every remount flashed a
// "Loading profiles…" spinner while GET /api/profiles ran again. Following the
// module-scope atom pattern used across the ported stores, the list and the
// active id persist across mounts: a remount renders the cached rows instantly
// while the mount effect's refresh() revalidates in the background.
// `profilesLoaded` records that some fetch has ever succeeded — the "first
// load" spinner (and its loadError fallback) only applies when none has, while
// a failed background revalidate over the cache surfaces through `error` with
// the stale rows kept visible.
const profilesAtom = atom<Profile[] | null>(null);
const activeIdAtom = atom<string | null>(null);
const profilesLoadedAtom = atom(false);

/** Connection profile manager: list, active switch, and the inline editor. */
export default function ConnectionProfiles() {
  const app = useAppMotion();
  const { confirm, dialog } = useConfirmDialog();
  const profiles = useAtomValue(profilesAtom);
  const activeId = useAtomValue(activeIdAtom);

  /** Fetch failure with nothing cached — replaces the spinner until a retry
   *  succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Errors of the list-level actions (use / delete) and of background
   *  revalidates over the cached list — the rows stay visible. */
  const [error, setError] = useState<string | null>(null);
  /** Profile id with an in-flight list action, disabling its buttons. */
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- editor state ---
  const [editorOpen, setEditorOpen] = useState(false);
  /** null while creating; otherwise the id of the edited profile. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [saving, setSaving] = useState(false);
  const [editorNote, setEditorNote] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  // --- model suggestions (auto-fetched when the editor opens) ---
  // These come from the edited profile's OWN endpoint + key, so an endpoint
  // change invalidates the list. `modelsSource` records where the cached list
  // came from (a profile id, or "default" for the app-wide list when
  // creating) so `ensureModels` reloads when the editor switches profiles
  // instead of showing another endpoint's models.
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsSource, setModelsSource] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const applyProfiles = useCallback(
    (result: { profiles: Profile[]; active_profile_id: string | null }): void => {
      appStore.set(profilesAtom, result.profiles);
      appStore.set(activeIdAtom, result.active_profile_id);
      appStore.set(profilesLoadedAtom, true);
      setLoadError(null);
      setError(null);
    },
    [],
  );

  const failLoad = useCallback((err: unknown): void => {
    const message = err instanceof Error ? err.message : "Failed to load profiles";
    if (appStore.get(profilesLoadedAtom)) {
      // The cached list is on screen (a use/delete/save refresh, or a
      // remount's background revalidate): keep the stale rows visible
      // and surface the failure next to them.
      setError(message);
    } else {
      // No fetch has ever succeeded, so the list never rendered — the
      // spinner fallback's error banner shows it.
      setLoadError(message);
    }
  }, []);

  const refresh = useCallback((): Promise<void> => {
    return listProfiles().then(applyProfiles).catch(failLoad);
  }, [applyProfiles, failLoad]);

  /** Retry after a first-load failure: clear the error and re-fetch. */
  const retry = (): void => {
    setLoadError(null);
    void refresh();
  };

  useEffect(() => {
    // One call covers both cases: with a cached list, `profiles` is already
    // non-null, so the rows render instantly (no spinner) and this fetch
    // merely revalidates in the background; without a cache (first mount,
    // or no fetch has ever succeeded) `profiles` is null and the spinner
    // flow applies. Cancellation keeps a StrictMode double mount harmless.
    let cancelled = false;
    listProfiles()
      .then((result) => {
        if (!cancelled) {
          applyProfiles(result);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          failLoad(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyProfiles, failLoad]);

  const closeEditor = (): void => {
    setEditorOpen(false);
  };

  // Named `selectProfile`, not `useProfile`: React's rules-of-hooks lint reads
  // any `use*` call as a hook, and this runs from an onChange handler.
  const selectProfile = (profile: Profile): void => {
    if (profile.id === appStore.get(activeIdAtom) || busyId !== null) {
      return;
    }
    setBusyId(profile.id);
    setError(null);
    setActiveProfile(profile.id)
      .then(() => appStore.set(activeIdAtom, profile.id))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to set the active profile"),
      )
      .finally(() => setBusyId(null));
  };

  const remove = (profile: Profile): void => {
    if (busyId !== null) {
      return;
    }
    confirm({
      title: "Delete connection profile?",
      description: (
        <>
          <strong>{profile.name}</strong> and its endpoint settings will be removed. Chats using it
          fall back to the next available profile.
        </>
      ),
      confirmLabel: "Delete profile",
      tone: "danger",
      onConfirm: () => {
        setBusyId(profile.id);
        setError(null);
        deleteProfile(profile.id)
          .then(() => {
            if (editingId === profile.id) {
              closeEditor();
            }
            // The server already fell back to a valid active — refetch shows it.
            return refresh();
          })
          .catch((err: unknown) =>
            setError(err instanceof Error ? err.message : "Failed to delete profile"),
          )
          .finally(() => setBusyId(null));
      },
    });
  };

  const loadModels = (id: string | null): void => {
    setModelsLoading(true);
    setEditorError(null);
    // A saved profile lists models from its own endpoint+key; a profile being
    // created has no id yet, so fall back to the app-wide default list. A
    // custom endpoint's unsaved key can't be used here — the user may still
    // type a model id and save, then reload suggestions.
    (id === null ? getModels() : getProfileModels(id))
      .then((result) => {
        setModels(result.models);
        setModelsSource(modelSource(id));
      })
      .catch((err: unknown) =>
        setEditorError(err instanceof Error ? err.message : "Failed to load models"),
      )
      .finally(() => setModelsLoading(false));
  };

  /** Auto-load for editor open: fetch suggestions unless the cached list
   *  already belongs to this source or a fetch is in flight. The "Load
   *  models" button remains the manual retry/refresh for when this fails
   *  (e.g. no auth configured) or the list goes stale. */
  const ensureModels = (id: string | null): void => {
    if (!modelsLoading && modelsSource !== modelSource(id)) {
      loadModels(id);
    }
  };

  const startCreate = (): void => {
    setEditingId(null);
    setDraft(draftFrom(null));
    setEditorError(null);
    setEditorNote(null);
    setEditorOpen(true);
    ensureModels(null);
  };

  const startEdit = (profile: Profile): void => {
    setEditingId(profile.id);
    setDraft(draftFrom(profile));
    setEditorError(null);
    setEditorNote(null);
    setEditorOpen(true);
    ensureModels(profile.id);
  };

  const editDraft = (patch: Partial<Draft>): void => {
    setEditorNote(null);
    setEditorError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  /** API-key input: a typed replacement supersedes (and hides) the clear
   *  toggle, so reset `clearApiKey` once the field holds a real value. */
  const editApiKey = (value: string): void => {
    setEditorNote(null);
    setEditorError(null);
    setDraft((current) => ({
      ...current,
      api_key: value,
      clearApiKey: value.trim() === "" ? current.clearApiKey : false,
    }));
  };

  const toggleClearKey = (checked: boolean): void => {
    setEditorNote(null);
    setEditorError(null);
    setDraft((current) => ({ ...current, clearApiKey: checked }));
  };

  const editSampler = (meta: SamplerMeta, value: string): void => {
    setEditorNote(null);
    setEditorError(null);
    setDraft((current) => ({
      ...current,
      samplers: { ...current.samplers, [meta.key]: value },
    }));
  };

  /** The profile the editor is patching, if it is already saved. */
  const editedProfile = (): Profile | undefined => {
    const id = editingId;
    return id === null ? undefined : profiles?.find((profile) => profile.id === id);
  };

  /** A stored key the user has neither replaced nor marked for clearing. */
  const storedKey = (): boolean =>
    editedProfile()?.has_api_key === true && !draft.clearApiKey && draft.api_key.trim() === "";

  /** Whether the clear toggle applies (a stored key and no typed replacement). */
  const canClearKey = (): boolean =>
    editedProfile()?.has_api_key === true && draft.api_key.trim() === "";

  const keyPlaceholder = (): string => {
    if (editedProfile()?.has_api_key === true && draft.api_key.trim() === "") {
      return draft.clearApiKey ? "Will be cleared on save" : "•••••• (stored)";
    }
    return "sk-… (optional)";
  };

  const save = async (): Promise<void> => {
    if (saving) {
      return;
    }
    const current = draft;
    const name = current.name.trim();
    if (name === "") {
      setEditorError("Name is required.");
      return;
    }
    // Mirror the server's endpoint rule before the round-trip so a typo shows
    // next to the form instead of as a 400 (the server would reject it too).
    const endpointIssue = endpointError(current.base_url);
    if (endpointIssue !== null) {
      setEditorError(endpointIssue);
      return;
    }
    // A patched sampling replaces the stored object wholesale, so merge over
    // the edited profile's stored map: keys the editor doesn't expose (e.g.
    // `stream`, preset extras) pass through untouched, while the managed
    // numeric fields are set or cleared on top of it. `reasoning_effort` is
    // added by createInput/updatePatch. A new profile starts empty.
    const edited = editingId;
    const stored = profiles?.find((profile) => profile.id === edited);
    const sampling: SamplingValues = {
      ...(stored?.sampling ?? {}),
    };
    // Empty text = unset (a stored value is dropped); anything else must be
    // a valid number in range (the hints state the ranges; the server would
    // reject them otherwise).
    for (const meta of SAMPLERS) {
      const text = current.samplers[meta.key].trim();
      if (text === "") {
        delete sampling[meta.key];
        continue;
      }
      const value = Number(text);
      const inRange =
        Number.isFinite(value) &&
        (meta.min === undefined || value >= meta.min) &&
        (meta.max === undefined || value <= meta.max) &&
        (meta.integer !== true || Number.isInteger(value));
      if (!inRange) {
        const bounds =
          meta.max === undefined ? `${meta.min} or higher` : `between ${meta.min} and ${meta.max}`;
        setEditorError(
          `${meta.label} must be ${meta.integer === true ? "a whole number " : ""}${bounds}.`,
        );
        return;
      }
      sampling[meta.key] = value;
    }
    setSaving(true);
    setEditorError(null);
    setEditorNote(null);
    try {
      const saved =
        edited === null
          ? await createProfile(createInput(current, sampling))
          : await updateProfile(edited, updatePatch(current, sampling));
      // Keep the editor open on the saved profile: a later save PATCHes it.
      setEditingId(saved.id);
      await refresh();
      setEditorNote("Saved");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="set-stack">
      <p className="caption muted set-intro">
        One profile is active for chat generation. Other tools (like Layered Summaries) can use a
        different profile.
      </p>

      {profiles !== null ? (
        <>
          {profiles.length > 0 ? (
            <div className="set-rows profile-list">
              {/* Presence animates a profile card in/out as the list changes;
                  keys are profile ids, so a background refresh that returns the
                  same rows does not replay anything. */}
              <Presence>
                {profiles.map((profile) => (
                  <ProfileRow
                    key={profile.id}
                    profile={profile}
                    active={profile.id === activeId}
                    // Any in-flight action blocks switching the active profile;
                    // only this row's own action disables its Delete.
                    busy={busyId !== null}
                    rowBusy={busyId === profile.id}
                    onSelect={selectProfile}
                    onEdit={startEdit}
                    onRemove={remove}
                  />
                ))}
              </Presence>
            </div>
          ) : (
            <SettingsEmpty
              icon={<Cable size={36} />}
              title="No connection profiles"
              hint="Create a profile to point the app at a model endpoint."
              action={
                <button type="button" className="btn btn-primary" onClick={startCreate}>
                  <Plus size={16} />
                  New profile
                </button>
              }
            />
          )}

          {/* The toolbar button is the non-empty list's entry point; when the
              list is empty the empty-state action above is the only one, so the
              two never render together. */}
          {profiles.length > 0 && (
            <div className="row">
              <button type="button" className="btn" onClick={startCreate}>
                <Plus size={16} />
                New profile
              </button>
            </div>
          )}
          {error && <p className="field-error">{error}</p>}

          <Presence>
            {editorOpen && (
              <motion.form
                key="profile-editor"
                className="set-card profile-editor"
                variants={riseVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <header className="set-card-head">
                  <div className="set-card-heading">
                    <h3 className="set-card-title">
                      {editingId === null ? "New profile" : "Edit profile"}
                    </h3>
                    <p className="set-card-desc">
                      The endpoint and samplers chats use while this profile is active.
                    </p>
                  </div>
                </header>
                <div className="set-card-body">
                  <div className="field">
                    <label className="field-label" htmlFor="profile-name-input">
                      Name
                    </label>
                    <input
                      id="profile-name-input"
                      className="input"
                      value={draft.name}
                      onChange={(event) => editDraft({ name: event.currentTarget.value })}
                    />
                  </div>

                  <div className="field">
                    <label className="field-label" htmlFor="profile-base-url-input">
                      Endpoint URL
                    </label>
                    <input
                      id="profile-base-url-input"
                      className="input"
                      placeholder="https://api.openai.com"
                      spellCheck={false}
                      autoComplete="off"
                      value={draft.base_url}
                      onChange={(event) => editDraft({ base_url: event.currentTarget.value })}
                    />
                    <span className="field-hint">
                      Any OpenAI-compatible base URL works (OpenAI, Ollama, LM Studio, …); it is
                      required for generation.
                    </span>
                    {/* Empty is deliberately allowed (a runtime 400, not a save
                        block), so warn without disabling Save. The banner reads
                        as caution rather than a hard field error. */}
                    {draft.base_url.trim() === "" && (
                      <p className="warn-banner" role="note">
                        <TriangleAlert size={16} />
                        No endpoint set — this profile can't generate until you add one.
                      </p>
                    )}
                  </div>

                  <div className="field">
                    <div className="row profile-key-label">
                      <label className="field-label" htmlFor="profile-api-key-input">
                        API key
                      </label>
                      {storedKey() && (
                        <span className="badge profile-key-badge">
                          <KeyRound size={12} aria-hidden="true" />
                          Stored
                        </span>
                      )}
                    </div>
                    <input
                      id="profile-api-key-input"
                      className="input"
                      type="password"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={keyPlaceholder()}
                      value={draft.api_key}
                      onChange={(event) => editApiKey(event.currentTarget.value)}
                    />
                    <span className="field-hint">
                      Sent as a Bearer token to this endpoint. Leave blank for keyless servers
                      (Ollama, LM Studio).
                    </span>
                    {/* The stored key is write-only, so "keep it" is the absence of
                        any signal — this toggle is the explicit `api_key: null`. It
                        hides once a replacement is typed (which wins regardless). */}
                    {canClearKey() && (
                      <label className="row profile-key-clear">
                        <span className="switch">
                          <input
                            type="checkbox"
                            className="switch-input"
                            checked={draft.clearApiKey}
                            onChange={(event) => toggleClearKey(event.currentTarget.checked)}
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                        </span>
                        <span className="profile-key-clear-label">Clear stored key</span>
                      </label>
                    )}
                  </div>

                  <div className="field">
                    <label className="field-label" htmlFor="profile-model-input">
                      Model
                    </label>
                    {/* Manual retry/refresh: the list auto-loads when the editor
                        opens, so this mostly matters after a failure (e.g. no auth
                        configured) or to pick up newly added endpoint models. */}
                    <div className="row profile-model-tools">
                      <button
                        type="button"
                        className="btn"
                        disabled={modelsLoading}
                        onClick={() => loadModels(editingId)}
                      >
                        {modelsLoading ? (
                          <span className="spinner btn-spinner" aria-hidden="true" />
                        ) : (
                          <RotateCcw size={16} />
                        )}
                        {modelsLoading ? "Loading…" : "Load models"}
                      </button>
                    </div>
                    {/* Free text rather than a select: custom endpoints serve ids the
                        built-in gateway never lists. The datalist fills in whatever
                        the endpoint reports (loaded per profile above) without
                        constraining what can be typed or saved. */}
                    <input
                      id="profile-model-input"
                      className="input"
                      list="profile-model-suggestions"
                      placeholder="Type or pick a model id"
                      spellCheck={false}
                      autoComplete="off"
                      value={draft.model}
                      onChange={(event) => editDraft({ model: event.currentTarget.value })}
                    />
                    <datalist id="profile-model-suggestions">
                      {(models ?? []).map((info) => (
                        <option value={info.id} key={info.id}>
                          {modelLabel(info)}
                        </option>
                      ))}
                    </datalist>
                    <span className="field-hint">
                      Suggestions come from this profile's endpoint; any model id can be typed.
                    </span>
                  </div>

                  <div className="field">
                    <span className="field-label">Samplers</span>
                    <div className="profile-samplers">
                      {SAMPLERS.map((meta) => (
                        <SamplerField
                          key={meta.key}
                          meta={meta}
                          value={draft.samplers[meta.key]}
                          onChange={(value) => editSampler(meta, value)}
                        />
                      ))}
                    </div>
                    <span className="field-hint">
                      Empty fields stay unset — the gateway's defaults apply.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field-label" htmlFor="profile-reasoning-effort-select">
                      Reasoning effort
                    </label>
                    <select
                      id="profile-reasoning-effort-select"
                      className="input"
                      value={draft.reasoningEffort}
                      onChange={(event) =>
                        editDraft({
                          reasoningEffort: event.currentTarget.value as ReasoningEffort,
                        })
                      }
                    >
                      {REASONING_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {REASONING_EFFORT_LABELS[effort]}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Sent as <code>reasoning_effort</code>; Off omits it. Low is the default.
                    </span>
                  </div>

                  <div className="row">
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <SettingsSaved note={editorNote} />
                    <button type="button" className="btn" onClick={closeEditor}>
                      Cancel
                    </button>
                    {editorError && <span className="field-error">{editorError}</span>}
                  </div>
                </div>
              </motion.form>
            )}
          </Presence>
        </>
      ) : loadError === null ? (
        <SettingsLoading label="Loading profiles…" rows={3} />
      ) : (
        <SettingsError
          title="Couldn't load connection profiles"
          details={loadError}
          onRetry={retry}
        />
      )}
      {dialog}
    </div>
  );
}
