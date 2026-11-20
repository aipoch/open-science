import {
  DownloadChecksumError,
  DownloadSourceError,
  resilientDownload
} from '@aipoch/resilient-download'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUseCases, USE_CASE_MANIFEST_URL, type UseCase } from '../../shared/use-cases'
import { assertPackageCapacity, PackageCapacityError } from './capacity'

export type UseCaseDownloadFailureReason =
  | 'manifest'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'server'
  | 'verification'
  | 'disk-full'
  | 'storage'

export class UseCaseDownloadError extends Error {
  constructor(
    readonly reason: UseCaseDownloadFailureReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'UseCaseDownloadError'
  }
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED'
])

const STORAGE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR'])

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = []
  let current: unknown = error
  while (
    current !== undefined &&
    current !== null &&
    !chain.includes(current) &&
    chain.length < 8
  ) {
    chain.push(current)
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return chain
}

const errorCode = (entry: unknown): string | undefined =>
  typeof entry === 'object' && entry !== null && 'code' in entry && typeof entry.code === 'string'
    ? entry.code
    : undefined

const errorMessage = (entry: unknown): string =>
  entry instanceof Error ? entry.message : typeof entry === 'string' ? entry : ''

const hasTimeoutSignal = (chain: unknown[]): boolean =>
  chain.some((entry) => {
    const code = errorCode(entry)
    return (
      (entry instanceof Error && entry.name === 'TimeoutError') ||
      (code !== undefined && TIMEOUT_CODES.has(code)) ||
      /^stalled >|\btimed out\b/i.test(errorMessage(entry))
    )
  })

const hasNetworkSignal = (chain: unknown[]): boolean =>
  chain.some((entry) => {
    const code = errorCode(entry)
    return (
      (code !== undefined && NETWORK_CODES.has(code)) ||
      /fetch failed|\bnetwork\b/i.test(errorMessage(entry))
    )
  })

const classifyManifestFetchError = (error: unknown): UseCaseDownloadError | undefined => {
  const chain = errorChain(error)
  if (hasTimeoutSignal(chain)) {
    return new UseCaseDownloadError('timeout', 'Example catalog request timed out.', {
      cause: error
    })
  }
  if (chain.some((entry) => /redirect/i.test(errorMessage(entry)))) {
    return new UseCaseDownloadError('server', 'Example server returned an unexpected response.', {
      cause: error
    })
  }
  if (hasNetworkSignal(chain)) {
    return new UseCaseDownloadError('network', 'Could not reach the example catalog.', {
      cause: error
    })
  }
  return undefined
}

const classifyDownloadError = (error: unknown): unknown => {
  const chain = errorChain(error)
  if (
    error instanceof DownloadChecksumError ||
    chain.some(
      (entry) =>
        (entry instanceof Error &&
          (entry.name === 'DownloadChecksumError' ||
            entry.name === 'DownloadResponseIntegrityError')) ||
        errorMessage(entry) === 'short read' ||
        /exceeds expected size|invalid Content-(?:Range|Length)|Content-Range length|validator does not match|left the trusted origin/i.test(
          errorMessage(entry)
        )
    )
  ) {
    return new UseCaseDownloadError('verification', 'Downloaded example failed verification.', {
      cause: error
    })
  }
  if (hasTimeoutSignal(chain)) {
    return new UseCaseDownloadError('timeout', 'Example download timed out.', { cause: error })
  }
  const message = errorMessage(error)
  if (/^request failed \((404|410)\)$/.test(message)) {
    return new UseCaseDownloadError('unavailable', 'Use case is unavailable.', { cause: error })
  }
  if (
    /^request failed \(\d+\)$|^server error \d+$|^unexpected status \d+$|^response had no body$/.test(
      message
    ) ||
    chain.some((entry) => /redirect/i.test(errorMessage(entry)))
  ) {
    return new UseCaseDownloadError('server', 'Example server returned an error.', { cause: error })
  }
  if (error instanceof DownloadSourceError || hasNetworkSignal(chain)) {
    return new UseCaseDownloadError('network', 'Network error while downloading example.', {
      cause: error
    })
  }
  if (chain.some((entry) => errorCode(entry) === 'ENOSPC')) {
    return new UseCaseDownloadError('disk-full', 'Not enough disk space for example download.', {
      cause: error
    })
  }
  if (
    chain.some((entry) => {
      const code = errorCode(entry)
      return code !== undefined && STORAGE_CODES.has(code)
    })
  ) {
    return new UseCaseDownloadError('storage', 'Could not save downloaded example.', {
      cause: error
    })
  }
  return error
}

// Resolve the slug independently of renderer metadata and verify bytes before archive inspection.
export const downloadUseCase = async (
  slug: string,
  signal: AbortSignal,
  progress: (bytes: number, total: number) => void
): Promise<{ path: string; release: () => Promise<void> }> => {
  const manifestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  let manifest: Response
  try {
    manifest = await fetch(USE_CASE_MANIFEST_URL, {
      signal: manifestSignal,
      redirect: 'error'
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw classifyManifestFetchError(manifestSignal.reason ?? error) ?? error
  }
  if (!manifest.ok) {
    await manifest.body?.cancel().catch(() => undefined)
    throw new UseCaseDownloadError('manifest', 'Could not load use cases.')
  }
  let item: UseCase | undefined
  try {
    const data: unknown = await manifest.json().catch((error: unknown) => {
      if (signal.aborted || error instanceof SyntaxError) throw error
      throw classifyManifestFetchError(manifestSignal.reason ?? error) ?? error
    })
    item = parseUseCases(data).find((entry) => entry.slug === slug)
  } catch (error) {
    if (signal.aborted || error instanceof UseCaseDownloadError) throw error
    throw new UseCaseDownloadError('manifest', 'Could not load use cases.', { cause: error })
  }
  if (!item) throw new UseCaseDownloadError('unavailable', 'Use case is unavailable.')
  let directory: string
  try {
    directory = await mkdtemp(join(tmpdir(), 'open-science-use-case-'))
  } catch (error) {
    throw classifyDownloadError(error)
  }
  const release = (): Promise<void> => rm(directory, { recursive: true, force: true })
  // A slug is a portable filename, including on Windows where published titles can contain colons.
  const path = join(directory, `case-${slug}.science`)
  try {
    await assertPackageCapacity(directory, item.sizeBytes)
    await resilientDownload(item.packageUrl, path, {
      signal,
      expectedSize: item.sizeBytes,
      expectedSha256: item.sha256,
      maxRetries: 0,
      fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' }),
      onProgress: ({ transferred }) => progress(transferred, item.sizeBytes)
    })
    signal.throwIfAborted()
    return { path, release }
  } catch (error) {
    await release()
    if (signal.aborted || error instanceof PackageCapacityError) throw error
    throw classifyDownloadError(error)
  }
}
