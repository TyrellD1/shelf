import { handleApi } from "./api.js";
import { API_KEY_HEADER, createAuth } from "./auth.js";
import { handleCliAuth } from "./cli-auth.js";
import { createDb } from "./db.js";
import type { Env } from "./env.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        const db = createDb(env);
        return handleApi(request, env, createAuth(env, db), db);
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
