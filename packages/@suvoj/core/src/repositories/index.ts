/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import { type ChatHookBus, chatHooks } from "./hooks";
import { SettingsRepository, VariablesRepository } from "./kv";
import { LorebooksRepository } from "./lorebooks";
import { MessagesRepository } from "./messages";
import { PersonasRepository } from "./personas";
import { PresetsRepository } from "./presets";
import { ProfilesRepository } from "./profiles";
import { SummariesRepository } from "./summaries";
import { TrackerRepository } from "./tracker";

export * from "./characters";
export * from "./chats";
export * from "./hooks";
export * from "./kv";
export * from "./lorebooks";
export * from "./messages";
export * from "./personas";
export * from "./presets";
export * from "./profiles";
export * from "./summaries";
export * from "./summary-cascade";
export * from "./summary-events";
export * from "./tracker";
export * from "./tracker-cascade";

/** One instance of every repository over a shared database. */
export interface Repositories {
  characters: CharactersRepository;
  personas: PersonasRepository;
  chats: ChatsRepository;
  messages: MessagesRepository;
  lorebooks: LorebooksRepository;
  summaries: SummariesRepository;
  presets: PresetsRepository;
  profiles: ProfilesRepository;
  settings: SettingsRepository;
  variables: VariablesRepository;
  trackers: TrackerRepository;
}

/** Builds the full repository set over `db` (hooks bus injectable for tests). */
export function createRepositories(db: Database, hooks: ChatHookBus = chatHooks): Repositories {
  return {
    characters: new CharactersRepository(db),
    personas: new PersonasRepository(db),
    chats: new ChatsRepository(db),
    messages: new MessagesRepository(db, hooks),
    lorebooks: new LorebooksRepository(db),
    summaries: new SummariesRepository(db),
    presets: new PresetsRepository(db),
    profiles: new ProfilesRepository(db),
    settings: new SettingsRepository(db),
    variables: new VariablesRepository(db),
    trackers: new TrackerRepository(db),
  };
}
