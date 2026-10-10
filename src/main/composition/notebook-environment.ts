import { registerNotebookEnvIpcHandlers } from '../desktop-surface-declarations'
import { runtimeMetadata } from '../runtime-metadata'
import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRunResultDeliveryAdapter } from '../background-result-delivery/notebook-adapter'
import { createLogger, errorLogFields } from '../logger'
import { installNotebookEnvironmentSurface } from '../notebook/application'
import { broadcastNotebookEnvProgress } from '../notebook/env-ipc'
import {
  createNotebookEnvironmentLifecycle,
  type NotebookEnvironmentLifecycle
} from '../notebook/environment-lifecycle-workflows'
import { serializeProvisioner } from '../notebook/environment-operation-foundation'
import { effectiveMirrorAsync } from '../notebook/mirror-probe'
import type { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import type { NotebookCommandWorkflows } from '../notebook/notebook-workflows'
import {
  createProductionProvisioner,
  type ProductionProvisionerDeps,
  type RuntimeProvisioner
} from '../notebook/provisioner'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { SettingsService } from '../settings/service'
import { runDataRootStartupRecovery } from '../storage/migration-state'

type NotebookEnvironmentCompositionDependencies = {
  settingsService: Pick<SettingsService, 'getPackageMirror'>
  provisioningRoot: string
  notebookNetworkSandbox: NotebookNetworkSandboxOwner
  micromambaRunner: ProductionProvisionerDeps['runner']
  notebookService: Pick<
    NotebookRuntimeService,
    | 'isPrefixRecoveryBlocked'
    | 'clearRecoveryBlock'
    | 'clearRuntimeRecoveryBlock'
    | 'clearCorruptRecoveryBlock'
    | 'blockPrefixRecovery'
    | 'isPrefixLiveUnconfirmed'
    | 'withEnvLock'
    | 'recoverInterruptedOperations'
    | 'ensureRecovered'
    | 'isDefaultEnvRecoveryBlocked'
    | 'recoveryStatus'
    | 'prepareRuntimeRepair'
    | 'completeRuntimeRepair'
    | 'setEnvironmentStartupBarrier'
    | 'setEnvironmentManager'
    | 'setDefaultEnvProvisioner'
  >
  notebookCommands: Pick<NotebookCommandWorkflows, 'state'>
  notebookRunResultDelivery: Pick<NotebookRunResultDeliveryAdapter, 'recoverWaiting'>
  markNotebookResultAuthorityReady: () => void
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
}

const notebookStartupLog = createLogger('notebook:startup')

export const registerNotebookEnvironmentComposition = async ({
  settingsService,
  provisioningRoot,
  notebookNetworkSandbox,
  micromambaRunner,
  notebookService,
  notebookCommands,
  notebookRunResultDelivery,
  markNotebookResultAuthorityReady,
  declareElectronAdapter
}: NotebookEnvironmentCompositionDependencies): Promise<NotebookEnvironmentLifecycle> => {
  // Resolve the shared conda base under the app data root (relocatable, where the runtime install
  // lives) and start the env readiness gate. Named environments resolve the effective conda channel
  // lazily because they are the only path that solves online; default runtime packs use the official
  // CDN and must not wait for mirror probing during application startup.
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const effectiveMirror = (): ReturnType<typeof effectiveMirrorAsync> =>
      effectiveMirrorAsync(configuredMirror, runtimeMetadata().locale)
    provisioner = createProductionProvisioner(
      {
        root: provisioningRoot,
        processSandbox: notebookNetworkSandbox,
        channel: async () =>
          (await effectiveMirror()).condaChannel ??
          process.env.OPEN_SCIENCE_CONDA_CHANNEL ??
          'conda-forge',
        // Mirror probing never changes the configured enterprise CA bundle, so it is safe to pass
        // through synchronously while channel selection warms in the background.
        caBundle: configuredMirror?.caBundle,
        micromamba: {
          resourcesPath: runtimeMetadata().resourcesPath,
          packaged: runtimeMetadata().packaged,
          configHome: runtimeMetadata().homePath
        },
        // Self-guard the provisioner's prefix writes (startup restore/upgrade/repair, named create, lazy
        // materialize) against a prefix crash-recovery could not confirm free of a live orphan — closes
        // the startup-gate path the UI-only assertProvisionAllowed guard did not cover. Reads the live
        // blocked set at call time (recovery is awaited before the gate touches any prefix).
        isPrefixBlocked: (prefix) => notebookService.isPrefixRecoveryBlocked(prefix),
        // An explicit user Reset (repair with force) clears the in-memory block; the provisioner also
        // clears the retained journal record + sidecar so the quarantine doesn't re-arm next startup.
        clearPrefixBlock: (prefix) => notebookService.clearRecoveryBlock(prefix),
        // Reset also clears an interrupted install's runtime-ID block, or bound sessions would still be
        // rejected after the env rebuilds until the next restart.
        clearRuntimeBlock: (runtimeId) => notebookService.clearRuntimeRecoveryBlock(runtimeId),
        // A force Reset that finds the journal itself corrupt moves it aside and releases just THAT prefix
        // from the global corrupt-journal barrier — other envs stay blocked until their own Reset/restart.
        clearCorruptBlock: (prefix) => notebookService.clearCorruptRecoveryBlock(prefix),
        // On an unconfirmed-child prefix-write failure, block the prefix in-process immediately so an
        // in-session retry can't begin() a second op that races the first's possibly-live orphan.
        blockPrefix: (prefix) => notebookService.blockPrefixRecovery(prefix),
        // Lets a force Reset refuse a prefix an interrupted install (or prefix write) this session left with
        // a possibly-live orphan — the provisioner can't see install failures in its own set.
        isPrefixLiveUnconfirmed: (prefix) => notebookService.isPrefixLiveUnconfirmed(prefix),
        // Share the service's per-env install lock so a default-env create/repair/upgrade serializes with
        // a package install into the same env prefix instead of racing it on a separate lock.
        withPrefixLock: (envName, fn) => notebookService.withEnvLock(envName, fn)
      },
      { runner: micromambaRunner }
    )
    // Warm the process-local mirror cache after provisioner construction succeeds. This stays outside
    // the startup critical path; a later named-env create awaits the same memoized probe if necessary.
    void effectiveMirror().catch((error) =>
      notebookStartupLog.error('package mirror warmup failed', errorLogFields(error))
    )
    // One serialized wrapper shared by the startup gate and the notebook service's on-demand default
    // provisioning, so a concurrent build of the same default env (UI R-tab + an agent R run) can't
    // race the provisioner's shared in-flight flag; materialize is also idempotent as a backstop.
    serialized = serializeProvisioner(provisioner)
  } catch (error) {
    // micromamba missing (e.g. dev without a staged binary): the notebook env stays unprovisioned and
    // the UI surfaces "runtime unavailable" rather than crashing startup or dropping the IPC handlers.
    notebookStartupLog.error('environment provisioning unavailable', errorLogFields(error))
  }
  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight (orphan
  // download staging, a half-built prefix, an interrupted install). Kicked off HERE — before the env
  // IPC gate below — so recoverInterruptedOperations() publishes its barrier synchronously and every
  // prefix-touching path (the startup gate's restore/upgrade/repair, UI provision/repair, named-env
  // create, on-demand materialize, install) can await it and never race recovery's cleanup/delete.
  // Fire-and-forget so a slow/failed recovery never blocks IPC registration; the barrier itself is what
  // actually orders the prefix work.
  void runDataRootStartupRecovery(
    async () => {
      try {
        await notebookService.recoverInterruptedOperations()
        await notebookRunResultDelivery.recoverWaiting(async (request) => {
          const state = await notebookCommands.state({
            projectId: request.projectId,
            sessionId: request.sessionId,
            workspaceCwd: '',
            runIds: [request.runId]
          })
          return state.runs.find((run) => run.runId === request.runId)
        })
      } finally {
        markNotebookResultAuthorityReady()
      }
    },
    {
      reportFailure: (error) =>
        notebookStartupLog.error('operation recovery failed', errorLogFields(error))
    }
  )
  const waitForRecovery = (): Promise<void> => notebookService.ensureRecovered()
  // Recovery can retain a target for worker uncertainty, cache publication, or journal failure.
  // A block alone does not identify its cause; detailed reasons are available in Runtimes.
  const assertProvisionAllowed = (language: NotebookLanguage): void => {
    if (notebookService.isDefaultEnvRecoveryBlocked(language)) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: recovery of a previous operation on the ${language} runtime has not completed. ` +
          'Use Recheck in Settings → Runtimes to retry safe recovery and review the remaining recovery requirements.'
      )
    }
  }

  const notebookEnvironmentLifecycle = createNotebookEnvironmentLifecycle({
    provisioner: serialized,
    root: provisioningRoot,
    projectProgress: broadcastNotebookEnvProgress,
    waitForRecovery,
    recoveryStatus: () => notebookService.recoveryStatus(),
    assertProvisionAllowed,
    onRepairStarting: (language, target) => notebookService.prepareRuntimeRepair(language, target),
    revokeRuntimeAccess: async (language) => {
      if (language === 'r') await notebookNetworkSandbox.revokeManagedRAccess(provisioningRoot)
    },
    onRepairCompleted: (language) => notebookService.completeRuntimeRepair(language)
  })
  // Always register the handlers (serialized is undefined when the provisioner could not be built).
  // Start maintenance only after all four Electron channels exist, preserving the previous startup
  // ordering while construction remains application-owned and single-instance.
  declareElectronAdapter('notebook-environment', () => {
    const startup = installNotebookEnvironmentSurface(
      notebookEnvironmentLifecycle,
      registerNotebookEnvIpcHandlers
    )
    notebookService.setEnvironmentStartupBarrier(startup)
  })
  if (provisioner && serialized) {
    // Back the notebook service's manage_environments tool with the same provisioner that owns the env
    // gate (it is a DefaultRuntimeProvisioner, which implements createNamedEnvironment/listEnvironments/
    // removeEnvironment). Wired after construction like the mcp/mirror resolvers above.
    notebookService.setEnvironmentManager(provisioner)
    // On first agent use of a not-yet-built default env, build it from the offline bundle (via the
    // shared serialized provisioner) instead of erroring — keeps R lazy but avoids the agent creating
    // a redundant named env.
    notebookService.setDefaultEnvProvisioner(serialized, broadcastNotebookEnvProgress)
  }
  return notebookEnvironmentLifecycle
}
