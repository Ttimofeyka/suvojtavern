/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character, Lorebook } from "@suvoj/core";
import { st } from "@suvoj/core";
import type { Repos, RouteDeps } from "../routes-deps";
import { JANITOR_ORIGIN } from "./browser";
import { getJanitorBrowser } from "./browser-instance";
import { downloadAvatar, fetchCharacterMetadata, probeLogin } from "./client";
import { definitionPrivateError, JanitorError, notLoggedInError } from "./errors";
import {
  emptyLorebookRead,
  type JanitorLorebookOutcome,
  persistLorebooks,
  readLorebooks,
} from "./lorebooks";

/**
 * Phase A: import a JanitorAI character whose definition the creator left
 * PUBLIC. The `/hampter/characters/:id` response *is* the card in that case,
 * so no prompt capture is needed — the only browser work is reading the
 * metadata and any downloadable public lorebooks, all in one background
 * session.
 *
 * Private definitions are rejected with a `definition-private` error that the
 * UI turns into an "Extract anyway" button (Phase B / `captureAndReconstruct`).
 */

/** What POST /api/janitor/import accepts. */
export interface JanitorImportInput {
  url: string;
  onConflict?: "error" | "rename" | "replace";
  /** When false, attached lorebooks are neither imported nor scanned. */
  includeLorebooks?: boolean;
}

/** The frozen result shape shared by /import and /capture. */
export interface JanitorImportResult {
  character: Character;
  /** First imported lorebook row, or null. */
  lorebook: Lorebook | null;
  lorebooks: JanitorLorebookOutcome[];
  renamed: boolean;
  source: "janitor";
  definitionSource: "public" | "reconstructed";
  warnings: string[];
}

/** Blob dir the card importer writes avatars into (matches transfer-import). */
export function blobDirFor(deps: RouteDeps): string {
  return `${deps.dataDir ?? "data"}/blobs`;
}

/**
 * Reject a duplicate name up front when the caller asked for `error`, so the
 * route can answer 409 (the preset-import convention) instead of the core
 * importer's generic 400. `rename`/`replace` fall through to core's handling.
 */
export function assertNoNameConflict(
  repos: Repos,
  name: string,
  onConflict: "error" | "rename" | "replace",
): void {
  if (onConflict !== "error" || name === "") return;
  const exists = repos.characters
    .list()
    .some((character) => character.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    throw new JanitorError(`character "${name}" already exists`, 409);
  }
}

/** Parse a janitor source to a character id, throwing a 400 on anything else. */
export function requireJanitorRef(url: string): { id: string } {
  const source = st.parseJanitorSource(url);
  if (source.kind === "ref") return { id: source.ref.id };
  throw new JanitorError(
    source.kind === "error" ? source.message : "url is not a janitorai.com character URL",
    400,
  );
}

/** True for the card name a TavernCardV2 carries (used for conflict pre-checks). */
export function cardNameOf(card: unknown): string {
  const data = (card as { data?: unknown } | null)?.data;
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.trim() : "";
}

/**
 * Import a public JanitorAI character. Everything runs inside one background
 * browser session: navigate to the origin (so `view.fetch` carries the
 * cookies + Cloudflare clearance), require a login, read the catalog record,
 * then import the card and its public lorebooks.
 */
export async function importPublicCard(
  input: JanitorImportInput,
  deps: RouteDeps,
): Promise<JanitorImportResult> {
  const { id } = requireJanitorRef(input.url);
  const onConflict = input.onConflict ?? "error";
  const includeLorebooks = input.includeLorebooks !== false;
  const browser = getJanitorBrowser(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const blobDir = blobDirFor(deps);

  return browser.withView(
    async (view) => {
      await view.navigate(JANITOR_ORIGIN);
      if (!(await probeLogin(view))) throw notLoggedInError();

      const meta = await fetchCharacterMetadata(view, id);
      if (meta === null) {
        throw new JanitorError(`could not read JanitorAI character ${id}`, 400);
      }
      if (!st.janitorIsCardPublic(meta)) {
        // The catalog record exists but the definition is hidden (or empty).
        throw definitionPrivateError();
      }
      const mapped = st.janitorCardFromMetadata(meta);
      if (mapped === null) {
        throw new JanitorError(`JanitorAI character ${id} has no usable name`, 400);
      }

      assertNoNameConflict(deps.repos, cardNameOf(mapped.card), onConflict);

      // Read the public lorebooks before the card import so a browser hiccup
      // cannot leave a half-imported character; they are persisted after the
      // character row exists (their link target).
      const read = includeLorebooks
        ? await readLorebooks(view, mapped.lorebooks)
        : emptyLorebookRead();

      // Avatar is fetched server-side (public CDN, no session) and passed to
      // the importer as the source image for the lossless-WebP pipeline.
      const avatar = await downloadAvatar(fetchImpl, mapped.avatarFile);
      const imported = await st.importCardFromJson(mapped.card, deps.repos, {
        onConflict,
        blobDir,
        sourcePng: avatar ?? undefined,
      });

      const scan = persistLorebooks(read, deps.repos, imported.character);

      return {
        character: imported.character,
        lorebook: scan.first,
        lorebooks: scan.outcomes,
        renamed: imported.renamed,
        source: "janitor",
        definitionSource: "public",
        warnings: scan.warnings,
      } satisfies JanitorImportResult;
    },
    { mode: "background" },
  );
}
