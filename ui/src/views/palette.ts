import { machineColor, type ShelfFileMeta } from "@shelf/shared";
import { h } from "../dom.js";
import { relativeTime, titleOf } from "../logic.js";
import type { AppContext } from "../context.js";

/** ⌘P / ⌘K: search every file and open it, without leaving the reader. */
export function openPalette(ctx: AppContext): () => void {
  let items: ShelfFileMeta[] = [];
  let active = 0;
  let debounce: number | undefined;

  const input = h("input", {
    attrs: {
      type: "text",
      placeholder: "Search the whole shelf…",
      "aria-label": "Search every file",
      autocomplete: "off",
      spellcheck: "false",
    },
  });

  const results = h("div", { class: "palette-results" });
  const scrim = h(
    "div",
    {
      class: "scrim",
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Search every file" },
      on: {
        click: (event) => {
          if (event.target === scrim) close();
        },
      },
    },
    h(
      "div",
      { class: "palette" },
      input,
      results,
      h("div", {
        class: "palette-hint",
        text: "↑↓ to move · ⏎ to open · esc to close",
      }),
    ),
  );

  function render(): void {
    if (items.length === 0) {
      results.replaceChildren(
        h("div", {
          class: "palette-hint",
          style: { borderTop: "0" },
          text: input.value.trim() ? "No matches" : "Loading…",
        }),
      );
      return;
    }
    results.replaceChildren(
      ...items.map((file, index) => {
        const color = machineColor(file.machineId);
        return h(
          "button",
          {
            class: "palette-item",
            attrs: { type: "button", "data-active": String(index === active) },
            style: {
              "--row-bg": color.lightBg,
              "--row-bg-dark": color.darkBg,
              "--row-border": color.swatch,
            },
            on: {
              click: () => open(file.id),
              mouseenter: () => {
                active = index;
                render();
              },
            },
          },
          h("span", { class: "bar" }),
          h(
            "span",
            {},
            h("span", { class: "title", style: { display: "block" }, text: titleOf(file) }),
            h("span", {
              class: "sub",
              style: { display: "block" },
              text: `${file.path} · ${file.machineId} · ${relativeTime(file.editedAt)}`,
            }),
          ),
          h("span", { class: "meta", text: file.machineId.slice(0, 3) }),
        );
      }),
    );
    const activeElement = results.querySelector<HTMLElement>('[data-active="true"]');
    activeElement?.scrollIntoView({ block: "nearest" });
  }

  async function search(): Promise<void> {
    try {
      const response = await ctx.adapter.list({ q: input.value.trim() || undefined, limit: 20 });
      items = response.files;
      active = 0;
    } catch {
      items = [];
    }
    render();
  }

  function open(id: string): void {
    close();
    ctx.openReader(id);
  }

  function close(): void {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      active = Math.min(active + 1, items.length - 1);
      render();
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      render();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const file = items[active];
      if (file) open(file.id);
    }
  }

  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void search(), 120);
  });

  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(scrim);
  input.focus();
  render();
  void search();

  return close;
}
