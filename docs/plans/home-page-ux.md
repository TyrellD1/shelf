# Home page UX overhaul

Scope: the list view, meaning the search, filters, sort, rows, and the states around them, on
desktop (Tauri) and mobile (PWA). **The top bar is out of scope.** Its layout, CSS, and
traffic-light alignment stay exactly as they are. The only change there is behavioural: the sync
chip now shows the right text, with no change to markup or styles.

The work is in four passes: bugs, eyesores, delight, then verification.

## 1. Bugs

| # | Bug | Cause | Fix |
|---|-----|-------|-----|
| 1 | Clicking sync doesn't update "In sync · 3d ago" | The chip shows `lastSyncAt`, which is the **pull cursor** (the server's `edited_at` of the newest file pulled), not the time of the sync. If nothing new arrived, it never moves. | The CLI records `syncedAt` (the wall-clock time of the last sync that finished) in the index and reports it from `status`, `sync`, and `list`. The chip shows that. The pull cursor keeps its meaning. |
| 2 | The chip never shows sync progress | `adapter.sync(onProgress)` passes a boolean to Rust, which emits `shelf-progress`, but nothing in the UI listens. | The local adapter subscribes to `shelf-progress` while a sync runs. |
| 3 | Filters and search "work weird" | `refresh()` returns early when a request is already in flight, so the **latest** query or filter is dropped and the list shows results for an older state. | Request sequencing: every refresh gets a token, and only the newest response renders. |
| 4 | No way to refresh | The only option is ⌘R on desktop. The PWA has nothing. | A refresh button in the list toolbar (sync on desktop, refetch on the PWA), pull-to-refresh on touch, and auto-refresh (below). |
| 5 | The list goes stale | Nothing polls. | Auto-refresh every 10 s, **only while the home page is visible**: paused in the reader and when the tab or window is hidden, and it fires right away when you come back. The desktop runs a quiet `shelf sync` that doesn't pulse the chip; the PWA refetches status and the list. |
| 6 | Relative times freeze ("just now" forever) | Rows and the chip only render on data changes. | Polling re-renders. Rows are keyed by a signature that includes the displayed times, so an unchanged list isn't rebuilt (no hover or selection flicker). |
| 7 | Returning from the reader loses your place | The list element is re-mounted and the scroll resets. | Save and restore scroll, and restore the selection to the document you opened. |
| 8 | `/` from the reader doesn't focus search | Focus is attempted before the list is mounted. | Focus after routing. |
| 9 | PWA search ignores machine names | The Worker matches only `path_on_machine`, but the CLI matches path **or** machine. That breaks the "surfaces never disagree" rule. | The Worker matches both. |
| 10 | iOS zooms into the search field | The input is 13 px, and Safari zooms on anything under 16 px. | 16 px on coarse pointers. |
| 11 | Toasts stack on top of each other | Each toast is appended at the same fixed spot. | One toast at a time; a new one replaces the old. |
| 12 | An empty palette says "Loading…" forever | The empty-query plus empty-shelf case wasn't handled. | It says the shelf is empty. |

## 2. Eyesores

- **The mobile toolbar is a horizontal scroller** that hides the sort control and most filters
  offscreen while squeezing search to 180 px. It becomes two rows: a full-width search with the
  refresh button and sort, then a swipeable facet strip with edge fades.
- **The sort button cycles on click** with no hint of the options. It becomes a native `<select>`
  (Newest, Oldest, Recently edited), which gives the native picker on phones. The choice is
  remembered per viewer.
- **Rows stretch to 1700 px**, leaving the size flush right, far from the title. The list becomes
  a centred column (max ~880 px) with the toolbar aligned to it.
- **The time is clipped on mobile** because it sits at the end of an ellipsised sub-line. It moves
  to the right column (with the size under it on desktop).
- **Heavy per-row tints**, especially in dark mode. The tint drops to a hover/selection wash, and
  machine identity stays on the 3 px bar and a small swatch next to the machine name. This keeps
  the "grey-first, colour for identity" rule from `DESIGN.md`.
- **Redundant sub-line**: the full path repeats the title. The sub-line shows the folder plus the
  machine.
- **Facet chips for a single machine** are noise, so the strip hides when there are fewer than two
  machines. Chips show counts.
- **A "12 of 12" footer band**. It becomes a quiet summary line under the toolbar ("12 files",
  "3 matches for "foo" on mac-mini · Clear").
- The blank list on first load becomes skeleton rows.
- Safe-area bottom padding for the PWA on notched phones.

## 3. Delight

- **Date sections** (Today, Yesterday, This week, then by month) with sticky headers. They follow
  the active sort key (created or edited).
- **Match highlighting** of the search term in titles and folders.
- **Version badge**: `report-v3.html` shows as "report" with a `v3` pill.
- **Keyboard**: `↑`/`↓` or `j`/`k` move a selection, `⏎` opens, `Esc` clears search and then
  blurs, and `/` focuses search (a hint shows in the field on desktop).
- **New arrivals glow**: rows that appear on a refresh fade in with a brief highlight.
- **Pull-to-refresh** on touch, with a spinner that follows your thumb.
- **Infinite scroll**: an IntersectionObserver loads the next page, and "Load more" stays as a
  fallback.
- **Clear button** in the search field, and a "Clear filters" action in the no-matches state.
- Rows are real links (`<a href="#/f/<id>">`), so cmd-click and middle-click open a new tab on the
  PWA.

## 4. Where things live

- `ui/src/logic.ts` holds the new pure helpers, tested in `ui/test/logic.test.ts`: `dateGroup`,
  `versionOf`, `highlightRanges`, `folderOf`, and `listSignature`.
- `ui/src/views/list.ts` is the rewritten list view (toolbar, sections, keyboard, infinite scroll,
  pull-to-refresh).
- `ui/src/main.ts` handles polling on the home route, quiet versus loud sync, progress, the chip
  using `syncedAt`, single toasts, and post-route focus. The top-bar DOM and CSS are untouched.
- `ui/src/adapter.ts` adds the progress listener and `syncedAt` on `StatusInfo`.
- `cli/src/lib/store.ts` and `cli/src/commands/{sync,status,list}.ts` add `syncedAt` to the index
  and output. It is a cache field like `lastSyncAt`, and losing it only means the chip says
  "Not synced yet" until the next sync.
- `web/src/api.ts` makes search match the machine id too.
- `ui/src/style.css` changes only the list, toolbar, and row sections. The top-bar rules are
  untouched.

## 5. Verification

- `npm run typecheck && npm test`.
- Screenshots of desktop and phone, in light and dark, against a mocked API with Playwright, before
  and after.
- Scripted checks in Playwright: typing fast lands on the latest query, the sort select, a facet
  toggle, keyboard navigation, polling hitting the API every ~10 s on the list and **not** in the
  reader, and scroll restore after the reader.
