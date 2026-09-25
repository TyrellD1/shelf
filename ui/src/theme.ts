/** Theme helpers shared by the app shell and the reader. */

export type Theme = "light" | "dark";

export const THEME_KEY = "shelf-theme";
export const ARTIFACT_THEME_KEY = "html-theme";

export function currentTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Fires whenever the app theme changes (manual toggle or system change). */
export function notifyTheme(theme: Theme): void {
  window.dispatchEvent(new CustomEvent<Theme>("shelf:theme", { detail: theme }));
}

export function onThemeChange(handler: (theme: Theme) => void): void {
  window.addEventListener("shelf:theme", (event) => {
    handler((event as CustomEvent<Theme>).detail ?? currentTheme());
  });
}

/**
 * Bootstrap injected before an artifact's own scripts.
 *
 * The `/html` and `/slides` artifacts keep their theme under `html-theme` and
 * read it in a blocking script in `<head>`. Writing that key first, then
 * correcting the attribute after their script has run and on every message from
 * the parent, makes an artifact follow the app theme without the artifact
 * knowing anything about Shelf.
 */
export function themeBootstrap(theme: Theme): string {
  return `<script>(function(){var theme="${theme}";var root=document.documentElement;function apply(){try{root.dataset.themePreference=theme;root.dataset.theme=theme}catch(e){}}try{localStorage.setItem("${ARTIFACT_THEME_KEY}",theme)}catch(e){}apply();document.addEventListener("DOMContentLoaded",apply);addEventListener("message",function(event){var next=event&&event.data&&event.data.shelfTheme;if(next!=="light"&&next!=="dark")return;theme=next;try{localStorage.setItem("${ARTIFACT_THEME_KEY}",next)}catch(e){}apply()});})();</script>`;
}

/** Inserts the bootstrap just after `<head>`, or at the top when there is none. */
export function injectTheme(html: string, theme: Theme): string {
  const bootstrap = themeBootstrap(theme);
  const headStart = html.search(/<head(\s|>)/i);
  if (headStart === -1) return bootstrap + html;
  const close = html.indexOf(">", headStart);
  if (close === -1) return bootstrap + html;
  return html.slice(0, close + 1) + bootstrap + html.slice(close + 1);
}
