import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveDataRoot } from '../storage-root'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from './durable-json-file'

const MANAGED_WORKSPACE_OWNERSHIP_DIR = '.ownership'
const MANAGED_WORKSPACE_OWNERSHIP_VERSION = 1

type ManagedWorkspaceOwnership = Readonly<{
  version: typeof MANAGED_WORKSPACE_OWNERSHIP_VERSION
  workspaceId: string
  projectId: string
  sessionId?: string
  createdAt: number
  lastUsedAt: number
  retainedAfterDelete: boolean
}>

type ManagedWorkspaceLocation = Readonly<{
  workspacesRoot: string
  directory: string
  workspaceId: string
  ownershipDirectory: string
  receiptPath: string
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isFileSystemError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code

const decodeOwnership = (contents: string): ManagedWorkspaceOwnership => {
  const value: unknown = JSON.parse(contents)
  if (!isRecord(value)) throw new Error('Managed workspace ownership receipt must be an object.')
  if (typeof value.version === 'number' && value.version > MANAGED_WORKSPACE_OWNERSHIP_VERSION) {
    throw new DurableJsonRecoveryBarrierError(
      `Unsupported managed workspace ownership version: ${value.version}`
    )
  }
  if (
    value.version !== MANAGED_WORKSPACE_OWNERSHIP_VERSION ||
    typeof value.workspaceId !== 'string' ||
    !value.workspaceId ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !value.sessionId)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.lastUsedAt) ||
    typeof value.retainedAfterDelete !== 'boolean'
  ) {
    throw new Error('Managed workspace ownership receipt is invalid.')
  }
  return {
    version: MANAGED_WORKSPACE_OWNERSHIP_VERSION,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
    retainedAfterDelete: value.retainedAfterDelete
  }
}

const locateManagedWorkspace = (
  cwd: string,
  dataRoot = resolveDataRoot()
): ManagedWorkspaceLocation | undefined => {
  const workspacesRoot = resolve(dataRoot, 'workspaces')
  const directory = resolve(cwd)
  const workspaceId = relative(workspacesRoot, directory)
  if (
    !workspaceId ||
    workspaceId === MANAGED_WORKSPACE_OWNERSHIP_DIR ||
    workspaceId === '..' ||
    workspaceId.startsWith(`..${sep}`) ||
    isAbsolute(workspaceId) ||
    workspaceId.includes(sep)
  ) {
    return undefined
  }
  const ownershipDirectory = join(workspacesRoot, MANAGED_WORKSPACE_OWNERSHIP_DIR)
  return {
    workspacesRoot,
    directory,
    workspaceId,
    ownershipDirectory,
    receiptPath: join(ownershipDirectory, `${workspaceId}.json`)
  }
}

const assertManagedWorkspacesRoot = async (workspacesRoot: string): Promise<boolean> => {
  let info
  try {
    info = await lstat(workspacesRoot)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed workspaces root must be a regular directory.')
  }
  return true
}

const assertManagedWorkspaceDirectory = async (
  cwd: string,
  dataRoot?: string
): Promise<ManagedWorkspaceLocation | undefined> => {
  const location = locateManagedWorkspace(cwd, dataRoot)
  if (!location) return undefined
  if (!(await assertManagedWorkspacesRoot(location.workspacesRoot))) return undefined
  let info
  try {
    info = await lstat(location.directory)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed workspace must be a regular directory.')
  }
  return location
}

const assertOwnershipDirectoryPath = async (
  workspacesRoot: string,
  ownershipDirectory: string
): Promise<boolean> => {
  if (!(await assertManagedWorkspacesRoot(workspacesRoot))) return false
  let info
  try {
    info = await lstat(ownershipDirectory)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed workspace ownership path must be a regular directory.')
  }
  return true
}

const assertOwnershipDirectory = (location: ManagedWorkspaceLocation): Promise<boolean> =>
  assertOwnershipDirectoryPath(location.workspacesRoot, location.ownershipDirectory)

