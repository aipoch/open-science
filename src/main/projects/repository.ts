import type { Prisma, PrismaClient, Project as PrismaProject } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type {
  CreateProjectRequest,
  LocateProjectFolderRequest,
  Project,
  ProjectDeletionCleanup,
  ProjectFolderValidationResult,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'
import { PROJECT_NAME_MAX_LENGTH } from '../../shared/projects'
import { projectSessionDefaultsSchema } from '../../shared/session-configuration'
import { MEMORY_SETTINGS_ID } from '../../shared/memory'
import { deletePdfAnnotations } from '../pdf-annotations/repository'
import { migrationSqlExecutor } from '../database/migration-sql-executor'
import { sameProjectFolderSpelling } from '../storage/data-location-identity'
import { isSessionPackagePending } from '../storage/session-package-state'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  validateProjectFolder,
  type ProjectFolderValidationOptions
} from './project-folder-validation'
import type { ProjectFolderPath } from '../storage/workspace-location'
import { detectProjectFolderWarnings } from './project-folder-location'
import { assertProjectRecordLocation } from './project-record-location'
import { ProjectArtifactIndexUnavailableError } from './record-indexes'
import { revalidateProjectNotebookOutputDirectories } from './session-output-layout'
import {
  completeProjectRecordReopen,
  enableProjectSessionOutputs,
  getProjectRecordRoute,
  getProjectRecordRoot,
  initializeProjectRecordStorage,
  markProjectRecordDetached,
  readProjectRecordManifest,
  registerProjectRecordStorage
} from './record-storage'
import {
  assertProjectFolderAvailable,
  projectFolderFailure,
  projectFolderWarnings
} from './project-folder-binding'

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
  | 'sessionReplayProgress'
  | 'sessionDiscussionSnapshot'
  | 'bookmark'
  | 'pdfAnnotation'
  | 'tagAssignment'
  | 'visionEvidence'
  | 'memoryEntry'
  | 'memorySettings'
>

type ProjectDeletionResult = Readonly<{ memoryRevision: number }>

const decodeProjectSessionDefaults = (value: string | null): Project['sessionDefaults'] => {
  try {
    const decoded: unknown = JSON.parse(value ?? '{}')
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return { permissionProfile: 'ask', delegationPolicy: 'deny' }
    }
    const source = decoded as Record<string, unknown>
    const defaults = Object.fromEntries(
      Object.entries(projectSessionDefaultsSchema.shape).flatMap(([key, schema]) => {
        const field = schema.safeParse(source[key])
        return field.success && field.data !== undefined ? [[key, field.data]] : []
      })
    )
    if (
      source.permissionProfile !== undefined &&
      !projectSessionDefaultsSchema.shape.permissionProfile.safeParse(source.permissionProfile)
        .success
    ) {
      defaults.permissionProfile = 'ask'
    }
    if (
      source.delegationPolicy !== undefined &&
      !projectSessionDefaultsSchema.shape.delegationPolicy.safeParse(source.delegationPolicy)
        .success
    ) {
      defaults.delegationPolicy = 'deny'
    }
    return projectSessionDefaultsSchema.parse(defaults)
  } catch {
    return { permissionProfile: 'ask', delegationPolicy: 'deny' }
  }
}

// Normalizes Prisma rows into the epoch-ms shape shared with the renderer.
const toProject = (row: PrismaProject): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  // An empty Agent Context is omitted on the wire, matching the optional shared schema field.
  ...(row.agentContext ? { agentContext: row.agentContext } : {}),
  ...(row.optimizationPrompt ? { optimizationPrompt: row.optimizationPrompt } : {}),
  sessionDefaults: decodeProjectSessionDefaults(row.sessionDefaults),
  ...(row.rootPath ? { rootPath: row.rootPath } : {}),
  isExample: row.isExample,
  ...(row.pinned ? { pinned: true } : {}),
  ...(row.archivedAt ? { archivedAt: row.archivedAt.getTime() } : {}),
  archiveRevision: row.archiveRevision,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

// Resolves the Prisma client on demand. A provider (rather than a captured promise) means a failed
// initialization is not held forever: each call can retry via getProjectDbClient's self-healing cache.
type ProjectClientProvider = () => Promise<ProjectClient>

// Owns Project reads/writes. The client is resolved lazily per call so schema-ensure failures can recover.
export type ProjectRecordOptions = {
  storageRoot: () => string
  assertLocation?: (path: string) => Promise<void>
  restoreIndexes?: (
    client: Prisma.TransactionClient,
    projectId: string,
    locatedFolder?: string
  ) => Promise<void>
  reconcileIndexes?: (client: ProjectClient, projectId: string) => Promise<void>
}

