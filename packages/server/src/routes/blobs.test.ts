/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { blobsRoutes } from "./blobs";

/** Temp dataDir for the blob store; each test writes uniquely-named files. */
const dataDir = await mkdtemp(path.join(tmpdir(), "suvoj-blobs-"));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Stand-in fetch (with Bun's `preconnect` member); never called by these routes. */
const fetchImpl = Object.assign(
  async (): Promise<Response> => new Response("{}", { status: 200 }),
  { preconnect: () => {} },
);

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }), dataDir };
  return { app: new Hono().route("/", blobsRoutes(deps)), repos };
}

describe("GET /blobs/*", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it("serves a stored blob as image/webp", async () => {
    const { app } = makeApp();
    await mkdir(path.join(dataDir, "blobs"), { recursive: true });
    await writeFile(path.join(dataDir, "blobs", "a1b2c3.webp"), bytes);
    const res = await app.request("/blobs/a1b2c3.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("404 for a missing blob", async () => {
    const { app } = makeApp();
    const res = await app.request("/blobs/missing.webp");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Blob not found" });
  });

  it("never serves files outside the blobs dir", async () => {
    const { app } = makeApp();
    await writeFile(path.join(dataDir, "secret.txt"), "TOP SECRET");
    for (const pathName of [
      "/blobs/..%2Fsecret.txt",
      "/blobs/..%2F..%2Fsecret",
      "/blobs/%2e%2e%2Fsecret.txt",
      "/blobs/%2Fetc%2Fpasswd",
      "/blobs/",
      "/blobs/../secret.txt",
    ]) {
      const res = await app.request(pathName);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("SECRET");
    }
  });
});
