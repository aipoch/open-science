import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  parseOwnedExecutionFileEvidenceSummary,
  type ExecutionActivityKind,
  type ExecutionFileEvidenceCoverage,
  type ExecutionFileEvidenceReason,
  type ExecutionFileEvidenceSummary,
  type ScientificOutputEvidence
} from '../../shared/execution-file-evidence'
import type { ComputeJob } from '../../shared/compute'
import type { NotebookRunRecord, NotebookWorkingFile } from '../../shared/notebook'
import { assertDiskReserve } from '../bounded-file-io'
import { createLogger, diagnosticErrorFields } from '../logger'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { availableBytes } from '../storage/usage'
import { analyzeScientificOutputs } from './scientific-output-analysis'
import { createRootNotebookLane } from './lane-identity'
import { getNotebookFileEvidenceLocation } from './repository'

const log = createLogger('notebook:file-evidence')

type WorkingFileObservationRequest = {
  dataRoot: string
  notebookSessionRoot: string
  fileEvidenceStorageRoot?: string
  fileEvidenceRoot?: string
  fileEvidenceStoragePrefix?: string
  runId?: string
  signal?: AbortSignal
}

type WorkingFileObservationResult = {
  workingFiles: NotebookWorkingFile[]
  fileEvidence: ExecutionFileEvidenceSummary
}

type WorkingFileObservation = {
  finish: (signal?: AbortSignal) => Promise<WorkingFileObservationResult>
}

type WorkingFileObservationDependencies = {
  watchDirectory?: typeof watch
  createId?: () => string
  now?: () => number
  maxGenerationBytes?: number
  maxActivityBytes?: number
  maxEvidenceBytes?: number
  diskReserveBytes?: number
  evidenceQueueTimeoutMs?: number
  getAvailableBytes?: typeof availableBytes
  runEvidenceWorker?: typeof runEvidenceWorker
}

type ActiveObservation = { conflicted: boolean }
type SnapshotEntry = Omit<NotebookWorkingFile, 'size' | 'mtimeMs'> & {
  size: number
  mtimeMs: number
  physicalPath: string
  dev: number
  ino: number
  ctimeMs: number
}
type SnapshotCapture =
  | { state: 'available'; files: Map<string, SnapshotEntry> }
  | { state: 'unavailable'; reason: ExecutionFileEvidenceReason }
type ObservedFileChange = {
  relation: 'created' | 'modified' | 'deleted'
  relativePath: string
  before?: SnapshotEntry
  after?: SnapshotEntry
}
type RootObservationResult = {
  changes: ObservedFileChange[]
  reasonCodes: ExecutionFileEvidenceReason[]
  available: boolean
}
type RootObservation = {
  initialFiles: readonly SnapshotEntry[]
  initialAvailable: boolean
  finish: () => Promise<RootObservationResult>
}
type FileIdentity = { dev: number; ino: number }
type EvidenceWorkerBlobPoolBinding = {
  blobRoot: string
  expectedBlobRootIdentity: FileIdentity
  blobStorageKeyPrefix: string
}
type EvidenceWorkerBeginRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'begin'
  expectedRootIdentity: FileIdentity
  receiptName: string
  stagingName: string
  finalName: string
  activityId: string
  activityKind: ExecutionActivityKind
  parentActivityId?: string
  evidenceId: string
  storageKeyPrefix: string
  initialViewState: ExecutionFileEvidenceCoverage
  initialFiles: Array<{
    file: SnapshotEntry
    generation: { generationId: string; capturedAt: string }
    relation?: 'present-before' | 'staged-input'
  }>
  maxGenerationBytes: number
  maxActivityBytes: number
  maxEvidenceBytes: number
  diskReserveBytes: number
  availableBytes: number
  captureCancelled: boolean
}
type EvidenceWorkerEnsureCaptureRequest = Omit<EvidenceWorkerBeginRequest, 'operation'> & {
  operation: 'ensure-capture'
}
type EvidenceWorkerPersistRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'persist'
  expectedRootIdentity: FileIdentity
  receiptName: string
  stagingName: string
  finalName: string
  activityId: string
  activityKind: ExecutionActivityKind
  parentActivityId?: string
  evidenceId: string
  storageKeyPrefix: string
  rootKinds: Array<'data' | 'handoff'>
  rootsAvailable: boolean
  evidenceState?: ExecutionFileEvidenceSummary['state']
  reasonCodes: ExecutionFileEvidenceReason[]
  scientificOutputs: ScientificOutputEvidence[]
  changes: Array<{
    change: {
      relation: ObservedFileChange['relation'] | 'harvested-output' | 'remote-input-reference'
      relativePath: string
      before?: SnapshotEntry
      after?: SnapshotEntry
      pathPortability?: 'relative' | 'absolute'
      authority?: 'advisory' | 'explicit-transfer'
    }
    generation: { generationId: string; capturedAt: string }
  }>
  maxGenerationBytes: number
  maxActivityBytes: number
  maxEvidenceBytes: number
  diskReserveBytes: number
  availableBytes: number
  captureCancelled: boolean
}
type EvidenceWorkerRecoverPublishedRequest = Omit<EvidenceWorkerPersistRequest, 'operation'> & {
  operation: 'recover-published'
}
type EvidenceWorkerCompleteRequest = {
  operation: 'complete'
  expectedRootIdentity: FileIdentity
  receiptName: string
  finalName: string
  activityId: string
  activityKind: ExecutionActivityKind
  parentActivityId?: string
  evidenceId: string
  checksum: string
  storageKey: string
}
type EvidenceWorkerReconcileRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'reconcile'
  expectedRootIdentity: FileIdentity
  deferredActivityKinds: ExecutionActivityKind[]
  deferredActivityIds: string[]
  retained: Array<{
    receiptName: string
    finalName: string
    activityId: string
    activityKind: ExecutionActivityKind
    parentActivityId?: string
    evidenceId: string
    checksum: string
    storageKey: string
  }>
}
type EvidenceWorkerCleanupRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'cleanup'
  expectedRootIdentity: FileIdentity
  receiptName: string
  preservePublished?: boolean
}
type EvidenceWorkerDeleteProjectRequest = {
  operation: 'delete-project'
  expectedRootIdentity: FileIdentity
  projectName: string
}
type EvidenceWorkerEnsureProjectRequest = {
  operation: 'ensure-project'
  expectedRootIdentity: FileIdentity
  projectName: string
}
type EvidenceWorkerRequest =
  | EvidenceWorkerBeginRequest
  | EvidenceWorkerEnsureCaptureRequest
  | EvidenceWorkerPersistRequest
  | EvidenceWorkerRecoverPublishedRequest
  | EvidenceWorkerCompleteRequest
  | EvidenceWorkerReconcileRequest
  | EvidenceWorkerCleanupRequest
  | EvidenceWorkerDeleteProjectRequest
  | EvidenceWorkerEnsureProjectRequest
type EvidenceWorkerResult =
  | {
      ok: true
      capturedInitialGenerations: number
      initialGenerations?: Array<{
        relativePath: string
        generationId: string
        checksum: string
        sizeBytes: number
      }>
    }
  | { ok: true; captureReady: true; initialized: boolean }
  | { ok: true; recoveredFileEvidence: ExecutionFileEvidenceSummary | null }
  | {
      ok: true
      generations: Array<{ path: string; generationId: string; checksum: string }>
      fileEvidence: ExecutionFileEvidenceSummary
    }
  | {
      ok: true
      removedStagingEntries: number
      removedActivityEntries: number
      removedBlobEntries?: number
    }
  | { ok: true; removedProjectEntries: number }
  | { ok: true; projectOwned: true }

type ActiveEvidenceCapture = {
  evidenceRoot: { path: string; identity: FileIdentity }
  receiptName: string
  stagingName: string
  finalName: string
  evidenceId: string
  activityId: string
  activityKind: ExecutionActivityKind
  parentActivityId?: string
  storageKeyPrefix: string
  blobRoot: { path: string; identity: FileIdentity }
  blobStorageKeyPrefix: string
  maxGenerationBytes: number
  maxActivityBytes: number
  maxEvidenceBytes: number
  diskReserveBytes: number
}

