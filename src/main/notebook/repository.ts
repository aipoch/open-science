import {
  isNotebookRunReference,
  type RunReference,
  type StoredNotebookRun
} from './run-record-reference'
import {
  type PendingRunScope,
  CorruptPendingRunError,
  assertPendingRunsCheckpointable,
  PENDING_RUN_DIRECTORY,
  recoverPendingRuns,
  mergePendingRuns,
  pendingDirectoryIdentity,
  publishPendingRun,
  clearPendingRuns,
  PENDING_RUN_LIMIT,
  PENDING_REFERENCE_BYTES,
  PENDING_RUN_BYTES
} from './pending-run-files'
import { estimateReplayBytes, indexReplayRun, type ReplayRunIndex } from '../../shared/replay'
import { indexInlineRuns, readInlineRunBatch, type InlineRunSlot } from './inline-run-window'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookKernelMetadata,
  NotebookKernelInstanceIdentity,
  NotebookRunDocument,
  NotebookRunHistorySummary,
  NotebookAgentSummary,
  NotebookRunCursor,
  NotebookRunRecord,
  NotebookRunStatus,
  NotebookWorkingFile,
  NotebookEnvironmentManifest
} from '../../shared/notebook'
import { parseOwnedExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import {
  createNotebookFrameRunFilter,
  summarizeNotebookHistory,
  NOTEBOOK_RUN_FILE,
  NOTEBOOKS_DIR
} from '../../shared/notebook'
import type { NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  defaultFileDurability,
  DurableJsonRecoveryBarrierError,
  isRecoverableDurableJsonTemporaryFile,
  readFileWithinLimit,
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import { decodeVersionedJson } from '../storage/versioned-json-decoder'
import {
  decodeRunDocumentDataPaths,
  encodeRunDocumentDataPaths,
  encodeNotebookRunDataPaths
} from './run-document-data-path-codec'
import { decodeNotebookHelperEvidence } from './helper-evidence'
import {
  createFrameNotebookLane,
  createRootNotebookLane,
  notebookLaneScope,
  type NotebookLaneIdentity
} from './lane-identity'
import { isRecord } from '../value-guards'
import { ensureNotebookInputRoot } from './input-staging'

const RECORDS_DIRECTORY = '.run-records'
const INLINE_BYTES = 64 * 1024
// Batch lifecycle transitions once rewriting the manifest costs at least four full hot slots.
const MIN_BATCHED_MANIFEST_BYTES = 4 * PENDING_RUN_BYTES
const ENVIRONMENT_MANIFEST_DIRECTORY = 'runtime/provenance/environment-manifests'
const MAX_ENVIRONMENT_MANIFEST_BYTES = 32 * 1024 * 1024
const digestPattern = /^[a-f0-9]{64}$/

const digest = (contents: string): string => createHash('sha256').update(contents).digest('hex')

const serializeEnvironmentManifest = (manifest: NotebookEnvironmentManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`

const environmentManifestPath = (dataRoot: string, checksum: string): string =>
  join(dataRoot, ENVIRONMENT_MANIFEST_DIRECTORY, `${checksum}.json`)

const environmentManifestChecksumForRun = (run: NotebookRunRecord): string | undefined =>
  run.environmentManifestChecksum ??
  (run.environmentCapture?.state === 'available' || run.environmentCapture?.state === 'partial'
    ? run.environmentCapture.manifestChecksum
    : undefined)

const environmentManifestStorageKey = (checksum: string): string =>
  `${ENVIRONMENT_MANIFEST_DIRECTORY}/${checksum}.json`

const withoutEnvironmentManifest = (run: NotebookRunRecord): NotebookRunRecord => {
  if (!run.environmentManifest) return run
  const copy = { ...run }
  delete copy.environmentManifest
  return copy
}

const readEnvironmentManifest = async (
  storageRoot: string,
  checksum: string
): Promise<NotebookEnvironmentManifest | undefined> => {
  if (!digestPattern.test(checksum)) return undefined
  const path = environmentManifestPath(storageRoot, checksum)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    const contents = await readFileWithinLimit(path, MAX_ENVIRONMENT_MANIFEST_BYTES)
    if (digest(contents) !== checksum) return undefined
    const value: unknown = JSON.parse(contents)
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.captureKind !== 'completed-run' ||
      !Array.isArray(value.packages)
    )
      return undefined
    return value as NotebookEnvironmentManifest
  } catch {
    return undefined
  }
}

type RecordReadScope = {
  root: string
  records?: Map<string, { info: DocumentFileIdentity; run: NotebookRunRecord }>
}

type LaneHistory = Pick<
  NotebookRunDocument,
  'notebookSessionRoot' | 'dataRoot' | 'kernel' | 'runtimeBindings' | 'runs'
>
type HistoryBody = { root: string; ref: RunReference }
type SessionInitialization = Omit<LaneHistory, 'runs'> & {
  runs: readonly Pick<NotebookRunRecord, 'runId' | 'status' | 'fileEvidence'>[]
}

// Positions refer to the authoritative manifest. Only append and in-place lifecycle transitions
// may operate on the remaining Runs; complete history readers never receive this projection.
type DetachedRuns = {
  analysis?: Map<number, NotebookRunRecord>
  slots: Map<number, RunReference>
  submissionIds: Set<string>
  hasBackgroundRuns: boolean
  bytes: number
}

type LaneSummary = {
  notebookSessionRoot: string
  workspaceCwd: string
  hasBackgroundRuns: boolean
  history?: LaneHistory
  rows?: ReplayRunIndex[]
}

// Immutable records land before the manifest. Only startup, before admission, removes orphans.
class NotebookRunRecordStorage {
  private readonly references = new WeakMap<
    NotebookRunRecord,
    { directory: string; ref: RunReference }
  >()

  private async directory(root: string, create = false): Promise<string> {
    const directory = join(root, RECORDS_DIRECTORY)
    if (create) await mkdir(directory, { recursive: true })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid Notebook record directory.')
    return directory
  }

  remember(runs: NotebookRunRecord[], stored: StoredNotebookRun[], directory: string): void {
    stored.forEach((ref, index) => {
      if (isNotebookRunReference(ref)) this.references.set(runs[index], { directory, ref })
    })
  }

  private readonly verifiedFiles = new WeakMap<RunReference, DocumentFileIdentity>()

  async unchanged(
    root: string,
    references: RunReference[],
    verifyUnseen = false
  ): Promise<boolean> {
    if (!references.length) return true
    try {
      const directory = await this.directory(root)
      for (const ref of references) {
        const known = this.verifiedFiles.get(ref)
        if (!known) {
          if (!verifyUnseen) return false
          // A newly published result has no read identity yet. Verify its content once.
          await this.read(root, [ref])
          continue
        }
        const current = await lstat(join(directory, `${ref.sha256}.json`))
        if (!current.isFile() || !sameDocumentFileIdentity(known, current)) return false
      }
      return true
    } catch {
      // The ordinary read below owns corruption handling for live and imported Sessions.
      return false
    }
  }

  private readonly reads = new AsyncLocalStorage<RecordReadScope>()

  async withinHistoryRead<T>(root: string, read: () => Promise<T>): Promise<T> {
    const parent = this.reads.getStore()
    const scope: RecordReadScope = {
      root,
      records: (parent?.root === root ? parent.records : undefined) ?? new Map()
    }
    return this.reads.run(scope, async () => {
      try {
        return await read()
      } finally {
        // Runtime initialization may start longer-lived async work in this context.
        scope.records = undefined
      }
    })
  }

  async read(root: string, runs: StoredNotebookRun[]): Promise<NotebookRunRecord[]> {
    const scope = this.reads.getStore()
    const records =
      scope && (root === scope.root || dirname(root) === join(scope.root, 'frames'))
        ? scope.records
        : undefined
    const result: NotebookRunRecord[] = []
    let directory: string | undefined
    for (const entry of runs) {
      if (!isNotebookRunReference(entry)) {
        result.push(entry)
        continue
      }
      directory ??= await this.directory(root)
      const path = join(directory, `${entry.sha256}.json`)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes)
        throw new Error('Invalid Notebook record file.')
      const cached = records?.get(path)
      if (cached && sameDocumentFileIdentity(cached.info, info)) {
        if (cached.run.runId !== entry.runId) throw new Error('Notebook record identity mismatch.')
        this.verifiedFiles.set(entry, cached.info)
        result.push(cached.run)
        continue
      }
      const contents = await readFileWithinLimit(path, entry.bytes)
      if (digest(contents) !== entry.sha256) throw new Error('Notebook record checksum mismatch.')
      const run = JSON.parse(contents) as NotebookRunRecord
      if (run?.runId !== entry.runId) throw new Error('Notebook record identity mismatch.')
      const identity = {
        size: info.size,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs
      }
      this.verifiedFiles.set(entry, identity)
      records?.set(path, { info: identity, run })
      result.push(run)
    }
    return result
  }

  async write(
    root: string,
    runs: NotebookRunRecord[],
    encode: (run: NotebookRunRecord) => NotebookRunRecord
  ): Promise<StoredNotebookRun[]> {
    const stored: StoredNotebookRun[] = []
    let directory: string | undefined
    for (const run of runs) {
      const known = this.references.get(run)
      if (known?.directory === root) {
        stored.push(known.ref)
        continue
      }
      const encoded = encode(run)
      const contents = JSON.stringify(encoded)
      const bytes = Buffer.byteLength(contents)
      if (bytes < INLINE_BYTES) {
        stored.push(encoded)
        continue
      }
      directory ??= await this.directory(root, true)
      const ref: RunReference = {
        storage: 'file',
        runId: run.runId,
        sha256: digest(contents),
        bytes
      }
      await writeDurableJsonFile(join(directory, `${ref.sha256}.json`), contents)
      this.references.set(run, { directory: root, ref })
      stored.push(ref)
    }
    return stored
  }

  referencesFor(root: string, runs: readonly NotebookRunRecord[]): RunReference[] {
    return runs.flatMap((run) => {
      const stored = this.references.get(run)
      return stored?.directory === root ? stored.ref : []
    })
  }

  async containsOnlyReferencedFiles(
    root: string,
    runs: readonly NotebookRunRecord[]
  ): Promise<boolean> {
    const names = new Set(this.referencesFor(root, runs).map((ref) => `${ref.sha256}.json`))
    try {
      const entries = await readdir(await this.directory(root), { withFileTypes: true })
      return entries.every((entry) => !entry.isFile() || names.has(entry.name))
    } catch (error) {
      if (isMissingFileError(error)) return true
      throw error
    }
  }

  async prune(root: string, runs: StoredNotebookRun[]): Promise<void> {
    let directory: string
    try {
      directory = await this.directory(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const retained = new Set(runs.filter(isNotebookRunReference).map((ref) => `${ref.sha256}.json`))
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const canonical = /^[a-f0-9]{64}\.json$/.test(entry.name)
      const base = /^[a-f0-9]{64}\.json/.exec(entry.name)?.[0]
      const abandoned =
        base && isRecoverableDurableJsonTemporaryFile(join(directory, base), entry.name)
      if ((canonical && !retained.has(entry.name)) || abandoned)
        await rm(join(directory, entry.name))
    }
  }
}

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EXECUTION_FILE_EVIDENCE_DIR = 'execution-file-evidence'
const RUN_TERMINAL_OUTBOX_DIR = '.run-terminal-outbox'
const MAX_DOCUMENT_CACHE_ENTRIES = 8
const MAX_DOCUMENT_CACHE_BYTES = 32 * 1024 * 1024
const MAX_ANALYSIS_METADATA_BYTES = 1024 * 1024
const MAX_LANE_SUMMARY_BYTES = 256 * 1024
const MAX_DOCUMENT_READ_ATTEMPTS = 2
const log = createLogger('notebook:persistence')

type DocumentFileIdentity = {
  pending?: string
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

type PersistedNotebookDocumentScope = {
  projectId?: unknown
  projectName?: unknown
  sessionId?: unknown
}

const manifestIdentity = async (path: string): Promise<DocumentFileIdentity> => {
  const info = await stat(path)
  return {
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
    size: info.size,
    pending: await pendingDirectoryIdentity(path)
  }
}

const statIfPresent = async (path: string): Promise<DocumentFileIdentity | undefined> => {
  try {
    return await manifestIdentity(path)
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
}

const sameDocumentFileIdentity = (
  left: DocumentFileIdentity,
  right: DocumentFileIdentity | undefined
): boolean =>
  right !== undefined &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs &&
  left.size === right.size &&
  left.ino === right.ino &&
  left.pending === right.pending

type LoadNotebookRunDocumentRequest = {
  projectId: string
  sessionId: string
  workspaceCwd: string
  artifactSessionId?: string
  pythonPath?: string
  kernelName?: string
  lane: NotebookLaneIdentity
}

type AppendNotebookRunRequest = {
  projectId: string
  sessionId: string
  run: NotebookRunRecord
  lane: NotebookLaneIdentity
  signal?: AbortSignal
}

type UpdateNotebookRunRequest = AppendNotebookRunRequest

type TransitionNotebookRunRequest = AppendNotebookRunRequest & {
  expectedStatus: NotebookRunStatus
}

type NotebookRunMutationResult = {
  run: NotebookRunRecord
}
type NotebookRunLookupResult = Readonly<{
  document: Pick<NotebookRunDocument, 'notebookSessionRoot' | 'dataRoot' | 'kernel'>
  run: NotebookRunRecord
}>

type ReadSessionDocumentsOptions = Readonly<{
  includeEnvironmentManifests?: boolean
}>

type ReadSessionRunsOptions = ReadSessionDocumentsOptions

type AppendOrGetNotebookRunResult = NotebookRunMutationResult & { admitted: boolean }
type TransitionNotebookRunResult = NotebookRunMutationResult & { transitioned: boolean }

type RecoveredBackgroundRun = Readonly<{
  projectId: string
  sessionId: string
  run: NotebookRunRecord
}>

type NotebookRunTerminalFact = {
  version: 1
  projectId: string
  sessionId: string
  expectedStatus: 'running'
  run: NotebookRunRecord
}

type UpdateKernelStatusRequest = {
  projectId: string
  sessionId: string
  status: NotebookKernelMetadata['lastKnownStatus']
  lane: NotebookLaneIdentity
}

type UpdateKernelTerminationRequest = Omit<UpdateKernelStatusRequest, 'status'> & {
  kernelInstance: NotebookKernelInstanceIdentity
}

type NormalizeNotebookRunDocumentRequest = Omit<
  LoadNotebookRunDocumentRequest,
  'workspaceCwd' | 'lane'
> & {
  workspaceCwd?: string
  // Only the legacy read adapter omits this. Every mutating caller requires a lane.
  lane?: NotebookLaneIdentity
}

// Rejects path traversal and empty segments before composing notebook storage paths.
const assertSafeNotebookPathSegment = (segment: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid notebook path segment: ${segment}`)
  }

  return segment
}

// Detects the expected "run.json does not exist yet" case without hiding real IO failures.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const persistedScopeValue = (value: unknown): string =>
  value === undefined || value === null ? '<missing>' : (JSON.stringify(value) ?? String(value))

const isOptionalSha256 = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))

const notebookHelperEvidenceStatusCandidate = (value: unknown): boolean => {
  if (!isRecord(value) || (value.state !== 'complete' && value.state !== 'incomplete')) return false
  return (
    value.state === 'complete' ||
    (Array.isArray(value.reasons) &&
      value.reasons.length > 0 &&
      value.reasons.every(
        (reason) =>
          reason === 'source-missing' || reason === 'source-corrupt' || reason === 'payload-limit'
      ))
  )
}

class UnsupportedNotebookDocumentVersionError extends DurableJsonRecoveryBarrierError {
  constructor() {
    super('Notebook document version is not supported.')
  }
}

class CorruptNotebookDocumentError extends Error {
  constructor() {
    super('Notebook document is corrupt.')
  }
}

class NotebookRunSubmissionConflictError extends Error {
  readonly code = 'NOTEBOOK_RUN_SUBMISSION_CONFLICT'

  constructor(readonly submissionIdentity: string) {
    super(
      `NOTEBOOK_RUN_SUBMISSION_CONFLICT: submission identity ${submissionIdentity} was reused with different work.`
    )
    this.name = 'NotebookRunSubmissionConflictError'
  }
}

