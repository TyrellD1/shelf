import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type { Kysely } from "kysely";
import { scopeFromPermissions, type KeyScope } from "@shelf/shared";
import type { Database } from "./db.js";
import { isAllowedEmail, type AuthEnv } from "./env.js";

/**
 * One user, one shelf. Email + password sign-in, sessions in Postgres, and an
 * `x-api-key` credential that the CLI uses forever (api keys never expire by
 * default: `keyExpiration.defaultExpiresIn` is `null`).
 *
 * It is also the OAuth server for the MCP endpoint (`mcp.ts`): claude.ai
 * registers itself, sends you through /oauth/login and /oauth/consent
 * (`oauth-pages.ts`), and gets a JWT bound to `<APP_URL>/mcp`.
 */
export function createAuth(env: AuthEnv, db: Kysely<Database>) {
  return betterAuth({
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: { db, type: "postgres" },
    trustedOrigins: trustedOrigins(env.APP_URL),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 90,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      apiKey({
        // Lets a request authenticated with x-api-key resolve to a session.
        enableSessionForAPIKeys: true,
        // `metadata` records which CLI install (clientId) owns a key so a
        // repeat `shelf setup` can rotate it instead of piling up keys.
        enableMetadata: true,
        // The plugin defaults to 10 requests per day per key, which is nothing
        // for a client that pushes every file it writes. This is a single-user
        // tool with one long-lived key per machine; the allowlist is the guard.
        rateLimit: { enabled: false },
      }),
      // Signs the MCP access tokens; the keys live in the `jwks` table.
      jwt(),
      mcp({
        resource: mcpResource(env.APP_URL),
        loginPage: "/oauth/login",
        consentPage: "/oauth/consent",
        // claude.ai registers a client per connection (RFC 7591). Who may
        // register is narrowed to Claude's callbacks in the hook below, and
        // a token still needs your password and an explicit consent.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // `/mcp` is the only resource here. A client that leaves out RFC 8707's
        // `resource` would get an opaque token `/mcp` cannot verify; bind it.
        if (ctx.path === "/oauth2/authorize" && ctx.query && !ctx.query.resource) {
          return { context: { query: { ...ctx.query, resource: mcpResource(env.APP_URL) } } };
        }
        if (ctx.path === "/oauth2/token" && ctx.body && !ctx.body.resource) {
          return { context: { body: { ...ctx.body, resource: mcpResource(env.APP_URL) } } };
        }
        if (ctx.path === "/oauth2/register") {
          const uris = (ctx.body as { redirect_uris?: unknown } | undefined)?.redirect_uris;
          if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAllowedRedirectUri)) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_redirect_uri",
              error_description: "This shelf only connects to Claude.",
            });
          }
          return;
        }
        if (ctx.path !== "/sign-up/email" && ctx.path !== "/sign-in/email") return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== "string") return;
        if (!isAllowedEmail(env, email)) {
          throw new APIError("FORBIDDEN", {
            message: "This shelf is private. That address is not allowed.",
          });
        }
      }),
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The MCP endpoint's URL: the OAuth `resource` its tokens are bound to. */
export function mcpResource(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/mcp`;
}

/** Hosted Claude apps use one callback; Claude Code uses a loopback port. */
const CLAUDE_CALLBACKS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

export function isAllowedRedirectUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (CLAUDE_CALLBACKS.has(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function trustedOrigins(appUrl: string): string[] {
  const origins = new Set<string>([appUrl]);
  try {
    const url = new URL(appUrl);
    if (url.hostname === "localhost") origins.add(`${url.protocol}//127.0.0.1:${url.port}`);
    if (url.hostname === "127.0.0.1") origins.add(`${url.protocol}//localhost:${url.port}`);
    // Local development: the Vite dev server that hosts the same UI.
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      origins.add(`${url.protocol}//127.0.0.1:1420`);
      origins.add(`${url.protocol}//localhost:1420`);
    }
  } catch {
    // ignore malformed APP_URL
  }
  return [...origins];
}

/** The header the api-key plugin reads; also how a request is told apart from a browser. */
export const API_KEY_HEADER = "x-api-key";

/**
 * What the request's credential may do. A browser session is `full`; an API key
 * carries the scope it was minted with. `null` when the key does not verify.
 */
export async function credentialScope(auth: Auth, headers: Headers): Promise<KeyScope | null> {
  const key = headers.get(API_KEY_HEADER);
  if (!key) return "full";
  const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
  if (!result?.valid || !result.key) return null;
  return scopeFromPermissions(result.key.permissions);
}

/**
 * The same headers without an API key, so only a browser cookie can resolve a
 * session. Used wherever a session can mint or manage keys: a key must never be
 * able to issue itself a broader one.
 */
export function browserOnly(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete(API_KEY_HEADER);
  return copy;
}
