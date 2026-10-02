# Shelf — design notes

Written after the first implementation pass, as the "after report" on the choices made,
what is load-bearing, and what I would change next.

## 1. The shape of the system

```
CLI (TypeScript, one bundled file)      ← owns ~/.shelf, the only writer
  ├── shelf write / open / list / read
  ├── shelf sync  (push local sha256 deltas, pull server deltas)
  └── shelf setup (browser → loopback API key handoff)

Cloudflare Worker + Postgres (Neon)     ← the API and the web app
  ├── /api/auth/*   Better Auth (email+password, allowlist, api keys)
  ├── /api/files*   REST over one table: shelf_files
  ├── /cli          server-rendered "authorize this machine" page
  └── /             the PWA (same UI bundle as the desktop app)

Tauri v2 desktop app                    ← reads ~/.shelf through the CLI
  ├── commands: shelf_run / shelf_sync / shelf_setup / shelf_cli_info / shelf_pending_open
  ├── shelf:// protocol handler → serves artifacts with a strict CSP
  └── deep links: shelf://open?id=… (what `shelf open` triggers)

React-free frontend (ui/)               ← one build, two hosts
  ├── LocalAdapter (Tauri IPC → CLI)
  └── NetworkAdapter (fetch → /api)
```

## 2. Decisions and why

### Paths are immutable, versions are automatic
A path is written once; a later write of different bytes to the same path becomes
`report-v2.html`. This keeps every version addressable forever, makes sync trivially safe
(a row never changes identity), and matches how the user thinks about agent artifacts
("show me how this changed"). Re-running an *identical* write is a no-op, and a repeat write
of bytes that already exist somewhere in the same version family (called the *twin* check)
is also a no-op — otherwise an agent retrying `shelf write report.html` after a failure would
silently stack `-v2`, `-v3`, …

`--replace` is the escape hatch for genuine in-place updates, and `--as-new` forces a new
version without asking.

### Local bytes are the source of truth, `index.json` is a cache
`~/.shelf/html/<machine-id>/<path>` holds the bytes for **every** machine you have synced,
not just this one — that is what makes the desktop app able to render any document offline.
`index.json` mirrors metadata (id, sha256, timestamps, `pushedSha`, `fetchedAt`) and can be
deleted at any time: `loadIndexOrRebuild()` rescans the store and rebuilds it. This is also
why the answer to "does it need a local map?" is *yes, but a derived one* — the map exists for
ordering, search and push bookkeeping, never as the only record of anything.

Why not SQLite? The store is a few hundred small files; a JSON map loads in single-digit
milliseconds and keeps the CLI dependency-free (one 53 KB bundle, Node built-ins only).
If the shelf ever passes a few thousand files, the replacement is a `store.sqlite` behind the
same `store.ts` API — that boundary is why all index reads go through that module.

### Deterministic ids: `fileId = sha1(machineId + "\0" + path)`
Ids are derived, not assigned. The same machine+path always yields `sf_<20 hex>`, so a local
store that lost its index still reconstructs the same ids the server knows, `shelf read <id>`
works from any machine, and the server can *reject* mismatched ids (it recomputes and compares).
sha1 is used as a naming hash here, never for content integrity — that is sha256.

### Sync is content-addressed and cursor-based
Push: anything whose `sha256 !== pushedSha`. Pull: `GET /api/changes?since=<cursor>`, where the
cursor is the server's own `edited_at` of the last row seen (no client clocks involved), and
the loop follows `hasMore`. Deduping by sha256 means a re-run after a failure moves nothing.
One protection worth naming: if a file is local-and-dirty (edited here, not yet pushed), a pull
that would replace it is skipped and reported, so a local edit can never be clobbered.

### One auth flow, two clients
`gh auth login`-style loopback redirect, not a device code: the CLI binds a random
`127.0.0.1` port, opens `/cli?port&state&client&label`, and the web app (after an allowlisted
sign-in) mints a Better Auth **API key** and redirects to `http://127.0.0.1:<port>/callback`.
The state nonce is checked, only loopback redirects are constructed server-side, and the key
never expires (`keyExpiration.defaultExpiresIn` is `null`). The key carries a `clientId` in its
metadata, so re-running setup **rotates** that machine's key rather than accumulating keys.
The same session cookie that authorizes the CLI is what signs the PWA in.

