import { mkdir, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

import type { ComputeJobSessionOwner } from './job-repository'

const isSafeSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  !segment.includes('\0')

const assertSafeSegment = (segment: string, label: string): string => {
  if (!isSafeSegment(segment)) {
    throw new Error(`Invalid Session cache ${label}: ${segment}`)
  }
  return segment
}

const assertSafeFilename = (filename: string): string => {
  if (
    filename.length === 0 ||
    filename !== basename(filename) ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new Error(`Invalid Session cache filename: ${filename}`)
  }
  return filename
}

export class SessionCacheOwner {
  private readonly root: string
  private readonly activeOperations = new Map<string, Set<Promise<void>>>()
  private readonly closedProjects = new Set<string>()
  private readonly closedSessions = new Set<string>()

  constructor(storageRoot: string) {
    this.root = join(storageRoot, 'compute', 'session-cache')
  }

  async createOperationFile(
    projectId: string,
    sessionId: string,
    filename: string
  ): Promise<{ operationId: string; path: string; release(): void }> {
    const safeFilename = assertSafeFilename(filename)
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    const safeSessionId = assertSafeSegment(sessionId, 'Session id')
    const release = this.registerOperation(safeProjectId, safeSessionId)
    const operationId = randomUUID()
    const directory = join(this.root, safeProjectId, safeSessionId, operationId)
    try {
      await mkdir(directory, { recursive: true })
      return { operationId, path: join(directory, safeFilename), release }
    } catch (error) {
      release()
      throw error
    }
  }

  removeOperation(projectId: string, sessionId: string, operationId: string): Promise<void> {
    return rm(
      join(
        this.root,
        assertSafeSegment(projectId, 'Project id'),
        assertSafeSegment(sessionId, 'Session id'),
        assertSafeSegment(operationId, 'operation id')
      ),
      { recursive: true, force: true }
    )
  }

  async removeSession(projectId: string, sessionId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    const safeSessionId = assertSafeSegment(sessionId, 'Session id')
    const key = this.sessionKey(safeProjectId, safeSessionId)
    this.closedSessions.add(key)
    await Promise.all(this.activeOperations.get(key) ?? [])
    await rm(join(this.root, safeProjectId, safeSessionId), { recursive: true, force: true })
  }

  async removeProject(projectId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    this.closedProjects.add(safeProjectId)
    const prefix = `${safeProjectId}/`
    await Promise.all(
      [...this.activeOperations.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, operations]) => [...operations])
    )
    await rm(join(this.root, safeProjectId), {
      recursive: true,
      force: true
    })
  }

  async reconcileActiveSessions(
    sessions: readonly { sessionId: string; projectId: string }[]
  ): Promise<void> {
    const activeByProject = new Map<string, Set<string>>()
    for (const session of sessions) {
      const projectId = assertSafeSegment(session.projectId, 'Project id')
      const sessionId = assertSafeSegment(session.sessionId, 'Session id')
      const activeSessions = activeByProject.get(projectId) ?? new Set<string>()
      activeSessions.add(sessionId)
      activeByProject.set(projectId, activeSessions)
    }

    const projectEntries = await readdir(this.root, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || !isSafeSegment(projectEntry.name)) continue
      const activeSessions = activeByProject.get(projectEntry.name)
      if (!activeSessions) {
        await this.removeProject(projectEntry.name)
        continue
      }

      const projectDirectory = join(this.root, projectEntry.name)
      const sessionEntries = await readdir(projectDirectory, { withFileTypes: true })
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory() || !isSafeSegment(sessionEntry.name)) continue
        if (!activeSessions.has(sessionEntry.name)) {
          await this.removeSession(projectEntry.name, sessionEntry.name)
        }
      }
    }
  }

  private registerOperation(projectId: string, sessionId: string): () => void {
    const key = this.sessionKey(projectId, sessionId)
    if (this.closedProjects.has(projectId) || this.closedSessions.has(key)) {
      throw new Error('Session cache is being deleted and cannot accept new operations.')
    }

    let settle!: () => void
    const operation = new Promise<void>((resolve) => {
      settle = resolve
    })
    const operations = this.activeOperations.get(key) ?? new Set<Promise<void>>()
    operations.add(operation)
    this.activeOperations.set(key, operations)

    let released = false
    return () => {
      if (released) return
      released = true
      operations.delete(operation)
      if (operations.size === 0) this.activeOperations.delete(key)
      settle()
    }
  }

  private sessionKey(projectId: string, sessionId: string): string {
    return `${projectId}/${sessionId}`
  }
}

type ComputeDeletionParticipant = {
  restoreProjectJobDeletion(projectId: string): Promise<void>
  prepareSessionJobDeletion(projectId: string, sessionId: string): Promise<void>
  commitSessionJobDeletion(projectId: string, sessionId: string): Promise<void>
  prepareProjectJobDeletion(projectId: string): Promise<void>
  commitProjectJobDeletion(projectId: string): Promise<void>
  abortSessionJobDeletion(projectId: string, sessionId: string): Promise<void>
  abortProjectJobDeletion(projectId: string): Promise<void>
  reconcileProjectOrphanJobs(
    projectId: string,
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<boolean | 'unknown'>
  ): Promise<void>
}

export const withSessionCacheDeletion = (
  jobs: ComputeDeletionParticipant,
  cache: Pick<SessionCacheOwner, 'removeProject' | 'removeSession'>
): ComputeDeletionParticipant => ({
  restoreProjectJobDeletion: (projectId) => jobs.restoreProjectJobDeletion(projectId),
  prepareSessionJobDeletion: (projectId, sessionId) =>
    jobs.prepareSessionJobDeletion(projectId, sessionId),
  commitSessionJobDeletion: async (projectId, sessionId) => {
    await jobs.commitSessionJobDeletion(projectId, sessionId)
    await cache.removeSession(projectId, sessionId)
  },
  prepareProjectJobDeletion: (projectId) => jobs.prepareProjectJobDeletion(projectId),
  commitProjectJobDeletion: async (projectId) => {
    await jobs.commitProjectJobDeletion(projectId)
    await cache.removeProject(projectId)
  },
  abortSessionJobDeletion: (projectId, sessionId) =>
    jobs.abortSessionJobDeletion(projectId, sessionId),
  abortProjectJobDeletion: (projectId) => jobs.abortProjectJobDeletion(projectId),
  reconcileProjectOrphanJobs: (projectId, isOwnerLive) =>
    jobs.reconcileProjectOrphanJobs(projectId, isOwnerLive)
})