const notebookRunCandidate = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (
    typeof value.runId !== 'string' ||
    (value.submissionIdentity !== undefined &&
      (typeof value.submissionIdentity !== 'string' || value.submissionIdentity.length === 0)) ||
    (value.submissionFingerprint !== undefined &&
      (typeof value.submissionFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.submissionFingerprint))) ||
    (value.submissionIdentity === undefined) !== (value.submissionFingerprint === undefined) ||
    (value.admittedAt !== undefined &&
      (typeof value.admittedAt !== 'number' || !Number.isFinite(value.admittedAt))) ||
    (value.frozenShellContext !== undefined &&
      (!isRecord(value.frozenShellContext) ||
        typeof value.frozenShellContext.cwd !== 'string' ||
        typeof value.frozenShellContext.handoffDir !== 'string' ||
        typeof value.frozenShellContext.runtimeRoot !== 'string' ||
        typeof value.frozenShellContext.notebookSessionRoot !== 'string' ||
        typeof value.frozenShellContext.inputRoot !== 'string' ||
        !Array.isArray(value.frozenShellContext.protectedDirs) ||
        !value.frozenShellContext.protectedDirs.every((entry) => typeof entry === 'string') ||
        !isRecord(value.frozenShellContext.environment) ||
        !Object.values(value.frozenShellContext.environment).every(
          (entry) => typeof entry === 'string'
        ) ||
        typeof value.frozenShellContext.timeoutMs !== 'number' ||
        !Number.isFinite(value.frozenShellContext.timeoutMs) ||
        typeof value.frozenShellContext.platform !== 'string')) ||
    (value.shellConcurrency !== undefined &&
      (!isRecord(value.shellConcurrency) ||
        !Number.isSafeInteger(value.shellConcurrency.limit) ||
        Number(value.shellConcurrency.limit) < 1 ||
        (value.shellConcurrency.slot !== undefined &&
          (!Number.isSafeInteger(value.shellConcurrency.slot) ||
            Number(value.shellConcurrency.slot) < 1 ||
            Number(value.shellConcurrency.slot) > Number(value.shellConcurrency.limit))))) ||
    typeof value.cellId !== 'string' ||
    (value.source !== 'agent' && value.source !== 'user') ||
    typeof value.script !== 'string' ||
    !['queued', 'running', 'completed', 'failed', 'timeout', 'interrupted', 'cancelled'].includes(
      String(value.status)
    ) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    (value.cancellationRequestedAt !== undefined &&
      (typeof value.cancellationRequestedAt !== 'number' ||
        !Number.isFinite(value.cancellationRequestedAt))) ||
    (value.cancellationReason !== undefined && typeof value.cancellationReason !== 'string') ||
    // Shell execution can persist signed exit codes (including -1 on Windows).
    // Preserve those terminal facts when reopening history, including for package export.
    (value.exitCode !== undefined &&
      value.exitCode !== null &&
      (!Number.isSafeInteger(value.exitCode) ||
        (Number(value.exitCode) < 0 && value.kernelKind !== 'bash'))) ||
    (value.kernelEpochId !== undefined &&
      (typeof value.kernelEpochId !== 'string' || value.kernelEpochId.length === 0)) ||
    (value.executionStarted !== undefined && typeof value.executionStarted !== 'boolean') ||
    (value.kernelDispatched !== undefined && typeof value.kernelDispatched !== 'boolean') ||
    (value.replPersistentBindings !== undefined &&
      (value.replPersistentBindings !== true || value.kernelKind !== 'repl')) ||
    (value.runtimeId !== undefined && typeof value.runtimeId !== 'string') ||
    (value.kernelKind !== undefined &&
      value.kernelKind !== 'python' &&
      value.kernelKind !== 'r' &&
      value.kernelKind !== 'repl' &&
      value.kernelKind !== 'bash')
  ) {
    return false
  }
  if (value.frozenRuntimeTarget !== undefined) {
    const target = isRecord(value.frozenRuntimeTarget) ? value.frozenRuntimeTarget : undefined
    if (
      !target ||
      (target.language !== 'python' && target.language !== 'r' && target.language !== 'repl') ||
      typeof target.environment !== 'string' ||
      typeof target.processKey !== 'string' ||
      (target.runtimeId !== undefined && typeof target.runtimeId !== 'string') ||
      (target.source !== undefined &&
        target.source !== 'managed' &&
        target.source !== 'external') ||
      (target.interpreterPath !== undefined && typeof target.interpreterPath !== 'string') ||
      (target.command !== undefined && typeof target.command !== 'string') ||
      (target.args !== undefined &&
        (!Array.isArray(target.args) || target.args.some((arg) => typeof arg !== 'string'))) ||
      (target.condaPrefix !== undefined && typeof target.condaPrefix !== 'string')
    ) {
      return false
    }
  }
  if (value.frozenPermissionScope !== undefined) {
    const scope = isRecord(value.frozenPermissionScope) ? value.frozenPermissionScope : undefined
    if (
      !scope ||
      !Array.isArray(scope.allowedHelperSkillIds) ||
      scope.allowedHelperSkillIds.some((skillId) => typeof skillId !== 'string')
    ) {
      return false
    }
  }
  if (
    value.workingFiles !== undefined &&
    (!Array.isArray(value.workingFiles) ||
      value.workingFiles.some(
        (file) =>
          !isRecord(file) ||
          typeof file.path !== 'string' ||
          (file.generationId !== undefined &&
            (typeof file.generationId !== 'string' || file.generationId.length === 0)) ||
          !isOptionalSha256(file.checksum) ||
          (file.change !== undefined && file.change !== 'created' && file.change !== 'modified')
      ))
  ) {
    return false
  }
  if (
    value.fileEvidence !== undefined &&
    !parseOwnedExecutionFileEvidenceSummary(value.fileEvidence, {
      activityId: String(value.runId),
      activityKind: 'notebook-run'
    })
  ) {
    return false
  }
  if (
    value.artifacts !== undefined &&
    (!Array.isArray(value.artifacts) ||
      value.artifacts.some(
        (artifact) =>
          !isRecord(artifact) ||
          typeof artifact.path !== 'string' ||
          (typeof artifact.projectId !== 'string' && typeof artifact.projectName !== 'string')
      ))
  ) {
    return false
  }
  if (
    value.helperModules !== undefined &&
    (!Array.isArray(value.helperModules) ||
      // Analysis budgets are not validity constraints on durable execution history.
      value.helperModules.some((helper) => decodeNotebookHelperEvidence(helper).state !== 'valid'))
  ) {
    return false
  }
  if (
    value.helperEvidenceStatus !== undefined &&
    !notebookHelperEvidenceStatusCandidate(value.helperEvidenceStatus)
  ) {
    return false
  }
  return true
}

const notebookDocumentCandidate = (value: unknown): NotebookRunDocument | undefined =>
  isRecord(value) && Array.isArray(value.runs) ? (value as NotebookRunDocument) : undefined

function assertNotebookDocumentShape(value: unknown): asserts value is NotebookRunDocument {
  if (!isRecord(value)) throw new CorruptNotebookDocumentError()
  const kernel = isRecord(value.kernel) ? value.kernel : undefined
  if (
    (typeof value.projectId !== 'string' && typeof value.projectName !== 'string') ||
    typeof value.sessionId !== 'string' ||
    typeof value.workspaceCwd !== 'string' ||
    typeof value.notebookSessionRoot !== 'string' ||
    typeof value.dataRoot !== 'string' ||
    !kernel ||
    typeof kernel.runtimeRoot !== 'string' ||
    !Array.isArray(value.runs) ||
    value.runs.some((run) => !notebookRunCandidate(run))
  ) {
    throw new CorruptNotebookDocumentError()
  }
}

type StoredNotebookDocument = Omit<NotebookRunDocument, 'version' | 'runs'> & {
  version: 1 | 2
  runs: StoredNotebookRun[]
}

const decodeNotebookDocument = (contents: string): StoredNotebookDocument => {
  const decoded = decodeVersionedJson(contents, {
    currentVersion: 2,
    legacyVersions: [1],
    readVersion: (value) =>
      typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined,
    decode: notebookDocumentCandidate
  })
  if (decoded.status === 'unsupported') throw new UnsupportedNotebookDocumentVersionError()
  if (decoded.status === 'corrupt') throw new CorruptNotebookDocumentError()
  return decoded.value as unknown as StoredNotebookDocument
}

const assertStoredNotebookDocumentShape = (document: StoredNotebookDocument): void => {
  assertNotebookDocumentShape({
    ...document,
    runs:
      document.version === 2
        ? document.runs.filter((run) => !isNotebookRunReference(run))
        : document.runs
  })
}

// The physical notebooks/<projectId>/<sessionId>/run.json path is the ownership boundary. Validate
// the persisted identity before decoding paths or normalizing request-derived fields so a misplaced
// document can never be silently adopted by its containing directory.
function assertNotebookDocumentOwnership(
  document: unknown,
  projectId: string,
  sessionId: string
): asserts document is NotebookRunDocument {
  if (!document || typeof document !== 'object') {
    throw new Error('Notebook run document ownership mismatch: run.json has no document scope.')
  }

  const scope = document as PersistedNotebookDocumentScope
  const documentProjectId = scope.projectId ?? scope.projectName
  if (documentProjectId !== projectId) {
    throw new Error(
      `Notebook run document ownership mismatch: requested projectId ${JSON.stringify(projectId)}, ` +
        `but run.json declares ${persistedScopeValue(documentProjectId)}.`
    )
  }
  if (scope.sessionId !== sessionId) {
    throw new Error(
      `Notebook run document ownership mismatch: requested sessionId ${JSON.stringify(sessionId)}, ` +
        `but run.json declares ${persistedScopeValue(scope.sessionId)}.`
    )
  }
}

// Returns the shared runtime installation root used by notebook system instructions.
const getRuntimeRoot = (storageRoot: string): string => join(storageRoot, 'runtime')

// Builds the durable workspace root for a single notebook session.
const getNotebookSessionRoot = (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  lane?: NotebookLaneIdentity
): string => {
  const root = join(
    storageRoot,
    NOTEBOOKS_DIR,
    assertSafeNotebookPathSegment(projectId),
    assertSafeNotebookPathSegment(sessionId)
  )
  if (!lane) return root
  const scope = notebookLaneScope(lane)
  if (scope.projectId !== projectId || scope.sessionId !== sessionId) {
    throw new Error('Notebook lane does not match repository request scope.')
  }
  return scope.kind === 'root'
    ? root
    : join(root, 'frames', assertSafeNotebookPathSegment(scope.agentFrameId))
}

// Resolves the persisted run history path for a notebook session.
const getNotebookRunJsonPath = (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  lane?: NotebookLaneIdentity
): string =>
  join(getNotebookSessionRoot(storageRoot, projectId, sessionId, lane), NOTEBOOK_RUN_FILE)

// Resolves the notebook-owned data directory used for raw and processed files.
const getNotebookDataRoot = (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  lane?: NotebookLaneIdentity
): string => join(getNotebookSessionRoot(storageRoot, projectId, sessionId, lane), 'data')

const getNotebookFileEvidenceLocation = (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  lane: NotebookLaneIdentity
): { root: string; storageKeyPrefix: string } => {
  const safeProjectId = assertSafeNotebookPathSegment(projectId)
  const safeSessionId = assertSafeNotebookPathSegment(sessionId)
  const scope = notebookLaneScope(lane)
  if (scope.projectId !== projectId || scope.sessionId !== sessionId) {
    throw new Error('Notebook lane does not match file-evidence scope.')
  }
  const segments = [EXECUTION_FILE_EVIDENCE_DIR, safeProjectId, safeSessionId]
  if (scope.kind === 'frame') {
    segments.push('frames', assertSafeNotebookPathSegment(scope.agentFrameId))
  }
  return {
    root: join(storageRoot, ...segments),
    storageKeyPrefix: segments.join('/')
  }
}

const getNotebookTerminalFactPath = (
  storageRoot: string,
  projectId: string,
  sessionId: string,
  lane: NotebookLaneIdentity,
  runId: string
): string =>
  join(
    getNotebookSessionRoot(storageRoot, projectId, sessionId, lane),
    RUN_TERMINAL_OUTBOX_DIR,
    `${assertSafeNotebookPathSegment(runId)}.json`
  )

const parseNotebookRunTerminalFact = (contents: string): NotebookRunTerminalFact => {
  const value: unknown = JSON.parse(contents)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.projectId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.expectedStatus !== 'running' ||
    !isRecord(value.run) ||
    !notebookRunCandidate(value.run) ||
    value.run.status === 'queued' ||
    value.run.status === 'running'
  ) {
    throw new Error('Notebook terminal outcome recovery fact is corrupt.')
  }
  return value as NotebookRunTerminalFact
}

// Creates the empty text projection used before an execution has produced output.
const emptyText = (): NotebookRunRecord['text'] => ({
  stdout: '',
  stderr: '',
  traceback: '',
  plain: []
})

// Normalizes generated working files and guarantees they remain inside the notebook workspace.
const normalizeWorkingFiles = (
  sessionRoot: string,
  runId: string,
  workingFiles: NotebookWorkingFile[] | undefined
): NotebookWorkingFile[] =>
  (workingFiles ?? []).map((file) => {
    const absolutePath = resolve(file.path)
    const root = resolve(sessionRoot)
    const relativePath = relative(root, absolutePath)

    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error('Notebook working file is outside notebook session workspace.')
    }
    if (isAbsolute(relativePath)) {
      throw new Error('Notebook working file is outside notebook session workspace.')
    }

    return {
      ...file,
      path: absolutePath,
      relativePath: file.relativePath || relativePath,
      createdByRunId: file.createdByRunId ?? runId
    }
  })

// Optional provenance keys are often absent. Only populated fields occupy the bounded cache.
const compactReplayRunIndex = (run: NotebookRunRecord): ReplayRunIndex => {
  const row = indexReplayRun(run)
  for (const key of Object.keys(row) as (keyof ReplayRunIndex)[]) {
    if (row[key] === undefined) delete row[key]
  }
  return row
}

const EMPTY_OUTPUT_BYTES = Buffer.byteLength(JSON.stringify([emptyText(), []]))
const omittedOutputBytes = (
  text: NotebookRunRecord['text'],
  outputs: NotebookRunRecord['outputs']
): number => Buffer.byteLength(JSON.stringify([text, outputs])) - EMPTY_OUTPUT_BYTES

// Fills active optional run fields while preserving retired historical fields as written. Legacy
// records predate kernelKind and were always python/r, so default (never overwrite) to 'python'.
const normalizeRun = (sessionRoot: string, run: NotebookRunRecord): NotebookRunRecord => {
  const fileEvidence = run.fileEvidence
    ? parseOwnedExecutionFileEvidenceSummary(run.fileEvidence, {
        activityId: run.runId,
        activityKind: 'notebook-run'
      })
    : undefined
  return {
    ...run,
    kernelKind: run.kernelKind ?? 'python',
    text: run.text ?? emptyText(),
    outputs: run.outputs ?? [],
    workingFiles: normalizeWorkingFiles(sessionRoot, run.runId, run.workingFiles),
    ...(fileEvidence
      ? { fileEvidence: { ...fileEvidence, reasonCodes: [...fileEvidence.reasonCodes] } }
      : {}),
    inputFiles: (run.inputFiles ?? []).map((input) => ({ ...input }))
  }
}

const kernelInstanceIdentityKey = (instance: NotebookKernelInstanceIdentity): string =>
  instance.kind === 'repl' ? 'repl' : `${instance.kind}:${instance.environment}`

const sameKernelInstance = (
  left: NotebookKernelInstanceIdentity,
  right: NotebookKernelInstanceIdentity
): boolean => kernelInstanceIdentityKey(left) === kernelInstanceIdentityKey(right)

const normalizeTerminatedKernelInstances = (
  value: unknown
): NotebookKernelInstanceIdentity[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const instances = new Map<string, NotebookKernelInstanceIdentity>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || !('kind' in candidate)) continue
    if (candidate.kind === 'repl') {
      instances.set('repl', { kind: 'repl' })
      continue
    }
    if (
      (candidate.kind === 'python' || candidate.kind === 'r') &&
      'environment' in candidate &&
      typeof candidate.environment === 'string' &&
      candidate.environment.length > 0
    ) {
      const instance = { kind: candidate.kind, environment: candidate.environment }
      instances.set(kernelInstanceIdentityKey(instance), instance)
    }
  }
  return instances.size > 0 ? [...instances.values()] : undefined
}

const canonicalKernelMetadata = (kernel: NotebookKernelMetadata): NotebookKernelMetadata => {
  // `language: 'python'` predates multi-kernel documents. It was never read and cannot represent a
  // history containing Python, R, REPL, and Bash runs, so accept it from old run.json files but never
  // return or persist it as canonical metadata.
  const next = { ...kernel } as NotebookKernelMetadata & { language?: unknown }
  delete next.language
  return next
}