### Postgres over Hyperdrive, `pg` everywhere
`wrangler dev` + a local Postgres and production + Neon run the *same* driver (`pg`) and the
same Kysely dialect; in production the connection string comes from a Hyperdrive binding, which
is free-tier eligible and gives real transactions and connection pooling — the reason to prefer
it over an HTTP-only Neon driver, whose transaction story is subtly different from what
Better Auth's adapter expects. Neon was the user's call ("write the html just to a column") and
it holds up: a single `shelf_files` table with `(user_id, machine_id, path_on_machine)` unique
and `(user_id, id)` as the primary key. **The push-back I would offer**: Cloudflare D1 would
remove the Neon account, the Hyperdrive config and the second vendor entirely; the only reason
not to is that Postgres is the better long-term home for this data. Keeping `DATABASE_URL` as a
fallback in `web/src/env.ts` means swapping the backend is one file.

### HTML in a column
No object storage, no signed URLs. Bodies are capped at 5 MB, stored as text, and the list
endpoints never select `html` (they compute `octet_length(html)` as `bytes`). For one user with
HTML artifacts this is right; it would stop being right at video-sized payloads or thousands of
files per user, at which point `html` becomes an R2 key and nothing else changes.

### The desktop app is a shell, not a second implementation
Every read in the Tauri app goes through the CLI (`shelf status|list|read|sync --json`), which
means the window and the terminal can never disagree, and there is exactly one place where
`~/.shelf` is understood. The cost is a process spawn per action (~60 ms for Node); the payoff
is that the app has no store logic to keep in sync with the CLI, and `shelf sync --stream`
gives it real progress lines to show in the "syncing / in sync" chip.

Rust never opens a store file, so the only interesting thing it does with the CLI is start it, and
that is not always just `Command::new` (see the Dock note in section 4).

### Every icon comes from `logo.svg`
`scripts/make-icons.mjs` reads `ui/public/logo.svg`, lays the mark on the standard rounded tile
(paper marks on a dark tile, so they stay visible on a dark Dock, with the one gray book kept
gray), and rasterises that: `tauri icon` writes the macOS/Windows bundle set including
`icon.icns`, and `sips` makes the PWA sizes from the 1024 px render. A second, maskable variant
scales the mark into the safe zone for platform masking, and the Android/iOS sets Tauri also
emits are deleted, since Shelf ships as a desktop app. Before this, the icon was drawn a second
time inside the script with its own geometry, which is exactly how a logo and an app icon drift
apart.

### Artifacts cannot phone home on the desktop
The reader iframe points at `shelf://localhost/view/<id>`; the Rust handler runs `shelf read <id>`
and returns the bytes with

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'
```

Inline scripts and styles work (so the `/html` and `/slides` artifacts render exactly as
authored), but CDNs, fonts, beacons and `fetch` are dead. The iframe is sandboxed with
`allow-scripts allow-same-origin`, which is safe here because the artifact's origin
(`shelf://localhost`) differs from the app's (`tauri://localhost`) — the document gets its own
storage without reaching the app's DOM or IPC. `unsafe-eval` is deliberately absent; an artifact
that needs `new Function` will not run.

The PWA uses the same UI with an object-URL iframe instead (`sandbox="allow-scripts"`, opaque
origin, parent CSP inherited). Reading on a phone works; `localStorage` inside an artifact throws
there, which only affects cosmetic persistence.

### `shelf open` writes first, then focuses the app
`shelf open <path>` runs the same write path (so an agent can use it as the only call it makes),
then `open shelf://open?id=<id>`. If `Shelf.app` is not installed it falls back to the default
browser and says so (`openedIn: "browser"`). Deep links that arrive before the webview is
listening are held in Rust (`shelf_pending_open`), because a cold start delivers the URL during
`setup()`.

### One frontend build, two hosts
`ui/` builds once; the Worker serves `ui/dist` as its assets and Tauri uses it as `frontendDist`.
`ui/src/adapter.ts` picks the data source at runtime. No branching elsewhere, which is what keeps
"the PWA is the same UI as the app but over the network" true rather than aspirational.

### Grayscale, with color only for identity
The UI follows the user's established token set. The one deliberate exception is machine
identity: every row carries a tint and a 3 px bar derived from a hand-written FNV-1a hash of the
machine id (`shared/src/color.ts`), desaturated (low saturation, two values per theme) so it
reads as a label, not decoration. Filter chips reuse the same swatch.

