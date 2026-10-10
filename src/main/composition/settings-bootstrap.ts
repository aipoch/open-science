import { runtimeMetadata } from '../runtime-metadata'
import { runtimeNetwork } from '../runtime-network'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpSessionAgentTarget } from '../../shared/acp'
import type { WslSetupStatus } from '../../shared/wsl-setup'
import { createAcpRuntime } from '../acp/runtime-composition'
import {
  resolveValidatedSessionAgentTarget,
  type SessionAgentTargetResolver
} from '../acp/session-agent-target'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { createLogger } from '../logger'
import { resolveAvailableShellRuntimeBinding } from '../notebook/configured-shell-runtime'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { resolveNotebookTrustBundle } from '../notebook/trust-bundle'
import { PermissionApprovalPresence } from '../permission-approval-presence'
import { NetworkProxyRuntime } from '../settings/network-proxy-runtime'
import { SettingsRepository } from '../settings/repository'
import { SettingsService } from '../settings/service'
import { SettingsInstallCoordinator } from '../settings/settings-install-coordinator'
import { SettingsSnapshotCommitOwner } from '../settings/settings-snapshot-commit-owner'
import { netFetchStandard } from '../skills/net-fetch'
import { UserSkillSpecialistPackageAdapter } from '../skills/specialist-package-adapter'
import { SpecialistRepository } from '../specialist/repository'
import { SpecialistService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { initializeDataLocation } from '../storage/initialize-location'
import { probeWindowsVolume } from '../wsl/windows-volume-probe'
import { FileWslSetupOperationJournal } from '../wsl/wsl-setup-operation-journal'
import { WslSetupOwner } from '../wsl/wsl-setup-owner'
import { WslSetupSessionOwner } from '../wsl/wsl-setup-session-owner'
import { initializeWsl2BashPreview, wsl2BashPreviewStatus } from '../wsl/wsl2-preview-gate'

export async function composeSettingsBootstrap({
  applicationEvents,
  permissionApprovalPresence,
  getRuntimeRef,
  getSpecialistRepository,
  getSpecialistService,
  mainEntryPath,
  settingsStore,
  headless,
  modules
}: {
  applicationEvents: ApplicationEvents
  permissionApprovalPresence: PermissionApprovalPresence
  getRuntimeRef: () => { current: ReturnType<typeof createAcpRuntime> | undefined }
  getSpecialistRepository: () => SpecialistRepository
  getSpecialistService: () => SpecialistService
  mainEntryPath: string
  settingsStore: import('../settings/document-store').SettingsDocumentStore | undefined
  headless: boolean
  modules: ApplicationModuleBuilder
}): Promise<{
  specialistPackageSkillAdapter: UserSkillSpecialistPackageAdapter
  specialistPackageRecovery: {
    current: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
  }
  settingsRepository: SettingsRepository
  wslSetupSessions: WslSetupSessionOwner
  wslRuntimeReconciliation: { current?: (status: WslSetupStatus) => void }
  wslSetup: WslSetupOwner
  getAvailableShellRuntimeBinding: () => Promise<
    Awaited<ReturnType<typeof resolveAvailableShellRuntimeBinding>>
  >
  networkProxyRuntime: NetworkProxyRuntime
  grantedRootsRepositoryRef: { current?: GrantedLocalRootsRepository }
  notebookPolicyLifecycle: {
    current?: Pick<NotebookRuntimeService, 'shutdownAll'>
  }
  shutdownNotebooksBeforePolicyChange: (
    trigger: 'ca-bundle' | 'granted-roots'
  ) => Promise<{ reaped: boolean }>
  notebookNetworkSandbox: NotebookNetworkSandboxOwner
  settingsService: SettingsService
  settingsSnapshotCommits: SettingsSnapshotCommitOwner
  resolveSessionAgentTarget: SessionAgentTargetResolver
  resolveDefaultSessionAgentTarget: () => Promise<AcpSessionAgentTarget>
}> {
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const specialistPackageSkillAdapter = new UserSkillSpecialistPackageAdapter(resolveConfigRoot())
  const specialistPackageRecovery = {
    current: undefined as (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
  }
  const settingsRepository = new SettingsRepository(
    settingsStore ?? resolveConfigRoot(),
    (operation) => specialistPackageSkillAdapter.runMutationExclusive(operation)
  )
  await initializeDataLocation(settingsRepository)
  initializeWsl2BashPreview({
    platform: process.platform,
    arch: process.arch,
    packaged: runtimeMetadata().packaged,
    resourcesPath: runtimeMetadata().resourcesPath
  })
  const settingsInstallCoordinator = new SettingsInstallCoordinator()
  const wslSetupSessions = new WslSetupSessionOwner(resolveConfigRoot())
  const wslRuntimeReconciliation: { current?: (status: WslSetupStatus) => void } = {}
  const wslSetup = new WslSetupOwner({
    // Managed workspaces, handoff data, and caches live below this local NTFS mount root. The
    // execution adapter will still validate each invocation's concrete authorized paths.
    workspacePath: resolveDataRoot,
    volumeProbe: probeWindowsVolume,
    readSelection: async () => (await settingsRepository.getSettings()).wslSelection,
    readActivation: async () => {
      const settings = await settingsRepository.getSettings()
      return {
        runtime: settings.localShellRuntime,
        selection: settings.activatedWslSelection
      }
    },
    writeSelection: (selection) => settingsRepository.setWslSelection(selection),
    installCoordinator: settingsInstallCoordinator,
    operationJournal: new FileWslSetupOperationJournal(resolveConfigRoot()),
    previewStatus: wsl2BashPreviewStatus,
    onStatusChanged: (status) => {
      applicationEvents.publish('settings:wsl-setup-changed', status)
      wslRuntimeReconciliation.current?.(status)
    }
  })
  const getAvailableShellRuntimeBinding = async (): Promise<
    Awaited<ReturnType<typeof resolveAvailableShellRuntimeBinding>>
  > => {
    const binding = await resolveAvailableShellRuntimeBinding(
      await settingsRepository.getSettings(),
      async (selection) => {
        if (!wsl2BashPreviewStatus().available) return false
        const snapshot = await wslSetup.probe(selection)
        return (
          snapshot.state === 'ready' &&
          snapshot.selection?.distro === selection.distro &&
          snapshot.selection?.user === selection.user
        )
      },
      process.platform
    )
    if (binding.kind !== 'powershell' || !(await notebookNetworkSandbox.windowsProtectionReady()))
      return binding
    return Object.freeze({ kind: 'powershell', version: '7.6' })
  }
  const networkProxyRuntime = new NetworkProxyRuntime({
    setProxy: (config) => runtimeNetwork().setProxy(config)
  })
  const settingsServiceRef: { current?: SettingsService } = {}
  const grantedRootsRepositoryRef: { current?: GrantedLocalRootsRepository } = {}
  const notebookPolicyLifecycle: {
    current?: Pick<NotebookRuntimeService, 'shutdownAll'>
  } = {}
  const notebookPolicyLog = createLogger('notebook:policy')
  const shutdownNotebooksBeforePolicyChange = async (
    trigger: 'ca-bundle' | 'granted-roots'
  ): Promise<{ reaped: boolean }> => {
    const operation = startDiagnosticOperation(notebookPolicyLog, {
      operation: 'notebook-policy-shutdown',
      fields: { trigger }
    })
    if (!notebookPolicyLifecycle.current) {
      const error = new Error('Notebook policy lifecycle is not ready.')
      operation.fail(error)
      throw error
    }
    try {
      const result = await notebookPolicyLifecycle.current.shutdownAll()
      operation.complete({ reaped: result.reaped })
      return result
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }
  const notebookNetworkSandbox = await modules.add(undefined, () => {
    const capability = new NotebookNetworkSandboxOwner({
      windowsRuntimeRoot: join(resolveConfigRoot(), 'notebook-runtimes'),
      packaged: runtimeMetadata().packaged,
      allowRuntimeAccessPrompt: !headless,
      resourceRoot: runtimeMetadata().packaged
        ? join(runtimeMetadata().resourcesPath, 'notebook-network-sandbox')
        : join(runtimeMetadata().applicationPath, 'packages', 'notebook-network-sandbox', 'vendor'),
      // R rejects a TEMP path containing spaces. Electron's product-named userData directory
      // includes them in both production and development; keep command temp under the fixed config root.
      temporaryRoot: join(resolveConfigRoot(), 'notebook-command-temp'),
      getSettings: async () => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return service.getNotebookNetwork()
      },
      getCaBundlePath: async () => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return (await service.getPackageMirror()).caBundle
      },
      getGrantedLocalRoots: async () => grantedRootsRepositoryRef.current?.list() ?? [],
      persistAlwaysAllow: async (hostname) => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return service.allowNotebookNetworkDomain(hostname)
      },
      requestDecision: async ({
        sessionId,
        hostname,
        port,
        runtime,
        reason,
        allowOnce,
        signal
      }) => {
        if (headless && !permissionApprovalPresence.isAvailable()) return 'unavailable'
        const coordinator = getRuntimeRef().current
        if (!coordinator || signal.aborted) return 'deny'
        const selected = await coordinator
          .requestAppPermission({
            sessionId,
            title: `Connect to ${hostname}?`,
            rawInput: {
              notebookNetworkApproval: {
                hostname,
                ...(port === undefined ? {} : { port }),
                ...(runtime === undefined ? {} : { runtime }),
                ...(reason === undefined ? {} : { reason })
              }
            },
            options: [
              ...(allowOnce
                ? [
                    {
                      optionId: 'allow-once',
                      name: 'Allow once',
                      kind: 'allow_once' as const,
                      scope: 'once' as const
                    }
                  ]
                : []),
              {
                optionId: 'always-allow',
                name: 'Global',
                kind: 'allow_always',
                scope: 'global'
              },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ],
            signal
          })
          .catch(() => undefined)
        return selected === 'always-allow'
          ? 'alwaysAllow'
          : selected === 'allow-once'
            ? 'allowOnce'
            : 'deny'
      },
      getParentProxy: async () => {
        const environment = networkProxyRuntime.getChildProcessProxyEnvironment()
        if (!environment) return undefined
        const parentProxy = {
          http: environment.HTTP_PROXY ?? environment.http_proxy ?? environment.ALL_PROXY,
          https: environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.ALL_PROXY,
          noProxy: environment.NO_PROXY ?? environment.no_proxy
        }
        return parentProxy.http || parentProxy.https ? parentProxy : undefined
      }
    })
    return {
      capability,
      rollback: () => capability.dispose(),
      dispose: () => capability.dispose()
    }
  })
  const settingsService = await modules.add(undefined, () => {
    const capability = new SettingsService({
      repository: settingsRepository,
      onProviderHealthChanged: async () => {
        await settingsSnapshotCommits.projectAfter(Promise.resolve())
      },
      installCoordinator: settingsInstallCoordinator,
      skillRuntimeMcpEntryPath: mainEntryPath,
      openAlexFetch: netFetchStandard,
      applyNetworkProxy: async (settings) => {
        await networkProxyRuntime.apply(settings)
        await notebookNetworkSandbox.updateParentProxy()
      },
      readMarketplaceSpecialists: async (): Promise<
        import('../../shared/specialist').SpecialistListItem[]
      > => {
        const snapshot = await getSpecialistService().listForSettingsSnapshot()
        if (snapshot.integrity.status !== 'ok')
          throw new Error('Specialist impact inspection is unavailable.')
        return snapshot.items
      },
      withMarketplaceImpactLock: (operation) => getSpecialistRepository().withReadLock(operation),
      withUserSkillRecoveryBarrier: (operation) =>
        specialistPackageRecovery.current?.(operation) ?? operation(),
      applyNotebookNetwork: async (settings) => notebookNetworkSandbox.applySettings(settings),
      validatePackageMirror: async (settings) => {
        await resolveNotebookTrustBundle(settings.caBundle)
      },
      applyPackageMirror: async () => {
        await notebookNetworkSandbox.updateTrustBundle()
      },
      beforePackageMirrorCaBundleChange: async () => {
        await shutdownNotebooksBeforePolicyChange('ca-bundle')
      },
      getNotebookNetworkStatus: () => notebookNetworkSandbox.status(),
      installNotebookNetwork: () => notebookNetworkSandbox.installWindows(),
      cancelNotebookNetworkSetup: () => notebookNetworkSandbox.cancelWindowsSetup(),
      removeNotebookNetwork: () => notebookNetworkSandbox.removeWindows(),
      refreshNotebookShellCapabilities: async () => {
        const runtime = getRuntimeRef().current
        if (!runtime) throw new Error('Shell capability lifecycle is not ready.')
        // Reuse the global Shell switch boundary: existing conversations reconnect with the
        // current interpreter, tool descriptions and permission qualifiers on their next turn.
        await runtime.requestShellCapabilityRefresh()
      },
      wslSetup,
      wslSetupSessions,
      ensureDefaultWslSetupWorkspace: async () => {
        const settings = await settingsRepository.getSettings()
        if (!settings.dataRoot && settings.onboardingCompletedAt === undefined)
          await mkdir(resolveDataRoot(), { recursive: true })
      },
      resolveCodexProxyEnvironment: () =>
        Promise.resolve(networkProxyRuntime.getChildProcessProxyEnvironment())
    })
    return {
      name: 'settings-service',
      capability,
      rollback: () => capability.dispose(),
      dispose: () => capability.dispose(),
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS
    }
  })
  settingsServiceRef.current = settingsService
  const settingsSnapshotCommits = new SettingsSnapshotCommitOwner(
    settingsService,
    applicationEvents
  )
  const resolveSessionAgentTarget: SessionAgentTargetResolver = async (source) =>
    resolveValidatedSessionAgentTarget(source, await settingsService.getSettingsView())
  const resolveDefaultSessionAgentTarget = async (): Promise<AcpSessionAgentTarget> => {
    const target = await settingsService.captureActiveExplicitAgentBackendTarget()
    return {
      frameworkId: target.frameworkId,
      providerId: target.providerId,
      ...(target.model.kind === 'required' ? { model: target.model.id } : {}),
      reasoningEffort: target.reasoningEffort
    }
  }
  return {
    specialistPackageSkillAdapter,
    specialistPackageRecovery,
    settingsRepository,
    wslSetupSessions,
    wslRuntimeReconciliation,
    wslSetup,
    getAvailableShellRuntimeBinding,
    networkProxyRuntime,
    grantedRootsRepositoryRef,
    notebookPolicyLifecycle,
    shutdownNotebooksBeforePolicyChange,
    notebookNetworkSandbox,
    settingsService,
    settingsSnapshotCommits,
    resolveSessionAgentTarget,
    resolveDefaultSessionAgentTarget
  }
}
