/** Wire types shared by the CLI, the web app, and the desktop app. */

import type { KeyScope } from "./scope.js";

export interface ShelfFileMeta {
  id: string;
  machineId: string;
  path: string;
  createdAt: string;
  editedAt: string;
  bytes: number;
  /** sha256 of the stored html; lets a client skip identical content. */
  sha256?: string;
  /** Size of the file's version family (see `latestVersions`); set on list results. */
  versions?: number;
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
  /**
   * What the calling credential may do. An append-only key gets an empty
   * `machines` list and a zero `fileCount`: it is not allowed to see the shelf.
   */
  scope: KeyScope;
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
  /** One machine id, or several joined by commas (see `parseMachineList`). */
  machine?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
  withHtml?: boolean;
  /** `latest` (the default) keeps the newest file of each version family; `all` keeps every file. */
  versions?: VersionsMode;
  /** Every version of this file's family (an id), newest first; ignores `versions`. */
  versionsOf?: string;
}

export type VersionsMode = "latest" | "all";