const activeByObservedRoot = new Map<string, Set<ActiveObservation>>()
let reservedDiskBytes = 0
const MAX_CHANGED_PATHS = 10_000
const MAX_FALLBACK_SNAPSHOT_ENTRIES = 50_000
const EVENT_SETTLE_MS = 20
const WATCHER_READY_MS = 5
const MAX_WORKER_OUTPUT_BYTES = 16 * 1024 * 1024
const EVIDENCE_WORKER_TIMEOUT_MS = 10 * 60 * 1000
const EVIDENCE_QUEUE_TIMEOUT_MS = 5_000
const SAFE_ACTIVITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const EXECUTION_FILE_EVIDENCE_DIR = 'execution-file-evidence'
const BASELINE_REASON_CODES: ExecutionFileEvidenceReason[] = [
  'file-reads-not-observed',
  'external-paths-not-observed',
  'remote-outputs-not-observed',
  'transient-files-not-captured',
  'delayed-writes-not-observed',
  'writer-not-isolated'
]

class SnapshotEntryLimitError extends Error {}
class UnsafeEvidencePathError extends Error {}

const isPathInside = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

const toPortableNotebookRelativePath = (path: string, hostSeparator = sep): string =>
  hostSeparator === '/' ? path : path.split(hostSeparator).join('/')

const uniqueReasons = (
  reasons: readonly ExecutionFileEvidenceReason[]
): ExecutionFileEvidenceReason[] => [...new Set(reasons)].sort()

const unavailableEvidence = (
  reasons: readonly ExecutionFileEvidenceReason[],
  activityId?: string,
  activityKind: ExecutionActivityKind = 'notebook-run',
  parentActivityId?: string
): ExecutionFileEvidenceSummary => ({
  schemaVersion: 1,
  ...(activityId ? { activityId } : {}),
  activityKind,
  ...(parentActivityId ? { parentActivityId } : {}),
  state: 'unavailable',
  scientificOutputCount: 0,
  initialViewState: 'unavailable',
  managedRootsFinalState: 'unavailable',
  scientificOutputAnalysis: 'unavailable',
  fileReads: 'unavailable',
  externalPaths: 'unavailable',
  writerAttribution: 'unavailable',
  reasonCodes: uniqueReasons([...BASELINE_REASON_CODES, ...reasons])
})

const isExistingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'EEXIST'

const assertRealDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new UnsafeEvidencePathError(`Unsafe Execution file-evidence directory: ${path}`)
  }
}

const ensureRealDirectory = async (path: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isExistingPathError(error)) throw error
  }
  await assertRealDirectory(path)
}

const directoryIdentity = async (path: string): Promise<FileIdentity> => {
  const metadata = await stat(path)
  if (!metadata.isDirectory()) throw new UnsafeEvidencePathError(`Not a directory: ${path}`)
  return { dev: metadata.dev, ino: metadata.ino }
}

const assertEvidenceRootIdentity = async (path: string, expected: FileIdentity): Promise<void> => {
  await assertRealDirectory(path)
  const actual = await directoryIdentity(path)
  if (
    (await realpath(path)) !== path ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new UnsafeEvidencePathError('Execution file-evidence root identity changed.')
  }
}

const secureEvidenceRoot = async (
  storageRoot: string,
  requestedEvidenceRoot: string
): Promise<{ path: string; identity: FileIdentity }> => {
  const resolvedStorageRoot = resolve(storageRoot)
  await assertRealDirectory(resolvedStorageRoot)
  const canonicalStorageRoot = await realpath(resolvedStorageRoot)
  const nested = relative(resolvedStorageRoot, resolve(requestedEvidenceRoot))
  if (nested === '' || isAbsolute(nested) || nested === '..' || nested.startsWith(`..${sep}`)) {
    throw new UnsafeEvidencePathError('Execution file-evidence root escapes app storage.')
  }
  let evidenceRoot = canonicalStorageRoot
  for (const segment of nested.split(sep)) {
    evidenceRoot = join(evidenceRoot, segment)
    await ensureRealDirectory(evidenceRoot)
    if ((await realpath(evidenceRoot)) !== evidenceRoot) {
      throw new UnsafeEvidencePathError('Execution file-evidence root resolves through a symlink.')
    }
  }
  return { path: evidenceRoot, identity: await directoryIdentity(evidenceRoot) }
}

const stripUnpublishedGenerations = (workingFiles: NotebookWorkingFile[]): NotebookWorkingFile[] =>
  workingFiles.map((file) => {
    const unpublished = { ...file }
    delete unpublished.generationId
    delete unpublished.checksum
    return unpublished
  })

const resolveEvidenceWorkerPath = (): string => {
  const candidates = [
    process.resourcesPath &&
      join(
        process.resourcesPath,
        'app.asar.unpacked',
        'resources',
        'notebook',
        'file_evidence_worker.js'
      ),
    process.resourcesPath &&
      join(process.resourcesPath, 'resources', 'notebook', 'file_evidence_worker.js'),
    join(__dirname, '../../resources/notebook/file_evidence_worker.js'),
    join(__dirname, '../../../resources/notebook/file_evidence_worker.js')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!
}

export const runEvidenceWorker = async (
  evidenceRoot: string,
  request: EvidenceWorkerRequest,
  signal?: AbortSignal
): Promise<EvidenceWorkerResult> =>
  new Promise((resolveResult, rejectResult) => {
    signal?.throwIfAborted()
    const child = spawn(process.execPath, [resolveEvidenceWorkerPath()], {
      cwd: evidenceRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let outputExceeded = false
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectResult(error)
    }
    const resolveOnce = (result: EvidenceWorkerResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveResult(result)
    }
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next) > MAX_WORKER_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill('SIGKILL')
      }
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    const abort = (): void => {
      child.kill('SIGKILL')
      rejectOnce(signal?.reason ?? new Error('File-evidence worker aborted.'))
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectOnce(new Error('File-evidence worker timed out.'))
    }, EVIDENCE_WORKER_TIMEOUT_MS)
    timeout.unref()
    child.once('error', rejectOnce)
    child.stdin.once('error', rejectOnce)
    child.once('close', (code) => {
      if (settled) return
      if (signal?.aborted) {
        rejectOnce(signal.reason)
        return
      }
      if (outputExceeded) {
        rejectOnce(new Error('File-evidence worker output exceeded its limit.'))
        return
      }
      let result: EvidenceWorkerResult | { ok: false; error?: string }
      try {
        result = JSON.parse(stdout.trim()) as EvidenceWorkerResult | { ok: false; error?: string }
      } catch {
        rejectOnce(new Error(`File-evidence worker returned invalid output: ${stderr.trim()}`))
        return
      }
      if (code !== 0 || !result.ok) {
        rejectOnce(new Error(!result.ok ? result.error : stderr.trim()))
        return
      }
      resolveOnce(result)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    child.stdin.end(JSON.stringify(request))
  })

type WorkingFileEvidenceLocation = {
  storageRoot: string
  root: string
  storageKeyPrefix: string
}

const receiptNameForActivity = (activityId: string): string => `receipt-${activityId}.json`
const finalNameForActivity = (activityId: string): string => `activity-${activityId}`

const ensureProjectPromises = new Map<string, Promise<void>>()
let evidenceMutationTail = Promise.resolve()

const waitForEvidenceMutationTurn = async (
  previous: Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<void> =>
  new Promise((resolveTurn, rejectTurn) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const resolveOnce = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveTurn()
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectTurn(error)
    }
    const abort = (): void =>
      rejectOnce(signal?.reason ?? new Error('File-evidence queue aborted.'))
    const timeout = setTimeout(
      () => rejectOnce(new Error('File-evidence queue wait timed out.')),
      timeoutMs
    )
    timeout.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    previous.catch(() => undefined).then(resolveOnce)
  })

