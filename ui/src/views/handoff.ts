import { h, mount } from "../dom.js";
import { appLinkFor, isDesktopBrowser } from "../logic.js";

/**
 * Hands a web reader link (`https://…/#/f/<id>`) to the desktop app.
 *
 * A link pasted into Notion, Slack or a doc opens in the browser; the browser is
 * the only thing that can then launch `shelf://open?id=…`. Whether to do that is
 * remembered per browser: "app" launches straight away, "browser" never asks,
 * and no answer yet asks once. Nothing here runs inside the desktop app itself.
 */

const PREFERENCE_KEY = "shelf-open-links";
type Preference = "app" | "browser";

function readPreference(): Preference | null {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY);
    return value === "app" || value === "browser" ? value : null;
  } catch {
    return null;
  }
}

function writePreference(value: Preference | null): void {
  try {
    if (value) localStorage.setItem(PREFERENCE_KEY, value);
    else localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // private mode: the choice just is not remembered
  }
}

function launch(link: string): void {
  // A top-level navigation to an unknown scheme leaves the page in place; the
  // browser either hands it to the OS or (no app installed) does nothing.
  window.location.href = link;
}

/** True when this browser could hand links to the desktop app. */
export function canHandOff(): boolean {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return false;
  return isDesktopBrowser(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** Opens the current document in the desktop app on request (the reader bar button). */
export function openInApp(): boolean {
  const link = appLinkFor(location.hash);
  if (!link) return false;
  // Choosing the app again means a remembered "browser" no longer holds.
  if (readPreference() === "browser") writePreference(null);
  launch(link);
  return true;
}

/**
 * Called once per page load, before sign-in. Returns true when it took over the
 * page; `proceed` then boots the web app as normal if the user stays here.
 */
export function maybeHandOff(root: Element, proceed: () => void): boolean {
  const link = appLinkFor(location.hash);
  if (!link || !canHandOff()) return false;
  const preference = readPreference();
  if (preference === "browser") return false;

  const stay = proceed;

  if (preference === "app") {
    showOpened(root, link, stay);
    launch(link);
    return true;
  }

  const remember = h("input", { attrs: { type: "checkbox", checked: true } });
  const choose = (value: Preference) => {
    if (remember.checked) writePreference(value);
    if (value === "app") {
      // Leave the "Opened in Shelf" screen behind in case they come back to the tab.
      showOpened(root, link, stay);
      launch(link);
    } else {
      stay();
    }
  };
  mount(
    root,
    screen(
      "Open in the Shelf app?",
      "Shelf links can open in the desktop app instead of the browser.",
      h("button", { class: "primary", attrs: { type: "button" }, text: "Open in Shelf", on: { click: () => choose("app") } }),
      h("button", { class: "ghost-button", attrs: { type: "button" }, text: "Read it here", on: { click: () => choose("browser") } }),
      h("label", { class: "handoff-remember" }, remember, " Remember for this browser"),
    ),
  );
  return true;
}

function showOpened(root: Element, link: string, stay: () => void): void {
  mount(
    root,
    screen(
      "Opened in Shelf",
      "This document was sent to the Shelf app. If nothing happened, the app may not be installed on this computer.",
      h("button", { class: "primary", attrs: { type: "button" }, text: "Open again", on: { click: () => launch(link) } }),
      h("button", { class: "ghost-button", attrs: { type: "button" }, text: "Read it here", on: { click: stay } }),
      h("button", {
        class: "link-button",
        attrs: { type: "button" },
        text: "Stop opening links in the app",
        on: {
          click: () => {
            writePreference(null);
            stay();
          },
        },
      }),
    ),
  );
}

function screen(title: string, body: string, ...actions: HTMLElement[]): HTMLElement {
  return h(
    "div",
    { class: "handoff" },
    h("div", { class: "handoff-card" }, h("h1", { text: title }), h("p", { text: body }), ...actions),
  );
}
