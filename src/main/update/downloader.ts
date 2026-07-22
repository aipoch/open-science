import type { DownloadProgress } from '../../shared/download-progress'
import type { PlatformDownload } from '../../shared/update'
import { netFetchStandard } from '../skills/net-fetch'
import { resilientDownload } from '../net/resilient-download'

export { DownloadChecksumError } from '../net/resilient-download'

export type DownloadDeps = {
  fetchImpl?: typeof fetch
  onProgress?: (progress: DownloadProgress) => void
  // Aborts the request/stream when signalled; the partial file is kept for a later session resume.
  signal?: AbortSignal
}

// Streams the installer to `targetPath` via the shared resilient core: Range resume + retry + stall
// handling + streaming sha256. The sha256/size come from the update manifest, so a mismatch means a
// corrupt/tampered download and the core removes the partial file before throwing. Defaults to
// Electron net.fetch (system-proxy-aware) so downloads work behind a corporate VPN or proxy.
export const downloadInstaller = async (
  download: PlatformDownload,
  targetPath: string,
  deps: DownloadDeps = {}
): Promise<string> =>
  resilientDownload(download.url, targetPath, {
    expectedSha256: download.sha256,
    expectedSize: download.size > 0 ? download.size : undefined,
    signal: deps.signal,
    onProgress: deps.onProgress,
    deps: { fetchImpl: deps.fetchImpl ?? netFetchStandard }
  })
