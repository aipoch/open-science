import { runtimeMetadata } from '../runtime-metadata'
import { dirname } from 'node:path'
import { DEFAULT_ARTIFACT_PROJECT_ID } from '../../shared/artifacts'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArchiveCoordinator } from '../archive/coordinator'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { withReproducibilityNotebookLifecycle } from '../artifacts/reproducibility-notebook-lifecycle'
import { BackgroundResultDeliveryOwner } from '../background-result-delivery/owner'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { createNotebookApplicationModule } from '../notebook/application'
import { NotebookDependencyAnalyzer } from '../notebook/dependency-analysis'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { NotebookRunRepository } from '../notebook/repository'
import { runtimeRoot } from '../notebook/runtime-paths'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createProductionMicromambaRunner } from '../notebook/windows-micromamba-runner'
import type { NotebookRuntimeSettings } from '../settings/capabilities'
import { SettingsService } from '../settings/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'

export async function composeNotebookRuntime({
  applicationEvents,
  notebookPolicyLifecycle,
  notebookNetworkSandbox,
  settingsService,
  backgroundResultDelivery,
  notebookRepository,
  notebookDependencyAnalyzer,
  grantedRootsRepository,
  notebookActivityRef,
  artifactReproducibilityAttemptOwnerRef,
  archiveCoordinator,
  backendTeardownOwnedByCoordinator,
  translate,
  modules,
  composition
}: {
  applicationEvents: ApplicationEvents
  notebookPolicyLifecycle: {
    current?: Pick<NotebookRuntimeService, 'shutdownAll'>
  }
  notebookNetworkSandbox: NotebookNetworkSandboxOwner
  settingsService: SettingsService
  backgroundResultDelivery: BackgroundResultDeliveryOwner
  notebookRepository: NotebookRunRepository
  notebookDependencyAnalyzer: NotebookDependencyAnalyzer
  grantedRootsRepository: GrantedLocalRootsRepository
  notebookActivityRef: {
    current: { getActiveNotebookSessions(): { projectId: string; sessionId: string }[] } | undefined
  }
  artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  }
  archiveCoordinator: ArchiveCoordinator
  backendTeardownOwnedByCoordinator: { current: boolean }
  translate: import('../locale/main-process-messages').NativeTranslator
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<{
  provisioningRoot: ReturnType<typeof runtimeRoot>
  micromambaRunner: ReturnType<typeof createProductionMicromambaRunner>
  notebookService: NotebookRuntimeService
  notebookCommands: ReturnType<typeof createNotebookApplicationModule>['capability']['commands']
  notebookLocalRpc: ReturnType<typeof createNotebookApplicationModule>['capability']['localRpc']
  notebookLifecycle: ReturnType<typeof withReproducibilityNotebookLifecycle>
}> {
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // One runner owns Windows integrity/preflight/fallback state for every production micromamba
  // consumer in this main-process generation. Each consumer receives only its narrow resolve seam.
  const micromambaRunner = createProductionMicromambaRunner({
    packaged: runtimeMetadata().packaged,
    configHome: runtimeMetadata().homePath,
    home: dirname(dirname(provisioningRoot)),
    resourcesPath: runtimeMetadata().resourcesPath
  })
  const notebookRuntimeSettings: Pick<
    NotebookRuntimeSettings,
    'getSnapshot' | 'setEnvironmentEnabled'
  > = {
    getSnapshot: async (language) => {
      const [runtimeEnablement, manualInterpreters, packageMirror] = await Promise.all([
        settingsService.getRuntimeEnablement(language),
        settingsService.getManualInterpreters(language),
        settingsService.getPackageMirror()
      ])
      return {
        language,
        runtimeEnablement,
        manualInterpreters,
        packageMirror
      }
    },
    setEnvironmentEnabled: (language, envId, enabled) =>
      settingsService.setEnvironmentEnabled(language, envId, enabled)
  }
  const notebookApplication = await modules.add(
    {
      admitSessionWork: (projectId: string, sessionId: string) =>
        archiveCoordinator.admitSessionWork(projectId, sessionId),
      configRoot: resolveConfigRoot(),
      dataRoot: resolveDataRoot(),
      projectId: DEFAULT_ARTIFACT_PROJECT_ID,
      repository: notebookRepository,
      dependencyAnalyzer: notebookDependencyAnalyzer,
      getPackageMirror: () => settingsService.getPackageMirror(),
      getAgentEnvironmentCreationEnabled: () =>
        settingsService.getAgentEnvironmentCreationEnabled(),
      notebookRuntimeSettings,
      micromambaRunner,
      locale: runtimeMetadata().locale,
      appVersion: runtimeMetadata().version,
      translate,
      helperModuleCatalog: settingsService.registeredHelperCatalog(),
      processSandbox: notebookNetworkSandbox,
      getGrantedLocalRoots: () => grantedRootsRepository.list(),
      onBackgroundRunTerminal: (source) =>
        backgroundResultDelivery.enqueue(source).then(() => undefined),
      onBackgroundRunAdmitted: (source) =>
        backgroundResultDelivery.register(source).then(() => undefined),
      onBackgroundRunObserved: (source) => backgroundResultDelivery.acknowledgeObserved(source),
      events: applicationEvents,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
      isBackendTeardownOwned: () => backendTeardownOwnedByCoordinator.current
    },
    createNotebookApplicationModule
  )
  const {
    runtime: notebookService,
    commands: notebookCommands,
    localRpc: notebookLocalRpc
  } = notebookApplication
  notebookPolicyLifecycle.current = notebookService
  const notebookLifecycle = withReproducibilityNotebookLifecycle(
    notebookService,
    () => artifactReproducibilityAttemptOwnerRef.current
  )
  notebookActivityRef.current = notebookLifecycle
  composition.phase('notebook-runtime')
  return {
    provisioningRoot,
    micromambaRunner,
    notebookService,
    notebookCommands,
    notebookLocalRpc,
    notebookLifecycle
  }
}
