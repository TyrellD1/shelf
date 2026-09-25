import type {
  ChangesResponse,
  ListResponse,
  MeResponse,
  ShelfFile,
  ShelfFileMeta,
  WriteRequestBody,
  WriteResponse,
} from "@shelf/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get existing(): ShelfFileMeta | undefined {
    const body = this.body as { existing?: ShelfFileMeta } | undefined;
    return body?.existing;
  }
}

export interface ChangesQuery {
  since?: string | null;
  excludeMachine?: string;
  limit?: number;
}

export function createApi(apiUrl: string, token: string) {
  const base = apiUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init?.method ?? "GET",
        body: init?.body,
        headers: {
          "x-api-key": token,
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, `cannot reach ${base}: ${message}`);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const record = (body ?? {}) as { message?: string; error?: string };
      throw new ApiError(
        response.status,
        record.message ?? record.error ?? `HTTP ${response.status} from ${base}`,
        body,
      );
    }
    return body as T;
  }

  return {
    base,
    me: () => request<MeResponse>("/api/me"),
    health: () => request<{ ok: boolean; db: string; ms: number }>("/api/health"),
    list: (params: URLSearchParams) => request<ListResponse>(`/api/files?${params.toString()}`),
    changes: (query: ChangesQuery) => {
      const params = new URLSearchParams();
      if (query.since) params.set("since", query.since);
      if (query.excludeMachine) params.set("excludeMachine", query.excludeMachine);
      if (query.limit) params.set("limit", String(query.limit));
      return request<ChangesResponse>(`/api/changes?${params.toString()}`);
    },
    get: (id: string) => request<ShelfFile>(`/api/files/${encodeURIComponent(id)}`),
    async byPath(machineId: string, path: string): Promise<ShelfFileMeta | null> {
      const params = new URLSearchParams({ machineId, path });
      try {
        return await request<ShelfFileMeta>(`/api/files/by-path?${params.toString()}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    write: (body: WriteRequestBody) =>
      request<WriteResponse>("/api/files", { method: "POST", body: JSON.stringify(body) }),
  };
}

export type Api = ReturnType<typeof createApi>;
