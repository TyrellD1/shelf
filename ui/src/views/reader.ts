import { versionFamily, versionNumber, type ShelfFileMeta } from "@shelf/shared";
import { h } from "../dom.js";
import { formatBytes, relativeTime, titleOf, versionChoices, versionOf } from "../logic.js";
import { currentTheme, onThemeChange } from "../theme.js";
import type { AppContext } from "../context.js";

export interface ReaderView {
  element: HTMLElement;
  destroy(): void;
}

/**
 * Full-window reader. The document itself is served by the host:
 * the desktop app through the `shelf://` protocol (strict CSP, no network),
 * the PWA through an object URL. Either way the artifact is sandboxed, and the
 * app theme is injected into it so `/html` and `/slides` artifacts match the app.
 */
export function createReaderView(ctx: AppContext, id: string): ReaderView {
  const iframe = h("iframe", {
    attrs: {
      title: "Shelf document",
      sandbox: ctx.adapter.kind === "local" ? "allow-scripts allow-same-origin" : "allow-scripts",
      referrerpolicy: "no-referrer",
    },
  });

  // The desktop webview paints white while a new document loads. Cover the iframe with the
  // page colour until 100 ms after it has loaded; the web app does not need this.
  const LIFT_AFTER_LOAD_MS = 100;
  const cover = ctx.adapter.kind === "local" ? h("div", { class: "reader-cover" }) : null;
  if (cover) {
    iframe.addEventListener("load", () => window.setTimeout(() => cover.remove(), LIFT_AFTER_LOAD_MS));
  }

  const view = h("div", { class: "reader" }, iframe, ...(cover ? [cover] : []));
  const element = view;
  let source: string | null = null;
  let file: ShelfFileMeta | null = null;
  let disposed = false;
  let subtitle = "";

  ctx.readerChrome.setTitle("Loading…", "");
  ctx.readerChrome.setActions({
    back: () => ctx.closeReader(),
    external: () => {
      if (!file) return;
      void ctx.adapter.openExternal(file, source).catch((error: unknown) => {
        ctx.toast(`Could not open your browser: ${error instanceof Error ? error.message : error}`);
      });
    },
  });

  /** Keeps a live artifact in step when the app theme changes. */
  const pushTheme = () => {
    try {
      iframe.contentWindow?.postMessage({ shelfTheme: currentTheme() }, "*");
    } catch {
      // A cross-origin frame that has not loaded yet; the injected bootstrap
      // will pick up the theme on its next load anyway.
    }
  };
  onThemeChange(pushTheme);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      ctx.closeReader();
    }
  };
  window.addEventListener("keydown", onKey);

  void (async () => {
    // The desktop's `shelf read` exits non-zero for an unknown id; treat that as a miss.
    const lookup = () => ctx.adapter.get(id).catch(() => null);
    let found = ctx.getCachedFile(id) ?? (await lookup());
    if (disposed) return;
    if (!found && ctx.adapter.kind === "local") {
      // A link from another machine (or the web) can arrive before this one has
      // pulled the file, so sync once before giving up.
      ctx.readerChrome.setTitle("Syncing…", "");
      await ctx.pull({ quiet: true }).catch(() => undefined);
      if (disposed) return;
      found = await lookup();
      if (disposed) return;
    }
    if (!found) {
      ctx.readerChrome.setTitle("Not on this device", id);
      view.replaceChildren(
        h(
          "div",
          { class: "empty", style: { height: "100%" } },
          h("h2", { text: "Not on this device" }),
          h("p", { text: "The file was not found locally. Run a sync, or open it from the web app." }),
          h("button", {
            class: "ghost-button",
            text: "Back to the shelf",
            on: { click: () => ctx.closeReader() },
          }),
        ),
      );
      return;
    }
    ctx.cacheFile(found);
    file = found;
    subtitle = `${found.machineId} · ${formatBytes(found.bytes)} · ${relativeTime(found.editedAt)}`;
    ctx.readerChrome.setTitle(titleOf(found), subtitle);
    void showVersions(found);
    source = await ctx.adapter.readerSource(found);
    if (disposed) {
      ctx.adapter.releaseReaderSource?.(source);
      return;
    }
    iframe.src = source;
  })();

  /**
   * The version menu, and a notice above the document when this is not the
   * newest version. A failure leaves both out: the document is what matters.
   */
  async function showVersions(current: ShelfFileMeta): Promise<void> {
    const family = await ctx.adapter
      .list({ versionsOf: current.id, limit: 200 })
      // An older CLI or Worker ignores `versionsOf` and answers with the whole shelf.
      .then((response) => response.files.filter((file) => versionFamily(file) === versionFamily(current)))
      .catch(() => [] as ShelfFileMeta[]);
    if (disposed || family.length < 2) return;
    const choices = versionChoices(family, current.id);
    ctx.readerChrome.setVersions(choices, (id) => ctx.openReader(id));
    // The menu names the version, so the title does not repeat it ("roadmap", not "roadmap-v3").
    ctx.readerChrome.setTitle(versionOf(current).base, subtitle);
    const here = choices.find((choice) => choice.current);
    const newest = choices[0];
    if (!here || here.latest) return;
    view.prepend(
      h(
        "div",
        { class: "reader-notice", attrs: { role: "status" } },
        h("span", { text: `This is ${here.short}, an older version.` }),
        h("button", {
          class: "link-button",
          attrs: { type: "button" },
          text: `Open the latest (v${versionNumber(family[0].path)})`,
          on: { click: () => ctx.openReader(newest.id) },
        }),
      ),
    );
  }

  return {
    element,
    destroy() {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      ctx.readerChrome.clear();
      if (source) ctx.adapter.releaseReaderSource?.(source);
    },
  };
}
