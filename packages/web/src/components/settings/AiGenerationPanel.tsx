/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from "react";
import { getSettings, putSettings } from "../../lib/api";
import {
  type CharacterGenerationConfig,
  DEFAULT_CHARACTER_GENERATION_PROMPT,
  normalizeCharacterGenerationConfig,
} from "../../lib/api-character-generation";
import {
  DEFAULT_LOREBOOK_GENERATION_PROMPT,
  type LorebookGenerationConfig,
  normalizeLorebookGenerationConfig,
} from "../../lib/api-lorebook-generation";
import type { Profile } from "../../lib/api-profiles";
import { listProfiles } from "../../lib/api-profiles";
import {
  setCharacterGenerationConfig,
  setLorebookGenerationConfig,
} from "../../stores/ai-generation";
import { RotateCcw } from "../ui/icons";
import "../../styles/settings.css";
import { SettingsError, SettingsLoading, SettingsSaved } from "./SettingsStates";

/**
 * AI generation settings (Settings → AI Generation): the connection profile,
 * system prompt, token cap, and master switch behind BOTH the character
 * editor's "Generate description" and the lorebook entry editor's "Generate
 * content" actions. Mirrors the TrackerSettings load/save idiom — one Save
 * button, "Saved" note, and a separate loadError so a failed GET can never
 * overwrite the stored configs with unwritten defaults.
 */
