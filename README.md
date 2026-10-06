# Shelf

A **local-first shelf for HTML written by agents**.

An agent finishes a report, a slide deck, an explainer — it calls `shelf write ./report.html`.
The file lands on your machine instantly, syncs to your other machines, and is readable in a
native desktop app (fast, offline, no network) or in a PWA on your phone.

```
        agent / human                        you
   ┌──────────────────────┐        ┌───────────────────────┐
   │ shelf write report.html │      │  desktop app (Tauri)  │  reads ~/.shelf, no network
   │ shelf open  report.html │      │  PWA (phone)          │  reads the API
   └───────────┬──────────┘        └───────────┬───────────┘
               │                                │
               ▼                                ▼
        ┌──────────────────────────────────────────┐
        │  ~/.shelf/    config.json + index.json    │   ← CLI owns this
        │               html/<machine>/<path>       │
        └───────────────────┬──────────────────────┘
                            │ shelf sync (push/pull, sha256 diffed)
                            ▼
        ┌──────────────────────────────────────────┐
        │ Vercel function + Postgres (Neon)         │   ← the web app and the API
        │ /api/files  /api/changes  /api/auth  /cli │
        └──────────────────────────────────────────┘
```

Three surfaces, one shelf:

| Surface | Reads from | Notes |
| --- | --- | --- |
| **CLI** (`shelf`) | `~/.shelf` | The only writer. Agents use it. |
| **Desktop app** | `~/.shelf` via the CLI | Local-first, offline, artifacts served with a strict CSP. |
| **PWA** | the API over the network | Same UI, for the phone. |

## Install

### CLI

```bash
curl -fsSL https://raw.githubusercontent.com/TyrellD1/shelf/main/install.sh | bash
```

Installs the latest release to `~/.local/bin/shelf` (needs Node 20+; override the directory
with `SHELF_INSTALL_DIR`). From a checkout instead:

```bash
npm install && npm run build && npm run install:cli
```

### Desktop app (macOS)

```bash
npm install
npm run desktop:build          # → desktop/src-tauri/target/release/bundle/macos/Shelf.app
open desktop/src-tauri/target/release/bundle/macos/Shelf.app
```

Copy it to `/Applications` to register the `shelf://` URL scheme, which is what makes
`shelf open` pop the app to the front.

## Quick start

```bash
shelf setup                    # opens the browser, signs you in, asks for a machine id
shelf write ./report.html --json
shelf open  ./report.html      # writes it if needed, then opens it in the desktop app
shelf list
shelf reveal ./report.html     # that file, in your browser, straight from the shelf
shelf sync                     # push local writes, pull other machines' files
shelf status
```

`--json` gives agents one JSON document on stdout (add `--stream` for progress lines first).

## Commands

| Command | What it does |
| --- | --- |
| `shelf setup [--api <url>] [--machine <id>] [--append-only]` | Browser handoff, stores a long-lived API key, sets this machine's id. `--append-only` preselects a write-only key |
| `shelf write <path> [--replace\|--as-new] [--no-push]` | Write (and push) a file and print its web link (`url` in `--json`). Existing paths become `-v2`, `-v3`, … |
| `shelf open <path> [--browser]` | Write if missing, then open in the desktop app (falls back to the browser) |
| `shelf list [--search q] [--machine id] [--sort created\|edited] [--limit n]` | The shelf, newest first |
| `shelf read <id\|path> [--meta]` | Raw HTML on stdout (what the desktop reader uses) |
| `shelf reveal <id\|path> [--print]` | Open the shelf's own copy of a file in your browser. Never writes or pushes |
| `shelf sync [--pull-only\|--push-only]` | Push local writes, pull other machines |
| `shelf status [--check]` | Config, counts, pending pushes, last sync |
| `shelf machine [set <id>]` | Show or change this machine's id |
| `shelf machine rename <id>` / `<from> <to>` | Move this machine's files (or another's) onto a new id, then push them |
| `shelf logout` / `shelf upgrade [--check]` | Drop the local token / update the CLI |

Global: `--json`, `--stream`, `--version`, `--help`. Local data lives in `~/.shelf`
(`SHELF_HOME` overrides it) and is written `0600`/`0700`.

## How the pieces fit

