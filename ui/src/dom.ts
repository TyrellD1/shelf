export type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  html?: string;
  style?: Record<string, string | null | undefined>;
  dataset?: Record<string, string | null | undefined>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, (event: Event) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.html !== undefined) el.innerHTML = props.html;
    if (props.style) {
      for (const [key, value] of Object.entries(props.style)) {
        if (value != null) el.style.setProperty(key, value);
      }
    }
    if (props.dataset) {
      for (const [key, value] of Object.entries(props.dataset)) {
        if (value != null) el.dataset[key] = value;
      }
    }
    if (props.attrs) {
      for (const [key, value] of Object.entries(props.attrs)) {
        if (value === null || value === undefined || value === false) continue;
        el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    if (props.on) {
      for (const [event, handler] of Object.entries(props.on)) {
        el.addEventListener(event, handler);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function mount(target: Element, ...children: Child[]): void {
  target.replaceChildren();
  append(target, children);
}

export function svg(path: string, size = 18): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  node.appendChild(p);
  return node;
}

export const ICONS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5.5 12.5L21 21",
  menu: "M4 7h16M4 12h16M4 17h16",
  refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
  sun: "M12 4V2m0 20v-2M4 12H2m20 0h-2M6 6 4.5 4.5M18 18l1.5 1.5M6 18 4.5 19.5M18 6l1.5-1.5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  logout: "M15 12H4m0 0 3.5-3.5M4 12l3.5 3.5M12 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6",
  close: "M6 6l12 12M18 6 6 18",
  check: "M4 12.5 9 17.5 20 6.5",
  external: "M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
} as const;
