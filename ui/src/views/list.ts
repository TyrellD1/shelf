import { machineColor, type ShelfFileMeta, type SortKey } from "@shelf/shared";
import { ICONS, h, svg } from "../dom.js";
import {
  folderOf,
  formatBytes,
  formatDate,
  groupByDate,
  highlightRanges,
  listSignature,
  relativeTime,
  versionOf,
} from "../logic.js";
import type { AppContext } from "../context.js";
import { createMachinePicker } from "./machines.js";

export interface RefreshOptions {
  /** Keep what is on screen while loading and on failure (polls, pulls). */
  quiet?: boolean;
  /** Give rows that were not on screen before a brief highlight. */
  markNew?: boolean;
}

export interface ListView {
  element: HTMLElement;
  refresh(options?: RefreshOptions): Promise<void>;
  /** Re-render the machine filter from the latest status. */
  refreshChrome(): void;
  focusSearch(): void;
  /** Called after the view is mounted again (restores scroll). */
  shown(): void;
  /** Called before the view is unmounted (remembers scroll). */
  hidden(): void;
}

const PAGE_SIZE = 30;
const SORT_KEY = "shelf-sort";
const PULL_THRESHOLD = 64;

type SortState = { key: SortKey; dir: "asc" | "desc"; label: string };

const SORTS: SortState[] = [
  { key: "created", dir: "desc", label: "Newest" },
  { key: "created", dir: "asc", label: "Oldest" },
  { key: "edited", dir: "desc", label: "Recently edited" },
];

function storedSort(): number {
  try {
    const value = Number(localStorage.getItem(SORT_KEY));
    return Number.isInteger(value) && value >= 0 && value < SORTS.length ? value : 0;
  } catch {
    return 0;
  }
}

/** Text with every match of `query` wrapped in `<mark>`. */
function highlighted(text: string, query: string): Node[] {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return [document.createTextNode(text)];
  const nodes: Node[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
    nodes.push(h("mark", { text: text.slice(start, end) }));
    at = end;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}

/** "mac-mini", "mac-mini and ci-runner", "3 machines". */
function machinesText(ids: string[]): string {
  if (ids.length <= 2) return ids.join(" and ");
  return `${ids.length} machines`;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (/^(input|textarea|select)$/i.test(element.tagName) || element.isContentEditable));
}

