export type BrowserImportProgress = { sentBytes: number; totalBytes: number }
export type BrowserImportFailureCode =
  'unsupported-browser' | 'timeout' | 'readiness-exhausted' | 'incompatible'
export class BrowserImportError extends Error {
  readonly code: BrowserImportFailureCode
  constructor(code: BrowserImportFailureCode, message: string)
}
export type BrowserImportDiscoveryOptions = {
  signal?: AbortSignal
  /** Must match the page origin. Inferred from location in browsers. */
  origin?: string
  /** A single configured endpoint, never a range to scan. Defaults to 49151. */
  port?: number
  timeoutMs?: number
}
export type BrowserImportUnavailable = {
  /** unavailable also covers opaque CORS/local-network denials; it does not mean not installed. */
  status: 'unavailable' | 'unsupported-browser' | 'incompatible' | 'timeout' | 'aborted'
}
/** Advisory only; the transfer handshake authenticates the actual receiver. No package is fetched. */
export function checkBrowserImportAvailability(
  options?: BrowserImportDiscoveryOptions
): Promise<{ status: 'available' } | BrowserImportUnavailable>
export type BrowserImportTransfer = {
  /** Contains a secret; never log or persist it. Browser policy may require a fresh user click. */
  readonly url: string
  /** Acknowledges receipt only, independently of destination selection and final import consent. */
  send(options?: {
    signal?: AbortSignal
    onProgress?: (progress: BrowserImportProgress) => void
    /** Overall abortable readiness budget, separate from file transfer; defaults to two minutes. */
    readyTimeoutMs?: number
    /** 1–5 attempts, always separated by 1,000 ms; defaults to 5. */
    readinessAttempts?: number
    /** Includes response body reads; defaults to 2,000 ms, maximum 30,000 ms. */
    attemptTimeoutMs?: number
  }): Promise<{ received: true }>
}
/** Takes a complete browser-held Blob/File. Never fetches a remote package URL. */
export function prepareBrowserImport(
  file: Blob,
  options?: { filename?: string; origin?: string; port?: number }
): BrowserImportTransfer
