import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Kysely } from "kysely";
import type { Database } from "./db.js";
import { isAllowedEmail, type AuthEnv } from "./env.js";

/**
 * One user, one shelf. Email + password sign-in, sessions in Postgres, and an
 * `x-api-key` credential that the CLI uses forever (api keys never expire by
 * default: `keyExpiration.defaultExpiresIn` is `null`).
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
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
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
