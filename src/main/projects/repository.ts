import type { PrismaClient, Project as PrismaProject } from '@prisma/client'

import type {
  CreateProjectRequest,
  Project,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'

// Only the project delegate is needed; typing to this subset keeps the repository unit-testable with a
// lightweight mock instead of a real (engine-backed) PrismaClient.
type ProjectClient = Pick<PrismaClient, '$executeRaw' | 'project' | 'projectDeletionIntent'>

// Normalizes Prisma rows into the epoch-ms shape shared with the renderer.
const toProject = (row: PrismaProject): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  isExample: row.isExample,
  ...(row.pinned ? { pinned: true } : {}),
  ...(row.archivedAt ? { archivedAt: row.archivedAt.getTime() } : {}),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

// Resolves the Prisma client on demand. A provider (rather than a captured promise) means a failed
// initialization is not held forever: each call can retry via getProjectDbClient's self-healing cache.
type ProjectClientProvider = () => Promise<ProjectClient>

// Owns Project reads/writes. The client is resolved lazily per call so schema-ensure failures can recover.
class ProjectRepository {
  constructor(private readonly getClient: ProjectClientProvider) {}

  // Lists projects most-recently-updated first for the home screen.
  async list(): Promise<Project[]> {
    const client = await this.getClient()
    const rows = await client.project.findMany({ orderBy: { updatedAt: 'desc' } })

    return rows.map(toProject)
  }

  // Returns a single project or null when it no longer exists.
  async get(id: string): Promise<Project | null> {
    const client = await this.getClient()
    const row = await client.project.findUnique({ where: { id } })

    return row ? toProject(row) : null
  }

  // Creates a project; rejects blank names before touching the database.
  async create(request: CreateProjectRequest): Promise<Project> {
    const name = request.name.trim()

    if (!name) {
      throw new Error('Project name is required.')
    }

    const client = await this.getClient()
    const row = await client.project.create({
      data: { name, description: request.description?.trim() ?? '' }
    })

    return toProject(row)
  }

  // Updates editable fields, ignoring undefined values so callers can patch only what changed.
  // Pin-only changes preserve updatedAt because pinning controls placement, not research activity.
  async update(request: UpdateProjectRequest): Promise<Project> {
    const data: { name?: string; description?: string; pinned?: boolean } = {}

    if (request.name !== undefined) {
      const name = request.name.trim()

      if (!name) {
        throw new Error('Project name is required.')
      }

      data.name = name
    }

    if (request.description !== undefined) {
      data.description = request.description.trim()
    }

    const client = await this.getClient()

    if (
      request.pinned !== undefined &&
      request.name === undefined &&
      request.description === undefined
    ) {
      // Prisma's @updatedAt automation also runs for administrative changes. Updating only the pin
      // column in SQL avoids both a fake activity bump and a read/write race that could restore an
      // older timestamp over concurrent Project activity.
      const updated = await client.$executeRaw`
        UPDATE "Project"
        SET "pinned" = ${request.pinned}
        WHERE "id" = ${request.id}
      `
      if (updated !== 1) throw new Error('Project not found.')

      const row = await client.project.findUnique({ where: { id: request.id } })
      if (!row) throw new Error('Project not found.')
      return toProject(row)
    }

    if (request.pinned !== undefined) data.pinned = request.pinned

    const row = await client.project.update({ where: { id: request.id }, data })

    return toProject(row)
  }

  // Archive is deliberately separate from ordinary Project edits: a stale rename/update must not
  // forge or clear visibility state. The compare-and-set condition also makes Undo safe across
  // windows without changing the research activity timestamp.
  async updateArchive(request: UpdateProjectArchiveRequest, archivedAt: number): Promise<Project> {
    if (!Number.isSafeInteger(request.expectedArchivedAt) && request.expectedArchivedAt !== null) {
      throw new Error('Project archive state is invalid.')
    }
    if (!Number.isSafeInteger(archivedAt) || archivedAt <= 0) {
      throw new Error('Project archive timestamp is invalid.')
    }

    const client = await this.getClient()
    const current = await client.project.findUnique({ where: { id: request.id } })
    if (!current) throw new Error('Project not found.')

    const expectedArchivedAt = request.expectedArchivedAt
    const result = await client.project.updateMany({
      where: {
        id: request.id,
        archivedAt: expectedArchivedAt === null ? null : new Date(expectedArchivedAt)
      },
      data: {
        archivedAt: request.archived ? new Date(archivedAt) : null,
        // Prisma otherwise updates this @updatedAt field. Administrative visibility changes must
        // not make a Project look newer than its underlying work.
        updatedAt: current.updatedAt
      }
    })
    if (result.count !== 1) {
      throw new Error('Project archive state changed elsewhere.')
    }

    const row = await client.project.findUnique({ where: { id: request.id } })
    if (!row) throw new Error('Project not found.')
    return toProject(row)
  }

  // Removes a project row. Cascading its sessions is handled by the session layer, not the DB.
  async delete(id: string): Promise<void> {
    const client = await this.getClient()

    await client.project.delete({ where: { id } })
  }

  // Upsert makes intent creation idempotent across repeated delete commands and crash recovery.
  async createDeletionIntent(projectId: string): Promise<void> {
    const client = await this.getClient()

    await client.projectDeletionIntent.upsert({
      where: { projectId },
      create: { projectId },
      update: {}
    })
  }

  // deleteMany treats an already-finished or rolled-back intent as successful cleanup.
  async deleteDeletionIntent(projectId: string): Promise<void> {
    const client = await this.getClient()
    await client.projectDeletionIntent.deleteMany({ where: { projectId } })
  }

  // Oldest-first replay preserves the durable order in which project deletions began.
  async listDeletionIntents(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.projectDeletionIntent.findMany({
      orderBy: { createdAt: 'asc' },
      select: { projectId: true }
    })
    return rows.map((row) => row.projectId)
  }
}

export { ProjectRepository, toProject }
export type { ProjectClient, ProjectClientProvider }
