import { existsSync } from 'node:fs'

import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  planStartupAction,
  readReadyMarker,
  serializeProvisioner,
  type ProvisionProgress,
  type ProvisionStatus,
  type RuntimeProvisioner
} from '@aipoch/environment'
import { parseNotebookLanguage, parseOptionalNotebookLanguage } from '../../shared/notebook'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import type {
  TaskNotebookEnvironmentOperation,
  TaskNotebookEnvironmentRequest,
  TaskNotebookEnvironmentTarget
} from '../../shared/task-api'
import { withDataRootWrite } from '../storage/migration-state'
import {
  logStartupGateFailure,
  runLoggedRuntimeOperation
} from './environment-lifecycle-diagnostics'
import { explicitRuntimeRepairTarget, type ExplicitRuntimeRepairTarget } from './runtime-repair'

type NotebookEnvironmentLifecycle = {
  status: () => Promise<ProvisionStatus>
  provision: (language: NotebookLanguage, operationId?: string) => Promise<void>
  repair: (
    language: NotebookLanguage,
    runtimeIdentity: string,
    operationId?: string
  ) => Promise<void>
  cancel: (language?: NotebookLanguage) => void
  startup: () => Promise<void>
}

type ManagedNotebookSetup = {
  start: (request: TaskNotebookEnvironmentRequest) => TaskNotebookEnvironmentOperation
  get: (target: TaskNotebookEnvironmentTarget) => TaskNotebookEnvironmentOperation
  cancel: (target: TaskNotebookEnvironmentTarget) => TaskNotebookEnvironmentOperation
}

type OperationObservation = {
  signal: AbortSignal
  report: (progress: ProvisionProgress) => void
}

type NotebookEnvironmentWorkflows = Omit<NotebookEnvironmentLifecycle, 'provision' | 'repair'> & {
  provision: (
    language: NotebookLanguage,
    operationId?: string,
    observation?: OperationObservation
  ) => Promise<void>
  repair: (
    language: NotebookLanguage,
    runtimeIdentity: string,
    operationId?: string,
    observation?: OperationObservation
  ) => Promise<void>
}

class NotebookEnvironmentOperationConflictError extends Error {}

type NotebookEnvironmentLifecycleDeps = {
  provisioner: RuntimeProvisioner | undefined
  root: string
  platform?: NodeJS.Platform
  projectProgress: (progress: ProvisionProgress) => void
  recoveryStatus?: () => import('@aipoch/environment/contracts').NotebookRecoveryStatus
  waitForStatusRecovery?: () => Promise<void>
  waitForRecovery?: () => Promise<void>
  assertProvisionAllowed?: (language: NotebookLanguage) => void
  onRepairStarting?: (
    language: NotebookLanguage,
    target: ExplicitRuntimeRepairTarget
  ) => Promise<void> | void
  onRepairCompleted?: (language: NotebookLanguage) => Promise<void> | void
  revokeRuntimeAccess?: (language: NotebookLanguage) => Promise<void>
}

const RUNTIME_UNAVAILABLE_MESSAGE =
  'The notebook runtime is unavailable: micromamba was not found. In a packaged build it ships with the app; for development, set OPEN_SCIENCE_MICROMAMBA_BIN to a micromamba binary and restart.'

const runUnavailableOperation = (
  deps: NotebookEnvironmentLifecycleDeps,
  operation: 'provision' | 'repair',
  language: NotebookLanguage,
  operationId?: string
): Promise<void> =>
  runLoggedRuntimeOperation(
    operation,
    language,
    deps.root,
    () => Promise.reject(new Error(RUNTIME_UNAVAILABLE_MESSAGE)),
    (progress) =>
      deps.projectProgress({
        ...progress,
        scope: language,
        ...(operationId === undefined ? {} : { operationId })
      })
  )

