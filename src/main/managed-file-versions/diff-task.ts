import { Worker } from 'node:worker_threads'

import {
  MANAGED_DIFF_MAX_OUTPUT_BYTES,
  MANAGED_DIFF_MAX_OUTPUT_LINES,
  type ManagedFileVersionDiffLine
} from '../../shared/managed-file-versions'
import { ManagedFileVersionError } from './service'

type DiffTask = { requestId: string; before: string; after: string }
type WorkerLike = {
  once(event: 'message', listener: (value: unknown) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}
type DiffWorkerResourceLimits = {
  maxOldGenerationSizeMb: number
  maxYoungGenerationSizeMb: number
  stackSizeMb: number
}
type DiffTaskRunnerOptions = {
  createWorker?: (task: DiffTask, resourceLimits: DiffWorkerResourceLimits) => WorkerLike
  timeoutMs?: number
}
const DEFAULT_DIFF_TASK_TIMEOUT_MS = 10_000
const DIFF_WORKER_RESOURCE_LIMITS: DiffWorkerResourceLimits = {
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  stackSizeMb: 2
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { diffChars, diffLines } = require('diff')
const run = () => {
const stripNewline = (value) => value.replace(/(?:\r\n|\n)$/u, '')
const splitChangedLines = (value) => value.length === 0 ? [] : value.match(/.*?(?:\r\n|\n|$)/gu).filter(Boolean).map(stripNewline)
const segmentsForPair = (before, after) => {
  const changes = diffChars(before, after)
  const removed = []
  const added = []
  for (const change of changes) {
    if (change.added) added.push({ kind: 'added', text: change.value })
    else if (change.removed) removed.push({ kind: 'removed', text: change.value })
    else {
      removed.push({ kind: 'context', text: change.value })
      added.push({ kind: 'context', text: change.value })
    }
  }
  return { removed, added }
}
let oldLine = 1
let newLine = 1
const lines = []
const changes = diffLines(workerData.before, workerData.after, { timeout: 9000, maxEditLength: 20000 })
if (!changes) {
  parentPort.postMessage({ error: 'DIFF_TIMEOUT' })
  return
}
let outputBytes = 2
const pushLine = (line) => {
  const nextBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') + (lines.length === 0 ? 0 : 1)
  if (lines.length + 1 > workerData.maxOutputLines || outputBytes + nextBytes > workerData.maxOutputBytes) {
    parentPort.postMessage({ error: 'DIFF_OUTPUT_LIMIT_EXCEEDED' })
    return false
  }
  lines.push(line)
  outputBytes += nextBytes
  return true
}
for (let index = 0; index < changes.length; index += 1) {
  const change = changes[index]
  const next = changes[index + 1]
  if (change.removed && next?.added) {
    const beforeLines = splitChangedLines(change.value)
    const afterLines = splitChangedLines(next.value)
    const pairCount = Math.max(beforeLines.length, afterLines.length)
    for (let pair = 0; pair < pairCount; pair += 1) {
      const before = beforeLines[pair]
      const after = afterLines[pair]
      if (before !== undefined && after !== undefined) {
        const segments = segmentsForPair(before, after)
        if (!pushLine({ kind: 'removed', oldLineNumber: oldLine++, segments: segments.removed })) return
        if (!pushLine({ kind: 'added', newLineNumber: newLine++, segments: segments.added })) return
      } else if (before !== undefined) { if (!pushLine({ kind: 'removed', oldLineNumber: oldLine++, segments: [{ kind: 'removed', text: before }] })) return }
      else if (after !== undefined) { if (!pushLine({ kind: 'added', newLineNumber: newLine++, segments: [{ kind: 'added', text: after }] })) return }
    }
    index += 1
    continue
  }
  for (const text of splitChangedLines(change.value)) {
    if (change.removed) { if (!pushLine({ kind: 'removed', oldLineNumber: oldLine++, segments: [{ kind: 'removed', text }] })) return }
    else if (change.added) { if (!pushLine({ kind: 'added', newLineNumber: newLine++, segments: [{ kind: 'added', text }] })) return }
    else if (!pushLine({ kind: 'context', oldLineNumber: oldLine++, newLineNumber: newLine++, segments: [{ kind: 'context', text }] })) return
  }
}
parentPort.postMessage(lines)
}
run()
`

class ManagedTextDiffTaskRunner {
  private readonly active = new Map<
    string,
    { worker: WorkerLike; reject: (error: ManagedFileVersionError) => void }
  >()

  constructor(private readonly options: DiffTaskRunnerOptions = {}) {}

  run(task: DiffTask): Promise<ManagedFileVersionDiffLine[]> {
    if (this.active.has(task.requestId)) {
      return Promise.reject(
        new ManagedFileVersionError('INVALID_REQUEST', 'Diff request id is already active.')
      )
    }
    const worker =
      this.options.createWorker?.(task, DIFF_WORKER_RESOURCE_LIMITS) ??
      new Worker(WORKER_SOURCE, {
        eval: true,
        resourceLimits: DIFF_WORKER_RESOURCE_LIMITS,
        workerData: {
          before: task.before,
          after: task.after,
          maxOutputLines: MANAGED_DIFF_MAX_OUTPUT_LINES,
          maxOutputBytes: MANAGED_DIFF_MAX_OUTPUT_BYTES
        }
      })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.active.delete(task.requestId)) return
        reject(new ManagedFileVersionError('DIFF_TIMEOUT', 'Diff task exceeded the time limit.'))
        void worker.terminate()
      }, this.options.timeoutMs ?? DEFAULT_DIFF_TASK_TIMEOUT_MS)
      const clear = (): boolean => {
        clearTimeout(timeout)
        return this.active.delete(task.requestId)
      }
      this.active.set(task.requestId, {
        worker,
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      worker.once('message', (value: unknown) => {
        clear()
        if (typeof value === 'object' && value !== null && 'error' in value) {
          const code = value.error === 'DIFF_OUTPUT_LIMIT_EXCEEDED' ? value.error : 'DIFF_TIMEOUT'
          reject(
            new ManagedFileVersionError(
              code,
              code === 'DIFF_TIMEOUT'
                ? 'Diff task exceeded the time limit.'
                : 'The complete diff exceeds the display limit.'
            )
          )
          return
        }
        const lines = value as ManagedFileVersionDiffLine[]
        if (
          lines.length > MANAGED_DIFF_MAX_OUTPUT_LINES ||
          Buffer.byteLength(JSON.stringify(lines), 'utf8') > MANAGED_DIFF_MAX_OUTPUT_BYTES
        ) {
          reject(
            new ManagedFileVersionError(
              'DIFF_OUTPUT_LIMIT_EXCEEDED',
              'The complete diff exceeds the display limit.'
            )
          )
          return
        }
        resolve(lines)
      })
      worker.once('error', (error: Error) => {
        if (!clear()) return
        reject(
          new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'Diff task failed.', {
            cause: error
          })
        )
      })
      worker.once('exit', (code: number) => {
        if (code === 0 || !clear()) return
        reject(
          new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'Diff task exited unexpectedly.')
        )
      })
    })
  }

  cancel(requestId: string): boolean {
    const active = this.active.get(requestId)
    if (!active) return false
    this.active.delete(requestId)
    active.reject(new ManagedFileVersionError('DIFF_CANCELLED', 'Diff request was cancelled.'))
    void active.worker.terminate()
    return true
  }
}

export { ManagedTextDiffTaskRunner }
export type { DiffTask, DiffTaskRunnerOptions }