const withoutTerminatedKernelInstances = (
  kernel: NotebookKernelMetadata
): NotebookKernelMetadata => {
  const next = canonicalKernelMetadata(kernel)
  delete next.terminatedKernelInstances
  return next
}

const ownRun = (lane: NotebookLaneIdentity, run: NotebookRunRecord): NotebookRunRecord => {
  const scope = notebookLaneScope(lane)
  const agentFrameId = run.agentFrameId ?? scope.agentFrameId
  // Root lanes share one durable document across their provisional and conversation Frame ids. Keep
  // the Run's self-consistent root provenance; child lanes must still match their exact Frame owner.
  const matchesRootRunProvenance =
    scope.kind === 'root' && run.rootFrameId !== undefined && agentFrameId === run.rootFrameId
  if (agentFrameId !== scope.agentFrameId && !matchesRootRunProvenance) {
    throw new Error('Notebook Run Frame owner does not match its lane.')
  }
  return { ...run, agentFrameId }
}

// Repairs or initializes a run document with canonical paths and kernel metadata.
const normalizeDocument = (
  storageRoot: string,
  request: NormalizeNotebookRunDocumentRequest,
  document: NotebookRunDocument
): NotebookRunDocument => {
  assertNotebookDocumentOwnership(document, request.projectId, request.sessionId)
  const storageProjectId = assertSafeNotebookPathSegment(request.projectId)
  const projectId = assertSafeNotebookPathSegment(document.projectId)
  const sessionId = assertSafeNotebookPathSegment(request.sessionId)
  const notebookSessionRoot = getNotebookSessionRoot(
    storageRoot,
    storageProjectId,
    sessionId,
    request.lane
  )
  const terminatedKernelInstances = normalizeTerminatedKernelInstances(
    document.kernel?.terminatedKernelInstances
  )

  return {
    ...document,
    version: 1,
    projectId,
    sessionId,
    artifactSessionId: request.artifactSessionId ?? document.artifactSessionId,
    workspaceCwd: request.workspaceCwd ?? document.workspaceCwd,
    notebookSessionRoot,
    dataRoot: getNotebookDataRoot(storageRoot, storageProjectId, sessionId, request.lane),
    kernel: {
      ...withoutTerminatedKernelInstances(document.kernel),
      pythonPath: request.pythonPath ?? document.kernel?.pythonPath,
      kernelName: request.kernelName ?? document.kernel?.kernelName ?? 'python3',
      runtimeRoot: getRuntimeRoot(storageRoot),
      lastKnownStatus: terminatedKernelInstances
        ? 'terminated'
        : (document.kernel?.lastKnownStatus ?? 'idle'),
      ...(terminatedKernelInstances ? { terminatedKernelInstances } : {})
    },
    runs: (document.runs ?? []).map((run) => normalizeRun(notebookSessionRoot, run)),
    updatedAt: document.updatedAt ?? Date.now()
  }
}

type HistoryWindow = {
  runs: NotebookRunRecord[]
  total: number
  latestRunEnvironments: Partial<Record<'python' | 'r', string>>
  historySummary?: NotebookRunHistorySummary
  agentSummaries: NotebookAgentSummary[]
  historyPage?: { hasEarlierRuns: boolean; oldestCursor?: NotebookRunCursor }
}

export type NotebookHistorySnapshot = { window: HistoryWindow; kernel?: NotebookKernelMetadata }

function selectRunWindow(
  documents: ReadonlyArray<Pick<NotebookRunDocument, 'runs'>>,
  sessionId: string,
  limit: number,
  requestedRunIds: ReadonlySet<string>,
  historySummaryFrameId?: string,
  historyBefore?: NotebookRunCursor
): HistoryWindow {
  const runs: NotebookRunRecord[] = []
  const requestedRuns = new Map<string, NotebookRunRecord>()
  const latestEnvironmentRuns = new Map<'python' | 'r', NotebookRunRecord>()
  const historySummary: NotebookRunHistorySummary | undefined = historySummaryFrameId
    ? {
        agentFrameId: historySummaryFrameId,
        runCount: 0,
        kernelCounts: { python: 0, r: 0, repl: 0, bash: 0 }
      }
    : undefined
  const matchesSummaryFrame = historySummary
    ? createNotebookFrameRunFilter(
        sessionId,
        historySummary.agentFrameId,
        documents.flatMap((document) => document.runs)
      )
    : undefined
  let latestSummaryDataRun: NotebookRunRecord | undefined
  let total = 0
  let eligibleTotal = 0
  const compareRuns = (left: NotebookRunRecord, right: NotebookRunRecord): number =>
    left.startedAt - right.startedAt || left.runId.localeCompare(right.runId)

  for (const document of documents) {
    for (const run of document.runs) {
      total += 1
      if (requestedRunIds.has(run.runId)) requestedRuns.set(run.runId, run)
      if (historySummary && matchesSummaryFrame?.(run)) {
        historySummary.runCount += 1
        historySummary.kernelCounts[run.kernelKind] += 1
        if (
          (run.kernelKind === 'python' || run.kernelKind === 'r') &&
          (!latestSummaryDataRun || compareRuns(latestSummaryDataRun, run) < 0)
        ) {
          latestSummaryDataRun = run
          historySummary.latestDataKernel = run.kernelKind
        }
      }
      if (
        (run.kernelKind === 'python' || run.kernelKind === 'r') &&
        run.environment &&
        (!latestEnvironmentRuns.has(run.kernelKind) ||
          compareRuns(latestEnvironmentRuns.get(run.kernelKind)!, run) < 0)
      ) {
        latestEnvironmentRuns.set(run.kernelKind, run)
      }
      if (limit <= 0) continue
      if (
        historyBefore &&
        (run.startedAt > historyBefore.startedAt ||
          (run.startedAt === historyBefore.startedAt &&
            run.runId.localeCompare(historyBefore.runId) >= 0))
      ) {
        continue
      }
      eligibleTotal += 1
      let low = 0
      let high = runs.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (compareRuns(runs[middle], run) <= 0) low = middle + 1
        else high = middle
      }
      runs.splice(low, 0, run)
      if (runs.length > limit) runs.shift()
    }
  }

  const pageRuns = [...runs]
  const mergedRuns = new Map(pageRuns.map((run) => [run.runId, run]))
  for (const run of requestedRuns.values()) mergedRuns.set(run.runId, run)
  return {
    runs: [...mergedRuns.values()].sort(compareRuns),
    total,
    agentSummaries: summarizeNotebookHistory(
      sessionId,
      documents.flatMap((document) => document.runs)
    ),
    latestRunEnvironments: Object.fromEntries(
      [...latestEnvironmentRuns.entries()].map(([kind, run]) => [kind, run.environment!])
    ),
    historyPage: {
      hasEarlierRuns: eligibleTotal > pageRuns.length,
      ...(pageRuns[0]
        ? { oldestCursor: { startedAt: pageRuns[0].startedAt, runId: pageRuns[0].runId } }
        : {})
    },
    ...(historySummary ? { historySummary } : {})
  }
}

type PendingLane = {
  storageRoot: string
  projectId: string
  sessionId: string
  lane: NotebookLaneIdentity
  recoveryError?: Error
}
// Repositories for the same data root share checkpoint obligations and failed recovery fences.
const pendingLanes = new Map<string, PendingLane>()
const storageWrites = new Map<string, Promise<void>>()

// Owns durable run.json persistence for one app storage root.
class NotebookRunRepository {
  private readonly records = new NotebookRunRecordStorage()
  private get saveQueue(): Promise<void> {
    return storageWrites.get(resolve(this.storageRoot)) ?? Promise.resolve()
  }
  // Analysis rows omit output, but replay still needs its original size and presence.
  private readonly analysisIndexDetails = new WeakMap<
    NotebookRunRecord,
    Pick<ReplayRunIndex, 'detailBytes' | 'hasOutput'>
  >()
  private readonly pendingViews = new Map<
    string,
    {
      identity: DocumentFileIdentity
      coldCount: number
      references: RunReference[]
      coldHasBackgroundRuns: boolean
      analysis?: StoredNotebookRun[]
      ids: Set<string>
      submissions: Set<string>
      document: NotebookRunDocument
    }
  >()
  private readonly recoveringLane = new AsyncLocalStorage<string>()
  private readonly observedDeleted = new Set<string>()
  private readonly coldCounts = new WeakMap<NotebookRunDocument, number>()
  private readonly publishedEnvironmentManifests = new Set<string>()
  private readonly documentCache = new Map<
    string,
    DocumentFileIdentity & { weight: number; document: NotebookRunDocument }
  >()
  private documentCacheBytes = 0
  private readonly pendingDocumentReads = new Map<
    string,
    {
      identity: DocumentFileIdentity
      result: Promise<{ document: NotebookRunDocument; stable: boolean }>
    }
  >()
  // Keep metadata after an oversized document is released. Cap even unusual IDs or very long histories.
  private readonly laneSummaries = new Map<
    string,
    { identity: DocumentFileIdentity; summary: LaneSummary }
  >()
  private readonly lifecycleViews = new WeakMap<
    LaneSummary,
    { remaining: NotebookRunDocument; detached: DetachedRuns }
  >()

  private readonly historyBodies = new WeakMap<NotebookRunRecord, HistoryBody>()
  private readonly inlineSlots = new WeakMap<NotebookRunRecord, InlineRunSlot>()
  private readonly inlineOutputs = new WeakMap<
    NotebookRunRecord,
    Pick<NotebookRunRecord, 'text' | 'outputs'>
  >()
  private readonly backgroundOutputBytes = new WeakMap<RunReference, number>()
  private readonly runIndexes = new WeakMap<
    NotebookRunDocument,
    { rows: ReplayRunIndex[]; byId: Map<string, NotebookRunRecord> }
  >()

  private runIndex(document: NotebookRunDocument): {
    rows: ReplayRunIndex[]
    byId: Map<string, NotebookRunRecord>
  } {
    let index = this.runIndexes.get(document)
    if (!index) {
      index = {
        rows: document.runs.map(indexReplayRun),
        byId: new Map(document.runs.map((run) => [run.runId, run]))
      }
      this.runIndexes.set(document, index)
    }
    return index
  }

  private async cachedLaneSummary(filePath: string): Promise<LaneSummary | undefined> {
    const cached = this.laneSummaries.get(filePath)
    if (!cached) return undefined
    return sameDocumentFileIdentity(cached.identity, await statIfPresent(filePath))
      ? cached.summary
      : undefined
  }

  private async hasRecoveryCandidate(filePath: string): Promise<boolean> {
    try {
      const entries = await readdir(dirname(filePath), { withFileTypes: true })
      return entries.some(
        (entry) => entry.isFile() && isRecoverableDurableJsonTemporaryFile(filePath, entry.name)
      )
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  private async cachedSessionSummaries(
    projectId: string,
    sessionId: string
  ): Promise<LaneSummary[] | undefined> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId)
    const root = await this.cachedLaneSummary(path)
    const summaries: LaneSummary[] = []
    if (root) summaries.push(root)
    else if ((await this.pathExists(path)) || (await this.hasRecoveryCandidate(path)))
      return undefined
    for (const frameId of await this.frameIds(projectId, sessionId)) {
      const lane = createFrameNotebookLane(projectId, sessionId, frameId)
      const summary = await this.cachedLaneSummary(
        getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
      )
      if (!summary) return undefined
      summaries.push(summary)
    }
    return summaries
  }

  private async cachedHistory(
    projectId: string,
    sessionId: string,
    detachedBodies?: Map<NotebookRunRecord, HistoryBody>,
    backgroundTaskMetadata = false,
    evidenceOnly = false,
    missingOutput?: Map<NotebookRunRecord, InlineRunSlot | undefined>
  ): Promise<{ summaries: LaneSummary[]; documents: LaneHistory[] } | undefined> {
    const root = getNotebookSessionRoot(this.storageRoot, projectId, sessionId)
    const framesRoot = join(root, 'frames')
    if (
      !Array.from(this.laneSummaries.values()).some(
        ({ summary }) =>
          (((evidenceOnly || missingOutput) &&
            this.pendingViews.get(join(summary.notebookSessionRoot, NOTEBOOK_RUN_FILE))
              ?.analysis) ||
            summary.history ||
            (detachedBodies && this.lifecycleViews.get(summary)?.detached.analysis)) &&
          (summary.notebookSessionRoot === root ||
            dirname(summary.notebookSessionRoot) === framesRoot)
      )
    )
      return undefined
    const summaries = await this.cachedSessionSummaries(projectId, sessionId)
    if (!summaries?.length) return undefined
    const hasDetachedLane =
      detachedBodies && summaries.some((s) => this.lifecycleViews.get(s)?.detached.analysis)
    const validateSiblings = evidenceOnly || backgroundTaskMetadata || hasDetachedLane
    const documents = []
    for (const summary of summaries) {
      const path = join(summary.notebookSessionRoot, NOTEBOOK_RUN_FILE)
      if (summary.history) {
        if (validateSiblings) {
          const refs = summary.history.runs.flatMap((run) => this.historyBodies.get(run)?.ref ?? [])
          if (
            (await this.hasRecoveryCandidate(path)) ||
            !(await this.records.unchanged(summary.notebookSessionRoot, refs))
          )
            return undefined
        }
        documents.push(summary.history)
        continue
      }
      if (evidenceOnly || missingOutput) {
        const compact = await this.readCompactMetadata(path)
        if (compact) {
          const runs = this.historyRuns(compact, projectId, sessionId)
          if (missingOutput) {
            compact.runs.forEach((row, i) => {
              if (!this.analysisIndexDetails.has(row)) return
              const inline = this.inlineOutputs.get(row)
              const external = this.historyBodies.get(row)
              if (inline) runs[i] = { ...runs[i], ...inline }
              else if (external && detachedBodies) detachedBodies.set(runs[i], external)
              else missingOutput.set(runs[i], this.inlineSlots.get(row))
            })
          }
          documents.push({ ...compact, runs })
          continue
        }
      }
      if (detachedBodies && this.lifecycleViews.get(summary)?.detached.analysis) {
        const lane =
          summary.notebookSessionRoot === root
            ? undefined
            : createFrameNotebookLane(projectId, sessionId, basename(summary.notebookSessionRoot))
        const history = await this.readDetachedHistory(projectId, sessionId, lane, detachedBodies)
        if (!history) return undefined
        documents.push(history)
        continue
      }
      // Small sibling lanes can use the repository's existing full-document cache.
      const full = this.documentCache.get(path)
      const cached = this.laneSummaries.get(path)
      if (!full || cached?.summary !== summary || !sameDocumentFileIdentity(cached.identity, full))
        return undefined
      if (validateSiblings) {
        if (await this.hasRecoveryCandidate(path)) return undefined
        if (full.weight > full.size) {
          const refs = this.records.referencesFor(summary.notebookSessionRoot, full.document.runs)
          if (!(await this.records.unchanged(summary.notebookSessionRoot, refs))) return undefined
        }
      }
      documents.push({
        ...full.document,
        runs: this.historyRuns(full.document, projectId, sessionId)
      })
    }
    return { summaries, documents }
  }

