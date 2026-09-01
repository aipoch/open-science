import type { NotebookKernelMetadata, NotebookLanguage } from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult
} from '../../shared/notebook-env'
import type { NotebookEnvironmentOperations } from './environment-operations'
import { assertSafeEnvName, DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix } from './runtime-paths'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import { managedRuntimeIdentity } from './runtime-target'

type NotebookEnvironmentManager = {
  createNamedEnvironment: (
    name: string,
    language: NotebookLanguage,
    packages?: string[],
    request?: Extract<ManageEnvironmentsRequest, { action: 'create' }>
  ) => Promise<EnvironmentInfo>
  listEnvironments: () => EnvironmentInfo[]
  removeEnvironment: (name: string) => void
  removeManagedEnvironment?: (language: NotebookLanguage) => void | Promise<void>
}

type EnvironmentManagementSession = {
  readonly sessionId: string
  kernelStatusEntries(): Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
  runtimeBindingEntries(): Array<[NotebookLanguage, NotebookSessionRuntimeBinding]>
}

type NotebookEnvironmentManagementOptions = {
  runtimeRoot: string
  manager?: NotebookEnvironmentManager
  sessions: () => Iterable<EnvironmentManagementSession>
  ensureRecovered: () => Promise<void>
  assertPrefixRecoverable: (prefix: string) => void
  environmentOperations: Pick<NotebookEnvironmentOperations, 'runMutation'>
  runtimeRepair: Pick<NotebookRuntimeRepairOwner, 'completeRemovedManagedEnvironment'>
  isAgentEnvironmentCreationEnabled: () => Promise<boolean>
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
        if (!(await this.options.isAgentEnvironmentCreationEnabled())) {
          throw new Error(
            'AGENT_ENVIRONMENT_CREATION_DISABLED: creating Runtime Environments by the Agent is ' +
              'disabled in Settings → Runtimes. Set up the Runtime there or enable Agent environment creation.'
          )
        }
        const name = assertSafeEnvName(request.name)
        if (request.language !== 'python' && request.language !== 'r') {
          throw new Error('Creating an environment requires a language of "python" or "r".')
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          const created = await manager.createNamedEnvironment(
            name,
            request.language,
            request.packages,
            request
          )
          const { runtimeId } = managedRuntimeIdentity(
            this.options.runtimeRoot,
            request.language,
            name
          )
          return {
            created: {
              name,
              language: request.language,
              runtimeId,
              runnable: created.ready
            }
          }
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
        const blockingBinding = this.blockingBinding(name)
        if (blockingBinding) {
          const bindingState = blockingBinding.status === 'active' ? 'an active' : 'a revoking'
          throw new Error(
            `Environment "${name}" cannot be removed because Session ` +
              `"${blockingBinding.sessionId}" has ${bindingState} Runtime Binding ` +
              'to it. Switch that Session to another Runtime Environment first.'
          )
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          manager.removeEnvironment(name)
          this.options.runtimeRepair.completeRemovedManagedEnvironment(name)
          return { removed: { name } }
        })
      }
    }
  }

  async uninstallManagedEnvironment(
    language: NotebookLanguage,
    beforeRemove: (environmentName: string) => Promise<void>
  ): Promise<void> {
    const manager = this.manager
    if (!manager?.removeManagedEnvironment) {
      throw new Error('Managed Runtime uninstall is unavailable.')
    }
    const environmentName = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
    await this.options.ensureRecovered()
    this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, environmentName))
    await this.options.environmentOperations.runMutation(environmentName, async () => {
      await beforeRemove(environmentName)
      await manager.removeManagedEnvironment?.(language)
      this.options.runtimeRepair.completeRemovedManagedEnvironment(environmentName)
    })
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

  private blockingBinding(
    name: string
  ): { sessionId: string; status: 'active' | 'revoking' } | undefined {
    for (const session of this.options.sessions()) {
      for (const [, binding] of session.runtimeBindingEntries()) {
        const status = binding.status ?? 'active'
        if (
          binding.provenance === 'agent-created' &&
          binding.envName === name &&
          (status === 'active' || status === 'revoking')
        ) {
          return { sessionId: session.sessionId, status }
        }
      }
    }
    return undefined
  }
}

export { NotebookEnvironmentManagementOwner }
export type { NotebookEnvironmentManager }
