import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { Buffer } from 'node:buffer'
import { basename, join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  decodeSessionFile,
  MAX_PERSISTED_SESSION_BYTES,
  SessionSizeLimitError,
  SessionRevisionConflictError,
  SessionDeletionCommittedError,
  sanitizeSessionUploadedAttachments,
  sessionRevision,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest,
  type SessionSummary,
  type SessionUsageProjection,
  type SessionLoadFailure,
  type SessionLoadWarning
} from '../../shared/session-persistence'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'
import { SessionPersistenceOperationScheduler } from './operation-scheduler'
import {
  assertSessionProjectionStorageShape,
  buildSessionProjection,
  type SessionProjectionRepository
} from './projection'
import {
  DurableJsonRecoveryBarrierError,
  DurableJsonReadLimitError,
  isRecoverableDurableJsonTemporaryFile,
  readFileWithinLimit,
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '../storage/durable-json-file'

const SESSIONS_DIR = 'sessions'
const DELETED_SESSIONS_DIR = 'deleted-sessions'
const PROJECT_DELETION_COMMIT_MARKER = '.project-deletion-committed'
const MANIFEST_FILE = 'manifest.json'
const PRE_S2_BACKUP_SUFFIX = '.pre-s2-backup'
const PRE_SUBAGENT_MODEL_BACKUP_SUFFIX = '.pre-subagent-model-backup'
const RECOVERABLE_TEMPORARY_FILE_PATTERN =
  /^(.+\.json)\.(?:\d{13}-\d+|\d+|\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.tmp$/iu

const nextSessionRevision = (revision: number): number => {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Session revision cannot be incremented safely.')
  }
  return revision + 1
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
}

type PreparedSessionWrite = {
  sanitizedSession: PersistedChatSession
  contents: string
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
  mode?: 'repair' | 'read-only'
  // Main-owned same-process mutations read durable authority without applying app-restart recovery.
  preserveRuntimeState?: boolean
}

type SessionLoadDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

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
  hasActiveRuntimePrompt(projectId: string, sessionId: string): boolean
  hasLiveRuntimeSession(projectId: string, sessionId: string): boolean
  maxSessionBytes: number
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

// Owns per-session durable reads/writes: one file per Session under sessions/<projectId>/<id>.json,
// plus a small manifest for the last-open selection. Writes are atomic (temp + rename) and serialized
// at their Project/Session scope, while malformed JSON is backed up for later recovery.
class SessionRepository {
  private readonly operationScheduler = new SessionPersistenceOperationScheduler()
  private readonly sessionRevisions = new Map<string, number>()
  private projectionWritesSuspended = false
  private readonly suspendedProjectionSessionWrites = new Map<
    string,
    Readonly<{ projectId: string; sessionId: string }>
  >()
  private suspendedProjectionCatalogMutation = false
  private projectionInitialization:
    Promise<{ result?: LoadAllSessionsResult; sessions: SessionSummary[] }> | undefined
  private backupSequence = 0
  private readonly dependencies: SessionRepositoryDependencies

  constructor(
    private readonly storageDir: string,
    dependencies: Partial<SessionRepositoryDependencies> = {},
    private readonly projection?: SessionProjectionRepository
  ) {
    this.dependencies = {
      hasActiveRuntimePrompt:
        dependencies.hasActiveRuntimePrompt ?? DEFAULT_DEPENDENCIES.hasActiveRuntimePrompt,
      hasLiveRuntimeSession:
        dependencies.hasLiveRuntimeSession ?? DEFAULT_DEPENDENCIES.hasLiveRuntimeSession,
      maxSessionBytes: dependencies.maxSessionBytes ?? DEFAULT_DEPENDENCIES.maxSessionBytes,
      remove: dependencies.remove ?? DEFAULT_DEPENDENCIES.remove,
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
      renameFile: dependencies.renameFile ?? DEFAULT_DEPENDENCIES.renameFile,
      wait: dependencies.wait ?? DEFAULT_DEPENDENCIES.wait
    }
  }

  private get sessionsDir(): string {
    return join(this.storageDir, SESSIONS_DIR)
  }

  private get manifestPath(): string {
    return join(this.sessionsDir, MANIFEST_FILE)
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

  private async inspectActiveProjectBoundary(projectId: string): Promise<FilesystemBoundaryState> {
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
    loadAuthority: () => Promise<LoadAllSessionsResult>
  ): Promise<{ result?: LoadAllSessionsResult; sessions: SessionSummary[] }> {
    if (!this.projection) throw new Error('Session projection is unavailable.')
    if (this.projectionInitialization) return this.projectionInitialization

    const initialization = this.ensureSessionProjectionNow(loadAuthority)
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
      for (const pending of await this.projection.pending()) {
        if (pending.operation === 'delete') {
          await this.deleteSessionNow(pending.projectId, pending.sessionId)
          continue
        }
        const loaded = await this.loadSessionWithDiagnostics(pending.projectId, pending.sessionId, {
          mode: 'read-only'
        })
        if (loaded.status === 'unreadable') break
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
    loadAuthority: () => Promise<LoadAllSessionsResult>
  ): Promise<{ result?: LoadAllSessionsResult; sessions: SessionSummary[] }> {
    if (!this.projection) throw new Error('Session projection is unavailable.')

    const loadReadyProjection = async (): Promise<{
      result?: LoadAllSessionsResult
      sessions: SessionSummary[]
    }> => {
      const summaries = await this.operationScheduler.runGlobal(() => this.projection!.list())
      const needsAuthorityScan =
        summaries.some((session) => session.needsStartupRecovery) ||
        (await this.hasOversizedProjectedSession(summaries))
      if (!needsAuthorityScan) {
        return { sessions: summaries }
      }
      const result = await this.loadAuthorityWithSuspendedProjection(loadAuthority)
      return this.operationScheduler.runGlobal(async () => {
        const freshResult = await this.refreshProjectionBuildAuthority(result)
        const numbers = new Map(summaries.map((session) => [session.id, session.number]))
        if (freshResult.diagnostics?.isComplete === false) {
          await this.retainOversizedProjectionRecovery(freshResult.diagnostics.warnings)
          return {
            result: freshResult,
            sessions: projectIncompleteSummaries(freshResult, numbers)
          }
        }
        const numbered = freshResult.sessions.map((session) => ({
          ...session,
          number: session.number ?? numbers.get(session.id)
        }))
        await this.projection!.replaceAll(numbered)
        return {
          result: { ...freshResult, sessions: numbered },
          sessions: await this.projection!.list()
        }
      })
    }

    if (await this.projection.isInitialized()) {
      await this.reconcilePendingSessionProjection()
      if (await this.projection.isReady()) return loadReadyProjection()
    }

    const result = await this.loadAuthorityWithSuspendedProjection(loadAuthority)
    return this.operationScheduler.runGlobal(async () => {
      const freshResult = await this.refreshProjectionBuildAuthority(result)
      if (freshResult.diagnostics?.isComplete === false) {
        return { result: freshResult, sessions: projectIncompleteSummaries(freshResult) }
      }
      for (const session of freshResult.sessions) assertSessionProjectionStorageShape(session)
      const assignments = await this.projection!.numberAssignments()
      const existingNumberById = new Map(assignments.map(({ id, number }) => [id, number]))
      const existingIdByNumber = new Map(assignments.map(({ id, number }) => [number, id]))
      await this.projection!.clearForRebuild()
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
          const numbered =
            session.number === number ? session : await this.saveSessionNow({ ...session, number })
          rebuiltById.set(session.id, numbered)
          continue
        }
        const persisted = await this.saveSessionNow({ ...session, number: undefined })
        rebuiltById.set(session.id, persisted)
      }
      const rebuilt = freshResult.sessions.map((session) => rebuiltById.get(session.id) ?? session)
      await this.projection!.replaceAll(rebuilt)
      return {
        result: { ...freshResult, sessions: rebuilt },
        sessions: await this.projection!.list()
      }
    })
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

  async loadSessionSummaries(): Promise<SessionSummary[]> {
    if (!this.projection || !(await this.projection.isReady())) {
      throw new Error('Session projection is not ready.')
    }
    return this.operationScheduler.runGlobal(() => this.projection!.list())
  }

  private async hasOversizedProjectedSession(
    summaries: readonly SessionSummary[]
  ): Promise<boolean> {
    const projectedFilesByProject = new Map<string, Set<string>>()
    for (const summary of summaries) {
      const projectedFiles = projectedFilesByProject.get(summary.projectId) ?? new Set<string>()
      projectedFiles.add(`${summary.id}.json`)
      projectedFilesByProject.set(summary.projectId, projectedFiles)
      try {
        const metadata = await lstat(this.sessionFilePath(summary.projectId, summary.id))
        if (
          metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          metadata.size > this.dependencies.maxSessionBytes
        ) {
          return true
        }
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
    }

    for (const [projectId, projectedFiles] of projectedFilesByProject) {
      const directory = this.projectDir(projectId)
      let entries: SessionDirectoryEntry[]
      try {
        entries = await this.dependencies.readDirectoryEntries(directory)
      } catch (error) {
        if (isMissingFileError(error)) continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const sessionExtensionIndex = entry.name.lastIndexOf('.json.')
        if (sessionExtensionIndex < 0) continue
        const primaryName = entry.name.slice(0, sessionExtensionIndex + '.json'.length)
        if (!projectedFiles.has(primaryName)) continue
        const primaryPath = join(directory, primaryName)
        if (!isRecoverableDurableJsonTemporaryFile(primaryPath, entry.name)) continue
        try {
          const metadata = await lstat(join(directory, entry.name))
          if (
            metadata.isFile() &&
            !metadata.isSymbolicLink() &&
            metadata.size > this.dependencies.maxSessionBytes
          ) {
            return true
          }
        } catch (error) {
          if (!isMissingFileError(error)) throw error
        }
      }
    }
    return false
  }

  private async retainOversizedProjectionRecovery(
    warnings: readonly SessionLoadWarning[] | undefined
  ): Promise<void> {
    if (!this.projection) return
    for (const warning of warnings ?? []) {
      if (
        warning.kind !== 'too-large' ||
        !warning.fileName.endsWith('.json') ||
        warning.fileName.length === '.json'.length
      ) {
        continue
      }
      const sessionId = warning.fileName.slice(0, -'.json'.length)
      let projectId: string
      let safeSessionId: string
      try {
        projectId = assertSafeSegment(warning.projectId)
        safeSessionId = assertSafeSegment(sessionId)
      } catch {
        // Unsafe warning identities already keep the scan incomplete; they cannot become a safe
        // projection reconciliation target.
        continue
      }
      await this.projection.markPending(projectId, safeSessionId)
    }
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
    sessionId: string
  ): Promise<PersistedChatSession | undefined> {
    const safeProjectId = assertSafeSegment(projectId)
    if ((await this.inspectActiveProjectBoundary(safeProjectId)) !== 'valid') return undefined
    return (
      await this.readSessionFile(
        this.sessionFilePath(safeProjectId, assertSafeSegment(sessionId)),
        safeProjectId
      )
    ).session
  }

  // Terminal mutations must distinguish absence from a transient/non-ENOENT read failure. Treating
  // both as undefined could unlink the JSON before Upload cleanup has observed its final authority.
  async loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string,
    options: SessionScanOptions = {}
  ): Promise<SessionLoadDiagnostic> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    const projectBoundary = await this.inspectActiveProjectBoundary(safeProjectId)
    if (projectBoundary === 'invalid') return { status: 'unreadable' }
    if (projectBoundary === 'missing') return { status: 'missing' }
    const read = await this.readSessionFile(
      this.sessionFilePath(safeProjectId, safeSessionId),
      safeProjectId,
      {
        quarantineInvalidFiles: options.mode !== 'read-only',
        preserveRuntimeState: options.preserveRuntimeState
      }
    )
    if (!read.isComplete || read.wasQuarantined) return { status: 'unreadable' }

    const quarantine = await this.hasQuarantinedSessionFile(safeProjectId, safeSessionId)
    if (!quarantine.isComplete) return { status: 'unreadable' }
    if (read.session) return { status: 'found', session: read.session }
    return quarantine.exists ? { status: 'unreadable' } : { status: 'missing' }
  }

  // Verifies durable Session identity from directory/file authority without parsing JSON. This lets
  // an incomplete hydration catalog distinguish a corrupt Session file from a genuinely unused id.
  async assertSessionIdentityOwnership(
    sessionIdValue: string,
    expectedProjectIdValue: string
  ): Promise<void> {
    const sessionId = assertSafeSegment(sessionIdValue)
    const expectedProjectId = assertSafeSegment(expectedProjectIdValue)
    const fileName = `${sessionId}.json`
    const projectDirectories = await this.listDirectoryNames(this.sessionsDir)
    let belongsToAnotherProject = false
    let isComplete = projectDirectories.isComplete

    for (const projectIdValue of projectDirectories.names) {
      let projectId: string
      try {
        projectId = assertSafeSegment(projectIdValue)
      } catch {
        isComplete = false
        continue
      }
      const sessionFiles = await this.listSessionFileNames(join(this.sessionsDir, projectId), {
        missingIsIncomplete: true
      })
      isComplete &&= sessionFiles.isComplete
      if (
        projectId !== expectedProjectId &&
        (sessionFiles.names.includes(fileName) ||
          sessionFiles.quarantinedPrimaryFileNames.includes(fileName))
      ) {
        belongsToAnotherProject = true
      }
    }

    if (!isComplete) {
      throw new Error('Cannot save a Session while its global identity ownership is unreadable.')
    }
    if (belongsToAnotherProject) {
      throw new Error('Cannot save a Session id that is already owned by another Project.')
    }
  }

  // Reports whether the live sessions tree was fully scanned so DB reconciliation never acts on a
  // partial read. Project recovery owns tombstone cleanup before ordinary hydration is allowed.
  async loadAllWithDiagnostics(options: SessionScanOptions = {}): Promise<SessionLoadDiagnostics> {
    const quarantineInvalidFiles = options.mode !== 'read-only'
    const scanMetrics: SessionScanMetrics = {
      projectDirectoryCount: 0,
      sessionFileCount: 0,
      sessionBytes: 0
    }
    const { sessions, isComplete, warnings } = await this.readAllSessions({
      quarantineInvalidFiles,
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
    expectedRevision?: number
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(session.projectId, session.id, () =>
      this.saveSessionNow(session, expectedRevision)
    )
  }

  private async saveSessionNow(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession> {
    const key = `${session.projectId}:${session.id}`
    let actualRevision = Math.max(sessionRevision(session), this.sessionRevisions.get(key) ?? 0)
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new Error('Session expected revision must be a non-negative integer.')
    }
    await this.assertExistingSessionWithinLimit(this.sessionFilePath(session.projectId, session.id))
    if (expectedRevision !== undefined) {
      const current = await loadSessionMutationAuthority(this, session.projectId, session.id)
      if (current.status === 'unreadable') {
        throw new Error('Cannot compare Session revision because durable JSON is unreadable.')
      }
      actualRevision = current.status === 'found' ? sessionRevision(current.session) : 0
      if (actualRevision !== expectedRevision) {
        throw new SessionRevisionConflictError(expectedRevision, actualRevision)
      }
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
    const unprojectedWrite = this.prepareSessionWrite(
      projectionWillAssignNumber
        ? { ...unprojectedDurableSession, number: Number.MAX_SAFE_INTEGER }
        : unprojectedDurableSession
    )

    if (this.projection && this.projectionWritesSuspended) {
      assertSessionProjectionStorageShape(session)
    }
    const projectedSession =
      this.projection && !this.projectionWritesSuspended
        ? await this.projection.prepareSave(session)
        : session
    const durableSession: PersistedChatSession = {
      ...projectedSession,
      revision: nextRevision
    }
    await this.writeSession(
      durableSession,
      projectedSession === session && !projectionWillAssignNumber
        ? unprojectedWrite
        : this.prepareSessionWrite(durableSession)
    )
    if (this.projectionWritesSuspended) {
      this.suspendedProjectionSessionWrites.set(key, {
        projectId: session.projectId,
        sessionId: session.id
      })
    } else {
      await this.projection?.commitSave(durableSession)
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
      const durableSession: PersistedChatSession = {
        ...session,
        revision: nextSessionRevision(
          Math.max(sessionRevision(session), this.sessionRevisions.get(key) ?? 0)
        )
      }
      await this.writeSessionToDirectory(durableSession, this.deletedProjectDir(session.projectId))
      if (this.projectionWritesSuspended) this.suspendedProjectionCatalogMutation = true
      this.sessionRevisions.set(key, durableSession.revision!)
    })
  }

  // Removes a single session file.
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.deleteSessionNow(projectId, sessionId)
    )
  }

  private async deleteSessionNow(projectId: string, sessionId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId)
    const safeSessionId = assertSafeSegment(sessionId)
    const diagnostic = await this.loadSessionWithDiagnostics(safeProjectId, safeSessionId)
    if (diagnostic.status === 'unreadable') {
      throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
    }
    const revisionKey = `${safeProjectId}:${safeSessionId}`
    if (diagnostic.status === 'missing') {
      this.sessionRevisions.delete(revisionKey)
      if (this.projectionWritesSuspended) {
        this.suspendedProjectionSessionWrites.set(revisionKey, {
          projectId: safeProjectId,
          sessionId: safeSessionId
        })
      } else {
        await this.projection?.markPending(safeProjectId, safeSessionId, 'delete')
        await this.projection
          ?.commitDelete(safeProjectId, safeSessionId)
          .catch((error: unknown) => {
            throw new SessionDeletionCommittedError(error)
          })
      }
      return
    }

    if (!this.projectionWritesSuspended) {
      await this.projection?.markPending(safeProjectId, safeSessionId, 'delete')
    }

    // The valid primary proves matching quarantines are superseded authority covered by this
    // explicit Session deletion. Remove every backup first so any failure leaves that proof in
    // place and the operation safely retryable; only then remove the current primary.
    const primaryPath = this.sessionFilePath(safeProjectId, safeSessionId)
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
    await this.dependencies.remove(primaryPath, {
      force: true,
      recursive: false
    })
    this.sessionRevisions.delete(revisionKey)
    if (this.projectionWritesSuspended) {
      this.suspendedProjectionSessionWrites.set(revisionKey, {
        projectId: safeProjectId,
        sessionId: safeSessionId
      })
    } else {
      await this.projection?.commitDelete(safeProjectId, safeSessionId).catch((error: unknown) => {
        throw new SessionDeletionCommittedError(error)
      })
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
      await writeFile(join(liveProjectDir, PROJECT_DELETION_COMMIT_MARKER), '', 'utf8')
      await rename(liveProjectDir, deletedProjectDir)
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

  // Writes through a unique temp file, then atomically replaces the target session file.
  private prepareSessionWrite(session: PersistedChatSession): PreparedSessionWrite {
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    const legacyUpload = messages
      .flatMap((message) => message.uploads ?? [])
      .find((upload) => !upload.versionId)
    if (legacyUpload) {
      throw new Error(
        `Session upload must be upgraded to an immutable Version before persistence: ${legacyUpload.id}`
      )
    }
    const sanitizedSession = sanitizeSessionUploadedAttachments(session)
    return {
      sanitizedSession,
      contents: this.serializeJsonForWrite(
        createSessionFile(encodeSessionDataPaths(sanitizedSession)),
        this.dependencies.maxSessionBytes
      )
    }
  }

  private async writeSession(
    session: PersistedChatSession,
    preparedWrite = this.prepareSessionWrite(session)
  ): Promise<void> {
    await this.ensureDirectoryBoundary(this.sessionsDir, 'Active Session root')
    await this.writeSessionToDirectory(session, this.projectDir(session.projectId), preparedWrite)
  }

  private async writeSessionToDirectory(
    session: PersistedChatSession,
    projectDirectory: string,
    preparedWrite = this.prepareSessionWrite(session)
  ): Promise<void> {
    const filePath = join(projectDirectory, `${assertSafeSegment(session.id)}.json`)
    const { sanitizedSession, contents } = preparedWrite

    await this.ensureDirectoryBoundary(projectDirectory, 'Session Project directory')
    await this.assertFileBoundary(filePath, 'Session file')
    await this.assertExistingSessionWithinLimit(filePath)
    await this.preservePreS2Backup(filePath, sanitizedSession)
    await this.preservePreSubagentModelBackup(filePath, sanitizedSession)
    await this.ensureDirectoryBoundary(projectDirectory, 'Session Project directory')
    await this.assertFileBoundary(filePath, 'Session file')
    await this.atomicWriteContents(filePath, contents)
  }

  private async assertExistingSessionWithinLimit(filePath: string): Promise<void> {
    try {
      if ((await lstat(filePath)).size > this.dependencies.maxSessionBytes) {
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      }
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
  }

  private async readSessionFileForBackup(filePath: string): Promise<string | undefined> {
    try {
      return await this.dependencies.readSessionFileWithinLimit(
        filePath,
        this.dependencies.maxSessionBytes
      )
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      if (error instanceof DurableJsonReadLimitError) {
        throw new SessionSizeLimitError(this.dependencies.maxSessionBytes)
      }
      throw error
    }
  }

  private async preservePreS2Backup(
    filePath: string,
    nextSession: PersistedChatSession
  ): Promise<void> {
    const writesS2Attempt = nextSession.runtimeContext?.delegatedWork?.records.some((record) =>
      record.attempts.some((attempt) => Boolean(attempt.initiatingTurnMessageId))
    )
    if (!writesS2Attempt) return

    const currentRaw = await this.readSessionFileForBackup(filePath)
    if (currentRaw === undefined) return
    let current: unknown
    try {
      current = JSON.parse(currentRaw) as unknown
    } catch {
      // The normal read path owns corrupt-file quarantine. Never replace unreadable authority while
      // attempting the version-gated backup.
      throw new Error('Cannot preserve the pre-S2 Session backup from unreadable JSON.')
    }
    const currentWritesS2Attempt = hasS2AttemptSchema(current)
    const backupPath = `${filePath}${PRE_S2_BACKUP_SUFFIX}`
    if (currentWritesS2Attempt) {
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
    try {
      await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL)
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
    const currentRaw = await this.readSessionFileForBackup(filePath)
    if (currentRaw === undefined) return
    let current: unknown
    try {
      current = JSON.parse(currentRaw) as unknown
    } catch {
      throw new Error('Cannot preserve the pre-Subagent-model Session backup from unreadable JSON.')
    }
    const backupPath = `${filePath}${PRE_SUBAGENT_MODEL_BACKUP_SUFFIX}`
    if (hasSubagentModelAttemptSchema(current)) {
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
    try {
      await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL)
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
    await writeDurableJsonFile(filePath, contents, {
      remove: this.dependencies.remove,
      rename: this.dependencies.renameFile,
      wait: this.dependencies.wait
    })
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
      const project = await this.readProjectSessions(projectId, {
        missingDirectoryIsIncomplete: true,
        quarantineInvalidFiles: options.quarantineInvalidFiles,
        warnings,
        scanMetrics: options.scanMetrics,
        sessionsBoundaryValidated: true
      })
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
    const directoryBoundary = await this.inspectDirectoryBoundary(projectDir)
    if (directoryBoundary === 'invalid') {
      return { sessions: [], isComplete: false }
    }
    let recoveryComplete = true
    try {
      await recoverDurableJsonDirectory(
        projectDir,
        (filePath, contents) => this.decodeSessionContents(filePath, projectId, contents),
        {
          readDirectoryEntries: this.dependencies.readDirectoryEntries,
          readFile: this.dependencies.readSessionFile,
          readFileWithinLimit: this.dependencies.readSessionFileWithinLimit,
          remove: this.dependencies.remove,
          rename: this.dependencies.renameFile,
          wait: this.dependencies.wait
        },
        { maxBytes: this.dependencies.maxSessionBytes }
      )
    } catch (error) {
      recoveryComplete = false
      if (error instanceof DurableJsonReadLimitError) {
        const primaryFileName = RECOVERABLE_TEMPORARY_FILE_PATTERN.exec(error.fileName)?.[1]
        if (primaryFileName) {
          options.warnings?.push({
            kind: 'too-large',
            projectId,
            fileName: primaryFileName,
            recovered: false
          })
        }
      }
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
      read = await readDurableJsonFile(
        filePath,
        (contents) =>
          this.decodeSessionContents(filePath, projectId, contents, options.preserveRuntimeState),
        {
          readDirectoryEntries: this.dependencies.readDirectoryEntries,
          readFile: this.dependencies.readSessionFile,
          readFileWithinLimit: this.dependencies.readSessionFileWithinLimit,
          remove: this.dependencies.remove,
          rename: this.dependencies.renameFile,
          wait: this.dependencies.wait
        },
        { maxBytes: this.dependencies.maxSessionBytes }
      )
    } catch (error) {
      if (error instanceof DurableJsonReadLimitError) {
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
      if (error instanceof UnsupportedSessionFileError) {
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
      if (!options.missingIsIncomplete) return { isComplete: true }
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
    if (initialBoundary === 'missing' && (await this.inspectFileBoundary(filePath)) !== 'valid') {
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

  private decodeSessionContents(
    filePath: string,
    projectId: string,
    contents: string,
    preserveRuntimeState?: boolean
  ): { session: PersistedChatSession; bytes: number } {
    const decoded = decodeSessionFile(JSON.parse(contents) as unknown, {
      preserveLegacyUploadPaths: true,
      preserveRuntimeState:
        preserveRuntimeState === true
          ? true
          : (sessionId) =>
              this.dependencies.hasActiveRuntimePrompt(projectId, sessionId) ||
              this.dependencies.hasLiveRuntimeSession(projectId, sessionId)
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
      bytes: Buffer.byteLength(contents, 'utf8')
    }
  }

  // ENOENT is an authoritative empty directory; any other readdir failure is a partial scan.
  private async listDirectoryNames(dir: string): Promise<{ names: string[]; isComplete: boolean }> {
    const boundary = await this.inspectDirectoryBoundary(dir)
    if (boundary !== 'valid') {
      return { names: [], isComplete: boundary === 'missing' }
    }
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        isComplete: entries.every((entry) => entry.isDirectory() || entry.isFile())
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) }
    }
  }

  // Lists only committed session JSON files. Quarantines are associated with their former primary so
  // terminal scans can distinguish orphan authority from a backup superseded by valid current JSON.
  // In-progress temp writes stay excluded and non-ENOENT directory failures disable reconciliation.
  private async listSessionFileNames(
    dir: string,
    options: { missingIsIncomplete?: boolean; directoryBoundaryValidated?: boolean } = {}
  ): Promise<{
    names: string[]
    isComplete: boolean
    quarantinedPrimaryFileNames: string[]
  }> {
    if (!options.directoryBoundaryValidated) {
      const boundary = await this.inspectDirectoryBoundary(dir)
      if (boundary !== 'valid') {
        return {
          names: [],
          isComplete: boundary === 'missing' && !options.missingIsIncomplete,
          quarantinedPrimaryFileNames: []
        }
      }
    }
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !entry.name.includes('.tmp') &&
              !entry.name.includes('.invalid-')
          )
          .map((entry) => entry.name),
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
        quarantinedPrimaryFileNames: []
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
export type { ProjectSessionDeletionState, ProjectSessionLoadDiagnostics, SessionLoadDiagnostic }
export type { SessionLoadDiagnostics, SessionScanMetrics }
