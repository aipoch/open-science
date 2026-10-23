import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_R_STAGE_CHECKPOINT_BYTES, validRStageEnvironmentProof } from '@aipoch/reproducibility'
import type {
  RStageCheckpointCapture,
  RStageCheckpointFile
} from '@aipoch/reproducibility/contracts'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookSessionExecutionResult } from './session-aggregate'

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

// Read from one descriptor, reject links/non-files and bound allocation even if a producer grows
// the file after stat. No path returned by R is ever used; only the host-created capture paths.
const readCheckpoint = async (path: string): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_R_STAGE_CHECKPOINT_BYTES)
      throw new Error('checkpoint-size-or-type')
    const bytes = Buffer.alloc(info.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size !== info.size) throw new Error('checkpoint-changed')
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}

const checkpointStorageDirectory = async (storageRoot: string): Promise<string> => {
  const canonicalRoot = await realpath(storageRoot)
  let directory = canonicalRoot
  for (const segment of ['runtime', 'provenance', 'r-stage-checkpoints']) {
    directory = join(directory, segment)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error('checkpoint-storage-directory-link')
  }
  return directory
}

export const publishRStageCheckpointBlob = async (
  storageRoot: string,
  bytes: Buffer
): Promise<RStageCheckpointFile> => {
  if (bytes.length <= 0 || bytes.length > MAX_R_STAGE_CHECKPOINT_BYTES)
    throw new Error('checkpoint-size-or-type')
  const checksum = digest(bytes)
  const storageKey = `runtime/provenance/r-stage-checkpoints/${checksum}.rds`
  const directory = await checkpointStorageDirectory(storageRoot)
  const path = join(directory, `${checksum}.rds`)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o400 })
    try {
      // A link publishes without overwriting an already captured immutable object.
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const persisted = await readCheckpoint(path)
    if (persisted.length !== bytes.length || digest(persisted) !== checksum)
      throw new Error('checkpoint-publication-checksum')
    return { storageKey, checksum, sizeBytes: bytes.length }
  } finally {
    await rm(temporary, { force: true })
  }
}

export type RStageCheckpointCaptureOwner = {
  paths: { inputPath: string; outputPath: string }
  seal(
    run: Pick<NotebookRunRecord, 'runId' | 'kernelEpochId' | 'script'>,
    result: NotebookSessionExecutionResult
  ): Promise<RStageCheckpointCapture>
  dispose(): Promise<void>
}

export const prepareRStageCheckpoint = async (
  notebookSessionRoot: string,
  storageRoot: string
): Promise<RStageCheckpointCaptureOwner> => {
  const parent = join(notebookSessionRoot, '.r-stage-checkpoints')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('checkpoint-directory-link')
  const root = await mkdtemp(join(parent, 'capture-'))
  const canonicalRoot = await realpath(root)
  const paths = { inputPath: join(root, 'input.rds'), outputPath: join(root, 'output.rds') }
  return {
    paths,
    seal: async (run, result) => {
      if (result.status !== 'completed')
        return { state: 'unavailable', reason: 'run-not-completed' }
      const capture = result.stageCheckpointCapture
      if (!capture || capture.state === 'unavailable')
        return capture ?? { state: 'unavailable', reason: 'checkpoint-response-missing' }
      if (
        capture.environmentProof !== undefined &&
        !validRStageEnvironmentProof(capture.environmentProof)
      )
        return { state: 'unavailable', reason: 'invalid-checkpoint-environment-proof' }
      const environmentProof = capture.environmentProof
        ? {
            schemaVersion: 1 as const,
            packages: capture.environmentProof.packages.map((pkg) => ({ ...pkg }))
          }
        : undefined
      if (!run.kernelEpochId || result.environmentLock?.state !== 'available')
        return { state: 'unavailable', reason: 'checkpoint-environment-lock-unavailable' }
      try {
        if ((await realpath(root)) !== canonicalRoot)
          throw new Error('checkpoint-directory-changed')
        const input = await publishRStageCheckpointBlob(
          storageRoot,
          await readCheckpoint(paths.inputPath)
        )
        const output = await publishRStageCheckpointBlob(
          storageRoot,
          await readCheckpoint(paths.outputPath)
        )
        return {
          state: 'available',
          schemaVersion: 1,
          runId: run.runId,
          kernelEpochId: run.kernelEpochId,
          sourceChecksum: digest(run.script),
          environmentLockChecksum: result.environmentLock.lockChecksum,
          input,
          output,
          inputNames: [...capture.inputNames],
          outputNames: [...capture.outputNames],
          ...(environmentProof ? { environmentProof } : {})
        }
      } catch {
        return { state: 'unavailable', reason: 'checkpoint-publication-failed' }
      }
    },
    dispose: () => rm(root, { recursive: true, force: true })
  }
}