const runSerializedEvidenceWorker = async (
  worker: typeof runEvidenceWorker,
  evidenceRoot: string,
  request: EvidenceWorkerRequest,
  signal?: AbortSignal,
  timeoutMs = EVIDENCE_QUEUE_TIMEOUT_MS
): Promise<EvidenceWorkerResult> => {
  const previous = evidenceMutationTail
  let release!: () => void
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn
  })
  const tail = previous.catch(() => undefined).then(() => turn)
  evidenceMutationTail = tail
  try {
    await waitForEvidenceMutationTurn(previous, signal, timeoutMs)
    return await worker(evidenceRoot, request, signal)
  } finally {
    release()
    if (evidenceMutationTail === tail) evidenceMutationTail = Promise.resolve()
  }
}

const ensureWorkingFileEvidenceProject = async (
  storageRoot: string,
  projectId: string,
  worker: typeof runEvidenceWorker = runEvidenceWorker
): Promise<void> => {
  if (!SAFE_ACTIVITY_ID.test(projectId))
    throw new Error('Unsafe Execution file-evidence Project ID.')
  const evidenceRoot = await secureEvidenceRoot(
    storageRoot,
    join(storageRoot, EXECUTION_FILE_EVIDENCE_DIR)
  )
  const key = `${evidenceRoot.path}\0${projectId}`
  const existing = ensureProjectPromises.get(key)
  if (existing) return existing
  const ensuring = runSerializedEvidenceWorker(worker, evidenceRoot.path, {
    operation: 'ensure-project',
    expectedRootIdentity: evidenceRoot.identity,
    projectName: projectId
  }).then((result) => {
    if (!('projectOwned' in result)) {
      throw new Error('File-evidence Project ownership returned an invalid result.')
    }
  })
  ensureProjectPromises.set(key, ensuring)
  try {
    await ensuring
  } finally {
    ensureProjectPromises.delete(key)
  }
}

const projectEvidenceScope = (
  storageRoot: string,
  evidenceRoot: string,
  storageKeyPrefix: string
): { projectId: string; projectRoot: string; blobStorageKeyPrefix: string } | undefined => {
  const segments = storageKeyPrefix.split('/')
  // An exact root prefix is used by the isolated adapter/tests. Production Project-owned
  // locations always include both Project and session segments.
  if (segments[0] !== EXECUTION_FILE_EVIDENCE_DIR || segments.length < 3) return undefined
  const projectId = segments[1]
  if (!projectId || !SAFE_ACTIVITY_ID.test(projectId)) {
    throw new Error('Unsafe Execution file-evidence Project storage prefix.')
  }
  const projectRoot = join(storageRoot, EXECUTION_FILE_EVIDENCE_DIR, projectId)
  if (!isPathInside(projectRoot, resolve(evidenceRoot))) {
    throw new Error('Execution file-evidence root does not match its Project storage prefix.')
  }
  return {
    projectId,
    projectRoot,
    blobStorageKeyPrefix: `${EXECUTION_FILE_EVIDENCE_DIR}/${projectId}/blobs`
  }
}

const deleteWorkingFileEvidenceProject = async (
  storageRoot: string,
  projectId: string
): Promise<void> => {
  if (!SAFE_ACTIVITY_ID.test(projectId))
    throw new Error('Unsafe Execution file-evidence Project ID.')
  const root = await secureEvidenceRoot(storageRoot, join(storageRoot, EXECUTION_FILE_EVIDENCE_DIR))
  const result = await runSerializedEvidenceWorker(
    runEvidenceWorker,
    root.path,
    {
      operation: 'delete-project',
      expectedRootIdentity: root.identity,
      projectName: projectId
    },
    undefined,
    EVIDENCE_WORKER_TIMEOUT_MS
  )
  if (!('removedProjectEntries' in result)) {
    throw new Error('File-evidence Project deletion returned an invalid result.')
  }
}

const completeWorkingFileEvidence = async (
  location: WorkingFileEvidenceLocation,
  run: Pick<NotebookRunRecord, 'runId' | 'fileEvidence'>
): Promise<void> => {
  const evidence = run.fileEvidence
  if (
    !SAFE_ACTIVITY_ID.test(run.runId) ||
    evidence?.activityId !== run.runId ||
    evidence.activityKind !== 'notebook-run' ||
    !evidence?.evidenceId ||
    !evidence.checksum ||
    !evidence.storageKey
  ) {
    return
  }
  const finalName = finalNameForActivity(run.runId)
  if (evidence.storageKey !== `${location.storageKeyPrefix}/${finalName}/evidence.json`) return
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'complete',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(run.runId),
    finalName,
    activityId: run.runId,
    activityKind: 'notebook-run',
    evidenceId: evidence.evidenceId,
    checksum: evidence.checksum,
    storageKey: evidence.storageKey
  })
  if (!('removedStagingEntries' in result)) {
    throw new Error('File-evidence completion returned an invalid result.')
  }
}

const reconcileEvidenceReceipts = async (
  location: WorkingFileEvidenceLocation,
  retained: EvidenceWorkerReconcileRequest['retained'],
  deferredActivityKinds: ExecutionActivityKind[],
  deferredActivityIds: string[]
): Promise<{ removedStagingEntries: number; removedActivityEntries: number }> => {
  const projectScope = projectEvidenceScope(
    location.storageRoot,
    location.root,
    location.storageKeyPrefix
  )
  if (projectScope) {
    await ensureWorkingFileEvidenceProject(location.storageRoot, projectScope.projectId)
  }
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const blobRoot = await secureEvidenceRoot(
    location.storageRoot,
    projectScope
      ? join(projectScope.projectRoot, 'blobs')
      : join(location.storageRoot, 'execution-file-evidence-blobs')
  )
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'reconcile',
    expectedRootIdentity: evidenceRoot.identity,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope?.blobStorageKeyPrefix ?? 'execution-file-evidence-blobs',
    deferredActivityKinds,
    deferredActivityIds,
    retained
  })
  if (!('removedStagingEntries' in result)) {
    throw new Error('File-evidence reconciliation returned an invalid result.')
  }
  return {
    removedStagingEntries: result.removedStagingEntries,
    removedActivityEntries: result.removedActivityEntries
  }
}

const reconcileWorkingFileEvidence = async (
  location: WorkingFileEvidenceLocation,
  runs: readonly Pick<NotebookRunRecord, 'runId' | 'fileEvidence'>[]
): Promise<{ removedStagingEntries: number; removedActivityEntries: number }> => {
  const retainedNotebookRuns: EvidenceWorkerReconcileRequest['retained'] = runs.flatMap((run) => {
    const evidence = run.fileEvidence
    if (
      !SAFE_ACTIVITY_ID.test(run.runId) ||
      evidence?.activityId !== run.runId ||
      evidence.activityKind !== 'notebook-run' ||
      !evidence?.evidenceId ||
      !evidence.checksum ||
      !evidence.storageKey
    ) {
      return []
    }
    const finalName = finalNameForActivity(run.runId)
    if (evidence.storageKey !== `${location.storageKeyPrefix}/${finalName}/evidence.json`) return []
    return [
      {
        receiptName: receiptNameForActivity(run.runId),
        finalName,
        activityId: run.runId,
        activityKind: 'notebook-run' as const,
        evidenceId: evidence.evidenceId,
        checksum: evidence.checksum,
        storageKey: evidence.storageKey
      }
    ]
  })
  return reconcileEvidenceReceipts(
    location,
    retainedNotebookRuns,
    // Notebook recovery cannot prove whether an unreferenced asynchronous Compute Job is still
    // queued or running. Its lifecycle owner cleans failures; Project deletion owns final removal.
    ['compute-job'],
    []
  )
}

type ComputeJobFileEvidenceRecord = Pick<
  ComputeJob,
  | 'job_id'
  | 'project_id'
  | 'session_id'
  | 'producer_run_id'
  | 'file_evidence'
  | 'status'
  | 'harvested_at'
>

