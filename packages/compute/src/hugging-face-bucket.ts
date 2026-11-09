import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'

type Connection = Readonly<{ bucket: string; runId: string; token: string; signal?: AbortSignal }>
type Output = Readonly<{ path: string; bytes?: number; sha256?: string; xetHash?: string }>
export type HuggingFaceArchivedFile = Readonly<{
  path: string
  localPath: string
  bytes: number
  sha256: string
  xetHash?: string
}>
type Inventory = Array<{ path: string; bytes: number; xetHash?: string }>
type CleanupSnapshot = {
  expectedInputs?: readonly Pick<HuggingFaceArchivedFile, 'path' | 'bytes' | 'sha256'>[]
  expectedOutputs?: readonly Omit<HuggingFaceArchivedFile, 'localPath'>[]
  discardedOutputs?: readonly { path: string; bytes: number; xetHash: string }[]
}
type Mount = { bucket: string; prefix: string }
type Mounts = { inputs: Mount; outputs: Mount }
export type BucketOperation =
  | { kind: 'stage'; files: readonly HuggingFaceArchivedFile[]; maxBytes: number }
  | { kind: 'list' }
  | { kind: 'archive'; files: readonly Output[]; maxBytes: number; directory: string }
  | ({ kind: 'cleanup' } & CleanupSnapshot)
export type BucketTask = Omit<Connection, 'signal'> & BucketOperation

async function runWorker<T>(connection: Connection, operation: BucketOperation): Promise<T> {
  const { signal, bucket, runId, token } = connection
  signal?.throwIfAborted()
  // A fresh module graph isolates the SDK's Xet write-token cache for every operation.
  const worker = new Worker(join(__dirname, 'hugging-face-bucket-worker.js'), {
    workerData: { bucket, runId, token, ...operation } satisfies BucketTask,
    execArgv: []
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('exit', () => {
        signal?.removeEventListener('abort', abort)
        reject(new Error('Hugging Face Bucket worker exited before completion.'))
      })
      worker.once('error', reject)
      worker.once('message', (reply: { result: T } | { error: string }) => {
        if ('error' in reply) reject(new Error(reply.error))
        else resolve(reply.result)
      })
    })
  } finally {
    await worker.terminate()
  }
}

export function stageHuggingFaceInputs(
  request: Connection & { files: readonly HuggingFaceArchivedFile[]; maxBytes: number }
): Promise<Mounts> {
  return runWorker(request, { kind: 'stage', files: request.files, maxBytes: request.maxBytes })
}

export function listHuggingFaceJobOutputs(request: Connection): Promise<Inventory> {
  return runWorker(request, { kind: 'list' })
}

/** stagingDirectory must be a private host-owned directory. Success transfers ownership of the staged files. */
export async function archiveHuggingFaceOutputs(
  request: Connection & {
    files: readonly Output[]
    maxBytes: number
    stagingDirectory: string
  }
): Promise<HuggingFaceArchivedFile[]> {
  request.signal?.throwIfAborted()
  if (!isAbsolute(request.stagingDirectory))
    throw new Error('An absolute staging directory is required.')
  if (!request.files.length) return []
  const directory = await mkdtemp(join(request.stagingDirectory, 'hf-archive-'))
  try {
    return await runWorker(request, {
      kind: 'archive',
      files: request.files,
      maxBytes: request.maxBytes,
      directory
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Pre-launch cancellation verifies the frozen inputs. Completed jobs use publication receipts. */
export function cleanupHuggingFaceBucketFiles(
  request: Connection & CleanupSnapshot
): Promise<void> {
  return runWorker(request, {
    kind: 'cleanup',
    expectedInputs: request.expectedInputs,
    expectedOutputs: request.expectedOutputs,
    discardedOutputs: request.discardedOutputs
  })
}
