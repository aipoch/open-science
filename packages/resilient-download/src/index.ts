import { downloadWithDependencies } from './resilient-download'
import type { ResilientDownloadOpts } from './types'

// The published signature exposes transport injection; filesystem fault seams stay package-private.
export const resilientDownload: (
  url: string,
  destination: string,
  options?: ResilientDownloadOpts
) => Promise<string> = downloadWithDependencies

export { DownloadChecksumError, DownloadSourceError } from './errors'
export { SpeedMeter } from './download-speed'
export type { DownloadPhase, DownloadProgress, ResilientDownloadOpts } from './types'
