# Agent notes — shelf

## What this is

`shelf` is a local-first store for HTML written by agents, with three surfaces that must never
disagree: the CLI (`cli/`), the desktop app (`desktop/`, Tauri v2), and the PWA/web app
(`web/` + `ui/`). The CLI owns the local store and is the only writer; the desktop app shells
out to it; the PWA reads the same data over HTTP.

## Rules that keep it coherent

1. **The CLI is the single writer.** `desktop/src-tauri` must not read or write
   `~/.shelf` itself — add a CLI command instead and call it from Rust.
2. **One frontend, two hosts.** `ui/` builds once and runs inside both the Worker and Tauri.
   Never fork the UI per host; branch on `adapter.kind` (`ui/src/adapter.ts`) instead.
3. **Paths are immutable.** Re-writing a path versions it (`-v2`, `-v3`). Only `--replace`
   overwrites. Identical content is a no-op — compare by sha256, never by timestamps.
4. **Local bytes are the source of truth.** `~/.shelf/index.json` is a cache that must be
   rebuildable by scanning `~/.shelf/html/`. Never store state that only lives in the index.
5. **`shared/` is the contract.** Wire types, id derivation (`fileId`), and path rules live
   there so the CLI, Worker, and UI cannot drift. Changing an id scheme or payload shape means
   bumping the affected code in all three consumers.
6. **No network from artifacts.** The desktop reader serves documents from `shelf://` with
   `default-src 'none'`. Never relax that CSP to make a document work — inline everything.
7. **Single user.** `ALLOWED_EMAILS` is the whole authorization model. Do not add roles,
   sharing, or multi-tenant concepts without an explicit request.

## Layout

```
cli/src/commands/   one file per command, thin: parse flags, call lib/, emit JSON
cli/src/lib/        config, store (index + bytes), api client, writer core, launch, output
shared/src/         types, paths (versioning, validation), hash (file ids), color (machine hue)
ui/src/             adapter (local|network), views (list, reader, palette, login), logic
ui/src/logic.ts     pure list/search helpers — add tests here, not in views
web/src/            index (routing), auth (Better Auth), api (REST), cli-auth (browser handoff)
web/scripts/        migrate, seed, env
desktop/src-tauri/  main.rs (commands, shelf:// protocol, deep links)
```

## Workflow

- `npm run typecheck && npm test` before committing; `npm run smoke` for end-to-end changes
  (it drives the real CLI against a local Worker and Postgres).
- Schema changes go in `web/migrations/*.sql` with `if not exists` / `add column if not exists`
  so `npm run db:migrate` stays idempotent. Better Auth's own tables are created by that script.
- The CLI ships as one bundled file (`cli/build.mjs`) with no runtime dependencies beyond Node
  built-ins and `@shelf/shared`. Keep it that way.
- Commits: Conventional Commits. Never commit `web/.dev.vars`, `~/.shelf`, or tokens.
