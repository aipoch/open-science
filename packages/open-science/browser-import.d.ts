export type BrowserImportProgress = { sentBytes: number; totalBytes: number }
export type BrowserImportTransfer = {
  /** Open this URL directly from a user click. Contains a secret; do not log or publish it. */
  readonly url: string
  /** Acknowledges local receipt only. The user still confirms the import in Open-Science. */
  send(options?: {
    signal?: AbortSignal
    onProgress?: (progress: BrowserImportProgress) => void
    readyTimeoutMs?: number
  }): Promise<{ received: true }>
}
/** Takes a complete browser-held Blob/File. Never fetches a remote package URL. */
export function prepareBrowserImport(
  file: Blob,
  options?: { filename?: string; origin?: string; port?: number }
): BrowserImportTransfer
