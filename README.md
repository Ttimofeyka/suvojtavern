<p align="center">
  <img src="packages/web/public/logo.png" alt="SuvojTavern" width="112" />
</p>

<h1 align="center">SuvojTavern</h1>

<p align="center">
  Self-hosted AI roleplay for people who care about the story — and own their data.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue.svg" alt="License: MPL-2.0" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-14151a?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/ui-React%2019-087ea4?logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/state-SQLite-003b57?logo=sqlite" alt="SQLite" />
</p>

SuvojTavern is a local-first web client for character-driven roleplay. It talks to any
OpenAI-compatible endpoint, keeps every character, chat, lorebook, preset, and summary in a
single SQLite database, and runs as one Bun process with a React frontend.

It imports SillyTavern cards, lorebooks, and presets, and ships a lean roleplay preset with a
scene tracker so long chats keep their facts straight.

## Features

- **Bring your own model.** Any OpenAI-compatible `base_url` and key, with per-profile model and
  sampling settings. Works keyless against Ollama, LM Studio, and similar local servers.
- **A real prompt engine.** Ordered prompt blocks, marker slots, injection depth and position,
  conditional blocks, generation-type gating, and reusable preset controls — with a live prompt
  preview before you send.
- **Story-aware chats.** Streaming responses, swipes, edits, continue, branching, and markdown
  rendering.
- **Characters that come from anywhere.** Import SillyTavern PNG/JSON cards, Chub.ai cards, and
  direct PNG links; manage galleries; generate or enhance fields with your own model.
- **Lorebooks that scale.** Keyword and constant entries, sections, ST import/export, and
  AI-assisted entry or whole-book generation.
- **Memory that survives context limits.** Rolling summaries or a trim strategy, configured per
  chat, injected on a cache-stable prompt layout.
- **A scene tracker.** Structured, swipe-aware state — pronouns, on/off-stage cast, knowledge, and
  secrets — kept per message and injected into the prompt.
- **Plugins without a rebuild.** Drop a folder into `plugins/`, reload, and get hooks, prompt
  stages, memory strategies, tracker mechanisms, themes, controls, and drawer tabs.
- **A UI made for reading.** Eight built-in palettes plus plugin themes, light and dark, desktop
  and mobile layouts, with reduced-motion support.
- **Local by default.** One SQLite file, no telemetry, no account, no cloud dependency.

## Quick start