// Replay accepts only the package executor's run-specific materialized paths. Caller-selected cwd,
// run identifiers or paths cannot redirect restoration to the live session or durable store.
export const assertRStageReplayPaths = async (
  sessionRoot: string,
  runId: string,
  stageRestore?: { inputPath: string; expectedOutputPath: string },
  stageExpectedOutputPath?: string,
  stageSupplement?: { inputPath: string; expectedOutputPath: string; names: string[] }
): Promise<void> => {
  if (!stageRestore && !stageExpectedOutputPath && !stageSupplement) return
  if ([stageRestore, stageExpectedOutputPath, stageSupplement].filter(Boolean).length !== 1)
    throw new Error('Conflicting R stage replay modes.')
  if (
    stageSupplement &&
    (!Array.isArray(stageSupplement.names) ||
      !stageSupplement.names.length ||
      stageSupplement.names.length > 4096 ||
      stageSupplement.names.some(
        (name) => typeof name !== 'string' || !name || name.length > 1024
      ) ||
      new Set(stageSupplement.names).size !== stageSupplement.names.length)
  )
    throw new Error('Invalid R stage supplement names.')
  const directory = join('.r-stage-checkpoints', digest(runId))
  const boundary = stageRestore ?? stageSupplement
  const expectedPaths: Array<[string, string]> = boundary
    ? [
        [boundary.inputPath, join(directory, 'input.rds')],
        [boundary.expectedOutputPath, join(directory, 'output.rds')]
      ]
    : [[stageExpectedOutputPath!, join(directory, 'output.rds')]]
  const canonicalRoot = await realpath(sessionRoot)
  for (const [supplied, relativePath] of expectedPaths) {
    const expected = join(sessionRoot, relativePath)
    if (supplied !== expected || (await realpath(expected)) !== join(canonicalRoot, relativePath))
      throw new Error('R stage replay path is outside its materialized Run.')
    const info = await lstat(expected)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_R_STAGE_CHECKPOINT_BYTES)
      throw new Error('Invalid materialized R stage checkpoint.')
  }
}

// Session-package import has already validated the document and stages bytes privately. Reuse the
// same bounded reader and immutable publication owner rather than introducing a second store writer.
export const installRStageCheckpointBlob = async (
  storageRoot: string,
  sourcePath: string,
  expected: RStageCheckpointFile
): Promise<RStageCheckpointFile> => {
  if (
    !/^[a-f0-9]{64}$/u.test(expected.checksum) ||
    expected.storageKey !== `runtime/provenance/r-stage-checkpoints/${expected.checksum}.rds` ||
    !Number.isSafeInteger(expected.sizeBytes) ||
    expected.sizeBytes <= 0 ||
    expected.sizeBytes > MAX_R_STAGE_CHECKPOINT_BYTES
  )
    throw new Error('Invalid imported R stage checkpoint metadata.')
  const bytes = await readCheckpoint(sourcePath)
  if (bytes.length !== expected.sizeBytes || digest(bytes) !== expected.checksum)
    throw new Error('Imported R stage checkpoint checksum mismatch.')
  return publishRStageCheckpointBlob(storageRoot, bytes)
}
