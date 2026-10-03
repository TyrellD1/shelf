import { parseScope, SCOPE_PERMISSIONS, type KeyScope } from "@shelf/shared";
import { browserOnly, type Auth } from "./auth.js";
import type { Env } from "./env.js";

/**
 * Browser half of `shelf setup`.
 *
 *   shelf setup -> GET /cli?port=&state=&client=&label=&scope=   (this page, needs a session)
 *               -> POST /cli/authorize                    (mints an API key)
 *               -> http://127.0.0.1:<port>/callback?state=&token=&scope=   (CLI stores it)
 *
 * Only a loopback redirect is allowed, so a token can never be handed to a
 * remote host. `scope` from the CLI (`shelf setup --append-only`) only picks the
 * default on this page; the person authorizing chooses what the key gets.
 */
export async function handleCliAuth(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  const isPost = request.method.toUpperCase() === "POST";
  const form = isPost ? await request.formData().catch(() => null) : null;

  const field = (key: string): string => {
    if (form) {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    }
    return url.searchParams.get(key) ?? "";
  };

  const port = Number.parseInt(field("port"), 10);
  const state = field("state");
  const clientId = field("client");
  const label = (field("label") || "this machine").slice(0, 64);
  const scope = parseScope(field("scope"));

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return page("Cannot continue", "The CLI sent an invalid loopback port.", 400);
  }
  if (!/^[a-f0-9]{16,64}$/.test(state)) {
    return page("Cannot continue", "The CLI sent an invalid state token.", 400);
  }
  if (clientId && !/^[A-Za-z0-9-]{6,64}$/.test(clientId)) {
    return page("Cannot continue", "The CLI sent an invalid client id.", 400);
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
  try {
    // Cookie only: an API key must not be able to authorize a new key.
    session = await auth.api.getSession({ headers: browserOnly(request.headers) });
  } catch {
    session = null; // bad api key: fall through to the login redirect
  }
  if (!session) {
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(`${env.APP_URL}/login?next=${encodeURIComponent(next)}`, 302);
  }

  if (isPost) {
    const origin = request.headers.get("origin");
    if (origin && origin !== env.APP_URL) {
      return page("Cannot continue", "Cross-origin request refused.", 403);
    }
    if (!form) {
      return page("Cannot continue", "The form was not readable.", 400);
    }

    await revokePreviousKeys(auth, request, clientId);

    // Permissions are server-only in the api-key plugin, so the key is minted
    // for the signed-in user without forwarding the browser's headers.
    const created = await auth.api.createApiKey({
      body: {
        userId: session.user.id,
        name: `cli:${label}`,
        metadata: { source: "shelf-cli", clientId, label, scope },
        permissions: SCOPE_PERMISSIONS[scope],
      },
    });

    const target = new URL(`http://127.0.0.1:${port}/callback`);
    target.searchParams.set("state", state);
    target.searchParams.set("token", created.key);
    target.searchParams.set("api", env.APP_URL);
    target.searchParams.set("email", session.user.email);
    target.searchParams.set("scope", scope);
    return Response.redirect(target.toString(), 302);
  }

  return page(
    "Authorize the shelf CLI",
    renderAuthorizeBody({ label, state, port, clientId, scope, email: session.user.email }),
    200,
  );
}

/** Re-running setup on the same machine rotates its key instead of piling up. */
async function revokePreviousKeys(auth: Auth, request: Request, clientId: string): Promise<void> {
  if (!clientId) return;
  try {
    const headers = browserOnly(request.headers);
    const listed = await auth.api.listApiKeys({ headers });
    const keys =
      (listed as { apiKeys?: Array<{ id: string; metadata?: unknown }> }).apiKeys ??
      (Array.isArray(listed) ? (listed as Array<{ id: string; metadata?: unknown }>) : []);
    for (const key of keys) {
      const metadata = key.metadata as { clientId?: string } | null | undefined;
      if (metadata?.clientId === clientId) {
        await auth.api.deleteApiKey({ body: { keyId: key.id }, headers });
      }
    }
  } catch (error) {
    console.warn("shelf: could not rotate an older cli key", error);
  }
}

interface Capability {
  title: string;
  detail: string;
  /** Present on an append-only key too. */
  append: boolean;
}

/** What a key can do, in the order the page lists it. Mirrors `appendScopeAllows`. */
const CAPABILITIES: Capability[] = [
  {
    title: "Write new documents",
    detail:
      "Push the HTML that <code>shelf write</code> stores. Writing a path that already exists adds the next version (<code>-v2</code>, <code>-v3</code>) instead of overwriting it.",
    append: true,
  },
  {
    title: "Check its own paths",
    detail:
      "Look up whether a path is taken (its size and hash, never its HTML) so a rewrite lands on a free version.",
    append: true,
  },
  {
    title: "Replace documents in place",
    detail: "<code>shelf write --replace</code> overwrites a path with new bytes.",
    append: false,
  },
  {
    title: "List the shelf",
    detail:
      "See every document's path, machine, size and dates across all your machines (<code>shelf list</code>, <code>shelf status</code>).",
    append: false,
  },
  {
    title: "Read documents",
    detail: "Fetch the HTML of any document on the shelf, from any machine.",
    append: false,
  },
  {
    title: "Sync other machines down",
    detail:
      "<code>shelf sync</code> pulls what your other machines wrote into this one's local store.",
    append: false,
  },
];

function renderAuthorizeBody(input: {
  label: string;
  state: string;
  port: number;
  clientId: string;
  scope: KeyScope;
  email: string;
}): string {
  const label = escapeHtml(input.label);
  const checked = (scope: KeyScope) => (input.scope === scope ? " checked" : "");
  const capabilities = CAPABILITIES.map(
    (item) => `
      <details class="cap${item.append ? "" : " cap-read"}">
        <summary>${escapeHtml(item.title)}</summary>
        <p>${item.detail}</p>
      </details>`,
  ).join("");
  return `
    <p class="lede">The <code>shelf</code> CLI on <strong>${label}</strong> wants a key for your
    shelf. Everything it writes is attributed to that machine id.</p>
    ${
      input.scope === "append"
        ? `<p class="asked">The CLI asked for <strong>append-only</strong> access.</p>`
        : ""
    }
    <form method="post" action="/cli/authorize">
      <input type="hidden" name="state" value="${escapeHtml(input.state)}" />
      <input type="hidden" name="port" value="${input.port}" />
      <input type="hidden" name="client" value="${escapeHtml(input.clientId)}" />
      <input type="hidden" name="label" value="${label}" />
      <fieldset class="scopes">
        <legend>Access</legend>
        <label class="scope">
          <input type="radio" name="scope" value="full"${checked("full")} />
          <span><strong>Full access</strong><small>Read, write and sync the whole shelf.</small></span>
        </label>
        <label class="scope">
          <input type="radio" name="scope" value="append" id="scope-append"${checked("append")} />
          <span><strong>Append only</strong><small>Write new documents. Can't read anything back.</small></span>
        </label>
      </fieldset>
      <div class="caps-head">What this key can do</div>
      <div class="caps">${capabilities}
      </div>
      <p class="append-note">It can't list, read, replace or sync anything. Best for a headless
      machine that only publishes.</p>
      <button type="submit">Authorize ${label}</button>
    </form>
    <p class="fine">Signed in as ${escapeHtml(input.email)}. The key does not expire; running
    <code>shelf setup</code> again rotates it.</p>
  `;
}

function page(title: string, body: string, status: number): Response {
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
