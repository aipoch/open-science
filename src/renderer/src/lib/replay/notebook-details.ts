import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'
import type {
  ReplayNotebookRunDetails,
  ReplayRunIndex,
  ReplaySourceIdentity
} from '../../../../shared/replay'
import { estimateReplayBytes, replaySourceKey } from './run-index'
import type { ReplayReaderApi } from './source'

export const REPLAY_NOTEBOOK_DETAIL_LIMIT = 8 * 1024 * 1024
export const REPLAY_NOTEBOOK_CACHE_LIMIT = 32 * 1024 * 1024

export type ReplayNotebookRunReader = (
  source: ReplaySourceIdentity,
  index: ReplayRunIndex,
  options?: { signal?: AbortSignal }
) => Promise<ReplayNotebookRunDetails>

const settleRead = (
  promise: Promise<ReplayNotebookRunDetails>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<ReplayNotebookRunDetails> =>
  new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: ReplayNotebookRunDetails): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(
      () => finish({ status: 'unavailable', reason: 'load-failed' }),
      Math.max(1, timeoutMs)
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    void promise.then(finish, () => {
      if (signal?.aborted) abort()
      else finish({ status: 'unavailable', reason: 'load-failed' })
    })
  })

// The display projection preserves only recorded prefixes/complete outputs. It never synthesizes
// scientific output to replace omitted payloads. The existing truncated indicator explains loss.
const boundedRun = (run: NotebookRunRecord, maxBytes: number): NotebookRunRecord => {
  let remaining = Math.max(0, maxBytes - 8192)
  let truncated = Boolean(run.truncated)
  const text = (value: string): string => {
    const kept = value.slice(0, Math.min(128 * 1024, Math.floor(remaining / 2)))
    remaining = Math.max(0, remaining - kept.length * 2)
    if (kept.length !== value.length) truncated = true
    return kept
  }
  const script = text(run.script)
  const stdout = text(run.text.stdout)
  const stderr = text(run.text.stderr)
  const traceback = text(run.text.traceback)
  const plain = run.text.plain.slice(0, 64).map(text)
  if (plain.length !== run.text.plain.length) truncated = true
  const outputs: NotebookOutput[] = []
  for (const output of run.outputs.slice(0, 128)) {
    if (output.type === 'stream' || output.type === 'text') {
      outputs.push({ ...output, text: text(output.text) })
      remaining = Math.max(0, remaining - 128)
    } else {
      const bytes = estimateReplayBytes(output)
      if (bytes <= remaining) {
        outputs.push(output)
        remaining -= bytes
      } else {
        truncated = true
      }
    }
  }
  if (outputs.length !== run.outputs.length) truncated = true
  return {
    runId: run.runId,
    cellId: run.cellId,
    source: run.source,
    kernelKind: run.kernelKind,
    script,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    text: { stdout, stderr, traceback, plain },
    outputs,
    workingFiles: [],
    executionInvocationId: run.executionInvocationId,
    rootFrameId: run.rootFrameId,
    agentFrameId: run.agentFrameId,
    messageBranchId: run.messageBranchId,
    runtimeSegmentId: run.runtimeSegmentId,
    promptMessageId: run.promptMessageId,
    truncated
  }
}

