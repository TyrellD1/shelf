import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { loadConfig, requireConfig, requireFullScope, UserError } from "../lib/config.js";
import type { Output } from "../lib/output.js";
import { familyOf, loadIndex } from "../lib/store.js";
import { toMeta, writeToShelf } from "../lib/writer.js";
import { fileUrl, versionNumber } from "@shelf/shared";

export async function writeCommand(args: ParsedArgs, output: Output): Promise<void> {
  const input = args.positional[0];
  if (!input) {
    throw new UserError("usage: shelf write <path.html>", "usage", "shelf write ./report.html");
  }

  const replace = flagBool(args, "--replace");
  if (replace) requireFullScope(requireConfig(), "--replace");

  const outcome = await writeToShelf({
    inputPath: input,
    replace,
    asNew: flagBool(args, "--as-new") || flagBool(args, "--force"),
    push: !flagBool(args, "--no-push"),
    output,
  });

  for (const warning of outcome.warnings) output.warn(warning);

  // An agent appends a version by writing the same path again; say which one this is.
  const version = versionNumber(outcome.path);
  const versions = familyOf(loadIndex(), outcome.entry).length || 1;

  const human = {
    created: `wrote ${outcome.path}`,
    versioned: `wrote ${outcome.path} (new version, v${version})`,
    replaced: `replaced ${outcome.path}`,
    unchanged: `${outcome.path} is already up to date`,
  }[outcome.action];

  // The link works once the file is pushed; a --no-push write still gets it for later.
  const config = loadConfig();
  const url = config ? fileUrl(config.apiUrl, outcome.entry.id) : null;

  output.emit(
    {
      ok: true,
      action: outcome.action,
      path: outcome.path,
      requestedPath: outcome.requestedPath,
      version,
      versions,
      file: toMeta(outcome.entry),
      pushed: outcome.pushed,
      url,
      ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
    },
    `${human}${outcome.pushed ? " · synced" : ""}${url ? `\n${url}` : ""}`,
  );
}
