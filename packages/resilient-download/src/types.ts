export type DownloadPhase = 'downloading' | 'reconnecting'

export type DownloadProgress = {
  phase: DownloadPhase
  transferred: number
  total?: number
  percent?: number
  bytesPerSecond: number
  etaSeconds?: number
  attempt: number
}

export type ResilientDownloadOpts = {
  expectedSha256?: string
  // Exact byte size, normally from a manifest. It is both the short-read target and a hard write
  // ceiling, including response metadata and each streamed chunk. If this and Content-Length are
  // absent, a silently truncated stream cannot be distinguished from a complete unknown-size body.
  expectedSize?: number
  // When set, every final response URL must remain on this origin after fetch follows redirects.
  expectedOrigin?: string
  maxRetries?: number
  stallTimeoutMs?: number
  signal?: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  fetchImpl?: typeof fetch
}