  /** Validated metadata selects the same window as full history. Hydration stops as soon as the next record exceeds the byte budget. */
  async readCachedHistoryWindow(
    projectId: string,
    sessionId: string,
    query: {
      limit: number
      runIds: readonly string[]
      frameId?: string
      before?: NotebookRunCursor
      lane?: NotebookLaneIdentity
      evidenceOnly?: boolean
      backgroundTaskMetadata?: boolean
      retain?: (
        run: NotebookRunRecord,
        index: number,
        count: number,
        omittedBytes?: number
      ) => boolean
    }
  ): Promise<NotebookHistorySnapshot | undefined> {
    const { limit, runIds, frameId, before, lane, retain } = query
    const detachedBodies = new Map<NotebookRunRecord, HistoryBody>()
    const missingOutput = query.evidenceOnly
      ? undefined
      : new Map<NotebookRunRecord, InlineRunSlot | undefined>()
    const cached = await this.cachedHistory(
      projectId,
      sessionId,
      detachedBodies,
      query.backgroundTaskMetadata,
      query.evidenceOnly,
      missingOutput
    )
    if (!cached) return undefined
    const path = lane && getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    const kernel = path
      ? cached.documents.find((doc) => doc.notebookSessionRoot === dirname(path))?.kernel
      : undefined
    if (path) {
      if (!kernel || (await this.hasRecoveryCandidate(path))) return undefined
      await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
    }
    const requested = new Set(runIds)
    const window = selectRunWindow(cached.documents, sessionId, limit, requested, frameId, before)
    const runs: NotebookRunRecord[] = []
    const hydrate = this.environmentManifestReader(requested)
    // Older foreground rows cannot change which newer background tasks fit the byte limit.
    const first = query.backgroundTaskMetadata
      ? window.runs.findIndex((run) => run.executionMode === 'background')
      : 0
    let inlineBatch: Map<NotebookRunRecord, NotebookRunRecord> | undefined
    for (let index = window.runs.length - 1; first >= 0 && index >= first; index--) {
      const row = window.runs[index]
      let inline: NotebookRunRecord | undefined
      if (missingOutput?.has(row)) {
        try {
          if (!inlineBatch?.has(row))
            inlineBatch = await readInlineRunBatch(window.runs, index, missingOutput)
          inline = inlineBatch?.get(row)
          if (!inline) return undefined
        } catch {
          return undefined
        }
      }
      const body = this.historyBodies.get(row) ?? detachedBodies.get(row)
      let run = inline
        ? { ...row, text: inline.text ?? emptyText(), outputs: inline.outputs ?? [] }
        : row
      let omittedBytes =
        body && query.backgroundTaskMetadata ? this.backgroundOutputBytes.get(body.ref) : undefined
      if (
        body &&
        !query.evidenceOnly &&
        (!query.backgroundTaskMetadata || omittedBytes === undefined)
      ) {
        try {
          const [raw] = await this.records.read(body.root, [body.ref])
          const text = raw.text ?? emptyText()
          const outputs = raw.outputs ?? []
          if (query.backgroundTaskMetadata) {
            omittedBytes = omittedOutputBytes(text, outputs)
            this.backgroundOutputBytes.set(body.ref, omittedBytes)
          } else {
            run = { ...row, text, outputs }
          }
        } catch {
          // Re-enter normal lane validation so live and imported corruption policies apply.
          return undefined
        }
      }
      run = await hydrate(run)
      if (retain && !retain(run, index, window.runs.length, omittedBytes) && runs.length > 0) {
        const { runId, startedAt } = runs[runs.length - 1]
        window.historyPage = { hasEarlierRuns: true, oldestCursor: { runId, startedAt } }
        break
      }
      runs.push(run)
    }
    const latest = await this.cachedSessionSummaries(projectId, sessionId)
    if (
      latest?.length !== cached.summaries.length ||
      !latest.every((s, i) => s === cached.summaries[i])
    )
      return undefined
    return { kernel, window: { ...window, runs: runs.reverse() } }
  }

  // Dependency analysis consumes source, runtime and file evidence; it never consumes output.
  async readAnalysisRuns(
    projectId: string,
    sessionId: string,
    options: ReadSessionRunsOptions = {}
  ): Promise<NotebookRunRecord[]> {
    const cached = await this.cachedHistory(projectId, sessionId)
    const lanes = cached
      ? cached.documents.map((doc) => doc.runs)
      : await this.readSessionLaneValues(projectId, sessionId, (lane) =>
          this.readLaneAnalysisRuns(projectId, sessionId, lane)
        )
    const runs = lanes
      .flat()
      .sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
    if (!options.includeEnvironmentManifests) return runs
    return Promise.all(runs.map(this.environmentManifestReader()))
  }

  private async readCompactMetadata(path: string): Promise<NotebookRunDocument | undefined> {
    const compact = this.pendingViews.get(path)
    if (!compact?.analysis) return undefined
    const { identity, references, analysis, document } = compact
    if (!(await this.laneFilesUnchanged(path, identity, references, { verifyUnseen: true })))
      return undefined
    const deferred = analysis.filter(isNotebookRunReference)
    const replacements = new Map<RunReference, NotebookRunRecord>()
    if (deferred.length) {
      const root = dirname(path)
      const hydrated = await this.hydrate(path, { ...document, runs: deferred })
      const decoded = decodeRunDocumentDataPaths(hydrated, this.storageRoot)
      for (const [i, row] of decoded.runs.entries()) {
        const run = normalizeRun(root, row)
        const metadata = { ...run, text: emptyText(), outputs: [] }
        const { detailBytes, hasOutput } = indexReplayRun(run)
        this.analysisIndexDetails.set(metadata, { detailBytes, hasOutput })
        this.historyBodies.set(metadata, { root, ref: deferred[i] })
        replacements.set(deferred[i], metadata)
      }
      if (!sameDocumentFileIdentity(identity, await statIfPresent(path))) return undefined
    }
    const cold = analysis.map((row) => (isNotebookRunReference(row) ? replacements.get(row)! : row))
    return { ...document, runs: [...cold, ...document.runs] }
  }

