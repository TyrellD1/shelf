import { route, type Services } from "./app.js";
import { createAuth } from "./auth.js";
import { createDb } from "./db.js";
import type { Env } from "./env.js";

type WorkerEnv = Env & { ASSETS: Fetcher };

/**
 * Cloudflare Workers host, used by `wrangler dev` for local work. Production runs
 * on Vercel (`vercel.ts`). A Worker cannot share a socket between requests, so the
 * pool and the auth instance are built per request, on first use.
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    let services: Services | undefined;
    const response = await route(request, env, () => {
      if (!services) {
        const db = createDb(env);
        services = { db, auth: createAuth(env, db) };
      }
      return services;
    });
    return response ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
