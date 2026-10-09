import { createSettingsExportFiles, createSettingsFileCommands } from '../settings/file-commands'
import { createBackgroundResultActivityOwner } from '../background-result-delivery/ipc'
import {
  registerBackgroundResultDeliveryIpcHandlers,
  createSettingsElectronSurface,
  registerNotebookIpcHandlers
} from '../desktop-surface-declarations'
import type { BackgroundResultDelivery } from '../../shared/background-result-delivery'
import type { WslSetupStatus } from '../../shared/wsl-setup'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'

import { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'
import { type ResolvedBackgroundResultSource } from '../background-result-delivery/source-resolver'
import { ALL_CONNECTOR_IDS } from '../connectors/registry'

import { createLogger } from '../logger'
import { createNotebookApplicationModule } from '../notebook/application'

import { createPermissionGrantProjectionController } from '../permission-grants/projection-controller'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { ProjectDeletionCoordinator } from '../projects/deletion-coordinator'
import { createDefaultProjectRepository } from '../projects/ipc'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { loadSessionMetadataAfterProjectRecovery } from '../session-persistence/ipc'
import { SettingsRepository } from '../settings/repository'
import { SettingsService } from '../settings/service'
import { SettingsSnapshotCommitOwner } from '../settings/settings-snapshot-commit-owner'
import { createSettingsWorkflows } from '../settings/workflows'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { TagService } from '../tags/service'
import { WslSetupOwner } from '../wsl/wsl-setup-owner'

export async function composeSettingsEffects({
  surfaceAdapters,
  declareElectronAdapter,
  settingsRepository,
  wslRuntimeReconciliation,
  wslSetup,
  settingsService,
  settingsSnapshotCommits,
  backgroundResultDeliveryRepository,
  resolveDeliverySources,
  requestSkillCatalogRefresh,
  projectRepository,
  permissionGrantRegistry,
  sessionPersistenceCoordinator,
  projectDeletionCoordinator,
  notebookCommands,
  removeResourceTagsOrThrow,
  removeResourceTags,
  connectorService,
  connectorRuntimeSettings,
  mcpClientManager,
  runtime,
  sideChatRuntime,
  translate,
  onAppIconVariantChanged,
  listAppIconPreviews,
  modules
}: {
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  settingsRepository: SettingsRepository
  wslRuntimeReconciliation: { current?: (status: WslSetupStatus) => void }
  wslSetup: WslSetupOwner
  settingsService: SettingsService
  settingsSnapshotCommits: SettingsSnapshotCommitOwner
  backgroundResultDeliveryRepository: BackgroundResultDeliveryRepository
  resolveDeliverySources: (
    deliveries: readonly BackgroundResultDelivery[]
  ) => Promise<ResolvedBackgroundResultSource[]>
  requestSkillCatalogRefresh: () => void
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'sessionMetadataSnapshot'>
  projectDeletionCoordinator: ProjectDeletionCoordinator
  notebookCommands: ReturnType<typeof createNotebookApplicationModule>['capability']['commands']
  removeResourceTagsOrThrow: (
    resources: Parameters<TagService['removeResources']>[0]
  ) => Promise<void>
  removeResourceTags: (resources: Parameters<TagService['removeResources']>[0]) => Promise<void>
  connectorService: import('../connectors/service').ConnectorService
  connectorRuntimeSettings: import('../connectors/runtime-settings-projection').ConnectorRuntimeSettingsProjection
  mcpClientManager: import('../connectors/custom-mcp/client-manager').McpClientManager
  runtime: ReturnType<typeof createAcpRuntime>
  sideChatRuntime: SideChatRuntimeOwner
  translate: import('../locale/main-process-messages').NativeTranslator
  onAppIconVariantChanged:
    ((variant: import('../../shared/settings').AppIconVariant) => void) | undefined
  listAppIconPreviews: (() => import('../../shared/settings').AppIconPreview[]) | undefined
  modules: ApplicationModuleBuilder
}): Promise<{
  permissionGrantProjection: import('../permission-grants/projection-controller').PermissionGrantProjectionController
  settingsWorkflows: ReturnType<typeof createSettingsWorkflows>
  settingsFileCommands: ReturnType<typeof createSettingsFileCommands>
  backgroundResultActivity: ReturnType<typeof createBackgroundResultActivityOwner>
}> {
  const permissionGrantProjection = await modules.add(
    {
      registry: permissionGrantRegistry,
      projects: {
        list: async () => {
          await projectDeletionCoordinator.recoverPendingDeletions()
          return projectRepository.list()
        }
      },
      sessions: {
        metadataSnapshot: () =>
          loadSessionMetadataAfterProjectRecovery(
            projectDeletionCoordinator,
            sessionPersistenceCoordinator
          )
      },
      connectors: {
        get: async () => ({
          ...(await settingsService.getConnectors()),
          bundledConnectorIds: ALL_CONNECTOR_IDS
        })
      }
    },
    (dependencies) => {
      const owner = createPermissionGrantProjectionController({
        ...dependencies,
        publishChanged: (payload) => broadcastToRenderers('permissions:changed', payload)
      })
      return {
        name: 'permission-grant-projection',
        capability: owner,
        dispose: () => owner.dispose()
      }
    }
  )
  // Framework changes rotate future runtime ownership; provider edits and authentication changes
  // reconnect generations that use the affected provider. Active provider/model/effort selections are
  // persisted defaults only and never flow through this effects port to mutate existing Sessions.
  const settingsWorkflows = createSettingsWorkflows(settingsService, {
    runtime: {
      requestProviderReconnect: (providerIds, includeDefault = true) => {
        void runtime.requestProviderReconnect(providerIds, includeDefault)
        if (includeDefault) void sideChatRuntime.requestProviderReconnect()
      },
      requestAgentFrameworkSwitch: (frameworkId) => {
        void runtime.requestAgentFrameworkSwitch(frameworkId)
        void sideChatRuntime.requestProviderReconnect()
      }
    },
    localShell: {
      requestShellRuntimeRefresh: () => runtime.requestShellCapabilityRefresh()
    },
    skills: {
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      notifySkillCatalogChanged: requestSkillCatalogRefresh,
      removeTagsForSkill: (resourceId) =>
        removeResourceTags([{ resourceType: 'catalog.skill', resourceId }])
    },
    connectors: {
      invalidatePermissionProjection: () => permissionGrantProjection.invalidateProjection(),
      refreshConnectorSkillDocs: (customServerId) =>
        customServerId
          ? connectorRuntimeSettings.refreshCustomServer(customServerId)
          : connectorRuntimeSettings.refresh(),
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      pruneCustomServerPermissions: (serverId) =>
        permissionGrantRegistry.prune({ kind: 'mcp_server', serverId }).then(() => undefined),
      removeTagsForConnector: (resourceId) =>
        removeResourceTagsOrThrow([{ resourceType: 'catalog.connector', resourceId }]),
      beginCustomServerSecurityChange: (serverId) =>
        connectorService.beginCustomServerSecurityChange(serverId),
      clearCustomServerFailure: (serverId) => connectorService.clearCustomServerFailure(serverId),
      resetCustomServerClient: (serverId) => mcpClientManager.close(serverId)
    },
    appearance: { applyAppIconVariant: onAppIconVariantChanged ?? (() => undefined) }
  })
  wslRuntimeReconciliation.current = (status) => {
    if (!status.snapshot || status.operation.state === 'running') return
    void settingsWorkflows.localShell
      .fallbackAfterWslProbe(status.snapshot, async () => {
        // Discard an observation superseded while the serialized Shell switch was queued.
        if (wslSetup.getStatus().revision !== status.revision) return {}
        return settingsRepository.getSettings()
      })
      .then(async (changed) => {
        if (changed) {
          await settingsSnapshotCommits.currentSnapshotAfter(Promise.resolve())
          await wslSetup.probe()
        }
      })
      .catch((error) => createLogger('wsl-setup').warn('PowerShell fallback failed', { error }))
  }
  wslRuntimeReconciliation.current(wslSetup.getStatus())
  const settingsFileCommands = createSettingsFileCommands(
    settingsService,
    createSettingsExportFiles(translate)
  )
  surfaceAdapters.push(
    createSettingsElectronSurface({
      fileCommands: settingsFileCommands,
      service: settingsService,
      workflows: settingsWorkflows,
      snapshotCommits: settingsSnapshotCommits,
      listAppIconPreviews,
      translate
    })
  )
  declareElectronAdapter('notebook', () => registerNotebookIpcHandlers(notebookCommands))
  const backgroundResultActivity = createBackgroundResultActivityOwner(
    backgroundResultDeliveryRepository,
    {
      resolveSources: resolveDeliverySources
    }
  )
  declareElectronAdapter('background-result-delivery', () =>
    registerBackgroundResultDeliveryIpcHandlers(backgroundResultActivity)
  )
  return {
    permissionGrantProjection,
    settingsWorkflows,
    settingsFileCommands,
    backgroundResultActivity
  }
}
