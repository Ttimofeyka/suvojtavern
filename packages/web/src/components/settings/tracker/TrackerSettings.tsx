/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from "react";
import { getSettings, putSettings } from "../../../lib/api";
import type { PluginInfo } from "../../../lib/api-plugins";
import type { Profile } from "../../../lib/api-profiles";
import { listProfiles } from "../../../lib/api-profiles";
import {
  DEFAULT_TRACKER_SYSTEM_PROMPT,
  normalizeTrackerConfig,
  type PluginTrackerContributions,
  TRACKER_PRESET_KEY_RE,
  type TrackerConfig,
} from "../../../lib/tracker-config";
import { usePlugins } from "../../../stores/plugins";
import { RotateCcw } from "../../ui/icons";
import "../../../styles/tracker.css";
import { SettingsError, SettingsLoading, SettingsSaved } from "../SettingsStates";
import { StepperRow } from "../Stepper";
import DrawerTabsCard from "./DrawerTabsCard";
import SchemaPresetsCard from "./SchemaPresetsCard";

/** When the tracker runs relative to the conversation. */
const AUTO_MODES = [
  { id: "after_reply", name: "After reply" },
  { id: "before_reply", name: "Before reply" },
  { id: "after_user_message", name: "After user message" },
  { id: "manual", name: "Manual only" },
] as const;

/** Prompt-injection roles for tracker snapshots. */
const INJECTION_ROLES = [
  { id: "user", name: "User" },
  { id: "assistant", name: "Assistant" },
  { id: "system", name: "System" },
] as const;

/** Rendering modes for injected tracker snapshots (plain is the default). */
const INJECTION_FORMATS = [
  { id: "json", name: "JSON" },
  { id: "plain", name: "Plain text (default)" },
] as const;

/**
 * Tracker settings (Settings → Tracker): the generation knobs, prompt
 * injection, schema presets, and the chat drawer's tab list. Mirrors the
 * MemoryStrategyPanel's load/save idiom — one Save button at the bottom,
 * "Saved" note, per-action errors inline.
 */
