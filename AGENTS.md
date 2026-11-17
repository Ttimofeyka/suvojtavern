# SuvojTavern

Self-hosted AI roleplay chat app. Bun workspace monorepo, executed from TypeScript source — **no compile step for server/core**.

## Layout

- `packages/@suvoj/core` — DB, repositories, prompt engine, memory strategies, tracker, SillyTavern import/export. No server or DOM deps.
- `packages/@suvoj/plugin-sdk` — type-only re-export surface + `definePlugin` identity fn.
- `packages/server` — Hono app on `Bun.serve` + `bun:sqlite`. Composition root is `src/app.ts`.
- `packages/web` — React 19 + Vite SPA (plain global CSS, no Tailwind/CSS modules).
- `plugins/` — one folder per server plugin; loaded at runtime, no rebuild.

Dependency direction: `server → core + plugin-sdk`, `plugin-sdk → core`. Packages export `./src/index.ts` directly.

## Commands

Always use the root scripts; several commands are cwd-sensitive.

```bash
bun run dev        # server on 127.0.0.1:3210 (bun --watch), cwd=packages/server
bun run dev:web    # Vite dev server (5173); proxies /api and /blobs to :3210
bun run build      # builds web only → packages/web/dist (server serves this in prod)
bun test           # all tests, recursive across workspaces
bun run lint       # biome check .
bun run format     # biome format --write .
bun run db:init    # migrate + seed preset/default profile
bun run db:seed    # db:init plus lorebook + default persona seeds
bun run typecheck:plugins   # tsc -p plugins --noEmit
```

- **There is no root `typecheck`.** Run per package: `bun run --cwd packages/server typecheck`, same for `packages/@suvoj/core`, `packages/@suvoj/plugin-sdk`, `packages/web`.
- Single test: `bun test packages/server/src/routes/messages.test.ts`, or `bun test -t "name"`.
- `db:init` / `db:seed` run with cwd `packages/server`, so the real dev DB is **`packages/server/data/suvoj.db`** — not `./data`. Invoke them via the root scripts, never by hand from another cwd.
- `packages/server/seed/*.json` are the canonical, shipped seed assets and the only copies in the repo. Tests read them directly too, so a change there must keep the suite green.

## Conventions (differ from defaults)

- ESM everywhere; **no file extensions in relative imports** (`./app`, not `./app.js`) — `moduleResolution: bundler`.
- `verbatimModuleSyntax` + `isolatedModules` are on: use `import type` for type-only imports.
- Zod is **v4**. Request bodies parse with the local `parseJsonBody(schema, ...)` helper in `routes-deps.ts` (not `schema.safeParse` inline).
- Do **not** build PATCH schemas from a create schema via `.partial()` when fields have `.default()` — defaults survive and wipe columns. Write PATCH schemas explicitly with `.optional()` (documented in `routes/characters.ts`).
- JSON responses use **snake_case** keys matching DB columns (`character_id`, `created_at`).
- Errors are `{ error: string, details?: unknown }`; `GatewayError` status passes through for 4xx else 502; `ZodError` → 400.
- Biome: 2-space, 100 cols, double quotes, semicolons, organized imports.
- Every first-party source file (`.ts`, `.tsx`, `.css`, `.html`) starts with the MPL-2.0 Exhibit A header from `LICENSE` — copy the block when creating a file. JSON, lockfiles, and vendored `.agents/` files are exempt.
- Entry modules are import-side-effect-free: boot logic lives behind `if (import.meta.main)` so `bun test` never opens the live DB.
- Comments are dense and explain *why* — match them.

## Testing

- `bun:test`, `*.test.ts` colocated with source. No `*.test.tsx`.
- Fully hermetic — no DB, fixtures, services, or env required. Tests open `openDatabase(":memory:")` + `runMigrations`; helpers in `packages/@suvoj/core/src/test-utils.ts`.
- Plugin discovery is process-global: pass `pluginsDir: null` to `createApp(...)` in tests so the real `plugins/example-plugin` doesn't leak into the shared engine registry.
- Upstream network is stubbed via `createApp({ fetchImpl })` / `createGateway({ repos, fetchImpl })`.
- `packages/web/tsconfig.json` **excludes `src/**/*.test.ts`** and sets `"types": ["react", "react-dom"]` (no `bun-types`), so web tests run under `bun test` but are **not** typechecked by `tsc`.

