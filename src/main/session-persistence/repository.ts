import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  loadSessionHistoryPageRequestSchema,
  type LoadSessionHistoryPageRequest,
  type SessionHistoryPage
} from '../../shared/session-history'
import type { SessionComputePolicy } from '@aipoch/compute'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { packageOriginSchema } from '../../shared/session-package'
import { isSessionPackagePending } from '../storage/session-package-state'
import { decodeSessionComputePolicy } from './compute-policy'
import { preserveImportedSession } from './imported-session'
import { SessionProjectionAfterCommitError, type MainSessionSaveOptions } from './save-session'
import { createRuntimeSessionFile } from './runtime-session-file'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

import {
  MAX_PERSISTED_SESSION_BYTES,
  deleteSessionRecoveryFileRequestSchema,
  SESSION_RECOVERY_COMPUTE_JOBS_ERROR,
  type DeleteSessionRecoveryFileRequest,
  SessionDeletionCommittedError,
  SessionRevisionConflictError,
  SessionSizeLimitError,
  createEmptySessionManifest,
  createSessionFile,
  decodeSessionEnvelope,
  decodeSessionFile,
  normalizeSessionManifest,
  sanitizeSessionUploadedAttachments,
  sessionRevision,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest,
  type SessionLoadFailure,
  type SessionLoadWarning,
  type SessionSummary,
  type SessionUsageProjection
} from '../../shared/session-persistence'
import {
  DurableJsonReadLimitError,
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  readFileWithinLimit,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import { defaultFileDurability } from '@aipoch/durable-files'
import { SessionPersistenceOperationScheduler } from './operation-scheduler'
import {
  assertSessionProjectionStorageShape,
  buildSessionProjection,
  type SessionProjectionRepository
} from './projection'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'
import {
  sessionJournalPath,
  sessionLegacyBackupPath,
  SessionJournalStore,
  SessionJournalCorruptionError,
  SessionJournalVersionError,
  SessionJournalSizeError,
  SessionJournalRevisionError,
  type SessionJournalDependencies,
  type SessionJournalPreparedWrite,
  type SessionJournalRead
} from './journal'
import { journalValueByteLength, normalizeJournalValue, type JournalValue } from './journal-codec'

const SESSIONS_DIR = 'sessions'
const DELETED_SESSIONS_DIR = 'deleted-sessions'
const PROJECT_DELETION_COMMIT_MARKER = '.project-deletion-committed'
const MANIFEST_FILE = 'manifest.json'
const SESSION_LOCATOR_FILE = 'session-locator.json'
const PRE_S2_BACKUP_SUFFIX = '.pre-s2-backup'
const PRE_SUBAGENT_MODEL_BACKUP_SUFFIX = '.pre-subagent-model-backup'
const RECOVERABLE_TEMPORARY_FILE_PATTERN =
  /^(.+\.json)\.(?:\d{13}-\d+|\d+|(\d+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.tmp$/iu

const temporarySessionPrimaryName = (fileName: string): string | undefined => {
  const temporary = RECOVERABLE_TEMPORARY_FILE_PATTERN.exec(fileName)
  if (!temporary) return undefined
  // Match the durable reader: only current PID/UUID names carry a validated PID.
  // Legacy numeric suffixes have no reliable live-writer ownership marker.
  const pid = Number(temporary[2])
  if (temporary[2] !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) return undefined
  return temporary[1]
}

const nextSessionRevision = (revision: number): number => {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Session revision cannot be incremented safely.')
  }
  return revision + 1
}

// A package copy starts with already-versioned history and has no local pre-upgrade image.
// Require matching durable provenance: caller-supplied metadata cannot bypass a local backup.
const isSamePublishedPackageCopy = (value: unknown, next: PersistedChatSession): boolean => {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Record<string, unknown>
  const current =
    envelope.session && typeof envelope.session === 'object'
      ? (envelope.session as Record<string, unknown>)
      : envelope
  const origin = packageOriginSchema.safeParse(current.packageOrigin ?? current.forkOrigin)
  const nextOrigin = next.packageOrigin ?? next.forkOrigin
  return (
    origin.success &&
    Boolean(nextOrigin) &&
    current.id === next.id &&
    current.projectId === next.projectId &&
    origin.data.importId === nextOrigin?.importId
  )
}

const hasS2AttemptSchema = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Record<string, unknown>
  const session =
    typeof envelope.session === 'object' && envelope.session !== null
      ? (envelope.session as Record<string, unknown>)
      : envelope
  const runtimeContext = session.runtimeContext
  if (typeof runtimeContext !== 'object' || runtimeContext === null) return false
  const delegatedWork = (runtimeContext as Record<string, unknown>).delegatedWork
  if (typeof delegatedWork !== 'object' || delegatedWork === null) return false
  const records = (delegatedWork as Record<string, unknown>).records
  if (!Array.isArray(records)) return false
  return records.some((record) => {
    if (typeof record !== 'object' || record === null) return false
    const attempts = (record as Record<string, unknown>).attempts
    return (
      Array.isArray(attempts) &&
      attempts.some(
        (attempt) =>
          typeof attempt === 'object' &&
          attempt !== null &&
          Object.hasOwn(attempt, 'initiatingTurnMessageId')
      )
    )
  })
}

const hasSubagentModelAttemptSchema = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Record<string, unknown>
  const session =
    typeof envelope.session === 'object' && envelope.session !== null
      ? (envelope.session as Record<string, unknown>)
      : envelope
  const runtimeContext = session.runtimeContext
  const delegatedWork =
    typeof runtimeContext === 'object' && runtimeContext !== null
      ? (runtimeContext as Record<string, unknown>).delegatedWork
      : undefined
  const records =
    typeof delegatedWork === 'object' && delegatedWork !== null
      ? (delegatedWork as Record<string, unknown>).records
      : undefined
  return (
    Array.isArray(records) &&
    records.some((record) => {
      const attempts =
        typeof record === 'object' && record !== null
          ? (record as Record<string, unknown>).attempts
          : undefined
      return (
        Array.isArray(attempts) &&
        attempts.some(
          (attempt) =>
            typeof attempt === 'object' &&
            attempt !== null &&
            Object.hasOwn(attempt, 'executionModel')
        )
      )
    })
  )
}

type SessionScanMetrics = {
  projectDirectoryCount: number
  sessionFileCount: number
  sessionBytes: number
  authorityReadMs: number
  jsonParseMs: number
}

export type SessionIdentityCatalog = {
  sessions: { projectId: string; id: string }[]
  isComplete: boolean
  generation: number
}

export type SessionLocation = {
  sessionId: string
  projectId: string
  storagePath: string
}

type SessionLocatorDocument = {
  version: 1
  entries: SessionLocation[]
}

type PreparedSessionWrite = {
  sanitizedSession: PersistedChatSession
  document: ReturnType<typeof createSessionFile>
  contents?: string
  journalWrite?: SessionJournalPreparedWrite
  runtimeChanges?: import('../../shared/runtime-session-projection').RuntimeSessionChanges
  runtimeSourceFingerprint?: string
}

type SessionLoadDiagnostics = {
  result: LoadAllSessionsResult
  // False means at least one directory or session file could not be read or safely quarantined.
  // Callers may hydrate the returned sessions but must not reconcile absent index rows as deletions.
  isComplete: boolean
  warnings: SessionLoadWarning[]
  scanMetrics: SessionScanMetrics
  failure?: SessionLoadFailure
}

type SessionScanOptions = {
  quarantinedIsIncomplete?: boolean
  mode?: 'repair' | 'read-only'
  // Main-owned same-process mutations read durable authority without applying app-restart recovery.
  preserveRuntimeState?: boolean
}

type SessionLoadDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

type SessionRecoverySnapshot = (SessionLoadDiagnostic | { status: 'repair-required' }) & {
  metrics?: Pick<SessionScanMetrics, 'sessionBytes' | 'authorityReadMs' | 'jsonParseMs'>
}

type SessionMutationAuthorityRepository = {
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string,
    options?: SessionScanOptions
  ): Promise<SessionLoadDiagnostic>
}

// Same-process read-modify-write paths must observe the durable runtime state verbatim. Startup
// hydration deliberately does not use this seam because it owns app-restart recovery.
export const loadSessionMutationAuthority = (
  repository: SessionMutationAuthorityRepository,
  projectId: string,
  sessionId: string
): Promise<SessionLoadDiagnostic> =>
  repository.loadSessionWithDiagnostics(projectId, sessionId, {
    mode: 'read-only',
    preserveRuntimeState: true
  })

type ProjectSessionLoadDiagnostics = {
  sessions: PersistedChatSession[]
  isComplete: boolean
}

type ProjectSessionDeletionState = 'live' | 'legacy-committed' | 'prepared' | 'absent'
type FilesystemBoundaryState = 'missing' | 'valid' | 'invalid'

class UnsupportedSessionFileError extends DurableJsonRecoveryBarrierError {}

