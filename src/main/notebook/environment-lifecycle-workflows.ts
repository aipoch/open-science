import { existsSync } from 'node:fs'

import {
  parseNotebookLanguage,
  parseOptionalNotebookLanguage,
  type NotebookLanguage
} from '../../shared/notebook'
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
  platform?: NodeJS.Platform
  projectProgress: (progress: ProvisionProgress) => void
  waitForRecovery?: () => Promise<void>
  assertProvisionAllowed?: (language: NotebookLanguage) => void
  runProvisionAdmission?: <T>(language: NotebookLanguage, operation: () => Promise<T>) => Promise<T>
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
  provision: async (language, operationId) =>
    runUnavailableOperation(deps, 'provision', parseNotebookLanguage(language), operationId),
  repair: async (language, operationId) =>
    runUnavailableOperation(deps, 'repair', parseNotebookLanguage(language), operationId),
  cancel: (language) => {
    parseOptionalNotebookLanguage(language)
  },
  startup: () => Promise.resolve()
})

const createNotebookEnvironmentLifecycle = (
  deps: NotebookEnvironmentLifecycleDeps
): NotebookEnvironmentLifecycle => {
  if (!deps.provisioner) return createUnavailableLifecycle(deps)

  const provisioner = serializeProvisioner(deps.provisioner)
  const platform = deps.platform ?? process.platform
  const runProvisionAdmission = <T>(
    language: NotebookLanguage,
    operation: () => Promise<T>
  ): Promise<T> => deps.runProvisionAdmission?.(language, operation) ?? operation()
  const runStartupAdmission = <T>(operation: () => Promise<T>): Promise<T> =>
    runProvisionAdmission('python', () => runProvisionAdmission('r', operation))

  const status = (): Promise<ProvisionStatus> =>
    withDataRootWrite(async () => {
      if (deps.waitForRecovery) await deps.waitForRecovery()
      return provisioner.status()
    })

  const provision = async (language: NotebookLanguage, operationId?: string): Promise<void> => {
    const parsedLanguage = parseNotebookLanguage(language)
    return runLoggedRuntimeOperation(
      'provision',
      parsedLanguage,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          deps.assertProvisionAllowed?.(parsedLanguage)
          const provisionDefault = async (): Promise<void> => {
            switch (parsedLanguage) {
              case 'r':
                await provisioner.provisionR(report)
                return
              case 'python':
                await provisioner.provisionPython(report)
                return
            }
          }
          await runProvisionAdmission(parsedLanguage, provisionDefault)
        }),
      (progress) =>
        deps.projectProgress({
          ...progress,
          scope: parsedLanguage,
          ...(operationId === undefined ? {} : { operationId })
        })
    )
  }

  const repair = async (language: NotebookLanguage, operationId?: string): Promise<void> => {
    const parsedLanguage = parseNotebookLanguage(language)
    return runLoggedRuntimeOperation(
      'repair',
      parsedLanguage,
      deps.root,
      (report) =>
        withDataRootWrite(async () => {
          if (deps.waitForRecovery) await deps.waitForRecovery()
          const repairDefault = (): Promise<void> =>
            provisioner.repair(parsedLanguage, report, {
              force: true,
              onVerified: () => deps.onRepairCompleted?.(parsedLanguage)
            })
          await runProvisionAdmission(parsedLanguage, repairDefault)
        }),
      (progress) =>
        deps.projectProgress({
          ...progress,
          scope: parsedLanguage,
          ...(operationId === undefined ? {} : { operationId })
        })
    )
  }

  const startup = async (): Promise<void> => {
    try {
      await withDataRootWrite(async () => {
        if (deps.waitForRecovery) await deps.waitForRecovery()
        await runStartupAdmission(async () => {
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
    cancel: (language) => provisioner.cancel(parseOptionalNotebookLanguage(language)),
    startup
  }
}

export { createNotebookEnvironmentLifecycle }
export type { NotebookEnvironmentLifecycle, NotebookEnvironmentLifecycleDeps }
