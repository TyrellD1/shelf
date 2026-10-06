import { machineColor, type MachineSummary } from "@shelf/shared";
import { ICONS, h, svg } from "../dom.js";

export interface MachinePicker {
  element: HTMLElement;
  /** Redraw from the latest machines and selection. */
  render(machines: MachineSummary[], selected: string[], thisDevice: string | null): void;
  close(): void;
}

/**
 * The machine filter: one button that opens a multi-select. Nothing selected
 * means every machine. Each toggle applies at once, so the list behind the
 * popover narrows as you tick. Phones get the same list as a bottom sheet.
 */
export function createMachinePicker(onChange: (selected: string[]) => void): MachinePicker {
  let machines: MachineSummary[] = [];
  let selected: string[] = [];
  let thisDevice: string | null = null;

  const label = h("span", { class: "picker-label" });
  const button = h(
    "button",
    {
      class: "picker-button",
      attrs: { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" },
      on: { click: () => (panel.isConnected ? close() : open()) },
    },
    label,
    svg("M6 9l6 6 6-6", 12),
  );
  const list = h("div", { class: "picker-list" });
  const panel = h(
    "div",
    { class: "picker", attrs: { role: "dialog", "aria-label": "Filter by machine" } },
    h("div", { class: "picker-handle", attrs: { "aria-hidden": "true" } }),
    list,
  );
  const scrim = h("div", { class: "picker-scrim", on: { click: () => close() } });
  const element = h("div", { class: "picker-anchor" }, button);

  function set(next: string[]): void {
    selected = next;
    draw();
    onChange([...selected]);
  }

  function ordered(): MachineSummary[] {
    // This device first, then the order the shelf reports (most files first).
    return [...machines].sort((a, b) => Number(b.machineId === thisDevice) - Number(a.machineId === thisDevice));
  }

  function draw(): void {
    const known = new Set(machines.map((machine) => machine.machineId));
    // A selection can outlive its machine (renamed, or not synced yet); keep it visible.
    const extra = selected.filter((id) => !known.has(id)).map((machineId) => ({ machineId, count: 0, latestAt: "" }));

    if (selected.length === 0) label.replaceChildren(document.createTextNode("All machines"));
    else if (selected.length === 1) {
      label.replaceChildren(
        h("span", { class: "swatch", style: { background: machineColor(selected[0], known).swatch } }),
        document.createTextNode(selected[0] === thisDevice ? "This device" : selected[0]),
      );
    } else label.replaceChildren(document.createTextNode(`${selected.length} machines`));
    button.dataset.active = String(selected.length > 0);
    button.title = selected.length ? `Showing ${selected.join(", ")}` : "Filter by machine";

    const total = machines.reduce((sum, machine) => sum + machine.count, 0);
    const allRow = h(
      "button",
      {
        class: "picker-item all",
        attrs: { type: "button", "aria-pressed": String(selected.length === 0) },
        on: { click: () => set([]) },
      },
      h("span", { class: "picker-check" }, selected.length === 0 ? svg(ICONS.check, 12) : null),
      h("span", { class: "picker-name", text: "All machines" }),
      h("span", { class: "picker-count", text: String(total) }),
    );

    const rows = [...ordered(), ...extra].map((machine) => {
      const checked = selected.includes(machine.machineId);
      const checkbox = h("input", {
        attrs: { type: "checkbox", checked },
        on: {
          change: () =>
            set(
              checkbox.checked
                ? [...selected, machine.machineId]
                : selected.filter((id) => id !== machine.machineId),
            ),
        },
      });
      return h(
        "label",
        { class: "picker-item", dataset: { checked: String(checked) } },
        checkbox,
        h("span", { class: "picker-check", attrs: { "aria-hidden": "true" } }, checked ? svg(ICONS.check, 12) : null),
        h("span", { class: "swatch", style: { background: machineColor(machine.machineId, known).swatch } }),
        h(
          "span",
          { class: "picker-name" },
          document.createTextNode(machine.machineId),
          machine.machineId === thisDevice ? h("span", { class: "picker-tag", text: "this device" }) : null,
        ),
        h("button", {
          class: "picker-only",
          text: "Only",
          attrs: { type: "button", title: `Show only ${machine.machineId}` },
          on: {
            click: (event) => {
              event.preventDefault();
              set([machine.machineId]);
            },
          },
        }),
        h("span", { class: "picker-count", text: String(machine.count) }),
      );
    });

    list.replaceChildren(allRow, h("div", { class: "picker-sep" }), ...rows);
  }

  function items(): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(".picker-item.all, .picker-item input")];
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const all = items();
      const index = all.indexOf(document.activeElement as HTMLElement);
      const next = index === -1 ? 0 : (index + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
      all[next]?.focus();
    }
  }

  function onOutside(event: Event): void {
    if (!element.contains(event.target as Node)) close();
  }

  function open(): void {
    draw();
    element.append(scrim, panel);
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    // Start on the current choice so Space toggles what you are looking at.
    const first = list.querySelector<HTMLElement>(".picker-item input:checked") ?? items()[0];
    first?.focus({ preventScroll: true });
  }

  function close(): void {
    if (!panel.isConnected) return;
    panel.remove();
    scrim.remove();
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  }

  return {
    element,
    render(nextMachines, nextSelected, nextThisDevice) {
      machines = nextMachines;
      selected = [...nextSelected];
      thisDevice = nextThisDevice;
      // A poll re-renders this; keep focus where it was inside an open panel.
      const focusedId = panel.isConnected
        ? (document.activeElement?.closest(".picker-item") as HTMLElement | null)?.textContent
        : null;
      draw();
      if (focusedId) {
        const again = [...list.querySelectorAll<HTMLElement>(".picker-item")].find((item) => item.textContent === focusedId);
        (again?.querySelector("input") ?? again)?.focus({ preventScroll: true });
      }
    },
    close,
  };
}
