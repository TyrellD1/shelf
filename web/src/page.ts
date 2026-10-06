/** Small server-rendered pages for the browser halves of `shelf setup` and MCP sign-in. */

export function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(title)} · Shelf</title>
<style>
  :root { --page:#fafafa; --ink:#111; --muted:#6b6b6b; --line:#e5e5e5; --surface:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --page:#0d0d0d; --ink:#f2f2f2; --muted:#9a9a9a; --line:#262626; --surface:#141414; }
  }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:grid; place-items:center; background:var(--page); color:var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px;
  }
  main { width: 100%; max-width: 430px; background: var(--surface); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:17px; letter-spacing:-.01em; margin:0 0 4px; }
  .brand { font-size:12px; text-transform:uppercase; letter-spacing:.14em; color:var(--muted); margin-bottom:18px; }
  .lede { margin: 0 0 18px; }
  .fine, code { color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .fine { font-size:12.5px; margin: 16px 0 0; }
  button {
    width:100%; padding:11px 16px; border-radius:9px; border:1px solid var(--ink); background:var(--ink); color:var(--page);
    font: inherit; font-weight:500; cursor:pointer;
  }
  button:hover { opacity:.88; }
  button.secondary { background: transparent; color: var(--ink); border-color: var(--line); margin-top: 8px; }
  /* /cli: the key's access picker and what it can do. */
  .asked { margin: -6px 0 16px; font-size: 13px; color: var(--muted); }
  .scopes { border: 0; margin: 0 0 16px; padding: 0; display: grid; gap: 8px; }
  .scopes legend, .caps-head {
    font-size: 11.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted);
    padding: 0; margin-bottom: 8px;
  }
  .scope {
    display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; cursor: pointer;
    border: 1px solid var(--line); border-radius: 9px;
  }
  .scope:has(input:checked) { border-color: var(--ink); }
  .scope input { margin: 3px 0 0; accent-color: var(--ink); }
  .scope span { display: grid; gap: 1px; }
  .scope small { color: var(--muted); font-size: 12.5px; }
  .caps {
    max-height: 220px; overflow-y: auto; border: 1px solid var(--line); border-radius: 9px;
    margin-bottom: 16px;
  }
  .cap + .cap { border-top: 1px solid var(--line); }
  .cap summary {
    cursor: pointer; padding: 9px 12px; font-size: 13.5px; list-style: none;
    display: flex; justify-content: space-between; align-items: center;
  }
  .cap summary::-webkit-details-marker { display: none; }
  .cap summary::after { content: "+"; color: var(--muted); }
  .cap[open] summary::after { content: "\\2212"; }
  .cap p { margin: 0; padding: 0 12px 10px; font-size: 12.5px; color: var(--muted); }
  .append-note { display: none; margin: -6px 0 16px; font-size: 12.5px; color: var(--muted); }
  /* Append only drops every capability that reads or overwrites the shelf. */
  form:has(#scope-append:checked) .cap-read { display: none; }
  form:has(#scope-append:checked) .cap-read + .cap:not(.cap-read) { border-top: 0; }
  form:has(#scope-append:checked) .append-note { display: block; }
</style></head>
<body><main><div class="brand">Shelf</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