const createUnavailableLifecycle = (
  deps: NotebookEnvironmentLifecycleDeps
): NotebookEnvironmentWorkflows => ({
  status: () =>
    withDataRootWrite(async () => {
      await (deps.waitForStatusRecovery ?? deps.waitForRecovery)?.()
      return {
        pythonReady: false,
        rReady: false,
        version: DEFAULT_ENV_VERSION,
        provisioning: false,
        ...(deps.recoveryStatus ? { recovery: deps.recoveryStatus() } : {})
      }
    }),
  provision: async (language, operationId) =>
    runUnavailableOperation(deps, 'provision', parseNotebookLanguage(language), operationId),
  repair: async (language, _runtimeIdentity, operationId) =>
    runUnavailableOperation(deps, 'repair', parseNotebookLanguage(language), operationId),
  cancel: (language) => {
    parseOptionalNotebookLanguage(language)
  },
  startup: () => Promise.resolve()
})

const createNotebookEnvironmentWorkflows = (
  deps: NotebookEnvironmentLifecycleDeps
): NotebookEnvironmentWorkflows => {
  if (!deps.provisioner) return createUnavailableLifecycle(deps)

  const provisioner = serializeProvisioner(deps.provisioner)
  const platform = deps.platform ?? process.platform

  const status = (): Promise<ProvisionStatus> =>
    withDataRootWrite(async () => {
      await (deps.waitForStatusRecovery ?? deps.waitForRecovery)?.()
      const status = await provisioner.status()
      return { ...status, ...(deps.recoveryStatus ? { recovery: deps.recoveryStatus() } : {}) }
    })

  const provision = async (
    language: NotebookLanguage,
    operationId?: string,
    observation?: OperationObservation
  ): Promise<void> => {
    const parsedLanguage = parseNotebookLanguage(language)
    return runLoggedRuntimeOperation(
      'provision',
      parsedLanguage,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          observation?.signal.throwIfAborted()
          deps.assertProvisionAllowed?.(parsedLanguage)
          switch (parsedLanguage) {
            case 'r':
              await provisioner.provisionR(report, observation?.signal)
              return
            case 'python':
              await provisioner.provisionPython(report, observation?.signal)
              return
          }
        }),
      (progress) => {
        observation?.report(progress)
        deps.projectProgress({
          ...progress,
          scope: parsedLanguage,
          ...(operationId === undefined ? {} : { operationId })
        })
      }
    )
  }

  const repair = async (
    language: NotebookLanguage,
    runtimeIdentity: string,
    operationId?: string,
    observation?: OperationObservation
  ): Promise<void> => {
    const parsedLanguage = parseNotebookLanguage(language)
    if (typeof runtimeIdentity !== 'string' || runtimeIdentity.trim() === '') {
      throw new Error('A current app-managed runtime identity is required for repair.')
    }
    return runLoggedRuntimeOperation(
      'repair',
      parsedLanguage,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          observation?.signal.throwIfAborted()
          await provisioner.repair(parsedLanguage, report, {
            force: true,
            ...(observation ? { signal: observation.signal } : {}),
            onStarting:
              deps.onRepairStarting || deps.revokeRuntimeAccess
                ? async () => {
                    await deps.onRepairStarting?.(
                      parsedLanguage,
                      explicitRuntimeRepairTarget(parsedLanguage, runtimeIdentity)
                    )
                    await deps.revokeRuntimeAccess?.(parsedLanguage)
                  }
                : undefined,
            onVerified: () => deps.onRepairCompleted?.(parsedLanguage)
          })
        }),
      (progress) => {
        observation?.report(progress)
        deps.projectProgress({
          ...progress,
          scope: parsedLanguage,
          ...(operationId === undefined ? {} : { operationId })
        })
      }
    )
  }

  const startup = async (): Promise<void> => {
    try {
      await withDataRootWrite(async () => {
        if (deps.waitForRecovery) await deps.waitForRecovery()
        await provisioner.restoreRelocatedEnvs(deps.projectProgress)

        const action = planStartupAction(deps.root, DEFAULT_ENV_VERSION, platform)
        if (action === 'ready') return
        if (action === 'upgrade') {
          await provisioner.upgradeIfNeeded(deps.projectProgress)
          return
        }
        if (action !== 'repair') return

        // A residual default-r prefix makes the planner report repair even for an R-first user. Only
        // maintain Python eagerly when it was actually provisioned before; fresh Python stays lazy.
        const pythonWasProvisioned =
          readReadyMarker(deps.root) !== undefined ||
          existsSync(envPrefix(deps.root, DEFAULT_PY_ENV, platform))
        if (pythonWasProvisioned) await provisioner.repair('python', deps.projectProgress)
      })
    } catch (error) {
      logStartupGateFailure(error)
      deps.projectProgress({
        phase: 'error',
        diagnostic: `Environment preparation failed: ${(error as Error).message}`,
        progress: 0
      })
    }
  }

  return {
    status,
    provision,
    repair,
    cancel: (language) => provisioner.cancel(parseOptionalNotebookLanguage(language)),
    startup
  }
}

