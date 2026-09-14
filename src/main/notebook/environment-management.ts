import type {
  NotebookEnvironmentLock,
  NotebookKernelMetadata,
  NotebookLanguage
} from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult
} from '../../shared/notebook-env'
import type { NotebookEnvironmentOperations } from './environment-operations'
import { assertSafeEnvName, envPrefix } from './runtime-paths'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import { managedRuntimeIdentity } from './runtime-target'

type NotebookEnvironmentManager = {
  createNamedEnvironment: (
    name: string,
    language: NotebookLanguage,
    packages?: string[],
    request?: Extract<ManageEnvironmentsRequest, { action: 'create' }>,
    signal?: AbortSignal
  ) => Promise<EnvironmentInfo>
  createNamedEnvironmentFromLock?: (
    name: string,
    language: NotebookLanguage,
    lock: NotebookEnvironmentLock,
    lockChecksum: string,
    request?: { projectId?: string }
  ) => Promise<{ environment: EnvironmentInfo; reused: boolean }>
  listEnvironments: (signal?: AbortSignal) => EnvironmentInfo[] | Promise<EnvironmentInfo[]>
  removeEnvironment: (name: string) => void
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

/** Owns named-environment validation, lifecycle ordering, and live-use protection. */
class NotebookEnvironmentManagementOwner {
  private manager: NotebookEnvironmentManager | undefined

  constructor(private readonly options: NotebookEnvironmentManagementOptions) {
    this.manager = options.manager
  }

  setManager(manager: NotebookEnvironmentManager): void {
    this.manager = manager
  }

  async manage(
    request: ManageEnvironmentsRequest,
    signal?: AbortSignal
  ): Promise<ManageEnvironmentsResult> {
    signal?.throwIfAborted()
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
        signal?.throwIfAborted()
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(
          name,
          async () => {
            signal?.throwIfAborted()
            const created = await manager.createNamedEnvironment(
              name,
              request.language,
              request.packages,
              request,
              signal
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
          },
          signal
        )
      }
      case 'list': {
        const environments = await manager.listEnvironments(signal)
        signal?.throwIfAborted()
        return { environments }
      }
      case 'remove': {
        const name = assertSafeEnvName(request.name)
        const liveKernel = this.liveKernel(name)
        if (liveKernel) {
          throw new Error(
            `Environment "${name}" is in use by a live ${liveKernel.language} Kernel ` +
              `(status: ${liveKernel.status}) in Session "${liveKernel.sessionId}". ` +
              'Waiting for a Run to finish leaves an idle Kernel alive. In that Session, use ' +
              'list_notebook_runtimes then notebook_switch_runtime with the language and an exact ' +
              'runtimeId for another Runtime Environment, or notebook_shutdown to stop its Kernels. ' +
              'These actions clear the affected Kernel memory. If a Runtime Binding still blocks removal, ' +
              'switch that binding to another environment.'
          )
        }
        const blockingBinding = this.blockingBinding(name)
        if (blockingBinding) {
          const bindingState = blockingBinding.status === 'active' ? 'an active' : 'a revoking'
          throw new Error(
            `Environment "${name}" cannot be removed because Session ` +
              `"${blockingBinding.sessionId}" has ${bindingState} Runtime Binding ` +
              'to it. In that Session, use list_notebook_runtimes then notebook_switch_runtime with ' +
              'the language and an exact runtimeId for another Runtime Environment. Switching clears ' +
              'the previous Kernel memory.'
          )
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(
          name,
          async () => {
            signal?.throwIfAborted()
            manager.removeEnvironment(name)
            this.options.runtimeRepair.completeRemovedManagedEnvironment(name)
            return { removed: { name } }
          },
          signal
        )
      }
    }
  }

  async importLock(input: {
    projectId?: string
    language: NotebookLanguage
    lock: NotebookEnvironmentLock
    lockChecksum: string
  }): Promise<{ environmentName: string; reused: boolean }> {
    const manager = this.manager
    if (!manager?.createNamedEnvironmentFromLock) {
      throw new Error('Environment lock import is unavailable.')
    }
    if (input.language !== 'python' && input.language !== 'r') {
      throw new Error('An imported environment requires Python or R.')
    }
    const name = assertSafeEnvName(`repro-${input.lockChecksum.slice(0, 12)}`)
    await this.options.ensureRecovered()
    this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
    return this.options.environmentOperations.runMutation(name, async () => {
      const result = await manager.createNamedEnvironmentFromLock!(
        name,
        input.language,
        input.lock,
        input.lockChecksum,
        input.projectId ? { projectId: input.projectId } : undefined
      )
      return { environmentName: result.environment.name, reused: result.reused }
    })
  }

  private liveKernel(name: string):
    | {
        sessionId: string
        language: string
        status: NotebookKernelMetadata['lastKnownStatus']
      }
    | undefined {
    for (const session of this.options.sessions()) {
      for (const [processKey, status] of session.kernelStatusEntries()) {
        if (processKey === 'repl' || status === 'terminated') continue
        if (processKey.slice(processKey.indexOf(':') + 1) === name) {
          return {
            sessionId: session.sessionId,
            language: processKey.slice(0, processKey.indexOf(':')),
            status
          }
        }
      }
    }
    return undefined
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
