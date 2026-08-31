import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookKernelMetadata,
  NotebookKernelInstanceIdentity,
  NotebookRunDocument,
  NotebookRunHistorySummary,
  NotebookRunCursor,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import { parseOwnedExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import { NOTEBOOK_RUN_FILE, NOTEBOOKS_DIR } from '../../shared/notebook'
import type { NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import { createLogger } from '../logger'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { decodeVersionedJson } from '../storage/versioned-json-decoder'
import { decodeRunDocumentDataPaths, encodeRunDocumentDataPaths } from './run-document-data-paths'
import {
  createFrameNotebookLane,
  notebookLaneScope,
  type NotebookLaneIdentity
} from './lane-identity'
import { isRecord } from '../value-guards'
import { ensureNotebookInputRoot } from './input-staging'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EXECUTION_FILE_EVIDENCE_DIR = 'execution-file-evidence'
const MAX_DOCUMENT_CACHE_ENTRIES = 8
const MAX_DOCUMENT_CACHE_BYTES = 32 * 1024 * 1024
const MAX_DOCUMENT_READ_ATTEMPTS = 2
const log = createLogger('notebook:persistence')

type DocumentFileIdentity = { mtimeMs: number; size: number; ino: number }

type PersistedNotebookDocumentScope = {
  projectId?: unknown
  projectName?: unknown
  sessionId?: unknown
}

const sameDocumentFileIdentity = (
  left: DocumentFileIdentity,
  right: DocumentFileIdentity
): boolean => left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino

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
}

type UpdateNotebookRunRequest = AppendNotebookRunRequest

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

const notebookRunCandidate = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (
    typeof value.runId !== 'string' ||
    typeof value.cellId !== 'string' ||
    (value.source !== 'agent' && value.source !== 'user') ||
    typeof value.script !== 'string' ||
    !['queued', 'running', 'completed', 'failed', 'timeout', 'interrupted', 'cancelled'].includes(
      String(value.status)
    ) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    (value.kernelEpochId !== undefined &&
      (typeof value.kernelEpochId !== 'string' || value.kernelEpochId.length === 0)) ||
    (value.kernelDispatched !== undefined && typeof value.kernelDispatched !== 'boolean') ||
    (value.runtimeId !== undefined && typeof value.runtimeId !== 'string') ||
    (value.kernelKind !== undefined &&
      value.kernelKind !== 'python' &&
      value.kernelKind !== 'r' &&
      value.kernelKind !== 'repl' &&
      value.kernelKind !== 'bash')
  ) {
    return false
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

const decodeNotebookDocument = (contents: string): NotebookRunDocument => {
  const decoded = decodeVersionedJson(contents, {
    currentVersion: 1,
    readVersion: (value) =>
      typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined,
    decode: notebookDocumentCandidate
  })
  if (decoded.status === 'unsupported') throw new UnsupportedNotebookDocumentVersionError()
  if (decoded.status === 'corrupt') throw new CorruptNotebookDocumentError()
  return decoded.value
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

// Fills optional run fields so old or partial records always have the current shape. Legacy
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
    artifacts: run.artifacts ?? [],
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

// Owns durable run.json persistence for one app storage root.
class NotebookRunRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly documentCache = new Map<
    string,
    { mtimeMs: number; size: number; ino: number; document: NotebookRunDocument }
  >()
  private documentCacheBytes = 0

  constructor(private readonly storageRoot: string) {}

  // Loads an existing history file or creates the directory skeleton and first run.json.
  async loadOrCreate(request: LoadNotebookRunDocumentRequest): Promise<NotebookRunDocument> {
    if (!request.lane) throw new Error('Notebook writes require an explicit Frame lane.')
    const projectId = assertSafeNotebookPathSegment(request.projectId)
    const sessionId = assertSafeNotebookPathSegment(request.sessionId)
    const filePath = getNotebookRunJsonPath(this.storageRoot, projectId, sessionId, request.lane)

    const read = await readDurableJsonFile(filePath, (contents) => {
      const document = decodeNotebookDocument(contents)
      assertNotebookDocumentOwnership(document, projectId, sessionId)
      assertNotebookDocumentShape(document)
      return document
    })
    if (read.status === 'found') {
      // Decode $DATA sentinels against the current data root before recomputing session roots,
      // so a relocated data root and the decoded working-file paths agree.
      const decoded = decodeRunDocumentDataPaths(read.value, this.storageRoot)
      await ensureNotebookInputRoot(this.storageRoot, projectId, sessionId)
      return normalizeDocument(this.storageRoot, request, decoded)
    }

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

    await this.writeDocument(document)

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
  ): Promise<NotebookRunDocument> {
    return this.mutate(projectId, sessionId, lane, (document) => ({
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
  async findExisting(projectId: string, sessionId: string): Promise<NotebookRunDocument | null> {
    try {
      return await this.loadExisting(projectId, sessionId)
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }

      throw error
    }
  }

  async findAnyExisting(projectId: string, sessionId: string): Promise<NotebookRunDocument | null> {
    const root = await this.findExisting(projectId, sessionId)
    if (root) return root

    const framesRoot = join(
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId),
      'frames'
    )
    let entries
    try {
      entries = await readdir(framesRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      const lane = createFrameNotebookLane(projectId, sessionId, entry.name)
      try {
        return await this.loadExisting(projectId, sessionId, lane)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
    }
    return null
  }

  async readSessionDocuments(projectId: string, sessionId: string): Promise<NotebookRunDocument[]> {
    const documents: NotebookRunDocument[] = []
    const legacy = await this.findExisting(projectId, sessionId).catch((error) => {
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

    const framesRoot = join(
      getNotebookSessionRoot(this.storageRoot, projectId, sessionId),
      'frames'
    )
    let entries
    try {
      entries = await readdir(framesRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return documents
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      const lane = createFrameNotebookLane(projectId, sessionId, entry.name)
      const document = await this.loadExisting(projectId, sessionId, lane).catch((error) => {
        if (
          isMissingFileError(error) ||
          error instanceof CorruptNotebookDocumentError ||
          error instanceof UnsupportedNotebookDocumentVersionError
        ) {
          log.warn('skipping unreadable Notebook document', {
            projectId,
            sessionId,
            lane: 'frame',
            frameId: entry.name,
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

  async readSessionRuns(projectId: string, sessionId: string): Promise<NotebookRunRecord[]> {
    const documents = await this.readSessionDocuments(projectId, sessionId)
    return documents
      .flatMap((document) => document.runs)
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
  ): Promise<{
    runs: NotebookRunRecord[]
    total: number
    latestRunEnvironments: Partial<Record<'python' | 'r', string>>
    historySummary?: NotebookRunHistorySummary
    historyPage?: { hasEarlierRuns: boolean; oldestCursor?: NotebookRunCursor }
  }> {
    const documents = await this.readSessionDocuments(projectId, sessionId)
    const runs: NotebookRunRecord[] = []
    const requestedRunIds = new Set(includeRunIds)
    const requestedRuns = new Map<string, NotebookRunRecord>()
    const latestEnvironmentRuns = new Map<'python' | 'r', NotebookRunRecord>()
    const historySummary: NotebookRunHistorySummary | undefined = historySummaryFrameId
      ? {
          agentFrameId: historySummaryFrameId,
          runCount: 0,
          kernelCounts: { python: 0, r: 0, repl: 0, bash: 0 }
        }
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
        if (historySummary && run.agentFrameId === historySummary.agentFrameId) {
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
        fileInfo = await stat(filePath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        const recovered = await readDurableJsonFile(filePath, (contents) => {
          const document = decodeNotebookDocument(contents)
          assertNotebookDocumentOwnership(document, safeProjectId, safeSessionId)
          assertNotebookDocumentShape(document)
          return document
        })
        if (recovered.status === 'missing') throw error
        fileInfo = await stat(filePath)
      }
      const cached = this.documentCache.get(filePath)
      if (cached && sameDocumentFileIdentity(cached, fileInfo)) {
        assertNotebookDocumentOwnership(cached.document, safeProjectId, safeSessionId)
        // Refresh insertion order so the Map also acts as a small LRU.
        this.documentCache.delete(filePath)
        this.documentCache.set(filePath, cached)
        return cached.document
      }
      const read = await readDurableJsonFile(filePath, (contents) => {
        const document = decodeNotebookDocument(contents)
        assertNotebookDocumentOwnership(document, safeProjectId, safeSessionId)
        assertNotebookDocumentShape(document)
        return document
      })
      if (read.status === 'missing') throw new Error(`Notebook document disappeared: ${filePath}`)
      // Decode before normalization for the same reason as loadOrCreate above.
      const decoded = decodeRunDocumentDataPaths(read.value, this.storageRoot)

      const normalized = normalizeDocument(
        this.storageRoot,
        {
          projectId: safeProjectId,
          sessionId: safeSessionId,
          lane
        },
        decoded
      )
      const currentInfo = await stat(filePath)
      if (!sameDocumentFileIdentity(fileInfo, currentInfo)) {
        // An atomic replacement landed between read and stat. Retry once so old bytes can never be
        // cached under the replacement file's identity; under continuous writes, return this valid
        // snapshot without caching it and let the next caller observe the latest document.
        if (attempt + 1 < MAX_DOCUMENT_READ_ATTEMPTS) continue
        return normalized
      }
      this.rememberDocument(filePath, {
        mtimeMs: currentInfo.mtimeMs,
        size: currentInfo.size,
        ino: currentInfo.ino,
        document: normalized
      })
      return normalized
    }

    throw new Error(`Failed to read notebook document: ${filePath}`)
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
    const operation = this.saveQueue.then(async () => {
      const document = await this.loadExisting(projectId, sessionId, lane)
      const nextDocument = transform(document)

      await this.persist(nextDocument)

      return nextDocument
    })

    // Keep later saves moving even if this turn failed (bad transform or a write failure) and
    // surfaced to its caller.
    this.saveQueue = operation.then(
      () => undefined,
      () => undefined
    )

    return operation
  }

  // Queues an unconditional write, used by loadOrCreate's ENOENT branch where there is nothing to
  // read-modify (the file doesn't exist yet, so there is no stale-read race to guard against).
  private async writeDocument(document: NotebookRunDocument): Promise<void> {
    const operation = this.saveQueue.then(() => this.persist(document))

    this.saveQueue = operation.then(
      () => undefined,
      () => undefined
    )
    await operation
  }

  // Retains only a small working set. Large or numerous histories remain readable but are parsed
  // again instead of pinning complete text and image payloads for the process lifetime.
  private rememberDocument(
    filePath: string,
    entry: { mtimeMs: number; size: number; ino: number; document: NotebookRunDocument }
  ): void {
    const previous = this.documentCache.get(filePath)
    if (previous) {
      this.documentCache.delete(filePath)
      this.documentCacheBytes -= previous.size
    }

    if (entry.size > MAX_DOCUMENT_CACHE_BYTES) return

    this.documentCache.set(filePath, entry)
    this.documentCacheBytes += entry.size
    while (
      this.documentCache.size > MAX_DOCUMENT_CACHE_ENTRIES ||
      this.documentCacheBytes > MAX_DOCUMENT_CACHE_BYTES
    ) {
      const oldestPath = this.documentCache.keys().next().value
      if (typeof oldestPath !== 'string') break
      const oldest = this.documentCache.get(oldestPath)
      this.documentCache.delete(oldestPath)
      this.documentCacheBytes -= oldest?.size ?? 0
    }
  }

  // Writes one document to disk via a temp file + atomic rename. Always invoked from inside the
  // saveQueue chain (mutate() or writeDocument() above), never called directly.
  private async persist(document: NotebookRunDocument): Promise<void> {
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
    const encoded = encodeRunDocumentDataPaths(document, this.storageRoot)
    await writeDurableJsonFile(filePath, `${JSON.stringify(encoded, null, 2)}\n`)
    const fileInfo = await stat(filePath)
    this.rememberDocument(filePath, {
      mtimeMs: fileInfo.mtimeMs,
      size: fileInfo.size,
      ino: fileInfo.ino,
      document
    })
  }
}

export {
  NotebookRunRepository,
  getNotebookDataRoot,
  getNotebookFileEvidenceLocation,
  getNotebookRunJsonPath,
  getNotebookSessionRoot,
  getRuntimeRoot
}
export type {
  AppendNotebookRunRequest,
  LoadNotebookRunDocumentRequest,
  UpdateKernelStatusRequest,
  UpdateNotebookRunRequest
}