### Artifacts inherit the app theme instead of being re-authored
`/html` and `/slides` artifacts read `localStorage['html-theme']` in a blocking `<head>` script,
falling back to `prefers-color-scheme`. Rather than change how they are written (or wrap them in
something that rewrites their styles), the reader injects a bootstrap immediately after `<head>`:
it writes the app's theme into that same key before their script runs, re-asserts
`data-theme`/`data-themePreference` on `DOMContentLoaded` (their script may have overwritten both),
and re-applies on `postMessage`, which is how a live app toggle reaches a document that is already
open. The desktop carries the value in the `shelf://` query string; the PWA injects it into the blob.
It is a five-line contract that survives the artifacts changing shape, because it rides on their
own documented mechanism.

### The reader lives in the top bar
The app uses an overlay title bar (`hiddenTitle` + `titleBarStyle: "Overlay"` + `trafficLightPosition`),
so the macOS traffic lights sit inside the app's own 44 px bar. Three things had to be measured rather
than guessed:

- The lights' centre lands at `trafficLightPosition.y - 2.25` CSS px, so `y: 24` puts them on a 44 px
  bar's centre line (confirmed with `scripts/measure-topbar.mjs`).
- `<button>` carries a UA `padding: 1px 6px` that pushes a supposedly centred icon off by 2.5 px
  until it is reset.
- Dragging. `-webkit-app-region: drag` is an Electron property; a WKWebView ignores it, which is why
  the bar could not be grabbed at first. Tauri starts the drag itself on mousedown inside an element
  marked `data-tauri-drag-region` (`"deep"` covers the whole subtree; buttons and inputs are skipped
  for us), and that invoke is permissioned — without `core:window:allow-start-dragging` in
  `capabilities/default.json` the handler runs and the window simply never moves.

`html.tauri` indents the bar 100 px so the controls clear the lights, the back arrow is a bare icon
rather than another boxed button, and the PWA gets the same bar without the indent. Floating controls
over a document break the one thing the reader is for, so the back button, the title and "open in
your browser" sit in that bar while the iframe owns everything below it.

That last button has to mean different things per host. The desktop reader points its iframe at
`shelf://localhost/...`, which Safari cannot resolve, so it runs `shelf reveal <path>` instead: the
CLI resolves the entry and hands the shelf's own file to macOS, showing the artifact exactly as it
was written, with no theme injection and no write. The PWA has nothing to hand over — the document
is already a blob it owns — so it opens that blob in a tab.

### A machine id is identity, not a label
`fileId = sha1(machineId + "\0" + path)` means the machine id is half of every file's name, and the
bytes live under `~/.shelf/html/<machine>/`. So `shelf setup --machine <new>` or `machine set` only
relabels the config: files already written keep the old id, and because sync only pushes what
belongs to the machine you are on, they silently stop being pushed. That trap is why `shelf machine
rename` exists, and why `setup` now warns when it changes an id that has files behind it. A rename
moves the bytes, recomputes ids, clears `pushedSha` (no server has seen the new ids), and resets the
pull cursor, which described the old identity. Rows already pushed under the old id stay on the
server: the API has no delete, so the shelf keeps both and the old machine simply stops appearing
unless something is still filed under it. Two ids that both have files is normal and supported,
which is what `<from> <to>` is for.

Renaming also exposed a second bug: `shelf read <path>` and `shelf reveal <path>` resolved a path
by the first suffix match in index order, so re-keying a file (which re-inserts it) could change
which document you got. `resolveEntry` in `lib/store.ts` now prefers an exact path, then the
shortest suffix, so the answer no longer depends on insertion order.

### Paths are anchored to the git root
`path_on_machine` is the file's path relative to the repository root when it lives in a repository
(`cli/src/lib/writer.ts`), falling back to the current directory and then `$HOME`. Writing
`docs/report.html` from the repo root and `./report.html` from inside `docs/` therefore produce the
same shelf path instead of two copies of one document. Outside a repository the old rule applies,
so nothing changes for loose files.

### The window sizes itself once per display
1708x940 preferred, clamped to the monitor work area and centred (`size_window` in `main.rs`). No
persistence yet: a laptop screen and a 3440-wide monitor both get a sane window, at the cost of
forgetting a manual resize.