**Immutable paths.** A path is written once. Re-writing content to the same path creates
`report-v2.html` (then `-v3`, …) — you can see how a document evolved without ever losing a
version. `--replace` overwrites in place instead, and re-running an identical write is a no-op
(compared by sha256), so an agent can call `shelf write` twice without stacking versions.

**Local first.** The CLI owns `~/.shelf`: `html/<machine-id>/<path>` holds the bytes and
`index.json` is a cache of metadata (id, sha256, timestamps, what was pushed). Delete the
index and `shelf` rebuilds it by scanning the store — the bytes are the source of truth.

**Sync.** `shelf sync` pushes every local file whose sha256 differs from what the server has,
then pulls rows edited after the last cursor from the other machines. Both directions are
idempotent and content-addressed, so a re-run only moves what changed and a local edit is
never clobbered by an older copy.

**One auth, two clients.** `shelf setup` opens the web app at `/cli`, you authorize the machine,
and the browser hands a long-lived API key to a loopback listener (`127.0.0.1:<random>`,
state-checked). The CLI stores the key in `~/.shelf/config.json` and signs every request with
`x-api-key`. Re-running setup rotates that machine's key instead of piling up keys. Only
addresses in `ALLOWED_EMAILS` can sign in at all.

**Append-only keys.** The authorize page lets you pick the key's access: **Full** (the
default) or **Append only**. An append-only key can write new documents and look up its own
paths' size and hash so a rewrite lands on the next version, and that is all: no list, no read,
no `--replace` (a rewrite always versions), no pull. It is meant for a headless box (CI, a
build server, an agent sandbox) that only publishes: install the CLI there with `install.sh`,
run `shelf setup --append-only`, and read what it wrote from any other device. The scope lives on
the key server-side (Better Auth api-key `permissions`), so the server refuses reads whatever the
CLI does; `/api/auth/*` and `/cli` never accept an API key, so a key cannot mint a broader one.
Keys minted before scopes existed stay full.

**Desktop app.** A thin Tauri shell; every read goes through the CLI (`shelf status|list|read|sync`),
so the terminal and the window never disagree. `shelf sync` streams progress lines that the app
turns into a "syncing / in sync" chip. Documents are served to the reader iframe from a
`shelf://` protocol handler with `default-src 'none'` — artifacts can run their own inline
scripts, but they cannot reach the network. The reader's controls live in the top bar, so nothing
floats over the document, and the window opens at 1708x940 (clamped to the display) instead of a
postage stamp.

**PWA.** The same UI bundle, hosted on Vercel, reading `/api/*` with a session cookie.

**MCP (claude.ai).** The server serves `/mcp` with three tools that mirror the CLI: `list`,
`read` and `write` (same versioning, same one-line descriptions from `shared/`). claude.ai
connects over OAuth: it registers itself, you sign in with your shelf password and press Allow,
and it gets a token bound to `/mcp`. Registration only accepts Claude's callback URLs. Files
written this way land under a machine named after the app that connected (`claude-mcp`), and
`shelf sync` pulls them like any other machine's.

## Theming

`/html` and `/slides` artifacts keep their theme under a `html-theme` key and read it in a
blocking script in `<head>`. When the app serves an artifact it injects three lines ahead of that
script: write the app's current theme into the key, re-assert it on `DOMContentLoaded`, and follow
`postMessage({ shelfTheme })` afterwards. The desktop passes the theme through the `shelf://`
query, the PWA injects it into the blob. Artifacts are untouched on disk and know nothing about
Shelf; they simply open in the theme the app is showing, and follow a live toggle.

## Local development

Everything runs locally with parity to production (same routes, same Postgres driver).

```bash
cp web/.dev.vars.example web/.dev.vars     # fill in a secret, your email, a seed password
npm install
npm run dev:all                            # postgres + migrations + seed + wrangler dev on :8787
npm run install:cli                        # link the CLI from this checkout
shelf setup --api http://localhost:8787
```

- `scripts/dev-db.sh start|stop|status|psql` — a private Postgres on port 55432 (no Docker needed;
  `docker compose up -d` also works if you prefer containers).
