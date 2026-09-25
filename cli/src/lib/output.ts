/** Output channel: human text, or one JSON document on stdout for agents. */

export interface Output {
  json: boolean;
  stream: boolean;
  /** Final result. In JSON mode this is the single object printed to stdout. */
  emit(data: Record<string, unknown>, human?: string): void;
  progress(message: string): void;
  human(line: string): void;
  warn(message: string): void;
}

export function createOutput(options: { json: boolean; stream: boolean }): Output {
  const { json, stream } = options;
  return {
    json,
    stream,
    emit(data, human) {
      if (json) {
        if (stream) {
          process.stdout.write(`${JSON.stringify({ type: "result", ...data })}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        }
        return;
      }
      if (human) process.stdout.write(`${human}\n`);
    },
    progress(message) {
      if (json) {
        if (stream) process.stdout.write(`${JSON.stringify({ type: "progress", message })}\n`);
        else process.stderr.write(`${message}\n`);
        return;
      }
      process.stderr.write(`${message}\n`);
    },
    human(line) {
      if (!json) process.stdout.write(`${line}\n`);
    },
    warn(message) {
      process.stderr.write(`shelf: ${message}\n`);
    },
  };
}

export function fail(error: unknown, json: boolean, code = 1): never {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: string }).code ?? "error")
      : "error";
  const hint =
    typeof error === "object" && error !== null && "hint" in error
      ? ((error as { hint?: string }).hint ?? undefined)
      : undefined;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: message, code: errorCode, ...(hint ? { hint } : {}) })}\n`,
    );
  } else {
    process.stderr.write(`shelf: ${message}\n`);
    if (hint) process.stderr.write(`  hint: ${hint}\n`);
  }
  process.exit(code);
}