const readRecordedNotebookRun = async (
  api: ReplayReaderApi['notebook'],
  source: ReplaySourceIdentity,
  index: ReplayRunIndex,
  {
    signal,
    maxBytes = REPLAY_NOTEBOOK_DETAIL_LIMIT
  }: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<ReplayNotebookRunDetails> => {
  try {
    signal?.throwIfAborted()
    // Imports clear the original workspace path. Persisted history is scoped by project/Session;
    // getReference below verifies it exists before any state read.
    const request = {
      projectId: source.projectId,
      sessionId: source.sessionId,
      workspaceCwd: source.workspaceCwd ?? ''
    }
    if (!(await api.getReference(request))) return { status: 'unavailable', reason: 'not-recorded' }
    signal?.throwIfAborted()
    const state = await api.state({ ...request, runIds: [index.runId] })
    signal?.throwIfAborted()
    const original = state.runs.find((run) => run.runId === index.runId)
    if (!original) return { status: 'unavailable', reason: 'not-recorded' }
    const identityFields = [
      'agentFrameId',
      'messageBranchId',
      'promptMessageId',
      'executionInvocationId',
      'startedAt',
      'endedAt',
      'status',
      'cellId',
      'kernelKind'
    ] as const
    if (identityFields.some((key) => index[key] !== original[key])) {
      return { status: 'unavailable', reason: 'identity-mismatch' }
    }
    const run = boundedRun(original, Math.max(0, maxBytes))
    const bytes = estimateReplayBytes(run)
    return bytes <= maxBytes
      ? { status: 'ready', run, bytes }
      : { status: 'unavailable', reason: 'too-large' }
  } catch (error) {
    signal?.throwIfAborted()
    void error
    return { status: 'unavailable', reason: 'load-failed' }
  }
}

export const readReplayNotebookRun = (
  api: ReplayReaderApi['notebook'],
  source: ReplaySourceIdentity,
  index: ReplayRunIndex,
  options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {}
): Promise<ReplayNotebookRunDetails> =>
  settleRead(
    readRecordedNotebookRun(api, source, index, options),
    options.signal,
    options.timeoutMs ?? 10000
  )

type CacheEntry = { value: ReplayNotebookRunDetails; bytes: number }

// A playback-owned LRU. No global cache or fallback to a run with a matching filename/id from a
// different imported session. read() limits payload size; this owner limits residency/concurrency.
export class ReplayNotebookRunCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<ReplayNotebookRunDetails>>()
  private readonly waiters: Array<() => void> = []
  private bytes = 0
  private active = 0
  private generation = 0
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly concurrency: number
  private readonly timeoutMs: number

  constructor(
    private readonly read: ReplayNotebookRunReader,
    options: {
      maxBytes?: number
      maxEntries?: number
      concurrency?: number
      timeoutMs?: number
    } = {}
  ) {
    this.maxBytes = Math.max(0, options.maxBytes ?? REPLAY_NOTEBOOK_CACHE_LIMIT)
    this.maxEntries = Math.max(1, options.maxEntries ?? 12)
    this.concurrency = Math.max(1, options.concurrency ?? 2)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10000)
  }

  get stats(): Readonly<{ bytes: number; entries: number; active: number; pending: number }> {
    return {
      bytes: this.bytes,
      entries: this.entries.size,
      active: this.active,
      pending: this.pending.size
    }
  }

  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.bytes = 0
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.active < this.concurrency) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const enter = (): void => {
        signal?.removeEventListener('abort', abort)
        // release() transferred the active slot to this queued reader.
        resolve()
      }
      const abort = (): void => {
        const index = this.waiters.indexOf(enter)
        if (index >= 0) this.waiters.splice(index, 1)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      this.waiters.push(enter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }

  async load(
    source: ReplaySourceIdentity,
    index: ReplayRunIndex,
    { signal }: { signal?: AbortSignal } = {}
  ): Promise<ReplayNotebookRunDetails> {
    signal?.throwIfAborted()
    const key = JSON.stringify([replaySourceKey(source), index.runId])
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.value
    }
    const generation = this.generation
    const pendingKey = JSON.stringify([generation, key])
    const existing = this.pending.get(pendingKey)
    if (existing) {
      try {
        const value = await existing
        signal?.throwIfAborted()
        return value
      } catch (error) {
        signal?.throwIfAborted()
        if (generation !== this.generation) throw error
        // A previous viewport consumer may have cancelled the shared read. A current consumer
        // can issue its own bounded retry; it must not inherit the old viewport's cancellation.
        if (this.pending.get(pendingKey) === existing) this.pending.delete(pendingKey)
        return this.load(source, index, { signal })
      }
    }
    if (this.pending.size >= 32) throw new Error('Replay detail request queue is full.')
    const pending = (async (): Promise<ReplayNotebookRunDetails> => {
      await this.acquire(signal)
      try {
        signal?.throwIfAborted()
        if (generation !== this.generation) throw new DOMException('Aborted', 'AbortError')
        const value = await settleRead(this.read(source, index, { signal }), signal, this.timeoutMs)
        signal?.throwIfAborted()
        if (generation !== this.generation) throw new DOMException('Aborted', 'AbortError')
        const bytes = value.status === 'ready' ? estimateReplayBytes(value.run) : 128
        if (bytes <= this.maxBytes) {
          this.entries.set(key, { value, bytes })
          this.bytes += bytes
          while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value
            if (!oldestKey) break
            const oldest = this.entries.get(oldestKey)!
            this.entries.delete(oldestKey)
            this.bytes -= oldest.bytes
          }
        }
        return value
      } finally {
        this.release()
      }
    })()
    this.pending.set(pendingKey, pending)
    try {
      return await pending
    } finally {
      if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey)
    }
  }
}