export function createListView(ctx: AppContext): ListView {
  const state = { q: "", machines: [] as string[], sort: storedSort(), shown: PAGE_SIZE };
  let files: ShelfFileMeta[] = [];
  let total = 0;
  let loaded = false;
  let error: string | null = null;
  let staleError: string | null = null;
  let sequence = 0;
  let signature = "";
  let selectedId: string | null = null;
  let known = new Set<string>();
  let savedScroll = 0;
  let loadingMore = false;

  // ------------------------------------------------------------- toolbar

  const searchInput = h("input", {
    attrs: {
      type: "text",
      inputmode: "search",
      enterkeyhint: "go",
      placeholder: window.matchMedia("(max-width: 560px)").matches
        ? "Search the shelf"
        : "Search titles, folders, machines",
      "aria-label": "Search the shelf",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
    },
  });
  const clearButton = h(
    "button",
    {
      class: "search-clear",
      attrs: { type: "button", title: "Clear search", "aria-label": "Clear search", hidden: true },
      on: {
        click: () => {
          setQuery("");
          searchInput.focus();
        },
      },
    },
    svg(ICONS.close, 12),
  );
  const slashHint = h("kbd", { class: "search-kbd", text: "/", attrs: { "aria-hidden": "true" } });
  const searchBox = h(
    "label",
    { class: "search" },
    svg(ICONS.search, 15),
    searchInput,
    slashHint,
    clearButton,
  );

  let debounce: number | undefined;
  searchInput.addEventListener("input", () => {
    syncSearchChrome();
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      state.q = searchInput.value.trim();
      resetPaging();
      void refresh();
    }, 140);
  });

  const sortSelect = h(
    "select",
    {
      attrs: { "aria-label": "Sort" },
      on: {
        change: () => {
          state.sort = Number(sortSelect.value);
          try {
            localStorage.setItem(SORT_KEY, String(state.sort));
          } catch {
            // private mode: the choice lasts until reload
          }
          sortLabel.textContent = SORTS[state.sort].label;
          resetPaging();
          void refresh();
        },
      },
    },
    ...SORTS.map((sort, index) => h("option", { attrs: { value: index }, text: sort.label })),
  );
  sortSelect.value = String(state.sort);
  // The native select sits invisibly over a small label: phones get their own
  // picker, and its 16px font keeps iOS from zooming the page on focus.
  const sortLabel = h("span", { text: SORTS[state.sort].label });
  const sortBox = h("label", { class: "select" }, sortLabel, svg("M6 9l6 6 6-6", 12), sortSelect);

  const refreshButton = h(
    "button",
    {
      class: "icon-button refresh",
      attrs: {
        type: "button",
        title: ctx.adapter.kind === "local" ? "Sync now (⌘R)" : "Refresh",
        "aria-label": ctx.adapter.kind === "local" ? "Sync now" : "Refresh",
      },
      on: { click: () => void pull() },
    },
    svg(ICONS.refresh, 14),
  );

  let machineDebounce: number | undefined;
  const picker = createMachinePicker((selected) => {
    state.machines = selected;
    resetPaging();
    renderSummary();
    // Ticking three boxes in a row should cost one request, not three.
    window.clearTimeout(machineDebounce);
    machineDebounce = window.setTimeout(() => void refresh(), 120);
  });
  const summaryText = h("div", { class: "summary-text", attrs: { "aria-live": "polite" } });
  const summary = h(
    "div",
    { class: "summary" },
    summaryText,
    h("div", { class: "summary-controls" }, picker.element, sortBox),
  );

  const head = h(
    "div",
    { class: "list-head" },
    h(
      "div",
      { class: "list-inner" },
      h("div", { class: "toolbar" }, searchBox, refreshButton),
      summary,
    ),
  );

  // ---------------------------------------------------------------- body

  const rows = h("div", { class: "rows", attrs: { role: "list" } });
  const footer = h("div", { class: "list-footer" });
  const pullIndicator = h("div", { class: "pull", attrs: { "aria-hidden": "true" } }, svg(ICONS.refresh, 16));
  const content = h(
    "div",
    { class: "content" },
    pullIndicator,
    h("div", { class: "list-inner" }, rows, footer),
  );
  const element = h("div", { class: "list" }, head, content);

  // ------------------------------------------------------------- loading

  function resetPaging(): void {
    state.shown = PAGE_SIZE;
    content.scrollTop = 0;
  }

  function setQuery(value: string): void {
    window.clearTimeout(debounce);
    searchInput.value = value;
    syncSearchChrome();
    if (state.q === value) return;
    state.q = value;
    resetPaging();
    void refresh();
  }

  function syncSearchChrome(): void {
    const has = searchInput.value.length > 0;
    clearButton.hidden = !has;
    slashHint.hidden = has;
  }

  /** Only the newest request renders, so a fast typist never sees stale results. */
  async function refresh(options: RefreshOptions = {}): Promise<void> {
    const ticket = ++sequence;
    const sort = SORTS[state.sort];
    const filterKey = `${state.q}\u0000${state.machines.join(",")}\u0000${state.sort}`;
    if (!loaded) renderSkeleton();
    else if (!options.quiet) element.dataset.loading = "true";
    try {
      const response = await ctx.adapter.list({
        q: state.q || undefined,
        machines: state.machines.length ? state.machines : undefined,
        limit: state.shown,
        offset: 0,
        sort: sort.key,
        dir: sort.dir,
      });
      if (ticket !== sequence) return;
      const fresh =
        options.markNew && loaded && filterKey === lastFilterKey
          ? new Set(response.files.filter((file) => !known.has(file.id)).map((file) => file.id))
          : new Set<string>();
      files = response.files;
      total = response.total;
      error = null;
      staleError = null;
      known = new Set(files.map((file) => file.id));
      for (const file of files) ctx.cacheFile(file);
      loaded = true;
      lastFilterKey = filterKey;
      renderRows(fresh);
    } catch (cause) {
      if (ticket !== sequence) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (options.quiet && loaded && !error) {
        // Keep the list a poll could not refresh; say so quietly.
        staleError = message;
      } else {
        error = message;
        files = [];
        total = 0;
        loaded = true;
        renderRows(new Set());
      }
    } finally {
      if (ticket === sequence) {
        delete element.dataset.loading;
        loadingMore = false;
        renderSummary();
      }
    }
  }
  let lastFilterKey = "";

  async function pull(): Promise<void> {
    if (refreshButton.dataset.busy) return;
    refreshButton.dataset.busy = "true";
    try {
      await ctx.pull();
    } finally {
      delete refreshButton.dataset.busy;
    }
  }

  // ------------------------------------------------------------ rendering

  function renderChrome(): void {
    const status = ctx.status();
    const machines = status?.machines ?? [];
    // One machine is not a choice; keep the control while a selection is active.
    picker.element.hidden = machines.length < 2 && state.machines.length === 0;
    picker.render(machines, state.machines, ctx.adapter.kind === "local" ? (status?.machineId ?? null) : null);
    sortSelect.value = String(state.sort);
    sortLabel.textContent = SORTS[state.sort].label;
  }

  function renderSummary(): void {
    if (!loaded || error) {
      summaryText.replaceChildren();
      return;
    }
    const parts: Node[] = [];
    const filtered = Boolean(state.q || state.machines.length);
    if (filtered) {
      parts.push(document.createTextNode(`${total} ${total === 1 ? "match" : "matches"}`));
      if (state.q) parts.push(document.createTextNode(" for "), h("strong", { text: `“${state.q}”` }));
      // The machine button already names the machines; saying it twice wraps on phones.
      parts.push(
        h("button", {
          class: "link-button",
          attrs: { type: "button" },
          text: "Clear",
          on: { click: clearFilters },
        }),
      );
    } else {
      parts.push(document.createTextNode(`${total} ${total === 1 ? "file" : "files"}`));
    }
    if (staleError) {
      parts.push(h("span", { class: "stale", text: "Couldn’t refresh, retrying", attrs: { title: staleError } }));
    }
    summaryText.replaceChildren(...parts);
  }

  function clearFilters(): void {
    window.clearTimeout(debounce);
    searchInput.value = "";
    syncSearchChrome();
    state.q = "";
    state.machines = [];
    picker.close();
    resetPaging();
    renderChrome();
    void refresh();
  }

  function renderSkeleton(): void {
    rows.replaceChildren(
      ...Array.from({ length: 7 }, (_, index) =>
        h(
          "div",
          { class: "row skeleton", attrs: { "aria-hidden": "true" } },
          h("span", { class: "bar" }),
          h(
            "span",
            { class: "main" },
            h("span", { class: "bone", style: { width: `${38 + ((index * 17) % 35)}%` } }),
            h("span", { class: "bone small", style: { width: `${22 + ((index * 11) % 25)}%` } }),
          ),
        ),
      ),
    );
    footer.replaceChildren();
  }

  function renderRows(fresh: Set<string>): void {
    if (error) {
      signature = "";
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
      signature = "";
      rows.replaceChildren(emptyState());
      footer.replaceChildren();
      return;
    }

    const sort = SORTS[state.sort];
    const next = listSignature(files, `${state.q}\u0000${sort.key}\u0000${total}`);
    if (next === signature && fresh.size === 0) return;
    signature = next;

    const stampOf = (file: ShelfFileMeta) => (sort.key === "edited" ? file.editedAt : file.createdAt);
    if (selectedId && !files.some((file) => file.id === selectedId)) selectedId = null;

    const sections = groupByDate(files, stampOf).map((group) =>
      h(
        "section",
        { class: "section", attrs: { "aria-label": group.label } },
        h("h3", { class: "section-head", text: group.label }),
        ...group.items.map((file) => rowFor(file, stampOf(file), fresh.has(file.id))),
      ),
    );
    rows.replaceChildren(...sections);

    const hasMore = files.length < total;
    const end = files.length > 12 ? h("span", { class: "end", text: "That’s everything" }) : "";
    footer.replaceChildren(
      hasMore
        ? h("button", {
            class: "ghost-button",
            text: loadingMore ? "Loading…" : `Show more (${total - files.length})`,
            on: { click: () => loadMore() },
          })
        : end,
    );
    // Re-observe so a footer that is still in view after a page loads fires again.
    observer?.unobserve(footer);
    if (hasMore) observer?.observe(footer);
  }

  function knownMachines(): string[] {
    return (ctx.status()?.machines ?? []).map((machine) => machine.machineId);
  }

  function rowFor(file: ShelfFileMeta, stamp: string, isFresh: boolean): HTMLElement {
    const color = machineColor(file.machineId, knownMachines());
    const { base, version } = versionOf(file);
    const folder = folderOf(file.path);
    const created = formatDate(file.createdAt);
    const edited = formatDate(file.editedAt);
    return h(
      "a",
      {
        class: `row${isFresh ? " fresh" : ""}`,
        attrs: {
          href: `#/f/${encodeURIComponent(file.id)}`,
          role: "listitem",
          "aria-current": file.id === selectedId ? "true" : null,
          title: file.path,
        },
        dataset: { id: file.id },
        style: {
          "--row-tint": color.lightBg,
          "--row-tint-dark": color.darkBg,
          "--row-border": color.swatch,
        },
        on: {
          click: (event) => {
            const mouse = event as MouseEvent;
            if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button !== 0) return;
            event.preventDefault();
            open(file.id);
          },
        },
      },
      h("span", { class: "bar" }),
      h(
        "span",
        { class: "main" },
        h(
          "span",
          { class: "title-line" },
          h("span", { class: "title" }, ...highlighted(base, state.q)),
          version ? h("span", { class: "badge", text: `v${version}` }) : null,
        ),
        h(
          "span",
          { class: "sub" },
          folder ? h("span", { class: "folder" }, ...highlighted(folder, state.q)) : null,
          h(
            "span",
            { class: "machine" },
            h("span", { class: "swatch", style: { background: color.swatch } }),
            ...highlighted(file.machineId, state.q),
          ),
        ),
      ),
      h(
        "span",
        { class: "meta" },
        h("span", {
          class: "time",
          text: relativeTime(stamp),
          attrs: { title: created === edited ? `Created ${created}` : `Created ${created} · edited ${edited}` },
        }),
        h("span", { class: "size", text: formatBytes(file.bytes) }),
      ),
    );
  }

  function emptyState(): HTMLElement {
    const status = ctx.status();
    if (state.q || state.machines.length) {
      return h(
        "div",
        { class: "empty" },
        h("h2", { text: "No matches" }),
        h("p", {
          text: state.q
            ? `Nothing on the shelf matches “${state.q}”${state.machines.length ? ` on ${machinesText(state.machines)}` : ""}.`
            : `Nothing from ${machinesText(state.machines)} yet.`,
        }),
        h("button", { class: "ghost-button", text: "Clear filters", on: { click: clearFilters } }),
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

  // -------------------------------------------------------------- paging

  function loadMore(): void {
    if (loadingMore || files.length >= total) return;
    loadingMore = true;
    state.shown += PAGE_SIZE;
    void refresh({ quiet: true });
  }

  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) loadMore();
          },
          { root: content, rootMargin: "240px 0px" },
        )
      : null;

  // ---------------------------------------------------------- selection

  function open(id: string): void {
    selectedId = id;
    ctx.openReader(id);
  }

  function rowElements(): HTMLElement[] {
    return [...rows.querySelectorAll<HTMLElement>("a.row")];
  }

  function select(id: string | null, scroll = true): void {
    selectedId = id;
    for (const row of rowElements()) {
      if (row.dataset.id === id) {
        row.setAttribute("aria-current", "true");
        if (scroll) row.scrollIntoView({ block: "nearest" });
      } else {
        row.removeAttribute("aria-current");
      }
    }
  }

  function move(delta: number): void {
    const ids = rowElements().map((row) => row.dataset.id ?? "");
    if (ids.length === 0) return;
    const index = selectedId ? ids.indexOf(selectedId) : -1;
    const next = index === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(Math.max(index + delta, 0), ids.length - 1);
    select(ids[next]);
  }

  window.addEventListener("keydown", (event) => {
    if (!element.isConnected || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector(".scrim")) return;
    const inSearch = event.target === searchInput;
    if (isTyping(event.target) && !inSearch) return;

    if (inSearch && event.key === "Escape") {
      event.preventDefault();
      if (searchInput.value) setQuery("");
      else searchInput.blur();
      return;
    }
    const down = event.key === "ArrowDown" || (!inSearch && event.key === "j");
    const up = event.key === "ArrowUp" || (!inSearch && event.key === "k");
    if (down || up) {
      event.preventDefault();
      move(down ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      const target = selectedId ?? (inSearch ? rowElements()[0]?.dataset.id : undefined);
      if (target) {
        event.preventDefault();
        open(target);
      }
      return;
    }
    if (event.key === "Escape" && selectedId) {
      select(null, false);
    }
  });

  // ------------------------------------------------------ pull to refresh

  let pullStart: number | null = null;
  let pullDistance = 0;
  content.addEventListener(
    "touchstart",
    (event) => {
      pullStart = content.scrollTop <= 0 ? event.touches[0].clientY : null;
      pullDistance = 0;
    },
    { passive: true },
  );
  content.addEventListener(
    "touchmove",
    (event) => {
      if (pullStart === null) return;
      const delta = event.touches[0].clientY - pullStart;
      if (delta <= 0 || content.scrollTop > 0) {
        pullDistance = 0;
        setPull(0);
        return;
      }
      // Resistance: the indicator moves slower than the thumb.
      pullDistance = Math.min(delta * 0.5, PULL_THRESHOLD * 1.5);
      setPull(pullDistance);
    },
    { passive: true },
  );
  content.addEventListener("touchend", () => {
    if (pullStart === null) return;
    pullStart = null;
    if (pullDistance >= PULL_THRESHOLD) {
      pullIndicator.dataset.state = "busy";
      setPull(PULL_THRESHOLD * 0.75);
      void pull().finally(() => {
        delete pullIndicator.dataset.state;
        setPull(0);
      });
    } else {
      setPull(0);
    }
    pullDistance = 0;
  });

  function setPull(distance: number): void {
    pullIndicator.style.setProperty("--pull", `${distance}px`);
    pullIndicator.style.opacity = String(Math.min(distance / (PULL_THRESHOLD * 0.6), 1));
    if (pullStart === null) delete pullIndicator.dataset.dragging;
    else pullIndicator.dataset.dragging = "true";
    pullIndicator.style.setProperty("--pull-turn", `${(distance / PULL_THRESHOLD) * 270}deg`);
    pullIndicator.dataset.ready = String(distance >= PULL_THRESHOLD);
  }

  renderChrome();
  syncSearchChrome();

  return {
    element,
    refresh,
    refreshChrome: renderChrome,
    focusSearch: () => {
      searchInput.focus();
      searchInput.select();
    },
    shown: () => {
      content.scrollTop = savedScroll;
      if (selectedId) select(selectedId);
    },
    hidden: () => {
      savedScroll = content.scrollTop;
    },
  };
}
