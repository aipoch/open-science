import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { ActivePlanProjection, PlanLifecycle } from '../../shared/session-plan/contract'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { defaultFileDurability } from '../storage/file-durability'
import { retryFileReplacement } from '../storage/file-replacement'
import { planContextFilePlatformStrategy } from './plan-context-file-windows-strategy'

const PLAN_CONTEXT_DIRECTORY = 'session-plan'
const PLAN_CONTEXT_FILE = 'current.json'

type PlanContextProjectionFields = Pick<
  ActivePlanProjection,
  | 'artifactVersionId'
  | 'artifactChecksum'
  | 'revision'
  | 'approval'
  | 'lifecycle'
  | 'document'
  | 'stepStates'
>

export type PlanContextFile =
  | (Readonly<{ schemaVersion: 1; active: boolean }> & PlanContextProjectionFields)
  | Readonly<{ schemaVersion: 1; active: false }>

export type PlanContextFileStoreOptions = Readonly<{
  storageRoot: string
  readCurrent: (projectId: string, sessionId: string) => Promise<ActivePlanProjection | undefined>
  platform?: NodeJS.Platform
  renameFile?: typeof rename
}>

export type PlanContextFileReference = Readonly<{
  path: string
  artifactVersionId: string
  revision: number
}>

type FileIdentity = Readonly<{ dev: number | bigint; ino: number | bigint }>

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const assertDirectory = async (path: string, label: string): Promise<FileIdentity> => {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`)
  }
  return { dev: metadata.dev, ino: metadata.ino }
}

const ensureDirectory = async (
  path: string,
  label: string,
  mode: number
): Promise<FileIdentity> => {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined
    throw error
  })
  if (existing === undefined) {
    await mkdir(path, { mode }).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        return
      }
      throw error
    })
  }
  return assertDirectory(path, label)
}

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino

const assertDestinationFile = async (path: string): Promise<void> => {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined
    throw error
  })
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error('Session Plan context file must be a regular file.')
  }
}

const planIsActive = (
  approval: ActivePlanProjection['approval'],
  lifecycle: PlanLifecycle
): boolean => approval === 'approved' && (lifecycle === 'approved' || lifecycle === 'in_progress')

const projectPlanContext = (projection: ActivePlanProjection): PlanContextFile => ({
  schemaVersion: 1,
  active: planIsActive(projection.approval, projection.lifecycle),
  artifactVersionId: projection.artifactVersionId,
  artifactChecksum: projection.artifactChecksum,
  revision: projection.revision,
  approval: projection.approval,
  lifecycle: projection.lifecycle,
  document: projection.document,
  stepStates: projection.stepStates
})

const tombstone: PlanContextFile = { schemaVersion: 1, active: false }

export class PlanContextFileStore {
  private readonly lanes = new Map<string, Promise<void>>()

  constructor(private readonly options: PlanContextFileStoreOptions) {}

  async refresh(
    projectId: string,
    sessionId: string
  ): Promise<PlanContextFileReference | undefined> {
    const laneKey = `${projectId}\u0000${sessionId}`
    const previous = this.lanes.get(laneKey) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveLane) => {
      release = resolveLane
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.lanes.set(laneKey, tail)

    await previous.catch(() => undefined)
    try {
      return await this.refreshInLane(projectId, sessionId)
    } finally {
      release()
      if (this.lanes.get(laneKey) === tail) this.lanes.delete(laneKey)
    }
  }

  private async refreshInLane(
    projectId: string,
    sessionId: string
  ): Promise<PlanContextFileReference | undefined> {
    let projection: ActivePlanProjection | undefined
    try {
      projection = await this.options.readCurrent(projectId, sessionId)
    } catch (error) {
      await this.invalidate(projectId, sessionId)
      throw error
    }

    const value = projection === undefined ? tombstone : projectPlanContext(projection)
    try {
      const path = await this.write(projectId, sessionId, value)
      return projection === undefined
        ? undefined
        : {
            path,
            artifactVersionId: projection.artifactVersionId,
            revision: projection.revision
          }
    } catch (error) {
      await this.invalidate(projectId, sessionId)
      throw error
    }
  }

  private async invalidate(projectId: string, sessionId: string): Promise<void> {
    try {
      await this.write(projectId, sessionId, tombstone)
      return
    } catch {
      // A failed tombstone publication must not leave an older active record available when the
      // safely validated target can still be removed. The originating read/write error remains the
      // caller-visible failure; cleanup is best effort and never claims that invalidation succeeded.
    }
    await this.removeCurrent(projectId, sessionId).catch(() => undefined)
  }

  private async removeCurrent(projectId: string, sessionId: string): Promise<void> {
    const directory = await this.ensureContextDirectory(projectId, sessionId)
    const directoryIdentity = await assertDirectory(directory, 'Session Plan context directory')
    const path = join(directory, PLAN_CONTEXT_FILE)
    await assertDestinationFile(path)
    const currentDirectoryIdentity = await assertDirectory(
      directory,
      'Session Plan context directory'
    )
    if (!sameIdentity(directoryIdentity, currentDirectoryIdentity)) {
      throw new Error('Session Plan context directory changed during invalidation.')
    }
    await rm(path, { force: true })
    await defaultFileDurability.syncDirectory(directory)
  }

  private async ensureContextDirectory(projectId: string, sessionId: string): Promise<string> {
    const storageRoot = resolve(this.options.storageRoot)
    await assertDirectory(storageRoot, 'Storage root')

    const inputRoot = resolve(getNotebookInputRoot(storageRoot, projectId, sessionId))
    const relativeInputRoot = relative(storageRoot, inputRoot)
    if (
      relativeInputRoot === '' ||
      relativeInputRoot.startsWith(`..${sep}`) ||
      relativeInputRoot === '..'
    ) {
      throw new Error('Notebook input root escapes the storage root.')
    }

    let current = storageRoot
    for (const segment of relativeInputRoot.split(sep)) {
      current = join(current, segment)
      await ensureDirectory(current, 'Notebook input directory', 0o700)
    }

    const directory = join(inputRoot, PLAN_CONTEXT_DIRECTORY)
    await ensureDirectory(directory, 'Session Plan context directory', 0o700)
    await chmod(directory, 0o700)
    return directory
  }

  private async write(
    projectId: string,
    sessionId: string,
    value: PlanContextFile
  ): Promise<string> {
    const directory = await this.ensureContextDirectory(projectId, sessionId)
    const directoryIdentity = await assertDirectory(directory, 'Session Plan context directory')
    const path = join(directory, PLAN_CONTEXT_FILE)
    await assertDestinationFile(path)

    const contents = `${JSON.stringify(value, null, 2)}\n`
    const temporaryPath = join(directory, `.${PLAN_CONTEXT_FILE}.${randomUUID()}.tmp`)
    const { publishedMode } = planContextFilePlatformStrategy(
      this.options.platform ?? process.platform
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.chmod(publishedMode)
      await handle.close()
      handle = undefined

      const currentDirectoryIdentity = await assertDirectory(
        directory,
        'Session Plan context directory'
      )
      if (!sameIdentity(directoryIdentity, currentDirectoryIdentity)) {
        throw new Error('Session Plan context directory changed during publication.')
      }
      await assertDestinationFile(path)
      await retryFileReplacement(() => (this.options.renameFile ?? rename)(temporaryPath, path))
      await defaultFileDurability.syncDirectory(directory)
      return path
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
