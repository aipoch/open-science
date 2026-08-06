import { existsSync } from 'node:fs'

import type { NotebookLanguage } from '../../shared/notebook'
import { withDataRootWrite } from '../storage/migration-state'
import {
  logStartupGateFailure,
  runLoggedRuntimeOperation,
  serializeProvisioner
} from './environment-operation-foundation'
import {
  planStartupAction,
  type ProvisionProgress,
  type ProvisionStatus,
  type RuntimeProvisioner
} from './provisioner'
import { DEFAULT_ENV_VERSION, DEFAULT_PY_ENV, envPrefix, readReadyMarker } from './runtime-paths'

type NotebookEnvironmentLifecycle = {
  status: () => Promise<ProvisionStatus>
  provision: (language: NotebookLanguage, operationId?: string) => Promise<void>
  repair: (language: NotebookLanguage, operationId?: string) => Promise<void>
  cancel: (language?: NotebookLanguage) => void
  startup: () => Promise<void>
}

type NotebookEnvironmentLifecycleDeps = {
  provisioner: RuntimeProvisioner | undefined
  root: string
  projectProgress: (progress: ProvisionProgress) => void
  waitForRecovery?: () => Promise<void>
  assertProvisionAllowed?: (language: NotebookLanguage) => void
  onRepairCompleted?: (language: NotebookLanguage) => Promise<void> | void
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
): NotebookEnvironmentLifecycle => ({
  status: () =>
    Promise.resolve({
      pythonReady: false,
      rReady: false,
      version: DEFAULT_ENV_VERSION,
      provisioning: false
    }),
  provision: (language, operationId) =>
    runUnavailableOperation(deps, 'provision', language, operationId),
  repair: (language, operationId) => runUnavailableOperation(deps, 'repair', language, operationId),
  cancel: () => undefined,
  startup: () => Promise.resolve()
})

const createNotebookEnvironmentLifecycle = (
  deps: NotebookEnvironmentLifecycleDeps
): NotebookEnvironmentLifecycle => {
  if (!deps.provisioner) return createUnavailableLifecycle(deps)

  const provisioner = serializeProvisioner(deps.provisioner)

  const status = (): Promise<ProvisionStatus> =>
    withDataRootWrite(async () => {
      if (deps.waitForRecovery) await deps.waitForRecovery()
      return provisioner.status()
    })

  const provision = (language: NotebookLanguage, operationId?: string): Promise<void> =>
    runLoggedRuntimeOperation(
      'provision',
      language,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          deps.assertProvisionAllowed?.(language)
          await (language === 'r'
            ? provisioner.provisionR(report)
            : provisioner.provisionPython(report))
        }),
      (progress) =>
        deps.projectProgress({
          ...progress,
          scope: language,
          ...(operationId === undefined ? {} : { operationId })
        })
    )

  const repair = (language: NotebookLanguage, operationId?: string): Promise<void> =>
    runLoggedRuntimeOperation(
      'repair',
      language,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          await provisioner.repair(language, report, { force: true })
          await deps.onRepairCompleted?.(language)
        }),
      (progress) =>
        deps.projectProgress({
          ...progress,
          scope: language,
          ...(operationId === undefined ? {} : { operationId })
        })
    )

  const startup = async (): Promise<void> => {
    try {
      await withDataRootWrite(async () => {
        if (deps.waitForRecovery) await deps.waitForRecovery()
        await provisioner.restoreRelocatedEnvs(deps.projectProgress)

        const action = planStartupAction(deps.root, DEFAULT_ENV_VERSION)
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
          existsSync(envPrefix(deps.root, DEFAULT_PY_ENV))
        if (pythonWasProvisioned) await provisioner.repair('python', deps.projectProgress)
      })
    } catch (error) {
      logStartupGateFailure(error)
      deps.projectProgress({
        phase: 'error',
        message: `Environment preparation failed: ${(error as Error).message}`,
        progress: 0
      })
    }
  }

  return {
    status,
    provision,
    repair,
    cancel: (language) => provisioner.cancel(language),
    startup
  }
}

export { createNotebookEnvironmentLifecycle }
export type { NotebookEnvironmentLifecycle, NotebookEnvironmentLifecycleDeps }
