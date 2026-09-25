import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { UserError } from "../lib/config.js";
import type { Output } from "../lib/output.js";
import { toMeta, writeToShelf } from "../lib/writer.js";

export async function writeCommand(args: ParsedArgs, output: Output): Promise<void> {
  const input = args.positional[0];
  if (!input) {
    throw new UserError("usage: shelf write <path.html>", "usage", "shelf write ./report.html");
  }

  const outcome = await writeToShelf({
    inputPath: input,
    replace: flagBool(args, "--replace"),
    asNew: flagBool(args, "--as-new") || flagBool(args, "--force"),
    push: !flagBool(args, "--no-push"),
    output,
  });

  for (const warning of outcome.warnings) output.warn(warning);

  const human = {
    created: `wrote ${outcome.path}`,
    versioned: `wrote ${outcome.path} (new version)`,
    replaced: `replaced ${outcome.path}`,
    unchanged: `${outcome.path} is already up to date`,
  }[outcome.action];

  output.emit(
    {
      ok: true,
      action: outcome.action,
      path: outcome.path,
      requestedPath: outcome.requestedPath,
      file: toMeta(outcome.entry),
      pushed: outcome.pushed,
      ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
    },
    `${human}${outcome.pushed ? " · synced" : ""}`,
  );
}
