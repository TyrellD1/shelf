import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import type { Kysely } from "kysely";
import { handleApi } from "./api.js";
import { API_KEY_HEADER, type Auth } from "./auth.js";
import { handleCliAuth } from "./cli-auth.js";
import type { Database } from "./db.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import { handleOAuthPages } from "./oauth-pages.js";

export interface Services {
  auth: Auth;
  db: Kysely<Database>;
}

/**
 * OAuth discovery for MCP clients. The issuer is `<APP_URL>/api/auth`, so
 * RFC 8414 puts its metadata at `/.well-known/<kind>/api/auth`; the bare
 * forms are served too for clients that only probe the origin.
 */
const AUTH_SERVER_METADATA = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]);
const OPENID_METADATA = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/auth",
  "/api/auth/.well-known/openid-configuration",
]);

/**
 * Every route the server answers itself, for either host (`vercel.ts`, `scripts/dev.ts`).
 * Returns `null` for anything else, which the host serves from the built UI.
 * `services` is a thunk so a host can decide how long a pool and an auth instance live.
 */
export async function route(
  request: Request,
  env: Env,
  services: () => Services,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;

  try {
    if (path === "/api/health") {
      const { auth, db } = services();
      return await handleApi(request, env, auth, db);
    }

    if (path === "/mcp") {
      const { auth, db } = services();
      return await handleMcp(request, env, auth, db);
    }

    if (AUTH_SERVER_METADATA.has(path)) {
      return await oauthProviderAuthServerMetadata(services().auth)(request);
    }
    if (OPENID_METADATA.has(path)) {
      return await oauthProviderOpenIdConfigMetadata(services().auth)(request);
    }
    // Protected resource metadata (RFC 9728), served by the mcp() plugin.
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return await services().auth.handler(request);
    }

    if (path === "/oauth/login" || path === "/oauth/consent") {
      return await handleOAuthPages(request, env, services().auth);
    }

    if (path.startsWith("/api/auth")) {
      // Auth routes (sessions, key management) belong to the browser. An API
      // key that reached them could mint a broader key than it was given.
      if (request.headers.has(API_KEY_HEADER)) {
        return new Response(
          JSON.stringify({ error: "forbidden", message: "API keys cannot manage auth." }),
          { status: 403, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
      return await services().auth.handler(request);
    }

    if (path.startsWith("/api/")) {
      const { auth, db } = services();
      return await handleApi(request, env, auth, db);
    }

    if (path === "/cli" || path === "/cli/authorize") {
      return await handleCliAuth(request, env, services().auth);
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("shelf: unhandled error", message);
    return new Response(JSON.stringify({ error: "server_error", message }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