const reconcileComputeJobFileEvidence = async (
  storageRoot: string,
  jobs: readonly ComputeJobFileEvidenceRecord[]
): Promise<{ removedStagingEntries: number; removedActivityEntries: number }> => {
  const sessions = new Map<
    string,
    { location: WorkingFileEvidenceLocation; jobs: ComputeJobFileEvidenceRecord[] }
  >()
  const includeSession = (projectId: string, sessionId: string): void => {
    if (!SAFE_ACTIVITY_ID.test(projectId) || !SAFE_ACTIVITY_ID.test(sessionId)) {
      throw new Error('Unsafe Compute Job file-evidence owner.')
    }
    const key = JSON.stringify([projectId, sessionId])
    if (!sessions.has(key)) {
      sessions.set(key, {
        location: computeEvidenceLocation(storageRoot, projectId, sessionId),
        jobs: []
      })
    }
  }

  for (const job of jobs) {
    includeSession(job.project_id, job.session_id)
    sessions.get(JSON.stringify([job.project_id, job.session_id]))!.jobs.push(job)
  }

  const root = await secureEvidenceRoot(storageRoot, join(storageRoot, EXECUTION_FILE_EVIDENCE_DIR))
  for (const projectEntry of await readdir(root.path, { withFileTypes: true })) {
    if (projectEntry.isSymbolicLink()) {
      throw new UnsafeEvidencePathError('Execution file-evidence Project is a symlink.')
    }
    if (!projectEntry.isDirectory()) continue
    if (!SAFE_ACTIVITY_ID.test(projectEntry.name)) {
      throw new UnsafeEvidencePathError('Execution file-evidence Project name is unsafe.')
    }
    if (!existsSync(join(root.path, `.project-ownership-${projectEntry.name}.json`))) {
      // Project deletion tombstones are directories too, but only a live Project directory has a
      // matching ownership receipt keyed by the directory name.
      continue
    }
    const projectRoot = join(root.path, projectEntry.name)
    for (const sessionEntry of await readdir(projectRoot, { withFileTypes: true })) {
      if (sessionEntry.name === 'blobs' || !sessionEntry.isDirectory()) {
        if (sessionEntry.isSymbolicLink()) {
          throw new UnsafeEvidencePathError('Execution file-evidence Session is a symlink.')
        }
        continue
      }
      if (!SAFE_ACTIVITY_ID.test(sessionEntry.name)) {
        throw new UnsafeEvidencePathError('Execution file-evidence Session name is unsafe.')
      }
      includeSession(projectEntry.name, sessionEntry.name)
    }
  }

  let removedStagingEntries = 0
  let removedActivityEntries = 0
  for (const { location, jobs: sessionJobs } of sessions.values()) {
    const retained: EvidenceWorkerReconcileRequest['retained'] = []
    const deferredActivityIds: string[] = []
    for (const job of sessionJobs) {
      const evidence = job.file_evidence
      const finalName = finalNameForActivity(job.job_id)
      if (
        evidence?.activityId === job.job_id &&
        evidence.activityKind === 'compute-job' &&
        evidence.parentActivityId === job.producer_run_id &&
        evidence.evidenceId &&
        evidence.checksum &&
        evidence.storageKey === `${location.storageKeyPrefix}/${finalName}/evidence.json`
      ) {
        retained.push({
          receiptName: receiptNameForActivity(job.job_id),
          finalName,
          activityId: job.job_id,
          activityKind: 'compute-job',
          ...(job.producer_run_id ? { parentActivityId: job.producer_run_id } : {}),
          evidenceId: evidence.evidenceId,
          checksum: evidence.checksum,
          storageKey: evidence.storageKey
        })
      } else {
        const mayStillPublishEvidence = job.status !== 'error' && job.harvested_at === undefined
        if (mayStillPublishEvidence) deferredActivityIds.push(job.job_id)
      }
    }
    const result = await reconcileEvidenceReceipts(
      location,
      retained,
      ['notebook-run'],
      deferredActivityIds
    )
    removedStagingEntries += result.removedStagingEntries
    removedActivityEntries += result.removedActivityEntries
  }
  return { removedStagingEntries, removedActivityEntries }
}

const registerObservation = (
  observedRoot: string,
  observation: ActiveObservation
): (() => void) => {
  const active = activeByObservedRoot.get(observedRoot) ?? new Set<ActiveObservation>()
  if (active.size > 0) {
    observation.conflicted = true
    for (const existing of active) existing.conflicted = true
  }
  active.add(observation)
  activeByObservedRoot.set(observedRoot, active)
  return () => {
    active.delete(observation)
    if (active.size === 0) activeByObservedRoot.delete(observedRoot)
  }
}

const settleWatcherEvents = (): Promise<void> =>
  new Promise((resolveSettled) => setTimeout(resolveSettled, EVENT_SETTLE_MS))
const waitForWatcherReady = (): Promise<void> =>
  new Promise((resolveReady) => setTimeout(resolveReady, WATCHER_READY_MS))

const snapshotEntry = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string,
  candidatePath: string
): Promise<SnapshotEntry | undefined> => {
  const linkMetadata = await lstat(candidatePath)
  if (linkMetadata.isSymbolicLink()) return undefined
  const canonicalPath = await realpath(candidatePath)
  if (!isPathInside(observedRoot, canonicalPath)) return undefined
  const metadata = await stat(canonicalPath)
  if (!metadata.isFile()) return undefined
  const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, canonicalPath))
  return {
    physicalPath: canonicalPath,
    path: logicalPath,
    relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
    kind: 'other',
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino
  }
}

const captureSnapshot = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string
): Promise<SnapshotCapture> => {
  try {
    const files = new Map<string, SnapshotEntry>()
    let entriesSeen = 0
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        entriesSeen += 1
        if (entriesSeen > MAX_FALLBACK_SNAPSHOT_ENTRIES) throw new SnapshotEntryLimitError()
        const candidatePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(candidatePath)
          continue
        }
        if (!entry.isFile()) continue
        const file = await snapshotEntry(
          observedRoot,
          logicalObservedRoot,
          logicalSessionRoot,
          candidatePath
        )
        if (file) files.set(file.path, file)
      }
    }
    await visit(observedRoot)
    return { state: 'available', files }
  } catch (error) {
    return {
      state: 'unavailable',
      reason:
        error instanceof SnapshotEntryLimitError ? 'observer-limit-exceeded' : 'observer-failed'
    }
  }
}

