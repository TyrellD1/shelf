import { createAuth } from "../src/auth.js";
import { createDb } from "../src/db.js";
import { loadEnv } from "./env.js";

/**
 * Creates the single shelf account from SEED_EMAIL / SEED_PASSWORD.
 * Safe to re-run: an existing account is reported, not an error.
 */
const env = loadEnv();
const email = env.SEED_EMAIL ?? process.env.SEED_EMAIL;
const password = env.SEED_PASSWORD ?? process.env.SEED_PASSWORD;
const name = env.SEED_NAME ?? email ?? "Shelf owner";

if (!email || !password) {
  console.error("SEED_EMAIL and SEED_PASSWORD must be set (see web/.dev.vars.example).");
  process.exit(1);
}

const db = createDb(env);
const auth = createAuth(env, db);

try {
  const result = await auth.api.signUpEmail({ body: { email, password, name } });
  console.log(`created ${result.user.email} (${result.user.id})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/exist/i.test(message)) {
    console.log(`${email} already exists — nothing to do`);
  } else {
    console.error(`seed failed: ${message}`);
    process.exitCode = 1;
  }
}

await db.destroy();
