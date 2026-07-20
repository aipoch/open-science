import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  normalizeSessionFile,
  sanitizeSessionMessageImages,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest
} from '../../shared/session-persistence'
import { decodeSessionDataPaths, encodeSessionDataPaths } from './session-data-paths'

const SESSIONS_DIR = 'sessions'
const DELETED_SESSIONS_DIR = 'deleted-sessions'
const MANIFEST_FILE = 'manifest.json'

type SessionLoadDiagnostics = {
  result: LoadAllSessionsResult
  // False means at least one directory or session file could not be read or safely quarantined.
  // Callers may hydrate the returned sessions but must not reconcile absent index rows as deletions.
  isComplete: boolean
}

type SessionRepositoryDependencies = {
  remove(path: string, options: { force: boolean; recursive: boolean }): Promise<void>
}

const DEFAULT_DEPENDENCIES: SessionRepositoryDependencies = {
  remove: (path, options) => rm(path, options)
}

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
// and unreadable files are backed up rather than dropped.
class SessionRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0
  private backupSequence = 0

  constructor(
    private readonly storageDir: string,
    private readonly dependencies: SessionRepositoryDependencies = DEFAULT_DEPENDENCIES
  ) {}

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
    return (await this.loadAllWithDiagnostics()).result
  }

  // Reports whether the sessions tree was fully scanned so DB reconciliation never acts on a partial
  // read. Cleanup of previously renamed project tombstones is best-effort and does not re-expose them.
  async loadAllWithDiagnostics(): Promise<SessionLoadDiagnostics> {
    await this.cleanupDeletedProjects()
    const { sessions, isComplete } = await this.readAllSessions()
    const manifest = await this.readManifest()

    return { result: { sessions, manifest }, isComplete }
  }

  // Writes one session file (serialized through the save queue to preserve write order).
  async saveSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(() => this.writeSession(session))
  }

  // Removes a single session file.
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => rm(this.sessionFilePath(projectId, sessionId), { force: true }))
  }

  // Atomically removes the project from the readable sessions tree before best-effort cleanup.
  async deleteProjectSessions(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const deletedProjectDir = this.deletedProjectDir(projectId)
      await mkdir(this.deletedSessionsDir, { recursive: true })

      try {
        await rename(this.projectDir(projectId), deletedProjectDir)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }

      // Once renamed, the session JSON is logically deleted. Cleanup can safely retry on startup.
      await this.removeDeletedProject(deletedProjectDir)
    })
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
    const filePath = this.sessionFilePath(session.projectId, session.id)
    const sanitizedSession = sanitizeSessionMessageImages(session)

    await mkdir(this.projectDir(session.projectId), { recursive: true })
    await this.atomicWrite(filePath, createSessionFile(encodeSessionDataPaths(sanitizedSession)))
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
    await rename(temporaryPath, filePath)
  }

  private async cleanupDeletedProjects(): Promise<void> {
    const deletedProjects = await this.listDirectoryNames(this.deletedSessionsDir)
    for (const projectId of deletedProjects.names) {
      await this.removeDeletedProject(join(this.deletedSessionsDir, projectId))
    }
  }

  // Physical cleanup happens after the atomic rename removed the directory from the readable tree.
  // Failures are intentionally swallowed because startup will retry the tombstone later.
  private async removeDeletedProject(path: string): Promise<void> {
    await this.dependencies.remove(path, { recursive: true, force: true }).catch(() => undefined)
  }

  private async readManifest(): Promise<PersistedSessionManifest> {
    try {
      const raw = await readFile(this.manifestPath, 'utf8')

      return normalizeSessionManifest(JSON.parse(raw) as unknown)
    } catch {
      return createEmptySessionManifest()
    }
  }

  // Reads every project directory's session files and propagates completeness across every level.
  // Invalid files count as handled only when they were successfully moved aside.
  private async readAllSessions(): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }> {
    const projectDirectories = await this.listDirectoryNames(this.sessionsDir)
    const sessions: PersistedChatSession[] = []
    let isComplete = projectDirectories.isComplete

    for (const projectId of projectDirectories.names) {
      const projectDir = join(this.sessionsDir, projectId)
      const sessionFiles = await this.listSessionFileNames(projectDir)
      isComplete &&= sessionFiles.isComplete

      for (const fileName of sessionFiles.names) {
        // The directory is the authoritative owning project, regardless of the file's stored projectId.
        const read = await this.readSessionFile(join(projectDir, fileName), projectId)
        isComplete &&= read.isComplete

        if (read.session) sessions.push(read.session)
      }
    }

    return { sessions, isComplete }
  }

  private async readSessionFile(
    filePath: string,
    projectId: string
  ): Promise<{ session?: PersistedChatSession; isComplete: boolean }> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const session = normalizeSessionFile(JSON.parse(raw) as unknown)

      if (!session) {
        return { isComplete: await this.tryBackupInvalidFile(filePath) }
      }

      return { session: decodeSessionDataPaths({ ...session, projectId }), isComplete: true }
    } catch (error) {
      if (isMissingFileError(error)) return { isComplete: true }
      return { isComplete: await this.tryBackupInvalidFile(filePath) }
    }
  }

  // ENOENT is an authoritative empty directory; any other readdir failure is a partial scan.
  private async listDirectoryNames(dir: string): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })

      return {
        names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        isComplete: true
      }
    } catch (error) {
      return { names: [], isComplete: isMissingFileError(error) }
    }
  }

  // Lists only committed session JSON files. In-progress temp writes and quarantined invalid files are
  // excluded, while non-ENOENT directory failures keep reconciliation disabled.
  private async listSessionFileNames(
    dir: string
  ): Promise<{ names: string[]; isComplete: boolean }> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })

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
export type { SessionLoadDiagnostics }
