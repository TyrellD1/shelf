/** Tiny flag parser: `--flag`, `--flag=value`, and `--flag value` for known value flags. */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "--api",
  "--machine",
  "--limit",
  "--offset",
  "--search",
  "--sort",
  "--dir",
  "--label",
  "--path",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(0, eq)] = token.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(token) && argv[index + 1] && !argv[index + 1].startsWith("-")) {
      flags[token] = argv[++index];
      continue;
    }
    flags[token] = true;
  }

  return { positional, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true" || args.flags[name] === "1";
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = flagString(args, name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
