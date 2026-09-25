import { machineColor, type ShelfFileMeta, type SortKey } from "@shelf/shared";
import { ICONS, h, svg } from "../dom.js";
import { formatBytes, relativeTime, titleOf } from "../logic.js";
import type { AppContext } from "../context.js";

export interface ListView {
  element: HTMLElement;
  refresh(): Promise<void>;
  /** Re-render facets and sort label from the latest status/state. */
  refreshChrome(): void;
  focusSearch(): void;
}

const PAGE_SIZE = 20;

type SortState = { key: SortKey; dir: "asc" | "desc"; label: string };

const SORTS: SortState[] = [
  { key: "created", dir: "desc", label: "Newest" },
  { key: "created", dir: "asc", label: "Oldest" },
  { key: "edited", dir: "desc", label: "Recently edited" },
];

export function createListView(ctx: AppContext): ListView {
  const state = { q: "", machine: "", sort: 0, shown: PAGE_SIZE };
  let files: ShelfFileMeta[] = [];
  let total = 0;
  let loading = false;
  let error: string | null = null;

  const rows = h("div", { class: "rows" });
  const body = h("div", { class: "content" }, rows);
  const footer = h("div", { class: "list-footer" });

  const searchInput = h("input", {
    attrs: {
      type: "search",
      placeholder: "Search paths",
      "aria-label": "Search paths",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const searchBox = h(
    "label",
    { class: "search" },
    svg(ICONS.search, 15),
    searchInput,
  );

  let debounce: number | undefined;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      state.q = searchInput.value.trim();
      state.shown = PAGE_SIZE;
      void refresh();
    }, 150);
  });

  const facets = h("div", { class: "filters" });
  const sortButton = h("button", {
    class: "facet",
    attrs: { type: "button" },
    on: {
      click: () => {
        state.sort = (state.sort + 1) % SORTS.length;
        void refresh();
      },
    },
  });

  const toolbar = h("div", { class: "toolbar" }, searchBox, facets, sortButton);

  async function refresh(): Promise<void> {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const sort = SORTS[state.sort];
      const response = await ctx.adapter.list({
        q: state.q || undefined,
        machine: state.machine || undefined,
        limit: state.shown,
        offset: 0,
        sort: sort.key,
        dir: sort.dir,
      });
      files = response.files;
      total = response.total;
      for (const file of files) ctx.cacheFile(file);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      files = [];
      total = 0;
    } finally {
      loading = false;
      renderRows();
      renderChrome();
    }
  }

  function renderChrome(): void {
    const sort = SORTS[state.sort];
    sortButton.replaceChildren(
      document.createTextNode(sort.label),
      svg("M6 9l6 6 6-6", 14),
    );
    sortButton.setAttribute(
      "aria-label",
      `Sort: ${sort.label}. Click to change.`,
    );

    const machines = ctx.status()?.machines ?? [];
    const chips = [
      h("button", {
        class: "facet",
        attrs: { type: "button", "aria-pressed": String(state.machine === "") },
        on: {
          click: () => {
            state.machine = "";
            state.shown = PAGE_SIZE;
            void refresh();
          },
        },
        text: "All",
      }),
      ...machines.map((machine) => {
        const color = machineColor(machine.machineId);
        return h(
          "button",
          {
            class: "facet",
            attrs: {
              type: "button",
              "aria-pressed": String(state.machine === machine.machineId),
              title: `${machine.count} file(s) from ${machine.machineId}`,
            },
            on: {
              click: () => {
                state.machine = state.machine === machine.machineId ? "" : machine.machineId;
                state.shown = PAGE_SIZE;
                void refresh();
              },
            },
          },
          h("span", {
            class: "swatch",
            style: { background: color.swatch },
          }),
          document.createTextNode(machine.machineId),
        );
      }),
    ];
    facets.replaceChildren(...chips);
  }

  function renderRows(): void {
    if (error) {
      rows.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("h2", { text: "Could not read the shelf" }),
          h("p", { text: error }),
          h("button", {
            class: "ghost-button",
            text: "Try again",
            on: { click: () => void refresh() },
          }),
        ),
      );
      footer.replaceChildren();
      return;
    }

    if (files.length === 0) {
      rows.replaceChildren(emptyState());
      footer.replaceChildren();
      return;
    }

    rows.replaceChildren(
      ...files.map((file) => {
        const color = machineColor(file.machineId);
        return h(
          "button",
          {
            class: "row",
            attrs: { type: "button" },
            dataset: { id: file.id },
            style: {
              "--row-bg": color.lightBg,
              "--row-bg-dark": color.darkBg,
              "--row-border": color.swatch,
            },
            on: { click: () => ctx.openReader(file.id) },
          },
          h("span", { class: "bar" }),
          h(
            "span",
            {},
            h("span", { class: "title", text: titleOf(file) }),
            h("span", {
              class: "sub",
              text: `${file.path} · ${file.machineId} · ${relativeTime(file.editedAt)}`,
            }),
          ),
          h("span", { class: "meta", text: formatBytes(file.bytes) }),
        );
      }),
    );

    const hasMore = files.length < total;
    footer.replaceChildren(
      h("span", { text: `${files.length} of ${total}` }),
      hasMore
        ? h("button", {
            class: "ghost-button",
            text: "Load more",
            on: {
              click: () => {
                state.shown += PAGE_SIZE;
                void refresh();
              },
            },
          })
        : h("span", {}),
    );
  }

  function emptyState(): HTMLElement {
    const status = ctx.status();
    if (state.q || state.machine) {
      return h(
        "div",
        { class: "empty" },
        h("h2", { text: "No matches" }),
        h("p", { text: "Try a different path fragment or machine." }),
      );
    }
    if (ctx.adapter.kind === "local" && !status?.configured) {
      return h(
        "div",
        { class: "empty" },
        h("h2", { text: "Nothing here yet" }),
        h("p", {
          text: "This app reads the shelf through the CLI. Run setup once and it will stay in sync.",
        }),
        h("p", {}, h("code", { text: "shelf setup" })),
        h("button", {
          class: "ghost-button",
          text: "Run setup now",
          on: {
            click: async () => {
              try {
                ctx.toast("Opening the browser to authorize this machine…");
                await ctx.adapter.setup?.();
                await ctx.refreshStatus();
                ctx.refreshChrome();
                await refresh();
              } catch (cause) {
                ctx.toast(cause instanceof Error ? cause.message : String(cause));
              }
            },
          },
        }),
      );
    }
    return h(
      "div",
      { class: "empty" },
      h("h2", { text: "The shelf is empty" }),
      h("p", {
        text: "Anything an agent writes lands here. On a machine with the CLI:",
      }),
      h("p", {}, h("code", { text: "shelf write ./report.html" })),
    );
  }

  renderChrome();
  void refresh();

  return {
    element: h("div", { class: "list" }, toolbar, body, footer),
    refresh,
    refreshChrome: renderChrome,
    focusSearch: () => searchInput.focus(),
  };
}
