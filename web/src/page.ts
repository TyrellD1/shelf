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
