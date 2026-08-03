import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveDataRoot } from '../storage-root'

type ManagedSessionWorkspaceLease = {
  readonly cwd: string
  commit(): void
  release(): Promise<void>
}

type ManagedSessionWorkspaceCapability = {
  acquire(): Promise<ManagedSessionWorkspaceLease>
}

type ManagedSessionWorkspaceDependencies = {
  resolveRoot: () => string
  createId: () => string
  createDirectory: (path: string) => Promise<void>
  removeDirectory: (path: string) => Promise<void>
}

const defaultDependencies: ManagedSessionWorkspaceDependencies = {
  resolveRoot: resolveDataRoot,
  createId: randomUUID,
  createDirectory: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  removeDirectory: (path) => rm(path, { recursive: true, force: true })
}

// Owns the provisional directory from allocation until the application workflow either publishes the
// Session or releases it. A committed directory becomes ordinary user workspace storage; an
// uncommitted directory is removed best effort so cleanup can never replace the Session startup error.
const createManagedSessionWorkspaceCapability = (
  dependencies: Partial<ManagedSessionWorkspaceDependencies> = {}
): ManagedSessionWorkspaceCapability => {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies }

  return {
    async acquire(): Promise<ManagedSessionWorkspaceLease> {
      const cwd = join(
        resolvedDependencies.resolveRoot(),
        'workspaces',
        resolvedDependencies.createId()
      )
      await resolvedDependencies.createDirectory(cwd)

      let committed = false
      let released = false
      return {
        cwd,
        commit: () => {
          if (!released) committed = true
        },
        release: async () => {
          if (released) return
          released = true
          if (committed) return
          await resolvedDependencies.removeDirectory(cwd).catch(() => undefined)
        }
      }
    }
  }
}

export { createManagedSessionWorkspaceCapability }
export type { ManagedSessionWorkspaceCapability, ManagedSessionWorkspaceLease }