const sameSnapshotEntry = (left: SnapshotEntry, right: SnapshotEntry): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const diffSnapshots = (
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>
): ObservedFileChange[] => {
  const changes: ObservedFileChange[] = []
  for (const [path, current] of after) {
    const previous = before.get(path)
    if (!previous) {
      changes.push({ relation: 'created', relativePath: current.relativePath, after: current })
    } else if (!sameSnapshotEntry(previous, current)) {
      changes.push({
        relation: 'modified',
        relativePath: current.relativePath,
        before: previous,
        after: current
      })
    }
  }
  for (const [path, previous] of before) {
    if (!after.has(path)) {
      changes.push({ relation: 'deleted', relativePath: previous.relativePath, before: previous })
    }
  }
  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

const fallbackObservation = (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string,
  before: ReadonlyMap<string, SnapshotEntry>,
  reasonCodes: readonly ExecutionFileEvidenceReason[],
  lifecycle?: { active: ActiveObservation; unregister: () => void }
): RootObservation => {
  let finished = false
  return {
    initialFiles: [...before.values()],
    initialAvailable: true,
    finish: async () => {
      if (finished) {
        return { changes: [], reasonCodes: ['observer-failed'], available: false }
      }
      finished = true
      if (lifecycle?.active.conflicted) {
        lifecycle.unregister()
        return { changes: [], reasonCodes: ['observer-conflict'], available: false }
      }
      const after = await captureSnapshot(observedRoot, logicalObservedRoot, logicalSessionRoot)
      const conflicted = lifecycle?.active.conflicted ?? false
      lifecycle?.unregister()
      if (conflicted) {
        return { changes: [], reasonCodes: ['observer-conflict'], available: false }
      }
      if (after.state === 'unavailable') {
        return {
          changes: [],
          reasonCodes: uniqueReasons([...reasonCodes, after.reason]),
          available: false
        }
      }
      return {
        changes: diffSnapshots(before, after.files),
        reasonCodes: uniqueReasons(reasonCodes),
        available: true
      }
    }
  }
}

const startRootObservation = async (
  rootPath: string,
  logicalRootPath: string,
  logicalSessionRootPath: string,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<RootObservation> => {
  let watcher: FSWatcher | undefined
  try {
    const logicalObservedRoot = resolve(logicalRootPath)
    const logicalSessionRoot = resolve(logicalSessionRootPath)
    const [observedRoot, sessionRoot] = await Promise.all([
      realpath(rootPath),
      realpath(logicalSessionRootPath)
    ])
    if (!isPathInside(sessionRoot, observedRoot)) {
      return {
        initialFiles: [],
        initialAvailable: false,
        finish: async () => ({ changes: [], reasonCodes: ['observer-failed'], available: false })
      }
    }

    const active: ActiveObservation = { conflicted: false }
    const changedPaths = new Set<string>()
    let watcherUnavailable = false
    let watcherLimitExceeded = false
    let finished = false
    try {
      watcher = (dependencies.watchDirectory ?? watch)(
        observedRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (watcherUnavailable || watcherLimitExceeded) return
          if (!filename) {
            watcherUnavailable = true
            return
          }
          const eventPath = filename.toString()
          if (isAbsolute(eventPath)) {
            watcherUnavailable = true
            return
          }
          const candidatePath = resolve(observedRoot, eventPath)
          if (!isPathInside(observedRoot, candidatePath)) {
            watcherUnavailable = true
            return
          }
          if (changedPaths.size >= MAX_CHANGED_PATHS) {
            watcherLimitExceeded = true
            return
          }
          changedPaths.add(candidatePath)
        }
      )
      watcher.on('error', () => {
        watcherUnavailable = true
      })
      await waitForWatcherReady()
    } catch {
      watcherUnavailable = true
    }

    changedPaths.clear()
    const before = await captureSnapshot(observedRoot, logicalObservedRoot, logicalSessionRoot)
    if (before.state === 'unavailable') {
      watcher?.close()
      return {
        initialFiles: [],
        initialAvailable: false,
        finish: async () => ({ changes: [], reasonCodes: [before.reason], available: false })
      }
    }
    if (watcherUnavailable || watcherLimitExceeded || !watcher) {
      watcher?.close()
      const unregister = registerObservation(observedRoot, active)
      return fallbackObservation(
        observedRoot,
        logicalObservedRoot,
        logicalSessionRoot,
        before.files,
        [
          ...(watcherUnavailable || !watcher ? (['watcher-unavailable'] as const) : []),
          ...(watcherLimitExceeded ? (['observer-limit-exceeded'] as const) : [])
        ],
        { active, unregister }
      )
    }

    const unregister = registerObservation(observedRoot, active)
    return {
      initialFiles: [...before.files.values()],
      initialAvailable: true,
      finish: async () => {
        if (finished) {
          return { changes: [], reasonCodes: ['observer-failed'], available: false }
        }
        finished = true
        if (!active.conflicted) await settleWatcherEvents()
        watcher?.close()
        if (active.conflicted) {
          unregister()
          return { changes: [], reasonCodes: ['observer-conflict'], available: false }
        }
        if (watcherUnavailable || watcherLimitExceeded) {
          return fallbackObservation(
            observedRoot,
            logicalObservedRoot,
            logicalSessionRoot,
            before.files,
            [
              ...(watcherUnavailable ? (['watcher-unavailable'] as const) : []),
              ...(watcherLimitExceeded ? (['observer-limit-exceeded'] as const) : [])
            ],
            { active, unregister }
          ).finish()
        }

        try {
          const changes: ObservedFileChange[] = []
          for (const candidatePath of [...changedPaths].sort()) {
            const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, candidatePath))
            const previous = before.files.get(logicalPath)
            const current = await snapshotEntry(
              observedRoot,
              logicalObservedRoot,
              logicalSessionRoot,
              candidatePath
            ).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
              throw error
            })
            if (!current && previous) {
              changes.push({
                relation: 'deleted',
                relativePath: previous.relativePath,
                before: previous
              })
            } else if (current && !previous) {
              changes.push({
                relation: 'created',
                relativePath: current.relativePath,
                after: current
              })
            } else if (current && previous && !sameSnapshotEntry(previous, current)) {
              changes.push({
                relation: 'modified',
                relativePath: current.relativePath,
                before: previous,
                after: current
              })
            }
          }
          if (changes.length > 0) {
            if (active.conflicted) {
              return { changes: [], reasonCodes: ['observer-conflict'], available: false }
            }
            return {
              changes: changes.sort((left, right) =>
                left.relativePath.localeCompare(right.relativePath)
              ),
              reasonCodes: [],
              available: true
            }
          }
          return fallbackObservation(
            observedRoot,
            logicalObservedRoot,
            logicalSessionRoot,
            before.files,
            [],
            { active, unregister }
          ).finish()
        } catch {
          return { changes: [], reasonCodes: ['observer-failed'], available: false }
        } finally {
          unregister()
        }
      }
    }
  } catch {
    watcher?.close()
    return {
      initialFiles: [],
      initialAvailable: false,
      finish: async () => ({ changes: [], reasonCodes: ['observer-failed'], available: false })
    }
  }
}

const beginEvidenceCapture = async (
  request: WorkingFileObservationRequest,
  observations: readonly RootObservation[],
  dependencies: WorkingFileObservationDependencies
): Promise<ActiveEvidenceCapture | undefined> => {
  if (!request.runId || !SAFE_ACTIVITY_ID.test(request.runId)) return undefined
  // Injected executors may omit the app-owned location. Keep their evidence outside the writable
  // Notebook session by falling back to a sibling private root; production supplies the canonical
  // project/session location explicitly.
  const fileEvidenceStorageRoot =
    request.fileEvidenceStorageRoot ?? resolve(request.notebookSessionRoot, '..')
  const fileEvidenceRoot =
    request.fileEvidenceRoot ?? join(fileEvidenceStorageRoot, 'execution-file-evidence')
  const fileEvidenceStoragePrefix = request.fileEvidenceStoragePrefix ?? 'execution-file-evidence'
  const projectScope = projectEvidenceScope(
    fileEvidenceStorageRoot,
    fileEvidenceRoot,
    fileEvidenceStoragePrefix
  )
  if (projectScope) {
    await ensureWorkingFileEvidenceProject(
      fileEvidenceStorageRoot,
      projectScope.projectId,
      dependencies.runEvidenceWorker
    )
  }
  const blobRoot = await secureEvidenceRoot(
    fileEvidenceStorageRoot,
    projectScope
      ? join(projectScope.projectRoot, 'blobs')
      : join(fileEvidenceStorageRoot, 'execution-file-evidence-blobs')
  )
  const evidenceId = `execution-file-evidence-${request.runId}`
  const capture: ActiveEvidenceCapture = {
    evidenceRoot: await secureEvidenceRoot(fileEvidenceStorageRoot, fileEvidenceRoot),
    receiptName: receiptNameForActivity(request.runId),
    stagingName: `staging-${request.runId}-${randomUUID()}`,
    finalName: finalNameForActivity(request.runId),
    evidenceId,
    activityId: request.runId,
    activityKind: 'notebook-run',
    storageKeyPrefix: fileEvidenceStoragePrefix,
    blobRoot,
    blobStorageKeyPrefix: projectScope?.blobStorageKeyPrefix ?? 'execution-file-evidence-blobs',
    maxGenerationBytes: dependencies.maxGenerationBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
    maxActivityBytes: dependencies.maxActivityBytes ?? LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
    maxEvidenceBytes:
      dependencies.maxEvidenceBytes ?? LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
    diskReserveBytes: dependencies.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
  }
  const initialFiles = observations.flatMap((observation) => observation.initialFiles)
  const initialViewState: ExecutionFileEvidenceCoverage = observations.every(
    (observation) => observation.initialAvailable
  )
    ? 'complete'
    : observations.some((observation) => observation.initialAvailable)
      ? 'partial'
      : 'unavailable'
  const plannedBytes = Math.min(
    capture.maxActivityBytes,
    Buffer.byteLength(JSON.stringify(initialFiles))
  )
  let reservedBytes = 0
  try {
    const freeBytes = await (dependencies.getAvailableBytes ?? availableBytes)(
      capture.evidenceRoot.path
    )
    assertDiskReserve(
      Math.max(0, freeBytes - reservedDiskBytes),
      plannedBytes,
      capture.diskReserveBytes
    )
    reservedDiskBytes += plannedBytes
    reservedBytes = plannedBytes
    const capturedAt = new Date((dependencies.now ?? Date.now)()).toISOString()
    const result = await runSerializedEvidenceWorker(
      dependencies.runEvidenceWorker ?? runEvidenceWorker,
      capture.evidenceRoot.path,
      {
        operation: 'begin',
        expectedRootIdentity: capture.evidenceRoot.identity,
        receiptName: capture.receiptName,
        stagingName: capture.stagingName,
        finalName: capture.finalName,
        activityId: capture.activityId,
        activityKind: capture.activityKind,
        evidenceId,
        storageKeyPrefix: fileEvidenceStoragePrefix,
        blobRoot: capture.blobRoot.path,
        expectedBlobRootIdentity: capture.blobRoot.identity,
        blobStorageKeyPrefix: capture.blobStorageKeyPrefix,
        initialViewState,
        initialFiles: initialFiles.map((file) => ({
          file,
          generation: {
            generationId: (dependencies.createId ?? randomUUID)(),
            capturedAt
          }
        })),
        maxGenerationBytes: capture.maxGenerationBytes,
        maxActivityBytes: capture.maxActivityBytes,
        maxEvidenceBytes: capture.maxEvidenceBytes,
        diskReserveBytes: capture.diskReserveBytes,
        availableBytes: Math.max(0, freeBytes - reservedDiskBytes + reservedBytes),
        captureCancelled: request.signal?.aborted ?? false
      },
      request.signal,
      dependencies.evidenceQueueTimeoutMs
    )
    if (!('capturedInitialGenerations' in result)) {
      throw new Error('File-evidence initial capture returned an invalid result.')
    }
    return capture
  } catch (error) {
    await runSerializedEvidenceWorker(
      dependencies.runEvidenceWorker ?? runEvidenceWorker,
      capture.evidenceRoot.path,
      {
        operation: 'cleanup',
        expectedRootIdentity: capture.evidenceRoot.identity,
        receiptName: capture.receiptName,
        blobRoot: capture.blobRoot.path,
        expectedBlobRootIdentity: capture.blobRoot.identity,
        blobStorageKeyPrefix: capture.blobStorageKeyPrefix
      }
    ).catch(() => undefined)
    throw error
  } finally {
    reservedDiskBytes -= reservedBytes
  }
}

