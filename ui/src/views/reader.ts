import { ICONS, h, svg } from "../dom.js";
import { formatBytes, relativeTime, titleOf } from "../logic.js";
import type { AppContext } from "../context.js";

export interface ReaderView {
  element: HTMLElement;
  destroy(): void;
}

/**
 * Full-window reader. The document itself is served by the host:
 * the desktop app through the `shelf://` protocol (strict CSP, no network),
 * the PWA through an object URL. Either way the artifact is sandboxed.
 */
export function createReaderView(ctx: AppContext, id: string): ReaderView {
  const iframe = h("iframe", {
    attrs: {
      title: "Shelf document",
      sandbox: ctx.adapter.kind === "local" ? "allow-scripts allow-same-origin" : "allow-scripts",
      referrerpolicy: "no-referrer",
    },
  });

  const label = h("span", { class: "label", text: "Loading…" });
  const external = h(
    "button",
    {
      class: "icon-button",
      attrs: { type: "button", title: "Open in a browser tab", "aria-label": "Open in a browser tab" },
      on: {
        click: () => {
          if (source) window.open(source, "_blank", "noopener");
        },
      },
    },
    svg("M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5", 15),
  );

  const bar = h(
    "div",
    { class: "reader-bar" },
    h(
      "button",
      {
        class: "icon-button",
        attrs: { type: "button", title: "Back to the shelf", "aria-label": "Back to the shelf" },
        on: { click: () => ctx.closeReader() },
      },
      svg(ICONS.menu, 16),
    ),
    external,
    label,
  );

  const element = h("div", { class: "reader" }, iframe, bar);
  let source: string | null = null;

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      ctx.closeReader();
    }
  };
  window.addEventListener("keydown", onKey);

  void (async () => {
    const file = ctx.getCachedFile(id) ?? (await ctx.adapter.get(id));
    if (!file) {
      label.textContent = `${id} is not in the local store`;
      iframe.replaceWith(
        h(
          "div",
          { class: "empty", style: { height: "100%" } },
          h("h2", { text: "Not on this device" }),
          h("p", {
            text: "The file was not found locally. Run a sync, or open it from the web app.",
          }),
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
    label.textContent = `${titleOf(file)} · ${file.machineId} · ${formatBytes(file.bytes)} · ${relativeTime(file.editedAt)}`;
    source = await ctx.adapter.readerSource(file);
    iframe.src = source;
  })();

  return {
    element,
    destroy() {
      window.removeEventListener("keydown", onKey);
      if (source) ctx.adapter.releaseReaderSource?.(source);
    },
  };
}