  // One physical lane in manifest order. A corrupt history must reach the admission caller.
  async readLaneAnalysisRuns(
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity
  ): Promise<NotebookRunRecord[]> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    const compact = await this.readCompactMetadata(path)
    if (compact) return this.historyRuns(compact, projectId, sessionId)
    const entry = this.laneSummaries.get(path)
    const history = entry?.summary.history
    if (entry && history) {
      const refs: RunReference[] = []
      for (const run of history.runs) {
        const body = this.historyBodies.get(run)
        if (body) refs.push(body.ref)
      }
      if (await this.laneFilesUnchanged(path, entry.identity, refs)) return history.runs
    }
    const detached = await this.readDetachedHistory(projectId, sessionId, lane)
    if (detached) return detached.runs
    const document = await this.findExisting(projectId, sessionId, lane)
    return document ? this.historyRuns(document, projectId, sessionId) : []
  }

  private async readDetachedHistory(
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity,
    bodies?: Map<NotebookRunRecord, HistoryBody>
  ): Promise<LaneHistory | undefined> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    const entry = this.laneSummaries.get(path)
    const view = entry && this.lifecycleViews.get(entry.summary)
    const analysis = view?.detached.analysis
    if (
      entry &&
      view &&
      analysis &&
      (await this.laneFilesUnchanged(
        path,
        entry.identity,
        Array.from(view.detached.slots.values())
      ))
    ) {
      // Newly published inline Runs still have their in-memory shape. Apply the same
      // portable-path and JSON normalization as reopening their bounded manifest.
      const encoded = encodeRunDocumentDataPaths(view.remaining, this.storageRoot)
      const inline = normalizeDocument(
        this.storageRoot,
        { projectId, sessionId, lane },
        decodeRunDocumentDataPaths(
          JSON.parse(JSON.stringify(encoded)) as NotebookRunDocument,
          this.storageRoot
        )
      )
      let nextInline = 0
      const runs = Array.from(
        { length: analysis.size + view.remaining.runs.length },
        (_, index) => analysis.get(index) ?? inline.runs[nextInline++]
      )
      const history = this.historyRuns({ ...inline, runs }, projectId, sessionId)
      if (bodies) {
        for (const [index, ref] of view.detached.slots) {
          bodies.set(history[index], { root: inline.notebookSessionRoot, ref })
        }
      }
      return { ...inline, runs: history }
    }
    return undefined
  }

  async hasCachedForegroundOnlyHistory(
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity
  ): Promise<boolean> {
    // A queued admission can turn an otherwise valid foreground-only snapshot stale.
    await this.saveQueue
    const summaries = await this.cachedSessionSummaries(projectId, sessionId)
    if (!summaries?.length || summaries.some((summary) => summary.hasBackgroundRuns)) return false
    if (lane) {
      const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
      if (!summaries.some((summary) => summary.notebookSessionRoot === dirname(path))) return false
      // loadOrCreate normally checks for pending durable writes and repairs the input directory.
      if (await this.hasRecoveryCandidate(path)) return false
      await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
    }
    return true
  }

  async readSessionRunIndex(projectId: string, sessionId: string): Promise<ReplayRunIndex[]> {
    const lanes = await this.readSessionLaneValues(projectId, sessionId, async (lane) => {
      const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
      const summary = await this.cachedLaneSummary(path)
      if (summary?.rows) return summary.rows.map(indexReplayRun)
      const compact = await this.readCompactMetadata(path)
      if (compact)
        return compact.runs.map((run) => ({
          ...indexReplayRun(run),
          ...this.analysisIndexDetails.get(run)
        }))
      return this.runIndex(await this.loadExisting(projectId, sessionId, lane)).rows
    })
    const rows = lanes.flat()
    return rows.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  }

  async readSessionRun(
    projectId: string,
    sessionId: string,
    runId: string
  ): Promise<NotebookRunRecord | undefined> {
    for (const document of await this.readSessionDocuments(projectId, sessionId)) {
      const run = this.runIndex(document).byId.get(runId)
      if (!run) continue
      const hydrated = await this.withEnvironmentManifests(document, [run])
      return hydrated.runs[0]
    }
    return undefined
  }

  constructor(
    private readonly storageRoot: string,
    private readonly deletedSessionScopes?: () => Promise<ReadonlyMap<string, boolean>>
  ) {
    this.storageRoot = resolve(storageRoot)
  }

  withinHistoryRead<T>(projectId: string, sessionId: string, read: () => Promise<T>): Promise<T> {
    return this.records.withinHistoryRead(
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId),
      read
    )
  }

  private async hydrate(
    filePath: string,
    stored: StoredNotebookDocument
  ): Promise<NotebookRunDocument> {
    try {
      const document = {
        ...stored,
        version: 1 as const,
        runs: await this.records.read(dirname(filePath), stored.runs)
      }
      assertNotebookDocumentShape(document)
      return document
    } catch {
      // A missing record is corruption, never an absent Notebook that may be recreated.
      throw new CorruptNotebookDocumentError()
    }
  }

  // Session initialization needs evidence and lifecycle metadata from recovery, including every Run.
  async loadSessionInitialization(
    request: Pick<
      LoadNotebookRunDocumentRequest,
      'projectId' | 'sessionId' | 'workspaceCwd' | 'lane'
    >
  ): Promise<SessionInitialization> {
    const { projectId, sessionId, lane } = request
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    if (await this.hasRecoveryCandidate(path)) return this.loadOrCreate(request)
    const entry = this.laneSummaries.get(path)
    const full = this.documentCache.get(path)
    const snapshot =
      entry?.summary.history ??
      (entry && full && sameDocumentFileIdentity(entry.identity, full) ? full.document : undefined)
    const document =
      snapshot && (await this.cachedLaneSummary(path)) === entry?.summary
        ? snapshot
        : ((await this.readCompactMetadata(path)) ??
          (await this.readDetachedHistory(projectId, sessionId, lane)) ??
          (await this.findExisting(projectId, sessionId, lane)))
    if (!document) return this.loadOrCreate(request)
    await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
    return document
  }

  // Live history queries need the active kernel and staging directory, even for an empty page.
  async loadSessionKernel(
    request: LoadNotebookRunDocumentRequest
  ): Promise<NotebookKernelMetadata> {
    const { projectId, sessionId, lane } = request
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    await this.saveQueue
    const compact = this.pendingViews.get(path)
    if (
      lane &&
      compact &&
      (await this.laneFilesUnchanged(path, compact.identity, compact.references, {
        verifyUnseen: true
      }))
    ) {
      await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
      return normalizeDocument(this.storageRoot, request, { ...compact.document, runs: [] }).kernel
    }
    const full = this.documentCache.get(path)
    if (full && lane) {
      const refs =
        full.weight > full.size ? this.records.referencesFor(dirname(path), full.document.runs) : []
      if (await this.laneFilesUnchanged(path, full, refs, { verifyUnseen: true })) {
        assertNotebookDocumentShape(full.document)
        await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
        // A freshly published header can still contain the pre-normalized termination status.
        return normalizeDocument(this.storageRoot, request, { ...full.document, runs: [] }).kernel
      }
    }
    // A cold kernel lookup can populate the validated history cache for the same request.
    const cold = !full && !compact && !pendingLanes.get(path)?.recoveryError
    if (
      lane &&
      (cold || (full && (await pendingDirectoryIdentity(path)))) &&
      !(await this.hasRecoveryCandidate(path))
    ) {
      const logical = await this.findExisting(projectId, sessionId, lane)
      if (logical) {
        await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
        return normalizeDocument(this.storageRoot, request, { ...logical, runs: [] }).kernel
      }
    }
    return (await this.loadOrCreate(request)).kernel
  }

  // Loads an existing history file or creates the directory skeleton and first run.json.
  async loadOrCreate(request: LoadNotebookRunDocumentRequest): Promise<NotebookRunDocument> {
    return this.enqueueSave(() => this.openDocument(request))
  }

  private async openDocument(
    request: LoadNotebookRunDocumentRequest
  ): Promise<NotebookRunDocument> {
    if (!request.lane) throw new Error('Notebook writes require an explicit Frame lane.')
    const projectId = assertSafeNotebookPathSegment(request.projectId)
    const sessionId = assertSafeNotebookPathSegment(request.sessionId)
    const filePath = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, request.lane)

    this.assertLaneWritable(filePath)
    const read = await readDurableJsonFile(filePath, (contents) => {
      const document = decodeNotebookDocument(contents)
      assertNotebookDocumentOwnership(document, projectId, sessionId)
      assertStoredNotebookDocumentShape(document)
      return document
    })
    if (read.status === 'found') {
      // Decode $DATA sentinels against the current data root before recomputing session roots,
      // so a relocated data root and the decoded working-file paths agree.
      const coldCount = read.value.runs.length
      const pending = await mergePendingRuns(
        filePath,
        this.pendingScope(filePath, projectId, sessionId),
        read.value.runs,
        notebookRunCandidate
      )
      if (pending.updatedAt)
        read.value.updatedAt = Math.max(pending.updatedAt, read.value.updatedAt)
      const hydrated = await this.hydrate(filePath, read.value)
      const decoded = decodeRunDocumentDataPaths(hydrated, this.storageRoot)
      await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
      const normalized = normalizeDocument(this.storageRoot, request, decoded)
      this.coldCounts.set(normalized, pending.checkpointed ? -1 : coldCount)
      this.records.remember(normalized.runs, read.value.runs, dirname(filePath))
      return normalized
    }

    if (await pendingDirectoryIdentity(filePath)) throw new CorruptNotebookDocumentError()
    const document = normalizeDocument(this.storageRoot, request, {
      version: 1,
      projectId,
      sessionId,
      workspaceCwd: request.workspaceCwd,
      notebookSessionRoot: '',
      dataRoot: '',
      kernel: {
        pythonPath: request.pythonPath,
        kernelName: request.kernelName ?? 'python3',
        runtimeRoot: '',
        lastKnownStatus: 'idle'
      },
      runs: [],
      updatedAt: Date.now()
    })

    await this.persist(document)

    return document
  }

  // Appends a new execution record, including "running" records created before execution starts.
  async appendRun(request: AppendNotebookRunRequest): Promise<NotebookRunDocument> {
    const run = ownRun(request.lane, request.run)
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => ({
      ...document,
      runs: [...document.runs, normalizeRun(document.notebookSessionRoot, run)],
      updatedAt: Date.now()
    }))
  }

  // Durable admission's linearization point. The read, identity comparison, and append share the
  // repository mutation queue, so concurrent retries cannot create two canonical Runs.
  async appendOrGetRun(request: AppendNotebookRunRequest): Promise<AppendOrGetNotebookRunResult> {
    if (
      request.run.status !== 'queued' ||
      !request.run.submissionIdentity ||
      !request.run.submissionFingerprint
    ) {
      throw new Error(
        'Durable notebook Run admission requires queued status and submission identity.'
      )
    }
    const run = ownRun(request.lane, request.run)
    let admitted = false
    let canonicalRun: NotebookRunRecord | undefined
    await this.mutateLifecycle(
      request.projectId,
      request.sessionId,
      request.lane,
      { submission: run.submissionIdentity! },
      (current) => {
        const existing = current.runs.find(
          (candidate) => candidate.submissionIdentity === run.submissionIdentity
        )
        if (existing) {
          if (existing.submissionFingerprint !== run.submissionFingerprint) {
            throw new NotebookRunSubmissionConflictError(run.submissionIdentity!)
          }
          canonicalRun = existing
          return current
        }
        request.signal?.throwIfAborted()
        admitted = true
        canonicalRun = normalizeRun(current.notebookSessionRoot, run)
        return { ...current, runs: [...current.runs, canonicalRun], updatedAt: Date.now() }
      }
    )
    if (!canonicalRun) throw new Error('Notebook Run admission did not resolve a canonical Run.')
    return { run: canonicalRun, admitted }
  }

  // A fully retained hot record can answer an exact lookup without hydrating the cold prefix.
  private async lookupDocument(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    lookup: Readonly<{ runId?: string; submissionIdentity?: string }>
  ): Promise<NotebookRunDocument> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    const compact = this.pendingViews.get(path)
    if (
      compact &&
      (lookup.runId
        ? !compact.ids.has(lookup.runId)
        : lookup.submissionIdentity && !compact.submissions.has(lookup.submissionIdentity)) &&
      (await this.laneFilesUnchanged(path, compact.identity, compact.references, {
        verifyUnseen: true
      }))
    )
      return compact.document
    return this.loadExisting(projectId, sessionId, lane)
  }

  async findRunBySubmission(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    submissionIdentity: string
  ): Promise<NotebookRunRecord | undefined> {
    await this.saveQueue
    const document = await this.lookupDocument(projectId, sessionId, lane, { submissionIdentity })
    return document.runs.find((run) => run.submissionIdentity === submissionIdentity)
  }

  async findRun(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    lookup: Readonly<{ runId?: string; submissionIdentity?: string }>
  ): Promise<NotebookRunLookupResult | undefined> {
    await this.saveQueue
    const document = await this.lookupDocument(projectId, sessionId, lane, lookup).catch(
      (error) => {
        if (isMissingFileError(error)) return undefined
        throw error
      }
    )
    if (!document) return undefined
    const run = document.runs.find((candidate) =>
      lookup.runId
        ? candidate.runId === lookup.runId
        : candidate.submissionIdentity === lookup.submissionIdentity
    )
    if (!run) return undefined
    const hydrated = await this.withEnvironmentManifests(document, [run])
    return { document, run: hydrated.runs[0]! }
  }

  // Resolves one caller-owned Run without making callers reconstruct the physical root/frame
  // layout. Root Runs may retain a provisional root Frame id after the Session adopts its final
  // id, so a string-shape check cannot reliably choose the document. Read the bounded root
  // candidate first and verify its persisted ownership before falling back to the one exact Frame.
  async findOwnedRun(
    projectId: string,
    sessionId: string,
    agentFrameId: string | undefined,
    lookup: Readonly<{ runId?: string; submissionIdentity?: string }>
  ): Promise<NotebookRunLookupResult | undefined> {
    const root = await this.findRun(
      projectId,
      sessionId,
      createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`),
      lookup
    )
    if (!agentFrameId) return root
    if (
      root?.run.agentFrameId === agentFrameId &&
      (!root.run.rootFrameId || root.run.rootFrameId === agentFrameId)
    ) {
      return root
    }
    return this.findRun(
      projectId,
      sessionId,
      createFrameNotebookLane(projectId, sessionId, agentFrameId),
      lookup
    )
  }

  // Compare-and-set transition used by the lifecycle owner. A racing terminal winner is returned
  // unchanged to every loser; terminal records can therefore never regress or be overwritten.
  async transitionRun(request: TransitionNotebookRunRequest): Promise<TransitionNotebookRunResult> {
    const requestedRun = ownRun(request.lane, request.run)
    let transitioned = false
    let canonicalRun: NotebookRunRecord | undefined
    await this.mutateLifecycle(
      request.projectId,
      request.sessionId,
      request.lane,
      { runId: requestedRun.runId },
      (current) => {
        const index = current.runs.findIndex((candidate) => candidate.runId === requestedRun.runId)
        if (index === -1) throw new Error(`Notebook run not found: ${requestedRun.runId}`)
        const existing = current.runs[index]
        canonicalRun = existing
        if (existing.status !== request.expectedStatus) return current
        const allowed =
          (existing.status === 'queued' &&
            (requestedRun.status === 'running' || requestedRun.status === 'cancelled')) ||
          (existing.status === 'running' &&
            requestedRun.status !== 'queued' &&
            requestedRun.status !== 'running')
        if (!allowed) {
          throw new Error(
            `Invalid notebook Run transition: ${existing.status} -> ${requestedRun.status}`
          )
        }
        const runs = [...current.runs]
        canonicalRun = normalizeRun(current.notebookSessionRoot, {
          ...requestedRun,
          ...(existing.cancellationRequestedAt !== undefined
            ? {
                cancellationRequestedAt: existing.cancellationRequestedAt,
                ...(existing.cancellationReason !== undefined
                  ? { cancellationReason: existing.cancellationReason }
                  : {})
              }
            : {})
        })
        runs[index] = canonicalRun
        transitioned = true
        return { ...current, runs, updatedAt: Date.now() }
      }
    )
    if (!canonicalRun) throw new Error(`Notebook run not found: ${requestedRun.runId}`)
    return { run: canonicalRun, transitioned }
  }

  // Cancellation is orthogonal intent, not a primary-state transition. Persist it while a Run is
  // queued/running so a crash between Stop and terminal CAS retains what the caller requested.
  async requestRunCancellation(
    request: AppendNotebookRunRequest & { requestedAt: number; reason: string }
  ): Promise<NotebookRunRecord> {
    let canonicalRun: NotebookRunRecord | undefined
    await this.mutateLifecycle(
      request.projectId,
      request.sessionId,
      request.lane,
      { runId: request.run.runId },
      (current) => {
        const index = current.runs.findIndex((candidate) => candidate.runId === request.run.runId)
        if (index === -1) throw new Error(`Notebook run not found: ${request.run.runId}`)
        const existing = current.runs[index]
        canonicalRun = existing
        if (
          (existing.status !== 'queued' && existing.status !== 'running') ||
          existing.cancellationRequestedAt !== undefined
        ) {
          return current
        }
        const runs = [...current.runs]
        canonicalRun = normalizeRun(current.notebookSessionRoot, {
          ...existing,
          cancellationRequestedAt: request.requestedAt,
          cancellationReason: request.reason
        })
        runs[index] = canonicalRun
        return { ...current, runs, updatedAt: Date.now() }
      }
    )
    if (!canonicalRun) throw new Error(`Notebook run not found: ${request.run.runId}`)
    return canonicalRun
  }

  // Write a recovery fact before the canonical terminal CAS. If that second write fails, startup
  // can still repair the exact outcome instead of guessing from an in-memory result.
  async commitTerminalRun(
    request: TransitionNotebookRunRequest & { expectedStatus: 'running' }
  ): Promise<TransitionNotebookRunResult> {
    if (request.run.status === 'queued' || request.run.status === 'running') {
      throw new Error('Notebook terminal outcome must have a terminal status.')
    }
    const factPath = getNotebookTerminalFactPath(
      this.storageRoot,
      request.projectId,
      request.sessionId,
      request.lane,
      request.run.runId
    )
    const fact: NotebookRunTerminalFact = {
      version: 1,
      projectId: request.projectId,
      sessionId: request.sessionId,
      expectedStatus: 'running',
      run: ownRun(request.lane, request.run)
    }
    await this.enqueueSave(async () => {
      this.assertLaneWritable(
        getNotebookRunJsonPath(this.storageRoot, request.projectId, request.sessionId, request.lane)
      )
      await mkdir(dirname(factPath), { recursive: true })
      await writeDurableJsonFile(factPath, `${JSON.stringify(fact, null, 2)}\n`)
    })
    const result = await this.transitionRun(request)
    if (!result.transitioned && result.run.status === 'running') {
      throw new Error(`Notebook terminal outcome could not claim running Run: ${request.run.runId}`)
    }
    await rm(factPath, { force: true })
    return result
  }

  async finishPendingRunDeletion(scope: {
    projectId?: string
    sessionIds?: readonly string[]
  }): Promise<void> {
    await this.enqueueSave(async () => {
      const lanes = [...pendingLanes].filter(
        ([, lane]) =>
          lane.storageRoot === this.storageRoot &&
          (scope.projectId === lane.projectId || scope.sessionIds?.includes(lane.sessionId))
      )
      if (!lanes.length) return
      const deleted = scope.sessionIds && (await this.deletedSessionScopes?.())
      for (const [path, entry] of lanes) {
        const { projectId, sessionId } = entry
        // The ID-only notification can also cover another Project. Check durable scope and
        // preserve retained producer history so another Session can still resolve its evidence.
        const retain =
          scope.projectId === projectId ? false : deleted?.get(projectId + ':' + sessionId)
        if (retain === undefined) continue
        this.observedDeleted.add(projectId + ':' + sessionId)
        if (retain && (await pendingDirectoryIdentity(path))) {
          this.assertLaneWritable(path)
          await this.checkpointLane(path, entry)
        } else await this.discardPendingRuns(path, projectId, sessionId)
        pendingLanes.delete(path)
        this.pendingViews.delete(path)
      }
    })
  }

  private async discardPendingRuns(
    path: string,
    projectId: string,
    sessionId: string
  ): Promise<void> {
    const root = dirname(path)
    if (
      (await pendingDirectoryIdentity(path)) &&
      (await this.pathExists(join(root, RECORDS_DIRECTORY)))
    ) {
      // A crash may have already checkpointed some slots. Keep every body named by the manifest.
      const manifest = await readDurableJsonFile(path, (contents) => {
        const document = decodeNotebookDocument(contents)
        assertNotebookDocumentOwnership(document, projectId, sessionId)
        assertStoredNotebookDocumentShape(document)
        return document
      })
      await this.records.prune(root, manifest.status === 'found' ? manifest.value.runs : [])
      await defaultFileDurability.syncDirectory(join(root, RECORDS_DIRECTORY))
    }
    await clearPendingRuns(path)
  }

  private assertLaneWritable(path: string): void {
    const error = pendingLanes.get(path)?.recoveryError
    if (error && this.recoveringLane.getStore() !== path) throw error
  }

  private async checkpointLane(path: string, entry: PendingLane): Promise<void> {
    await assertPendingRunsCheckpointable(path)
    if (!(await this.tryCheckpointReferences(path)))
      await this.persist(await this.loadExisting(entry.projectId, entry.sessionId, entry.lane))
  }

  async checkpointPendingRuns(): Promise<void> {
    await this.enqueueSave(async () => {
      const failures: Error[] = []
      for (const [path, entry] of pendingLanes) {
        if (entry.storageRoot !== this.storageRoot) continue
        try {
          this.assertLaneWritable(path)
          if (await pendingDirectoryIdentity(path)) await this.checkpointLane(path, entry)
          pendingLanes.delete(path)
        } catch (cause) {
          const error = new Error(`Notebook checkpoint incomplete: ${path}`, { cause })
          if (
            cause instanceof CorruptPendingRunError ||
            cause instanceof CorruptNotebookDocumentError
          )
            entry.recoveryError = cause
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Notebook checkpoints incomplete.')
    })
  }

  // Reconcile every persisted lane before new admission, including Sessions no renderer opens.
  async recoverAllRunLifecycles(): Promise<RecoveredBackgroundRun[]> {
    const recovered: RecoveredBackgroundRun[] = []
    const notebooksRoot = join(this.storageRoot, NOTEBOOKS_DIR)
    let projects
    try {
      projects = await readdir(notebooksRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return recovered
      throw error
    }
    const deleted = await this.deletedSessionScopes?.()
    for (const key of deleted?.keys() ?? []) this.observedDeleted.add(key)
    for (const project of projects) {
      if (!project.isDirectory() || !SAFE_SEGMENT_PATTERN.test(project.name)) continue
      const projectRoot = join(notebooksRoot, project.name)
      const sessions = await readdir(projectRoot, { withFileTypes: true })
      for (const session of sessions) {
        if (!session.isDirectory() || !SAFE_SEGMENT_PATTERN.test(session.name)) continue
        const sessionRoot = join(projectRoot, session.name)
        const sessionDeleted = deleted?.get(project.name + ':' + session.name)
        if (
          (await this.pathExists(join(sessionRoot, NOTEBOOK_RUN_FILE))) ||
          (await this.pathExists(join(sessionRoot, PENDING_RUN_DIRECTORY)))
        ) {
          recovered.push(
            ...(await this.recoverLaneIfReadable(
              project.name,
              session.name,
              createRootNotebookLane(project.name, session.name, `root-frame-${session.name}`),
              sessionDeleted
            ))
          )
        }
        const framesRoot = join(sessionRoot, 'frames')
        let frames
        try {
          frames = await readdir(framesRoot, { withFileTypes: true })
        } catch (error) {
          if (isMissingFileError(error)) continue
          throw error
        }
        for (const frame of frames) {
          if (!frame.isDirectory() || !SAFE_SEGMENT_PATTERN.test(frame.name)) continue
          if (
            !(await this.pathExists(join(framesRoot, frame.name, NOTEBOOK_RUN_FILE))) &&
            !(await this.pathExists(join(framesRoot, frame.name, PENDING_RUN_DIRECTORY)))
          )
            continue
          recovered.push(
            ...(await this.recoverLaneIfReadable(
              project.name,
              session.name,
              createFrameNotebookLane(project.name, session.name, frame.name),
              sessionDeleted
            ))
          )
        }
      }
    }
    return recovered
  }

  // Replaces an existing execution record, used to turn the initial "running" entry final.
  async updateRun(request: UpdateNotebookRunRequest): Promise<NotebookRunDocument> {
    const run = ownRun(request.lane, request.run)
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => {
      const runIndex = document.runs.findIndex((candidate) => candidate.runId === run.runId)

      if (runIndex === -1) {
        throw new Error(`Notebook run not found: ${run.runId}`)
      }

      const runs = [...document.runs]

      runs[runIndex] = normalizeRun(document.notebookSessionRoot, run)

      return { ...document, runs, updatedAt: Date.now() }
    })
  }

  // Persists the kernel's last-known lifecycle status (e.g. 'restarting' while restart() is in
  // flight, 'terminated' once an idle proc is dropped), read back by state()/getSessionReference().
  async updateKernelStatus(request: UpdateKernelStatusRequest): Promise<NotebookRunDocument> {
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => ({
      ...document,
      kernel: { ...document.kernel, lastKnownStatus: request.status },
      updatedAt: Date.now()
    }))
  }

  async markKernelTerminated(
    request: UpdateKernelTerminationRequest
  ): Promise<NotebookRunDocument> {
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => {
      const terminatedKernelInstances = document.kernel.terminatedKernelInstances ?? []
      const alreadyTerminated = terminatedKernelInstances.some((instance) =>
        sameKernelInstance(instance, request.kernelInstance)
      )
      return {
        ...document,
        kernel: {
          ...document.kernel,
          lastKnownStatus: 'terminated',
          terminatedKernelInstances: alreadyTerminated
            ? terminatedKernelInstances
            : [...terminatedKernelInstances, request.kernelInstance]
        },
        updatedAt: Date.now()
      }
    })
  }

  async clearKernelTermination(
    request: UpdateKernelTerminationRequest
  ): Promise<NotebookRunDocument> {
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => {
      const current = document.kernel.terminatedKernelInstances
      if (!current?.some((instance) => sameKernelInstance(instance, request.kernelInstance))) {
        return document
      }
      const remaining = current.filter(
        (instance) => !sameKernelInstance(instance, request.kernelInstance)
      )
      return {
        ...document,
        kernel:
          remaining.length > 0
            ? {
                ...document.kernel,
                lastKnownStatus: 'terminated',
                terminatedKernelInstances: remaining
              }
            : {
                ...withoutTerminatedKernelInstances(document.kernel),
                lastKnownStatus: 'idle'
              },
        updatedAt: Date.now()
      }
    })
  }

  async clearKernelTerminations(request: UpdateKernelStatusRequest): Promise<NotebookRunDocument> {
    return this.mutate(request.projectId, request.sessionId, request.lane, (document) => ({
      ...document,
      kernel: {
        ...withoutTerminatedKernelInstances(document.kernel),
        lastKnownStatus: request.status
      },
      updatedAt: Date.now()
    }))
  }

  // Persists the session's per-language runtime bindings (wire shape) so the bound runtime — and why
  // it may be unavailable — survives a restart. Reloaded + revalidated on the next session load.
  async setRuntimeBindings(
    projectId: string,
    sessionId: string,
    bindings: NotebookRuntimeBindings,
    lane: NotebookLaneIdentity
  ): Promise<void> {
    await this.mutateLifecycle(projectId, sessionId, lane, undefined, (document) => ({
      ...document,
      runtimeBindings: bindings,
      updatedAt: Date.now()
    }))
  }

  // Crash recovery: on the first load of a session in a fresh process, any run still marked 'running'
  // (or 'queued') was in flight when the previous process died — its kernel is gone, so mark it
  // 'interrupted' with interruptionReason 'app-terminated' (NOT failed — the code may have been fine).
  // The caller should only invoke this when such a stale run exists, so it never rewrites a clean doc
  // and never touches a run that is genuinely live in THIS process.
  async reconcileInterruptedRuns(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity
  ): Promise<NotebookRunDocument> {
    return this.mutate(projectId, sessionId, lane, (document) => {
      const now = Date.now()
      const runs = document.runs.map((run) =>
        run.status === 'running' || run.status === 'queued'
          ? {
              ...run,
              status: 'interrupted' as const,
              endedAt: run.endedAt ?? now,
              environmentCapture:
                run.kernelKind === 'python' || run.kernelKind === 'r'
                  ? ({ state: 'unavailable', reason: 'environment-capture-failed' } as const)
                  : ({ state: 'unavailable', reason: 'environment-not-supported' } as const),
              interruptionReason: 'app-terminated' as const
            }
          : run
      )
      return { ...document, runs, updatedAt: now }
    })
  }

  // Reads an existing history document without creating one, returning null when none exists yet.
  // Used to detect notebooks that predate the current app launch so the UI can rehydrate entries.
  async findExisting(
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity
  ): Promise<NotebookRunDocument | null> {
    try {
      return await this.loadExisting(projectId, sessionId, lane)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    }
  }

  async findAnyExisting(projectId: string, sessionId: string): Promise<NotebookRunDocument | null> {
    return this.firstExistingLane(projectId, sessionId, (lane) =>
      this.findExisting(projectId, sessionId, lane)
    )
  }

  async findReferenceHeader(
    projectId: string,
    sessionId: string
  ): Promise<Pick<LaneSummary, 'notebookSessionRoot' | 'workspaceCwd'> | null> {
    return this.firstExistingLane(
      projectId,
      sessionId,
      async (lane) =>
        (await this.cachedLaneSummary(
          getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
        )) ?? this.findExisting(projectId, sessionId, lane)
    )
  }

  private async firstExistingLane<T>(
    projectId: string,
    sessionId: string,
    read: (lane?: NotebookLaneIdentity) => Promise<T | null>
  ): Promise<T | null> {
    const root = await read()
    if (root) return root
    for (const frameId of await this.frameIds(projectId, sessionId)) {
      const lane = createFrameNotebookLane(projectId, sessionId, frameId)
      const child = await read(lane)
      if (child) return child
    }
    return null
  }

  private async frameIds(projectId: string, sessionId: string): Promise<string[]> {
    const framesRoot = join(
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId),
      'frames'
    )
    try {
      return (await readdir(framesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => entry.name)
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
  }

  async readSessionDocuments(
    projectId: string,
    sessionId: string,
    options: ReadSessionDocumentsOptions = {}
  ): Promise<NotebookRunDocument[]> {
    const documents = await this.readSessionLaneValues(projectId, sessionId, (lane) =>
      this.loadExisting(projectId, sessionId, lane)
    )
    if (!options.includeEnvironmentManifests) return documents
    const hydrate = this.environmentManifestReader()
    return Promise.all(
      documents.map((document) => this.withEnvironmentManifests(document, document.runs, hydrate))
    )
  }

  private async readSessionLaneValues<T>(
    projectId: string,
    sessionId: string,
    read: (lane?: NotebookLaneIdentity) => Promise<T>
  ): Promise<T[]> {
    const documents: T[] = []
    const legacy = await read().catch((error) => {
      if (isMissingFileError(error)) return null
      if (
        error instanceof CorruptNotebookDocumentError ||
        error instanceof UnsupportedNotebookDocumentVersionError
      ) {
        log.warn('skipping unreadable Notebook document', {
          projectId,
          sessionId,
          lane: 'root',
          status:
            error instanceof UnsupportedNotebookDocumentVersionError ? 'unsupported' : 'corrupt'
        })
        return null
      }
      throw error
    })
    if (legacy) documents.push(legacy)

    for (const frameId of await this.frameIds(projectId, sessionId)) {
      const lane = createFrameNotebookLane(projectId, sessionId, frameId)
      const document = await read(lane).catch((error) => {
        if (
          isMissingFileError(error) ||
          error instanceof CorruptNotebookDocumentError ||
          error instanceof UnsupportedNotebookDocumentVersionError
        ) {
          log.warn('skipping unreadable Notebook document', {
            projectId,
            sessionId,
            lane: 'frame',
            frameId,
            status:
              error instanceof UnsupportedNotebookDocumentVersionError ? 'unsupported' : 'corrupt'
          })
          return undefined
        }
        throw error
      })
      if (document) documents.push(document)
    }
    return documents
  }

  private async withEnvironmentManifests(
    document: NotebookRunDocument,
    runs: readonly NotebookRunRecord[] = document.runs,
    hydrate = this.environmentManifestReader()
  ): Promise<NotebookRunDocument> {
    return { ...document, runs: await Promise.all(runs.map(hydrate)) }
  }

  private environmentManifestReader(
    includeRunIds?: ReadonlySet<string>
  ): (run: NotebookRunRecord) => Promise<NotebookRunRecord> {
    const manifests = new Map<string, Promise<NotebookEnvironmentManifest | undefined>>()
    return async (run) => {
      if (includeRunIds && !includeRunIds.has(run.runId)) {
        return environmentManifestChecksumForRun(run) ? withoutEnvironmentManifest(run) : run
      }
      if (run.environmentManifest) return run
      const checksum = environmentManifestChecksumForRun(run)
      if (!checksum) return run
      const pending = manifests.get(checksum)
      const loading = pending ?? readEnvironmentManifest(this.storageRoot, checksum)
      if (!pending) manifests.set(checksum, loading)
      const manifest = await loading
      // Runs returned to callers keep independently mutable evidence.
      return manifest
        ? { ...run, environmentManifest: pending ? structuredClone(manifest) : manifest }
        : run
    }
  }

  // History views may infer a missing root identity from the physical root document. Its path
  // is normalized from the requested lane, not trusted from disk. Leave raw provenance readers,
  // explicit identities and child documents unchanged, and never mutate cached records.
  private historyRuns(
    document: NotebookRunDocument,
    projectId: string,
    sessionId: string
  ): NotebookRunRecord[] {
    if (
      document.notebookSessionRoot !==
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId)
    ) {
      return document.runs
    }
    return document.runs.map((run) =>
      run.agentFrameId &&
      run.agentFrameId !== `root-frame-${sessionId}` &&
      run.rootFrameId === undefined
        ? { ...run, rootFrameId: run.agentFrameId }
        : run
    )
  }

  async readSessionRuns(
    projectId: string,
    sessionId: string,
    options: ReadSessionRunsOptions = {}
  ): Promise<NotebookRunRecord[]> {
    const documents = await this.readSessionDocuments(projectId, sessionId, options)
    return documents
      .flatMap((document) => this.historyRuns(document, projectId, sessionId))
      .sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId)
      )
  }

  async readSessionRunWindow(
    projectId: string,
    sessionId: string,
    limit: number,
    includeRunIds: readonly string[] = [],
    historySummaryFrameId?: string,
    historyBefore?: NotebookRunCursor
  ): Promise<HistoryWindow> {
    const rawDocuments = await this.readSessionDocuments(projectId, sessionId)
    const requestedRunIds = new Set(includeRunIds)
    const hydrate = this.environmentManifestReader(requestedRunIds)
    const documents = await Promise.all(
      rawDocuments.map((document) =>
        this.withEnvironmentManifests(
          document,
          this.historyRuns(document, projectId, sessionId),
          hydrate
        )
      )
    )
    return selectRunWindow(
      documents,
      sessionId,
      limit,
      requestedRunIds,
      historySummaryFrameId,
      historyBefore
    )
  }

  // Loads a history document that must already exist for mutating operations.
  private async loadExisting(
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity
  ): Promise<NotebookRunDocument> {
    const safeProjectId = assertSafeNotebookPathSegment(projectId)
    const safeSessionId = assertSafeNotebookPathSegment(sessionId)
    const filePath = getNotebookRunJsonPath(this.storageRoot, safeProjectId, safeSessionId, lane)
    for (let attempt = 0; attempt < MAX_DOCUMENT_READ_ATTEMPTS; attempt += 1) {
      let fileInfo
      try {
        fileInfo = await manifestIdentity(filePath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        const recovered = await readDurableJsonFile(filePath, (contents) => {
          const document = decodeNotebookDocument(contents)
          assertNotebookDocumentOwnership(document, safeProjectId, safeSessionId)
          assertStoredNotebookDocumentShape(document)
          return document
        })
        if (recovered.status === 'missing') {
          if (await pendingDirectoryIdentity(filePath)) throw new CorruptNotebookDocumentError()
          throw error
        }
        fileInfo = await manifestIdentity(filePath)
      }
      const cached = this.documentCache.get(filePath)
      if (cached && sameDocumentFileIdentity(cached, fileInfo)) {
        const coldCount = this.coldCounts.get(cached.document)
        if (fileInfo.pending && coldCount !== undefined && coldCount >= 0) {
          const refs = this.records.referencesFor(
            dirname(filePath),
            cached.document.runs.slice(coldCount)
          )
          if (!(await this.records.unchanged(dirname(filePath), refs, true)))
            throw new CorruptNotebookDocumentError()
        }
        assertNotebookDocumentOwnership(cached.document, safeProjectId, safeSessionId)
        // Refresh insertion order so the Map also acts as a small LRU.
        this.documentCache.delete(filePath)
        this.documentCache.set(filePath, cached)
        return cached.document
      }
      // Reference lookup and recovery can arrive together before either has populated the cache.
      let read = this.pendingDocumentReads.get(filePath)
      if (!read || !sameDocumentFileIdentity(read.identity, fileInfo)) {
        read = {
          identity: fileInfo,
          result: this.readDocumentVersion(filePath, fileInfo, safeProjectId, safeSessionId, lane)
        }
        this.pendingDocumentReads.set(filePath, read)
      }
      try {
        const { document, stable } = await read.result
        if (stable || (!fileInfo.pending && attempt + 1 === MAX_DOCUMENT_READ_ATTEMPTS))
          return document
      } catch (error) {
        if (
          attempt + 1 === MAX_DOCUMENT_READ_ATTEMPTS ||
          sameDocumentFileIdentity(fileInfo, await statIfPresent(filePath))
        )
          throw error
      } finally {
        if (this.pendingDocumentReads.get(filePath) === read)
          this.pendingDocumentReads.delete(filePath)
      }
    }
    throw new Error(`Failed to read notebook document: ${filePath}`)
  }

  private async readDocumentVersion(
    filePath: string,
    fileInfo: DocumentFileIdentity,
    projectId: string,
    sessionId: string,
    lane?: NotebookLaneIdentity
  ): Promise<{ document: NotebookRunDocument; stable: boolean }> {
    const cached = this.documentCache.get(filePath)
    const count = cached && (this.coldCounts.get(cached.document) ?? cached.document.runs.length)
    if (
      fileInfo.pending &&
      cached &&
      count !== undefined &&
      count >= 0 &&
      sameDocumentFileIdentity({ ...cached, pending: fileInfo.pending }, fileInfo)
    ) {
      const base = cached.document
      const cold = base.runs.slice(0, count)
      const runs: StoredNotebookRun[] = [...cold]
      const pending = await mergePendingRuns(
        filePath,
        this.pendingScope(filePath, projectId, sessionId),
        runs,
        notebookRunCandidate
      )
      if (
        pending.updatedAt &&
        !pending.checkpointed &&
        (await this.laneFilesUnchanged(
          filePath,
          fileInfo,
          this.records.referencesFor(dirname(filePath), cold),
          { verifyUnseen: true }
        ))
      ) {
        const storedTail = runs.slice(count)
        const hydrated = await this.hydrate(filePath, { ...base, runs: storedTail })
        const tail = decodeRunDocumentDataPaths(hydrated, this.storageRoot).runs.map((row) =>
          normalizeRun(base.notebookSessionRoot, row)
        )
        this.records.remember(tail, storedTail, dirname(filePath))
        const document = { ...base, updatedAt: pending.updatedAt, runs: [...cold, ...tail] }
        this.coldCounts.set(document, count)
        this.rememberLaneSummary(filePath, fileInfo, document, true)
        this.rememberDocument(filePath, {
          ...fileInfo,
          weight:
            cached.weight +
            PENDING_RUN_BYTES +
            storedTail.reduce((sum, row) => sum + (isNotebookRunReference(row) ? row.bytes : 0), 0),
          document
        })
        return { document, stable: true }
      }
    }
    let manifestJson: string | undefined
    const read = await readDurableJsonFile(filePath, (contents) => {
      if (fileInfo.size > MAX_ANALYSIS_METADATA_BYTES) manifestJson = contents
      const document = decodeNotebookDocument(contents)
      assertNotebookDocumentOwnership(document, projectId, sessionId)
      assertStoredNotebookDocumentShape(document)
      return document
    })
    if (read.status === 'missing') throw new Error(`Notebook document disappeared: ${filePath}`)
    // Decode before normalization for the same reason as loadOrCreate above.
    const coldCount = read.value.runs.length
    const pending = await mergePendingRuns(
      filePath,
      this.pendingScope(filePath, projectId, sessionId),
      read.value.runs,
      notebookRunCandidate
    )
    if (pending.updatedAt) read.value.updatedAt = Math.max(pending.updatedAt, read.value.updatedAt)
    const hydrated = await this.hydrate(filePath, read.value)
    const decoded = decodeRunDocumentDataPaths(hydrated, this.storageRoot)

    const normalized = normalizeDocument(
      this.storageRoot,
      {
        projectId,
        sessionId,
        lane
      },
      decoded
    )
    this.coldCounts.set(normalized, pending.checkpointed ? -1 : coldCount)
    this.records.remember(normalized.runs, read.value.runs, dirname(filePath))
    const currentInfo = await manifestIdentity(filePath)
    if (!sameDocumentFileIdentity(fileInfo, currentInfo)) {
      return { document: normalized, stable: false }
    }
    const weight =
      currentInfo.size +
      read.value.runs.reduce(
        (bytes, run) => bytes + (isNotebookRunReference(run) ? run.bytes : 0),
        0
      )
    this.rememberLaneSummary(
      filePath,
      currentInfo,
      normalized,
      true,
      weight > MAX_DOCUMENT_CACHE_BYTES ? read.value.runs : undefined
    )
    if (!pending.checkpointed && weight > MAX_DOCUMENT_CACHE_BYTES)
      this.rememberPendingView(
        filePath,
        currentInfo,
        normalized,
        coldCount,
        read.value.runs,
        manifestJson
      )
    else this.pendingViews.delete(filePath)
    this.rememberDocument(filePath, {
      pending: currentInfo.pending,
      mtimeMs: currentInfo.mtimeMs,
      ctimeMs: currentInfo.ctimeMs,
      size: currentInfo.size,
      ino: currentInfo.ino,
      weight,
      document: normalized
    })
    return { document: normalized, stable: true }
  }

  private async recoverLane(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity
  ): Promise<RecoveredBackgroundRun[]> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    await recoverPendingRuns(
      path,
      this.pendingScope(path, projectId, sessionId),
      notebookRunCandidate
    )
    const recovered = new Map<string, NotebookRunRecord>()
    const outboxRoot = join(
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId, lane),
      RUN_TERMINAL_OUTBOX_DIR
    )
    await recoverDurableJsonDirectory(outboxRoot, (_targetPath, contents) =>
      parseNotebookRunTerminalFact(contents)
    )
    let facts: Dirent[]
    try {
      facts = await readdir(outboxRoot, { withFileTypes: true })
    } catch (error) {
      if (!isMissingFileError(error)) throw error
      facts = []
    }
    for (const entry of facts.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const factPath = join(outboxRoot, entry.name)
      const read = await readDurableJsonFile(factPath, parseNotebookRunTerminalFact)
      if (read.status === 'missing') continue
      const fact = read.value
      if (fact.projectId !== projectId || fact.sessionId !== sessionId) {
        throw new Error('Notebook terminal outcome recovery fact ownership mismatch.')
      }
      const result = await this.transitionRun({
        projectId,
        sessionId,
        lane,
        expectedStatus: fact.expectedStatus,
        run: fact.run
      })
      if (!result.transitioned && result.run.status === 'running') {
        throw new Error(`Notebook terminal outcome recovery is blocked: ${fact.run.runId}`)
      }
      if (result.run.executionMode === 'background') recovered.set(result.run.runId, result.run)
      await rm(factPath, { force: true })
    }

    const before = await statIfPresent(path)
    // The queued reconciliation reopens the manifest and can reuse unchanged, verified bodies.
    const document = await this.withinHistoryRead(projectId, sessionId, async () => {
      const current = await this.loadExisting(projectId, sessionId, lane)
      return current.runs.some((run) => run.status === 'queued' || run.status === 'running')
        ? this.reconcileInterruptedRuns(projectId, sessionId, lane)
        : current
    })
    // The persisted Run documents are the durable source of truth for terminal delivery. Replay
    // their bounded current history on every startup so a transient delivery-store failure cannot
    // permanently strand an outcome. The delivery repository de-duplicates pending and consumed
    // records by source identity.
    for (const run of document.runs) {
      if (
        run.executionMode === 'background' &&
        run.status !== 'queued' &&
        run.status !== 'running'
      ) {
        recovered.set(run.runId, run)
      }
    }
    // Finish the checkpoint even when every recovered Run was already terminal.
    if (await pendingDirectoryIdentity(path)) {
      await this.enqueueSave(async () => {
        const latest = await this.loadExisting(projectId, sessionId, lane)
        await this.persist(latest)
      })
    }
    // A clean directory needs no deletion. Reopen the authoritative manifest before any cleanup.
    const clean =
      before &&
      (await this.records.containsOnlyReferencedFiles(
        document.notebookSessionRoot,
        document.runs
      )) &&
      !(await this.hasRecoveryCandidate(path)) &&
      sameDocumentFileIdentity(before, await statIfPresent(path))
    if (!clean) {
      const manifest = await readDurableJsonFile(path, decodeNotebookDocument)
      if (manifest.status === 'found')
        await this.records.prune(document.notebookSessionRoot, manifest.value.runs)
    }
    return [...recovered.values()].map((run) => ({ projectId, sessionId, run }))
  }

  private async recoverLaneIfReadable(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    retainedAfterDeletion?: boolean
  ): Promise<RecoveredBackgroundRun[]> {
    const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
    const previousFence = pendingLanes.get(path)
    try {
      if (retainedAfterDeletion === false) {
        await this.discardPendingRuns(path, projectId, sessionId)
        pendingLanes.delete(path)
        return []
      }
      const recovered = await this.recoveringLane.run(path, () =>
        this.recoverLane(projectId, sessionId, lane)
      )
      // A completed retry releases its own fence, never a new dirty entry from another writer.
      if (previousFence?.recoveryError && pendingLanes.get(path) === previousFence)
        pendingLanes.delete(path)
      return retainedAfterDeletion ? [] : recovered
    } catch (error) {
      const corrupt =
        error instanceof CorruptNotebookDocumentError || error instanceof CorruptPendingRunError
      if (
        !corrupt ||
        error instanceof CorruptPendingRunError ||
        pendingLanes.has(path) ||
        (await this.pathExists(join(dirname(path), PENDING_RUN_DIRECTORY)))
      ) {
        pendingLanes.set(path, {
          storageRoot: this.storageRoot,
          projectId,
          sessionId,
          lane,
          recoveryError: error instanceof Error ? error : new Error(String(error))
        })
      }
      if (!corrupt) throw error

      log.warn('skipping unreadable Notebook document', {
        projectId,
        sessionId,
        lane: notebookLaneScope(lane).kind,
        status: 'corrupt',
        phase: 'startup-recovery'
      })
      return []
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  // Reads the current document, applies `transform`, and writes back the result -- the read and write
  // happen inside the same queued turn (not just the write, as writeDocument alone would give), so
  // overlapping callers touching the same session's run.json (e.g. two overlapping bash_execute calls,
  // which have no session-level lock of their own) can never race a stale read against another
  // writer's in-flight update.
  private async mutate(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    transform: (document: NotebookRunDocument) => NotebookRunDocument
  ): Promise<NotebookRunDocument> {
    return this.enqueueSave(async () => {
      this.assertLaneWritable(getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane))
      const document = await this.loadExisting(projectId, sessionId, lane)
      const next = transform(document)
      if (next !== document) await this.persist(next)
      return next
    })
  }

  private async laneFilesUnchanged(
    path: string,
    identity: DocumentFileIdentity,
    refs: RunReference[],
    { verifyUnseen = false } = {}
  ): Promise<boolean> {
    return (
      sameDocumentFileIdentity(identity, await statIfPresent(path)) &&
      !(await this.hasRecoveryCandidate(path)) &&
      (await this.records.unchanged(dirname(path), refs, verifyUnseen)) &&
      sameDocumentFileIdentity(identity, await statIfPresent(path))
    )
  }

  private pendingScope(path: string, projectId: string, sessionId: string): PendingRunScope {
    return {
      projectId,
      sessionId,
      frameId:
        dirname(path) === getNotebookSessionRoot(this.storageRoot, projectId, sessionId)
          ? null
          : basename(dirname(path))
    }
  }

  private rememberPendingView(
    path: string,
    identity: DocumentFileIdentity,
    document: NotebookRunDocument,
    coldCount: number,
    stored: StoredNotebookRun[],
    manifestJson?: string
  ): void {
    this.pendingViews.delete(path)
    // A manifest smaller than a hot slot can keep using the bounded lifecycle writer.
    const summary = this.laneSummaries.get(path)?.summary
    if (identity.size <= PENDING_RUN_BYTES && summary && this.lifecycleViews.has(summary)) return
    const references = stored.filter(isNotebookRunReference)
    const tail = { ...document, runs: document.runs.slice(coldCount) }
    if (estimateReplayBytes({ ...tail, runs: [] }) > MAX_LANE_SUMMARY_BYTES) return
    let bytes = references.reduce((total, ref) => total + estimateReplayBytes(ref) + 96, 0)
    const ids = new Set<string>(),
      submissions = new Set<string>()
    let coldHasBackgroundRuns = false
    for (let i = 0; i < coldCount; i++) {
      const run = document.runs[i]
      bytes += 64 + Buffer.byteLength(run.runId) + Buffer.byteLength(run.submissionIdentity ?? '')
      if (bytes > MAX_LANE_SUMMARY_BYTES) return
      coldHasBackgroundRuns ||= run.executionMode === 'background'
      ids.add(run.runId)
      if (run.submissionIdentity) submissions.add(run.submissionIdentity)
    }
    let analysis: StoredNotebookRun[] | undefined = []
    let analysisBytes = 0
    let inlineBytes = 0
    const external: { index: number; cost: number; ref: RunReference }[] = []
    for (let i = 0; i < coldCount; i++) {
      const run = document.runs[i]
      const metadata = { ...run, text: emptyText(), outputs: [] }
      const cost = estimateReplayBytes(metadata) + 96
      const ref = stored[i]
      if (isNotebookRunReference(ref)) {
        external.push({ index: i, cost, ref })
      } else {
        inlineBytes += cost
        if (inlineBytes > MAX_ANALYSIS_METADATA_BYTES) {
          analysis = undefined
          break
        }
      }
      analysis.push(metadata)
      analysisBytes += cost
    }
    if (analysis && analysisBytes > MAX_ANALYSIS_METADATA_BYTES) {
      // Drop the most resident metadata per byte fetched. Manifest order stays in analysis.
      external.sort((a, b) => b.cost / b.ref.bytes - a.cost / a.ref.bytes)
      let deferredBytes = 0
      for (const { index, cost, ref } of external) {
        if (deferredBytes + ref.bytes > MAX_ANALYSIS_METADATA_BYTES) continue
        analysis[index] = ref
        deferredBytes += ref.bytes
        analysisBytes -= cost
        if (analysisBytes <= MAX_ANALYSIS_METADATA_BYTES) break
      }
      if (analysisBytes > MAX_ANALYSIS_METADATA_BYTES) analysis = undefined
    }
    if (analysis) {
      // Keep recent inline output only within the remaining metadata budget. External
      // output already has a verified address and never needs to occupy that space.
      let inlineFile: InlineRunSlot['file'] | undefined
      let indexed = false
      for (let i = analysis.length - 1; i >= 0; i--) {
        const ref = stored[i]
        const metadata = analysis[i]
        if (isNotebookRunReference(metadata)) continue
        const run = document.runs[i]
        const { detailBytes, hasOutput } = this.analysisIndexDetails.get(run) ?? indexReplayRun(run)
        this.analysisIndexDetails.set(metadata, { detailBytes, hasOutput })
        if (isNotebookRunReference(ref)) {
          this.historyBodies.set(metadata, { root: document.notebookSessionRoot, ref })
        } else if (analysisBytes < MAX_ANALYSIS_METADATA_BYTES) {
          const { text, outputs } = document.runs[i]
          const output = { text, outputs }
          analysisBytes += estimateReplayBytes(output) + 64
          if (analysisBytes <= MAX_ANALYSIS_METADATA_BYTES) this.inlineOutputs.set(metadata, output)
        }
        if (!isNotebookRunReference(ref) && !this.inlineOutputs.has(metadata) && manifestJson) {
          if (!indexed) {
            inlineFile = indexInlineRuns(path, identity, manifestJson, coldCount)
            indexed = true
          }
          if (inlineFile) this.inlineSlots.set(metadata, { file: inlineFile, index: i })
        }
      }
    }
    if (this.pendingViews.size >= MAX_DOCUMENT_CACHE_ENTRIES)
      this.pendingViews.delete(this.pendingViews.keys().next().value!)
    this.pendingViews.set(path, {
      identity,
      coldCount,
      references,
      analysis,
      coldHasBackgroundRuns,
      ids,
      submissions,
      document: tail
    })
  }

  // Admission appends a slot; subsequent transitions may replace only a still-pending slot.
  // An older slot or a general document mutation goes through the full checkpoint.
  private async tryPublishPending(
    path: string,
    previous: NotebookRunDocument,
    next: NotebookRunDocument
  ): Promise<boolean> {
    const view = this.pendingViews.get(path)
    const compact = view?.document === previous ? view : undefined
    const cache = this.documentCache.get(path)
    if (
      !compact &&
      (cache?.document !== previous ||
        cache.size < MIN_BATCHED_MANIFEST_BYTES ||
        cache.weight + PENDING_RUN_BYTES > MAX_DOCUMENT_CACHE_BYTES)
    )
      return false
    const coldCount = compact ? 0 : (this.coldCounts.get(previous) ?? previous.runs.length)
    if (coldCount < 0 || next.runs.length > coldCount + PENDING_RUN_LIMIT) return false
    const slot = next.runs.findIndex((r, i) => r !== previous.runs[i])
    if (slot < coldCount || slot < 0) return false
    const run = next.runs[slot]
    if (
      slot === previous.runs.length &&
      (compact?.ids.has(run.runId) || previous.runs.some((r) => r.runId === run.runId))
    )
      return false
    if (
      (previous.runs[slot] && previous.runs[slot].runId !== run.runId) ||
      next.runs.slice(slot + 1).some((r, i) => r !== previous.runs[slot + 1 + i])
    )
      return false
    if (
      next.runs.length === coldCount + PENDING_RUN_LIMIT &&
      run.status !== 'queued' &&
      run.status !== 'running'
    )
      return false
    await this.publishEnvironmentManifests({ ...next, runs: [run] })
    const normalized = environmentManifestChecksumForRun(run)
      ? withoutEnvironmentManifest(run)
      : run
    const encoded = encodeNotebookRunDataPaths(normalized, this.storageRoot)
    const { projectId, sessionId } = next
    const frame = this.pendingScope(path, projectId, sessionId).frameId
    if (!pendingLanes.has(path))
      pendingLanes.set(path, {
        storageRoot: this.storageRoot,
        projectId,
        sessionId,
        lane: frame
          ? createFrameNotebookLane(projectId, sessionId, frame)
          : createRootNotebookLane(projectId, sessionId, 'root-frame-' + sessionId)
      })
    const entry = {
      ...this.pendingScope(path, next.projectId, next.sessionId),
      slot: slot + (compact?.coldCount ?? 0),
      run: encoded,
      updatedAt: next.updatedAt
    }
    let reference: RunReference | undefined
    if (!(await publishPendingRun(path, entry))) {
      const bytes = Buffer.byteLength(JSON.stringify(encoded))
      const hotReferences = this.records.referencesFor(dirname(path), next.runs.slice(coldCount))
      if (
        bytes < INLINE_BYTES ||
        bytes + hotReferences.reduce((sum, ref) => sum + ref.bytes, 0) > PENDING_REFERENCE_BYTES ||
        (!compact && cache!.weight + bytes + PENDING_RUN_BYTES > MAX_DOCUMENT_CACHE_BYTES)
      )
        return false
      const [stored] = await this.records.write(dirname(path), [normalized], () => encoded)
      if (!isNotebookRunReference(stored)) return false
      // The slot may already exist when its sibling .run-records directory is first created.
      await defaultFileDurability.syncDirectory(dirname(path))
      if (!(await publishPendingRun(path, { ...entry, run: stored }))) return false
      reference = stored
    }
    const identity = await manifestIdentity(path)
    const cached =
      normalized === run
        ? next
        : { ...next, runs: next.runs.map((r, i) => (i === slot ? normalized : r)) }
    if (compact) {
      if (reference || compact.references.some((ref) => ref.runId === run.runId)) {
        compact.references = compact.references.filter((ref) => ref.runId !== run.runId)
        if (reference) compact.references.push(reference)
      }
      compact.identity = identity
      compact.document = cached
      this.storeLaneSummary(path, identity, {
        workspaceCwd: cached.workspaceCwd,
        notebookSessionRoot: cached.notebookSessionRoot,
        hasBackgroundRuns:
          compact.coldHasBackgroundRuns ||
          cached.runs.some((row) => row.executionMode === 'background')
      })
      return true
    }
    this.coldCounts.set(cached, coldCount)
    this.rememberLaneSummary(path, identity, cached, false)
    this.rememberDocument(path, {
      ...identity,
      weight: cache!.weight + PENDING_RUN_BYTES + (reference?.bytes ?? 0),
      document: cached
    })
    return true
  }

  // Reuse only cold bodies validated for this exact manifest. Reopen the published hot
  // slots so a damaged or interrupted write cannot be acknowledged by a checkpoint.
  private async tryCheckpointReferences(
    path: string,
    transform?: (document: NotebookRunDocument) => NotebookRunDocument
  ): Promise<boolean> {
    const view = this.pendingViews.get(path)
    if (!view?.analysis || !view.identity.pending || !view.references.length) return false
    const base = view.document
    const inline: NotebookRunRecord[] = []
    const analysis = new Map<number, NotebookRunRecord>()
    const detached: DetachedRuns = {
      analysis,
      slots: new Map(),
      submissionIds: new Set(),
      hasBackgroundRuns: false,
      bytes: 0
    }
    for (const [index, metadata] of view.analysis.entries()) {
      if (isNotebookRunReference(metadata)) return false
      const body = this.historyBodies.get(metadata)
      if (body) {
        if (metadata.environmentManifest) return false
        analysis.set(index, metadata)
        detached.slots.set(index, body.ref)
        if (metadata.submissionIdentity) detached.submissionIds.add(metadata.submissionIdentity)
        detached.hasBackgroundRuns ||= metadata.executionMode === 'background'
        detached.bytes +=
          estimateReplayBytes(body.ref) + 96 + Buffer.byteLength(metadata.submissionIdentity ?? '')
      } else {
        const output = this.inlineOutputs.get(metadata)
        if (!output) return false
        inline.push({ ...metadata, ...output })
      }
    }
    if (
      !detached.slots.size ||
      !(await this.laneFilesUnchanged(path, view.identity, [...detached.slots.values()]))
    )
      return false
    if (transform) await assertPendingRunsCheckpointable(path)
    const rows: StoredNotebookRun[] = [...view.analysis]
    const merged = await mergePendingRuns(
      path,
      this.pendingScope(path, base.projectId, base.sessionId),
      rows,
      notebookRunCandidate
    )
    if (merged.checkpointed || !merged.updatedAt) return false
    const tail = rows.slice(view.coldCount)
    const hydrated = await this.hydrate(path, { ...base, runs: tail })
    const runs = decodeRunDocumentDataPaths(hydrated, this.storageRoot).runs.map((row) =>
      normalizeRun(base.notebookSessionRoot, row)
    )
    this.records.remember(runs, tail, dirname(path))
    if (!sameDocumentFileIdentity(view.identity, await statIfPresent(path))) return false
    const document = {
      ...base,
      runs: [...inline, ...runs],
      updatedAt: Math.max(base.updatedAt, merged.updatedAt)
    }
    const next = transform?.(document) ?? document
    if (!transform || next !== document) await this.persist(next, detached)
    return true
  }

  private async mutateLifecycle(
    projectId: string,
    sessionId: string,
    lane: NotebookLaneIdentity,
    lookup: { runId: string } | { submission: string } | undefined,
    transform: (document: NotebookRunDocument) => NotebookRunDocument
  ): Promise<void> {
    await this.enqueueSave(async () => {
      const path = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, lane)
      this.assertLaneWritable(path)
      const key = projectId + ':' + sessionId
      if (lookup && 'submission' in lookup && this.observedDeleted.has(key)) {
        if (!this.deletedSessionScopes || (await this.deletedSessionScopes()).has(key))
          throw new Error('Notebook Session was deleted.')
        this.observedDeleted.delete(key)
      }
      const compact = this.pendingViews.get(path)
      if (
        lookup &&
        compact &&
        !('runId' in lookup
          ? compact.ids.has(lookup.runId)
          : compact.submissions.has(lookup.submission)) &&
        (await this.laneFilesUnchanged(path, compact.identity, compact.references, {
          verifyUnseen: true
        }))
      ) {
        const next = transform(compact.document)
        if (
          next === compact.document ||
          (await this.tryPublishPending(path, compact.document, next))
        )
          return
        if ('runId' in lookup && (await this.tryCheckpointReferences(path, transform))) return
      }
      const entry = this.laneSummaries.get(path)
      const view = entry && this.lifecycleViews.get(entry.summary)
      if (
        entry &&
        view &&
        !(
          lookup &&
          ('submission' in lookup
            ? view.detached.submissionIds.has(lookup.submission)
            : Array.from(view.detached.slots.values()).some((ref) => ref.runId === lookup.runId))
        ) &&
        (await this.laneFilesUnchanged(
          path,
          entry.identity,
          Array.from(view.detached.slots.values())
        ))
      ) {
        const next = transform(view.remaining)
        if (next !== view.remaining) await this.persist(next, view.detached, entry.summary.rows)
        return
      }
      const document = await this.loadExisting(projectId, sessionId, lane)
      // A cold read may just have built a bounded ID index for an oversized inline history.
      const loaded = this.pendingViews.get(path)
      if (
        lookup &&
        loaded &&
        loaded !== compact &&
        !('runId' in lookup
          ? loaded.ids.has(lookup.runId)
          : loaded.submissions.has(lookup.submission))
      ) {
        const pending = transform(loaded.document)
        if (
          pending === loaded.document ||
          (await this.tryPublishPending(path, loaded.document, pending))
        )
          return
      }
      const next = transform(document)
      if (next !== document && !(await this.tryPublishPending(path, document, next)))
        await this.persist(next)
    })
  }

  private enqueueSave<T>(save: () => Promise<T>): Promise<T> {
    const operation = this.saveQueue.then(save)
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    const key = resolve(this.storageRoot)
    storageWrites.set(key, tail)
    void tail.then(() => {
      if (storageWrites.get(key) === tail) storageWrites.delete(key)
    })
    return operation
  }

  private rememberLaneSummary(
    filePath: string,
    identity: DocumentFileIdentity,
    document: NotebookRunDocument,
    includeIndex: boolean,
    oversizedRecords?: StoredNotebookRun[]
  ): void {
    const previous = this.laneSummaries.get(filePath)
    if (
      previous &&
      sameDocumentFileIdentity(previous.identity, identity) &&
      (!includeIndex || previous.summary.rows)
    )
      return
    const summary: LaneSummary = {
      notebookSessionRoot: document.notebookSessionRoot,
      workspaceCwd: document.workspaceCwd,
      hasBackgroundRuns: document.runs.some((run) => run.executionMode === 'background')
    }
    let bytes = estimateReplayBytes(summary)
    if (bytes > MAX_LANE_SUMMARY_BYTES) return
    if (includeIndex) {
      const rows: ReplayRunIndex[] = []
      for (const run of document.runs) {
        const row = compactReplayRunIndex(run)
        bytes += estimateReplayBytes(row)
        if (bytes > MAX_LANE_SUMMARY_BYTES) break
        rows.push(row)
      }
      if (rows.length === document.runs.length) summary.rows = rows
    }
    // Only large, externalized lanes need a second representation. Inline records share
    // their validated objects, and all retained metadata counts against the lane budget.
    if (oversizedRecords?.some(isNotebookRunReference)) {
      const history = {
        notebookSessionRoot: document.notebookSessionRoot,
        dataRoot: document.dataRoot,
        runtimeBindings: document.runtimeBindings,
        kernel: document.kernel,
        runs: [] as NotebookRunRecord[]
      }
      bytes = estimateReplayBytes(summary) + estimateReplayBytes(history)
      const runs = this.historyRuns(document, document.projectId, document.sessionId)
      for (const [index, run] of runs.entries()) {
        const ref = oversizedRecords[index]
        const entry = isNotebookRunReference(ref) ? { ...run, text: emptyText(), outputs: [] } : run
        bytes +=
          estimateReplayBytes(entry) +
          (isNotebookRunReference(ref) ? estimateReplayBytes(ref) + 256 : 0)
        if (bytes > MAX_LANE_SUMMARY_BYTES) break
        if (isNotebookRunReference(ref)) {
          this.historyBodies.set(entry, { root: document.notebookSessionRoot, ref })
          if (summary.hasBackgroundRuns)
            this.backgroundOutputBytes.set(ref, omittedOutputBytes(run.text, run.outputs))
        }
        history.runs.push(entry)
      }
      if (history.runs.length === runs.length) summary.history = history
    }
    if (oversizedRecords && !summary.history && identity.size <= MAX_LANE_SUMMARY_BYTES) {
      const slots = new Map<number, RunReference>()
      const submissionIds = new Set<string>()
      const remaining = { ...document, runs: [] as NotebookRunRecord[] }
      let hasBackgroundRuns = false
      let detachedBytes = 0
      let bytes = estimateReplayBytes(remaining)
      for (const [index, stored] of oversizedRecords.entries()) {
        const run = document.runs[index]
        if (isNotebookRunReference(stored)) {
          // The ordinary writer must first publish any embedded legacy Environment manifest.
          if (run.environmentManifest) break
          slots.set(index, stored)
          if (run.submissionIdentity) submissionIds.add(run.submissionIdentity)
          hasBackgroundRuns ||= run.executionMode === 'background'
          const cost =
            estimateReplayBytes(stored) + 96 + Buffer.byteLength(run.submissionIdentity ?? '')
          bytes += cost
          detachedBytes += cost
        } else {
          remaining.runs.push(run)
          bytes += estimateReplayBytes(run)
        }
        if (bytes > MAX_LANE_SUMMARY_BYTES) break
      }
      if (
        bytes <= MAX_LANE_SUMMARY_BYTES &&
        slots.size &&
        slots.size + remaining.runs.length === document.runs.length
      ) {
        const detached: DetachedRuns = {
          slots,
          submissionIds,
          hasBackgroundRuns,
          bytes: detachedBytes
        }
        // Keep only validated immutable inputs. The same slots survive admission and terminal writes.
        const analysis = new Map<number, NotebookRunRecord>()
        let analysisBytes = 0
        for (const index of slots.keys()) {
          const row = { ...document.runs[index], text: emptyText(), outputs: [] }
          analysisBytes += estimateReplayBytes(row) + 32
          if (analysisBytes > MAX_ANALYSIS_METADATA_BYTES) break
          const { detailBytes, hasOutput } = indexReplayRun(document.runs[index])
          this.analysisIndexDetails.set(row, { detailBytes, hasOutput })
          analysis.set(index, row)
        }
        if (analysis.size === slots.size) detached.analysis = analysis
        this.lifecycleViews.set(summary, { remaining, detached })
      }
    }
    this.storeLaneSummary(filePath, identity, summary)
  }

  private storeLaneSummary(
    filePath: string,
    identity: DocumentFileIdentity,
    summary: LaneSummary
  ): void {
    this.laneSummaries.delete(filePath)
    if (this.laneSummaries.size >= MAX_DOCUMENT_CACHE_ENTRIES) {
      const oldest = this.laneSummaries.keys().next().value
      if (oldest !== undefined) this.laneSummaries.delete(oldest)
    }
    this.laneSummaries.set(filePath, {
      identity: {
        pending: identity.pending,
        mtimeMs: identity.mtimeMs,
        ctimeMs: identity.ctimeMs,
        ino: identity.ino,
        size: identity.size
      },
      summary
    })
  }

  // Retains only a small working set. Large or numerous histories remain readable but are parsed
  // again instead of pinning complete text and image payloads for the process lifetime.
  private rememberDocument(
    filePath: string,
    entry: DocumentFileIdentity & {
      weight: number
      document: NotebookRunDocument
    }
  ): void {
    const previous = this.documentCache.get(filePath)
    if (previous) {
      this.documentCache.delete(filePath)
      this.documentCacheBytes -= previous.weight
    }

    if (entry.weight > MAX_DOCUMENT_CACHE_BYTES) return

    this.documentCache.set(filePath, entry)
    this.documentCacheBytes += entry.weight
    while (
      this.documentCache.size > MAX_DOCUMENT_CACHE_ENTRIES ||
      this.documentCacheBytes > MAX_DOCUMENT_CACHE_BYTES
    ) {
      const oldestPath = this.documentCache.keys().next().value
      if (typeof oldestPath !== 'string') break
      const oldest = this.documentCache.get(oldestPath)
      this.documentCache.delete(oldestPath)
      this.documentCacheBytes -= oldest?.weight ?? 0
    }
  }

  private async publishEnvironmentManifests(document: NotebookRunDocument): Promise<void> {
    const manifests = new Map<string, string>()
    for (const run of document.runs) {
      const manifest = run.environmentManifest
      const checksum = environmentManifestChecksumForRun(run)
      if (!manifest || !checksum) continue
      if (!digestPattern.test(checksum)) {
        throw new Error(`Notebook Environment manifest reference is invalid: ${checksum}`)
      }
      const serialized = serializeEnvironmentManifest(manifest)
      if (digest(serialized) !== checksum) {
        throw new Error(`Notebook Environment manifest checksum mismatch: ${checksum}`)
      }
      if (!this.publishedEnvironmentManifests.has(checksum)) manifests.set(checksum, serialized)
    }
    await Promise.all(
      Array.from(manifests, async ([checksum, serialized]) => {
        const path = environmentManifestPath(this.storageRoot, checksum)
        try {
          const existing = await readFile(path, 'utf8')
          if (existing !== serialized) {
            throw new Error(`Notebook Environment manifest conflict: ${checksum}`)
          }
        } catch (error) {
          if (!isMissingFileError(error)) throw error
          await writeDurableJsonFile(path, serialized)
        }
        this.publishedEnvironmentManifests.add(checksum)
      })
    )
  }

  // Writes one document to disk via a temp file + atomic rename. Always invoked from inside the
  // repository mutation queue, after readers and writers agree on the current version.
  private async persist(
    document: NotebookRunDocument,
    detached?: DetachedRuns,
    previousRows?: ReplayRunIndex[]
  ): Promise<void> {
    const directory = document.notebookSessionRoot
    const filePath = join(directory, NOTEBOOK_RUN_FILE)

    // Ensure the full notebook workspace exists before exposing run.json to readers.
    await mkdir(join(directory, 'data', 'raw'), { recursive: true })
    await mkdir(join(directory, 'data', 'processed'), { recursive: true })
    await mkdir(join(directory, 'work'), { recursive: true })
    await mkdir(join(directory, 'cache'), { recursive: true })
    await mkdir(join(directory, 'scripts'), { recursive: true })
    // Cross-kernel handoff channel: the REPL fetches external data here and hands files to
    // python/r via disk; 'outputs' collects results kernels want to surface back out.
    await mkdir(join(directory, 'handoff'), { recursive: true })
    await mkdir(join(directory, 'outputs'), { recursive: true })
    // The sandbox receives this stable sibling as read-only at process launch. Main may then stage
    // exact, verified Versions into it without exposing the authoritative Upload/Artifact stores.
    await ensureNotebookInputRoot(this.storageRoot, document.projectId, document.sessionId)

    // Encode only the serialized copy: `directory` above must stay derived from the absolute in-memory
    // `document.notebookSessionRoot`, never from the $DATA-sentinel-encoded copy, so run.json stores
    // portable "$DATA/..." paths that survive a data-root relocation.
    await this.publishEnvironmentManifests(document)
    const header = encodeRunDocumentDataPaths({ ...document, runs: [] }, this.storageRoot)
    // Keep the reference on the same sidecar-free Run object that subsequent mutations will use.
    const cachedDocument = {
      ...document,
      runs: document.runs.map((run) =>
        environmentManifestChecksumForRun(run) ? withoutEnvironmentManifest(run) : run
      )
    }
    const remaining = await this.records.write(directory, cachedDocument.runs, (run) =>
      encodeNotebookRunDataPaths(run, this.storageRoot)
    )
    // Transitions retain positions and admission appends at the end. Reinsert untouched records
    // in their original slots before publishing the same complete manifest.
    let cursor = 0
    const runs = detached
      ? Array.from(
          { length: detached.slots.size + remaining.length },
          (_, index) => detached.slots.get(index) ?? remaining[cursor++]
        )
      : remaining
    const encoded = {
      ...header,
      version: runs.some(isNotebookRunReference) ? 2 : 1,
      runs
    }
    const manifestJson = `${JSON.stringify(encoded, null, 2)}\n`
    await writeDurableJsonFile(filePath, manifestJson)
    await clearPendingRuns(filePath)
    if (!pendingLanes.get(filePath)?.recoveryError) pendingLanes.delete(filePath)
    const fileInfo = await manifestIdentity(filePath)
    const weight =
      fileInfo.size +
      runs.reduce((bytes, run) => bytes + (isNotebookRunReference(run) ? run.bytes : 0), 0)
    const oversized = weight > MAX_DOCUMENT_CACHE_BYTES
    if (detached) {
      const summary: LaneSummary = {
        notebookSessionRoot: directory,
        workspaceCwd: document.workspaceCwd,
        hasBackgroundRuns:
          detached.hasBackgroundRuns ||
          cachedDocument.runs.some((run) => run.executionMode === 'background')
      }
      if (previousRows) {
        let next = 0
        const rows = runs.map((_, index) =>
          detached.slots.has(index)
            ? previousRows[index]
            : compactReplayRunIndex(cachedDocument.runs[next++])
        )
        if (estimateReplayBytes(rows) + estimateReplayBytes(summary) <= MAX_LANE_SUMMARY_BYTES)
          summary.rows = rows
      }
      // A new external body must be validated by the ordinary reader before reuse.
      if (
        !remaining.some(isNotebookRunReference) &&
        fileInfo.size <= MAX_LANE_SUMMARY_BYTES &&
        estimateReplayBytes(cachedDocument) + detached.bytes <= MAX_LANE_SUMMARY_BYTES
      ) {
        this.lifecycleViews.set(summary, { remaining: cachedDocument, detached })
      }
      this.storeLaneSummary(filePath, fileInfo, summary)
      // A new external Run can outgrow the lifecycle view. Carry the verified cold
      // metadata into the next admission so the following Run need not reload every body.
      const coldAnalysis = detached.analysis
      if (
        oversized &&
        coldAnalysis &&
        (fileInfo.size > PENDING_RUN_BYTES || !this.lifecycleViews.has(summary))
      ) {
        let inline = 0
        const metadata = runs.map(
          (_, index) => coldAnalysis.get(index) ?? cachedDocument.runs[inline++]
        )
        this.rememberPendingView(
          filePath,
          fileInfo,
          { ...cachedDocument, runs: metadata },
          runs.length,
          runs,
          manifestJson
        )
      }
      return
    }
    this.rememberLaneSummary(
      filePath,
      fileInfo,
      cachedDocument,
      oversized,
      oversized ? runs : undefined
    )
    if (oversized)
      this.rememberPendingView(filePath, fileInfo, cachedDocument, runs.length, runs, manifestJson)
    else this.pendingViews.delete(filePath)
    this.rememberDocument(filePath, {
      mtimeMs: fileInfo.mtimeMs,
      ctimeMs: fileInfo.ctimeMs,
      size: fileInfo.size,
      ino: fileInfo.ino,
      weight,
      document: cachedDocument
    })
  }
}

export {
  NotebookRunRepository,
  NotebookRunSubmissionConflictError,
  environmentManifestChecksumForRun,
  environmentManifestStorageKey,
  getNotebookDataRoot,
  getNotebookFileEvidenceLocation,
  getNotebookRunJsonPath,
  getNotebookSessionRoot,
  getRuntimeRoot
}
export type { RecoveredBackgroundRun }
export type {
  AppendNotebookRunRequest,
  AppendOrGetNotebookRunResult,
  NotebookRunLookupResult,
  LoadNotebookRunDocumentRequest,
  TransitionNotebookRunRequest,
  TransitionNotebookRunResult,
  UpdateKernelStatusRequest,
  UpdateNotebookRunRequest
}