type SessionDirectoryEntry = {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

type SessionRepositoryDependencies = {
  hasComputeJobs?(projectId: string, sessionId: string): Promise<boolean>
  hasActiveRuntimePrompt(projectId: string, sessionId: string): boolean
  hasLiveRuntimeSession(projectId: string, sessionId: string): boolean
  maxSessionBytes: number
  journalDependencies?: SessionJournalDependencies
  remove(path: string, options: { force: boolean; recursive: boolean }): Promise<void>
  readDirectoryEntries(path: string): Promise<SessionDirectoryEntry[]>
  readManifestFile(path: string): Promise<string>
  readSessionFile(path: string): Promise<string>
  readSessionFileWithinLimit(path: string, maxBytes: number): Promise<string>
  renameFile(source: string, destination: string): Promise<void>
  wait(delayMs: number): Promise<void>
}

const DEFAULT_DEPENDENCIES: SessionRepositoryDependencies = {
  hasActiveRuntimePrompt: () => false,
  hasLiveRuntimeSession: () => false,
  maxSessionBytes: MAX_PERSISTED_SESSION_BYTES,
  remove: (path, options) => rm(path, options),
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readManifestFile: (path) => readFile(path, 'utf8'),
  readSessionFile: (path) => readFile(path, 'utf8'),
  readSessionFileWithinLimit: readFileWithinLimit,
  renameFile: (source, destination) => rename(source, destination),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
}

const projectIncompleteSummaries = (
  result: LoadAllSessionsResult,
  existingNumbers: ReadonlyMap<string, number> = new Map()
): SessionSummary[] => {
  const ordered = [...result.sessions].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
  const existingIdByNumber = new Map(
    [...existingNumbers].map(([id, number]) => [number, id] as const)
  )
  const candidateNumber = (session: PersistedChatSession): number | undefined =>
    existingNumbers.get(session.id) ?? session.number
  const candidateCounts = new Map<number, number>()
  for (const session of ordered) {
    const number = candidateNumber(session)
    const owner = number === undefined ? undefined : existingIdByNumber.get(number)
    if (
      number === undefined ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (owner && owner !== session.id)
    ) {
      continue
    }
    candidateCounts.set(number, (candidateCounts.get(number) ?? 0) + 1)
  }
  const used = new Set(existingNumbers.values())
  for (const [number, count] of candidateCounts) if (count === 1) used.add(number)
  let nextNumber = 1
  for (const number of used) nextNumber = Math.max(nextNumber, number + 1)
  return ordered
    .map((session) => {
      let number = candidateNumber(session)
      const owner = number === undefined ? undefined : existingIdByNumber.get(number)
      if (
        number === undefined ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (owner && owner !== session.id) ||
        candidateCounts.get(number) !== 1
      ) {
        while (used.has(nextNumber)) nextNumber += 1
        number = nextNumber
        used.add(number)
        nextNumber += 1
      }
      return { ...buildSessionProjection(session).summary, number }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

// Rejects path segments that could escape the sessions tree. Real session/project ids are id-like, so
// this only guards against corrupt or malicious values before they become file paths.
const assertSafeSegment = (segment: unknown): string => {
  if (
    typeof segment !== 'string' ||
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Unsafe session path segment: ${JSON.stringify(segment)}`)
  }

  return segment
}

// Existing sessions/<projectId>/<id>.json files retain their atomic snapshot reads/writes.
// New Sessions use append-only JSONL. Both paths serialize at the Project/Session scope.
// A separate manifest tracks the last-open selection; damaged authority is retained for recovery.
class SessionRepository {
  private readonly operationScheduler = new SessionPersistenceOperationScheduler()
  private catalogGeneration = 0
  private activeCatalogMutations = 0
  private catalogCommitFence: Promise<void> | undefined
  private readonly sessionRevisions = new Map<string, number>()
  private projectionWritesSuspended = false
  private readonly suspendedProjectionSessionWrites = new Map<
    string,
    Readonly<{ projectId: string; sessionId: string }>
  >()
  private suspendedProjectionCatalogMutation = false
  private readyIdentityCatalog: SessionIdentityCatalog | undefined
  private sessionLocator: SessionLocatorDocument | undefined
  private sessionLocatorTail: Promise<void> = Promise.resolve()
  private readonly sessionLocatorRemovedSessionIds = new Set<string>()
  private projectionInitialization:
    | Promise<{
        result?: LoadAllSessionsResult
        sessions: SessionSummary[]
        recoveredSessions?: PersistedChatSession[]
      }>
    | undefined
  private backupSequence = 0
  private readonly dependencies: SessionRepositoryDependencies
  private readonly journal: SessionJournalStore
  // Bind Main's reducer evidence to the existing file identity without retaining old documents.
  private readonly runtimeAuthorityFingerprints = new WeakMap<PersistedChatSession, string>()

  constructor(
    private readonly storageDir: string,
    dependencies: Partial<SessionRepositoryDependencies> = {},
    private readonly projection?: SessionProjectionRepository
  ) {
    this.dependencies = {
      hasComputeJobs: dependencies.hasComputeJobs,
      hasActiveRuntimePrompt:
        dependencies.hasActiveRuntimePrompt ?? DEFAULT_DEPENDENCIES.hasActiveRuntimePrompt,
      hasLiveRuntimeSession:
        dependencies.hasLiveRuntimeSession ?? DEFAULT_DEPENDENCIES.hasLiveRuntimeSession,
      maxSessionBytes: dependencies.maxSessionBytes ?? DEFAULT_DEPENDENCIES.maxSessionBytes,
      journalDependencies: dependencies.journalDependencies,
      remove: (path, options) =>
        this.mutateCatalog(() =>
          (dependencies.remove ?? DEFAULT_DEPENDENCIES.remove)(path, options)
        ),
      readDirectoryEntries:
        dependencies.readDirectoryEntries ?? DEFAULT_DEPENDENCIES.readDirectoryEntries,
      readManifestFile: dependencies.readManifestFile ?? DEFAULT_DEPENDENCIES.readManifestFile,
      readSessionFile: dependencies.readSessionFile ?? DEFAULT_DEPENDENCIES.readSessionFile,
      readSessionFileWithinLimit:
        dependencies.readSessionFileWithinLimit ??
        (dependencies.readSessionFile
          ? async (path, maxBytes) => {
              const contents = await dependencies.readSessionFile!(path)
              if (Buffer.byteLength(contents, 'utf8') > maxBytes) {
                throw new DurableJsonReadLimitError(basename(path), maxBytes)
              }
              return contents
            }
          : DEFAULT_DEPENDENCIES.readSessionFileWithinLimit),
      renameFile: (source, destination) =>
        this.mutateCatalog(() =>
          (dependencies.renameFile ?? DEFAULT_DEPENDENCIES.renameFile)(source, destination)
        ),
      wait: dependencies.wait ?? DEFAULT_DEPENDENCIES.wait
    }
    this.journal = new SessionJournalStore({
      maxBytes: this.dependencies.maxSessionBytes,
      dependencies: {
        readFileWithinLimit: this.dependencies.readSessionFileWithinLimit,
        rename: this.dependencies.renameFile,
        remove: this.dependencies.remove,
        wait: this.dependencies.wait,
        ...this.dependencies.journalDependencies
      }
    })
  }

  private async mutateCatalog(operation: () => Promise<void>): Promise<void> {
    while (this.catalogCommitFence) await this.catalogCommitFence
    this.catalogGeneration += 1
    this.activeCatalogMutations += 1
    try {
      await operation()
    } finally {
      this.activeCatalogMutations -= 1
      this.catalogGeneration += 1
    }
  }

  // Caller also owns the coordinator boundary and must not call scheduled repository operations.
  // Package publication outside this repository additionally requires its coordinator epoch guard.
  async runWithSessionCatalogSnapshot(
    snapshot: SessionIdentityCatalog,
    operation: () => Promise<void>
  ): Promise<boolean> {
    return this.operationScheduler.runGlobal(async () => {
      if (
        !snapshot.isComplete ||
        snapshot.generation !== this.catalogGeneration ||
        this.activeCatalogMutations > 0
      )
        return false
      let release!: () => void
      this.catalogCommitFence = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await operation()
        return true
      } finally {
        this.catalogCommitFence = undefined
        release()
      }
    })
  }

  private get sessionsDir(): string {
    return join(this.storageDir, SESSIONS_DIR)
  }

  private get manifestPath(): string {
    return join(this.sessionsDir, MANIFEST_FILE)
  }

  private get sessionLocatorPath(): string {
    return join(this.sessionsDir, SESSION_LOCATOR_FILE)
  }

  private get deletedSessionsDir(): string {
    return join(this.storageDir, DELETED_SESSIONS_DIR)
  }

  private projectDir(projectId: string): string {
    return join(this.sessionsDir, assertSafeSegment(projectId))
  }

  recoveryFolderPath(projectId: string): string {
    return this.projectDir(projectId)
  }

  // Discard only quarantined authority. Ordinary Session deletion still requires readable JSON.
  async deleteRecoveryFile(request: DeleteSessionRecoveryFileRequest): Promise<void> {
    const { projectId, fileName } = deleteSessionRecoveryFileRequestSchema.parse(request)
    const sessionId = fileName.slice(0, -5)
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      const boundary = await this.inspectActiveProjectBoundary(projectId)
      if (boundary === 'missing') return
      if (boundary !== 'valid')
        throw new Error('Session recovery directory is not a regular directory.')
      const projects = await this.dependencies.readDirectoryEntries(this.sessionsDir)
      if (!projects.some((entry) => entry.name === projectId && entry.isDirectory())) {
        throw new Error('Session recovery Project identity does not match its directory.')
      }
      if (
        this.dependencies.hasLiveRuntimeSession(projectId, sessionId) ||
        this.dependencies.hasActiveRuntimePrompt(projectId, sessionId)
      ) {
        throw new Error('Cannot discard recovery files for a live Session.')
      }
      const primaryPath = this.sessionFilePath(projectId, sessionId)
      if (
        (await this.inspectFileBoundary(primaryPath)) !== 'missing' ||
        (await this.journal.inspectStorage(primaryPath)).paths.length > 0
      ) {
        throw new Error(
          'The saved conversation changed. Recheck before deleting its recovery files.'
        )
      }
      const entries = await this.dependencies.readDirectoryEntries(this.projectDir(projectId))
      if (entries.some((entry) => temporarySessionPrimaryName(entry.name) === fileName)) {
        throw new Error(
          'The saved conversation has a pending write. Recheck before deleting its recovery files.'
        )
      }
      // Removing the last quarantine would otherwise authorize orphan-job cleanup, including
      // remote working files. Recovery-copy deletion must never imply that broader consent.
      if (!this.dependencies.hasComputeJobs)
        throw new Error('Compute ownership check is unavailable.')
      if (await this.dependencies.hasComputeJobs(projectId, sessionId)) {
        throw new Error(SESSION_RECOVERY_COMPUTE_JOBS_ERROR)
      }
      const prefix = `${fileName}.invalid-`
      const quarantines = entries.filter(
        (entry) =>
          entry.name.startsWith(prefix) && /^\d+-\d+$/u.test(entry.name.slice(prefix.length))
      )
      // Validate every candidate before removing any. Never recurse or follow a link.
      for (const entry of quarantines) {
        if (!entry.isFile()) {
          throw new Error('Session recovery file is not a regular file.')
        }
        await this.assertFileBoundary(
          join(this.projectDir(projectId), entry.name),
          'Session recovery file'
        )
      }
      for (const entry of quarantines) {
        await this.dependencies.remove(join(this.projectDir(projectId), entry.name), {
          recursive: false,
          force: true
        })
      }
    })
  }

  private sessionFilePath(projectId: string, sessionId: string): string {
    return join(this.projectDir(projectId), `${assertSafeSegment(sessionId)}.json`)
  }

  private deletedProjectDir(projectId: string): string {
    return join(this.deletedSessionsDir, assertSafeSegment(projectId))
  }

  private async inspectDirectoryBoundary(path: string): Promise<FilesystemBoundaryState> {
    try {
      const metadata = await lstat(path)
      return metadata.isDirectory() && !metadata.isSymbolicLink() ? 'valid' : 'invalid'
    } catch (error) {
      return isMissingFileError(error) ? 'missing' : 'invalid'
    }
  }

  private async inspectFileBoundary(path: string): Promise<FilesystemBoundaryState> {
    try {
      const metadata = await lstat(path)
      return metadata.isFile() && !metadata.isSymbolicLink() ? 'valid' : 'invalid'
    } catch (error) {
      return isMissingFileError(error) ? 'missing' : 'invalid'
    }
  }

  private async inspectActiveProjectBoundary(
    projectId: string,
    includePendingImport = false
  ): Promise<FilesystemBoundaryState> {
    if (!includePendingImport && (await isSessionPackagePending(this.storageDir, projectId)))
      return 'missing'
    const sessions = await this.inspectDirectoryBoundary(this.sessionsDir)
    if (sessions !== 'valid') return sessions
    return this.inspectDirectoryBoundary(this.projectDir(projectId))
  }

  private async ensureDirectoryBoundary(path: string, label: string): Promise<void> {
    await mkdir(path, { recursive: true })
    if ((await this.inspectDirectoryBoundary(path)) !== 'valid') {
      throw new Error(`${label} is not a regular directory.`)
    }
  }

  private async assertFileBoundary(path: string, label: string): Promise<void> {
    if ((await this.inspectFileBoundary(path)) === 'invalid') {
      throw new Error(`${label} is not a regular file.`)
    }
  }

  // Loads every per-session file plus the manifest.
  async loadAll(): Promise<LoadAllSessionsResult> {
    const scan = await this.loadAllWithDiagnostics()
    return scan.result
  }

  async loadManifest(): Promise<PersistedSessionManifest> {
    return (await this.readManifest({ quarantineInvalidFiles: true })).manifest
  }

  async ensureSessionProjection(
    loadAuthority: () => Promise<LoadAllSessionsResult>,
    recoverSession?: (summary: SessionSummary) => Promise<PersistedChatSession | undefined>
  ): Promise<{
    result?: LoadAllSessionsResult
    sessions: SessionSummary[]
    recoveredSessions?: PersistedChatSession[]
  }> {
    if (!this.projection) throw new Error('Session projection is unavailable.')
    if (this.projectionInitialization) return this.projectionInitialization

    const initialization = this.ensureSessionProjectionNow(loadAuthority, recoverSession)
    this.projectionInitialization = initialization
    void initialization.then(
      () => {
        if (this.projectionInitialization === initialization) {
          this.projectionInitialization = undefined
        }
      },
      () => {
        if (this.projectionInitialization === initialization) {
          this.projectionInitialization = undefined
        }
      }
    )
    return initialization
  }

  async reconcilePendingSessionProjection(): Promise<void> {
    await this.operationScheduler.runGlobal(async () => {
      if (!this.projection || !(await this.projection.isInitialized())) return
      let work = await this.projection.pending()
      const parentDeletes = work.filter(
        ({ operation, sessionId }) => operation === 'delete' && sessionId.startsWith('import-')
      )
      if (parentDeletes.length) {
        // Detaching a child can itself finish its pending save. Refresh before replaying the rest.
        for (const { projectId, sessionId } of parentDeletes) {
          if (await this.projection.isDeleted(projectId, sessionId)) {
            await this.retryDeletedDiscussionChildren(projectId, sessionId)
          } else {
            await this.deleteSessionNow(projectId, sessionId)
          }
        }
        work = (await this.projection.pending()).filter(
          ({ operation, sessionId }) => operation !== 'delete' || !sessionId.startsWith('import-')
        )
      }
      for (const pending of work) {
        if (pending.operation === 'delete') {
          await this.deleteSessionNow(pending.projectId, pending.sessionId)
          continue
        }
        const loaded = await this.loadSessionWithDiagnostics(pending.projectId, pending.sessionId, {
          mode: 'read-only'
        })
        if (loaded.status === 'unreadable') continue
        if (loaded.status === 'found') {
          // The global barrier keeps the authority read and replay ahead of every later save. Call
          // the unscheduled implementation to avoid nesting the same repository scheduler.
          await this.saveSessionNow(loaded.session)
          continue
        }

        const deletionState = await this.getProjectSessionDeletionState(pending.projectId)
        if (deletionState === 'prepared' || deletionState === 'legacy-committed') {
          const committed = await this.loadCommittedProjectWithDiagnostics(pending.projectId)
          if (!committed.isComplete) break
          const session = committed.sessions.find(({ id }) => id === pending.sessionId)
          if (session) {
            await this.projection.commitReconciliation(session)
            continue
          }
        }
        await this.projection.commitDelete(pending.projectId, pending.sessionId)
      }
    })
  }

  async summarizeReadOnlyAuthority(result: LoadAllSessionsResult): Promise<SessionSummary[]> {
    if (!this.projection) throw new Error('Session projection is unavailable.')
    const assignments = await this.operationScheduler.runGlobal(() =>
      this.projection!.numberAssignments()
    )
    return projectIncompleteSummaries(
      result,
      new Map(assignments.map(({ id, number }) => [id, number]))
    )
  }

  private async ensureSessionProjectionNow(
    loadAuthority: () => Promise<LoadAllSessionsResult>,
    recoverSession?: (summary: SessionSummary) => Promise<PersistedChatSession | undefined>
  ): Promise<{
    result?: LoadAllSessionsResult
    sessions: SessionSummary[]
    recoveredSessions?: PersistedChatSession[]
  }> {
    if (!this.projection) throw new Error('Session projection is unavailable.')

    const loadReadyProjection = async (): Promise<{
      result?: LoadAllSessionsResult
      sessions: SessionSummary[]
      recoveredSessions?: PersistedChatSession[]
    }> => {
      const summaries = await this.listProjectionSummaries()
      // A ready catalog is navigation authority, not a request to inspect historical bodies. A
      // lightweight identity scan still detects an unindexed historical file without parsing every
      // transcript; only complete identity drift triggers the guarded body scan and repair.
      if (
        !this.readyIdentityCatalog ||
        this.readyIdentityCatalog.generation !== this.catalogGeneration
      ) {
        const identityCatalog = await this.scanSessionIdentities()
        if (!identityCatalog.isComplete) {
          this.readyIdentityCatalog = undefined
        } else {
          this.readyIdentityCatalog = identityCatalog
          const projectedIds = new Set(summaries.map(({ projectId, id }) => `${projectId}\0${id}`))
          const identityDrift =
            identityCatalog.sessions.length !== projectedIds.size ||
            identityCatalog.sessions.some(
              ({ projectId, id }) => !projectedIds.has(`${projectId}\0${id}`)
            )
          if (identityDrift) {
            this.readyIdentityCatalog = undefined
            const result = await this.loadAuthorityWithSuspendedProjection(loadAuthority)
            return this.operationScheduler.runGlobal(async () => {
              const freshResult = await this.refreshProjectionBuildAuthority(result)
              const assignments = await this.projection!.numberAssignments()
              if (freshResult.diagnostics?.isComplete === false) {
                return {
                  result: freshResult,
                  sessions: projectIncompleteSummaries(
                    freshResult,
                    new Map(assignments.map(({ id, number }) => [id, number]))
                  )
                }
              }
              const numbered = await this.repairAuthorityNumbers(
                freshResult.sessions,
                new Map(assignments.map(({ id, number }) => [id, number]))
              )
              await this.projection!.replaceAll(numbered)
              this.readyIdentityCatalog = undefined
              return {
                result: { ...freshResult, sessions: numbered },
                sessions: await this.projection!.list()
              }
            })
          }
        }
      }
      // Oversized/corrupt files and temporary evidence are isolated by targeted recovery/open.
      if (!recoverSession) return { sessions: summaries }
      const recoveredSessions: PersistedChatSession[] = []
      for (const summary of summaries.filter((candidate) => candidate.needsStartupRecovery)) {
        const session = await recoverSession(summary)
        if (session) recoveredSessions.push(session)
      }
      return { sessions: await this.listProjectionSummaries(), recoveredSessions }
    }

    if (await this.projection.isInitialized()) {
      await this.reconcilePendingSessionProjection()
      if (await this.projection.isReady()) return loadReadyProjection()
    }

    const result = await this.loadAuthorityWithSuspendedProjection(loadAuthority)
    return this.operationScheduler.runGlobal(async () => {
      const freshResult = await this.refreshProjectionBuildAuthority(result)
      // A caller may supply a catalog without diagnostics. An initialized projection with pending
      // recovery is independently incomplete; rebuilding must not erase its unresolved authority.
      if (
        freshResult.diagnostics?.isComplete === false ||
        ((await this.projection!.isInitialized()) && !(await this.projection!.isReady()))
      ) {
        return {
          result: {
            ...freshResult,
            diagnostics: {
              ...freshResult.diagnostics,
              isComplete: false,
              warnings: freshResult.diagnostics?.warnings ?? []
            }
          },
          sessions: projectIncompleteSummaries(freshResult)
        }
      }
      for (const session of freshResult.sessions) assertSessionProjectionStorageShape(session)
      const assignments = await this.projection!.numberAssignments()
      const existingNumberById = new Map(assignments.map(({ id, number }) => [id, number]))
      const existingIdByNumber = new Map(assignments.map(({ id, number }) => [number, id]))
      const ordered = [...freshResult.sessions].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )
      const numberCounts = new Map<number, number>()
      for (const session of ordered) {
        const number = existingNumberById.get(session.id) ?? session.number
        const owner = number === undefined ? undefined : existingIdByNumber.get(number)
        if (
          number === undefined ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          (owner && owner !== session.id)
        )
          continue
        numberCounts.set(number, (numberCounts.get(number) ?? 0) + 1)
      }
      const rebuiltById = new Map<string, PersistedChatSession>()
      for (const session of ordered) {
        const number = existingNumberById.get(session.id) ?? session.number
        const owner = number === undefined ? undefined : existingIdByNumber.get(number)
        if (
          number !== undefined &&
          Number.isSafeInteger(number) &&
          number > 0 &&
          (!owner || owner === session.id) &&
          numberCounts.get(number) === 1
        ) {
          try {
            const numbered =
              session.number === number
                ? session
                : await this.saveSessionNow({ ...session, number })
            rebuiltById.set(session.id, numbered)
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== 'Cannot save a Session for a deleted Project.'
            )
              throw error
          }
          continue
        }
        try {
          const persisted = await this.saveSessionNow({ ...session, number: undefined })
          rebuiltById.set(session.id, persisted)
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'Cannot save a Session for a deleted Project.'
          )
            throw error
        }
      }
      const rebuilt = freshResult.sessions.map((session) => rebuiltById.get(session.id) ?? session)
      await this.projection!.replaceAll(rebuilt)
      this.readyIdentityCatalog = undefined
      return {
        result: { ...freshResult, sessions: rebuilt },
        sessions: await this.projection!.list()
      }
    })
  }

  private async repairAuthorityNumbers(
    sessions: readonly PersistedChatSession[],
    existingNumbers: ReadonlyMap<string, number>
  ): Promise<PersistedChatSession[]> {
    const ordered = [...sessions].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    const existingIdByNumber = new Map(
      [...existingNumbers].map(([id, number]) => [number, id] as const)
    )
    const candidateNumber = (session: PersistedChatSession): number | undefined =>
      existingNumbers.get(session.id) ?? session.number
    const candidateCounts = new Map<number, number>()
    for (const session of ordered) {
      const number = candidateNumber(session)
      const owner = number === undefined ? undefined : existingIdByNumber.get(number)
      if (
        number === undefined ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (owner && owner !== session.id)
      )
        continue
      candidateCounts.set(number, (candidateCounts.get(number) ?? 0) + 1)
    }
    const used = new Set(existingNumbers.values())
    for (const [number, count] of candidateCounts) if (count === 1) used.add(number)
    let nextNumber = 1
    for (const number of used) nextNumber = Math.max(nextNumber, number + 1)

    const repairedById = new Map<string, PersistedChatSession>()
    const numberSession = async (
      session: PersistedChatSession,
      number: number
    ): Promise<PersistedChatSession> => {
      const numbered = { ...session, number }
      try {
        assertSessionProjectionStorageShape(numbered)
      } catch {
        // Keep an invalid historical row in the rebuild input with its allocated number. The
        // projection repository will skip it and preserve an already indexed row, while a new
        // invalid row remains isolated from the rest of the catalog.
        return numbered
      }
      return this.saveSessionNow(numbered)
    }
    for (const session of ordered) {
      const existing = existingNumbers.get(session.id)
      const number = candidateNumber(session)
      const owner = number === undefined ? undefined : existingIdByNumber.get(number)
      const valid =
        number !== undefined &&
        Number.isSafeInteger(number) &&
        number > 0 &&
        (!owner || owner === session.id) &&
        candidateCounts.get(number) === 1
      if (valid && (existing === undefined || session.number === existing)) {
        repairedById.set(session.id, session)
        continue
      }

      if (valid && existing !== undefined) {
        repairedById.set(session.id, await numberSession(session, existing))
        continue
      }

      while (used.has(nextNumber)) nextNumber += 1
      const persisted = await numberSession(session, nextNumber)
      repairedById.set(session.id, persisted)
      used.add(nextNumber)
      nextNumber += 1
    }
    return sessions.map((session) => repairedById.get(session.id) ?? session)
  }

  private async loadAuthorityWithSuspendedProjection(
    loadAuthority: () => Promise<LoadAllSessionsResult>
  ): Promise<LoadAllSessionsResult> {
    this.projectionWritesSuspended = true
    this.suspendedProjectionSessionWrites.clear()
    this.suspendedProjectionCatalogMutation = false
    try {
      return await loadAuthority()
    } catch (error) {
      this.projectionWritesSuspended = false
      throw error
    }
  }

  private async refreshProjectionBuildAuthority(
    result: LoadAllSessionsResult
  ): Promise<LoadAllSessionsResult> {
    try {
      if (this.suspendedProjectionCatalogMutation) {
        const scan = await this.loadAllWithDiagnostics({ mode: 'read-only' })
        return {
          ...result,
          ...scan.result,
          diagnostics: {
            ...result.diagnostics,
            isComplete: scan.isComplete,
            warnings: scan.warnings ?? [],
            failure: scan.failure
          }
        }
      }

      const sessions = new Map(result.sessions.map((session) => [session.id, session]))
      for (const { projectId, sessionId } of this.suspendedProjectionSessionWrites.values()) {
        const loaded = await this.loadSessionWithDiagnostics(projectId, sessionId, {
          mode: 'read-only'
        })
        if (loaded.status === 'unreadable') {
          this.suspendedProjectionCatalogMutation = true
          return this.refreshProjectionBuildAuthority(result)
        }
        if (loaded.status === 'found') sessions.set(sessionId, loaded.session)
        else sessions.delete(sessionId)
      }
      return {
        ...result,
        sessions: [...sessions.values()],
        diagnostics: {
          isComplete: result.diagnostics?.isComplete ?? true,
          warnings: result.diagnostics?.warnings ?? [],
          ...result.diagnostics
        }
      }
    } finally {
      this.projectionWritesSuspended = false
    }
  }

  async listProjectionSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    const queuedAt = performance.now()
    return this.operationScheduler.runGlobal(async () => {
      // A caller cancelled while queued behind global work: skip the read instead of running it.
      signal?.throwIfAborted()
      const startedAt = performance.now()
      const summaries = await this.projection!.list()
      try {
        createLogger('session-persistence').debug('Session summaries loaded', {
          mode: 'summary',
          sessionCount: summaries.length,
          candidateCount: summaries.filter((summary) => summary.needsStartupRecovery).length,
          queueWaitMs: startedAt - queuedAt,
          summaryReadMs: performance.now() - startedAt
        })
      } catch {
        // Diagnostics must not affect catalog availability.
      }
      return summaries
    })
  }

  async findArtifactSessions(
    artifactId: string,
    ensureProjection: () => Promise<{ result?: LoadAllSessionsResult }>
  ): Promise<Array<{ projectId: string; sessionId: string }>> {
    const { result } = await ensureProjection()
    if (result) {
      // Recovery may return readable authority while the index is incomplete. Reuse the
      // sessions it already loaded, including legacy attachments keyed by Version id.
      return result.sessions
        .filter((session) => session.artifacts?.some((artifact) => artifact.id === artifactId))
        .map(({ id: sessionId, projectId }) => ({ projectId, sessionId }))
    }
    return this.operationScheduler.runGlobal(() =>
      this.projection!.findArtifactSessions(artifactId)
    )
  }

  async loadSessionSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    if (!this.projection || !(await this.projection.isReady())) {
      throw new Error('Session projection is not ready.')
    }
    return this.listProjectionSummaries(signal)
  }

  async loadSessionUsageProjection(): Promise<SessionUsageProjection> {
    if (!this.projection || !(await this.projection.isReady())) {
      throw new Error('Session projection is not ready.')
    }
    return this.operationScheduler.runGlobal(() => this.projection!.usage())
  }

  // Loads one durable session directly instead of scanning every project/session file. Reviewer fix
  // loops call this after each correction turn so every re-review sees newly persisted messages rather
  // than retaining the snapshot that existed when the initial review started.
  async loadSession(
    projectId: string,
    sessionId: string,
    reportReadFailure = false
  ): Promise<PersistedChatSession | undefined> {
    const safeProjectId = assertSafeSegment(projectId)
    if ((await this.inspectActiveProjectBoundary(safeProjectId)) !== 'valid') return undefined
    const safeSessionId = assertSafeSegment(sessionId)
    const read = await this.readSessionFile(
      this.sessionFilePath(safeProjectId, safeSessionId),
      safeProjectId
    )
    if (read.session || !reportReadFailure) return read.session
    if (read.warning && 'projectId' in read.warning)
      throw new ApplicationCommandError(
        `session-file-${read.warning.kind}`,
        'Could not read the conversation file.'
      )
    if (!read.isComplete) return undefined
    const files = await this.listSessionFileNames(this.projectDir(safeProjectId), {
      missingIsIncomplete: true
    })
    const fileName = `${safeSessionId}.json`
    if (!files.isComplete || files.names.includes(fileName)) return undefined
    if (files.quarantinedPrimaryFileNames.includes(fileName))
      throw new ApplicationCommandError('session-file-corrupt', 'Conversation data is damaged.')
    throw new ApplicationCommandError('session-file-missing', 'Conversation file not found.')
  }

  async loadSessionHistoryPage(
    request: LoadSessionHistoryPageRequest,
    reportReadFailure = false
  ): Promise<SessionHistoryPage | undefined> {
    const input = loadSessionHistoryPageRequestSchema.parse(request)
    const projectId = assertSafeSegment(input.projectId)
    const sessionId = assertSafeSegment(input.sessionId)
    if ((await this.inspectActiveProjectBoundary(projectId)) !== 'valid') return undefined
    const completePage = (session: PersistedChatSession): SessionHistoryPage => ({
      projectId,
      sessionId,
      revision: session.revision ?? 0,
      complete: true,
      session,
      hasMore: false,
      totalItems: session.messages.length + (session.activities?.length ?? 0)
    })
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      if (
        (await this.inspectFileBoundary(
          sessionJournalPath(this.sessionFilePath(projectId, sessionId))
        )) === 'missing'
      ) {
        // Old JSON already stores the full conversation. Keep its original read path without
        // creating a display index or rewriting the file just to open it.
        const session = await this.loadSession(projectId, sessionId, reportReadFailure)
        return session ? completePage(session) : undefined
      }
      if (!this.projection) return undefined
      const fingerprint = await this.historySourceFingerprint(projectId, sessionId)
      if (!fingerprint) return undefined
      const page = await this.projection!.history.readPage(input, fingerprint)
      if (
        page &&
        (this.hasLiveRuntimeSession(projectId, sessionId) ||
          ((page.session.status === 'idle' || page.session.status === 'error') &&
            page.session.messages.every((message) => message.status !== 'streaming')))
      )
        return page
      // Missing/stale JSONL indexes are admitted once through the existing full decoder.
      // Subsequent display pages query only their indexed rows.
      const session = await this.loadSession(projectId, sessionId, reportReadFailure)
      if (!session) return undefined
      const currentFingerprint = await this.historySourceFingerprint(projectId, sessionId)
      if (!currentFingerprint || currentFingerprint !== fingerprint)
        throw new SessionJournalCorruptionError('Session changed while building its history index.')
      const graph = session.conversationGraph
      // Keep the existing complete graph for revision/Frame controls. Linear conversations
      // alone can use display pages, which intentionally omit that navigation state.
      if (graph && (graph.frames.length !== 1 || graph.branches.length !== 1))
        return completePage(session)
      await this.projection!.history.sync(session, fingerprint)
      return this.projection!.history.readPage(input, fingerprint)
    })
  }

  private async historySourceFingerprint(
    projectId: string,
    sessionId: string
  ): Promise<string | undefined> {
    // Only JSONL has a paginated display index. Saving a legacy snapshot must not build one.
    const logicalPath = this.sessionFilePath(projectId, sessionId)
    const path = sessionJournalPath(logicalPath)
    if ((await this.inspectFileBoundary(path)) !== 'valid') return undefined
    const file = await lstat(path)
    // Use the same proof as journal.authorityFingerprint so runtime saves can compare their
    // already-read predecessor without another filesystem read. Older derived indexes rebuild.
    return JSON.stringify([
      logicalPath,
      `journal:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`
    ])
  }

  hasLiveRuntimeSession(projectId: string, sessionId: string): boolean {
    return this.dependencies.hasLiveRuntimeSession(projectId, sessionId)
  }

  hasActiveRuntimePrompt(projectId: string, sessionId: string): boolean {
    return this.dependencies.hasActiveRuntimePrompt(projectId, sessionId)
  }

  shouldPreserveRuntimeState(projectId: string, sessionId: string): boolean {
    return (
      this.hasActiveRuntimePrompt(projectId, sessionId) ||
      this.hasLiveRuntimeSession(projectId, sessionId) ||
      this.retainedRuntimeState.has(JSON.stringify([projectId, sessionId]))
    )
  }

  // Decode-only preservation for Main's live release after exhausted writes. This is not evidence
  // of an attached runtime and is never persisted; process restart uses ordinary recovery.
  private readonly retainedRuntimeState = new Set<string>()
  retainRuntimeSessionState(projectId: string, sessionId: string, retained: boolean): void {
    const key = JSON.stringify([projectId, sessionId])
    if (retained) this.retainedRuntimeState.add(key)
    else this.retainedRuntimeState.delete(key)
  }

  // Terminal mutations must distinguish absence from a transient/non-ENOENT read failure. Treating
  // both as undefined could unlink the JSON before Upload cleanup has observed its final authority.
  async loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string,
    options: SessionScanOptions = {}
  ): Promise<SessionLoadDiagnostic> {
    return this.readSessionAuthority(projectId, sessionId, options)
  }

  private async loadSessionSaveAuthority(
    projectId: string,
    sessionId: string,
    includePendingImport: boolean,
    runtimeAuthority?: PersistedChatSession
  ): Promise<SessionLoadDiagnostic> {
    const reusableAuthority =
      !includePendingImport &&
      runtimeAuthority &&
      this.runtimeAuthorityFingerprints.has(runtimeAuthority)
        ? runtimeAuthority
        : undefined
    if (!includePendingImport && !reusableAuthority)
      return loadSessionMutationAuthority(this, projectId, sessionId)
    // The pending import directory hides publication from ordinary readers, not from its
    // serialized writer's CAS. Recovery must compare against already committed physical history.
    return this.readSessionAuthority(
      projectId,
      sessionId,
      { mode: 'read-only', preserveRuntimeState: true },
      includePendingImport,
      reusableAuthority
    )
  }

  private async readSessionAuthority(
    projectId: string,
    sessionId: string,
    options: SessionScanOptions,
    includePendingImport = false,
    runtimeAuthority?: PersistedChatSession
  ): Promise<SessionLoadDiagnostic> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    const projectBoundary = await this.inspectActiveProjectBoundary(
      safeProjectId,
      includePendingImport
    )
    if (projectBoundary === 'invalid') return { status: 'unreadable' }
    if (projectBoundary === 'missing') return { status: 'missing' }
    const read = await this.readSessionFile(
      this.sessionFilePath(safeProjectId, safeSessionId),
      safeProjectId,
      {
        quarantineInvalidFiles: options.mode !== 'read-only',
        preserveRuntimeState: options.preserveRuntimeState,
        runtimeAuthority
      }
    )
    if (!read.isComplete || read.wasQuarantined) return { status: 'unreadable' }

    const quarantine = await this.hasQuarantinedSessionFile(safeProjectId, safeSessionId)
    if (!quarantine.isComplete) return { status: 'unreadable' }
    if (read.session) return { status: 'found', session: read.session }
    return quarantine.exists ? { status: 'unreadable' } : { status: 'missing' }
  }

  // Only a scoped durable recheck may remove stale derived metadata. An unresolved
  // import, temp, quarantine or unreadable body is never evidence of deletion.
  async reconcileMissingSessionProjection(projectId: string, sessionId: string): Promise<boolean> {
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      if (!this.projection || (await isSessionPackagePending(this.storageDir, projectId)))
        return false
      const loaded = await this.loadSessionWithDiagnostics(projectId, sessionId)
      if (loaded.status !== 'missing') return false
      await this.mutateCatalog(() => this.projection!.commitDelete(projectId, sessionId))
      return true
    })
  }

  // Off-lane recovery planning must not use the durable reader: even read-only diagnostics can
  // promote or remove temporary files. Defer that evidence to the guarded commit instead.
  async loadSessionRecoverySnapshot(
    projectIdValue: string,
    sessionIdValue: string
  ): Promise<SessionRecoverySnapshot> {
    const projectId = assertSafeSegment(projectIdValue)
    const sessionId = assertSafeSegment(sessionIdValue)
    const boundary = await this.inspectActiveProjectBoundary(projectId)
    if (boundary !== 'valid') return { status: boundary === 'missing' ? 'missing' : 'unreadable' }
    const fileName = `${sessionId}.json`
    const filePath = this.sessionFilePath(projectId, sessionId)
    const metrics = { sessionBytes: 0, authorityReadMs: 0, jsonParseMs: 0 }
    try {
      const entries = await this.dependencies.readDirectoryEntries(this.projectDir(projectId))
      if (entries.some((entry) => temporarySessionPrimaryName(entry.name) === fileName))
        return { status: 'repair-required' }
      const journalPath = sessionJournalPath(filePath)
      if ((await this.inspectFileBoundary(journalPath)) === 'valid') {
        const readStartedAt = performance.now()
        const current = await this.journal.read(filePath)
        if (!current) return { status: 'repair-required' }
        metrics.authorityReadMs = performance.now() - readStartedAt
        metrics.sessionBytes = current.storageBytes
        const decoded = this.decodeSessionDocument(
          filePath,
          projectId,
          current.document,
          current.storageBytes
        )
        return { status: 'found', session: decoded.session, metrics }
      }
      const before = await lstat(filePath)
      if (!before.isFile() || before.isSymbolicLink()) return { status: 'unreadable' }
      const readStartedAt = performance.now()
      let contents: string
      try {
        contents = await this.dependencies.readSessionFileWithinLimit(
          filePath,
          this.dependencies.maxSessionBytes
        )
      } finally {
        metrics.authorityReadMs = performance.now() - readStartedAt
      }
      const after = await lstat(filePath)
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return { status: 'repair-required' }
      const decoded = this.decodeSessionContents(filePath, projectId, contents, undefined, metrics)
      metrics.sessionBytes = decoded.bytes
      return { status: 'found', session: decoded.session, metrics }
    } catch {
      // Missing, malformed, or changing authority may have temp/quarantine evidence. Only the
      // guarded diagnostic reader can classify and repair it; never infer absence here.
      return { status: 'repair-required' }
    }
  }

  // Verifies durable Session identity from directory/file authority without parsing JSON. This lets
  // an incomplete hydration catalog distinguish a corrupt Session file from a genuinely unused id.
  async assertSessionIdentityOwnership(
    sessionIdValue: string,
    expectedProjectIdValue: string
  ): Promise<void> {
    const sessionId = assertSafeSegment(sessionIdValue)
    const expectedProjectId = assertSafeSegment(expectedProjectIdValue)
    const ownership = await this.readSessionIdentityOwners(sessionId)
    if (!ownership.isComplete)
      throw new Error('Cannot save a Session while its global identity ownership is unreadable.')
    if (ownership.projectIds.some((projectId) => projectId !== expectedProjectId))
      throw new Error('Cannot save a Session id that is already owned by another Project.')
  }

  // Lookups can rebuild the same file that independent project writers maintain.
  private withSessionLocator<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionLocatorTail.then(operation)
    this.sessionLocatorTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async locateSession(sessionIdValue: string): Promise<SessionLocation | undefined> {
    const sessionId = assertSafeSegment(sessionIdValue)
    return this.withSessionLocator(() => this.locateSessionLocked(sessionId))
  }

  private async locateSessionLocked(sessionId: string): Promise<SessionLocation | undefined> {
    let locator = await this.ensureSessionLocator()
    let entry = locator.entries.find((candidate) => candidate.sessionId === sessionId)
    if (!entry && !this.sessionLocatorRemovedSessionIds.has(sessionId)) {
      const ownership = await this.readSessionIdentityOwners(sessionId)
      if (
        ownership.isComplete &&
        ownership.projectIds.length === 1 &&
        (await isSessionPackagePending(this.storageDir, ownership.projectIds[0]))
      )
        return undefined
      if (ownership.isComplete && !ownership.projectIds.length) return undefined
      locator = await this.rebuildSessionLocator('missing-entry')
      entry = locator.entries.find((candidate) => candidate.sessionId === sessionId)
    }
    if (!entry) return undefined

    const expectedPath = this.sessionStoragePath(entry.projectId, entry.sessionId)
    if (
      entry.storagePath !== expectedPath ||
      !(await this.hasSessionAuthorityFile(entry.projectId, entry.sessionId))
    ) {
      locator = await this.rebuildSessionLocator('stale')
      entry = locator.entries.find((candidate) => candidate.sessionId === sessionId)
    }
    if (entry && (await isSessionPackagePending(this.storageDir, entry.projectId))) return undefined
    return entry
  }

  private sessionStoragePath(projectId: string, sessionId: string): string {
    return `${SESSIONS_DIR}/${assertSafeSegment(projectId)}/${assertSafeSegment(sessionId)}.json`
  }

  private async hasSessionAuthorityFile(projectId: string, sessionId: string): Promise<boolean> {
    const logicalPath = this.sessionFilePath(projectId, sessionId)
    return (
      (await this.inspectFileBoundary(logicalPath)) === 'valid' ||
      (await this.inspectFileBoundary(sessionJournalPath(logicalPath))) === 'valid'
    )
  }

  private async readSessionLocatorFile(): Promise<SessionLocatorDocument | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.sessionLocatorPath, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const document = parsed as Record<string, unknown>
      if (document.version !== 1 || !Array.isArray(document.entries)) return undefined
      const entries = document.entries.flatMap((entry): SessionLocation[] => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
        const value = entry as Record<string, unknown>
        if (
          typeof value.sessionId !== 'string' ||
          typeof value.projectId !== 'string' ||
          typeof value.storagePath !== 'string'
        )
          return []
        try {
          const sessionId = assertSafeSegment(value.sessionId)
          const projectId = assertSafeSegment(value.projectId)
          const storagePath = this.sessionStoragePath(projectId, sessionId)
          if (value.storagePath !== storagePath) return []
          return [{ sessionId, projectId, storagePath }]
        } catch {
          return []
        }
      })
      if (entries.length !== document.entries.length) return undefined
      if (new Set(entries.map(({ sessionId }) => sessionId)).size !== entries.length)
        return undefined
      return { version: 1, entries }
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      return undefined
    }
  }

  private async ensureSessionLocator(): Promise<SessionLocatorDocument> {
    if (this.sessionLocator) return this.sessionLocator
    const loaded = await this.readSessionLocatorFile()
    if (loaded) {
      this.sessionLocator = loaded
      return loaded
    }
    if ((await this.inspectDirectoryBoundary(this.sessionsDir)) === 'missing') {
      const empty = { version: 1 as const, entries: [] }
      this.sessionLocator = empty
      return empty
    }
    return this.rebuildSessionLocator('missing-or-invalid')
  }

  private async rebuildSessionLocator(
    reason: 'missing-or-invalid' | 'missing-entry' | 'stale'
  ): Promise<SessionLocatorDocument> {
    try {
      const scan = await this.scanSessionIdentities()
      if (!scan.isComplete) {
        throw new Error('Session locator rebuild requires a complete Session identity scan.')
      }
      const document: SessionLocatorDocument = {
        version: 1,
        entries: scan.sessions
          .map(({ projectId, id: sessionId }) => ({
            sessionId,
            projectId,
            storagePath: this.sessionStoragePath(projectId, sessionId)
          }))
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      }
      await this.atomicWrite(this.sessionLocatorPath, document)
      this.sessionLocator = document
      try {
        createLogger('session-persistence').info('Session locator rebuilt', {
          operation: 'session-locator-rebuild',
          reason,
          entryCount: document.entries.length
        })
      } catch {
        // Diagnostics must not affect locator durability.
      }
      return document
    } catch (error) {
      try {
        createLogger('session-persistence').warn('Session locator rebuild deferred', {
          operation: 'session-locator-rebuild',
          reason,
          outcome: 'deferred',
          ...diagnosticErrorFields(error)
        })
      } catch {
        // Diagnostics must not affect Session authority.
      }
      throw error
    }
  }

  private async maintainSessionLocator(
    operation: (document: SessionLocatorDocument) => SessionLocatorDocument
  ): Promise<void> {
    await this.withSessionLocator(async () => {
      try {
        const current = await this.ensureSessionLocator()
        const next = operation(current)
        if (current === next) return
        await this.atomicWrite(this.sessionLocatorPath, next)
        this.sessionLocator = next
      } catch (error) {
        this.sessionLocator = undefined
        try {
          createLogger('session-persistence').warn('Session locator maintenance degraded', {
            operation: 'session-locator-maintenance',
            outcome: 'degraded',
            ...diagnosticErrorFields(error)
          })
        } catch {
          // Diagnostics must not affect Session authority.
        }
      }
    })
  }

  private async upsertSessionLocator(
    session: Pick<PersistedChatSession, 'id' | 'projectId'>
  ): Promise<void> {
    this.sessionLocatorRemovedSessionIds.delete(session.id)
    await this.maintainSessionLocator((document) => {
      const existing = document.entries.find((entry) => entry.sessionId === session.id)
      if (existing?.projectId === session.projectId) return document
      return {
        version: 1,
        entries: [
          ...document.entries.filter((entry) => entry.sessionId !== session.id),
          {
            sessionId: session.id,
            projectId: session.projectId,
            storagePath: this.sessionStoragePath(session.projectId, session.id)
          }
        ].sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      }
    })
  }

  private async removeSessionLocator(sessionId: string): Promise<void> {
    this.sessionLocatorRemovedSessionIds.add(sessionId)
    await this.maintainSessionLocator((document) => ({
      version: 1,
      entries: document.entries.filter((entry) => entry.sessionId !== sessionId)
    }))
  }

  private async removeProjectSessionLocators(projectId: string): Promise<void> {
    await this.maintainSessionLocator((document) => ({
      version: 1,
      entries: document.entries.filter((entry) => {
        if (entry.projectId === projectId) this.sessionLocatorRemovedSessionIds.add(entry.sessionId)
        return entry.projectId !== projectId
      })
    }))
  }

  // Complete identity evidence only: never parse, promote, or quarantine conversation bodies here.
  async scanSessionIdentities(): Promise<SessionIdentityCatalog> {
    const generation = this.catalogGeneration
    const mutationsAtStart = this.activeCatalogMutations
    const rootBefore = await this.catalogDirectoryStamp(this.sessionsDir)
    const deletionBefore = await this.catalogDirectoryStamp(this.deletedSessionsDir)
    const directories = await this.listDirectoryNames(this.sessionsDir, {
      missingIsIncomplete: rootBefore !== 'missing'
    })
    const sessions: SessionIdentityCatalog['sessions'] = []
    let isComplete =
      directories.isComplete && rootBefore !== undefined && deletionBefore !== undefined
    const owners = new Map<string, string>()
    const memberships = new Map<string, Set<string>>()
    if (deletionBefore !== 'missing') {
      try {
        if ((await this.dependencies.readDirectoryEntries(this.deletedSessionsDir)).length > 0)
          isComplete = false
      } catch {
        isComplete = false
      }
    }
    for (const candidate of directories.names) {
      try {
        const projectId = assertSafeSegment(candidate)
        const path = this.projectDir(projectId)
        const before = await this.catalogDirectoryStamp(path)
        const files = await this.listSessionFileNames(path, { missingIsIncomplete: true })
        isComplete &&=
          files.isComplete &&
          !files.hasRecoveryEvidence &&
          before !== undefined &&
          before !== 'missing'
        if (await isSessionPackagePending(this.storageDir, projectId)) isComplete = false
        if (
          (await this.inspectFileBoundary(join(path, PROJECT_DELETION_COMMIT_MARKER))) !== 'missing'
        )
          isComplete = false
        if ((await this.getProjectSessionDeletionState(projectId)) !== 'live') isComplete = false
        const membership = new Set([...files.names, ...files.quarantinedPrimaryFileNames])
        memberships.set(path, membership)
        for (const name of membership) {
          const id = assertSafeSegment(name.slice(0, -'.json'.length))
          if (owners.has(id) && owners.get(id) !== projectId) isComplete = false
          owners.set(id, projectId)
          sessions.push({ projectId, id })
        }
        if (before !== (await this.catalogDirectoryStamp(path))) isComplete = false
      } catch {
        isComplete = false
      }
    }
    // Directory timestamps can miss rapid membership changes on Windows.
    if (isComplete) {
      const current = await this.listDirectoryNames(this.sessionsDir, {
        missingIsIncomplete: rootBefore !== 'missing'
      })
      const original = new Set(directories.names)
      isComplete =
        current.isComplete &&
        current.names.length === original.size &&
        current.names.every((name) => original.has(name))
      for (const [path, membership] of memberships) {
        const files = await this.listSessionFileNames(path, { missingIsIncomplete: true })
        const current = new Set([...files.names, ...files.quarantinedPrimaryFileNames])
        isComplete &&=
          files.isComplete &&
          !files.hasRecoveryEvidence &&
          current.size === membership.size &&
          [...current].every((name) => membership.has(name))
      }
      if (deletionBefore === 'missing') {
        isComplete &&= (await this.catalogDirectoryStamp(this.deletedSessionsDir)) === 'missing'
      } else {
        try {
          if ((await this.dependencies.readDirectoryEntries(this.deletedSessionsDir)).length > 0)
            isComplete = false
        } catch {
          isComplete = false
        }
      }
    }
    if (
      rootBefore !== (await this.catalogDirectoryStamp(this.sessionsDir)) ||
      deletionBefore !== (await this.catalogDirectoryStamp(this.deletedSessionsDir))
    )
      isComplete = false
    isComplete &&=
      mutationsAtStart === 0 &&
      this.activeCatalogMutations === 0 &&
      generation === this.catalogGeneration
    return { sessions, isComplete, generation }
  }

  private async catalogDirectoryStamp(path: string): Promise<string | undefined> {
    try {
      const stat = await lstat(path)
      return stat.isDirectory() && !stat.isSymbolicLink()
        ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
        : undefined
    } catch (error) {
      return isMissingFileError(error) ? 'missing' : undefined
    }
  }

  private async readSessionIdentityOwners(
    sessionId: string
  ): Promise<{ projectIds: string[]; isComplete: boolean }> {
    const fileName = `${sessionId}.json`
    const directories = await this.listDirectoryNames(this.sessionsDir)
    let isComplete = directories.isComplete
    const projectIds: string[] = []
    for (const candidate of directories.names) {
      let projectId: string
      try {
        projectId = assertSafeSegment(candidate)
      } catch {
        isComplete = false
        continue
      }
      const files = await this.listSessionFileNames(join(this.sessionsDir, projectId), {
        missingIsIncomplete: true
      })
      isComplete &&= files.isComplete
      if (files.names.includes(fileName) || files.quarantinedPrimaryFileNames.includes(fileName))
        projectIds.push(projectId)
    }
    return { projectIds, isComplete }
  }

  // Policy reads never hydrate, quarantine, repair, or mutate Session/projection state.
  async loadComputePolicy(
    projectIdValue: string | undefined,
    sessionIdValue: string
  ): Promise<SessionComputePolicy> {
    try {
      const sessionId = assertSafeSegment(sessionIdValue)
      const ownership = await this.readSessionIdentityOwners(sessionId)
      if (!ownership.isComplete) return { status: 'blocked', reason: 'unavailable' }
      const projectId =
        projectIdValue === undefined ? ownership.projectIds[0] : assertSafeSegment(projectIdValue)
      if (!projectId) return { status: 'blocked', reason: 'missing' }
      if (ownership.projectIds.some((owner) => owner !== projectId))
        return { status: 'blocked', reason: 'identity-conflict' }
      const deletion = await this.getProjectSessionDeletionState(projectId)
      if (deletion !== 'live' && deletion !== 'absent')
        return { status: 'blocked', reason: 'deleted' }
      if ((await this.inspectActiveProjectBoundary(projectId)) !== 'valid')
        return { status: 'blocked', reason: 'unavailable' }
      const path = this.sessionFilePath(projectId, sessionId)
      const current = await this.journal.read(path)
      if (!current) return { status: 'blocked', reason: 'missing' }
      const document = current.document
      return decodeSessionComputePolicy(document, sessionId)
    } catch {
      return { status: 'blocked', reason: 'unavailable' }
    }
  }

  // Reports whether the live sessions tree was fully scanned so DB reconciliation never acts on a
  // partial read. Project recovery owns tombstone cleanup before ordinary hydration is allowed.
  async loadAllWithDiagnostics(options: SessionScanOptions = {}): Promise<SessionLoadDiagnostics> {
    const quarantineInvalidFiles = options.mode !== 'read-only'
    const scanMetrics: SessionScanMetrics = {
      projectDirectoryCount: 0,
      sessionFileCount: 0,
      sessionBytes: 0,
      authorityReadMs: 0,
      jsonParseMs: 0
    }
    const { sessions, isComplete, warnings } = await this.readAllSessions({
      quarantineInvalidFiles,
      quarantinedIsIncomplete: options.quarantinedIsIncomplete,
      scanMetrics
    })
    const projectIdsBySessionId = new Map<string, Set<string>>()
    const recordIdentityOwner = (sessionId: string, projectId: string): void => {
      const projectIds = projectIdsBySessionId.get(sessionId) ?? new Set<string>()
      projectIds.add(projectId)
      projectIdsBySessionId.set(sessionId, projectIds)
    }
    for (const session of sessions) recordIdentityOwner(session.id, session.projectId)
    for (const warning of warnings) {
      if (!('projectId' in warning) || !warning.fileName.endsWith('.json')) continue
      recordIdentityOwner(warning.fileName.slice(0, -'.json'.length), warning.projectId)
    }
    const duplicateSessionIds = new Set(
      [...projectIdsBySessionId].filter(([, projectIds]) => projectIds.size > 1).map(([id]) => id)
    )
    const globallyIdentifiedSessions = sessions.filter(
      (session) => !duplicateSessionIds.has(session.id)
    )
    const warnedIdentityFiles = new Set(
      warnings.flatMap((warning) =>
        'projectId' in warning ? [`${warning.projectId}\0${warning.fileName}`] : []
      )
    )
    const identityWarnings: SessionLoadWarning[] = []
    for (const sessionId of duplicateSessionIds) {
      for (const projectId of projectIdsBySessionId.get(sessionId) ?? []) {
        const fileName = `${sessionId}.json`
        if (warnedIdentityFiles.has(`${projectId}\0${fileName}`)) continue
        identityWarnings.push({
          kind: 'unreadable',
          projectId,
          fileName,
          recovered: false
        })
      }
    }
    const manifestRead = await this.readManifest({ quarantineInvalidFiles })

    return {
      result: { sessions: globallyIdentifiedSessions, manifest: manifestRead.manifest },
      // The manifest is only a last-open pointer. It must never make a complete Session authority
      // scan read-only; a later selection write will retry persistence through the normal saver.
      isComplete: isComplete && duplicateSessionIds.size === 0,
      warnings: manifestRead.warning
        ? [...warnings, ...identityWarnings, manifestRead.warning]
        : [...warnings, ...identityWarnings],
      scanMetrics
    }
  }

  // Project deletion needs a complete view of only its target authority. An unrelated unreadable
  // Project must not block deletion, while any target-directory failure remains fail-closed.
  async loadProjectWithDiagnostics(
    projectId: string,
    options: SessionScanOptions = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    return this.readProjectSessions(assertSafeSegment(projectId), {
      quarantinedIsIncomplete: true,
      quarantineInvalidFiles: options.mode !== 'read-only'
    })
  }

  async loadCommittedProjectWithDiagnostics(
    projectId: string
  ): Promise<ProjectSessionLoadDiagnostics> {
    const safeProjectId = assertSafeSegment(projectId)
    const deletedSessionsBoundary = await this.inspectDirectoryBoundary(this.deletedSessionsDir)
    if (deletedSessionsBoundary !== 'valid') {
      return { sessions: [], isComplete: deletedSessionsBoundary === 'missing' }
    }
    return this.readProjectSessionsAtDirectory(
      safeProjectId,
      this.deletedProjectDir(safeProjectId),
      {
        quarantinedIsIncomplete: true
      }
    )
  }

  // Compares and advances whole-Session authority inside the same Project/Session lane as the atomic
  // replacement. Callers that own a stale renderer projection pass expectedRevision; trusted Main
  // mutations omit it after loading within the coordinator's matching Session lane.
  async saveSession(
    session: PersistedChatSession,
    expectedRevision?: number,
    options: MainSessionSaveOptions = {}
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(session.projectId, session.id, () =>
      this.saveSessionNow(session, expectedRevision, false, options)
    )
  }

  // Recovery holds the same identity/CAS protection without serializing unrelated Project saves.
  async saveRecoveredSession(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSessionRecovery(session.projectId, session.id, () =>
      this.saveSessionNow(session, expectedRevision, false)
    )
  }

  // Startup-only repair: never rename graph identities underneath an attached runtime. The backup
  // and revisioned replacement share the normal repository lane, so a retry cannot overwrite a
  // newer Session or lose the original bytes after an interrupted repair.
  async saveSessionWithBindingRepair(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSessionRecovery(session.projectId, session.id, async () => {
      if (
        this.dependencies.hasLiveRuntimeSession(session.projectId, session.id) ||
        this.dependencies.hasActiveRuntimePrompt(session.projectId, session.id)
      ) {
        throw new Error('Cannot repair Session graph bindings while its runtime is attached.')
      }
      return this.saveSessionNow(session, expectedRevision, true)
    })
  }

  private async saveSessionNow(
    session: PersistedChatSession,
    expectedRevision?: number,
    preserveBindingBackup = false,
    options: MainSessionSaveOptions = {}
  ): Promise<PersistedChatSession> {
    // Reject an exhausted caller revision even when importing into a missing authority. A stale
    // in-memory high-water mark is never used as the durable journal's base revision.
    nextSessionRevision(sessionRevision(session))
    // Imported IDs keep the readonly authority check off ordinary Session save hot paths,
    // including when imported history belongs to an existing Project.
    const pendingImport = await isSessionPackagePending(
      this.storageDir,
      assertSafeSegment(session.projectId)
    )
    const importedAuthority =
      session.id.startsWith('import-') || session.projectId.startsWith('import-')
        ? await this.loadSessionSaveAuthority(
            session.projectId,
            session.id,
            pendingImport,
            options.runtimeChanges?.previous
          )
        : undefined
    if (importedAuthority?.status === 'unreadable')
      throw new Error('Cannot modify unreadable imported research history.')
    if (importedAuthority?.status === 'found')
      session = preserveImportedSession(
        importedAuthority.session,
        pendingImport
          ? {
              ...session,
              // Projection assigns this local number on first publication. A retained import
              // stage predates that assignment; recovery keeps the authoritative number.
              number: importedAuthority.session.number
            }
          : session
      )
    const key = `${session.projectId}:${session.id}`
    let actualRevision = 0
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new Error('Session expected revision must be a non-negative integer.')
    }
    const hadPrimaryAuthority = await this.assertExistingSessionWithinLimit(
      this.sessionFilePath(session.projectId, session.id)
    )
    {
      // Both checks own the same serialized save lane. Reuse this operation's authority read;
      // the next save must load again so revision and readonly checks never use a stale cache.
      const current =
        importedAuthority ??
        (await this.loadSessionSaveAuthority(
          session.projectId,
          session.id,
          pendingImport,
          options.runtimeChanges?.previous
        ))
      if (current.status === 'unreadable') {
        throw new Error('Cannot compare Session revision because durable JSON is unreadable.')
      }
      actualRevision = current.status === 'found' ? sessionRevision(current.session) : 0
      if (expectedRevision !== undefined && actualRevision !== expectedRevision) {
        throw new SessionRevisionConflictError(expectedRevision, actualRevision)
      }
    }
    if (preserveBindingBackup) {
      await this.preserveArtifactBindingBackup(this.sessionFilePath(session.projectId, session.id))
    }
    const nextRevision = nextSessionRevision(actualRevision)

    const unprojectedDurableSession: PersistedChatSession = {
      ...session,
      revision: nextRevision
    }
    const projectionWillAssignNumber = Boolean(
      this.projection && !this.projectionWritesSuspended && session.number === undefined
    )
    // Admission must precede prepareSave because that call reserves projection metadata. A new
    // Session is measured with the largest possible assigned number, so the final payload cannot
    // cross the limit when projection allocation adds that field.
    const filePath = this.sessionFilePath(session.projectId, session.id)
    const legacyJson =
      (await this.inspectFileBoundary(sessionJournalPath(filePath))) === 'missing' &&
      (await this.inspectFileBoundary(filePath)) === 'valid'
    // Legacy authority was already read and decoded above. Reuse the released JSON writer;
    // reading it again through JournalStore would parse, freeze and measure all history again.
    const previousWriteAuthority = legacyJson ? undefined : await this.journal.read(filePath)
    if (!legacyJson && (previousWriteAuthority?.revision ?? 0) !== actualRevision)
      throw new SessionRevisionConflictError(actualRevision, previousWriteAuthority?.revision ?? 0)
    const unprojectedWrite = this.prepareSessionWrite(
      projectionWillAssignNumber
        ? { ...unprojectedDurableSession, number: Number.MAX_SAFE_INTEGER }
        : unprojectedDurableSession,
      previousWriteAuthority,
      options.runtimeChanges,
      legacyJson
    )

    if (this.projection && this.projectionWritesSuspended) {
      assertSessionProjectionStorageShape(session)
    }
    const preparedProjection =
      this.projection && !this.projectionWritesSuspended
        ? await this.projection.prepareSave(session)
        : undefined
    const durableSession: PersistedChatSession = {
      ...(preparedProjection?.session ?? session),
      revision: nextRevision
    }
    // prepareSave only assigns the authoritative number. Reuse the normalized graph instead
    // of materializing it again; retain the final byte check before writing authority.
    try {
      let preparedWrite = unprojectedWrite
      if (unprojectedWrite.document.session.number !== durableSession.number) {
        const numberedDocument = {
          ...unprojectedWrite.document,
          session: { ...unprojectedWrite.document.session, number: durableSession.number }
        }
        const document = legacyJson
          ? numberedDocument
          : (normalizeJournalValue(numberedDocument) as unknown as ReturnType<
              typeof createSessionFile
            >)
        preparedWrite = {
          ...unprojectedWrite,
          document,
          contents: legacyJson
            ? this.serializeJsonForWrite(document, this.dependencies.maxSessionBytes)
            : undefined,
          // Allocation changed the admitted document. The ordinary write path derives a fresh
          // checked batch rather than publishing the preparation for the provisional number.
          journalWrite: undefined
        }
        if (!legacyJson) this.assertDocumentWithinLimit(document)
      }
      await this.writeSession(durableSession, preparedWrite)
    } catch (error) {
      if (preparedProjection?.created && !hadPrimaryAuthority) {
        try {
          if (await this.hasNoSessionAuthorityFiles(session.projectId, session.id)) {
            await this.projection!.abortUnpublishedSave(preparedProjection)
          }
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            'Session publication and allocation cleanup failed.',
            { cause: error }
          )
        }
      }
      throw error
    }
    await this.upsertSessionLocator(durableSession)
    // Only a completed durable publication (atomic JSON replacement or fsynced JSONL append)
    // proves a transcript durable. Catalog projection still runs in this lane before the next
    // write can enter.
    try {
      options.onJsonCommitted?.(durableSession)
    } catch (error) {
      createLogger('session-persistence').warn(
        'Session JSON commit observer failed',
        diagnosticErrorFields(error)
      )
    }
    if (this.projectionWritesSuspended) {
      this.suspendedProjectionSessionWrites.set(key, {
        projectId: session.projectId,
        sessionId: session.id
      })
    } else {
      try {
        const sourceFingerprint =
          this.projection && !legacyJson
            ? await this.historySourceFingerprint(session.projectId, session.id)
            : undefined
        await this.projection?.commitSave(
          durableSession,
          preparedProjection,
          sourceFingerprint
            ? {
                sourceFingerprint,
                changes: unprojectedWrite.runtimeChanges,
                previousSourceFingerprint: unprojectedWrite.runtimeSourceFingerprint
              }
            : undefined
        )
      } catch (error) {
        createLogger('session-persistence').error('derived catalog commit failed', {
          ...diagnosticErrorFields(error)
        })
        this.sessionRevisions.set(key, durableSession.revision!)
        throw new SessionProjectionAfterCommitError(durableSession, error)
      }
    }
    this.sessionRevisions.set(key, durableSession.revision!)
    return durableSession
  }

  async saveCommittedProjectSession(session: PersistedChatSession): Promise<void> {
    return this.operationScheduler.runSession(session.projectId, session.id, async () => {
      if ((await this.getProjectSessionDeletionState(session.projectId)) !== 'legacy-committed') {
        throw new Error('Cannot save a Session outside committed Project deletion authority.')
      }
      await this.ensureDirectoryBoundary(this.deletedSessionsDir, 'Deleted Session root')
      const key = `${session.projectId}:${session.id}`
      const authority = await this.journal.read(
        join(this.deletedProjectDir(session.projectId), `${assertSafeSegment(session.id)}.json`)
      )
      const durableSession: PersistedChatSession = {
        ...session,
        revision: nextSessionRevision(authority?.revision ?? 0)
      }
      await this.writeSessionToDirectory(
        durableSession,
        this.deletedProjectDir(session.projectId),
        this.prepareSessionWrite(
          durableSession,
          undefined,
          undefined,
          authority?.format === 'legacy'
        )
      )
      if (this.projectionWritesSuspended) this.suspendedProjectionCatalogMutation = true
      this.sessionRevisions.set(key, durableSession.revision!)
    })
  }

  // Removes a single session file.
  async deletedSessionScopes(): Promise<Map<string, boolean>> {
    return this.projection?.deletedSessionScopes() ?? new Map()
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.deleteSessionNow(projectId, sessionId)
    )
  }

  // Package recovery calls this only for a validated historical deletion intent.
  async recoverDeletedDiscussionChildren(projectId: string, sessionId: string): Promise<void> {
    if (!sessionId.startsWith('import-') || !this.projection) return
    await this.operationScheduler.runProject(projectId, async () => {
      if (await this.projection!.isDeleted(projectId, sessionId))
        await this.retryDeletedDiscussionChildren(projectId, sessionId)
    })
  }

  private async retryDeletedDiscussionChildren(
    projectId: string,
    sessionId: string
  ): Promise<void> {
    // After the tombstone commits a retry owns only the children, never a restored parent file.
    const parent = await this.loadSessionWithDiagnostics(projectId, sessionId, {
      mode: 'read-only'
    })
    if (parent.status !== 'missing') return
    if (await this.detachDiscussionChildren(projectId, sessionId)) {
      await this.projection!.clearPendingDelete(projectId, sessionId)
    } else {
      await this.projection!.markPending(projectId, sessionId, 'delete')
    }
  }

  // Caller holds the repository's project lane (or startup's global barrier). Keep the
  // parent's pending delete until every child file and summary has committed, so crash
  // recovery retries the remaining children without inferring deletion from absence.
  private async detachDiscussionChildren(projectId: string, parentId: string): Promise<boolean> {
    if (!parentId.startsWith('import-')) return true
    let candidates: Array<{ id: string; indexedChild: boolean }>
    if (this.projection && (await this.projection.isInitialized())) {
      candidates = await this.projection.discussionChildCandidates(projectId, parentId)
    } else {
      const catalog = await this.loadProjectWithDiagnostics(projectId, { mode: 'read-only' })
      if (!catalog.isComplete)
        throw new Error('Cannot verify the child discussions in this Project.')
      candidates = catalog.sessions
        .filter((session) => session.parentSessionId === parentId)
        .map(({ id }) => ({ id, indexedChild: true }))
    }
    let allCandidatesReadable = true
    for (const { id, indexedChild } of candidates) {
      const loaded = await this.loadSessionWithDiagnostics(projectId, id, {
        mode: 'read-only',
        preserveRuntimeState: true
      })
      if (loaded.status === 'unreadable') {
        if (indexedChild) throw new Error('Cannot detach an unreadable discussion.')
        allCandidatesReadable = false
        continue
      }
      if (loaded.status !== 'found' || loaded.session.parentSessionId !== parentId) continue
      const child = loaded.session
      await this.saveSessionNow(
        {
          ...child,
          parentSessionId: undefined,
          deletedDiscussionSourceId: parentId,
          ...(child.runtimeContext?.sessionContext
            ? {
                runtimeContext: {
                  ...child.runtimeContext,
                  sessionContext: undefined,
                  revision: child.runtimeContext.revision + 1
                }
              }
            : {})
        },
        sessionRevision(child)
      )
    }
    return allCandidatesReadable
  }

  private async deleteSessionNow(projectId: string, sessionId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    const diagnostic = await this.loadSessionWithDiagnostics(safeProjectId, safeSessionId)
    if (diagnostic.status === 'unreadable') {
      throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
    }
    await this.removeBindingRepairBackups(safeProjectId, safeSessionId)
    const revisionKey = `${safeProjectId}:${safeSessionId}`
    if (!this.projectionWritesSuspended) {
      await this.projection?.markPending(safeProjectId, safeSessionId, 'delete')
    }

    if (diagnostic.status === 'found') {
      // The valid primary proves matching temps/quarantines are authority covered by this
      // explicit Session deletion. Remove every candidate first so any failure leaves that proof in
      // place and the operation safely retryable; only then remove the current primary.
      const primaryPath = this.sessionFilePath(safeProjectId, safeSessionId)
      // Validate owned files before cleanup; the live primary is always removed last.
      const authorityFiles = await this.journal.inspectStorage(primaryPath)
      const livePrimary = authorityFiles.paths.includes(sessionJournalPath(primaryPath))
        ? sessionJournalPath(primaryPath)
        : primaryPath
      const entries = await this.dependencies.readDirectoryEntries(this.projectDir(safeProjectId))
      for (const entry of entries) {
        if (entry.isFile() && temporarySessionPrimaryName(entry.name) === basename(primaryPath)) {
          await this.dependencies.remove(join(this.projectDir(safeProjectId), entry.name), {
            force: true,
            recursive: false
          })
        }
      }
      for (const suffix of [PRE_S2_BACKUP_SUFFIX, PRE_SUBAGENT_MODEL_BACKUP_SUFFIX]) {
        await this.dependencies.remove(`${primaryPath}${suffix}`, {
          force: true,
          recursive: false
        })
      }
      const quarantines = await this.listQuarantinedSessionFiles(safeProjectId, safeSessionId)
      if (!quarantines.isComplete) {
        throw new Error('Cannot delete a Session whose quarantine directory is unreadable.')
      }
      for (const fileName of quarantines.names) {
        await this.dependencies.remove(join(this.projectDir(safeProjectId), fileName), {
          force: true,
          recursive: false
        })
      }
      // The sole live JSONL is sufficient for recovery until its final unlink. Remove retained
      // legacy files first, so an interrupted cleanup always leaves readable authority.
      for (const file of authorityFiles.paths) {
        if (file !== livePrimary)
          await this.dependencies.remove(file, { force: true, recursive: false })
      }
      await this.dependencies.remove(livePrimary, { force: true, recursive: false })
      this.journal.invalidate(primaryPath)
      try {
        await defaultFileDurability.syncDirectory(dirname(primaryPath))
      } catch (error) {
        throw new SessionDeletionCommittedError(error)
      }
    }
    this.sessionRevisions.delete(revisionKey)
    await this.removeSessionLocator(safeSessionId)
    try {
      const detached = await this.detachDiscussionChildren(safeProjectId, safeSessionId)
      if (this.projectionWritesSuspended) {
        this.suspendedProjectionSessionWrites.set(revisionKey, {
          projectId: safeProjectId,
          sessionId: safeSessionId
        })
      } else {
        await this.projection?.commitDelete(safeProjectId, safeSessionId, {
          retainDeleteIntent: !detached
        })
      }
    } catch (cause) {
      throw new SessionDeletionCommittedError(cause)
    }
  }

  private async removeBindingRepairBackups(projectId: string, sessionId: string): Promise<void> {
    const boundary = await this.inspectActiveProjectBoundary(projectId)
    if (boundary === 'missing') return
    if (boundary !== 'valid')
      throw new Error('Session Project directory is not a regular directory.')
    const directory = this.projectDir(projectId)
    const prefix = `${sessionId}.json.pre-artifact-binding-`
    const entries = await this.dependencies.readDirectoryEntries(directory)
    for (const entry of entries) {
      if (
        !entry.name.startsWith(prefix) ||
        !/^[a-f0-9]{64}\.backup$/.test(entry.name.slice(prefix.length))
      ) {
        continue
      }
      const path = join(directory, entry.name)
      await this.assertFileBoundary(path, 'Session binding repair backup')
      await this.dependencies.remove(path, { force: true, recursive: false })
    }
  }

  // Atomically moves a marked live directory into the durable deletion area. The marker/tombstone is
  // retained until Project deletion finishes so recovery can distinguish a committed Session phase
  // from an attempt that failed before the rename, including for Projects with no Session files.
  async deleteProjectSessions(projectId: string): Promise<void> {
    return this.operationScheduler.runProject(projectId, async () => {
      const safeProjectId = assertSafeSegment(projectId)
      const state = await this.getProjectSessionDeletionState(safeProjectId)
      if (state === 'legacy-committed' || state === 'prepared') return
      await this.ensureDirectoryBoundary(this.deletedSessionsDir, 'Deleted Session root')

      const liveProjectDir = this.projectDir(safeProjectId)
      const deletedProjectDir = this.deletedProjectDir(safeProjectId)
      await this.dependencies.remove(deletedProjectDir, { recursive: true, force: true })
      await mkdir(liveProjectDir, { recursive: true })
      await this.mutateCatalog(() =>
        writeFile(join(liveProjectDir, PROJECT_DELETION_COMMIT_MARKER), '', 'utf8')
      )
      await this.dependencies.renameFile(liveProjectDir, deletedProjectDir)
      await this.removeProjectSessionLocators(safeProjectId)
      if (this.projectionWritesSuspended) this.suspendedProjectionCatalogMutation = true
    })
  }

  async getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    const safeProjectId = assertSafeSegment(projectId)
    if ((await this.inspectDirectoryBoundary(this.deletedSessionsDir)) === 'invalid') {
      throw new Error('Deleted Session root is not a regular directory.')
    }
    const deletedProjectDir = this.deletedProjectDir(safeProjectId)
    const liveProjectDir = this.projectDir(safeProjectId)
    const markerPath = join(deletedProjectDir, PROJECT_DELETION_COMMIT_MARKER)

    try {
      const tombstone = await lstat(deletedProjectDir)
      if (!tombstone.isDirectory() || tombstone.isSymbolicLink()) {
        throw new Error(`Project Session deletion tombstone is invalid: ${projectId}`)
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          const live = await lstat(liveProjectDir)
          if (!live.isDirectory() || live.isSymbolicLink()) {
            throw new Error(`Project Session live authority is invalid: ${projectId}`)
          }
          return 'live'
        } catch (liveError) {
          if (isMissingFileError(liveError)) return 'absent'
          throw liveError
        }
      }
      throw error
    }

    let isPrepared = false
    try {
      const marker = await lstat(markerPath)
      if (!marker.isFile() || marker.isSymbolicLink()) {
        throw new Error(`Project Session deletion marker is invalid: ${projectId}`)
      }
      isPrepared = true
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    // Releases before the marker protocol atomically renamed the same directory and then removed it
    // best-effort. A surviving unmarked tombstone therefore proves a possible committed old Session
    // phase and must be treated fail-closed while a Project deletion intent is being recovered.
    try {
      await lstat(liveProjectDir)
    } catch (error) {
      if (isMissingFileError(error)) return isPrepared ? 'prepared' : 'legacy-committed'
      throw error
    }
    throw new Error(`Project Session deletion has conflicting live authority: ${projectId}`)
  }

  async markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    await this.operationScheduler.runProject(projectId, async () => {
      if ((await this.getProjectSessionDeletionState(projectId)) !== 'legacy-committed') return
      await this.atomicWrite(
        join(this.deletedProjectDir(assertSafeSegment(projectId)), PROJECT_DELETION_COMMIT_MARKER),
        ''
      )
      if (this.projectionWritesSuspended) this.suspendedProjectionCatalogMutation = true
    })
  }

  async completeProjectSessionDeletion(projectId: string): Promise<void> {
    await this.operationScheduler.runProject(projectId, async () => {
      await this.projection?.deleteProjectHistory(assertSafeSegment(projectId))
      const safeProjectId = assertSafeSegment(projectId)
      const deletedSessionsBoundary = await this.inspectDirectoryBoundary(this.deletedSessionsDir)
      if (deletedSessionsBoundary === 'missing') return
      if (deletedSessionsBoundary === 'invalid') {
        throw new Error('Deleted Session root is not a regular directory.')
      }
      await this.dependencies.remove(this.deletedProjectDir(safeProjectId), {
        recursive: true,
        force: true
      })
      await this.removeProjectSessionLocators(safeProjectId)
      if (this.projectionWritesSuspended) this.suspendedProjectionCatalogMutation = true
    })
  }

  async listLegacyProjectSessionTombstones(): Promise<string[]> {
    const deletedSessionsBoundary = await this.inspectDirectoryBoundary(this.deletedSessionsDir)
    if (deletedSessionsBoundary === 'missing') return []
    if (deletedSessionsBoundary === 'invalid') {
      throw new Error('Deleted Session root is not a regular directory.')
    }
    let entries
    try {
      entries = await readdir(this.deletedSessionsDir, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }

    const projectIds: string[] = []
    for (const entry of entries) {
      // Every direct child is deletion authority. Ignoring an unexpected file or symlink could hide
      // an old tombstone from adoption and permanently strand the only legacy Upload locator.
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Project Session deletion tombstone is invalid: ${entry.name}`)
      }
      const projectId = assertSafeSegment(entry.name)
      const state = await this.getProjectSessionDeletionState(projectId)
      if (state === 'legacy-committed') projectIds.push(projectId)
      else if (state !== 'prepared') {
        // A tombstone observed by this scan must remain authoritative through classification. Treat
        // concurrent disappearance or conflicting live authority as unknown instead of skipping it.
        throw new Error(`Project Session deletion tombstone state changed: ${projectId}`)
      }
    }
    return projectIds.sort()
  }

  // Persists the last-open project/session pointer.
  async saveManifest(request: SaveSessionManifestRequest): Promise<void> {
    return this.operationScheduler.runManifest(() => this.writeManifest(request))
  }

  // Existing JSON uses the released codec/serialization and atomic replacement. Only JSONL
  // needs immutable journal values and incremental business-record preparation.
  private prepareSessionWrite(
    session: PersistedChatSession,
    previous?: SessionJournalRead,
    runtimeChanges?: MainSessionSaveOptions['runtimeChanges'],
    legacyJson = previous?.format === 'legacy'
  ): PreparedSessionWrite {
    let sanitizedSession = session
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    const legacyUpload = messages
      .flatMap((message) => message.uploads ?? [])
      .find((upload) => !upload.versionId)
    if (legacyUpload) {
      throw new Error(
        `Session upload must be upgraded to an immutable Version before persistence: ${legacyUpload.id}`
      )
    }
    if (legacyJson) {
      const sanitizedSession = sanitizeSessionUploadedAttachments(session)
      const document = createSessionFile(encodeSessionDataPaths(sanitizedSession))
      return {
        sanitizedSession,
        document,
        contents: this.serializeJsonForWrite(document, this.dependencies.maxSessionBytes)
      }
    }
    const sourceFingerprint = runtimeChanges
      ? this.runtimeAuthorityFingerprints.get(runtimeChanges.previous)
      : undefined
    if (
      sourceFingerprint &&
      previous &&
      sourceFingerprint !== this.journal.authorityFingerprint(previous)
    )
      throw new SessionJournalCorruptionError('Runtime Session authority changed after its read.')
    const runtimeDocument = createRuntimeSessionFile(
      session,
      previous,
      sourceFingerprint ? runtimeChanges : undefined
    )
    let rawDocument = runtimeDocument
    if (!rawDocument) {
      sanitizedSession = sanitizeSessionUploadedAttachments(session)
      rawDocument = createSessionFile(encodeSessionDataPaths(sanitizedSession))
    }
    // Reuse unchanged durable records for business changes and byte accounting.
    let journalWrite: SessionJournalPreparedWrite | undefined
    try {
      journalWrite = previous
        ? this.journal.prepareWrite(
            this.sessionFilePath(session.projectId, session.id),
            rawDocument,
            previous,
            runtimeDocument ? { textEvents: runtimeChanges?.changes.textEvents } : undefined
          )
        : undefined
    } catch (error) {
      if (error instanceof SessionJournalSizeError)
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      throw error
    }
    const document = (journalWrite?.document ??
      normalizeJournalValue(rawDocument)) as unknown as ReturnType<typeof createSessionFile>
    this.assertDocumentWithinLimit(document)
    return {
      sanitizedSession,
      document,
      journalWrite,
      runtimeChanges: runtimeDocument ? runtimeChanges?.changes : undefined,
      runtimeSourceFingerprint: runtimeDocument ? sourceFingerprint : undefined
    }
  }

  private assertDocumentWithinLimit(document: unknown): void {
    if (journalValueByteLength(document as JournalValue) > this.dependencies.maxSessionBytes)
      throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
  }

  private async writeSession(
    session: PersistedChatSession,
    preparedWrite: PreparedSessionWrite
  ): Promise<void> {
    await this.ensureDirectoryBoundary(this.sessionsDir, 'Active Session root')
    await this.writeSessionToDirectory(session, this.projectDir(session.projectId), preparedWrite)
  }

  private async writeSessionToDirectory(
    session: PersistedChatSession,
    projectDirectory: string,
    preparedWrite: PreparedSessionWrite
  ): Promise<void> {
    const filePath = join(projectDirectory, `${assertSafeSegment(session.id)}.json`)
    const { sanitizedSession, document } = preparedWrite

    await this.ensureDirectoryBoundary(projectDirectory, 'Session Project directory')
    await this.assertFileBoundary(filePath, 'Session file')
    await this.assertExistingSessionWithinLimit(filePath)
    await this.preservePreS2Backup(filePath, sanitizedSession)
    await this.preservePreSubagentModelBackup(filePath, sanitizedSession)
    await this.ensureDirectoryBoundary(projectDirectory, 'Session Project directory')
    await this.assertFileBoundary(filePath, 'Session file')
    if (preparedWrite.contents !== undefined) {
      if ((await this.inspectFileBoundary(sessionJournalPath(filePath))) !== 'missing')
        throw new SessionJournalCorruptionError('Session format changed before JSON replacement.')
      this.journal.invalidate(filePath)
      await this.atomicWriteContents(filePath, preparedWrite.contents)
      return
    }
    try {
      const identity = { expectedRevision: sessionRevision(session) - 1 }
      await this.mutateCatalog(async () => {
        if (preparedWrite.journalWrite)
          await this.journal.writePrepared(filePath, preparedWrite.journalWrite, identity)
        else await this.journal.write(filePath, { document, ...identity })
      })
    } catch (error) {
      if (error instanceof SessionJournalSizeError)
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      if (error instanceof SessionJournalRevisionError)
        throw new SessionRevisionConflictError(error.expectedRevision, error.actualRevision)
      throw error
    }
  }

  private async assertExistingSessionWithinLimit(filePath: string): Promise<boolean> {
    const logBoundary = await this.inspectFileBoundary(sessionJournalPath(filePath))
    if (logBoundary === 'invalid') throw new SessionJournalCorruptionError('Invalid Session JSONL.')
    if (logBoundary === 'valid') return true
    try {
      if ((await lstat(filePath)).size > this.dependencies.maxSessionBytes) {
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      }
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  private async hasNoSessionAuthorityFiles(projectId: string, sessionId: string): Promise<boolean> {
    try {
      const entries = await this.dependencies.readDirectoryEntries(this.projectDir(projectId))
      const primary = `${assertSafeSegment(sessionId)}.json`
      // Retain evidence even when only a temporary, backup, or quarantined file remains.
      return !entries.some(
        ({ name }) =>
          name === primary ||
          name.startsWith(`${primary}.`) ||
          name === basename(sessionJournalPath(primary)) ||
          name === basename(sessionLegacyBackupPath(primary)) ||
          name.startsWith(`${basename(sessionJournalPath(primary))}.`)
      )
    } catch (error) {
      if (isMissingFileError(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
        return true
      throw error
    }
  }

  private async readSessionFileForBackup(filePath: string): Promise<string | undefined> {
    try {
      if ((await this.inspectFileBoundary(sessionJournalPath(filePath))) !== 'missing') {
        const current = await this.journal.read(filePath)
        return current ? `${JSON.stringify(current.document)}\n` : undefined
      }
      return await this.dependencies.readSessionFileWithinLimit(
        filePath,
        this.dependencies.maxSessionBytes
      )
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      if (error instanceof DurableJsonReadLimitError || error instanceof SessionJournalSizeError)
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      throw error
    }
  }

  private async preserveArtifactBindingBackup(filePath: string): Promise<void> {
    await this.ensureDirectoryBoundary(this.sessionsDir, 'Active Session root')
    await this.ensureDirectoryBoundary(dirname(filePath), 'Session Project directory')
    await this.assertFileBoundary(filePath, 'Session file')
    const original = await this.readSessionFileForBackup(filePath)
    if (original === undefined)
      throw new Error('Cannot back up a missing Session for binding repair.')
    const checksum = createHash('sha256').update(original).digest('hex')
    const backupPath = `${filePath}.pre-artifact-binding-${checksum}.backup`
    await this.assertFileBoundary(backupPath, 'Session binding repair backup')
    try {
      await writeFile(backupPath, original, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      )) {
        throw error
      }
    }
    await this.assertFileBoundary(backupPath, 'Session binding repair backup')
    const preserved = await this.dependencies.readSessionFileWithinLimit(
      backupPath,
      this.dependencies.maxSessionBytes
    )
    if (preserved !== original)
      throw new Error('Session binding repair backup does not match its source.')
    await defaultFileDurability.syncFile(backupPath)
    await defaultFileDurability.syncDirectory(dirname(backupPath))
  }

  private async preservePreS2Backup(
    filePath: string,
    nextSession: PersistedChatSession
  ): Promise<void> {
    const writesS2Attempt = nextSession.runtimeContext?.delegatedWork?.records.some((record) =>
      record.attempts.some((attempt) => Boolean(attempt.initiatingTurnMessageId))
    )
    if (!writesS2Attempt) return

    const legacyJson = (await this.inspectFileBoundary(sessionJournalPath(filePath))) === 'missing'
    const legacyContents = legacyJson ? await this.readSessionFileForBackup(filePath) : undefined
    const current = legacyJson
      ? legacyContents === undefined
        ? undefined
        : (JSON.parse(legacyContents) as unknown)
      : (await this.journal.read(filePath))?.document
    if (current === undefined) return
    const currentWritesS2Attempt = hasS2AttemptSchema(current)
    const backupPath = `${filePath}${PRE_S2_BACKUP_SUFFIX}`
    if (currentWritesS2Attempt) {
      if (isSamePublishedPackageCopy(current, nextSession)) return
      try {
        await lstat(backupPath)
        return
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new Error('Session contains S2 data but its required pre-S2 backup is missing.')
        }
        throw error
      }
    }
    const currentRaw = legacyContents ?? (await this.readSessionFileForBackup(filePath))
    if (currentRaw === undefined)
      throw new Error('Cannot preserve the pre-S2 Session backup from missing authority.')
    try {
      await writeFile(backupPath, currentRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST'
      ) {
        return
      }
      throw error
    }
  }

  private async preservePreSubagentModelBackup(
    filePath: string,
    nextSession: PersistedChatSession
  ): Promise<void> {
    const writesModelSnapshot = nextSession.runtimeContext?.delegatedWork?.records.some((record) =>
      record.attempts.some((attempt) => attempt.executionModel !== undefined)
    )
    if (!writesModelSnapshot) return
    const legacyJson = (await this.inspectFileBoundary(sessionJournalPath(filePath))) === 'missing'
    const legacyContents = legacyJson ? await this.readSessionFileForBackup(filePath) : undefined
    const current = legacyJson
      ? legacyContents === undefined
        ? undefined
        : (JSON.parse(legacyContents) as unknown)
      : (await this.journal.read(filePath))?.document
    if (current === undefined) return
    const backupPath = `${filePath}${PRE_SUBAGENT_MODEL_BACKUP_SUFFIX}`
    if (hasSubagentModelAttemptSchema(current)) {
      if (isSamePublishedPackageCopy(current, nextSession)) return
      try {
        await lstat(backupPath)
        return
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new Error(
            'Session contains Subagent model data but its required backup is missing.'
          )
        }
        throw error
      }
    }
    const currentRaw = legacyContents ?? (await this.readSessionFileForBackup(filePath))
    if (currentRaw === undefined)
      throw new Error(
        'Cannot preserve the pre-Subagent-model Session backup from missing authority.'
      )
    try {
      await writeFile(backupPath, currentRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST'
      )
        return
      throw error
    }
  }

  private async writeManifest(request: SaveSessionManifestRequest): Promise<void> {
    await this.ensureDirectoryBoundary(this.sessionsDir, 'Active Session root')
    await this.assertFileBoundary(this.manifestPath, 'Session manifest')
    await this.atomicWrite(this.manifestPath, normalizeSessionManifest(request))
  }

  // Shared temp-file + rename write used by session files and the manifest.
  private async atomicWrite(filePath: string, payload: unknown, maxBytes?: number): Promise<void> {
    await this.atomicWriteContents(filePath, this.serializeJsonForWrite(payload, maxBytes))
  }

  private serializeJsonForWrite(payload: unknown, maxBytes?: number): string {
    const contents = `${JSON.stringify(payload, null, 2)}\n`
    if (maxBytes !== undefined && Buffer.byteLength(contents, 'utf8') > maxBytes) {
      throw new SessionSizeLimitError(maxBytes)
    }
    return contents
  }

  private async atomicWriteContents(filePath: string, contents: string): Promise<void> {
    await this.mutateCatalog(() =>
      writeDurableJsonFile(filePath, contents, {
        remove: this.dependencies.remove,
        rename: this.dependencies.renameFile,
        wait: this.dependencies.wait
      })
    )
  }

  private async readManifest(options: { quarantineInvalidFiles: boolean }): Promise<{
    manifest: PersistedSessionManifest
    warning?: SessionLoadWarning
  }> {
    const sessionsBoundary = await this.inspectDirectoryBoundary(this.sessionsDir)
    if (sessionsBoundary === 'missing') return { manifest: createEmptySessionManifest() }
    if (
      sessionsBoundary === 'invalid' ||
      (await this.inspectFileBoundary(this.manifestPath)) === 'invalid'
    ) {
      return {
        manifest: createEmptySessionManifest(),
        warning: {
          kind: 'manifest-unreadable',
          fileName: MANIFEST_FILE,
          recovered: false
        }
      }
    }
    try {
      const read = await readDurableJsonFile(
        this.manifestPath,
        (contents) => {
          const parsed = JSON.parse(contents) as unknown
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Invalid Session manifest')
          }
          return normalizeSessionManifest(parsed)
        },
        {
          readDirectoryEntries: this.dependencies.readDirectoryEntries,
          readFile: this.dependencies.readManifestFile,
          remove: this.dependencies.remove,
          rename: this.dependencies.renameFile,
          wait: this.dependencies.wait
        }
      )
      return {
        manifest: read.status === 'found' ? read.value : createEmptySessionManifest()
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        !isMissingFileError(error)
      ) {
        return {
          manifest: createEmptySessionManifest(),
          warning: {
            kind: 'manifest-unreadable',
            fileName: MANIFEST_FILE,
            recovered: false
          }
        }
      }
      const wasQuarantined =
        options.quarantineInvalidFiles && (await this.tryBackupInvalidFile(this.manifestPath))
      return {
        manifest: createEmptySessionManifest(),
        warning: {
          kind: 'manifest-corrupt',
          fileName: MANIFEST_FILE,
          recovered: wasQuarantined
        }
      }
    }
  }

  // Reads every project directory's session files and propagates completeness across every level.
  // Repair scans quarantine invalid data; read-only scans report it in place. I/O errors keep
  // reconciliation disabled until the next repair.
  private async readAllSessions(options: {
    quarantinedIsIncomplete?: boolean
    quarantineInvalidFiles: boolean
    scanMetrics: SessionScanMetrics
  }): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
    warnings: SessionLoadWarning[]
  }> {
    const projectDirectories = await this.listDirectoryNames(this.sessionsDir)
    const sessions: PersistedChatSession[] = []
    options.scanMetrics.projectDirectoryCount = projectDirectories.names.length
    const warnings: SessionLoadWarning[] = []
    let isComplete = projectDirectories.isComplete

    for (const projectId of projectDirectories.names) {
      const warningCount = warnings.length
      const project = await this.readProjectSessions(projectId, {
        missingDirectoryIsIncomplete: true,
        quarantineInvalidFiles: options.quarantineInvalidFiles,
        quarantinedIsIncomplete: options.quarantinedIsIncomplete,
        warnings,
        scanMetrics: options.scanMetrics,
        sessionsBoundaryValidated: true
      })
      if (
        options.quarantinedIsIncomplete &&
        !project.isComplete &&
        warnings.length === warningCount
      ) {
        warnings.push({ kind: 'unreadable', projectId, fileName: '.', recovered: false })
      }
      sessions.push(...project.sessions)
      isComplete &&= project.isComplete
    }

    return { sessions, isComplete, warnings }
  }

  private async readProjectSessions(
    projectIdValue: string,
    options: {
      missingDirectoryIsIncomplete?: boolean
      quarantinedIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      warnings?: SessionLoadWarning[]
      scanMetrics?: SessionScanMetrics
      sessionsBoundaryValidated?: boolean
    } = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    const projectId = assertSafeSegment(projectIdValue)
    if (!options.sessionsBoundaryValidated) {
      const sessionsBoundary = await this.inspectDirectoryBoundary(this.sessionsDir)
      if (sessionsBoundary !== 'valid') {
        return { sessions: [], isComplete: sessionsBoundary === 'missing' }
      }
    }
    return this.readProjectSessionsAtDirectory(
      projectId,
      join(this.sessionsDir, projectId),
      options
    )
  }

  private async readProjectSessionsAtDirectory(
    projectId: string,
    projectDir: string,
    options: {
      missingDirectoryIsIncomplete?: boolean
      quarantinedIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      warnings?: SessionLoadWarning[]
      scanMetrics?: SessionScanMetrics
    } = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    if (await isSessionPackagePending(this.storageDir, projectId))
      return { sessions: [], isComplete: true }
    const directoryBoundary = await this.inspectDirectoryBoundary(projectDir)
    if (directoryBoundary === 'invalid') {
      return { sessions: [], isComplete: false }
    }
    let recoveryComplete = true
    try {
      await recoverDurableJsonDirectory(
        projectDir,
        (filePath, contents) => this.decodeSessionPrimary(filePath, projectId, contents),
        {
          readDirectoryEntries: this.dependencies.readDirectoryEntries,
          readFile: (path) => this.readLegacySessionRecoveryFile(path),
          readFileWithinLimit: (path, maxBytes) =>
            this.readLegacySessionRecoveryFile(path, maxBytes),
          remove: this.dependencies.remove,
          rename: this.dependencies.renameFile,
          wait: this.dependencies.wait
        },
        { maxBytes: this.dependencies.maxSessionBytes }
      )
    } catch {
      recoveryComplete = false
      // The per-Session read below reports the barrier, including temp-only authority.
    }
    const sessionFiles = await this.listSessionFileNames(projectDir, {
      missingIsIncomplete: options.missingDirectoryIsIncomplete,
      directoryBoundaryValidated: directoryBoundary === 'valid'
    })
    const sessions: PersistedChatSession[] = []
    const activeQuarantines = new Set(sessionFiles.quarantinedPrimaryFileNames)
    if (options.scanMetrics) options.scanMetrics.sessionFileCount += sessionFiles.names.length
    const warnedFiles = new Set<string>()
    let isComplete = sessionFiles.isComplete && recoveryComplete

    for (const fileName of sessionFiles.names) {
      // The directory is the authoritative owning project, regardless of the file's stored projectId.
      const read = await this.readSessionFile(join(projectDir, fileName), projectId, {
        missingIsIncomplete: true,
        quarantineInvalidFiles: options.quarantineInvalidFiles,
        scanMetrics: options.scanMetrics
      })
      isComplete &&= read.isComplete
      if (options.quarantinedIsIncomplete && read.wasQuarantined) isComplete = false
      if (read.warning) {
        options.warnings?.push(read.warning)
        warnedFiles.add(read.warning.fileName)
      }
      if (read.session) {
        // A current primary that successfully normalizes supersedes retained historical backups for
        // the same file. Keep the backups, but do not let them permanently block terminal mutation.
        activeQuarantines.delete(fileName)
        sessions.push(read.session)
      }
    }
    if (options.quarantinedIsIncomplete && activeQuarantines.size > 0) isComplete = false
    for (const fileName of activeQuarantines) {
      if (!warnedFiles.has(fileName)) {
        options.warnings?.push({
          kind: 'corrupt',
          projectId,
          fileName,
          recovered: true
        })
      }
    }

    return { sessions, isComplete }
  }

  private async readSessionFile(
    filePath: string,
    projectId: string,
    options: {
      missingIsIncomplete?: boolean
      quarantineInvalidFiles?: boolean
      scanMetrics?: SessionScanMetrics
      preserveRuntimeState?: boolean
      runtimeAuthority?: PersistedChatSession
    } = {}
  ): Promise<{
    session?: PersistedChatSession
    isComplete: boolean
    wasQuarantined?: boolean
    warning?: SessionLoadWarning
  }> {
    const initialBoundary = await this.inspectFileBoundary(filePath)
    if (initialBoundary === 'invalid') {
      return {
        isComplete: false,
        warning: {
          kind: 'unreadable',
          projectId,
          fileName: basename(filePath),
          recovered: false
        }
      }
    }
    let read:
      | { status: 'found'; value: { session: PersistedChatSession; bytes: number } }
      | { status: 'missing' }
    try {
      const logBoundary = await this.inspectFileBoundary(sessionJournalPath(filePath))
      if (logBoundary === 'invalid')
        throw new SessionJournalCorruptionError('Session JSONL is not a regular file.')
      if (logBoundary === 'valid') {
        const current = await this.journal.read(filePath)
        if (!current) throw new SessionJournalCorruptionError('Session JSONL disappeared.')
        // The reducer already decoded this authority. Reuse it only within its save, after
        // the ordinary boundary checks and a fresh journal fingerprint check. External changes
        // and all other reads still run the full decoder, including tool-result redaction.
        const prior = options.runtimeAuthority
        const envelope = prior ? decodeSessionEnvelope(current.document) : undefined
        const value =
          options.preserveRuntimeState === true &&
          current.format === 'journal' &&
          prior &&
          // Imported projects also contain writable forks. The durable origin, not a mutable
          // caller object, decides whether the full imported-history comparison is required.
          envelope?.status === 'ok' &&
          envelope.session.packageOrigin === undefined &&
          prior.packageOrigin === undefined &&
          prior.id === basename(filePath, '.json') &&
          prior.projectId === projectId &&
          sessionRevision(prior) === current.revision &&
          this.runtimeAuthorityFingerprints.get(prior) ===
            this.journal.authorityFingerprint(current)
            ? { session: prior, bytes: current.storageBytes }
            : this.decodeSessionDocument(
                filePath,
                projectId,
                current.document,
                current.storageBytes,
                options.preserveRuntimeState
              )
        if (options.preserveRuntimeState === true)
          this.runtimeAuthorityFingerprints.set(
            value.session,
            this.journal.authorityFingerprint(current)
          )
        read = { status: 'found', value }
      } else {
        const readRecoveryFile = async (path: string, maxBytes?: number): Promise<string> => {
          const startedAt = performance.now()
          try {
            return maxBytes === undefined
              ? await this.readLegacySessionRecoveryFile(path)
              : await this.readLegacySessionRecoveryFile(path, maxBytes)
          } finally {
            if (options.scanMetrics)
              options.scanMetrics.authorityReadMs += performance.now() - startedAt
          }
        }
        read = await readDurableJsonFile(
          filePath,
          (contents) =>
            this.decodeSessionContents(
              filePath,
              projectId,
              contents,
              options.preserveRuntimeState,
              options.scanMetrics
            ),
          {
            readDirectoryEntries: this.dependencies.readDirectoryEntries,
            readFile: readRecoveryFile,
            readFileWithinLimit: readRecoveryFile,
            remove: this.dependencies.remove,
            rename: this.dependencies.renameFile,
            wait: this.dependencies.wait
          },
          { maxBytes: this.dependencies.maxSessionBytes }
        )
      }
    } catch (error) {
      if (error instanceof DurableJsonReadLimitError || error instanceof SessionJournalSizeError) {
        return {
          isComplete: false,
          warning: {
            kind: 'too-large',
            projectId,
            fileName: basename(filePath),
            recovered: false
          }
        }
      }
      if (
        error instanceof UnsupportedSessionFileError ||
        error instanceof SessionJournalVersionError
      ) {
        return {
          isComplete: false,
          warning: {
            kind: 'unsupported-version',
            projectId,
            fileName: basename(filePath),
            recovered: false
          }
        }
      }
      // Preserve a corrupt JSONL and its retained legacy backup. Moving only the live log could
      // hide research history and allow this ID to be recreated against an older document.
      let malformedJournalPrimary = false
      if (error instanceof SyntaxError) {
        try {
          malformedJournalPrimary = (await this.journal.inspectStorage(filePath)).paths.some(
            (path) => path !== filePath
          )
        } catch {
          // Unreadable ownership evidence cannot authorize moving the primary out of the way.
          malformedJournalPrimary = true
        }
      }
      if (error instanceof SessionJournalCorruptionError || malformedJournalPrimary) {
        return {
          isComplete: false,
          warning: {
            kind: 'corrupt',
            projectId,
            fileName: basename(filePath),
            recovered: false
          }
        }
      }
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        isMissingFileError(error)
      ) {
        const wasQuarantined =
          !isMissingFileError(error) &&
          options.quarantineInvalidFiles !== false &&
          (await this.tryBackupInvalidFile(filePath))
        if (!isMissingFileError(error)) {
          return {
            isComplete: wasQuarantined,
            wasQuarantined,
            warning: {
              kind: 'corrupt',
              projectId,
              fileName: basename(filePath),
              recovered: wasQuarantined
            }
          }
        }
      }
      if (isMissingFileError(error) && !options.missingIsIncomplete) return { isComplete: true }
      return {
        isComplete: false,
        warning: {
          kind: 'unreadable',
          projectId,
          fileName: basename(filePath),
          recovered: false
        }
      }
    }
    if (read.status === 'missing') {
      try {
        // A missing primary beside retained legacy history is unknown authority, not empty.
        const storage = await this.journal.inspectStorage(filePath)
        if (storage.paths.some((path) => path !== filePath))
          return {
            isComplete: false,
            warning: {
              kind: 'corrupt',
              projectId,
              fileName: basename(filePath),
              recovered: false
            }
          }
      } catch {
        return {
          isComplete: false,
          warning: {
            kind: 'unreadable',
            projectId,
            fileName: basename(filePath),
            recovered: false
          }
        }
      }
      if (!options.missingIsIncomplete) {
        const files = await this.listSessionFileNames(dirname(filePath))
        if (files.isComplete && !files.names.includes(basename(filePath))) {
          return { isComplete: true }
        }
      }
      return {
        isComplete: false,
        warning: {
          kind: 'unreadable',
          projectId,
          fileName: basename(filePath),
          recovered: false
        }
      }
    }
    if (
      initialBoundary === 'missing' &&
      (await this.inspectFileBoundary(filePath)) !== 'valid' &&
      (await this.inspectFileBoundary(sessionJournalPath(filePath))) !== 'valid'
    ) {
      return {
        isComplete: false,
        warning: {
          kind: 'unreadable',
          projectId,
          fileName: basename(filePath),
          recovered: false
        }
      }
    }
    if (options.scanMetrics) options.scanMetrics.sessionBytes += read.value.bytes
    return { session: read.value.session, isComplete: true }
  }

  private async readLegacySessionRecoveryFile(
    path: string,
    maxBytes = this.dependencies.maxSessionBytes
  ): Promise<string> {
    const primaryName = temporarySessionPrimaryName(basename(path))
    if (primaryName) {
      const primary = join(dirname(path), primaryName)
      if (
        (await this.inspectFileBoundary(primary)) === 'missing' &&
        (await this.inspectFileBoundary(sessionJournalPath(primary))) !== 'valid'
      ) {
        // A retained migration backup or unfinished JSONL publication is evidence of unknown
        // authority. Check before the legacy reader can promote or clean up an older temp.
        const storage = await this.journal.inspectStorage(primary)
        if (storage.paths.some((file) => file !== primary))
          throw new SessionJournalCorruptionError(
            'Cannot recover a legacy Session temp while JSONL history lacks its primary.'
          )
      }
    }
    return this.dependencies.readSessionFileWithinLimit(path, maxBytes)
  }

  private decodeSessionPrimary(
    filePath: string,
    projectId: string,
    contents: string,
    preserveRuntimeState?: boolean,
    scanMetrics?: Pick<SessionScanMetrics, 'jsonParseMs'>
  ): { session: PersistedChatSession; bytes: number } {
    return this.decodeSessionContents(
      filePath,
      projectId,
      contents,
      preserveRuntimeState,
      scanMetrics
    )
  }

  private decodeSessionContents(
    filePath: string,
    projectId: string,
    contents: string,
    preserveRuntimeState?: boolean,
    scanMetrics?: Pick<SessionScanMetrics, 'jsonParseMs'>
  ): { session: PersistedChatSession; bytes: number } {
    const parseStartedAt = performance.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } finally {
      if (scanMetrics) scanMetrics.jsonParseMs += performance.now() - parseStartedAt
    }
    return this.decodeSessionDocument(
      filePath,
      projectId,
      parsed,
      Buffer.byteLength(contents, 'utf8'),
      preserveRuntimeState
    )
  }

  private decodeSessionDocument(
    filePath: string,
    projectId: string,
    document: unknown,
    bytes: number,
    preserveRuntimeState?: boolean
  ): { session: PersistedChatSession; bytes: number } {
    const decoded = decodeSessionFile(document, {
      preserveLegacyUploadPaths: true,
      preserveRuntimeState:
        preserveRuntimeState !== undefined
          ? preserveRuntimeState
          : (sessionId) => this.shouldPreserveRuntimeState(projectId, sessionId)
    })
    if (decoded.status === 'unsupported-version') throw new UnsupportedSessionFileError()
    if (decoded.status === 'invalid') throw new Error('Invalid Session file')

    // The file name is authoritative for global Session identity. Unlike the owning Project,
    // an id mismatch is corruption rather than a legacy field that may be repaired from the path.
    const fileName = basename(filePath)
    const fileSessionId = fileName.endsWith('.json')
      ? fileName.slice(0, -'.json'.length)
      : undefined
    if (decoded.session.id !== fileSessionId) {
      throw new Error('Session id does not match its file name')
    }

    return {
      session: decodeSessionDataPaths({ ...decoded.session, projectId }),
      bytes
    }
  }

  // ENOENT is an authoritative empty directory; any other readdir failure is a partial scan.
  private async listDirectoryNames(
    dir: string,
    options: { missingIsIncomplete?: boolean } = {}
  ): Promise<{ names: string[]; isComplete: boolean }> {
    const boundary = await this.inspectDirectoryBoundary(dir)
    if (boundary !== 'valid') {
      return { names: [], isComplete: boundary === 'missing' && !options.missingIsIncomplete }
    }
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        isComplete: entries.every((entry) => entry.isDirectory() || entry.isFile())
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) && !options.missingIsIncomplete }
    }
  }

  // Lists Session primary identities. Quarantines are associated with their former primary so
  // terminal scans can distinguish orphan authority from a backup superseded by valid current JSON.
  // Include the primary identity of unresolved temps so missing JSON cannot authorize deletion.
  // The durable reader still excludes live writers; non-ENOENT failures disable reconciliation.
  private async listSessionFileNames(
    dir: string,
    options: { missingIsIncomplete?: boolean; directoryBoundaryValidated?: boolean } = {}
  ): Promise<{
    names: string[]
    isComplete: boolean
    quarantinedPrimaryFileNames: string[]
    hasRecoveryEvidence: boolean
  }> {
    if (!options.directoryBoundaryValidated) {
      const boundary = await this.inspectDirectoryBoundary(dir)
      if (boundary !== 'valid') {
        return {
          names: [],
          isComplete: boundary === 'missing' && !options.missingIsIncomplete,
          quarantinedPrimaryFileNames: [],
          hasRecoveryEvidence: false
        }
      }
    }
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)
      const primaryFiles = new Set(
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
      )

      return {
        hasRecoveryEvidence: entries.some((entry) => {
          if (temporarySessionPrimaryName(entry.name) !== undefined) return true
          // JSONL publication writes a sibling temporary. It carries an unpublished identity even
          // when the live primary still exists, so an identity cleanup snapshot is not complete.
          if (/^.*\.jsonl\..*\.tmp$/u.test(entry.name)) return true
          // A retained pre-migration legacy backup is unknown authority only when neither its JSON
          // nor JSONL primary survives. With a primary, the backup cannot hide another identity.
          if (entry.name.endsWith('.legacy-json.backup')) {
            const primary = `${entry.name.slice(0, -'.legacy-json.backup'.length)}.json`
            return !primaryFiles.has(primary) && !primaryFiles.has(`${primary}l`)
          }
          const quarantine = /^(.*\.json)\.invalid-\d+-\d+$/u.exec(entry.name)
          return quarantine !== null && !primaryFiles.has(quarantine[1])
        }),
        names: [
          ...new Set(
            entries.flatMap((entry) => {
              if (!entry.isFile()) return []
              if (
                entry.name.endsWith('.json') &&
                !entry.name.includes('.tmp') &&
                !entry.name.includes('.invalid-')
              ) {
                return [entry.name]
              }
              if (entry.name.endsWith('.jsonl')) return [`${entry.name.slice(0, -6)}.json`]
              if (entry.name.endsWith('.legacy-json.backup'))
                return [`${entry.name.slice(0, -'.legacy-json.backup'.length)}.json`]
              const jsonlTemporary = entry.name.match(/^(.*)\.jsonl\..*\.tmp$/u)
              if (jsonlTemporary) return [`${jsonlTemporary[1]}.json`]
              const primary = temporarySessionPrimaryName(entry.name)
              return primary ? [primary] : []
            })
          )
        ],
        isComplete: entries.every((entry) => entry.isFile() || !entry.name.includes('.json')),
        quarantinedPrimaryFileNames: entries.flatMap((entry) => {
          if (!entry.isFile()) return []
          const match = /^(.*\.json)\.invalid-\d+-\d+$/u.exec(entry.name)
          return match ? [match[1]] : []
        })
      }
    } catch (error) {
      return {
        names: [],
        isComplete: isMissingFileError(error) && !options.missingIsIncomplete,
        quarantinedPrimaryFileNames: [],
        hasRecoveryEvidence: false
      }
    }
  }

  private async hasQuarantinedSessionFile(
    projectId: string,
    sessionId: string
  ): Promise<{ exists: boolean; isComplete: boolean }> {
    const quarantines = await this.listQuarantinedSessionFiles(projectId, sessionId)
    return { exists: quarantines.names.length > 0, isComplete: quarantines.isComplete }
  }

  private async listQuarantinedSessionFiles(
    projectId: string,
    sessionId: string
  ): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await readdir(this.projectDir(projectId))
      const prefix = `${sessionId}.json.invalid-`
      return {
        names: entries.filter(
          (entry) => entry.startsWith(prefix) && /^\d+-\d+$/u.test(entry.slice(prefix.length))
        ),
        isComplete: true
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) }
    }
  }

  // Returning false preserves the partial-scan signal when even quarantine could not complete.
  private async tryBackupInvalidFile(filePath: string): Promise<boolean> {
    try {
      await this.backupInvalidFile(filePath)
      return true
    } catch {
      return false
    }
  }

  private async backupInvalidFile(filePath: string): Promise<void> {
    this.backupSequence += 1
    await this.dependencies.renameFile(
      filePath,
      `${filePath}.invalid-${Date.now()}-${this.backupSequence}`
    )
  }
}

// Distinguishes first-run missing storage from malformed files that deserve a backup.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

export { DEV_SESSION_DIR_NAME, PROD_SESSION_DIR_NAME, getSessionPersistenceDir } from './paths'
export { SessionRepository }
export type {
  SessionRecoverySnapshot,
  ProjectSessionDeletionState,
  ProjectSessionLoadDiagnostics,
  SessionLoadDiagnostic,
  SessionLoadDiagnostics,
  SessionScanMetrics
}