export default function TrackerSettings() {
  const { plugins, load: loadPlugins } = usePlugins();

  const [config, setConfig] = useState<TrackerConfig>(() => normalizeTrackerConfig({}));
  /** Server truth the Save button diffs against (the changed-state signal). */
  const [savedConfig, setSavedConfig] = useState<TrackerConfig>(() => normalizeTrackerConfig({}));
  /** Connection profiles for the tracker-profile select. */
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True until the first GET settles (either way); drives the skeleton. */
  const [loading, setLoading] = useState(true);
  /** GET /api/settings failed — without the stored values a save would wipe
   *  the real config, so the panel stays locked until a retry succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Blocking issues inside the preset editor (raw JSON / form rows),
   *  reported by SchemaPresetsCard; the Save button waits for them. */
  const [presetIssues, setPresetIssues] = useState<string | null>(null);

  /**
   * Loads the stored config into local state. A stable callback so the mount
   * effect and the error state's retry button run the same path. A load never
   * falls back to defaults: saving them would overwrite the real tracker_config,
   * so a failure stays visible through loadError.
   */
  const loadConfig = useCallback((): void => {
    setLoading(true);
    setLoadError(null);
    getSettings()
      .then((settings) => {
        const next = normalizeTrackerConfig(settings.tracker_config);
        setConfig(next);
        setSavedConfig(next);
      })
      .catch((err: unknown) => {
        // Not silently swallowed: saving over unwritten defaults would PUT
        // them as the whole tracker_config and wipe the stored values.
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      })
      .finally(() => setLoading(false));
    listProfiles()
      .then((result) => setProfiles(result.profiles))
      .catch(() => {}); // profiles unreachable — the select shows the default only
    // Mechanism options + drawer-tab rows come from the plugin list; the
    // store shares one in-flight GET with the drawer/plugins panel.
    void loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  /** Mechanism choices: the built-in plus every enabled plugin's offerings,
   *  with a keep-selectable placeholder when the configured id is gone. */
  const mechanismOptions = (): Array<{ id: string; name: string; description?: string }> => {
    const options: Array<{ id: string; name: string; description?: string }> = [
      { id: "suvoj-tracker", name: "Suvoj Tracker (built-in)" },
    ];
    // PluginInfo's tracker contributions are optional overlay fields the
    // shared type doesn't declare yet (server emits them).
    const list: Array<PluginInfo & PluginTrackerContributions> = plugins ?? [];
    for (const plugin of list) {
      for (const mechanism of plugin.trackerMechanisms ?? []) {
        options.push(mechanism);
      }
    }
    const current = config.mechanism;
    if (current !== "" && !options.some((option) => option.id === current)) {
      options.push({ id: current, name: `${current} (missing — falls back to Suvoj Tracker)` });
    }
    return options;
  };

  /** The selected mechanism's description, when the provider gives one. */
  const mechanismHint = (): string => {
    const current = config.mechanism;
    for (const option of mechanismOptions()) {
      if (option.id === current) {
        return option.description ?? "Where tracker snapshots come from.";
      }
    }
    return "Where tracker snapshots come from.";
  };

  const edit = (patch: Partial<TrackerConfig>): void => {
    setNote(null);
    setError(null);
    setConfig((current) => ({ ...current, ...patch }));
  };

  const editInjection = (patch: Partial<TrackerConfig["injection"]>): void => {
    setNote(null);
    setError(null);
    setConfig((current) => ({ ...current, injection: { ...current.injection, ...patch } }));
  };

  const editStepper = (
    key: "include_last_messages" | "include_last_trackers" | "keep_last" | "max_response_tokens",
    value: number,
  ): void => {
    edit({ [key]: value });
  };

  const editInjectionStepper = (value: number): void => {
    editInjection({ include_last: value });
  };

  /** True when the draft diverges from the last server truth. */
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);

  /**
   * Saves the whole tracker_config. Client-side gates first: the preset
   * editor must be valid (raw JSON parses, no blank/duplicate field rows),
   * preset keys must be kebab-case, and the active key must exist. A stored
   * profile_id pointing at a deleted profile drops out — the server resolves
   * missing ids to the default profile anyway; an empty list (fetch failed)
   * keeps the stored id so a network blip can't silently clear it.
   */
  const save = async (): Promise<void> => {
    if (saving || loadError !== null) {
      return;
    }
    const current = config;
    const issues: string[] = [];
    if (presetIssues !== null) {
      issues.push(presetIssues);
    }
    for (const key of Object.keys(current.schema_presets)) {
      if (!TRACKER_PRESET_KEY_RE.test(key)) {
        issues.push(`Preset key "${key}" must be lowercase kebab-case (a-z, 0-9, hyphens).`);
      }
    }
    if (
      Object.keys(current.schema_presets).length > 0 &&
      !(current.active_schema_key in current.schema_presets)
    ) {
      issues.push("The active preset no longer exists — pick a preset to save.");
    }
    if (issues.length > 0) {
      setError(issues.filter((issue) => issue !== "").join(" "));
      return;
    }
    const known = profiles.some((profile) => profile.id === current.profile_id);
    const profileId = known || profiles.length === 0 ? current.profile_id : "";
    setSaving(true);
    try {
      const saved = await putSettings({ tracker_config: { ...current, profile_id: profileId } });
      // Refresh from the response so a later edit starts from server truth.
      const next = normalizeTrackerConfig(saved.tracker_config);
      setConfig(next);
      setSavedConfig(next);
      setNote("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tracker settings");
    } finally {
      setSaving(false);
    }
  };

  /** Everything but the master toggle (and the drawer tabs) locks when off. */
  const off = !config.enabled;

  return (
    <div className="set-stack">
      <p className="caption muted set-intro">
        The tracker keeps a structured snapshot of the scene across replies — the preset's schema
        says what the model tracks, and the snapshot is injected into every prompt.
      </p>

      {loading ? (
        <SettingsLoading label="Loading tracker settings…" rows={3} />
      ) : loadError !== null ? (
        <SettingsError
          title="Couldn't load tracker settings"
          details={loadError}
          onRetry={loadConfig}
        />
      ) : (
        <>
          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">General</h3>
              </div>
            </header>
            <div className="set-card-body is-flush">
              <div className="set-rows">
                <label className="set-row switch-row" htmlFor="tracker-enabled">
                  <span className="set-row-main">
                    <span className="set-row-label">Enabled</span>
                    <span className="set-row-hint">
                      Master switch — tracking and prompt injection.
                    </span>
                  </span>
                  <span className="switch">
                    <input
                      id="tracker-enabled"
                      type="checkbox"
                      className="switch-input"
                      checked={config.enabled}
                      onChange={(event) => edit({ enabled: event.currentTarget.checked })}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                </label>
              </div>
              {off && (
                <div className="set-card-body">
                  <p className="caption muted">
                    Tracker is off — the settings below apply once it is enabled.
                  </p>
                </div>
              )}
            </div>
            <fieldset className="set-fields" disabled={off}>
              <div className="set-rows">
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Mechanism</span>
                    <span className="set-row-hint">{mechanismHint()}</span>
                  </span>
                  <select
                    className="select tracker-select"
                    aria-label="Tracker mechanism"
                    value={config.mechanism}
                    onChange={(event) => edit({ mechanism: event.currentTarget.value })}
                  >
                    {mechanismOptions().map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Auto mode</span>
                    <span className="set-row-hint">
                      When a new snapshot is generated. After user message waits for you to
                      continue, so discarded swipes and abandoned replies cost nothing.
                    </span>
                  </span>
                  <select
                    className="select tracker-select"
                    aria-label="Tracker auto mode"
                    value={config.auto_mode}
                    onChange={(event) =>
                      edit({
                        auto_mode: event.currentTarget.value as TrackerConfig["auto_mode"],
                      })
                    }
                  >
                    {AUTO_MODES.map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {mode.name}
                        {mode.id === "after_reply" ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Connection profile</span>
                    <span className="set-row-hint">
                      The model used for tracker generation — pick a cheaper model to save credits.
                    </span>
                  </span>
                  <select
                    className="select tracker-select"
                    aria-label="Tracker connection profile"
                    value={config.profile_id}
                    onChange={(event) => edit({ profile_id: event.currentTarget.value })}
                  >
                    <option value="">Default profile</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="set-row switch-row" htmlFor="tracker-invisible">
                  <span className="set-row-main">
                    <span className="set-row-label">Invisible mode</span>
                    <span className="set-row-hint">
                      Hides the tracker panel — the tracker still runs and still influences the AI.
                    </span>
                  </span>
                  <span className="switch">
                    <input
                      id="tracker-invisible"
                      type="checkbox"
                      className="switch-input"
                      checked={config.invisible}
                      onChange={(event) => edit({ invisible: event.currentTarget.checked })}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          </section>

          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Generation</h3>
              </div>
            </header>
            <fieldset className="set-fields" disabled={off}>
              <div className="set-rows">
                <StepperRow
                  label="Include last messages"
                  hint="Chat messages sent to the tracker generator. 0 = all"
                  value={config.include_last_messages}
                  min={0}
                  onChange={(value) => editStepper("include_last_messages", value)}
                />
                <StepperRow
                  label="Include last trackers"
                  hint="Snapshots from earlier positions sent to the tracker generator"
                  value={config.include_last_trackers}
                  min={0}
                  onChange={(value) => editStepper("include_last_trackers", value)}
                />
                <StepperRow
                  label="Keep last"
                  hint="Newest tracker per swipe kept across this many tracked positions"
                  value={config.keep_last}
                  min={1}
                  onChange={(value) => editStepper("keep_last", value)}
                />
                <StepperRow
                  label="Max response tokens"
                  hint="Token budget for the tracker generation response"
                  value={config.max_response_tokens}
                  min={1}
                  onChange={(value) => editStepper("max_response_tokens", value)}
                />
              </div>
              <div className="set-card-body">
                <div className="field">
                  <div className="tracker-prompt-head">
                    <label className="field-label" htmlFor="tracker-system-prompt">
                      System prompt
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => edit({ system_prompt: DEFAULT_TRACKER_SYSTEM_PROMPT })}
                    >
                      <RotateCcw size={12} />
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="tracker-system-prompt"
                    className="textarea tracker-code"
                    rows={8}
                    aria-label="Tracker system prompt"
                    value={config.system_prompt}
                    onChange={(event) => edit({ system_prompt: event.currentTarget.value })}
                  />
                  <span className="field-hint">
                    Sent to the tracker generator alongside the schema and chat excerpt. Reset
                    restores the built-in Suvoj Tracker prompt.
                  </span>
                </div>
              </div>
            </fieldset>
          </section>

          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Prompt injection</h3>
              </div>
            </header>
            <fieldset className="set-fields" disabled={off}>
              <div className="set-rows">
                <StepperRow
                  label="Include last"
                  hint="How many newest positions' selected-swipe snapshots are injected. 0 disables injection"
                  value={config.injection.include_last}
                  min={0}
                  onChange={editInjectionStepper}
                />
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Role</span>
                    <span className="set-row-hint">
                      The message role snapshots are injected as.
                    </span>
                  </span>
                  <select
                    className="select tracker-select"
                    aria-label="Injection role"
                    value={config.injection.role}
                    onChange={(event) =>
                      editInjection({
                        role: event.currentTarget.value as TrackerConfig["injection"]["role"],
                      })
                    }
                  >
                    {INJECTION_ROLES.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Header</span>
                    <span className="set-row-hint">
                      Line above each injected snapshot. Empty = no header line.
                    </span>
                  </span>
                  <input
                    className="input tracker-header-input"
                    type="text"
                    aria-label="Injection header"
                    placeholder="Tracker:"
                    value={config.injection.header}
                    onChange={(event) => editInjection({ header: event.currentTarget.value })}
                  />
                </div>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Format</span>
                    <span className="set-row-hint">
                      How each snapshot is rendered. Plain text emits compact key/value lines with a
                      read-only guard line and no fence (the default), so the roleplay model is far
                      less likely to echo the tracker into its reply. JSON restores the fenced
                      ```json block.
                    </span>
                  </span>
                  <select
                    className="select tracker-select"
                    aria-label="Injection format"
                    value={config.injection.format}
                    onChange={(event) =>
                      editInjection({
                        format: event.currentTarget.value as TrackerConfig["injection"]["format"],
                      })
                    }
                  >
                    {INJECTION_FORMATS.map((format) => (
                      <option key={format.id} value={format.id}>
                        {format.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>
          </section>

          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Schema presets</h3>
              </div>
            </header>
            <fieldset className="set-fields" disabled={off}>
              <div className="set-card-body">
                <SchemaPresetsCard
                  presets={config.schema_presets}
                  activeKey={config.active_schema_key}
                  onEdit={edit}
                  onIssues={setPresetIssues}
                />
              </div>
            </fieldset>
          </section>

          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Chat drawer tabs</h3>
              </div>
            </header>
            <div className="set-card-body is-flush">
              <DrawerTabsCard />
            </div>
          </section>

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || presetIssues !== null || !dirty}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {dirty && !saving && <span className="caption muted">Unsaved changes</span>}
            <SettingsSaved note={note} />
            {error !== null && <span className="field-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
