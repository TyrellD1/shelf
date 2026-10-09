/** Env needed to build Better Auth (used by both the server and Node scripts). */
export interface AuthEnv {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  ALLOWED_EMAILS?: string;
}

export interface Env extends AuthEnv {
  /** Production (Neon's pooled URL) and local development: a plain Postgres URL. */
  DATABASE_URL?: string;
  SEED_EMAIL?: string;
  SEED_PASSWORD?: string;
  SEED_NAME?: string;
  /** Discord webhook told about every new file. Unset: no notifications. */
  DISCORD_WEBHOOK_URL?: string;
}

export function databaseUrl(env: Pick<Env, "DATABASE_URL">): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "no database configured: set DATABASE_URL (see web/.dev.vars.example)",
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