## 3. Verification

- `npm test` — ids/paths/versioning, CLI flag parsing + index queries, UI list/search logic.
- `npm run smoke` — 30 end-to-end checks against a local Worker + Postgres: browser handoff,
  write/version/replace/no-op, cross-machine pull (including bytes landing in the store),
  auth rejection for a stranger's key, and the worker-side document + changes endpoints.
- `cargo test` — deep-link parsing and the CLI-backed reader path (with a stub CLI).
- Manual: the UI was exercised in a real browser against the dev Worker (login, list, facets,
  reader, ⌘P palette).

## 4. Found by dogfooding

- **Renaming a machine strands its files.** `shelf setup --machine tyrell-macbook-pro` looked
  harmless, but the machine id is half of every file id, so the nine documents already on the shelf
  stayed under `tys-macbook-pro-2` and `shelf sync` reported nothing to push. Fixed with
  `shelf machine rename` (see the identity section above), plus a warning from `setup` when the id
  it is about to write does not match the files in the store.
- **A GUI launch has almost no `PATH`.** Opening the app from the Dock failed with
  `env: node: No such file or directory` while the same bundle launched from a terminal worked: the
  CLI is installed as `#!/usr/bin/env node`, and Rust was spawning that file directly. `cli_command`
  now reads the shebang and, when it asks for node, builds `node <cli>` itself, finding node via
  `SHELF_NODE`, then `PATH`, then the version-manager and Homebrew locations (newest nvm version
  first, compared as numbers so `v9` cannot outrank `v24`). The child also gets a `PATH` with those
  directories plus the usual unix ones, so a Dock launch behaves like a terminal launch for whatever
  the CLI shells out to later (`open`, for `shelf reveal`). A Rust test spawns a node-shebang script
  with `PATH=/nonexistent`, so this cannot come back unnoticed.
- **Better Auth's API-key plugin rate-limits to 10 requests per day per key by default**, which
  is nothing for a client that pushes every file it writes: the CLI started returning 401 part-way
  through a normal day. `rateLimit: { enabled: false }` in `web/src/auth.ts` is the fix; for a
  single-user tool with one long-lived key per machine, the allowlist is the real guard. Worth
  knowing because the failure looks like a revoked token, not a quota.
- **"In sync · 3d ago" never moved when you clicked sync.** The chip showed `lastSyncAt`, which is
  the pull cursor (the server's `edited_at` of the newest file pulled), so a sync that found
  nothing new left it alone. The index now also keeps `syncedAt`, the wall-clock time the last
  clean sync finished, and the chip shows that. The cursor keeps its meaning. The same pass found
  the list dropping the newest search while an older one was in flight (it returned early instead
  of letting the latest request win), which is why the filters felt erratic. See
  `docs/plans/home-page-ux.md`.
- The first real write of a second machine's file proved the local store layout: bytes land in
  `~/.shelf/html/<machine-id>/<path>` and appear in the list without touching the server, which
  is what makes the desktop reader work offline.
- Deleting `index.json` and re-running `shelf list` rebuilds identical metadata from the store
  (verified during cleanup) — the derived-map claim holds.
- **A rebuilt index cannot know what was pushed**, and the first version of the write path treated
  `pushedSha === null` as "different content", so an identical `shelf write` after a rebuild stacked
  `report-v2.html` (and would have kept going). Fixed in `cli/src/lib/writer.ts`: identical bytes at
  the requested path now mean *unchanged*, and the push runs anyway to reconcile the remote copy.
  `scripts/smoke.sh` has a dedicated "a lost index is recoverable" step so it cannot regress.

## 5. Known limits / next

- The desktop bundle is unsigned: first launch needs right-click → Open, or `xattr -dr
  com.apple.quarantine`. Signing needs an Apple Developer certificate.
- No delete or rename, by design ("no need to delete ever"). A soft delete would be the first
  data-model change.
- Search is a `path ILIKE` on the server and a substring match locally. If the shelf grows past
  a few thousand artifacts, Postgres full-text (or a trigram index) is a drop-in improvement.
- Sync is manual (app open, `shelf sync`, or the chip). A background daemon was explicitly out of
  scope; the CLI is the right place for it if it is ever wanted.
- The version family check is per-machine; two machines can legitimately hold `report-v2.html`
  with different bytes, and they display as separate rows (attributed by machine).