const listManagedWorkspaceOwnershipLocations = async (
  dataRoot: string
): Promise<ManagedWorkspaceLocation[]> => {
  const workspacesRoot = resolve(dataRoot, 'workspaces')
  const ownershipDirectory = join(workspacesRoot, MANAGED_WORKSPACE_OWNERSHIP_DIR)
  if (!(await assertOwnershipDirectoryPath(workspacesRoot, ownershipDirectory))) return []

  const locations: ManagedWorkspaceLocation[] = []
  for (const entry of await readdir(ownershipDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const workspaceId = entry.name.slice(0, -'.json'.length)
    const location = locateManagedWorkspace(join(workspacesRoot, workspaceId), dataRoot)
    if (location?.receiptPath === join(ownershipDirectory, entry.name)) locations.push(location)
  }
  return locations
}

const ensureOwnershipDirectory = async (location: ManagedWorkspaceLocation): Promise<void> => {
  if (!(await assertManagedWorkspacesRoot(location.workspacesRoot))) {
    throw new Error('Managed workspaces root is missing.')
  }
  try {
    await mkdir(location.ownershipDirectory, { recursive: false })
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error
  }
  if (!(await assertOwnershipDirectory(location))) {
    throw new Error('Managed workspace ownership directory is missing.')
  }
}

const readOwnershipForUpdate = async (
  location: ManagedWorkspaceLocation
): Promise<ManagedWorkspaceOwnership | undefined> => {
  if (!(await assertOwnershipDirectory(location))) return undefined
  const result = await readDurableJsonFile(location.receiptPath, decodeOwnership)
  if (result.status === 'missing') return undefined
  if (result.value.workspaceId !== location.workspaceId) {
    throw new Error('Managed workspace ownership does not match its directory.')
  }
  return result.value
}

const writeOwnership = (
  location: ManagedWorkspaceLocation,
  ownership: ManagedWorkspaceOwnership
): Promise<void> =>
  ensureOwnershipDirectory(location).then(() =>
    writeDurableJsonFile(location.receiptPath, `${JSON.stringify(ownership, null, 2)}\n`)
  )

const initializeManagedWorkspaceOwnership = async (
  cwd: string,
  projectId: string,
  createdAt = Date.now(),
  dataRoot?: string
): Promise<void> => {
  const location = await assertManagedWorkspaceDirectory(cwd, dataRoot)
  if (!location) throw new Error('Managed workspace is outside the app workspace root.')
  if (!projectId.trim()) throw new Error('Managed workspace Project identity is required.')
  if (await readOwnershipForUpdate(location)) {
    throw new Error('Managed workspace already has an ownership receipt.')
  }
  await writeOwnership(location, {
    version: MANAGED_WORKSPACE_OWNERSHIP_VERSION,
    workspaceId: location.workspaceId,
    projectId,
    createdAt,
    lastUsedAt: createdAt,
    retainedAfterDelete: false
  })
}

const finalizeManagedWorkspaceOwnership = async (
  cwd: string,
  sessionId: string,
  lastUsedAt = Date.now(),
  dataRoot?: string
): Promise<void> => {
  const location = await assertManagedWorkspaceDirectory(cwd, dataRoot)
  if (!location) throw new Error('Managed workspace is outside the app workspace root.')
  const current = await readOwnershipForUpdate(location)
  if (!current) throw new Error('Managed workspace ownership receipt is missing.')
  if (!sessionId.trim()) throw new Error('Managed workspace Session identity is required.')
  if (current.sessionId && current.sessionId !== sessionId) {
    throw new Error('Managed workspace is already owned by another Session.')
  }
  await writeOwnership(location, {
    ...current,
    sessionId,
    lastUsedAt: Math.max(current.lastUsedAt, lastUsedAt)
  })
}

const markManagedWorkspaceRetained = async (
  session: Pick<PersistedChatSession, 'cwd' | 'projectId' | 'id' | 'createdAt' | 'updatedAt'>,
  dataRoot?: string
): Promise<boolean> => {
  const candidate = locateManagedWorkspace(session.cwd, dataRoot)
  if (!candidate) return false
  const location = await assertManagedWorkspaceDirectory(session.cwd, dataRoot)
  if (!location) {
    let orphanedOwnership: ManagedWorkspaceOwnership | undefined
    try {
      orphanedOwnership = await readOwnershipForUpdate(candidate)
    } catch {
      return false
    }
    if (
      orphanedOwnership?.projectId === session.projectId &&
      (orphanedOwnership.sessionId === undefined || orphanedOwnership.sessionId === session.id)
    ) {
      await rm(candidate.receiptPath, { force: true, recursive: false })
    }
    return false
  }
  const current = await readOwnershipForUpdate(candidate)
  if (!current) return false
  if (current.projectId !== session.projectId) {
    throw new Error('Managed workspace ownership conflicts with the deleting Session.')
  }
  if (current.sessionId !== undefined && current.sessionId !== session.id) return false
  await writeOwnership(location, {
    version: MANAGED_WORKSPACE_OWNERSHIP_VERSION,
    workspaceId: location.workspaceId,
    projectId: session.projectId,
    sessionId: session.id,
    createdAt: current.createdAt,
    lastUsedAt: Math.max(current.lastUsedAt, session.updatedAt),
    retainedAfterDelete: true
  })
  return true
}

const restoreManagedWorkspaceActive = async (
  session: Pick<PersistedChatSession, 'cwd' | 'projectId' | 'id'>,
  dataRoot?: string
): Promise<void> => {
  const location = await assertManagedWorkspaceDirectory(session.cwd, dataRoot)
  if (!location) return
  const current = await readOwnershipForUpdate(location)
  if (!current) return
  if (current.projectId !== session.projectId || current.sessionId !== session.id) {
    throw new Error('Managed workspace ownership conflicts with the restored Session.')
  }
  await writeOwnership(location, { ...current, retainedAfterDelete: false })
}

const restoreManagedProjectWorkspacesActive = async (
  projectId: string,
  directories: readonly string[],
  dataRoot = resolveDataRoot()
): Promise<void> => {
  const failures: unknown[] = []
  for (const directory of directories) {
    try {
      const location = locateManagedWorkspace(directory, dataRoot)
      if (!location) continue
      const current = await readOwnershipForUpdate(location)
      if (!current || !current.retainedAfterDelete) continue
      if (current.projectId !== projectId) {
        throw new Error('Managed workspace ownership conflicts with the restored Project.')
      }
      await writeOwnership(location, { ...current, retainedAfterDelete: false })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Managed Project workspace ownership restoration failed.')
  }
}

const markManagedProjectWorkspacesRetained = async (
  projectId: string,
  dataRoot = resolveDataRoot()
): Promise<readonly string[]> => {
  if (!projectId.trim()) throw new Error('Managed workspace Project identity is required.')
  const retainedDirectories: string[] = []
  try {
    for (const location of await listManagedWorkspaceOwnershipLocations(dataRoot)) {
      let current: ManagedWorkspaceOwnership | undefined
      try {
        current = await readOwnershipForUpdate(location)
      } catch {
        continue
      }
      if (!current || current.projectId !== projectId || current.retainedAfterDelete) continue
      retainedDirectories.push(location.directory)
      await writeOwnership(location, { ...current, retainedAfterDelete: true })
    }
    return retainedDirectories
  } catch (error) {
    try {
      await restoreManagedProjectWorkspacesActive(projectId, retainedDirectories, dataRoot)
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Managed Project workspace ownership retention failed and rollback was incomplete.'
      )
    }
    throw error
  }
}

const reconcileProvisionalManagedWorkspaces = async (
  sessions: readonly Pick<PersistedChatSession, 'cwd' | 'projectId' | 'id' | 'updatedAt'>[],
  createdBefore: number,
  dataRoot = resolveDataRoot()
): Promise<void> => {
  const sessionsByDirectory = new Map<string, typeof sessions>()
  for (const session of sessions) {
    const directory = resolve(session.cwd)
    sessionsByDirectory.set(directory, [...(sessionsByDirectory.get(directory) ?? []), session])
  }

  let firstFailure: unknown
  for (const location of await listManagedWorkspaceOwnershipLocations(dataRoot)) {
    try {
      const ownership = await readOwnershipForUpdate(location)
      if (!ownership || ownership.sessionId || ownership.retainedAfterDelete) continue

      const matchingSessions = sessionsByDirectory.get(location.directory) ?? []
      if (matchingSessions.length > 0) {
        if (
          matchingSessions.length === 1 &&
          matchingSessions[0].projectId === ownership.projectId
        ) {
          await finalizeManagedWorkspaceOwnership(
            location.directory,
            matchingSessions[0].id,
            matchingSessions[0].updatedAt,
            dataRoot
          )
        }
        continue
      }
      if (ownership.createdAt >= createdBefore) continue

      const workspace = await assertManagedWorkspaceDirectory(location.directory, dataRoot)
      if (workspace) await rm(workspace.directory, { recursive: true, force: true })
      await removeManagedWorkspaceOwnership(location.directory, dataRoot)
    } catch (error) {
      firstFailure ??= error
    }
  }
  if (firstFailure) throw firstFailure
}

const readManagedWorkspaceOwnership = async (
  cwd: string,
  dataRoot?: string
): Promise<ManagedWorkspaceOwnership | undefined> => {
  try {
    const location = await assertManagedWorkspaceDirectory(cwd, dataRoot)
    return location ? await readOwnershipForUpdate(location) : undefined
  } catch {
    // Corrupt, unreadable, future, or untrusted receipts stay visible as unknown and never authorize
    // cleanup. Writers still fail closed through the strict helpers above.
    return undefined
  }
}

const removeManagedWorkspaceOwnership = async (cwd: string, dataRoot?: string): Promise<void> => {
  const location = locateManagedWorkspace(cwd, dataRoot)
  if (!location) return
  try {
    if (!(await assertOwnershipDirectory(location))) return
  } catch {
    return
  }
  await rm(location.receiptPath, { force: true, recursive: false })
}

export {
  MANAGED_WORKSPACE_OWNERSHIP_DIR,
  assertManagedWorkspacesRoot,
  finalizeManagedWorkspaceOwnership,
  initializeManagedWorkspaceOwnership,
  markManagedProjectWorkspacesRetained,
  markManagedWorkspaceRetained,
  readManagedWorkspaceOwnership,
  reconcileProvisionalManagedWorkspaces,
  removeManagedWorkspaceOwnership,
  restoreManagedProjectWorkspacesActive,
  restoreManagedWorkspaceActive
}
export type { ManagedWorkspaceOwnership }