const persistEvidence = async (
  request: WorkingFileObservationRequest,
  rootKinds: Array<'data' | 'handoff'>,
  rootResults: RootObservationResult[],
  capture: ActiveEvidenceCapture | undefined,
  dependencies: WorkingFileObservationDependencies
): Promise<WorkingFileObservationResult> => {
  const changes = rootResults.flatMap((result) => result.changes)
  const workingFiles = changes.flatMap((change): NotebookWorkingFile[] =>
    change.after
      ? [
          {
            path: change.after.path,
            relativePath: change.after.relativePath,
            kind: change.after.kind,
            size: change.after.size,
            mtimeMs: change.after.mtimeMs
          }
        ]
      : []
  )
  const workingFilesByPath = new Map(workingFiles.map((file) => [file.path, file]))
  if (!request.runId || !SAFE_ACTIVITY_ID.test(request.runId)) {
    return {
      workingFiles,
      fileEvidence: unavailableEvidence(['activity-identity-missing'])
    }
  }
  const scientificOutputs = analyzeScientificOutputs(
    changes.map((change) => ({
      relation: change.relation,
      relativePath: change.relativePath
    })),
    request.runId
  )
  for (const change of changes) {
    if (change.after) {
      const workingFile = workingFilesByPath.get(change.after.path)
      if (workingFile) {
        workingFile.change = change.relation === 'created' ? 'created' : 'modified'
      }
    }
  }
  if (!capture) {
    return {
      workingFiles,
      fileEvidence: unavailableEvidence(
        ['initial-file-generations-not-captured', 'evidence-persistence-failed'],
        request.runId
      )
    }
  }

  const plannedBytes = Math.min(
    capture.maxActivityBytes,
    Buffer.byteLength(JSON.stringify(changes))
  )
  let reservedBytes = 0
  try {
    const freeBytes = await (dependencies.getAvailableBytes ?? availableBytes)(
      capture.evidenceRoot.path
    )
    assertDiskReserve(
      Math.max(0, freeBytes - reservedDiskBytes),
      Math.min(plannedBytes, Buffer.byteLength(JSON.stringify(changes))),
      capture.diskReserveBytes
    )
    reservedDiskBytes += plannedBytes
    reservedBytes = plannedBytes
    const result = await runSerializedEvidenceWorker(
      dependencies.runEvidenceWorker ?? runEvidenceWorker,
      capture.evidenceRoot.path,
      {
        operation: 'persist',
        expectedRootIdentity: capture.evidenceRoot.identity,
        receiptName: capture.receiptName,
        stagingName: capture.stagingName,
        finalName: capture.finalName,
        activityId: capture.activityId,
        activityKind: capture.activityKind,
        evidenceId: capture.evidenceId,
        storageKeyPrefix: capture.storageKeyPrefix,
        blobRoot: capture.blobRoot.path,
        expectedBlobRootIdentity: capture.blobRoot.identity,
        blobStorageKeyPrefix: capture.blobStorageKeyPrefix,
        rootKinds,
        rootsAvailable: rootResults.every((result) => result.available),
        reasonCodes: rootResults.flatMap((result) => result.reasonCodes),
        scientificOutputs,
        changes: changes.map((change) => ({
          change,
          generation: {
            generationId: change.after ? (dependencies.createId ?? randomUUID)() : '',
            capturedAt: new Date((dependencies.now ?? Date.now)()).toISOString()
          }
        })),
        maxGenerationBytes: capture.maxGenerationBytes,
        maxActivityBytes: capture.maxActivityBytes,
        maxEvidenceBytes: capture.maxEvidenceBytes,
        diskReserveBytes: capture.diskReserveBytes,
        availableBytes: Math.max(0, freeBytes - reservedDiskBytes + reservedBytes),
        captureCancelled: request.signal?.aborted ?? false
      },
      request.signal?.aborted ? undefined : request.signal,
      dependencies.evidenceQueueTimeoutMs
    )
    if (!('generations' in result)) {
      throw new Error('File-evidence persistence returned an invalid result.')
    }
    await assertEvidenceRootIdentity(capture.evidenceRoot.path, capture.evidenceRoot.identity)
    for (const generation of result.generations) {
      const workingFile = workingFilesByPath.get(generation.path)
      if (workingFile) {
        workingFile.generationId = generation.generationId
        workingFile.checksum = generation.checksum
      }
    }
    return {
      workingFiles,
      fileEvidence: result.fileEvidence
    }
  } catch (error) {
    if (process.env.OPEN_SCIENCE_DEBUG_FILE_EVIDENCE === '1') {
      log.error('file-evidence publication failed', diagnosticErrorFields(error))
    }
    await runSerializedEvidenceWorker(runEvidenceWorker, capture.evidenceRoot.path, {
      operation: 'cleanup',
      expectedRootIdentity: capture.evidenceRoot.identity,
      receiptName: capture.receiptName,
      blobRoot: capture.blobRoot.path,
      expectedBlobRootIdentity: capture.blobRoot.identity,
      blobStorageKeyPrefix: capture.blobStorageKeyPrefix
    }).catch(() => undefined)
    return {
      workingFiles: stripUnpublishedGenerations(workingFiles),
      fileEvidence: unavailableEvidence(
        [...rootResults.flatMap((result) => result.reasonCodes), 'evidence-persistence-failed'],
        request.runId
      )
    }
  } finally {
    reservedDiskBytes -= reservedBytes
  }
}

