import type { Auth } from "./auth.js";
import type { Env } from "./env.js";

/**
 * Browser half of `shelf setup`.
 *
 *   shelf setup -> GET /cli?port=&state=&client=&label=   (this page, needs a session)
 *               -> POST /cli/authorize                    (mints an API key)
 *               -> http://127.0.0.1:<port>/callback?state=&token=   (CLI stores it)
 *
 * Only a loopback redirect is allowed, so a token can never be handed to a
 * remote host.
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
    session = await auth.api.getSession({ headers: request.headers });
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

    const created = await auth.api.createApiKey({
      body: {
        name: `cli:${label}`,
        metadata: { source: "shelf-cli", clientId, label },
      },
      headers: request.headers,
    });

    const target = new URL(`http://127.0.0.1:${port}/callback`);
    target.searchParams.set("state", state);
    target.searchParams.set("token", created.key);
    target.searchParams.set("api", env.APP_URL);
    target.searchParams.set("email", session.user.email);
    return Response.redirect(target.toString(), 302);
  }

  return page(
    "Authorize the shelf CLI",
    renderAuthorizeBody({ label, state, port, clientId, email: session.user.email }),
    200,
  );
}

/** Re-running setup on the same machine rotates its key instead of piling up. */
async function revokePreviousKeys(auth: Auth, request: Request, clientId: string): Promise<void> {
  if (!clientId) return;
  try {
    const listed = await auth.api.listApiKeys({ headers: request.headers });
    const keys =
      (listed as { apiKeys?: Array<{ id: string; metadata?: unknown }> }).apiKeys ??
      (Array.isArray(listed) ? (listed as Array<{ id: string; metadata?: unknown }>) : []);
    for (const key of keys) {
      const metadata = key.metadata as { clientId?: string } | null | undefined;
      if (metadata?.clientId === clientId) {
        await auth.api.deleteApiKey({ body: { keyId: key.id }, headers: request.headers });
      }
    }
  } catch (error) {
    console.warn("shelf: could not rotate an older cli key", error);
  }
}

function renderAuthorizeBody(input: {
  label: string;
  state: string;
  port: number;
  clientId: string;
  email: string;
}): string {
  const label = escapeHtml(input.label);
  return `
    <p class="lede">The <code>shelf</code> CLI on <strong>${label}</strong> wants a key so it can
    write to your shelf and sync it down. Everything it writes is attributed to that machine id.</p>
    <form method="post" action="/cli/authorize">
      <input type="hidden" name="state" value="${escapeHtml(input.state)}" />
      <input type="hidden" name="port" value="${input.port}" />
      <input type="hidden" name="client" value="${escapeHtml(input.clientId)}" />
      <input type="hidden" name="label" value="${label}" />
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