- `npm run dev -w web` — the Worker alone (`wrangler dev`, http://127.0.0.1:8787).
- `npm run dev -w ui` — the UI alone against the local Worker (`/api` is proxied to :8787).
- `npm run desktop` — the Tauri app against the Vite dev server.
- `npm test` — unit tests (shared paths/ids, CLI flags + index, UI list logic, env allowlist).
- `npm run smoke` — 66 end-to-end checks: setup handoff, write/version/replace, cross-machine
  sync, worker auth, append-only keys, artifact serving.
- `npm run typecheck` — strict TS across shared/cli/ui/web.

## Deploy (Vercel + Neon)

You need a Vercel account and a Postgres the function can reach. Neon is the
path we test:

```bash
# 1. database: a project, and its pooled connection string
neon projects create --name shelf --region-id aws-us-east-1   # add --org-id if you have several orgs
neon connection-string --project-id <project-id> --pooled

# 2. the Vercel project, from the repository root
vercel link --yes --project shelf

# 3. its environment, then deploy
vercel env add DATABASE_URL production --sensitive          # the pooled Neon URL
vercel env add BETTER_AUTH_SECRET production --sensitive    # openssl rand -base64 32
vercel env add ALLOWED_EMAILS production                    # you@example.com
npm run deploy -w web                                       # vercel deploy --prod
```

`vercel.json` builds the UI and bundles the server (`web/src/vercel.ts`) into one
function, `api/index.mjs`, in `iad1`, next to Neon's `us-east-1`. The origin is the
project's production domain, `https://<project>.vercel.app` or close to it; set
`APP_URL` as well only to serve from another one. Changing `BETTER_AUTH_SECRET`
later strands the MCP signing key in the `jwks` table: empty that table and the
next connection mints a new one.

Then run the schema and your account once. Pass the Neon URL inline instead of
putting it in `web/.dev.vars`, so local development keeps using the local Postgres:

```bash
DATABASE_URL="$(neon connection-string --project-id <project-id>)" npm run db:migrate
DATABASE_URL="$(neon connection-string --project-id <project-id>)" npm run db:seed
```

Last, point a machine at it. This replaces whatever API the CLI was using, so a
local development setup has to be re-authorized the same way afterwards:

```bash
shelf setup --api https://<project>.vercel.app
shelf sync                                    # the first sync uploads what this machine has
```

To use the shelf from claude.ai, add a custom connector (Settings → Connectors) with the URL
`https://<project>.vercel.app/mcp` and leave the OAuth fields empty. Connecting sends you to
your shelf to sign in and allow it. `npm run db:migrate` creates the OAuth tables, so re-run it
against production after upgrading.

Local development still runs the same routes in `wrangler dev` (`web/src/index.ts`).
Workers' free plan allows 10 ms of CPU per request, which Better Auth does not fit in,
so production moved off it.

## Security notes

- One user, by design: Better Auth email+password with an `ALLOWED_EMAILS` allowlist. Everyone
  else is rejected before a session exists.
- The CLI token is a long-lived Better Auth API key, `0600`. `shelf logout` drops it locally;
  `shelf setup` rotates it.
- The loopback handoff only redirects to `http://127.0.0.1:<port>` with a matching state nonce.
- MCP: OAuth 2.1 with PKCE through Better Auth's MCP plugin. Dynamic registration is open but
  limited to Claude's callbacks (`claude.ai`, `claude.com`, loopback for Claude Code), every
  connection needs your password and an explicit Allow, and access tokens are JWTs whose audience
  is `<APP_URL>/mcp`, verified by the server against its own keys.
- Desktop artifacts are sandboxed in the reader iframe and served with
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'`.
  Inline scripts and styles work; CDNs, fonts and beacons do not.
- The device's machine id comes from the hostname, sanitized (`Tyrells-MacBook-Pro.local` →
  `tyrells-macbook-pro`), and can be anything you like: `shelf machine set work-laptop`.

## Layout

```
cli/      the `shelf` CLI (TypeScript, bundled to a single file with esbuild)
shared/   wire types, path/version rules, id hashing, machine colors
ui/       the frontend used by both the desktop app and the PWA (vanilla TS, no framework)
web/      the server (Vercel function): Better Auth, /api, /cli handoff, /mcp + OAuth, PWA assets
desktop/  Tauri v2 app: CLI bridge, shelf:// reader protocol, deep links
scripts/  dev-db, dev-all, smoke (+ smoke-mcp), icons
```

Design notes and the reasoning behind the trade-offs: [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
