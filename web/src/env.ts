export interface HyperdriveLike {
  connectionString: string;
}

/** Env needed to build Better Auth (used by both the Worker and Node scripts). */
export interface AuthEnv {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  ALLOWED_EMAILS?: string;
}

export interface Env extends AuthEnv {
  ASSETS: Fetcher;
  /** Production: Hyperdrive binding in front of Postgres. */
  HYPERDRIVE?: HyperdriveLike;
  /** Local development / fallback: a plain Postgres URL. */
  DATABASE_URL?: string;
  SEED_EMAIL?: string;
  SEED_PASSWORD?: string;
  SEED_NAME?: string;
}

export function databaseUrl(env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "no database configured: set the HYPERDRIVE binding (production) or DATABASE_URL (see web/.dev.vars.example)",
    );
  }
  return url;
}

export function allowedEmails(env: Pick<AuthEnv, "ALLOWED_EMAILS">): string[] {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Single-user shelf: anything not on the allowlist is refused. */
export function isAllowedEmail(env: Pick<AuthEnv, "ALLOWED_EMAILS">, email: string): boolean {
  const list = allowedEmails(env);
  if (list.length === 0) return true; // dev convenience; set ALLOWED_EMAILS in production
  return list.includes(email.trim().toLowerCase());
}
