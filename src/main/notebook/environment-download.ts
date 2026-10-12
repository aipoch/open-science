import { netFetchStandard } from '../network-fetch'
import { resilientDownload } from '@aipoch/resilient-download'
import {
  createFetchBundleAdapter as createEnvironmentBundleAdapter,
  type DownloadProgress
} from '@aipoch/environment'
// The manifest is tiny, so a total request timeout is fine. Without it, a CDN that accepts the
// connection then stalls would hang first-run provisioning (and the serialized provision queue behind
// it) forever instead of failing closed.
const MANIFEST_TIMEOUT_MS = 30_000
// The pack can be large (hundreds of MB), so a total timeout would wrongly kill a legit slow download.
// Use a STALL timeout instead: abort only when no bytes arrive for this window (covers a stalled
// connect and a mid-stream stall alike), and reset it on every received chunk.
const PACK_STALL_TIMEOUT_MS = 60_000

// Combines the internal timeout/stall controller with an optional external cancel signal (user
// pressing Cancel), so either one aborts the request. AbortSignal.any short-circuits if the external
// signal is already aborted.
const withCancel = (internal: AbortSignal, external?: AbortSignal): AbortSignal =>
  external ? AbortSignal.any([internal, external]) : internal

const fetchText = async (url: string, external?: AbortSignal): Promise<string> => {
  const signal = withCancel(AbortSignal.timeout(MANIFEST_TIMEOUT_MS), external)
  // Electron net.fetch so the manifest request honors the system/VPN proxy, matching the pack download.
  const response = await netFetchStandard(url, { signal })
  if (!response.ok) throw new Error(`runtime manifest request failed (${response.status})`)
  return response.text()
}

// Default download implementation: delegates to the shared resilient core with Electron net.fetch so
// downloads honor the system/VPN proxy and gain Range resume + retry + stall handling. Verifies the
// pack's sha256 inline when the caller passes it (fetchLanguagePack does, from the manifest entry).
// Tests inject a fake via LanguagePackFetchDeps.download.
const downloadFile = async (
  url: string,
  destPath: string,
  onProgress: (p: DownloadProgress) => void = () => undefined,
  external?: AbortSignal,
  expected?: { sha256?: string; size?: number }
): Promise<void> => {
  await resilientDownload(url, destPath, {
    expectedSha256: expected?.sha256,
    expectedSize: expected?.size,
    stallTimeoutMs: PACK_STALL_TIMEOUT_MS,
    signal: external,
    onProgress,
    fetchImpl: netFetchStandard
  })
}

export const createFetchBundleAdapter = (
  root: string,
  cdnBase: string | undefined
): ReturnType<typeof createEnvironmentBundleAdapter> =>
  createEnvironmentBundleAdapter(root, cdnBase, {
    fetchText,
    download: (url, dest, progress, expected, signal) =>
      downloadFile(url, dest, progress, signal, expected)
  })
