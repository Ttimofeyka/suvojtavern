/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";
import { migration001Init } from "./001_init";
import { migration002Profiles } from "./002_profiles";
import { migration003PresetsV2 } from "./003_presets_v2";
import { migration004LorebookLinkEnabled } from "./004_lorebook_link_enabled";
import { migration005Tracker } from "./005_tracker";
import { migration006ProfileEndpoints } from "./006_profile_endpoints";
import { migration007LorebookSections } from "./007_lorebook_sections";
import { migration008CharactersNameIndex } from "./008_characters_name_index";
import { migration009TrackerMessageIndex } from "./009_tracker_message_index";
import { migration010RenameZtrackerMechanism } from "./010_rename_ztracker_mechanism";
import { migration011ChatTrackerEnabled } from "./011_chat_tracker_enabled";
import { migration012DropAuth } from "./012_drop_auth";
import { migration013ThemeAwareTrackerPresetCss } from "./013_theme_aware_tracker_preset_css";

/** All schema migrations, applied by id order (see runMigrations). */
export const migrations: readonly Migration[] = [
  migration001Init,
  migration002Profiles,
  migration003PresetsV2,
  migration004LorebookLinkEnabled,
  migration005Tracker,
  migration006ProfileEndpoints,
  migration007LorebookSections,
  migration008CharactersNameIndex,
  migration009TrackerMessageIndex,
  migration010RenameZtrackerMechanism,
  migration011ChatTrackerEnabled,
  migration012DropAuth,
  migration013ThemeAwareTrackerPresetCss,
];
