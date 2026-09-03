import type { Prisma, PrismaClient, Project as PrismaProject } from '@prisma/client'

import type {
  CreateProjectRequest,
  Project,
  ProjectDeletionCleanup,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'
import { PROJECT_NAME_MAX_LENGTH } from '../../shared/projects'
import { projectSessionDefaultsSchema } from '../../shared/session-configuration'
import { MEMORY_SETTINGS_ID } from '../../shared/memory'
import { migrationSqlExecutor } from '../database/migration-sql-executor'

// Only the project delegate is needed; typing to this subset keeps the repository unit-testable with a
// lightweight mock instead of a real (engine-backed) PrismaClient.
type ProjectClient = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRawUnsafe'
  | '$transaction'
  | 'project'
  | 'projectDeletionIntent'
  | 'projectPreviewState'
  | 'visionEvidence'
  | 'memoryEntry'
  | 'memorySettings'
>

type ProjectDeletionResult = Readonly<{ memoryRevision: number }>

// Normalizes Prisma rows into the epoch-ms shape shared with the renderer.
const toProject = (row: PrismaProject): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  // An empty Agent Context is omitted on the wire, matching the optional shared schema field.
  ...(row.agentContext ? { agentContext: row.agentContext } : {}),
  sessionDefaults: projectSessionDefaultsSchema.parse(JSON.parse(row.sessionDefaults ?? '{}')),
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
    const rows = await client.project.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' }
    })

    return rows.map(toProject)
  }

  // Returns a single project or null when it no longer exists.
  async get(id: string): Promise<Project | null> {
    const client = await this.getClient()
    const row = await client.project.findUnique({ where: { id } })

    return row && row.deletedAt === null ? toProject(row) : null
  }

  // Creates a project; rejects blank names before touching the database.
  async create(request: CreateProjectRequest): Promise<Project> {
    const name = request.name.trim()

    if (!name) {
      throw new Error('Project name is required.')
    }

    const client = await this.getClient()
    const row = await client.project.create({
      data: {
        name,
        description: request.description?.trim() ?? '',
        agentContext: request.agentContext?.trim() ?? ''
      }
    })

    return toProject(row)
  }

  // Updates editable fields, ignoring undefined values so callers can patch only what changed.
  // Pin-only changes preserve updatedAt because pinning controls placement, not research activity.
  async update(request: UpdateProjectRequest): Promise<Project> {
    const data: {
      name?: string
      description?: string
      agentContext?: string
      sessionDefaults?: string
      pinned?: boolean
      updatedAt?: Date
    } = {}

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

    if (request.agentContext !== undefined) {
      data.agentContext = request.agentContext.trim()
    }

    if (request.sessionDefaults !== undefined) {
      data.sessionDefaults = JSON.stringify(
        projectSessionDefaultsSchema.parse(request.sessionDefaults)
      )
    }

    if (!Number.isSafeInteger(request.expectedUpdatedAt) || request.expectedUpdatedAt <= 0) {
      throw new Error('Project update timestamp is invalid.')
    }

    const client = await this.getClient()

    if (
      request.pinned !== undefined &&
      request.name === undefined &&
      request.description === undefined &&
      request.agentContext === undefined &&
      request.sessionDefaults === undefined
    ) {
      // Prisma's @updatedAt automation also runs for administrative changes. Updating only the pin
      // column in SQL avoids both a fake activity bump and a read/write race that could restore an
      // older timestamp over concurrent Project activity.
      const updated = await client.$executeRaw`
        UPDATE "Project"
        SET "pinned" = ${request.pinned}
        WHERE "id" = ${request.id} AND "deletedAt" IS NULL
      `
      if (updated !== 1) throw new Error('Project not found.')

      const row = await client.project.findUnique({ where: { id: request.id } })
      if (!row) throw new Error('Project not found.')
      if (row.deletedAt !== null) throw new Error('Project not found.')
      return toProject(row)
    }

    if (request.pinned !== undefined) data.pinned = request.pinned

    // Prisma's wall-clock @updatedAt can repeat within one millisecond or move backward after a
    // clock correction. Advance from the caller's compared value so every accepted content edit
    // receives a distinct token while updatedAt remains the Project activity timestamp.
    data.updatedAt = new Date(Math.max(Date.now(), request.expectedUpdatedAt + 1))

    const result = await client.project.updateMany({
      where: {
        id: request.id,
        deletedAt: null,
        updatedAt: new Date(request.expectedUpdatedAt)
      },
      data
    })
    if (result.count !== 1) {
      throw new Error('Project changed elsewhere.')
    }

    const row = await client.project.findUnique({ where: { id: request.id } })
    if (!row || row.deletedAt !== null) throw new Error('Project not found.')
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
    const expectedArchivedAt = request.expectedArchivedAt
    // Prisma's @updatedAt automation also runs for administrative changes. Updating only the archive
    // column in SQL preserves the activity timestamp without reading and later restoring a stale value.
    const updated = await client.$executeRaw`
      UPDATE "Project"
      SET "archivedAt" = ${request.archived ? new Date(archivedAt) : null}
      WHERE "id" = ${request.id}
        AND "deletedAt" IS NULL
        AND "archivedAt" IS ${expectedArchivedAt === null ? null : new Date(expectedArchivedAt)}
    `
    if (updated !== 1) {
      const current = await client.project.findUnique({ where: { id: request.id } })
      if (!current || current.deletedAt !== null) throw new Error('Project not found.')
      throw new Error('Project archive state changed elsewhere.')
    }

    const row = await client.project.findUnique({ where: { id: request.id } })
    if (!row || row.deletedAt !== null) throw new Error('Project not found.')
    return toProject(row)
  }

  // Retains Project and Session metadata/Usage for historical totals while removing active-only
  // derived children that previously relied on a hard-delete cascade.
  async delete(id: string): Promise<ProjectDeletionResult | undefined> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      await migrationSqlExecutor.query(
        transaction as unknown as Prisma.TransactionClient,
        'PRAGMA secure_delete = ON'
      )
      await transaction.projectPreviewState.deleteMany({ where: { projectId: id } })
      await transaction.visionEvidence.deleteMany({ where: { projectId: id } })
      const deletedMemory = await transaction.memoryEntry.deleteMany({ where: { projectId: id } })
      const memoryChange =
        deletedMemory.count > 0
          ? await transaction.memorySettings.update({
              where: { id: MEMORY_SETTINGS_ID },
              data: { revision: { increment: 1 } },
              select: { revision: true }
            })
          : undefined
      const current = await transaction.project.findUnique({ where: { id } })
      if (!current || current.deletedAt !== null) {
        return memoryChange ? { memoryRevision: memoryChange.revision } : undefined
      }
      await transaction.project.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), updatedAt: current.updatedAt }
      })
      return memoryChange ? { memoryRevision: memoryChange.revision } : undefined
    })
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

  async listDeletionCleanupProjects(): Promise<
    Array<Pick<ProjectDeletionCleanup, 'projectId' | 'projectName'>>
  > {
    const client = await this.getClient()
    const intents = await client.projectDeletionIntent.findMany({
      orderBy: { createdAt: 'asc' },
      select: { projectId: true }
    })
    if (intents.length === 0) return []

    const projects = await client.project.findMany({
      where: { id: { in: intents.map(({ projectId }) => projectId) } },
      select: { id: true, name: true }
    })
    const names = new Map(projects.map(({ id, name }) => [id, name]))
    return intents.map(({ projectId }) => {
      const projectName = names.get(projectId)?.slice(0, PROJECT_NAME_MAX_LENGTH)
      return { projectId, ...(projectName ? { projectName } : {}) }
    })
  }
}

export { ProjectRepository, toProject }
export type { ProjectClient, ProjectClientProvider, ProjectDeletionResult }
