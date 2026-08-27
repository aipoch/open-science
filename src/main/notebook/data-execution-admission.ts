import { realpathSync } from 'node:fs'

import type { NotebookCell, NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import { NotebookEnvironmentOperations } from './environment-operations'
import { detectManagedRuntimeMutation } from './managed-runtime-guard'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  resolveEnvName
} from './runtime-paths'
import type { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type {
  NotebookSessionAggregate,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'

type NotebookDataExecutionRoute = Readonly<{
  environment: string
  processKey: string
}>

type NotebookDataExecutionAdmission = Readonly<{
  language: NotebookLanguage
  route: NotebookDataExecutionRoute
  binding?: NotebookSessionRuntimeBinding
  resolvedInterpreter?: NotebookSessionResolvedInterpreter
  rejection?: unknown
}>

type NotebookDataExecutionAdmissionOwnerOptions = {
  runtimeRoot: string
  environmentOperations: Pick<
    NotebookEnvironmentOperations,
    'ensureDefaultEnvironmentReady' | 'isRepairBlocked' | 'runShared'
  >
  recovery: Pick<
    NotebookRecoveryCoordinator,
    'isGloballyBlocked' | 'isPrefixBlocked' | 'isRuntimeIdBlocked'
  >
  ensureRecovered: () => Promise<void>
  resolveRuntimeEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>
  repairPolicy: Pick<NotebookRuntimeRepairPolicy, 'blockKey' | 'requirement'>
}

const defaultEnvironment = (language: NotebookLanguage): string =>
  language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV

const processKey = (language: NotebookLanguage, environment: string): string =>
  `${language === 'r' ? 'r' : 'python'}:${resolveEnvName(language, environment)}`

class NotebookRuntimeRepairRequiredError extends Error {}

const repairRequiredError = (language: NotebookLanguage): Error =>
  new NotebookRuntimeRepairRequiredError(
    `RUNTIME_REPAIR_REQUIRED: the bound ${language} runtime failed a protected-package ` +
      'integrity check. Run the runtime Repair workflow before executing another cell.'
  )

/** Owns data-cell routing plus every fail-closed gate before the executor may be dispatched. */
class NotebookDataExecutionAdmissionOwner {
  constructor(private readonly options: NotebookDataExecutionAdmissionOwnerOptions) {}

  route(session: NotebookSessionAggregate, language: NotebookLanguage): NotebookDataExecutionRoute {
    const binding = session.runtimeBinding(language)
    const environment =
      binding?.source === 'managed' && binding.envName
        ? binding.envName
        : defaultEnvironment(language)
    return { environment, processKey: processKey(language, environment) }
  }

  async admit(
    session: NotebookSessionAggregate,
    cell: Readonly<NotebookCell>
  ): Promise<NotebookDataExecutionAdmission> {
    const route = this.route(session, cell.language)
    const runtimeRoot = this.options.runtimeRoot
    await this.options.ensureRecovered()
    const binding = session.runtimeBinding(cell.language)
    const repair = this.options.repairPolicy.requirement(cell.language, route.environment, binding)
    let resolvedInterpreter: NotebookSessionResolvedInterpreter | undefined
    let rejection: unknown
    const isExternal = binding?.source === 'external'
    const recoveryBlocked =
      (binding?.runtimeId && this.options.recovery.isRuntimeIdBlocked(binding.runtimeId)) ||
      (!isExternal &&
        this.options.recovery.isPrefixBlocked(envPrefix(runtimeRoot, route.environment))) ||
      (isExternal && this.options.recovery.isGloballyBlocked())
    const repairRequired =
      this.options.environmentOperations.isRepairBlocked(
        this.options.repairPolicy.blockKey(cell.language, route.environment, binding)
      ) || repair.required

    if (recoveryBlocked) {
      rejection = new Error(
        `RUNTIME_RECOVERY_BLOCKED: the bound ${cell.language} runtime is recovering from an interrupted ` +
          'operation whose worker process could not be confirmed stopped, so running it now could ' +
          'corrupt it. Restart the app to re-check and recover it before running cells.'
      )
    } else if (repairRequired) {
      rejection = repairRequiredError(cell.language)
    } else if (binding && (binding.status ?? 'active') !== 'active') {
      rejection = new Error(
        `RUNTIME_BINDING_UNAVAILABLE: the bound ${cell.language} runtime is ${binding.status}` +
          (binding.reason ? ` (${binding.reason})` : '') +
          '. Call list_notebook_runtimes then notebook_switch_runtime to choose another runtime ' +
          '(an unspecified choice falls back to the app-managed default). Any prior kernel memory ' +
          '(variables, imports) for this language was lost.'
      )
    } else if (binding?.resolvedInterpreter) {
      resolvedInterpreter = binding.resolvedInterpreter
    } else {
      try {
        if (
          route.environment === defaultEnvironment(cell.language) &&
          (await this.isDefaultEnvironmentDisabled(cell.language, session.runtimeRoot))
        ) {
          throw new Error(
            `No enabled ${cell.language} runtime: the app-managed default is disabled and no runtime ` +
              'is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
              'list_notebook_runtimes then notebook_bind_runtime, before running cells.'
          )
        }
        await this.ensureDefaultEnvironmentReady(session, cell.language, route.environment)
      } catch (error) {
        rejection = error
      }
    }

    const blockedMutation = detectManagedRuntimeMutation({
      source: cell.code,
      surface: cell.language,
      runtimeRoot: session.runtimeRoot,
      cwd: session.cwd
    })
    if (blockedMutation && rejection === undefined) {
      rejection = new Error(`MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`)
    }
    return { language: cell.language, route, binding, resolvedInterpreter, rejection }
  }

  runShared<Result>(
    admission: NotebookDataExecutionAdmission,
    operation: (rejection: unknown | undefined) => Promise<Result>
  ): Promise<Result> {
    return this.options.environmentOperations.runShared(
      'execution',
      admission.route.environment,
      () => {
        const repair = this.options.repairPolicy.requirement(
          admission.language,
          admission.route.environment,
          admission.binding
        )
        const postLockRepairRequired =
          this.options.environmentOperations.isRepairBlocked(
            this.options.repairPolicy.blockKey(
              admission.language,
              admission.route.environment,
              admission.binding
            )
          ) || repair.required
        return operation(
          postLockRepairRequired
            ? repairRequiredError(admission.language)
            : admission.rejection instanceof NotebookRuntimeRepairRequiredError
              ? undefined
              : admission.rejection
        )
      }
    )
  }

  private async isDefaultEnvironmentDisabled(
    language: NotebookLanguage,
    runtimeRoot: string
  ): Promise<boolean> {
    const enablement = await this.options.resolveRuntimeEnablement(language)
    if (!enablement) return false
    const prefix = envPrefix(runtimeRoot, defaultEnvironment(language))
    const interpreter = language === 'r' ? rBin(prefix) : pythonBin(prefix)
    let environmentId = interpreter
    try {
      environmentId = realpathSync(interpreter)
    } catch {
      // The raw path is authoritative until the default runtime is materialized.
    }
    return enablement.enabled[environmentId] === false || enablement.enabled[interpreter] === false
  }

  private ensureDefaultEnvironmentReady(
    session: NotebookSessionAggregate,
    language: NotebookLanguage,
    environment: string
  ): Promise<void> {
    return this.options.environmentOperations.ensureDefaultEnvironmentReady({
      language,
      environment,
      runtimeRoot: session.runtimeRoot,
      sessionId: session.sessionId,
      ensureRecovered: this.options.ensureRecovered,
      assertRecoverable: () => {
        const prefix = envPrefix(session.runtimeRoot, environment)
        if (this.options.recovery.isPrefixBlocked(prefix)) {
          throw new Error(
            `RUNTIME_RECOVERY_BLOCKED: a previous operation on "${prefix}" was interrupted and its worker ` +
              'process could not be confirmed stopped, so writing this environment now could corrupt it. ' +
              'Restart the app to re-check and recover it, then try again.'
          )
        }
      }
    })
  }
}

export { NotebookDataExecutionAdmissionOwner }