class ProjectRepository {
  constructor(
    private readonly getClient: ProjectClientProvider,
    private readonly configRoot?: string,
    private readonly folderOptions?: ProjectFolderValidationOptions,
    private readonly recordOptions?: ProjectRecordOptions
  ) {}

  private present(row: PrismaProject): Project {
    const project = toProject(row)
    if (!row.rootPath || !this.recordOptions) return project
    try {
      const route = getProjectRecordRoute(this.recordOptions.storageRoot(), row.id)
      if (!route || route.detached) return project
      const manifest = readProjectRecordManifest(row.rootPath)
      if (manifest?.projectId === row.id)
        project.outputLayout = manifest.version === 2 ? 'session-v1' : 'legacy'
    } catch {
      // A disconnected or unsupported Project stays visible. Folder admission reports the error
      // before any execution/write; never offer an upgrade when the records cannot be verified.
    }
    return project
  }

  projectRecordStorageRoot(): string | undefined {
    return this.recordOptions?.storageRoot()
  }

  recordRecoveryPending(projectId: string): boolean {
    return Boolean(
      this.recordOptions &&
      getProjectRecordRoute(this.recordOptions.storageRoot(), projectId)?.reopening
    )
  }

  async completeRecordRecovery(projectId: string): Promise<void> {
    if (this.recordOptions)
      await completeProjectRecordReopen(this.recordOptions.storageRoot(), projectId)
  }

