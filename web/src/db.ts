import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { databaseUrl, type Env } from "./env.js";

export interface ShelfFilesTable {
  user_id: string;
  id: string;
  machine_id: string;
  path_on_machine: string;
  html: string;
  sha256: string;
  created_at: Date;
  edited_at: Date;
}

/** Better Auth's table of registered OAuth clients; only what `mcp.ts` reads. */
export interface OAuthClientTable {
  clientId: string;
  name: string | null;
}

export interface Database {
  shelf_files: ShelfFilesTable;
  oauthClient: OAuthClientTable;
}

/**
 * `pg` speaks the Postgres wire protocol to Neon's pooler in production and
 * to the local Postgres in development.
 */
export function createPool(env: Pick<Env, "DATABASE_URL">): Pool {
  return new Pool({
    connectionString: databaseUrl(env),
    max: 4,
    idleTimeoutMillis: 5_000,
  });
}

export function createDb(
  env: Pick<Env, "DATABASE_URL">,
  pool: Pool = createPool(env),
): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
