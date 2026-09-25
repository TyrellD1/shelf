import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isValidMachineId, MACHINE_ID_RE } from "@shelf/shared";
import { createApi } from "../lib/api.js";
import {
  apiUrlFromEnv,
  ensureHome,
  loadConfig,
  saveConfig,
  UserError,
  type ShelfConfig,
} from "../lib/config.js";
import { flagBool, flagString, type ParsedArgs } from "../lib/flags.js";
import { openUrl } from "../lib/launch.js";
import type { Output } from "../lib/output.js";
import { ask, isInteractive } from "../lib/prompt.js";

interface CallbackResult {
  token: string;
  api?: string;
  email?: string;
}

export async function setupCommand(args: ParsedArgs, output: Output): Promise<void> {
  ensureHome();
  const existing = loadConfig();
  const apiFlag = flagString(args, "--api");
  const apiUrl = (apiFlag ?? apiUrlFromEnv() ?? existing?.apiUrl ?? "").replace(/\/+$/, "");
  if (!apiUrl) {
    throw new UserError(
      "no API URL configured",
      "no_api_url",
      "pass --api https://your-shelf.workers.dev (or set SHELF_API_URL)",
    );
  }

  await assertReachable(apiUrl, output);

  const clientId = flagString(args, "--client") ?? existing?.clientId ?? randomUUID();
  const label = flagString(args, "--label") ?? defaultLabel();
  const state = randomBytes(16).toString("hex");

  const listener = await startCallbackServer(state);
  const authUrl = `${apiUrl}/cli?port=${listener.port}&state=${state}&client=${encodeURIComponent(clientId)}&label=${encodeURIComponent(label)}`;

  output.human(`Authorize this machine in the browser:\n  ${authUrl}\n`);
  output.progress("waiting for browser authorization…");
  if (flagBool(args, "--no-open") || process.env.SHELF_NO_BROWSER === "1") {
    output.warn("open the URL above in a browser to finish");
  } else {
    try {
      await openUrl(authUrl);
    } catch {
      output.warn("could not open a browser automatically — open the URL above");
    }
  }

  const callback = await listener.wait();

  const config: ShelfConfig = {
    version: 1,
    apiUrl: (callback.api ?? apiUrl).replace(/\/+$/, ""),
    token: callback.token,
    clientId,
    machineId: existing?.machineId ?? "",
    user: null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  const api = createApi(config.apiUrl, config.token);
  const me = await api.me();
  config.user = { id: me.user.id, email: me.user.email };
  config.machineId = await resolveMachineId(args, existing?.machineId, output);

  saveConfig(config);

  output.emit(
    {
      ok: true,
      apiUrl: config.apiUrl,
      user: config.user,
      machineId: config.machineId,
      fileCount: me.fileCount,
      machines: me.machines,
    },
    `Authorized as ${config.user.email}\nMachine id: ${config.machineId}\nWrite something with: shelf write ./report.html`,
  );
}

async function assertReachable(apiUrl: string, output: Output): Promise<void> {
  const api = createApi(apiUrl, "");
  try {
    await api.health();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`cannot reach ${apiUrl} (${message})`, "unreachable", "check the URL and your network");
  }
  output.progress(`reachable: ${apiUrl}`);
}

async function resolveMachineId(
  args: ParsedArgs,
  existing: string | undefined,
  output: Output,
): Promise<string> {
  const flag = flagString(args, "--machine");
  if (flag) {
    if (!isValidMachineId(flag)) {
      throw new UserError(
        `invalid machine id "${flag}"`,
        "bad_machine_id",
        "lowercase letters, digits and dashes, up to 63 characters",
      );
    }
    return flag;
  }

  const fallback = existing ?? sanitizeHostname(hostname());
  if (!isInteractive()) {
    output.progress(`machine id: ${fallback} (pass --machine to override)`);
    return fallback;
  }

  const answer = await ask(`Machine id for this computer [${fallback}]: `);
  const chosen = answer.trim() || fallback;
  if (!isValidMachineId(chosen)) {
    throw new UserError(
      `"${chosen}" is not a valid machine id`,
      "bad_machine_id",
      `must match ${MACHINE_ID_RE.source} — try "macbook-pro"`,
    );
  }
  return chosen;
}

export function sanitizeHostname(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return cleaned || "machine";
}

function defaultLabel(): string {
  return hostname().replace(/\.local$/, "");
}

interface CallbackServer {
  port: number;
  wait(): Promise<CallbackResult>;
}

async function startCallbackServer(state: string): Promise<CallbackServer> {
  const timeoutMs = 5 * 60 * 1000;
  let server: Server | null = null;

  const wait = new Promise<CallbackResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      server?.close();
      reject(
        new UserError(
          "timed out waiting for the browser to authorize",
          "timeout",
          "re-run shelf setup",
        ),
      );
    }, timeoutMs);

    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      const gotState = url.searchParams.get("state") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const email = url.searchParams.get("email") ?? undefined;
      const api = url.searchParams.get("api") ?? undefined;

      const ok = gotState === state && token.length > 0;
      response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      response.end(ok ? DONE_PAGE : ERROR_PAGE);
      if (!ok) return;

      clearTimeout(timer);
      server?.close();
      resolve({ token, email, api });
    });

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    process.on("SIGINT", () => {
      clearTimeout(timer);
      server?.close();
      reject(new UserError("cancelled", "cancelled"));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("could not bind a loopback port"));
    });
  });

  return { port, wait: () => wait };
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Shelf</title>
<body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:16px">Shelf CLI authorized</h1>
<p style="color:#6b6b6b">You can close this tab and go back to your terminal.</p></div>`;

const ERROR_PAGE = `<!doctype html><meta charset="utf-8"><title>Shelf</title>
<body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:16px">Authorization failed</h1>
<p style="color:#6b6b6b">Run <code>shelf setup</code> again in your terminal.</p></div>`;
