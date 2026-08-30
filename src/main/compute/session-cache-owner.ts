import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
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

const assertSafeDirectory = async (directory: string, label: string): Promise<void> => {
  const entry = await lstat(directory)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Unsafe Session cache ${label} directory.`)
  }
}

const assertSafeExistingDirectory = async (directory: string, label: string): Promise<boolean> => {
  try {
    await assertSafeDirectory(directory, label)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const createSafeDirectory = async (directory: string, label: string): Promise<void> => {
  await mkdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  await assertSafeDirectory(directory, label)
}

export class SessionCacheOwner {
  private readonly computeRoot: string
  private readonly root: string
  private readonly activeOperations = new Map<string, Set<Promise<void>>>()
  private readonly closedProjects = new Set<string>()
  private readonly closedSessions = new Set<string>()
  private readonly reconcilingProjects = new Set<string>()

  constructor(storageRoot: string) {
    this.computeRoot = join(storageRoot, 'compute')
    this.root = join(this.computeRoot, 'session-cache')
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
      await createSafeDirectory(this.computeRoot, 'Compute')
      await createSafeDirectory(this.root, 'root')
      await createSafeDirectory(join(this.root, safeProjectId), 'Project')
      await createSafeDirectory(join(this.root, safeProjectId, safeSessionId), 'Session')
      await createSafeDirectory(directory, 'operation')
      return { operationId, path: join(directory, safeFilename), release }
    } catch (error) {
      release()
      throw error
    }
  }

  async removeOperation(projectId: string, sessionId: string, operationId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    const safeSessionId = assertSafeSegment(sessionId, 'Session id')
    const safeOperationId = assertSafeSegment(operationId, 'operation id')
    if (!(await this.assertSafePath(safeProjectId, safeSessionId, safeOperationId))) return
    await rm(join(this.root, safeProjectId, safeSessionId, safeOperationId), {
      recursive: true,
      force: true
    })
  }

  async removeSession(projectId: string, sessionId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    const safeSessionId = assertSafeSegment(sessionId, 'Session id')
    const key = this.sessionKey(safeProjectId, safeSessionId)
    this.closedSessions.add(key)
    await Promise.all(this.activeOperations.get(key) ?? [])
    if (!(await this.assertSafePath(safeProjectId, safeSessionId))) return
    await rm(join(this.root, safeProjectId, safeSessionId), { recursive: true, force: true })
  }

  async removeProject(projectId: string): Promise<void> {
    const safeProjectId = assertSafeSegment(projectId, 'Project id')
    this.closedProjects.add(safeProjectId)
    await this.removeProjectDirectory(safeProjectId)
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

    if (!(await this.assertSafePath())) return
    const projectEntries = await readdir(this.root, { withFileTypes: true })
    for (const projectEntry of projectEntries) {
      if (projectEntry.isSymbolicLink()) {
        throw new Error('Unsafe Session cache Project directory.')
      }
      if (!projectEntry.isDirectory() || !isSafeSegment(projectEntry.name)) continue
      const activeSessions = activeByProject.get(projectEntry.name)
      if (!activeSessions) {
        this.reconcilingProjects.add(projectEntry.name)
        try {
          await this.removeProjectDirectory(projectEntry.name)
        } finally {
          this.reconcilingProjects.delete(projectEntry.name)
        }
        continue
      }

      const projectDirectory = join(this.root, projectEntry.name)
      if (!(await assertSafeExistingDirectory(projectDirectory, 'Project'))) continue
      const sessionEntries = await readdir(projectDirectory, { withFileTypes: true })
      for (const sessionEntry of sessionEntries) {
        if (sessionEntry.isSymbolicLink()) {
          throw new Error('Unsafe Session cache Session directory.')
        }
        if (!sessionEntry.isDirectory() || !isSafeSegment(sessionEntry.name)) continue
        if (!activeSessions.has(sessionEntry.name)) {
          await this.removeSession(projectEntry.name, sessionEntry.name)
        }
      }
    }
  }

  private registerOperation(projectId: string, sessionId: string): () => void {
    const key = this.sessionKey(projectId, sessionId)
    if (
      this.closedProjects.has(projectId) ||
      this.closedSessions.has(key) ||
      this.reconcilingProjects.has(projectId)
    ) {
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

  private async removeProjectDirectory(projectId: string): Promise<void> {
    const prefix = `${projectId}/`
    await Promise.all(
      [...this.activeOperations.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, operations]) => [...operations])
    )
    if (!(await this.assertSafePath(projectId))) return
    await rm(join(this.root, projectId), {
      recursive: true,
      force: true
    })
  }

  private async assertSafePath(
    projectId?: string,
    sessionId?: string,
    operationId?: string
  ): Promise<boolean> {
    const directories: [string, string][] = [
      [this.computeRoot, 'Compute'],
      [this.root, 'root']
    ]
    if (projectId) directories.push([join(this.root, projectId), 'Project'])
    if (projectId && sessionId) {
      directories.push([join(this.root, projectId, sessionId), 'Session'])
    }
    if (projectId && sessionId && operationId) {
      directories.push([join(this.root, projectId, sessionId, operationId), 'operation'])
    }
    for (const [directory, label] of directories) {
      if (!(await assertSafeExistingDirectory(directory, label))) return false
    }
    return true
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
