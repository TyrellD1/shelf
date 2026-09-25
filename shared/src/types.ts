/** Wire types shared by the CLI, the web app, and the desktop app. */

export interface ShelfFileMeta {
  id: string;
  machineId: string;
  path: string;
  createdAt: string;
  editedAt: string;
  bytes: number;
  /** sha256 of the stored html; lets a client skip identical content. */
  sha256?: string;
}

export interface ShelfFile extends ShelfFileMeta {
  html: string;
}

export interface MachineSummary {
  machineId: string;
  count: number;
  latestAt: string;
}

export interface MeResponse {
  user: { id: string; email: string; name: string | null };
  machines: MachineSummary[];
  fileCount: number;
  appUrl: string;
}

export interface ListResponse {
  files: ShelfFileMeta[];
  total: number;
  hasMore: boolean;
}

export interface ChangesResponse {
  files: ShelfFile[];
  nextSince: string | null;
  hasMore: boolean;
}

export interface WriteResponse {
  file: ShelfFileMeta;
  created: boolean;
  replaced: boolean;
}

export interface ErrorResponse {
  error: string;
  message?: string;
  /** Populated on 409 so a client can explain what already exists. */
  existing?: ShelfFileMeta;
}

export interface WriteRequestBody {
  id: string;
  machineId: string;
  path: string;
  html: string;
  replace?: boolean;
}

export type SortKey = "created" | "edited";

export interface ListQuery {
  limit?: number;
  offset?: number;
  q?: string;
  machine?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
  withHtml?: boolean;
}
