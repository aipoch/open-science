import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveDataRoot } from '../storage-root'
import { bindStorageRoot } from '../storage/root-binding'
import {
  locateManagedWorkspacePath,
  type ManagedWorkspacePath
} from '../storage/workspace-location'
import {
  assertManagedWorkspacesRoot,
  finalizeManagedWorkspaceOwnership,
  initializeManagedWorkspaceOwnership,
  removeManagedWorkspaceOwnership,
  removeManagedWorkspaceDirectory
} from '../storage/managed-workspace-ownership'

type ManagedSessionWorkspaceLease = {
  readonly cwd: string
  commit(sessionId: string): Promise<void>
  release(): Promise<void>
}

type ManagedSessionWorkspaceCapability = {
  acquire(input: { projectId: string }): Promise<ManagedSessionWorkspaceLease>
}

type ManagedSessionWorkspaceDependencies = {
  bindRoot: typeof bindStorageRoot
  resolveRoot: () => string
  createId: () => string
  createDirectory: (path: string) => Promise<void>
  removeDirectory: (path: ManagedWorkspacePath, dataRoot: string) => Promise<void>
  initializeOwnership: (path: string, projectId: string, dataRoot: string) => Promise<void>
  finalizeOwnership: (path: string, sessionId: string, dataRoot: string) => Promise<void>
  removeOwnership: (path: ManagedWorkspacePath, dataRoot: string) => Promise<void>
}

const defaultDependencies: ManagedSessionWorkspaceDependencies = {
  bindRoot: bindStorageRoot,
  resolveRoot: resolveDataRoot,
  createId: randomUUID,
  createDirectory: async (path) => {
    const workspacesRoot = dirname(path)
    await mkdir(workspacesRoot, { recursive: true })
    if (!(await assertManagedWorkspacesRoot(workspacesRoot))) {
      throw new Error('Managed workspaces root is missing.')
    }
    await mkdir(path, { recursive: false })
  },
  removeDirectory: removeManagedWorkspaceDirectory,
  initializeOwnership: (path, projectId, dataRoot) =>
    initializeManagedWorkspaceOwnership(path, projectId, Date.now(), dataRoot),
  finalizeOwnership: (path, sessionId, dataRoot) =>
    finalizeManagedWorkspaceOwnership(path, sessionId, Date.now(), dataRoot),
  removeOwnership: removeManagedWorkspaceOwnership
}

// Owns the provisional directory from allocation until the application workflow either publishes the
// Session or releases it. A committed directory becomes ordinary user workspace storage; an
// uncommitted directory is removed best effort so cleanup can never replace the Session startup error.
const createManagedSessionWorkspaceCapability = (
  dependencies: Partial<ManagedSessionWorkspaceDependencies> = {}
): ManagedSessionWorkspaceCapability => {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies }

  return {
    async acquire(input): Promise<ManagedSessionWorkspaceLease> {
      const dataRoot = resolvedDependencies.resolveRoot()
      const cwd = locateManagedWorkspacePath(
        join(dataRoot, 'workspaces', resolvedDependencies.createId()),
        dataRoot
      )
      if (!cwd) throw new Error('Managed workspace identity is outside the app workspace root.')
      const rootBinding = resolvedDependencies.bindRoot(dataRoot)
      await rootBinding.prepare((path) => mkdir(path))
      await resolvedDependencies.createDirectory(cwd)
      const workspaceBinding = resolvedDependencies.bindRoot(cwd)
      const verify = async (): Promise<void> => {
        await rootBinding.verify()
        await workspaceBinding.verify()
      }
      const remove = async (): Promise<void> => {
        await verify()
        await resolvedDependencies.removeDirectory(cwd, dataRoot)
        await rootBinding.verify()
        await resolvedDependencies.removeOwnership(cwd, dataRoot)
      }
      try {
        await resolvedDependencies.initializeOwnership(cwd, input.projectId, dataRoot)
      } catch (error) {
        await remove().catch(() => undefined)
        throw error
      }

      let committed = false
      let released = false
      return {
        cwd,
        commit: async (sessionId) => {
          if (released) return
          await verify()
          await resolvedDependencies.finalizeOwnership(cwd, sessionId, dataRoot)
          committed = true
        },
        release: async () => {
          if (released) return
          released = true
          if (committed) return
          await remove().catch(() => undefined)
        }
      }
    }
  }
}

export { createManagedSessionWorkspaceCapability }
export type { ManagedSessionWorkspaceCapability, ManagedSessionWorkspaceLease }
