import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { handleApi } from "./api.js";
import { createAuth } from "./auth.js";
import { handleCliAuth } from "./cli-auth.js";
import { createDb } from "./db.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import { handleOAuthPages } from "./oauth-pages.js";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        const db = createDb(env);
        return handleApi(request, env, createAuth(env, db), db);
      }

      if (path === "/mcp") {
        const db = createDb(env);
        return await handleMcp(request, env, createAuth(env, db), db);
      }

      if (AUTH_SERVER_METADATA.has(path)) {
        return await oauthProviderAuthServerMetadata(createAuth(env, createDb(env)))(request);
      }
      if (OPENID_METADATA.has(path)) {
        return await oauthProviderOpenIdConfigMetadata(createAuth(env, createDb(env)))(request);
      }
      // Protected resource metadata (RFC 9728), served by the mcp() plugin.
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return await createAuth(env, createDb(env)).handler(request);
      }

      if (path === "/oauth/login" || path === "/oauth/consent") {
        const db = createDb(env);
        return await handleOAuthPages(request, env, createAuth(env, db));
      }

      if (path.startsWith("/api/auth")) {
        return createAuth(env, createDb(env)).handler(request);
      }

      if (path.startsWith("/api/")) {
        const db = createDb(env);
        return await handleApi(request, env, createAuth(env, db), db);
      }

      if (path === "/cli" || path === "/cli/authorize") {
        const db = createDb(env);
        return await handleCliAuth(request, env, createAuth(env, db));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("shelf: unhandled error", message);
      return new Response(JSON.stringify({ error: "server_error", message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
