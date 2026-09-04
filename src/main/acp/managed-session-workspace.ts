import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveDataRoot } from '../storage-root'
import {
  assertManagedWorkspacesRoot,
  finalizeManagedWorkspaceOwnership,
  initializeManagedWorkspaceOwnership,
  removeManagedWorkspaceOwnership
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
  resolveRoot: () => string
  createId: () => string
  createDirectory: (path: string) => Promise<void>
  removeDirectory: (path: string) => Promise<void>
  initializeOwnership: (path: string, projectId: string, dataRoot: string) => Promise<void>
  finalizeOwnership: (path: string, sessionId: string, dataRoot: string) => Promise<void>
  removeOwnership: (path: string, dataRoot: string) => Promise<void>
}

const defaultDependencies: ManagedSessionWorkspaceDependencies = {
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
  removeDirectory: async (path) => {
    if (!(await assertManagedWorkspacesRoot(dirname(path)))) return
    await rm(path, { recursive: true, force: true })
  },
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
      const cwd = join(dataRoot, 'workspaces', resolvedDependencies.createId())
      await resolvedDependencies.createDirectory(cwd)
      try {
        await resolvedDependencies.initializeOwnership(cwd, input.projectId, dataRoot)
      } catch (error) {
        await resolvedDependencies
          .removeDirectory(cwd)
          .then(() => resolvedDependencies.removeOwnership(cwd, dataRoot))
          .catch(() => undefined)
        throw error
      }

      let committed = false
      let released = false
      return {
        cwd,
        commit: async (sessionId) => {
          if (released) return
          await resolvedDependencies.finalizeOwnership(cwd, sessionId, dataRoot)
          committed = true
        },
        release: async () => {
          if (released) return
          released = true
          if (committed) return
          await resolvedDependencies
            .removeDirectory(cwd)
            .then(() => resolvedDependencies.removeOwnership(cwd, dataRoot))
            .catch(() => undefined)
        }
      }
    }
  }
}

export { createManagedSessionWorkspaceCapability }
export type { ManagedSessionWorkspaceCapability, ManagedSessionWorkspaceLease }