## Runtime gotchas

- `Bun.serve({ idleTimeout: 255 })` is deliberate — SSE generation streams idle past Bun's 10s default.
- Server env vars: `HOST`, `PORT`, `SUVOJ_AUTH_USERNAME`, `SUVOJ_AUTH_PASSWORD`, `SUVOJ_LAN`. `SUVOJ_LAN` is opt-in and off by default; when truthy (anything present other than `""`/`0`/`false`/`no`/`off`, compared after trim + lowercase so e.g. `" OFF "` is falsy) it binds `0.0.0.0` and the startup banner prints detected private-LAN IPv4 URLs. An explicit `HOST` always wins over `SUVOJ_LAN`; a blank/whitespace-only `HOST` is treated as unset and falls through to `SUVOJ_LAN`. LAN exposure is still gated by the credential guard: a non-loopback host without `SUVOJ_AUTH_*` throws at startup. `bun run dev:web` honors the same `SUVOJ_LAN` flag for its host. There is **no DB-path env var** and no `.env` file exists.
- Auth is HTTP Basic, applied to **all** routes including `/health` and the SPA fallback. The server refuses a non-loopback `HOST` without credentials and throws on partial credentials.
- `/api/auth/*` (the Suvoj device-flow login) is gone entirely: the routes, the `auth` DB table, and `AuthRepository` were removed (migration `012_drop_auth`). There is no built-in Suvoj endpoint and no server-level credential store; a connection profile carries its own `base_url` plus an optional `api_key`.
- SPA fallback (`routes/static.ts`) serves `packages/web/dist` resolved from the source file, not cwd. Run `bun run build` before testing the server-served UI.
- Tracker generation is per-chat and swipe-aware: a snapshot attaches to one message/swipe row, uses the tracker's own connection profile, and injects the selected swipe's snapshots as transient (non-persisted) prompt messages. The built-in schema tracks pronouns, a capped off-stage list, `knownCast`, and `secrets`; the tracker injects under the `system` role by default. See `docs/TRACKER.md`.
- Prompt layout is cache-stable: inside the `chatHistory` marker the order is new-chat prompt → live messages (+ depth injections) → memory summary → tracker state (`ctx.tail`) → (then whatever follows the marker: the shipped preset puts its CoT there, then `jailbreak`). `PromptContext.history` is conversation (trimmable, rewritten by memory stages); `PromptContext.tail` is injected STATE — a stage that injects state belongs in `tail`, never `history`. Volatile macros (`{{time}}`, `{{date}}`, `{{idle_duration}}`, `{{lastMessage}}`, `{{random}}`, `{{roll}}`) in a block rendering BEFORE `chatHistory` defeat provider prefix caching; `{{pick}}` is exempt (seeded per chat). Detection lives in `engine/macros.ts#volatileMacrosIn`, mirrored for the editor in `web/src/lib/preset-cache.ts` (a test pins the two lists).
- The post-response tail (level-0 summarization + the `after_reply` tracker snapshot) runs concurrently via `Promise.allSettled` in `routes/generate.ts`, after the `summarizing`/`tracking` status events are announced — `summarizing` only when the run has work (`hasSummarizationWork`: a full uncovered chunk or a layer over its promotion cap), so a fresh chat never flashes the pill; `done` still lands last. `before_reply` tracking stays sequential — its snapshot must exist before assembly reads it — and `after_user_message` is the same shape: when the tail is a just-sent user turn it tracks the PREVIOUS active message with the tracker prompt scoped through it (the new turn is excluded), skipping a reply that already carries a snapshot.

## Connection profiles & endpoints

