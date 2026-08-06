import type { NotebookKernelMetadata, NotebookLanguage } from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult
} from '../../shared/notebook-env'
import type { NotebookEnvironmentOperations } from './environment-operations'
import { assertSafeEnvName, DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix } from './runtime-paths'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'

type NotebookEnvironmentManager = {
  createNamedEnvironment: (
    name: string,
    language: NotebookLanguage,
    packages?: string[]
  ) => Promise<EnvironmentInfo>
  listEnvironments: () => EnvironmentInfo[]
  removeEnvironment: (name: string) => EnvironmentInfo[]
}

type EnvironmentManagementSession = {
  kernelStatusEntries(): Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
}

type NotebookEnvironmentManagementOptions = {
  runtimeRoot: string
  manager?: NotebookEnvironmentManager
  sessions: () => Iterable<EnvironmentManagementSession>
  ensureRecovered: () => Promise<void>
  assertPrefixRecoverable: (prefix: string) => void
  environmentOperations: Pick<NotebookEnvironmentOperations, 'runMutation'>
  runtimeRepair: Pick<NotebookRuntimeRepairOwner, 'completeRemovedManagedEnvironment'>
}

const isAppManagedEnvironment = (name: string): boolean =>
  name === DEFAULT_PY_ENV ||
  name === DEFAULT_R_ENV ||
  name.startsWith(`${DEFAULT_PY_ENV}-`) ||
  name.startsWith(`${DEFAULT_R_ENV}-`)

/** Owns named-environment validation, lifecycle ordering, and live-use protection. */
class NotebookEnvironmentManagementOwner {
  private manager: NotebookEnvironmentManager | undefined

  constructor(private readonly options: NotebookEnvironmentManagementOptions) {
    this.manager = options.manager
  }

  setManager(manager: NotebookEnvironmentManager): void {
    this.manager = manager
  }

  async manage(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult> {
    const manager = this.manager
    if (!manager) {
      throw new Error('Environment management is unavailable (no environment manager configured).')
    }

    switch (request.action) {
      case 'create': {
        const name = assertSafeEnvName(request.name)
        if (request.language !== 'python' && request.language !== 'r') {
          throw new Error('Creating an environment requires a language of "python" or "r".')
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          await manager.createNamedEnvironment(name, request.language, request.packages)
          return { environments: manager.listEnvironments() }
        })
      }
      case 'list':
        return { environments: manager.listEnvironments() }
      case 'remove': {
        const name = assertSafeEnvName(request.name)
        if (isAppManagedEnvironment(name)) {
          throw new Error(
            `Environment "${name}" is app-managed and cannot be removed. Only environments you ` +
              'created with manage_environments(action:"create") can be removed.'
          )
        }
        if (this.isLive(name)) {
          throw new Error(
            `Environment "${name}" is in use by a running kernel — restart the notebook or ` +
              'wait for the run to finish before removing it.'
          )
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          const environments = manager.removeEnvironment(name)
          this.options.runtimeRepair.completeRemovedManagedEnvironment(name)
          return { environments }
        })
      }
    }
  }

  private isLive(name: string): boolean {
    for (const session of this.options.sessions()) {
      for (const [processKey, status] of session.kernelStatusEntries()) {
        if (processKey === 'repl' || status === 'terminated') continue
        if (processKey.slice(processKey.indexOf(':') + 1) === name) return true
      }
    }
    return false
  }
}

export { NotebookEnvironmentManagementOwner }
export type { NotebookEnvironmentManager }
