import "./style.css";
import type { ShelfFileMeta } from "@shelf/shared";
import { createAdapter, isTauri, type DataAdapter, type StatusInfo } from "./adapter.js";
import type { AppContext, ReaderChrome } from "./context.js";
import { ICONS, h, mount, svg } from "./dom.js";
import { relativeTime } from "./logic.js";
import { notifyTheme } from "./theme.js";
import { createListView, type ListView } from "./views/list.js";
import { createReaderView, type ReaderView } from "./views/reader.js";
import { openPalette } from "./views/palette.js";
import { renderLoginInto } from "./views/login.js";

function fallbackStatus(error: unknown): StatusInfo {
  return {
    configured: false,
    apiUrl: null,
    machineId: null,
    lastSyncAt: null,
    fileCount: 0,
    pending: 0,
    user: null,
    machines: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

let toastNode: HTMLElement | null = null;
let toastTimer: number | undefined;

/** One toast at a time: a new message replaces the last instead of stacking on it. */
function showToast(message: string): void {
  toastNode?.remove();
  window.clearTimeout(toastTimer);
  const node = h("div", { class: "toast", text: message, attrs: { role: "status" } });
  toastNode = node;
  document.body.appendChild(node);
  toastTimer = window.setTimeout(() => {
    node.remove();
    if (toastNode === node) toastNode = null;
  }, 3600);
}

/** How often the home page pulls while it is on screen. */
const POLL_MS = 10_000;

function themeButton(): HTMLButtonElement {
  const apply = () => {
    const dark =
      document.documentElement.dataset.theme === "dark" ||
      (document.documentElement.dataset.theme !== "light" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    const icon = dark ? ICONS.sun : ICONS.moon;
    const path = button.querySelector("path");
    if (path) path.setAttribute("d", icon);
    button.setAttribute("aria-label", dark ? "Switch to light" : "Switch to dark");
  };
  const button = h("button", {
    class: "icon-button",
    attrs: { type: "button" },
    on: {
      click: () => {
        const current = document.documentElement.dataset.theme;
        const next =
          current === "dark"
            ? "light"
            : current === "light"
              ? "dark"
              : window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "light"
                : "dark";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("shelf-theme", next);
        } catch {
          // private mode
        }
        notifyTheme(next);
        apply();
      },
    },
  });
  button.appendChild(svg(ICONS.moon, 15));
  apply();
  return button;
}

function dot(state: "ok" | "busy" | "error"): HTMLElement {
  return h("span", { class: "dot", dataset: { state } });
}

let currentApp: { stop: () => void } | null = null;

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  // Signing out (or a lapsed session) boots again; the old app must stop polling.
  currentApp?.stop();
  currentApp = null;

  const adapter = createAdapter();
  let status: StatusInfo;
  try {
    status = await adapter.status();
  } catch (error) {
    status = fallbackStatus(error);
  }

  if (adapter.kind === "network" && !status.configured) {
    const noopChrome: ReaderChrome = {
      setTitle: () => undefined,
      setActions: () => undefined,
      clear: () => undefined,
    };
    const ctx = contextFor(adapter, () => status, () => undefined, noopChrome, async () => undefined);
    renderLoginInto(root, ctx, () => void boot());
    return;
  }

  const app = createApp(adapter, status);
  currentApp = app;
  mount(root, app.element);
  app.start();
}

/** Context factory. The app patches in the Chrome handles and a status getter. */
function contextFor(
  adapter: DataAdapter,
  currentStatus: () => StatusInfo,
  refreshChrome: () => void,
  readerChrome: ReaderChrome,
  pull: AppContext["pull"],
): AppContext {
  const cache = new Map<string, ShelfFileMeta>();
  const ctx: AppContext = {
    adapter,
    status: currentStatus,
    refreshStatus: async () => {
      const next = await adapter.status();
      statusRef.value = next;
      refreshChrome();
      return next;
    },
    openReader: (id) => {
      location.hash = `#/f/${encodeURIComponent(id)}`;
    },
    closeReader: () => {
      location.hash = "#/";
    },
    openPalette: () => openPalette(ctx),
    pull,
    toast: showToast,
    cacheFile: (file) => cache.set(file.id, file),
    getCachedFile: (id) => cache.get(id),
    refreshChrome,
    readerChrome,
  };
  return ctx;
}

const statusRef: { value: StatusInfo } = { value: fallbackStatus(null) };

function createApp(
  adapter: DataAdapter,
  initialStatus: StatusInfo,
): { element: HTMLElement; start: () => void; stop: () => void } {
  statusRef.value = initialStatus;
  let syncState: "idle" | "busy" | "error" = "idle";
  let syncNote = "";
  /** The sync in flight, shared by background polls and the sync button. */
  let syncing: Promise<void> | null = null;
  /** Whether someone is watching the sync in flight (button, ⌘R, launch). */
  let syncLoud = false;
  /** Fallback for a CLI too old to report `syncedAt`. */
  let syncedHere: string | null = null;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let stopped = false;
  let focusSearchAfterRoute = false;
  const cleanups: (() => void)[] = [];
  let listView: ListView | null = null;
  let readerView: ReaderView | null = null;

  const viewHost = h("div", { class: "view-host" });
  const syncChip = h("button", { class: "chip", attrs: { type: "button" } });
  const userChip = h("span", { class: "chip", attrs: { hidden: true } });  const signOutButton = h(
    "button",
    {
      class: "icon-button",
      attrs: { type: "button", hidden: true, title: "Sign out", "aria-label": "Sign out" },
      on: {
        click: async () => {
          await adapter.signOut?.().catch(() => undefined);
          await boot();
        },
      },
    },
    svg(ICONS.logout, 15),
  );
  const theme = themeButton();

  // Reader controls live in the top bar, next to the wordmark.
  const readerLeft = h("div", { class: "reader-chrome", attrs: { hidden: true } });
  const readerRight = h("div", { class: "reader-chrome", attrs: { hidden: true } });
  const readerTitle = h("span", { class: "reader-title" });
  const readerSep = h("span", { class: "reader-sep", text: "·", attrs: { "aria-hidden": "true" } });
  const readerSubtitle = h("span", { class: "reader-subtitle" });
  const readerChrome: ReaderChrome = {
    setTitle(title, subtitle) {
      readerTitle.textContent = title;
      readerTitle.title = title;
      readerSubtitle.textContent = subtitle;
      const showSubtitle = subtitle.length > 0;
      readerSubtitle.hidden = !showSubtitle;
      readerSep.hidden = !showSubtitle;
    },
    setActions(actions) {
      readerLeft.replaceChildren(
        h(
          "button",
          {
            class: "icon-button bare",
            attrs: { type: "button", title: "Back to the shelf", "aria-label": "Back to the shelf" },
            on: { click: () => actions.back() },
          },
          svg(ICONS.arrowLeft, 16),
        ),
        h("span", { class: "reader-heading" }, readerTitle, readerSep, readerSubtitle),
      );
      readerRight.replaceChildren(
        h(
          "button",
          {
            class: "icon-button",
            attrs: {
              type: "button",
              title: "Open the file in your browser",
              "aria-label": "Open the file in your browser",
            },
            on: { click: () => actions.external() },
          },
          svg(ICONS.external, 14),
        ),
      );
      readerLeft.hidden = false;
      readerRight.hidden = false;
    },
    clear() {
      readerLeft.hidden = true;
      readerRight.hidden = true;
      readerLeft.replaceChildren();
      readerRight.replaceChildren();
    },
  };

  const topbar = h(
    "div",
    {
      class: "topbar",
      // Tauri starts a window drag on mousedown inside this subtree; buttons and
      // inputs are skipped by Tauri itself. Ignored by the PWA, which has no
      // window to drag. `-webkit-app-region` is Electron-only and does nothing
      // here, which is why the bar was not draggable before.
      attrs: { "data-tauri-drag-region": "deep" },
    },
    readerLeft,
    h("span", { class: "spacer" }),
    syncChip,
    userChip,
    signOutButton,
    readerRight,
    theme,
  );
  const element = h("div", { class: "app" }, topbar, viewHost);

  const ctx = contextFor(adapter, () => statusRef.value, () => renderChrome(), readerChrome, (options) =>
    pull(options?.quiet ?? false),
  );

  function renderChrome(): void {
    if (adapter.kind === "local") {
      const status = statusRef.value;
      syncChip.hidden = false;
      userChip.hidden = true;
      signOutButton.hidden = true;
      if (!status.configured) {
        syncChip.dataset.state = "error";
        syncChip.title = status.error ?? "Run shelf setup";
        syncChip.replaceChildren(dot("error"), document.createTextNode("Set up"));
        syncChip.onclick = () => void runSetup();
      } else if (syncState === "busy") {
        syncChip.dataset.state = "busy";
        syncChip.replaceChildren(dot("busy"), document.createTextNode(syncNote || "Syncing…"));
        syncChip.onclick = null;
      } else if (syncState === "error") {
        syncChip.dataset.state = "error";
        syncChip.replaceChildren(dot("error"), document.createTextNode("Sync failed"));
        syncChip.title = syncNote;
        syncChip.onclick = () => void runSync();
      } else {
        // `lastSyncAt` is the pull cursor (the newest remote edit), which does not
        // move when a sync finds nothing new; `syncedAt` is when the sync ran.
        const syncedAt = status.syncedAt ?? syncedHere;
        const when = syncedAt ? `In sync · ${relativeTime(syncedAt)}` : "Not synced yet";
        syncChip.dataset.state = "ok";
        syncChip.title = `${status.fileCount} file(s) on this device${status.pending ? `, ${status.pending} to push` : ""}`;
        syncChip.replaceChildren(dot("ok"), document.createTextNode(when));
        syncChip.onclick = () => void runSync();
      }
    } else {
      syncChip.hidden = true;
      userChip.hidden = false;
      signOutButton.hidden = false;
      userChip.textContent = statusRef.value.user?.email ?? "signed in";
    }
    listView?.refreshChrome();
  }

  /**
   * Runs `shelf sync`. A quiet run (the 10 s poll) leaves the chip alone and
   * never toasts; a loud one shows progress. Clicking sync while a quiet run is
   * in flight makes that run loud instead of queueing a second one.
   */
  function runSync(quiet = false): Promise<void> {
    if (adapter.kind !== "local" || !statusRef.value.configured) return Promise.resolve();
    if (!quiet && !syncLoud) {
      syncLoud = true;
      syncState = "busy";
      syncNote = "Syncing…";
      renderChrome();
    }
    syncing ??= doSync().finally(() => {
      syncing = null;
      syncLoud = false;
    });
    return syncing;
  }

  async function doSync(): Promise<void> {
    try {
      const result = await adapter.sync((message) => {
        if (!syncLoud) return;
        syncNote = message;
        renderChrome();
      });
      if (result.errors.length === 0) syncedHere = result.syncedAt ?? new Date().toISOString();
      statusRef.value = await adapter.status();
      syncState = result.errors.length > 0 ? "error" : "idle";
      syncNote = result.errors.join("; ");
      if (result.errors.length > 0 && syncLoud) {
        showToast(`Sync finished with problems: ${result.errors.join("; ")}`);
      }
      renderChrome();
      await listView?.refresh({ quiet: true, markNew: true });
    } catch (error) {
      syncState = "error";
      syncNote = error instanceof Error ? error.message : String(error);
      renderChrome();
      if (syncLoud) showToast(`Sync failed: ${syncNote}`);
      // Whatever is already on this device is still worth showing.
      await listView?.refresh({ quiet: true });
    }
  }

  /** Brings the home page up to date from wherever this host gets its data. */
  async function pull(quiet: boolean): Promise<void> {
    if (stopped) return;
    if (adapter.kind === "local") {
      if (statusRef.value.configured) {
        await runSync(quiet);
        return;
      }
      statusRef.value = await adapter.status();
      renderChrome();
      await listView?.refresh({ quiet: true, markNew: true });
      return;
    }
    try {
      const next = await adapter.status();
      if (!next.configured) {
        // The session lapsed: show the sign-in page rather than an empty list.
        void boot();
        return;
      }
      statusRef.value = next;
      renderChrome();
    } catch {
      // Offline: the list refresh below reports it.
    }
    await listView?.refresh({ quiet, markNew: true });
  }

  const onHome = () => !stopped && listView !== null && readerView === null;

  /** Polls every POLL_MS while the home page is on screen and the window visible. */
  function schedulePoll(): void {
    window.clearTimeout(pollTimer);
    if (!onHome() || document.hidden) return;
    pollTimer = window.setTimeout(() => {
      if (!onHome() || document.hidden) return;
      void pull(true).finally(schedulePoll);
    }, POLL_MS);
  }

  function onVisibility(): void {
    if (document.hidden) {
      window.clearTimeout(pollTimer);
      return;
    }
    // Coming back to the window is when stale data is most noticeable.
    if (onHome()) void pull(true).finally(schedulePoll);
  }

  async function runSetup(): Promise<void> {
    try {
      showToast("Opening your browser to authorize this machine…");
      await adapter.setup?.();
      statusRef.value = await adapter.status();
      renderChrome();
      await listView?.refresh();
      await runSync();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }

  function route(): void {
    const match = /^#\/f\/(.+)$/.exec(location.hash || "#/");
    readerView?.destroy();
    readerView = null;
    if (match) {
      window.clearTimeout(pollTimer);
      if (listView?.element.isConnected) listView.hidden();
      const reader = createReaderView(ctx, decodeURIComponent(match[1]));
      readerView = reader;
      mount(viewHost, reader.element);
      return;
    }
    listView ??= createListView(ctx);
    if (!listView.element.isConnected) {
      mount(viewHost, listView.element);
      listView.shown();
    }
    void listView.refresh({ quiet: true, markNew: true });
    if (focusSearchAfterRoute) {
      focusSearchAfterRoute = false;
      listView.focusSearch();
    }
    schedulePoll();
  }

  function start(): void {
    renderChrome();
    route();
    listen(window, "hashchange", route);
    listen(document, "visibilitychange", onVisibility);
    // Keeps "In sync · 2m ago" honest between polls (and while reading).
    tickTimer = window.setInterval(() => {
      if (syncState === "idle") renderChrome();
    }, 30_000);

    // Follow the system theme when no manual choice is stored, and tell open
    // documents about it.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      if (document.documentElement.dataset.theme === "light") return;
      if (document.documentElement.dataset.theme === "dark") return;
      notifyTheme(event.matches ? "dark" : "light");
    });

    listen(window, "keydown", (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === "k" || event.key === "p")) {
        event.preventDefault();
        ctx.openPalette();
        return;
      }
      if (mod && event.key === "r" && adapter.kind === "local" && !event.shiftKey) {
        event.preventDefault();
        void runSync();
        return;
      }
      const typing = /^(input|textarea|select)$/i.test(
        (event.target as HTMLElement | null)?.tagName ?? "",
      );
      if (event.key === "/" && !typing) {
        event.preventDefault();
        if (readerView) {
          focusSearchAfterRoute = true;
          ctx.closeReader();
        } else {
          listView?.focusSearch();
        }
      }
    });

    adapter.onOpen?.((event) => {
      if (event.id) ctx.openReader(event.id);
    });
    void adapter.pendingOpen?.().then((event) => {
      if (event?.id) ctx.openReader(event.id);
    });

    if (adapter.kind === "local" && statusRef.value.configured) {
      void runSync();
    }

    if ("serviceWorker" in navigator && !isTauri() && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }

  function listen<K extends string>(
    target: Window | Document,
    type: K,
    handler: (event: never) => void,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  }

  function stop(): void {
    stopped = true;
    window.clearTimeout(pollTimer);
    window.clearInterval(tickTimer);
    for (const cleanup of cleanups.splice(0)) cleanup();
    readerView?.destroy();
    readerView = null;
  }

  return { element, start, stop };
}

void boot();
