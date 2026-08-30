import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookFileEvidenceCoverage,
  NotebookFileEvidenceReason,
  NotebookRunFileEvidence,
  NotebookRunRecord,
  NotebookScientificOutput,
  NotebookWorkingFile
} from '../../shared/notebook'
import { assertDiskReserve } from '../bounded-file-io'
import { createLogger, diagnosticErrorFields } from '../logger'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { availableBytes } from '../storage/usage'
import { analyzeScientificOutputs } from './scientific-output-analysis'

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
  fileEvidence: NotebookRunFileEvidence
}

type WorkingFileObservation = {
  finish: (signal?: AbortSignal) => Promise<WorkingFileObservationResult>
}

type WorkingFileObservationDependencies = {
  watchDirectory?: typeof watch
  createId?: () => string
  now?: () => number
  maxGenerationBytes?: number
  maxRunBytes?: number
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
  | { state: 'unavailable'; reason: NotebookFileEvidenceReason }
type ObservedFileChange = {
  relation: 'created' | 'modified' | 'deleted'
  relativePath: string
  before?: SnapshotEntry
  after?: SnapshotEntry
}
type RootObservationResult = {
  changes: ObservedFileChange[]
  reasonCodes: NotebookFileEvidenceReason[]
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
  runId: string
  evidenceId: string
  storageKeyPrefix: string
  initialViewState: NotebookFileEvidenceCoverage
  initialFiles: Array<{
    file: SnapshotEntry
    generation: { generationId: string; capturedAt: string }
  }>
  maxGenerationBytes: number
  maxRunBytes: number
  maxEvidenceBytes: number
  diskReserveBytes: number
  availableBytes: number
  captureCancelled: boolean
}
type EvidenceWorkerPersistRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'persist'
  expectedRootIdentity: FileIdentity
  receiptName: string
  stagingName: string
  finalName: string
  runId: string
  evidenceId: string
  storageKeyPrefix: string
  rootKinds: Array<'data' | 'handoff'>
  rootsAvailable: boolean
  reasonCodes: NotebookFileEvidenceReason[]
  scientificOutputs: NotebookScientificOutput[]
  changes: Array<{
    change: ObservedFileChange
    generation: { generationId: string; capturedAt: string }
  }>
  maxGenerationBytes: number
  maxRunBytes: number
  maxEvidenceBytes: number
  diskReserveBytes: number
  availableBytes: number
  captureCancelled: boolean
}
type EvidenceWorkerCompleteRequest = {
  operation: 'complete'
  expectedRootIdentity: FileIdentity
  receiptName: string
  finalName: string
  runId: string
  evidenceId: string
  checksum: string
  storageKey: string
}
type EvidenceWorkerReconcileRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'reconcile'
  expectedRootIdentity: FileIdentity
  retained: Array<{
    receiptName: string
    finalName: string
    runId: string
    evidenceId: string
    checksum: string
    storageKey: string
  }>
}
type EvidenceWorkerCleanupRequest = EvidenceWorkerBlobPoolBinding & {
  operation: 'cleanup'
  expectedRootIdentity: FileIdentity
  receiptName: string
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
  | EvidenceWorkerPersistRequest
  | EvidenceWorkerCompleteRequest
  | EvidenceWorkerReconcileRequest
  | EvidenceWorkerCleanupRequest
  | EvidenceWorkerDeleteProjectRequest
  | EvidenceWorkerEnsureProjectRequest
type EvidenceWorkerResult =
  | { ok: true; capturedInitialGenerations: number }
  | {
      ok: true
      generations: Array<{ path: string; generationId: string; checksum: string }>
      fileEvidence: NotebookRunFileEvidence
    }
  | {
      ok: true
      removedStagingEntries: number
      removedRunEntries: number
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
  storageKeyPrefix: string
  blobRoot: { path: string; identity: FileIdentity }
  blobStorageKeyPrefix: string
  maxGenerationBytes: number
  maxRunBytes: number
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
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const NOTEBOOK_FILE_EVIDENCE_DIR = 'notebook-file-evidence'
const BASELINE_REASON_CODES: NotebookFileEvidenceReason[] = [
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
  reasons: readonly NotebookFileEvidenceReason[]
): NotebookFileEvidenceReason[] => [...new Set(reasons)].sort()

const unavailableEvidence = (
  reasons: readonly NotebookFileEvidenceReason[]
): NotebookRunFileEvidence => ({
  schemaVersion: 1,
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
    throw new UnsafeEvidencePathError(`Unsafe Notebook file-evidence directory: ${path}`)
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
    throw new UnsafeEvidencePathError('Notebook file-evidence root identity changed.')
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
    throw new UnsafeEvidencePathError('Notebook file-evidence root escapes app storage.')
  }
  let evidenceRoot = canonicalStorageRoot
  for (const segment of nested.split(sep)) {
    evidenceRoot = join(evidenceRoot, segment)
    await ensureRealDirectory(evidenceRoot)
    if ((await realpath(evidenceRoot)) !== evidenceRoot) {
      throw new UnsafeEvidencePathError('Notebook file-evidence root resolves through a symlink.')
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

const receiptNameForRun = (runId: string): string => `receipt-${runId}.json`
const finalNameForRun = (runId: string): string => `run-${runId}`

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
  if (!SAFE_RUN_ID.test(projectId)) throw new Error('Unsafe Notebook file-evidence Project ID.')
  const evidenceRoot = await secureEvidenceRoot(
    storageRoot,
    join(storageRoot, NOTEBOOK_FILE_EVIDENCE_DIR)
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
  if (segments[0] !== NOTEBOOK_FILE_EVIDENCE_DIR) return undefined
  const projectId = segments[1]
  if (!projectId || !SAFE_RUN_ID.test(projectId)) {
    throw new Error('Unsafe Notebook file-evidence Project storage prefix.')
  }
  const projectRoot = join(storageRoot, NOTEBOOK_FILE_EVIDENCE_DIR, projectId)
  if (!isPathInside(projectRoot, resolve(evidenceRoot))) {
    throw new Error('Notebook file-evidence root does not match its Project storage prefix.')
  }
  return {
    projectId,
    projectRoot,
    blobStorageKeyPrefix: `${NOTEBOOK_FILE_EVIDENCE_DIR}/${projectId}/blobs`
  }
}

const deleteWorkingFileEvidenceProject = async (
  storageRoot: string,
  projectId: string
): Promise<void> => {
  if (!SAFE_RUN_ID.test(projectId)) throw new Error('Unsafe Notebook file-evidence Project ID.')
  const root = await secureEvidenceRoot(storageRoot, join(storageRoot, NOTEBOOK_FILE_EVIDENCE_DIR))
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
    !SAFE_RUN_ID.test(run.runId) ||
    !evidence?.evidenceId ||
    !evidence.checksum ||
    !evidence.storageKey
  ) {
    return
  }
  const finalName = finalNameForRun(run.runId)
  if (evidence.storageKey !== `${location.storageKeyPrefix}/${finalName}/evidence.json`) return
  const evidenceRoot = await secureEvidenceRoot(location.storageRoot, location.root)
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'complete',
    expectedRootIdentity: evidenceRoot.identity,
    receiptName: receiptNameForRun(run.runId),
    finalName,
    runId: run.runId,
    evidenceId: evidence.evidenceId,
    checksum: evidence.checksum,
    storageKey: evidence.storageKey
  })
  if (!('removedStagingEntries' in result)) {
    throw new Error('File-evidence completion returned an invalid result.')
  }
}

const reconcileWorkingFileEvidence = async (
  location: WorkingFileEvidenceLocation,
  runs: readonly Pick<NotebookRunRecord, 'runId' | 'fileEvidence'>[]
): Promise<{ removedStagingEntries: number; removedRunEntries: number }> => {
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
      : join(location.storageRoot, 'file-evidence-blobs')
  )
  const retained = runs.flatMap((run) => {
    const evidence = run.fileEvidence
    if (
      !SAFE_RUN_ID.test(run.runId) ||
      !evidence?.evidenceId ||
      !evidence.checksum ||
      !evidence.storageKey
    ) {
      return []
    }
    const finalName = finalNameForRun(run.runId)
    if (evidence.storageKey !== `${location.storageKeyPrefix}/${finalName}/evidence.json`) return []
    return [
      {
        receiptName: receiptNameForRun(run.runId),
        finalName,
        runId: run.runId,
        evidenceId: evidence.evidenceId,
        checksum: evidence.checksum,
        storageKey: evidence.storageKey
      }
    ]
  })
  const result = await runSerializedEvidenceWorker(runEvidenceWorker, evidenceRoot.path, {
    operation: 'reconcile',
    expectedRootIdentity: evidenceRoot.identity,
    blobRoot: blobRoot.path,
    expectedBlobRootIdentity: blobRoot.identity,
    blobStorageKeyPrefix: projectScope?.blobStorageKeyPrefix ?? 'file-evidence-blobs',
    retained
  })
  if (!('removedStagingEntries' in result)) {
    throw new Error('File-evidence reconciliation returned an invalid result.')
  }
  return {
    removedStagingEntries: result.removedStagingEntries,
    removedRunEntries: result.removedRunEntries
  }
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
  reasonCodes: readonly NotebookFileEvidenceReason[],
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
  if (!request.runId || !SAFE_RUN_ID.test(request.runId)) return undefined
  // Injected executors may omit the app-owned location. Keep their evidence outside the writable
  // Notebook session by falling back to a sibling private root; production supplies the canonical
  // project/session location explicitly.
  const fileEvidenceStorageRoot =
    request.fileEvidenceStorageRoot ?? resolve(request.notebookSessionRoot, '..')
  const fileEvidenceRoot =
    request.fileEvidenceRoot ?? join(fileEvidenceStorageRoot, 'file-evidence')
  const fileEvidenceStoragePrefix = request.fileEvidenceStoragePrefix ?? 'file-evidence'
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
      : join(fileEvidenceStorageRoot, 'file-evidence-blobs')
  )
  const evidenceId = `notebook-file-evidence-${request.runId}`
  const capture: ActiveEvidenceCapture = {
    evidenceRoot: await secureEvidenceRoot(fileEvidenceStorageRoot, fileEvidenceRoot),
    receiptName: receiptNameForRun(request.runId),
    stagingName: `staging-${request.runId}-${randomUUID()}`,
    finalName: finalNameForRun(request.runId),
    evidenceId,
    storageKeyPrefix: fileEvidenceStoragePrefix,
    blobRoot,
    blobStorageKeyPrefix: projectScope?.blobStorageKeyPrefix ?? 'file-evidence-blobs',
    maxGenerationBytes: dependencies.maxGenerationBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
    maxRunBytes: dependencies.maxRunBytes ?? LOCAL_RESOURCE_BUDGETS.artifactTurnBytes,
    maxEvidenceBytes:
      dependencies.maxEvidenceBytes ?? LOCAL_RESOURCE_BUDGETS.notebookEvidenceProjectBytes,
    diskReserveBytes: dependencies.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
  }
  const initialFiles = observations.flatMap((observation) => observation.initialFiles)
  const initialViewState: NotebookFileEvidenceCoverage = observations.every(
    (observation) => observation.initialAvailable
  )
    ? 'complete'
    : observations.some((observation) => observation.initialAvailable)
      ? 'partial'
      : 'unavailable'
  const plannedBytes = Math.min(
    capture.maxRunBytes,
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
        runId: request.runId,
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
        maxRunBytes: capture.maxRunBytes,
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
  if (!request.runId || !SAFE_RUN_ID.test(request.runId)) {
    return { workingFiles, fileEvidence: unavailableEvidence(['run-identity-missing']) }
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
      fileEvidence: unavailableEvidence([
        'initial-file-generations-not-captured',
        'evidence-persistence-failed'
      ])
    }
  }

  const plannedBytes = Math.min(capture.maxRunBytes, Buffer.byteLength(JSON.stringify(changes)))
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
        runId: request.runId,
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
        maxRunBytes: capture.maxRunBytes,
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
      fileEvidence: unavailableEvidence([
        ...rootResults.flatMap((result) => result.reasonCodes),
        'evidence-persistence-failed'
      ])
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
        return { workingFiles: [], fileEvidence: unavailableEvidence(['observer-failed']) }
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

export {
  completeWorkingFileEvidence,
  deleteWorkingFileEvidenceProject,
  reconcileWorkingFileEvidence,
  startWorkingFileObservation,
  toPortableNotebookRelativePath
}
export type { WorkingFileEvidenceLocation, WorkingFileObservation, WorkingFileObservationResult }
