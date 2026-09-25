import { ICONS, h, svg } from "../dom.js";
import { formatBytes, relativeTime, titleOf } from "../logic.js";
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

  const view = h("div", { class: "reader" }, iframe);
  const element = view;
  let source: string | null = null;
  let disposed = false;

  ctx.readerChrome.setTitle("Loading…", "");
  ctx.readerChrome.setActions({
    back: () => ctx.closeReader(),
    external: () => {
      if (source) window.open(source, "_blank", "noopener");
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
    const file = ctx.getCachedFile(id) ?? (await ctx.adapter.get(id));
    if (disposed) return;
    if (!file) {
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
    ctx.cacheFile(file);
    ctx.readerChrome.setTitle(
      titleOf(file),
      `${file.machineId} · ${formatBytes(file.bytes)} · ${relativeTime(file.editedAt)}`,
    );
    source = await ctx.adapter.readerSource(file);
    if (disposed) {
      ctx.adapter.releaseReaderSource?.(source);
      return;
    }
    iframe.src = source;
  })();

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
