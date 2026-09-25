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
        │ Cloudflare Worker + Postgres (Neon)       │   ← the web app and the API
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
shelf sync                     # push local writes, pull other machines' files
shelf status
```

`--json` gives agents one JSON document on stdout (add `--stream` for progress lines first).

## Commands

| Command | What it does |
| --- | --- |
| `shelf setup [--api <url>] [--machine <id>]` | Browser handoff, stores a long-lived API key, sets this machine's id |
| `shelf write <path> [--replace\|--as-new] [--no-push]` | Write (and push) a file. Existing paths become `-v2`, `-v3`, … |
| `shelf open <path> [--browser]` | Write if missing, then open in the desktop app (falls back to the browser) |
| `shelf list [--search q] [--machine id] [--sort created\|edited] [--limit n]` | The shelf, newest first |
| `shelf read <id\|path> [--meta]` | Raw HTML on stdout (what the desktop reader uses) |
| `shelf sync [--pull-only\|--push-only]` | Push local writes, pull other machines |
| `shelf status [--check]` | Config, counts, pending pushes, last sync |
| `shelf machine [set <id>]` | Show or change this machine's id |
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

**Desktop app.** A thin Tauri shell; every read goes through the CLI (`shelf status|list|read|sync`),
so the terminal and the window never disagree. `shelf sync` streams progress lines that the app
turns into a "syncing / in sync" chip. Documents are served to the reader iframe from a
`shelf://` protocol handler with `default-src 'none'` — artifacts can run their own inline
scripts, but they cannot reach the network.

**PWA.** The same UI bundle, hosted by the Worker, reading `/api/*` with a session cookie.

## Local development

Everything runs locally with parity to production (same Worker code, same Postgres driver).

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
- `npm run smoke` — 30 end-to-end checks: setup handoff, write/version/replace, cross-machine
  sync, worker auth, artifact serving.
- `npm run typecheck` — strict TS across shared/cli/ui/web.

## Deploy (Cloudflare Workers + Neon)

```bash
# 1. database
neonctl projects create --name shelf          # or the Neon dashboard
npx wrangler hyperdrive create shelf-db --connection-string "<neon pooler url>"

# 2. paste the printed hyperdrive id into web/wrangler.jsonc

# 3. secrets and deploy
cd web
npx wrangler secret put BETTER_AUTH_SECRET    # openssl rand -base64 32
npx wrangler secret put ALLOWED_EMAILS        # you@example.com
npx wrangler secret put DATABASE_URL          # used by the migration + seed scripts
npx wrangler deploy
```

Then run the schema and your account once, and point the CLI at it:

```bash
npm run db:migrate && npm run db:seed         # with web/.dev.vars holding the Neon URL
shelf setup --api https://shelf.<subdomain>.workers.dev
```

`APP_URL` in `wrangler.jsonc` must match the deployed origin (cookies and the CLI redirect use it).

## Security notes

- One user, by design: Better Auth email+password with an `ALLOWED_EMAILS` allowlist. Everyone
  else is rejected before a session exists.
- The CLI token is a long-lived Better Auth API key, `0600`. `shelf logout` drops it locally;
  `shelf setup` rotates it.
- The loopback handoff only redirects to `http://127.0.0.1:<port>` with a matching state nonce.
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
web/      Cloudflare Worker: Better Auth, /api, /cli handoff, PWA assets
desktop/  Tauri v2 app: CLI bridge, shelf:// reader protocol, deep links
scripts/  dev-db, dev-all, smoke, icons
```

Design notes and the reasoning behind the trade-offs: [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
