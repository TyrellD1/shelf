import type { ShelfFile, ShelfFileMeta } from "@shelf/shared";
import type { DataAdapter, StatusInfo } from "./adapter.js";

/** Top-bar controls the reader borrows while a document is open. */
export interface ReaderChrome {
  setTitle(title: string, subtitle: string): void;
  setActions(actions: { back(): void; external(): void }): void;
  clear(): void;
}

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
  readerChrome: ReaderChrome;
}

export type AdapterFile = ShelfFile;
