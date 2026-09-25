---
name: shelf
description: Put HTML you produced on the user's Shelf — write it, open it in the desktop app, list what is there. Use when the user asks to "put this on my shelf", "send this to my phone", "open it in Shelf", or when a skill (html, slides, review) finishes an artifact and the user wants to keep it.
---

# Shelf

`shelf` is the user's local-first store for HTML you write. Files land on their machine
immediately, sync to their other machines, and open in a native desktop app.

## The one thing you do

```bash
shelf write <path.html> --json
```

Do that when an artifact is finished. It writes the file, pushes it, and prints one JSON
object. If the user asked to look at it right away, use:

```bash
shelf open <path.html> --json      # writes it if needed, then opens the desktop app
```

Nothing else is required. Do not chmod, move, or copy the file elsewhere.

## Rules that matter

- **Write once, at the end.** Don't write intermediate drafts; the shelf keeps every version.
- **Paths are immutable.** Re-writing the same path creates `report-v2.html` automatically
  (then `-v3`, …). Re-writing identical bytes is a no-op. Never invent `-v2` names yourself,
  and only pass `--replace` if the user explicitly wants to overwrite the existing version.
- **Use a relative path** so the shelf shows something readable (`outputs/report.html`, not
  `/var/folders/.../report.html`). Run `shelf write` from the project directory.
- **Check the result.** `{"ok": true, "path": "...", "pushed": true}` means it is on the shelf
  and synced. `pushed: false` with a `warnings` entry means it is local but not uploaded yet —
  say so, and suggest `shelf sync`.

## Useful reads

```bash
shelf list --json --search <fragment> --limit 20   # what's already there
shelf read <id|path> --meta --json                 # metadata for one file
shelf status --json                                # api, machine id, pending pushes
```

## When it fails

| Output | What to tell the user |
| --- | --- |
| `shelf is not set up on this machine` | Run `shelf setup` once in a terminal (opens a browser). |
| `the saved token was rejected (401)` | Run `shelf setup` again; it rotates this machine's key. |
| `cannot reach http://…` | The cloud API is unreachable; the file is still local, run `shelf sync` later. |
| `path must end in .html` | Shelf only stores HTML artifacts. |

## Notes

- Output directory: `~/.shelf` (`html/<machine-id>/<path>` plus `index.json`). Don't edit it.
- `--json` is safe to parse; progress lines go to stderr unless you pass `--stream`.
