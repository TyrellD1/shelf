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

export interface Database {
  shelf_files: ShelfFilesTable;
}

/**
 * One pool per request. `pg` speaks the Postgres wire protocol over Hyperdrive
 * in production and over a plain TCP connection in local dev — same code path.
 */
export function createDb(env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">): Kysely<Database> {
  const pool = new Pool({
    connectionString: databaseUrl(env),
    max: 4,
    idleTimeoutMillis: 5_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
