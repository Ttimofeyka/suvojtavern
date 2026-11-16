/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from "node:path";
import { migrations, openDatabase, runMigrations } from "@suvoj/core";
import { seedBuiltInPreset, seedDefaultProfile, seedDefaultRegexRules } from "./seed";

const path = resolve("data/suvoj.db");
const db = openDatabase();
try {
  const applied = runMigrations(db, migrations);
  console.log(
    applied.length > 0
      ? `db: ${path} initialized (applied: ${applied.join(", ")})`
      : `db: ${path} already up to date`,
  );
  // The app always needs a preset available — seed (or version-refresh) the
  // built-in one. The version gate keeps user edits intact between bumps.
  console.log(`seed: built-in preset: ${seedBuiltInPreset(db)}`);
  // Generation also needs at least one connection profile.
  console.log(`seed: default profile: ${seedDefaultProfile(db)}`);
  // The built-in regex rule (Quote Cleaner) — create-when-no-array, so an
  // existing (even empty) list is preserved.
  console.log(`seed: regex rules: ${seedDefaultRegexRules(db)}`);
} finally {
  db.close();
}
