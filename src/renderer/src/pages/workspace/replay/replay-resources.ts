import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'
import type { ReplayResource } from '../../../../../shared/replay'
import { replayImageSource } from './replay-svg'

export type ReplayPreparedResource =
  | {
      status: 'ready'
      kind: 'image' | 'text' | 'table'
      content: string
      mimeType: string
      truncated: boolean
    }
  | { status: 'unavailable'; reason?: 'not-recorded' | 'read-failed' }
  | { status: 'unsupported' | 'timeout' }
export type ReplayResourceReader = (resource: ReplayResource) => Promise<ReplayPreparedResource>
export type ReplayResourceMap = Readonly<Record<string, ReplayPreparedResource | undefined>>

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'py',
  'r',
  'jl',
  'js',
  'ts',
  'css',
  'yaml',
  'yml',
  'toml',
  'log',
  'sh',
  'sql',
  'xml',
  'tex',
  'fasta',
  'fa'
])

export const readReplayResource: ReplayResourceReader = async (resource) => {
  // Never substitute a mutable filename or the latest Version for missing historical bytes.
  if (resource.availability !== 'recorded' || !resource.locator || !resource.versionId)
    return { status: 'unavailable', reason: 'not-recorded' }
  const extension = resource.name.split('.').at(-1)?.toLowerCase() ?? ''
  const imageMime = IMAGE_TYPES[extension]
  const text = TEXT_EXTENSIONS.has(extension) || resource.mimeType?.startsWith('text/')
  if (!imageMime && !text) return { status: 'unsupported' }
  const maxBytes = imageMime ? 16 * 1024 * 1024 : 192 * 1024
  if (imageMime && resource.size !== undefined && resource.size > maxBytes)
    return { status: 'unsupported' }
  let result: ArtifactPreviewResult
  try {
    const read =
      resource.source === 'upload'
        ? window.api.uploads.readPreview
        : window.api.artifacts.readPreview
    result = await read({
      path: resource.locator,
      projectId: resource.projectId,
      sessionId: resource.sessionId,
      fileId: resource.source === 'upload' ? resource.fileId : resource.artifactId,
      versionId: resource.versionId,
      maxBytes,
      encoding: imageMime ? 'base64' : 'utf8'
    })
  } catch {
    return { status: 'unavailable', reason: 'read-failed' }
  }
  if (imageMime && (result.truncated || result.encoding !== 'base64'))
    return { status: 'unavailable', reason: 'read-failed' }
  const imageSource = imageMime ? replayImageSource(imageMime, result.content) : undefined
  if (imageMime && !imageSource) return { status: 'unavailable', reason: 'read-failed' }
  return {
    status: 'ready',
    kind: imageMime ? 'image' : ['csv', 'tsv'].includes(extension) ? 'table' : 'text',
    content: imageSource ?? result.content,
    mimeType: imageMime ?? resource.mimeType ?? 'text/plain',
    truncated: result.truncated
  }
}

// Cache belongs to one mounted source. Missing/timeout decisions remain stable until an explicit
// reprepare, and late IPC responses cannot change a settled capture frame. Limit both reads and RAM.
export class ReplayResourceCache {
  private entries = new Map<string, { value: ReplayPreparedResource; bytes: number }>()
  private pending = new Map<string, Promise<ReplayPreparedResource>>()
  // Small failure decisions survive payload eviction for the entire preparation batch.
  private failures = new Map<string, ReplayPreparedResource>()
  private bytes = 0
  private running = 0
  private queue: (() => void)[] = []
  constructor(
    private reader: ReplayResourceReader = readReplayResource,
    private timeoutMs = 5000,
    private maxEntries = 24,
    private maxBytes = 64 * 1024 * 1024
  ) {}

  get stats(): Readonly<{ bytes: number; entries: number; running: number; queued: number }> {
    return {
      bytes: this.bytes,
      entries: this.entries.size,
      running: this.running,
      queued: this.queue.length
    }
  }

  prepare(resource: ReplayResource): Promise<ReplayPreparedResource> {
    const key = JSON.stringify([
      resource.id,
      resource.versionId,
      resource.checksum,
      resource.locator
    ])
    const failure = this.failures.get(key)
    if (failure) return Promise.resolve(failure)
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return Promise.resolve(cached.value)
    }
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.queue.length >= 32) {
      const outcome: ReplayPreparedResource = { status: 'timeout' }
      this.failures.set(key, outcome)
      return Promise.resolve(outcome)
    }
    const promise = new Promise<ReplayPreparedResource>((resolve) => {
      let settled = false
      const finish = (result: ReplayPreparedResource): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.pending.delete(key)
        if (result.status === 'ready') {
          const bytes = result.content.length * 2 + 128
          if (bytes <= this.maxBytes) {
            this.entries.set(key, { value: result, bytes })
            this.bytes += bytes
            while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
              const oldest = this.entries.keys().next().value!
              this.bytes -= this.entries.get(oldest)!.bytes
              this.entries.delete(oldest)
            }
          }
        } else this.failures.set(key, result)
        resolve(result)
      }
      const timeout = setTimeout(() => finish({ status: 'timeout' }), this.timeoutMs)
      const run = (): void => {
        if (settled) {
          this.queue.shift()?.()
          return
        }
        this.running++
        void Promise.resolve()
          .then(() => this.reader(resource))
          .then(finish, () => finish({ status: 'unavailable', reason: 'read-failed' }))
          .finally(() => {
            this.running--
            this.queue.shift()?.()
          })
      }
      if (this.running < 2) run()
      else this.queue.push(run)
    })
    this.pending.set(key, promise)
    return promise
  }
}
