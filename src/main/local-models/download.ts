import {
  DownloadSourceError,
  resilientDownload,
  type ResilientDownloadOpts
} from '../net/resilient-download'
import { netFetchStandard } from '../skills/net-fetch'
import type { LocalModelRevision } from './catalog'
import { localModelDownloadSources } from './download-sources'

type Asset = LocalModelRevision['assets'][number]
type Options = Pick<ResilientDownloadOpts, 'signal' | 'onProgress'>
type Dependencies = {
  fetchImpl?: typeof fetch
  download?: typeof resilientDownload
  sources?: (asset: Asset) => readonly string[]
  probeTimeoutMs?: number
  now?: () => number
}

// A probe measures bounded real file data, including the redirect target. It cannot certify the
// full asset or its sustained throughput; the downloader must still verify size and SHA-256.
const probe = async (
  url: string,
  size: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  now: () => number
): Promise<number> => {
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = now()
  let body: ReadableStream<Uint8Array> | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    combined.throwIfAborted()
    const sampleBytes = Math.min(size, 1024)
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=0-${sampleBytes - 1}` },
      signal: combined
    })
    body = response.body
    if (![200, 206].includes(response.status) || !body) return Infinity
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
      return Infinity
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
      if (
        !range ||
        Number(range[1]) !== sampleBytes - 1 ||
        Number(range[2]) !== size ||
        (length !== null && Number(length) !== sampleBytes)
      )
        return Infinity
    } else if (length !== null && Number(length) !== size) return Infinity
    reader = body.getReader()
    let received = 0
    while (received < sampleBytes) {
      const { done, value } = await reader.read()
      combined.throwIfAborted()
      if (done) return Infinity
      received += value.byteLength
    }
    return now() - started
  } catch {
    return Infinity
  } finally {
    clearTimeout(timer)
    // Abort also releases bodies rejected before a reader was acquired. A 200 response may have
    // ignored Range; stop reading immediately rather than buffering the entire model.
    controller.abort()
    await (reader ? reader.cancel() : body?.cancel())?.catch(() => undefined)
    reader?.releaseLock()
  }
}

// One invocation owns one asset's selection. Nothing is cached across installations or written
// outside resilientDownload's existing partial/receipt lifecycle.
export const downloadLocalModelAsset = async (
  asset: Asset,
  target: string,
  options: Options,
  dependencies: Dependencies = {}
): Promise<string> => {
  const fetchImpl = dependencies.fetchImpl ?? netFetchStandard
  const download = dependencies.download ?? resilientDownload
  const sources = (dependencies.sources ?? localModelDownloadSources)(asset)
  options.signal?.throwIfAborted()
  const candidates = await Promise.all(
    sources.map(async (url) => ({
      url,
      latency: await probe(
        url,
        asset.size,
        fetchImpl,
        options.signal,
        dependencies.probeTimeoutMs ?? 4000,
        dependencies.now ?? (() => performance.now())
      )
    }))
  )
  options.signal?.throwIfAborted()
  // Stable sorting retains the catalog order for ties and for unsuccessful probes. A failed probe
  // is only a ranking hint, never a reason to exclude an approved source from a real attempt.
  candidates.sort((a, b) => a.latency - b.latency)
  let failure: unknown
  for (const [index, { url }] of candidates.entries()) {
    options.signal?.throwIfAborted()
    if (index > 0)
      options.onProgress?.({
        phase: 'downloading',
        transferred: 0,
        total: asset.size,
        percent: 0,
        bytesPerSecond: 0,
        attempt: 0
      })
    try {
      return await download(url, target, {
        ...options,
        expectedSize: asset.size,
        expectedSha256: asset.sha256,
        maxRetries: 1,
        stallTimeoutMs: 30_000,
        deps: { fetchImpl }
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!(error instanceof DownloadSourceError)) throw error
      failure = error
    }
  }
  throw failure ?? new Error('No local model download sources.')
}
