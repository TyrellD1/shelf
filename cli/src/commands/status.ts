import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { createApi } from "../lib/api.js";
import { loadConfig, shelfHome, UserError } from "../lib/config.js";
import type { Output } from "../lib/output.js";
import { loadIndexOrRebuild, machines, pendingPush } from "../lib/store.js";
import { sanitizeHostname } from "./setup.js";
import { hostname } from "node:os";
import { shelfBinaryPath } from "../lib/launch.js";

export async function statusCommand(args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  const index = loadIndexOrRebuild();
  const machineId = config?.machineId ?? sanitizeHostname(hostname());
  const entries = Object.values(index.entries);
  const pending = config ? pendingPush(index, machineId).length : 0;

  let remoteReachable: boolean | null = null;
  if (config?.token && flagBool(args, "--check")) {
    try {
      await createApi(config.apiUrl, config.token).health();
      remoteReachable = true;
    } catch {
      remoteReachable = false;
    }
  }

  const payload = {
    ok: true,
    configured: Boolean(config?.token),
    apiUrl: config?.apiUrl ?? null,
    user: config?.user ?? null,
    machineId: config?.machineId ?? null,
    fileCount: entries.length,
    localCount: entries.filter((entry) => entry.machineId === machineId).length,
    pending,
    lastSyncAt: index.lastSyncAt,
    machines: machines(index),
    home: shelfHome(),
    cliPath: shelfBinaryPath(),
    cliVersion: SHELF_VERSION,
    remoteReachable,
    error: config?.token ? undefined : "run shelf setup",
  };

  const human = [
    `home:      ${payload.home}`,
    `cli:       ${payload.cliVersion} (${payload.cliPath})`,
    `account:   ${config?.user?.email ?? "not signed in"}`,
    `api:       ${config?.apiUrl ?? "not configured"}`,
    `machine:   ${payload.machineId ?? "not set"}`,
    `files:     ${payload.fileCount} on this device (${payload.localCount} from ${payload.machineId})`,
    `pending:   ${payload.pending} to push`,
    `last sync: ${payload.lastSyncAt ? new Date(payload.lastSyncAt).toLocaleString() : "never"}`,
    ...(payload.machines.length
      ? [
          "machines:",
          ...payload.machines.map(
            (machine) => `  ${machine.machineId.padEnd(16)} ${machine.count} file(s)`,
          ),
        ]
      : []),
  ].join("\n");

  output.emit(payload, human);
}

export async function machineCommand(args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  if (!config) throw new UserError("not set up yet", "not_configured", "run: shelf setup");
  const index = loadIndexOrRebuild();
  const action = args.positional[0];
  const value = args.positional[1] ?? args.positional[0];

  if (action === "set") {
    const { isValidMachineId } = await import("@shelf/shared");
    if (!value || !isValidMachineId(value)) {
      throw new UserError(
        `invalid machine id: ${value ?? "(missing)"}`,
        "bad_machine_id",
        "lowercase letters, digits and dashes",
      );
    }
    const { saveConfig } = await import("../lib/config.js");
    saveConfig({ ...config, machineId: value });
    output.emit({ ok: true, machineId: value }, `machine id is now ${value}`);
    return;
  }

  output.emit(
    {
      ok: true,
      machineId: config.machineId,
      hostname: sanitizeHostname(hostname()),
      machines: machines(index),
    },
    [`machine id: ${config.machineId}`, `hostname:   ${sanitizeHostname(hostname())}`].join("\n"),
  );
}

export async function logoutCommand(_args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  if (!config) throw new UserError("not set up yet", "not_configured");
  const { saveConfig } = await import("../lib/config.js");
  saveConfig({ ...config, token: "", user: null });
  output.emit(
    { ok: true, apiUrl: config.apiUrl, machineId: config.machineId },
    `signed out of ${config.apiUrl}\nLocal files are untouched. Run shelf setup to authorize again (it rotates this machine's key).`,
  );
}
