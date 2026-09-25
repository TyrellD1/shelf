import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import { createAuth } from "../src/auth.js";
import { createDb } from "../src/db.js";
import { loadEnv } from "./env.js";

/** Applies Better Auth's schema plus the SQL files in web/migrations, in order. */
const env = loadEnv();
const db = createDb(env);
const auth = createAuth(env, db);

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  console.log(
    `better-auth: ${toBeCreated.length} table(s) to create, ${toBeAdded.length} column(s) to add`,
  );
}
await runMigrations();
console.log("better-auth: schema up to date");

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
  const contents = readFileSync(join(migrationsDir, file), "utf8");
  await sql.raw(contents).execute(db);
  console.log(`applied ${file}`);
}

await db.destroy();