const startWorkingFileObservation = async (
  request: WorkingFileObservationRequest,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  const logicalSessionRoot = resolve(request.notebookSessionRoot)
  const handoffRoot = join(logicalSessionRoot, 'handoff')
  const roots: Array<{ kind: 'data' | 'handoff'; path: string; logicalPath: string }> = [
    { kind: 'data', path: request.dataRoot, logicalPath: request.dataRoot },
    ...(await realpath(handoffRoot).then(
      () => [{ kind: 'handoff' as const, path: handoffRoot, logicalPath: handoffRoot }],
      () => []
    ))
  ]
  const observations = await Promise.all(
    roots.map((root) =>
      startRootObservation(root.path, root.logicalPath, logicalSessionRoot, dependencies)
    )
  )
  const capture = await beginEvidenceCapture(request, observations, dependencies).catch((error) => {
    if (process.env.OPEN_SCIENCE_DEBUG_FILE_EVIDENCE === '1') {
      log.error('file-evidence initial capture failed', diagnosticErrorFields(error))
    }
    return undefined
  })
  let finished = false
  return {
    finish: async (signal) => {
      if (finished) {
        return {
          workingFiles: [],
          fileEvidence: unavailableEvidence(['observer-failed'], request.runId)
        }
      }
      finished = true
      const results = await Promise.all(observations.map((observation) => observation.finish()))
      return persistEvidence(
        { ...request, signal: signal ?? request.signal },
        roots.map((root) => root.kind),
        results,
        capture,
        dependencies
      )
    }
  }
}

type ComputeTransferInput = Readonly<{
  localPath: string
  dstFilename: string
  label: string
}>

type FrozenComputeTransferInput = ComputeTransferInput &
  Readonly<{
    frozenPath: string
    generationId: string
    checksum: string
    sizeBytes: number
  }>

type ComputeTransferOutput = Readonly<{
  localPath: string
  relativePath: string
}>

const computeEvidenceLocation = (
  storageRoot: string,
  projectId: string,
  sessionId: string
): WorkingFileEvidenceLocation => {
  const lane = createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
  const location = getNotebookFileEvidenceLocation(storageRoot, projectId, sessionId, lane)
  return { storageRoot, ...location }
}

const explicitTransferSnapshot = async (
  localPath: string,
  relativePath: string
): Promise<SnapshotEntry> => {
  const linkMetadata = await lstat(localPath)
  if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
    throw new Error(`Compute transfer source is not a regular file: ${localPath}`)
  }
  const physicalPath = await realpath(localPath)
  const metadata = await stat(physicalPath)
  if (
    !metadata.isFile() ||
    metadata.dev !== linkMetadata.dev ||
    metadata.ino !== linkMetadata.ino
  ) {
    throw new Error(`Compute transfer source changed during capture: ${localPath}`)
  }
  return {
    physicalPath,
    path: resolve(localPath),
    relativePath,
    kind: 'other',
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino
  }
}

const beginComputeJobFileEvidence = async (request: {
  storageRoot: string
  projectId: string
  sessionId: string
  jobId: string
  producerRunId?: string
  inputs: readonly ComputeTransferInput[]
  signal?: AbortSignal
}): Promise<FrozenComputeTransferInput[]> => {
  if (!SAFE_ACTIVITY_ID.test(request.jobId)) throw new Error('Unsafe Compute Job evidence ID.')
  const location = computeEvidenceLocation(
    request.storageRoot,
    request.projectId,
    request.sessionId
  )
  const projectScope = projectEvidenceScope(
    location.storageRoot,
    location.root,
    location.storageKeyPrefix
  )
  if (!projectScope) throw new Error('Compute Job evidence requires Project-owned storage.')
  await ensureWorkingFileEvidenceProject(location.storageRoot, projectScope.projectId)
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const blobRoot = await secureEvidenceRoot(
    location.storageRoot,
    join(projectScope.projectRoot, 'blobs')
  )
  const stagingName = `staging-${request.jobId}`
  const finalName = finalNameForActivity(request.jobId)
  const evidenceId = `execution-file-evidence-${request.jobId}`
  const inputs = await Promise.all(
    request.inputs.map(async (input) => ({
      input,
      file: await explicitTransferSnapshot(input.localPath, `inputs/${input.dstFilename}`),
      generationId: randomUUID()
    }))
  )
  const freeBytes = await availableBytes(evidenceRoot.path)
  try {
    const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
      operation: 'begin',
      expectedRootIdentity: evidenceRoot.identity,
      receiptName: receiptNameForActivity(request.jobId),
      stagingName,
      finalName,
      activityId: request.jobId,
      activityKind: 'compute-job',
      ...(request.producerRunId ? { parentActivityId: request.producerRunId } : {}),
      evidenceId,
      storageKeyPrefix: location.storageKeyPrefix,
      blobRoot: blobRoot.path,
      expectedBlobRootIdentity: blobRoot.identity,
      blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix,
      initialViewState: 'complete',
      initialFiles: inputs.map(({ file, generationId }) => ({
        file,
        generation: { generationId, capturedAt: new Date().toISOString() },
        relation: 'staged-input'
      })),
      maxGenerationBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
      maxActivityBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
      maxEvidenceBytes: LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
      diskReserveBytes: LOCAL_RESOURCE_BUDGETS.diskReserveBytes,
      availableBytes: freeBytes,
      captureCancelled: request.signal?.aborted ?? false
    })
    if (!('capturedInitialGenerations' in result)) {
      throw new Error('Compute input capture returned an invalid result.')
    }
    const generations = new Map(
      (result.initialGenerations ?? []).map((generation) => [generation.relativePath, generation])
    )
    return inputs.map(({ input, file }) => {
      const generation = generations.get(file.relativePath)
      if (!generation) throw new Error(`Compute input could not be frozen: ${input.label}`)
      return {
        ...input,
        frozenPath: join(evidenceRoot.path, stagingName, 'blobs', `sha256-${generation.checksum}`),
        generationId: generation.generationId,
        checksum: generation.checksum,
        sizeBytes: generation.sizeBytes
      }
    })
  } catch (error) {
    await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
      operation: 'cleanup',
      expectedRootIdentity: evidenceRoot.identity,
      receiptName: receiptNameForActivity(request.jobId),
      blobRoot: blobRoot.path,
      expectedBlobRootIdentity: blobRoot.identity,
      blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix
    }).catch(() => undefined)
    throw error
  }
}

const cleanupComputeJobFileEvidence = async (request: {
  storageRoot: string
  projectId: string
  sessionId: string
  jobId: string
  preservePublished?: boolean
}): Promise<void> => {
  const location = computeEvidenceLocation(
    request.storageRoot,
    request.projectId,
    request.sessionId
  )
  const projectScope = projectEvidenceScope(
    location.storageRoot,
    location.root,
    location.storageKeyPrefix
  )
  if (!projectScope) return
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const blobRoot = await secureEvidenceRoot(
    location.storageRoot,
    join(projectScope.projectRoot, 'blobs')
  )
  await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'cleanup',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(request.jobId),
    preservePublished: request.preservePublished,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix
  })
}