- `connection_profiles` own their endpoint: a `base_url` (a real http(s) URL; empty means the profile has no endpoint and resolution fails with a clean 400) plus a plaintext `api_key`. The read shape from `/api/profiles*` exposes `base_url` + `has_api_key: boolean`, never `api_key`; `api_key` is write-only (PATCH: absent = keep, `null` = clear, string = set).
- Endpoint/auth resolution lives in `gateway-shared.ts`: `Endpoint`, `resolveEndpoint(repos, profile)` (the profile is required; an empty `base_url` throws a `GatewayError` 400), `normalizeBaseUrl`, `authHeadersFor(endpoint)`. The profile's own `api_key`, when set, becomes the `Authorization: Bearer` header; a keyless endpoint (Ollama/LM Studio) sends none.
- The gateway takes an `endpoint` on `chatCompletion` and `getModels(endpoint?)` (models cache keyed per base URL); a call without one (no profile configured) is a clean 400. `GET /api/models` uses the active profile's endpoint; `GET /api/profiles/:id/models` lists models from that profile's own endpoint+key.
- Thinking is on by default. `reasoning_effort` lives in the profile's `sampling` (`off`/`low`/`medium`/`high`; Settings → Connection profiles). The gateway sends `"low"` when no effort is stored and drops the parameter entirely for `off`, so an empty sampling maps still runs at low effort. Non-reasoning models that reject the parameter need `off`.
- `seedDefaultProfile` creates the default profile with an empty model, endpoint and sampling — model and `base_url` are configured explicitly in Settings.

## Plugins

- One folder in `plugins/`; entry `index.ts` (or `package.json#main`, which must resolve inside the folder). Exports `definePlugin({...})` as default or named `plugin`.
- Newly discovered plugins start **disabled**; enable/reload via Settings → Plugins or `POST /api/plugins/reload`. Loader cache-busts by mtime, so edited source re-imports without restart.
- Reserved ids (rejected at load): memory strategies `trim`, `summaries`; pipeline stages `lorebook`, `memory`, `persona`, `history`, `tracker`; tracker mechanisms `suvoj-tracker`; drawer tabs `tracker`, `summaries`.
- Error isolation: a throwing hook is logged `[plugin:<id>] <hook> failed` and skipped; generation never fails from a plugin. Exception: a throwing `onPanelData` yields HTTP 500 on that tab's data route only.
- SDK reference and walkthrough: `docs/PLUGINS.md`; example: `plugins/example-plugin/index.ts`.

## Web

- React 19 + Vite SPA. Routing is `react-router` v7 (import from `"react-router"`, not `"react-router-dom"`); entry `src/index.tsx` (`createRoot`); routes in `src/App.tsx` (`/`, `/characters`, `/personas`, `/lorebooks`, `/presets`, `/settings`); views in `src/views/`, components in `src/components/`.
- Single fetch wrapper `src/lib/api.ts` (`api<T>`, `ApiError`, `blobUrl`); SSE via `src/lib/sse.ts`.
- State: Jotai atoms in `src/stores/*.ts` on one shared default store (`appStore`, from `getDefaultStore` — no `<Provider>` is mounted), so module-level get/set and component `useAtomValue`/`useSetAtom` see the same value. Components subscribe through `useX()` hooks; non-React code calls the plain module functions (e.g. `setTheme`).
- Icons come only from `src/components/ui/icons.tsx` (Lucide re-exports with house defaults: size 18, stroke 1.75) — components don't import `lucide-react` directly.
- Plain global CSS in `src/styles/`; theme via `data-theme` on `<html>`, knobs `data-motion` / `data-surfaces` / `data-blur` / `data-translucency`, plus inline `--ui-scale` / `--chat-scale` custom properties for the continuous font sliders. **No hardcoded colors** — derive from theme vars with `color-mix`; animate only `transform`/`opacity`. Design spec: `DESIGN.md`.
- Plugin drawer tabs render in a scriptless sandboxed iframe via `src/lib/tracker-template.ts` (`{{ }}` escaped).
- There is no in-app device login anymore — the Suvoj device flow (and with it the `/api/auth/*` routes) was removed. The app is reached directly; LAN exposure stays gated by HTTP Basic (`SUVOJ_AUTH_*`, see Runtime gotchas).
