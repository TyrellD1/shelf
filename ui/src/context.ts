import type { ShelfFile, ShelfFileMeta } from "@shelf/shared";
import type { DataAdapter, StatusInfo } from "./adapter.js";

export interface AppContext {
  adapter: DataAdapter;
  status(): StatusInfo | null;
  refreshStatus(): Promise<StatusInfo>;
  openReader(id: string): void;
  closeReader(): void;
  openPalette(): void;
  toast(message: string): void;
  cacheFile(file: ShelfFileMeta | ShelfFile): void;
  getCachedFile(id: string): ShelfFileMeta | undefined;
  /** Re-render the topbar (sync state, sign-in state). */
  refreshChrome(): void;
}

export type AdapterFile = ShelfFile;
