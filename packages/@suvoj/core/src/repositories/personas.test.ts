/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb } from "../test-utils";
import { PersonasRepository } from "./personas";

let personas: PersonasRepository;

beforeEach(() => {
  personas = new PersonasRepository(createTestDb());
});

describe("PersonasRepository", () => {
  it("round-trips personas", () => {
    const persona = personas.create({ name: "User", description: "A person" });
    expect(personas.get(persona.id)).toEqual(persona);
    expect(personas.list().map((p) => p.name)).toEqual(["User"]);
  });

  it("updates and deletes personas", () => {
    const persona = personas.create({ name: "User" });
    const updated = personas.update(persona.id, {
      name: "Renamed",
      avatar_path: "data/blobs/p.webp",
    });
    expect(updated).toMatchObject({ name: "Renamed", avatar_path: "data/blobs/p.webp" });
    expect(personas.delete(persona.id)).toBe(true);
    expect(personas.get(persona.id)).toBe(null);
  });
});
