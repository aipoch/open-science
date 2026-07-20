import type { PrismaClient, Project as PrismaProject } from '@prisma/client'

import type { CreateProjectRequest, Project, UpdateProjectRequest } from '../../shared/projects'

// Only the project delegate is needed; typing to this subset keeps the repository unit-testable with a
// lightweight mock instead of a real (engine-backed) PrismaClient.
type ProjectClient = Pick<PrismaClient, 'project' | 'projectDeletionIntent'>

// Normalizes Prisma rows into the epoch-ms shape shared with the renderer.
const toProject = (row: PrismaProject): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  isExample: row.isExample,
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

  // Updates name and/or description, ignoring undefined fields so callers can patch either one.
  async update(request: UpdateProjectRequest): Promise<Project> {
    const data: { name?: string; description?: string } = {}

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
    const row = await client.project.update({ where: { id: request.id }, data })

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