const RETAINED_MANAGED_OPERATIONS = 64

type ManagedSetupEntry = {
  snapshot: TaskNotebookEnvironmentOperation
  controller: AbortController
}

const createManagedSetup = (workflows: NotebookEnvironmentWorkflows): ManagedNotebookSetup => {
  const operations = new Map<string, ManagedSetupEntry>()
  const get = (target: TaskNotebookEnvironmentTarget): TaskNotebookEnvironmentOperation => {
    const snapshot = operations.get(target.operationId)?.snapshot
    return snapshot?.language === target.language ? snapshot : { ...target, status: 'unconfirmed' }
  }

  return {
    get,
    start: (request) => {
      const { language, operationId, action } = request
      const existing = operations.get(operationId)?.snapshot
      if (existing) {
        if (existing.language === language && existing.action === action) return existing
        throw new NotebookEnvironmentOperationConflictError('The operation ID is already in use.')
      }
      for (const { snapshot } of operations.values()) {
        if (snapshot.language === language && snapshot.status === 'preparing') {
          throw new NotebookEnvironmentOperationConflictError(
            'This language already has a setup operation in progress.'
          )
        }
      }
      if (operations.size >= RETAINED_MANAGED_OPERATIONS) {
        for (const [id, { snapshot }] of operations) {
          if (snapshot.status === 'preparing') continue
          operations.delete(id)
          break
        }
      }

      const controller = new AbortController()
      const entry: ManagedSetupEntry = { snapshot: { ...request, status: 'preparing' }, controller }
      operations.set(operationId, entry)
      const observation: OperationObservation = {
        signal: controller.signal,
        report: ({ phase, progress }) => {
          if (phase === 'error') return
          entry.snapshot = { ...entry.snapshot, progress: { phase, fraction: progress } }
        }
      }
      const work =
        action === 'prepare'
          ? workflows.provision(language, operationId, observation)
          : workflows.repair(
              language,
              language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV,
              operationId,
              observation
            )
      void work.then(
        () => {
          entry.snapshot = { ...entry.snapshot, status: 'completed' }
        },
        (error) => {
          const cancelled =
            (controller.signal.aborted && error === controller.signal.reason) ||
            (error instanceof Error &&
              (error.message === 'Runtime setup cancelled.' ||
                (controller.signal.aborted && error.name === 'AbortError')))
          entry.snapshot = cancelled
            ? { ...entry.snapshot, status: 'cancelled' }
            : {
                ...entry.snapshot,
                status: 'failed',
                reason:
                  error instanceof Error && error.message.startsWith('RUNTIME_RECOVERY_BLOCKED:')
                    ? 'notebook_environment_recovery_required'
                    : 'notebook_setup_failed'
              }
        }
      )
      return entry.snapshot
    },
    cancel: (target) => {
      const entry = operations.get(target.operationId)
      if (entry?.snapshot.language === target.language && entry.snapshot.status === 'preparing') {
        entry.snapshot = { ...entry.snapshot, cancelRequested: true }
        entry.controller.abort(new Error('Runtime setup cancelled.'))
      }
      return get(target)
    }
  }
}

const createNotebookEnvironmentLifecycle = (
  deps: NotebookEnvironmentLifecycleDeps
): NotebookEnvironmentLifecycle & { managedSetup: ManagedNotebookSetup } => {
  const workflows = createNotebookEnvironmentWorkflows(deps)
  return { ...workflows, managedSetup: createManagedSetup(workflows) }
}

export { createNotebookEnvironmentLifecycle, NotebookEnvironmentOperationConflictError }
export type { ManagedNotebookSetup, NotebookEnvironmentLifecycle, NotebookEnvironmentLifecycleDeps }
