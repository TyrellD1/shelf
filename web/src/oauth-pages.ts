import type { Auth } from "./auth.js";
import type { Env } from "./env.js";
import { MCP_MACHINE_ID } from "./mcp.js";
import { escapeHtml, page } from "./page.js";

/**
 * Browser half of connecting an MCP client (claude.ai) over OAuth.
 *
 *   claude.ai -> /api/auth/oauth2/authorize
 *             -> /oauth/login     (no session: sign in through the app's /login)
 *             -> /oauth/consent   (this page: Allow / Deny)
 *             -> https://claude.ai/api/mcp/auth_callback?code=…
 *
 * Login reuses the app's own sign-in page: after it, `/login?next=` replays
 * the authorize request, which now finds a session and moves on to consent.
 */
export async function handleOAuthPages(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/oauth/login") return login(url, env);
  return consent(request, url, env, auth);
}

/** Signed-query bookkeeping Better Auth adds to the authorize parameters. */
const SIGNED_QUERY_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

function login(url: URL, env: Env): Response {
  const query = new URLSearchParams(url.search);
  for (const key of SIGNED_QUERY_PARAMS) query.delete(key);
  // `prompt=login` is satisfied by signing in now; keeping it would loop.
  const prompt = (query.get("prompt") ?? "").split(" ").filter((value) => value && value !== "login");
  if (prompt.length) query.set("prompt", prompt.join(" "));
  else query.delete("prompt");

  const next = `/api/auth/oauth2/authorize?${query}`;
  return Response.redirect(`${env.APP_URL}/login?next=${encodeURIComponent(next)}`, 302);
}

async function consent(request: Request, url: URL, env: Env, auth: Auth): Promise<Response> {
  const isPost = request.method.toUpperCase() === "POST";

  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    session = null;
  }
  if (!session) {
    if (isPost) return page("Cannot continue", "Your session ended. Connect again from Claude.", 401);
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(`${env.APP_URL}/login?next=${encodeURIComponent(next)}`, 302);
  }

  if (isPost) {
    const origin = request.headers.get("origin");
    if (origin && origin !== env.APP_URL) {
      return page("Cannot continue", "Cross-origin request refused.", 403);
    }
    const form = await request.formData().catch(() => null);
    const oauthQuery = form?.get("oauth_query");
    if (typeof oauthQuery !== "string" || !oauthQuery) {
      return page("Cannot continue", "The form was not readable.", 400);
    }
    // Through the handler, not auth.api: authorize needs a real request.
    const response = await auth.handler(
      new Request(`${env.APP_URL}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: env.APP_URL,
          cookie: request.headers.get("cookie") ?? "",
        },
        body: JSON.stringify({ accept: form?.get("accept") === "yes", oauth_query: oauthQuery }),
      }),
    );
    const result = (await response.json().catch(() => ({}))) as {
      url?: string;
      redirect_uri?: string;
      error_description?: string;
      message?: string;
    };
    const target = result.url ?? result.redirect_uri;
    if (!response.ok || !target) {
      console.error("shelf: oauth consent failed", response.status, result);
      const reason = result.error_description ?? result.message ?? "The request was refused.";
      return page("Cannot continue", `<p class="lede">${escapeHtml(reason)}</p>`, 400);
    }
    return Response.redirect(target, 302);
  }

  const clientId = url.searchParams.get("client_id") ?? "";
  let clientName = "An app";
  try {
    const client = (await auth.api.getOAuthClientPublic({
      query: { client_id: clientId },
      headers: request.headers,
    })) as { client_name?: string };
    if (client.client_name) clientName = client.client_name;
  } catch {
    return page("Cannot continue", "That app is not registered with this shelf.", 400);
  }

  let returnsTo = "";
  try {
    returnsTo = new URL(url.searchParams.get("redirect_uri") ?? "").host;
  } catch {
    returnsTo = "";
  }

  // Everything the authorize step signed goes back as `oauth_query`.
  const oauthQuery = url.search.replace(/^\?/, "");
  const body = `
    <p class="lede"><strong>${escapeHtml(clientName)}</strong> wants to list, read and write
    the files on your shelf. What it writes is filed under the machine <code>${MCP_MACHINE_ID}</code>.</p>
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}" />
      <button type="submit" name="accept" value="yes">Allow</button>
      <button type="submit" name="accept" value="no" class="secondary">Deny</button>
    </form>
    <p class="fine">Signed in as ${escapeHtml(session.user.email)}.${
      returnsTo ? ` You will be sent back to <strong>${escapeHtml(returnsTo)}</strong>.` : ""
    }</p>
  `;
  return page("Connect to your shelf", body, 200);
}