  private async prepareFolder(
    path: string,
    scope: 'tree' | 'target' = 'tree'
  ): Promise<ProjectFolderPath> {
    if (!this.folderOptions) {
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        'Project folder access is unavailable.'
      )
    }
    try {
      return await validateProjectFolder(path, this.folderOptions, scope)
    } catch (error) {
      const failure = projectFolderFailure(error)
      const missing =
        isAbsolute(path) &&
        (await stat(path).then(
          () => false,
          (failure: NodeJS.ErrnoException) => failure.code === 'ENOENT'
        ))
      throw new ApplicationCommandError(
        missing ? 'project-folder-not-found' : 'project-folder-unavailable',
        failure.diagnostics,
        undefined,
        { cause: error }
      )
    }
  }

  async validateFolder(request: { path: string }): Promise<ProjectFolderValidationResult> {
    try {
      const path = await this.prepareFolder(request.path)
      if (this.recordOptions) {
        await (this.recordOptions.assertLocation ?? assertProjectRecordLocation)(path)
        readProjectRecordManifest(path)
      }
      await assertProjectFolderAvailable(await this.getClient(), path)
      return { ok: true, path, warnings: await detectProjectFolderWarnings(path) }
    } catch (error) {
      return { ...projectFolderFailure(error), path: request.path }
    }
  }

  async assertProjectFolderHealthy(projectId: string): Promise<string | undefined> {
    const project = await this.get(projectId)
    if (!project?.rootPath) return undefined
    try {
      const info = await lstat(project.rootPath)
      if (info.isSymbolicLink())
        throw new ApplicationCommandError(
          'project-folder-unavailable',
          `The saved project folder was replaced by a symbolic link: ${project.rootPath}`
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof ApplicationCommandError) throw error
        throw new ApplicationCommandError(
          'project-folder-unavailable',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    const path = await this.prepareFolder(project.rootPath, 'target')
    // A saved canonical directory must not silently follow a replacement symlink/ancestor.
    if (!sameProjectFolderSpelling(project.rootPath, path))
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        `Project folder binding changed on disk.\nSaved folder: ${project.rootPath}\nResolved folder: ${path}`
      )
    await assertProjectFolderAvailable(await this.getClient(), path, projectId)
    if (this.recordOptions) {
      const storageRoot = this.recordOptions.storageRoot()
      const route = getProjectRecordRoute(storageRoot, projectId)
      const manifest = readProjectRecordManifest(path)
      if (route || manifest?.projectId === projectId) {
        await (this.recordOptions.assertLocation ?? assertProjectRecordLocation)(path)
        if (!manifest || manifest.projectId !== projectId)
          throw new ApplicationCommandError(
            'project-folder-unavailable',
            'Project research records are missing or belong to another Project.'
          )
        if (!route || route.folder !== path)
          await registerProjectRecordStorage(storageRoot, path, projectId, {
            reopening: route?.reopening
          })
        getProjectRecordRoot(storageRoot, projectId)
      }
    }
    return path
  }

  async checkFolder(request: { projectId: string }): Promise<ProjectFolderValidationResult | null> {
    const project = await this.get(request.projectId)
    if (!project?.rootPath) return null
    try {
      const path = await this.assertProjectFolderHealthy(request.projectId)
      if (path)
        await this.recordOptions?.reconcileIndexes?.(await this.getClient(), request.projectId)
      return path ? { ok: true, path, warnings: projectFolderWarnings(path) } : null
    } catch (error) {
      const failure = projectFolderFailure(error)
      if (failure.kind === 'unavailable') {
        const missing = await lstat(project.rootPath).then(
          () => false,
          (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT'
        )
        if (missing) return { ...failure, kind: 'not-found', path: project.rootPath }
        if (error instanceof ProjectArtifactIndexUnavailableError)
          return { ...failure, kind: 'records-unavailable', path: project.rootPath }
      }
      return { ...failure, path: project.rootPath }
    }
  }

  private async missingFolderForLocation(
    request: LocateProjectFolderRequest,
    client: ProjectClient
  ): Promise<PrismaProject> {
    const row = await client.project.findUnique({ where: { id: request.projectId } })
    if (!row || row.deletedAt !== null) throw new Error('Project not found.')
    if (!row.rootPath || row.rootPath !== request.expectedRootPath)
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        'The project folder binding changed. Refresh it and retry.'
      )
    let missing: boolean
    try {
      missing = await lstat(row.rootPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return true
          throw error
        }
      )
    } catch (error) {
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!missing)
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        'The existing project folder is present. Restore access and retry; it cannot be replaced.'
      )
    return row
  }

  async locateFolder(
    request: LocateProjectFolderRequest,
    withRelocation: (commit: () => Promise<Project>) => Promise<Project>
  ): Promise<Project> {
    // Quiescing can perform Session/database I/O, so never hold SQLite's writer lock across it.
    await this.missingFolderForLocation(request, await this.getClient())
    const path = await this.prepareFolder(request.path)
    const recordRoute =
      this.recordOptions &&
      getProjectRecordRoute(this.recordOptions.storageRoot(), request.projectId)
    if (recordRoute) {
      await (this.recordOptions!.assertLocation ?? assertProjectRecordLocation)(path)
      if (readProjectRecordManifest(path)?.projectId !== request.projectId)
        throw new ApplicationCommandError(
          'project-folder-unavailable',
          'Select the folder containing this Project’s research records.'
        )
    }
    await assertProjectFolderAvailable(await this.getClient(), path, request.projectId)
    return withRelocation(() =>
      this.admitFolder(path, request.projectId, async (client) => {
        const current = await this.missingFolderForLocation(request, client)
        const changed = await client.project.updateMany({
          where: { id: request.projectId, deletedAt: null, rootPath: request.expectedRootPath },
          data: {
            rootPath: path,
            updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1))
          }
        })
        if (changed.count !== 1)
          throw new ApplicationCommandError(
            'project-folder-unavailable',
            'The project folder binding changed. Refresh it and retry.'
          )
        const row = await client.project.findUnique({ where: { id: request.projectId } })
        if (!row || row.deletedAt !== null) throw new Error('Project not found.')
        if (recordRoute) {
          await revalidateProjectNotebookOutputDirectories(
            this.recordOptions!.storageRoot(),
            request.projectId,
            path
          )
          await this.recordOptions!.restoreIndexes?.(
            client as unknown as Prisma.TransactionClient,
            request.projectId,
            path
          )
          await registerProjectRecordStorage(
            this.recordOptions!.storageRoot(),
            path,
            request.projectId,
            { reopening: recordRoute.reopening }
          )
        }
        return this.present(row)
      })
    )
  }

  private async admitFolder<Result>(
    path: string,
    projectId: string | undefined,
    operation: (client: ProjectClient) => Promise<Result>
  ): Promise<Result> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      // Acquire SQLite's writer lock before reading reservations. It serializes admission across
      // repository instances and host processes, not merely two UI requests in this instance.
      await transaction.$executeRaw`UPDATE "Project" SET "id" = "id" WHERE 0`
      await assertProjectFolderAvailable(transaction, path, projectId)
      return operation(transaction as unknown as ProjectClient)
    })
  }

  private pending(id: string): Promise<boolean> {
    return this.configRoot ? isSessionPackagePending(this.configRoot, id) : Promise.resolve(false)
  }

  // Lists projects most-recently-updated first for the home screen.
  async list(): Promise<Project[]> {
    const client = await this.getClient()
    const deletionIntents = await client.projectDeletionIntent.findMany({
      select: { projectId: true }
    })
    const rows = await client.project.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' }
    })
    const deletingProjectIds = new Set(deletionIntents.map(({ projectId }) => projectId))

    const pending = await Promise.all(rows.map(({ id }) => this.pending(id)))
    return rows
      .filter(({ id }, index) => !deletingProjectIds.has(id) && !pending[index])
      .map((row) => this.present(row))
  }

  // Returns a single project or null when it no longer exists.
  async get(id: string): Promise<Project | null> {
    if (await this.pending(id)) return null
    const client = await this.getClient()
    const row = await client.project.findUnique({ where: { id } })

    return row && row.deletedAt === null ? this.present(row) : null
  }

  async exists(id: string): Promise<boolean> {
    if (await this.pending(id)) return false
    const client = await this.getClient()
    const row = await client.project.findUnique({
      where: { id },
      select: { deletedAt: true }
    })
    return row?.deletedAt === null
  }

  // Creates a project; rejects blank names before touching the database.
  async create(request: CreateProjectRequest): Promise<Project> {
    const name = request.name.trim()

    if (!name) {
      throw new Error('Project name is required.')
    }

    const rootPath =
      request.rootPath === undefined ? undefined : await this.prepareFolder(request.rootPath)
    if (rootPath && this.recordOptions)
      await (this.recordOptions.assertLocation ?? assertProjectRecordLocation)(rootPath)
    const stored = rootPath && this.recordOptions ? readProjectRecordManifest(rootPath) : undefined
    const create = async (client: ProjectClient): Promise<Project> => {
      const data = {
        name,
        description: request.description?.trim() ?? '',
        agentContext: request.agentContext?.trim() ?? '',
        optimizationPrompt: request.optimizationPrompt?.trim() ?? '',
        ...(rootPath ? { rootPath } : {})
      }
      let row: PrismaProject
      if (rootPath && this.recordOptions) {
        const projectId = stored?.projectId ?? randomUUID()
        const previous = stored
          ? await client.project.findUnique({ where: { id: projectId } })
          : null
        if (previous && previous.deletedAt === null)
          throw new ApplicationCommandError(
            'project-folder-conflict',
            'This Project is already registered. Open or restore its existing entry.'
          )
        if (await client.projectDeletionIntent.findUnique({ where: { projectId } }))
          throw new ApplicationCommandError(
            'project-folder-unavailable',
            'Project removal is still finishing. Retry after cleanup completes.'
          )
        await initializeProjectRecordStorage(
          this.recordOptions.storageRoot(),
          rootPath,
          stored ?? {
            format: 'open-science-project',
            version: 2,
            outputLayout: 'session-v1',
            projectId,
            name,
            createdAt: Date.now()
          },
          { reopening: Boolean(stored) }
        )
        if (stored)
          await revalidateProjectNotebookOutputDirectories(
            this.recordOptions.storageRoot(),
            projectId,
            rootPath
          )
        row = previous
          ? await client.project.update({
              where: { id: projectId },
              data: { ...data, deletedAt: null, archivedAt: null }
            })
          : await client.project.create({
              data: {
                ...data,
                id: projectId,
                ...(stored ? { createdAt: new Date(stored.createdAt) } : {})
              }
            })
        if (stored)
          await this.recordOptions.restoreIndexes?.(
            client as unknown as Prisma.TransactionClient,
            projectId
          )
      } else row = await client.project.create({ data })
      return this.present(row)
    }
    return rootPath ? this.admitFolder(rootPath, undefined, create) : create(await this.getClient())
  }

  // Updates editable fields, ignoring undefined values so callers can patch only what changed.
  // Pin-only changes preserve updatedAt because pinning controls placement, not research activity.
  async update(request: UpdateProjectRequest): Promise<Project> {
    const data: {
      name?: string
      description?: string
      agentContext?: string
      optimizationPrompt?: string
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

    if (request.optimizationPrompt !== undefined) {
      data.optimizationPrompt = request.optimizationPrompt.trim()
    }

    if (!Number.isSafeInteger(request.expectedUpdatedAt) || request.expectedUpdatedAt <= 0) {
      throw new Error('Project update timestamp is invalid.')
    }

    const client = await this.getClient()
    if (request.enableSessionOutputs) {
      const project = await this.get(request.id)
      if (!project || project.updatedAt !== request.expectedUpdatedAt)
        throw new Error('Project changed elsewhere.')
      if (!project.rootPath || !this.recordOptions || project.outputLayout === undefined)
        throw new Error('Session outputs require existing Project research records.')
      await this.assertProjectFolderHealthy(request.id)
    }

    if (request.sessionDefaults !== undefined || request.agentTracingEnabled !== undefined) {
      const defaults =
        request.sessionDefaults ??
        decodeProjectSessionDefaults(
          (await client.project.findUnique({ where: { id: request.id } }))?.sessionDefaults ?? null
        )
      data.sessionDefaults = JSON.stringify(
        projectSessionDefaultsSchema.parse({
          ...defaults,
          ...(request.agentTracingEnabled !== undefined
            ? { agentTracingEnabled: request.agentTracingEnabled }
            : {})
        })
      )
    }

    if (
      request.pinned !== undefined &&
      request.name === undefined &&
      request.description === undefined &&
      request.agentContext === undefined &&
      request.optimizationPrompt === undefined &&
      request.sessionDefaults === undefined &&
      request.agentTracingEnabled === undefined &&
      request.enableSessionOutputs === undefined
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
      return this.present(row)
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
    if (request.enableSessionOutputs)
      await enableProjectSessionOutputs(this.recordOptions!.storageRoot(), request.id)
    return this.present(row)
  }

  // Archive is deliberately separate from ordinary Project edits: a stale rename/update must not
  // forge or clear visibility state. The compare-and-set condition also makes Undo safe across
  // windows without changing the research activity timestamp.
  async updateArchive(request: UpdateProjectArchiveRequest, archivedAt: number): Promise<Project> {
    if (
      !Number.isSafeInteger(request.expectedArchiveRevision) ||
      request.expectedArchiveRevision < 0
    ) {
      throw new Error('Project archive state is invalid.')
    }
    if (!Number.isSafeInteger(archivedAt) || archivedAt <= 0) {
      throw new Error('Project archive timestamp is invalid.')
    }

    const client = await this.getClient()
    if (!request.archived) {
      const current = await client.project.findUnique({ where: { id: request.id } })
      if (!current || current.deletedAt !== null) throw new Error('Project not found.')
      if (current.rootPath) {
        let path: string
        try {
          path = await this.prepareFolder(current.rootPath)
        } catch (error) {
          if (
            !(error instanceof ApplicationCommandError) ||
            error.code !== 'project-folder-not-found'
          )
            throw error
          // Restore visibility of genuinely missing bindings so Workspace can offer Locate. This
          // reserves the saved location; it neither grants access nor converts the Project to managed.
          const missing = {
            projectId: request.id,
            expectedRootPath: current.rootPath,
            path: current.rootPath
          }
          await this.missingFolderForLocation(missing, client)
          return this.admitFolder(current.rootPath, request.id, async (transaction) => {
            await this.missingFolderForLocation(missing, transaction)
            return this.updateArchiveNow(request, archivedAt, transaction)
          })
        }
        return this.admitFolder(path, request.id, (transaction) =>
          this.updateArchiveNow(request, archivedAt, transaction)
        )
      }
    }
    return this.updateArchiveNow(request, archivedAt, client)
  }

  private async updateArchiveNow(
    request: UpdateProjectArchiveRequest,
    archivedAt: number,
    client: ProjectClient
  ): Promise<Project> {
    // Prisma's @updatedAt automation also runs for administrative changes. Updating only the archive
    // columns in SQL preserves the activity timestamp without reading and later restoring a stale value.
    const updated = await client.$executeRaw`
      UPDATE "Project"
      SET "archivedAt" = ${request.archived ? new Date(archivedAt) : null},
          "archiveRevision" = "archiveRevision" + 1
      WHERE "id" = ${request.id}
        AND "deletedAt" IS NULL
        AND "archiveRevision" = ${request.expectedArchiveRevision}
    `
    if (updated !== 1) {
      const current = await client.project.findUnique({ where: { id: request.id } })
      if (!current || current.deletedAt !== null) throw new Error('Project not found.')
      throw new Error('Project archive state changed elsewhere.')
    }

    const row = await client.project.findUnique({ where: { id: request.id } })
    if (!row || row.deletedAt !== null) throw new Error('Project not found.')
    return this.present(row)
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
      await transaction.projectLiterature.deleteMany({ where: { projectId: id } })
      await transaction.projectPreviewState.deleteMany({ where: { projectId: id } })
      await transaction.sessionReplayProgress.deleteMany({ where: { projectId: id } })
      await transaction.sessionDiscussionSnapshot.deleteMany({ where: { sourceProjectId: id } })
      await transaction.bookmark.deleteMany({ where: { projectId: id } })
      await deletePdfAnnotations(transaction, { projectId: id })
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
    if (this.recordOptions)
      await markProjectRecordDetached(this.recordOptions.storageRoot(), projectId)
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