export default function AiGenerationPanel() {
  const [charConfig, setCharConfig] = useState<CharacterGenerationConfig>(() =>
    normalizeCharacterGenerationConfig({}),
  );
  const [loreConfig, setLoreConfig] = useState<LorebookGenerationConfig>(() =>
    normalizeLorebookGenerationConfig({}),
  );
  /** Connection profiles for the generator-profile selects. */
  const [profiles, setProfiles] = useState<Profile[]>([]);
  /** Server truth the Save button diffs against (the changed-state signal). */
  const [savedChar, setSavedChar] = useState<CharacterGenerationConfig>(() =>
    normalizeCharacterGenerationConfig({}),
  );
  const [savedLore, setSavedLore] = useState<LorebookGenerationConfig>(() =>
    normalizeLorebookGenerationConfig({}),
  );
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True until the first GET settles (either way); drives the skeleton. */
  const [loading, setLoading] = useState(true);
  /** GET /api/settings failed — without the stored values a save would wipe the
   *  real configs, so the panel stays locked until a retry succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Loads the stored config into local state. A stable callback so the mount
   * effect and the error state's retry button run the same path. A load never
   * falls back to defaults: saving them would overwrite the real configs, so a
   * failure stays visible through loadError.
   */
  const loadConfig = useCallback((): void => {
    setLoading(true);
    setLoadError(null);
    getSettings()
      .then((settings) => {
        const nextChar = normalizeCharacterGenerationConfig(settings.character_generation);
        const nextLore = normalizeLorebookGenerationConfig(settings.lorebook_generation);
        setCharConfig(nextChar);
        setLoreConfig(nextLore);
        setSavedChar(nextChar);
        setSavedLore(nextLore);
        // Push server truth into the shared store so the editors' generate
        // actions reflect the enabled flags immediately.
        setCharacterGenerationConfig(nextChar);
        setLorebookGenerationConfig(nextLore);
      })
      .catch((err: unknown) => {
        // Not silently swallowed: saving over unwritten defaults would PUT them
        // as the whole values and wipe the stored configs.
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      })
      .finally(() => setLoading(false));
    listProfiles()
      .then((result) => setProfiles(result.profiles))
      .catch(() => {}); // profiles unreachable — the selects show the default only
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const editChar = (patch: Partial<CharacterGenerationConfig>): void => {
    setNote(null);
    setError(null);
    setCharConfig((current) => ({ ...current, ...patch }));
  };

  const editLore = (patch: Partial<LorebookGenerationConfig>): void => {
    setNote(null);
    setError(null);
    setLoreConfig((current) => ({ ...current, ...patch }));
  };

  // A stored profile_id pointing at a deleted profile drops out — the server
  // resolves missing ids to the default profile anyway; an empty list (fetch
  // failed) keeps the stored id so a network blip can't silently clear it.
  const resolveProfileId = (id: string): string =>
    profiles.length === 0 || profiles.some((profile) => profile.id === id) ? id : "";

  /** True when either config diverges from the last server truth. */
  const dirty =
    JSON.stringify(charConfig) !== JSON.stringify(savedChar) ||
    JSON.stringify(loreConfig) !== JSON.stringify(savedLore);

  const save = async (): Promise<void> => {
    if (saving || loadError !== null) {
      return;
    }
    setSaving(true);
    try {
      const saved = await putSettings({
        character_generation: {
          ...charConfig,
          profile_id: resolveProfileId(charConfig.profile_id),
        },
        lorebook_generation: { ...loreConfig, profile_id: resolveProfileId(loreConfig.profile_id) },
      });
      // Refresh from the response so a later edit starts from server truth.
      const nextChar = normalizeCharacterGenerationConfig(saved.character_generation);
      const nextLore = normalizeLorebookGenerationConfig(saved.lorebook_generation);
      setCharConfig(nextChar);
      setLoreConfig(nextLore);
      setSavedChar(nextChar);
      setSavedLore(nextLore);
      setCharacterGenerationConfig(nextChar);
      setLorebookGenerationConfig(nextLore);
      setNote("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save AI generation settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="set-stack">
      <p className="caption muted set-intro">
        The connection profile, system prompt, and token cap behind the AI generation actions in the
        character and lorebook editors. Disable a feature to hide its action button.
      </p>

      {loading ? (
        <SettingsLoading label="Loading AI generation settings…" rows={3} />
      ) : loadError !== null ? (
        <SettingsError
          title="Couldn't load AI generation settings"
          details={loadError}
          onRetry={loadConfig}
        />
      ) : (
        <>
          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Character description</h3>
              </div>
            </header>
            <div className="set-card-body is-flush">
              <div className="set-rows">
                <label className="set-row switch-row" htmlFor="ai-gen-character-enabled">
                  <span className="set-row-main">
                    <span className="set-row-label">Enabled</span>
                    <span className="set-row-hint">
                      Show the “Generate description” action in the character editor.
                    </span>
                  </span>
                  <span className="switch">
                    <input
                      id="ai-gen-character-enabled"
                      type="checkbox"
                      className="switch-input"
                      checked={charConfig.enabled}
                      onChange={(event) => editChar({ enabled: event.currentTarget.checked })}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                </label>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Connection profile</span>
                    <span className="set-row-hint">
                      The model used for description generation — pick a cheaper model to save
                      credits.
                    </span>
                  </span>
                  <select
                    className="select ai-gen-select"
                    aria-label="Character generation connection profile"
                    value={charConfig.profile_id}
                    onChange={(event) => editChar({ profile_id: event.currentTarget.value })}
                  >
                    <option value="">Default profile</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.is_default ? `${profile.name} (default)` : profile.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="set-card-body">
                <div className="field">
                  <div className="ai-gen-prompt-head">
                    <label className="field-label" htmlFor="ai-gen-character-prompt">
                      System prompt
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        editChar({ system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT })
                      }
                    >
                      <RotateCcw size={12} />
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="ai-gen-character-prompt"
                    className="textarea ai-gen-code"
                    rows={16}
                    aria-label="Character generation system prompt"
                    value={charConfig.system_prompt}
                    onChange={(event) => editChar({ system_prompt: event.currentTarget.value })}
                  />
                  <span className="field-hint">
                    Sent to the generator with the character's name, tags, idea, and current
                    description. Reset restores the built-in prompt.
                  </span>
                </div>
              </div>
              <div className="set-rows">
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Max response tokens</span>
                    <span className="set-row-hint">
                      Token budget for the generated description.
                    </span>
                  </span>
                  <input
                    className="input ai-gen-tokens"
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Character generation max response tokens"
                    value={charConfig.max_response_tokens}
                    onChange={(event) => {
                      // Empty text mid-edit: keep the last good value; the
                      // controlled input restores it on the next paint.
                      const text = event.currentTarget.value;
                      if (text === "") {
                        return;
                      }
                      const parsed = Number(text);
                      if (Number.isFinite(parsed)) {
                        editChar({ max_response_tokens: Math.max(1, Math.trunc(parsed)) });
                      }
                    }}
                    onBlur={(event) => {
                      event.currentTarget.value = String(charConfig.max_response_tokens);
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Lorebook entries</h3>
              </div>
            </header>
            <div className="set-card-body is-flush">
              <div className="set-rows">
                <label className="set-row switch-row" htmlFor="ai-gen-lorebook-enabled">
                  <span className="set-row-main">
                    <span className="set-row-label">Enabled</span>
                    <span className="set-row-hint">
                      Show the “Generate content” action in the lorebook entry editor.
                    </span>
                  </span>
                  <span className="switch">
                    <input
                      id="ai-gen-lorebook-enabled"
                      type="checkbox"
                      className="switch-input"
                      checked={loreConfig.enabled}
                      onChange={(event) => editLore({ enabled: event.currentTarget.checked })}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                </label>
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Connection profile</span>
                    <span className="set-row-hint">
                      The model used for entry generation — pick a cheaper model to save credits.
                    </span>
                  </span>
                  <select
                    className="select ai-gen-select"
                    aria-label="Lorebook generation connection profile"
                    value={loreConfig.profile_id}
                    onChange={(event) => editLore({ profile_id: event.currentTarget.value })}
                  >
                    <option value="">Default profile</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.is_default ? `${profile.name} (default)` : profile.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="set-card-body">
                <div className="field">
                  <div className="ai-gen-prompt-head">
                    <label className="field-label" htmlFor="ai-gen-lorebook-prompt">
                      System prompt
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        editLore({ system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT })
                      }
                    >
                      <RotateCcw size={12} />
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="ai-gen-lorebook-prompt"
                    className="textarea ai-gen-code"
                    rows={16}
                    aria-label="Lorebook generation system prompt"
                    value={loreConfig.system_prompt}
                    onChange={(event) => editLore({ system_prompt: event.currentTarget.value })}
                  />
                  <span className="field-hint">
                    Sent to the generator with your description, instructions, and the entry's
                    current content. Reset restores the built-in prompt.
                  </span>
                </div>
              </div>
              <div className="set-rows">
                <div className="set-row">
                  <span className="set-row-main">
                    <span className="set-row-label">Max response tokens</span>
                    <span className="set-row-hint">
                      Token budget for the generated entry content.
                    </span>
                  </span>
                  <input
                    className="input ai-gen-tokens"
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Lorebook generation max response tokens"
                    value={loreConfig.max_response_tokens}
                    onChange={(event) => {
                      // Empty text mid-edit: keep the last good value; the
                      // controlled input restores it on the next paint.
                      const text = event.currentTarget.value;
                      if (text === "") {
                        return;
                      }
                      const parsed = Number(text);
                      if (Number.isFinite(parsed)) {
                        editLore({ max_response_tokens: Math.max(1, Math.trunc(parsed)) });
                      }
                    }}
                    onBlur={(event) => {
                      event.currentTarget.value = String(loreConfig.max_response_tokens);
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !dirty}
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
