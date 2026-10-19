export type BrowserImportReadinessMode = 'attempts' | 'wait-for-launch'
export type BrowserImportPhase = 'waiting-for-receiver' | 'transferring'
export type BrowserImportProgress = { sentBytes: number; totalBytes: number }
export type BrowserImportFailureCode =
  | 'unsupported-browser'
  | 'timeout'
  | 'readiness-exhausted'
  | 'incompatible'
  | 'launch-failed'
  | 'transfer-failed'
  | 'cancelled'
export class BrowserImportError extends Error {
  readonly code: BrowserImportFailureCode
  constructor(code: BrowserImportFailureCode, message: string)
}
/** Synchronous user-click launch request. Returning does not prove installation or delivery.
 * Throws BrowserImportError: unsupported-browser (no navigation API), launch-failed (navigation threw). */
export function launchOpenScience(): void
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
/** Probes a running, reachable service, not installation/protocol registration. May prompt for
 * local-network permission. Advisory only; the secret-bound handshake authenticates the receiver. */
export function checkBrowserImportAvailability(
  options?: BrowserImportDiscoveryOptions
): Promise<{ status: 'available' } | BrowserImportUnavailable>
export type BrowserImportTransfer = {
  /** Contains a secret; never log or persist it. Browser policy may require a fresh user click. */
  readonly url: string
  /** Acknowledges receipt only, independently of destination selection and final import consent.
   * Authenticated desktop cancellation throws code 'cancelled', terminal for this transfer.
   * Keep the Blob and explicitly prepare a new transfer; never automatically retry cancellation. */
  send(options?: {
    signal?: AbortSignal
    /** Waiting starts before readiness; transferring starts after identity verification, before bytes.
     * No transferring event for an already-received package; cached receipts emit no events. */
    onPhase?: (phase: BrowserImportPhase) => void
    /** Acknowledged bytes only; first callback follows the first successful chunk acknowledgment. */
    onProgress?: (progress: BrowserImportProgress) => void
    /** Default attempts preserves the 1–5 attempt limit. wait-for-launch retries until the
     * overall deadline or cancellation; it observes only this transfer's authenticated handshake. */
    readinessMode?: BrowserImportReadinessMode
    /** Readiness only; defaults to 120,000 ms. Capped at 120,000 ms in wait-for-launch,
     * 300,000 ms in attempts mode. Timeout permits another send() on the same live transfer. */
    readyTimeoutMs?: number
    /** 1–5 attempts with 1,000 ms gaps; defaults to 5. Ignored in wait-for-launch mode. */
    readinessAttempts?: number
    /** Includes response body reads; defaults to 2,000 ms. Accepts up to 30,000 ms,
     * clamped to 2,000 ms in wait-for-launch mode. Failed attempts have 1,000 ms gaps. */
    attemptTimeoutMs?: number
  }): Promise<{ received: true }>
}
/** Takes a complete browser-held Blob/File. Never fetches a remote package URL. */
export function prepareBrowserImport(
  file: Blob,
  options?: { filename?: string; origin?: string; port?: number }
): BrowserImportTransfer