const publishComputeJobFileEvidence = async (request: {
  storageRoot: string
  projectId: string
  sessionId: string
  jobId: string
  producerRunId?: string
  outputs: readonly ComputeTransferOutput[]
  remoteInputPaths?: readonly string[]
  reasonCodes?: readonly ExecutionFileEvidenceReason[]
  signal?: AbortSignal
}): Promise<ExecutionFileEvidenceSummary> => {
  const location = computeEvidenceLocation(
    request.storageRoot,
    request.projectId,
    request.sessionId
  )
  const projectScope = projectEvidenceScope(
    location.storageRoot,
    location.root,
    location.storageKeyPrefix
  )
  if (!projectScope) throw new Error('Compute Job evidence requires Project-owned storage.')
  await ensureWorkingFileEvidenceProject(location.storageRoot, projectScope.projectId)
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const blobRoot = await secureEvidenceRoot(
    location.storageRoot,
    join(projectScope.projectRoot, 'blobs')
  )
  const freeBytes = await availableBytes(evidenceRoot.path)
  const capture = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'ensure-capture',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(request.jobId),
    stagingName: `staging-${request.jobId}`,
    finalName: finalNameForActivity(request.jobId),
    activityId: request.jobId,
    activityKind: 'compute-job',
    ...(request.producerRunId ? { parentActivityId: request.producerRunId } : {}),
    evidenceId: `execution-file-evidence-${request.jobId}`,
    storageKeyPrefix: location.storageKeyPrefix,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix,
    initialViewState: 'unavailable',
    initialFiles: [],
    maxGenerationBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
    maxActivityBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
    maxEvidenceBytes: LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
    diskReserveBytes: LOCAL_RESOURCE_BUDGETS.diskReserveBytes,
    availableBytes: freeBytes,
    captureCancelled: request.signal?.aborted ?? false
  })
  if (!('captureReady' in capture)) {
    throw new Error('Compute recovery capture returned an invalid result.')
  }
  const outputs = await Promise.all(
    request.outputs.map(async (output) => ({
      output,
      file: await explicitTransferSnapshot(output.localPath, output.relativePath)
    }))
  )
  const remoteInputPaths = request.remoteInputPaths ?? []
  const reasons = [
    ...(request.reasonCodes ?? []),
    ...(request.producerRunId ? [] : (['compute-activity-lineage-missing'] as const)),
    ...(remoteInputPaths.length > 0 ? (['remote-input-generation-not-captured'] as const) : [])
  ]
  const hasRelations = outputs.length > 0 || remoteInputPaths.length > 0
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'persist',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(request.jobId),
    stagingName: `staging-${request.jobId}`,
    finalName: finalNameForActivity(request.jobId),
    activityId: request.jobId,
    activityKind: 'compute-job',
    ...(request.producerRunId ? { parentActivityId: request.producerRunId } : {}),
    evidenceId: `execution-file-evidence-${request.jobId}`,
    storageKeyPrefix: location.storageKeyPrefix,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix,
    rootKinds: ['data'],
    rootsAvailable: true,
    evidenceState: reasons.length === 0 ? 'available' : hasRelations ? 'partial' : 'unavailable',
    reasonCodes: [...new Set(reasons)],
    scientificOutputs: analyzeScientificOutputs(
      outputs.map(({ file }) => ({ relation: 'created', relativePath: file.relativePath })),
      request.jobId
    ),
    changes: [
      ...outputs.map(({ file }) => ({
        change: {
          relation: 'harvested-output' as const,
          relativePath: file.relativePath,
          after: file,
          pathPortability: 'relative' as const,
          authority: 'explicit-transfer' as const
        },
        generation: { generationId: randomUUID(), capturedAt: new Date().toISOString() }
      })),
      ...remoteInputPaths.map((remotePath) => ({
        change: {
          relation: 'remote-input-reference' as const,
          relativePath: remotePath,
          pathPortability: 'absolute' as const,
          authority: 'explicit-transfer' as const
        },
        generation: { generationId: randomUUID(), capturedAt: new Date().toISOString() }
      }))
    ],
    maxGenerationBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
    maxActivityBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
    maxEvidenceBytes: LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
    diskReserveBytes: LOCAL_RESOURCE_BUDGETS.diskReserveBytes,
    availableBytes: freeBytes,
    captureCancelled: request.signal?.aborted ?? false
  })
  if (!('fileEvidence' in result)) {
    throw new Error('Compute output capture returned an invalid result.')
  }
  const fileEvidence = parseOwnedExecutionFileEvidenceSummary(result.fileEvidence, {
    activityId: request.jobId,
    activityKind: 'compute-job',
    parentActivityId: request.producerRunId,
    storageKey: `${location.storageKeyPrefix}/${finalNameForActivity(request.jobId)}/evidence.json`
  })
  if (!fileEvidence) throw new Error('Compute output capture returned invalid file evidence.')
  return fileEvidence
}

const recoverPublishedComputeJobFileEvidence = async (request: {
  storageRoot: string
  projectId: string
  sessionId: string
  jobId: string
  producerRunId?: string
}): Promise<ExecutionFileEvidenceSummary | undefined> => {
  const location = computeEvidenceLocation(
    request.storageRoot,
    request.projectId,
    request.sessionId
  )
  if (!existsSync(location.root)) return undefined
  const projectScope = projectEvidenceScope(
    location.storageRoot,
    location.root,
    location.storageKeyPrefix
  )
  if (!projectScope) throw new Error('Compute Job evidence requires Project-owned storage.')
  await ensureWorkingFileEvidenceProject(location.storageRoot, projectScope.projectId)
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const blobRoot = await secureEvidenceRoot(
    location.storageRoot,
    join(projectScope.projectRoot, 'blobs')
  )
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'recover-published',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(request.jobId),
    stagingName: `staging-${request.jobId}`,
    finalName: finalNameForActivity(request.jobId),
    activityId: request.jobId,
    activityKind: 'compute-job',
    ...(request.producerRunId ? { parentActivityId: request.producerRunId } : {}),
    evidenceId: `execution-file-evidence-${request.jobId}`,
    storageKeyPrefix: location.storageKeyPrefix,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope.blobStorageKeyPrefix,
    rootKinds: ['data'],
    rootsAvailable: false,
    evidenceState: 'unavailable',
    reasonCodes: [],
    scientificOutputs: [],
    changes: [],
    maxGenerationBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
    maxActivityBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
    maxEvidenceBytes: LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
    diskReserveBytes: LOCAL_RESOURCE_BUDGETS.diskReserveBytes,
    availableBytes: 0,
    captureCancelled: false
  })
  if (!('recoveredFileEvidence' in result)) {
    throw new Error('Compute published evidence recovery returned an invalid result.')
  }
  if (!result.recoveredFileEvidence) return undefined
  const fileEvidence = parseOwnedExecutionFileEvidenceSummary(result.recoveredFileEvidence, {
    activityId: request.jobId,
    activityKind: 'compute-job',
    parentActivityId: request.producerRunId,
    storageKey: `${location.storageKeyPrefix}/${finalNameForActivity(request.jobId)}/evidence.json`
  })
  if (!fileEvidence || !fileEvidence.evidenceId || !fileEvidence.checksum) {
    throw new Error('Recovered Compute file evidence is not immutable.')
  }
  return fileEvidence
}

const settleComputeJobFileEvidence = async (request: {
  storageRoot: string
  projectId: string
  sessionId: string
  jobId: string
  producerRunId?: string
  fileEvidence: ExecutionFileEvidenceSummary
}): Promise<void> => {
  const evidence = request.fileEvidence
  if (
    evidence.activityId !== request.jobId ||
    evidence.activityKind !== 'compute-job' ||
    evidence.parentActivityId !== request.producerRunId ||
    !evidence.evidenceId ||
    !evidence.checksum ||
    !evidence.storageKey
  ) {
    throw new Error('Compute Job file-evidence completion requires a published summary.')
  }
  const location = computeEvidenceLocation(
    request.storageRoot,
    request.projectId,
    request.sessionId
  )
  const finalName = finalNameForActivity(request.jobId)
  if (evidence.storageKey !== `${location.storageKeyPrefix}/${finalName}/evidence.json`) {
    throw new Error('Compute Job file-evidence storage key does not match its owner.')
  }
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'complete',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForActivity(request.jobId),
    finalName: finalNameForActivity(request.jobId),
    activityId: request.jobId,
    activityKind: 'compute-job',
    ...(request.producerRunId ? { parentActivityId: request.producerRunId } : {}),
    evidenceId: evidence.evidenceId,
    checksum: evidence.checksum,
    storageKey: evidence.storageKey
  })
}

export {
  beginComputeJobFileEvidence,
  cleanupComputeJobFileEvidence,
  completeWorkingFileEvidence,
  deleteWorkingFileEvidenceProject,
  reconcileComputeJobFileEvidence,
  reconcileWorkingFileEvidence,
  publishComputeJobFileEvidence,
  recoverPublishedComputeJobFileEvidence,
  settleComputeJobFileEvidence,
  startWorkingFileObservation,
  toPortableNotebookRelativePath
}
export type { WorkingFileEvidenceLocation, WorkingFileObservation, WorkingFileObservationResult }
export type { ComputeTransferInput, ComputeTransferOutput, FrozenComputeTransferInput }
