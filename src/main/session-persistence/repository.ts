import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  normalizeSessionFile,
  sanitizeSessionUploadedAttachments,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest,
  type SessionLoadFailure,
  type SessionLoadWarning
} from '../../shared/session-persistence'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'

const SESSIONS_DIR = 'sessions'
const DELETED_SESSIONS_DIR = 'deleted-sessions'
const PROJECT_DELETION_COMMIT_MARKER = '.project-deletion-committed'
const MANIFEST_FILE = 'manifest.json'
const FILE_REPLACEMENT_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const
const PRE_S2_BACKUP_SUFFIX = '.pre-s2-backup'
const PRE_SUBAGENT_MODEL_BACKUP_SUFFIX = '.pre-subagent-model-backup'

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
}

type SessionLoadDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

type ProjectSessionLoadDiagnostics = {
  sessions: PersistedChatSession[]
  isComplete: boolean
}

type ProjectSessionDeletionState = 'live' | 'legacy-committed' | 'prepared' | 'absent'

type SessionDirectoryEntry = {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

type SessionRepositoryDependencies = {
  hasActiveRuntimePrompt(projectId: string, sessionId: string): boolean
  remove(path: string, options: { force: boolean; recursive: boolean }): Promise<void>
  readDirectoryEntries(path: string): Promise<SessionDirectoryEntry[]>
  readManifestFile(path: string): Promise<string>
  readSessionFile(path: string): Promise<string>
  renameFile(source: string, destination: string): Promise<void>
  wait(delayMs: number): Promise<void>
}

const DEFAULT_DEPENDENCIES: SessionRepositoryDependencies = {
  hasActiveRuntimePrompt: () => false,
  remove: (path, options) => rm(path, options),
  readDirectoryEntries: (path) => readdir(path, { withFileTypes: true }),
  readManifestFile: (path) => readFile(path, 'utf8'),
  readSessionFile: (path) => readFile(path, 'utf8'),
  renameFile: (source, destination) => rename(source, destination),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
}

const isRetryableFileReplacementError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(String((error as { code?: unknown }).code))

// Production storage lives under ~/.open-science; dev builds use an isolated sibling directory.
export const PROD_SESSION_DIR_NAME = '.open-science'
export const DEV_SESSION_DIR_NAME = '.open-science-project'

// Builds the app-owned session directory in the user's home folder. Kept pure (no electron) so it
// stays unit-testable; the dev/prod choice is applied by the main-only resolveStorageRoot helper.
const getSessionPersistenceDir = (
  homePath: string,
  dirName: string = PROD_SESSION_DIR_NAME
): string => join(homePath, dirName)

// Rejects path segments that could escape the sessions tree. Real session/project ids are id-like, so
// this only guards against corrupt or malicious values before they become file paths.
const assertSafeSegment = (segment: string): string => {
  if (
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

// Owns per-session durable reads/writes: one file per session under sessions/<projectId>/<id>.json,
// plus a small manifest for the last-open selection. Writes are serialized and atomic (temp + rename),
// while malformed JSON is backed up and I/O failures preserve the existing file for later recovery.
class SessionRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0
  private backupSequence = 0
  private readonly dependencies: SessionRepositoryDependencies

  constructor(
    private readonly storageDir: string,
    dependencies: Partial<SessionRepositoryDependencies> = {}
  ) {
    this.dependencies = {
      hasActiveRuntimePrompt:
        dependencies.hasActiveRuntimePrompt ?? DEFAULT_DEPENDENCIES.hasActiveRuntimePrompt,
      remove: dependencies.remove ?? DEFAULT_DEPENDENCIES.remove,
      readDirectoryEntries:
        dependencies.readDirectoryEntries ?? DEFAULT_DEPENDENCIES.readDirectoryEntries,
      readManifestFile: dependencies.readManifestFile ?? DEFAULT_DEPENDENCIES.readManifestFile,
      readSessionFile: dependencies.readSessionFile ?? DEFAULT_DEPENDENCIES.readSessionFile,
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

  private sessionFilePath(projectId: string, sessionId: string): string {
    return join(this.projectDir(projectId), `${assertSafeSegment(sessionId)}.json`)
  }

  private deletedProjectDir(projectId: string): string {
    return join(this.deletedSessionsDir, assertSafeSegment(projectId))
  }

  // Loads every per-session file plus the manifest.
  async loadAll(): Promise<LoadAllSessionsResult> {
    const scan = await this.loadAllWithDiagnostics()
    return scan.result
  }

  // Loads one durable session directly instead of scanning every project/session file. Reviewer fix
  // loops call this after each correction turn so every re-review sees newly persisted messages rather
  // than retaining the snapshot that existed when the initial review started.
  async loadSession(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession | undefined> {
    const safeProjectId = assertSafeSegment(projectId)
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
    const read = await this.readSessionFile(
      this.sessionFilePath(safeProjectId, safeSessionId),
      safeProjectId,
      { quarantineInvalidFiles: options.mode !== 'read-only' }
    )
    if (!read.isComplete || read.wasQuarantined) return { status: 'unreadable' }

    const quarantine = await this.hasQuarantinedSessionFile(safeProjectId, safeSessionId)
    if (!quarantine.isComplete) return { status: 'unreadable' }
    if (read.session) return { status: 'found', session: read.session }
    return quarantine.exists ? { status: 'unreadable' } : { status: 'missing' }
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
    const manifestRead = await this.readManifest({ quarantineInvalidFiles })

    return {
      result: { sessions, manifest: manifestRead.manifest },
      // The manifest is only a last-open pointer. It must never make a complete Session authority
      // scan read-only; a later selection write will retry persistence through the normal saver.
      isComplete,
      warnings: manifestRead.warning ? [...warnings, manifestRead.warning] : warnings,
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
    return this.readProjectSessionsAtDirectory(
      safeProjectId,
      this.deletedProjectDir(safeProjectId),
      {
        quarantinedIsIncomplete: true
      }
    )
  }

  // Writes one session file (serialized through the save queue to preserve write order).
  async saveSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(() => this.writeSession(session))
  }

  async saveCommittedProjectSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.getProjectSessionDeletionState(session.projectId)) !== 'legacy-committed') {
        throw new Error('Cannot save a Session outside committed Project deletion authority.')
      }
      await this.writeSessionToDirectory(session, this.deletedProjectDir(session.projectId))
    })
  }

  // Removes a single session file.
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const safeProjectId = assertSafeSegment(projectId)
      const safeSessionId = assertSafeSegment(sessionId)
      const diagnostic = await this.loadSessionWithDiagnostics(safeProjectId, safeSessionId)
      if (diagnostic.status === 'unreadable') {
        throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
      }
      if (diagnostic.status === 'missing') return

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
    })
  }

  // Atomically moves a marked live directory into the durable deletion area. The marker/tombstone is
  // retained until Project deletion finishes so recovery can distinguish a committed Session phase
  // from an attempt that failed before the rename, including for Projects with no Session files.
  async deleteProjectSessions(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const safeProjectId = assertSafeSegment(projectId)
      const state = await this.getProjectSessionDeletionState(safeProjectId)
      if (state === 'legacy-committed' || state === 'prepared') return

      const liveProjectDir = this.projectDir(safeProjectId)
      const deletedProjectDir = this.deletedProjectDir(safeProjectId)
      await mkdir(this.deletedSessionsDir, { recursive: true })
      await this.dependencies.remove(deletedProjectDir, { recursive: true, force: true })
      await mkdir(liveProjectDir, { recursive: true })
      await writeFile(join(liveProjectDir, PROJECT_DELETION_COMMIT_MARKER), '', 'utf8')
      await rename(liveProjectDir, deletedProjectDir)
    })
  }

  async getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    const safeProjectId = assertSafeSegment(projectId)
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
    await this.enqueue(async () => {
      if ((await this.getProjectSessionDeletionState(projectId)) !== 'legacy-committed') return
      await this.atomicWrite(
        join(this.deletedProjectDir(assertSafeSegment(projectId)), PROJECT_DELETION_COMMIT_MARKER),
        ''
      )
    })
  }

  async completeProjectSessionDeletion(projectId: string): Promise<void> {
    await this.enqueue(() =>
      this.dependencies.remove(this.deletedProjectDir(assertSafeSegment(projectId)), {
        recursive: true,
        force: true
      })
    )
  }

  async listLegacyProjectSessionTombstones(): Promise<string[]> {
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
    return this.enqueue(() => this.writeManifest(request))
  }

  // Serializes writes so an older save cannot finish after a newer one.
  private enqueue(operation: () => Promise<unknown>): Promise<void> {
    const run = this.saveQueue.then(() => operation()).then(() => undefined)

    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  // Writes through a unique temp file, then atomically replaces the target session file.
  private async writeSession(session: PersistedChatSession): Promise<void> {
    await this.writeSessionToDirectory(session, this.projectDir(session.projectId))
  }

  private async writeSessionToDirectory(
    session: PersistedChatSession,
    projectDirectory: string
  ): Promise<void> {
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    const legacyUpload = messages
      .flatMap((message) => message.uploads ?? [])
      .find((upload) => !upload.versionId)
    if (legacyUpload) {
      throw new Error(
        `Session upload must be upgraded to an immutable Version before persistence: ${legacyUpload.id}`
      )
    }
    const filePath = join(projectDirectory, `${assertSafeSegment(session.id)}.json`)
    const sanitizedSession = sanitizeSessionUploadedAttachments(session)

    await mkdir(projectDirectory, { recursive: true })
    await this.preservePreS2Backup(filePath, sanitizedSession)
    await this.preservePreSubagentModelBackup(filePath, sanitizedSession)
    await this.atomicWrite(filePath, createSessionFile(encodeSessionDataPaths(sanitizedSession)))
  }

  private async preservePreS2Backup(
    filePath: string,
    nextSession: PersistedChatSession
  ): Promise<void> {
    const writesS2Attempt = nextSession.runtimeContext?.delegatedWork?.records.some((record) =>
      record.attempts.some((attempt) => Boolean(attempt.initiatingTurnMessageId))
    )
    if (!writesS2Attempt) return

    let currentRaw: string
    try {
      currentRaw = await this.dependencies.readSessionFile(filePath)
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
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
    let currentRaw: string
    try {
      currentRaw = await this.dependencies.readSessionFile(filePath)
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
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
    await mkdir(this.sessionsDir, { recursive: true })
    await this.atomicWrite(this.manifestPath, normalizeSessionManifest(request))
  }

  // Shared temp-file + rename write used by session files and the manifest.
  private async atomicWrite(filePath: string, payload: unknown): Promise<void> {
    this.writeSequence += 1
    const temporaryPath = `${filePath}.${Date.now()}-${this.writeSequence}.tmp`

    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.dependencies.renameFile(temporaryPath, filePath)
          return
        } catch (error) {
          const delayMs = FILE_REPLACEMENT_RETRY_DELAYS_MS[attempt]
          if (delayMs === undefined || !isRetryableFileReplacementError(error)) throw error
          await this.dependencies.wait(delayMs)
        }
      }
    } catch (error) {
      await this.dependencies
        .remove(temporaryPath, { recursive: false, force: true })
        .catch(() => undefined)
      throw error
    }
  }

  private async readManifest(options: { quarantineInvalidFiles: boolean }): Promise<{
    manifest: PersistedSessionManifest
    warning?: SessionLoadWarning
  }> {
    let raw: string
    try {
      raw = await this.dependencies.readManifestFile(this.manifestPath)
    } catch (error) {
      if (!isMissingFileError(error)) {
        return {
          manifest: createEmptySessionManifest(),
          warning: {
            kind: 'manifest-unreadable',
            fileName: MANIFEST_FILE,
            recovered: false
          }
        }
      }
      return {
        manifest: createEmptySessionManifest()
      }
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Invalid Session manifest')
      }
      return {
        manifest: normalizeSessionManifest(parsed)
      }
    } catch {
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
        scanMetrics: options.scanMetrics
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
    } = {}
  ): Promise<ProjectSessionLoadDiagnostics> {
    const projectId = assertSafeSegment(projectIdValue)
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
    const sessionFiles = await this.listSessionFileNames(projectDir, {
      missingIsIncomplete: options.missingDirectoryIsIncomplete
    })
    const sessions: PersistedChatSession[] = []
    const activeQuarantines = new Set(sessionFiles.quarantinedPrimaryFileNames)
    if (options.scanMetrics) options.scanMetrics.sessionFileCount += sessionFiles.names.length
    const warnedFiles = new Set<string>()
    let isComplete = sessionFiles.isComplete

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
    } = {}
  ): Promise<{
    session?: PersistedChatSession
    isComplete: boolean
    wasQuarantined?: boolean
    warning?: SessionLoadWarning
  }> {
    let raw: string
    try {
      raw = await this.dependencies.readSessionFile(filePath)
    } catch (error) {
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
    if (options.scanMetrics) options.scanMetrics.sessionBytes += Buffer.byteLength(raw, 'utf8')

    try {
      const session = normalizeSessionFile(JSON.parse(raw) as unknown, {
        preserveLegacyUploadPaths: true,
        preserveRuntimeState: (sessionId) =>
          this.dependencies.hasActiveRuntimePrompt(projectId, sessionId)
      })
      if (!session) {
        const wasQuarantined =
          options.quarantineInvalidFiles !== false && (await this.tryBackupInvalidFile(filePath))
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

      return { session: decodeSessionDataPaths({ ...session, projectId }), isComplete: true }
    } catch {
      const wasQuarantined =
        options.quarantineInvalidFiles !== false && (await this.tryBackupInvalidFile(filePath))
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

  // ENOENT is an authoritative empty directory; any other readdir failure is a partial scan.
  private async listDirectoryNames(dir: string): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await this.dependencies.readDirectoryEntries(dir)

      return {
        names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        isComplete: true
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
    options: { missingIsIncomplete?: boolean } = {}
  ): Promise<{
    names: string[]
    isComplete: boolean
    quarantinedPrimaryFileNames: string[]
  }> {
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
        isComplete: true,
        quarantinedPrimaryFileNames: entries.flatMap((entry) => {
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
    await rename(filePath, `${filePath}.invalid-${Date.now()}-${this.backupSequence}`)
  }
}

// Distinguishes first-run missing storage from malformed files that deserve a backup.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

export { SessionRepository, getSessionPersistenceDir }
export type { ProjectSessionDeletionState, ProjectSessionLoadDiagnostics, SessionLoadDiagnostic }
export type { SessionLoadDiagnostics, SessionScanMetrics }