Requires [Bun](https://bun.sh) 1.4 or newer. Node is not needed.

```bash
git clone https://github.com/Ttimofeyka/suvojtavern.git
cd suvojtavern
bun install
bun run dev
```

Open <http://127.0.0.1:3210>. The first run creates and seeds
`packages/server/data/suvoj.db` with a default preset, a sample lorebook, and a default
connection profile.

Then open **Settings → Connections** and fill in your endpoint:

| Field       | Example                          | Notes                                        |
| ----------- | -------------------------------- | -------------------------------------------- |
| Base URL    | `https://api.openai.com/v1`      | Any OpenAI-compatible endpoint               |
| API key     | `sk-…`                           | Leave empty for Ollama / LM Studio           |
| Model       | `gpt-4.1`                        | Fetched from `GET /models` when available    |
| Reasoning   | `low` / `medium` / `high` / off  | Maps to `reasoning_effort`; off for models that reject it |

### Development

Run the API and the Vite dev server separately for hot reload:

```bash
bun run dev       # API on 127.0.0.1:3210 (Bun watch)
bun run dev:web   # UI on 127.0.0.1:5173, proxying /api and /blobs to :3210
```

### Production

```bash
bun run build                                 # bundles the SPA into packages/web/dist
bun run --cwd packages/server start           # serves the API and the built UI
```

## Configuration

The server reads these variables from the environment (Bun also loads a local `.env` file):

| Variable                | Default     | Purpose                                                                 |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `HOST`                  | `127.0.0.1` | Bind address. An explicit value always wins over `SUVOJ_LAN`.            |
| `PORT`                  | `3210`      | HTTP port.                                                              |
| `SUVOJ_LAN`             | unset       | Bind `0.0.0.0` and print reachable LAN URLs. Requires auth credentials.  |
| `SUVOJ_AUTH_USERNAME`   | unset       | HTTP Basic username (min 3 chars). Set together with the password.      |
| `SUVOJ_AUTH_PASSWORD`   | unset       | HTTP Basic password (min 8 chars). Set together with the username.      |

```bash
# Reachable from your LAN, protected by Basic auth
SUVOJ_LAN=1 SUVOJ_AUTH_USERNAME=suvoj SUVOJ_AUTH_PASSWORD='change-me-please' bun run dev
```

> **Security.** The server binds to loopback by default and refuses a non-loopback bind without
> credentials. Auth is a single shared Basic login, the SQLite file and API keys are stored
> unencrypted, and TLS is not built in. If you expose it beyond your machine, put it behind a
> reverse proxy with HTTPS.

## Scripts

| Command                    | What it does                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `bun run dev`              | Start the API with watch mode (port 3210).                      |
| `bun run dev:web`          | Start the Vite dev server (port 5173).                          |
| `bun run build`            | Build the web UI into `packages/web/dist`.                      |
| `bun test`                 | Run the full test suite across every workspace.                 |
| `bun run lint`             | Check formatting and lint rules with Biome.                     |
| `bun run format`           | Rewrite files with Biome formatting.                            |
| `bun run db:init`          | Apply migrations and seed the built-in preset and profile.      |
| `bun run db:seed`          | `db:init` plus the sample lorebook and default persona.         |
| `bun run typecheck:plugins`| Type-check the plugin folder.                                   |

Per-package type checks: `bun run --cwd packages/server typecheck` (same for
`packages/@suvoj/core`, `packages/@suvoj/plugin-sdk`, and `packages/web`).

## Project layout

```
packages/@suvoj/core        Database, repositories, prompt engine, memory, tracker, import/export
packages/@suvoj/plugin-sdk  Plugin types and the definePlugin() helper
packages/server             Hono API on Bun, model gateway, SQLite, plugin host
packages/web                React 19 + Vite single-page app
packages/server/seed        Shipped preset and sample lorebook (canonical copies)
plugins/                    Drop-in server plugins, loaded at runtime
docs/                       Presets, tracker, and plugin reference
```

## Plugins

A plugin is one folder in `plugins/` with an `index.ts` that default-exports
`definePlugin({...})`. Drop it in, open **Settings → Plugins**, and press **Reload** — no
server restart or frontend build. Newly discovered plugins start disabled.

The repository includes two annotated examples:

- `plugins/example-plugin` — hooks, settings, controls, a memory strategy, and a drawer tab.
- `plugins/theme-plugin` — declarative palettes and a global stylesheet.

Full reference: [`docs/PLUGINS.md`](docs/PLUGINS.md).

## Documentation

| Document                                   | Contents                                                   |
| ------------------------------------------ | ---------------------------------------------------------- |
| [`docs/PRESETS.md`](docs/PRESETS.md)       | Prompt slots, injection, conditional blocks, and controls  |
| [`docs/TRACKER.md`](docs/TRACKER.md)       | Scene state, schemas, injection, and drawer tabs           |
| [`docs/PLUGINS.md`](docs/PLUGINS.md)       | Plugin SDK, hooks, contributions, and the walkthrough       |
| [`DESIGN.md`](DESIGN.md)                   | Visual language, tokens, layout, and accessibility rules    |
| [`AGENTS.md`](AGENTS.md)                   | Repository conventions, commands, and architecture notes    |

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```bash
bun test
bun run lint
bun run typecheck:plugins
```

Keep tests hermetic (no DB fixtures or network), follow the existing conventions, and update the
relevant document under `docs/` when behavior changes.

## Built with

SuvojTavern was built with [Command Code](https://commandcode.ai), an AI coding agent used for
implementation, tests, and documentation.

## License

[Mozilla Public License 2.0](LICENSE).
