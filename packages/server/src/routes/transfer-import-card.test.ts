/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { transferRoutes } from "./transfer";

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  return { app: new Hono().route("/", transferRoutes(deps)), repos };
}

/** A minimal ST V2 card with one embedded character_book entry. */
function v2Card(name: string, description: string): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description,
      personality: "kind",
      first_mes: "Greetings, traveler!",
      alternate_greetings: ["Hey!", "Yo!"],
      character_book: { name: `${name}'s Tome`, entries: [{ keys: ["moon"], content: "Full." }] },
    },
  };
}

const jsonFile = (value: unknown): File =>
  new File([JSON.stringify(value)], "card.json", { type: "application/json" });

async function postCard(app: Hono, file: File, onConflict?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  if (onConflict !== undefined) {
    form.append("onConflict", onConflict);
  }
  return app.request("/api/import/card", { method: "POST", body: form });
}

describe("POST /api/import/card", () => {
  it("imports a V2 JSON card and its embedded character_book", async () => {
    const { app, repos } = makeApp();
    const res = await postCard(app, jsonFile(v2Card("Vesper", "a dusk card")));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: { id: string } };
    expect(repos.characters.get(body.character.id)).toMatchObject({
      name: "Vesper",
      description: "a dusk card",
      personality: "kind",
      first_mes: "Greetings, traveler!",
      alternate_greetings: ["Hey!", "Yo!"],
    });
    const [book] = repos.lorebooks.listForCharacter(body.character.id);
    expect(book?.name).toBe("Vesper's Tome");
    expect(repos.lorebooks.listEntries(book?.id ?? "")[0]).toMatchObject({
      keys: ["moon"],
      content: "Full.",
    });
  });

  it("handles duplicate names per onConflict: error, rename, replace", async () => {
    const { app, repos } = makeApp();
    await postCard(app, jsonFile(v2Card("Dup", "original")));
    const dup = await postCard(app, jsonFile(v2Card("Dup", "second")));
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: 'character "Dup" already exists' });

    const renamed = await postCard(app, jsonFile(v2Card("Dup", "second")), "rename");
    expect(renamed.status).toBe(201);
    expect(await renamed.json()).toMatchObject({ renamed: true, character: { name: "Dup (2)" } });
    expect(repos.characters.list().map((c) => c.name)).toEqual(["Dup", "Dup (2)"]);

    const replaced = await postCard(app, jsonFile(v2Card("Dup", "replaced")), "replace");
    expect(replaced.status).toBe(201);
    const body = (await replaced.json()) as { character: { id: string; description: string } };
    const [dupRow] = repos.characters.list().filter((c) => c.name === "Dup");
    expect(dupRow?.id).toBe(body.character.id); // replaced in place, no third character
    expect(body.character.description).toBe("replaced");
  });

  it("rejects missing/empty file, bad onConflict, and non-JSON with 400", async () => {
    const { app } = makeApp();
    const cases: Array<[Response, string]> = [
      [
        await app.request("/api/import/card", { method: "POST", body: new FormData() }),
        "multipart body must contain a 'file' field",
      ],
      [await postCard(app, new File([], "card.json")), "uploaded 'file' is empty"],
      [
        await postCard(app, jsonFile(v2Card("Ok", "x")), "merge"),
        "onConflict must be one of: error, rename, replace",
      ],
      [
        await postCard(app, new File(["{not json"], "card.json")),
        "uploaded 'file' is neither a PNG card nor valid JSON",
      ],
      [await postCard(app, jsonFile({ spec: "chara_card_v2", data: {} })), "card has no name"],
    ];
    for (const [res, error] of cases) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    }
  });
});
