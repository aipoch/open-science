import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createEmptySessionManifest,
  createSessionFile,
  normalizeSessionFile,
  normalizeSessionManifest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type PersistedSessionManifest,
  type SaveSessionManifestRequest
} from '../../shared/session-persistence'

const SESSIONS_DIR = 'sessions'
const MANIFEST_FILE = 'manifest.json'

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

  constructor(private readonly storageDir: string) {}

  private get sessionsDir(): string {
    return join(this.storageDir, SESSIONS_DIR)
  }

  private get manifestPath(): string {
    return join(this.sessionsDir, MANIFEST_FILE)
  }

  private projectDir(projectId: string): string {
    return join(this.sessionsDir, assertSafeSegment(projectId))
  }

  private sessionFilePath(projectId: string, sessionId: string): string {
    return join(this.projectDir(projectId), `${assertSafeSegment(sessionId)}.json`)
  }

  // Loads every per-session file plus the manifest.
  async loadAll(): Promise<LoadAllSessionsResult> {
    const sessions = await this.readAllSessions()
    const manifest = await this.readManifest()

    return { sessions, manifest }
  }

  // Writes one session file (serialized through the save queue to preserve write order).
  async saveSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(() => this.writeSession(session))
  }

  // Removes a single session file.
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => rm(this.sessionFilePath(projectId, sessionId), { force: true }))
  }

  // Removes an entire project's session directory (used when a project is deleted).
  async deleteProjectSessions(projectId: string): Promise<void> {
    return this.enqueue(() => rm(this.projectDir(projectId), { recursive: true, force: true }))
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

    await mkdir(this.projectDir(session.projectId), { recursive: true })
    await this.atomicWrite(filePath, createSessionFile(session))
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

  private async readManifest(): Promise<PersistedSessionManifest> {
    try {
      const raw = await readFile(this.manifestPath, 'utf8')

      return normalizeSessionManifest(JSON.parse(raw) as unknown)
    } catch {
      return createEmptySessionManifest()
    }
  }

  // Reads every project directory's session files, backing up any that are unreadable.
  private async readAllSessions(): Promise<PersistedChatSession[]> {
    const projectIds = await this.listDirectoryNames(this.sessionsDir)
    const sessions: PersistedChatSession[] = []

    for (const projectId of projectIds) {
      const projectDir = join(this.sessionsDir, projectId)
      const fileNames = await this.listSessionFileNames(projectDir)

      for (const fileName of fileNames) {
        // The directory is the authoritative owning project, regardless of the file's stored projectId.
        const session = await this.readSessionFile(join(projectDir, fileName), projectId)

        if (session) sessions.push(session)
      }
    }

    return sessions
  }

  private async readSessionFile(
    filePath: string,
    projectId: string
  ): Promise<PersistedChatSession | undefined> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const session = normalizeSessionFile(JSON.parse(raw) as unknown)

      if (!session) {
        await this.backupInvalidFile(filePath)

        return undefined
      }

      return { ...session, projectId }
    } catch (error) {
      if (!isMissingFileError(error)) {
        await this.backupInvalidFile(filePath).catch(() => undefined)
      }

      return undefined
    }
  }

  private async listDirectoryNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })

      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  // Only committed session JSON files; skips in-progress temp writes and backed-up invalid files.
  private async listSessionFileNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })

      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            !entry.name.includes('.tmp') &&
            !entry.name.includes('.invalid-')
        )
        .map((entry) => entry.name)
    } catch {
      return []
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
