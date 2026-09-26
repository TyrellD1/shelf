import type { ShelfFile, ShelfFileMeta, ListResponse, MeResponse, SortKey } from "@shelf/shared";
import { currentTheme, injectTheme } from "./theme.js";

export interface SyncResult {
  configured: boolean;
  pushed: number;
  pulled: number;
  skipped: number;
  errors: string[];
  lastSyncAt: string | null;
}

export interface StatusInfo {
  configured: boolean;
  apiUrl: string | null;
  machineId: string | null;
  lastSyncAt: string | null;
  fileCount: number;
  pending: number;
  user: { id: string; email: string } | null;
  machines: { machineId: string; count: number; latestAt: string }[];
  cliPath?: string | null;
  cliVersion?: string | null;
  remoteReachable?: boolean;
  error?: string;
}

export interface ListOptions {
  q?: string;
  machine?: string;
  limit?: number;
  offset?: number;
  sort?: SortKey;
  dir?: "asc" | "desc";
}

export interface OpenEvent {
  id: string;
  path?: string;
}

export interface DataAdapter {
  kind: "local" | "network";
  status(): Promise<StatusInfo>;
  list(options: ListOptions): Promise<ListResponse>;
  me(): Promise<MeResponse | null>;
  /** Metadata for one file (used by the reader bar and deep links). */
  get(id: string): Promise<ShelfFileMeta | ShelfFile | null>;
  /** Pull remote changes (local) — a no-op for the PWA. */
  sync(onProgress?: (message: string) => void): Promise<SyncResult>;
  /** Where the reader iframe should point. */
  readerSource(file: ShelfFileMeta): Promise<string>;
  releaseReaderSource?(source: string): void;
  /**
   * Hands the document to the user's own browser, which the app cannot do
   * itself: the desktop opens the shelf's file on disk through the CLI, the PWA
   * opens the page it already built as a blob.
   */
  openExternal(file: ShelfFileMeta, source: string | null): Promise<void>;
  signIn?(email: string, password: string): Promise<void>;
  signOut?(): Promise<void>;
  /** Runs `shelf setup` (opens the browser) from inside the desktop app. */
  setup?(): Promise<StatusInfo>;
  onOpen?(handler: (event: OpenEvent) => void): void;
  /** A `shelf open` deep link that arrived before the UI was ready. */
  pendingOpen?(): Promise<OpenEvent | null>;
  appUrl?(): string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Desktop: every read goes through the CLI, which owns the local store.
// ---------------------------------------------------------------------------

export function createLocalAdapter(): DataAdapter {
  const run = async <T>(args: string[]): Promise<T> => {
    const payload = await invoke<{ ok?: boolean; error?: string } & T>("shelf_run", { args });
    return payload;
  };

  const adapter: DataAdapter = {
    kind: "local",

    async status() {
      try {
        return await run<StatusInfo>(["status", "--json"]);
      } catch (error) {
        return {
          configured: false,
          apiUrl: null,
          machineId: null,
          lastSyncAt: null,
          fileCount: 0,
          pending: 0,
          user: null,
          machines: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    list(options) {
      const args = ["list", "--json", `--limit=${options.limit ?? 1000}`];
      if (options.offset) args.push(`--offset=${options.offset}`);
      if (options.q) args.push(`--search=${options.q}`);
      if (options.machine) args.push(`--machine=${options.machine}`);
      if (options.sort) args.push(`--sort=${options.sort}`);
      if (options.dir) args.push(`--dir=${options.dir}`);
      return run<ListResponse>(args);
    },

    async get(id) {
      const payload = await run<{ file: ShelfFileMeta }>(["read", id, "--json", "--meta"]);
      return payload.file ?? null;
    },

    me() {
      return adapter.status().then((status) => {
        if (!status.configured || !status.user) return null;
        return {
          user: { id: status.user.id, email: status.user.email, name: null },
          machines: status.machines,
          fileCount: status.fileCount,
          appUrl: status.apiUrl ?? "",
        };
      });
    },

    sync(onProgress) {
      return invoke<SyncResult>("shelf_sync", { onProgress: Boolean(onProgress) });
    },

    async readerSource(file) {
      return `shelf://localhost/view/${encodeURIComponent(file.id)}?theme=${currentTheme()}`;
    },

    async openExternal(file) {
      // The CLI owns the store, so it resolves the file and hands it to macOS;
      // `shelf://` URLs mean nothing to a browser and blobs do not exist here.
      await run(["reveal", file.path, "--json"]);
    },

    async setup() {
      await invoke<string>("shelf_setup");
      return adapter.status();
    },

    onOpen(handler) {
      void (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        await listen<OpenEvent>("shelf:open", (event) => handler(event.payload));
      })();
    },

    pendingOpen() {
      return invoke<OpenEvent | null>("shelf_pending_open").catch(() => null);
    },

    appUrl() {
      return "";
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// PWA: same UI, everything read over the network.
// ---------------------------------------------------------------------------

export function createNetworkAdapter(): DataAdapter {
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        // keep the status text
      }
      throw new ApiError(response.status, message);
    }
    return (await response.json()) as T;
  };

  return {
    kind: "network",

    async status() {
      const me = await this.me();
      return {
        configured: me !== null,
        apiUrl: location.origin,
        machineId: null,
        lastSyncAt: null,
        fileCount: me?.fileCount ?? 0,
        pending: 0,
        user: me ? { id: me.user.id, email: me.user.email } : null,
        machines: me?.machines ?? [],
      };
    },

    list(options) {
      const params = new URLSearchParams();
      params.set("limit", String(options.limit ?? 20));
      if (options.offset) params.set("offset", String(options.offset));
      if (options.q) params.set("q", options.q);
      if (options.machine) params.set("machine", options.machine);
      params.set("sort", options.sort === "edited" ? "edited" : "created");
      params.set("dir", options.dir ?? "desc");
      return api<ListResponse>(`/api/files?${params.toString()}`);
    },

    async get(id) {
      return api<ShelfFile>(`/api/files/${encodeURIComponent(id)}`);
    },

    async me() {
      try {
        return await api<MeResponse>("/api/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },

    async sync() {
      return { configured: true, pushed: 0, pulled: 0, skipped: 0, errors: [], lastSyncAt: null };
    },

    async readerSource(file) {
      const record = await api<ShelfFile>(`/api/files/${encodeURIComponent(file.id)}`);
      const blob = new Blob([injectTheme(record.html, currentTheme())], { type: "text/html" });
      return URL.createObjectURL(blob);
    },

    releaseReaderSource(source) {
      if (source.startsWith("blob:")) URL.revokeObjectURL(source);
    },

    async openExternal(_file, source) {
      if (source) window.open(source, "_blank", "noopener");
    },

    async signIn(email, password) {
      await api("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
    },

    async signOut() {
      await api("/api/auth/sign-out", { method: "POST", body: JSON.stringify({}) });
    },

    appUrl() {
      return location.origin;
    },
  };
}

export function createAdapter(): DataAdapter {
  return isTauri() ? createLocalAdapter() : createNetworkAdapter();
}
