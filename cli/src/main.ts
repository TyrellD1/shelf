import { readCommand, listCommand } from "./commands/list.js";
import { openCommand } from "./commands/open.js";
import { setupCommand } from "./commands/setup.js";
import { machineCommand, logoutCommand, statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { writeCommand } from "./commands/write.js";
import { UserError } from "./lib/config.js";
import { flagBool, parseArgs } from "./lib/flags.js";
import { createOutput, fail, type Output } from "./lib/output.js";
import { VERSION } from "./lib/version.js";

const HELP = `shelf ${VERSION} — a local-first shelf for HTML written by agents

usage
  shelf setup [--api <url>] [--machine <id>]   authorize this machine in the browser
  shelf write <path.html> [--replace|--as-new] write (and push) a file
  shelf open <path.html> [--browser]           write if needed, then open in the app
  shelf list [--search <q>] [--machine <id>] [--limit n] [--sort created|edited]
  shelf read <id|path> [--meta]                print a file (or its metadata)
  shelf sync [--pull-only|--push-only]         push local writes, pull other machines
  shelf status [--check]                       config, counts, sync state
  shelf machine [set <id>]                     show or change this machine's id
  shelf logout                                 drop the local token
  shelf upgrade [--check]                      update to the latest release

flags
  --json      one JSON document on stdout (for agents)
  --stream    with --json: progress lines, then a final result line
  --version, --help
`;

export async function run(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  const args = parseArgs(argv.slice(1));
  const output = createOutput({
    json: flagBool(args, "--json") || flagBool(args, "-j"),
    stream: flagBool(args, "--stream"),
  });

  switch (command) {
    case "setup":
      return setupCommand(args, output);
    case "write":
      return writeCommand(args, output);
    case "open":
      return openCommand(args, output);
    case "list":
    case "ls":
      return listCommand(args, output);
    case "read":
    case "cat":
      return readCommand(args, output);
    case "sync":
      return syncCommand(args, output);
    case "status":
      return statusCommand(args, output);
    case "machine":
    case "machines":
      return machineCommand(args, output);
    case "logout":
      return logoutCommand(args, output);
    case "upgrade":
    case "update":
      return upgradeCommand(args, output);
    case "version":
      output.emit(
        { ok: true, version: VERSION, node: process.version, platform: process.platform },
        VERSION,
      );
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-V":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      throw new UserError(`unknown command: ${command}`, "unknown_command", "shelf --help");
  }
}

export function handleFailure(error: unknown, output: Output): never {
  if (error instanceof UserError) fail(error, output.json);
  fail(error, output.json);
}

// `--json` must be honoured even when parsing failed early.
const argv = process.argv.slice(2);
const jsonRequested = argv.includes("--json") || argv.includes("-j");
const output = createOutput({ json: jsonRequested, stream: argv.includes("--stream") });
run(argv).catch((error: unknown) => handleFailure(error, output));
