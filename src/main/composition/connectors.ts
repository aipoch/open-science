import { desktopShellInteraction, desktopInteraction } from '../desktop-interaction'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { waitForInitialConnectorRefresh } from '../connector-reload'
import { createConnectorApplicationModule } from '../connectors/application'
import { createMoleculePreviewHandler } from '../connectors/molecule'
import { connectorSkillSourceDir } from '../connectors/provision'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, errorLogFields } from '../logger'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import {
  buildConnectorApprovalBroadcast,
  buildConnectorCredentialRequestBroadcast,
  buildSkillImportApprovalBroadcast
} from '../notifications/electron-wiring'
import { TaskNotificationService } from '../notifications/task-notifications'
import {
  reconcilePendingCustomServerDeletions,
  reconcilePermissionGrantOwners
} from '../permission-grants/reconciliation'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import { tryDecryptKey } from '../settings/crypto'
import { SettingsRepository } from '../settings/repository'
import { SettingsService } from '../settings/service'
import { netFetchStandard } from '../skills/net-fetch'
import { SpecialistService } from '../specialist/service'
import { resolveConfigRoot } from '../storage-root'
import { TagService } from '../tags/service'
import { createDefaultUploadRepository } from '../uploads/ipc'

const permissionGrantsLog = createLogger('permission-grants')

export async function composeConnectors({
  canRequestDesktopCredential,
  settingsService,
  uploadRepository,
  managedFileVersionService,
  runtimeRef,
  requestSkillCatalogRefresh,
  permissionGrantRegistry,
  specialistService,
  notificationsLog,
  taskNotifications,
  headless,
  modules,
  composition
}: {
  canRequestDesktopCredential?: () => boolean
  settingsService: SettingsService
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  requestSkillCatalogRefresh: () => void
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  specialistService: SpecialistService
  notificationsLog: ReturnType<typeof createLogger>
  taskNotifications: TaskNotificationService
  headless: boolean
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<{
  connectorService: import('../connectors/service').ConnectorService
  connectorRuntimeSettings: import('../connectors/runtime-settings-projection').ConnectorRuntimeSettingsProjection
  mcpClientManager: import('../connectors/custom-mcp/client-manager').McpClientManager
  conversationSkillImporter: import('../skills/conversation-import').ConversationSkillImporter
  approvalBroker: import('../connectors/approval-broker').ApprovalBroker
  credentialRequestBroker: import('../connectors/credential-request-broker').CredentialRequestBroker
  skillImportApprovalBroker: import('../skills/conversation-import').SkillImportApprovalBroker
}> {
  // The connector application owns MCP, connector/skill approval, runtime projection, and service
  // construction. Late-bound local tools remain composition-root dependencies and are passed in.
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (sessionId, input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(sessionId, input)
    }
  })
  const connectorApplication = await modules.add(
    {
      settings: settingsService,
      skillsDir: connectorSkillSourceDir(resolveConfigRoot()),
      openExternal: (url) => desktopShellInteraction().openExternal(url),
      notifyStatusChanged: () =>
        broadcastToRenderers('settings:connector-runtime-changed', undefined),
      broadcastConnectorApproval: buildConnectorApprovalBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('connector approval notification failed', errorLogFields(error))
      }),
      onConnectorApprovalSettled: (id, state) => {
        try {
          broadcastToRenderers('connectors:approval-settled', id)
        } finally {
          void taskNotifications.settleAuthorization('connector', id, state)
        }
      },
      replayConnectorApproval: (request) =>
        broadcastToRenderers('connectors:approval-request', request),
      broadcastCredentialRequest: buildConnectorCredentialRequestBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('connector credential notification failed', errorLogFields(error))
      }),
      replayCredentialRequest: (request) =>
        broadcastToRenderers('connectors:credential-request', request),
      onCredentialRequestSettled: (id, configured) => {
        try {
          broadcastToRenderers('connectors:credential-settled', id)
        } finally {
          void taskNotifications.settleConnectorCredentialRequest(id, configured)
        }
      },
      broadcastSkillImportApproval: buildSkillImportApprovalBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('skill import approval notification failed', errorLogFields(error))
      }),
      onSkillImportSettled: (id) => broadcastToRenderers('skills:conversation-import-settled', id),
      onSkillImportLifecycleSettled: (id, state) =>
        void taskNotifications.settleAuthorization('skill-import', id, state),
      uploads: uploadRepository,
      managedFileVersions: managedFileVersionService,
      fetchImpl: netFetchStandard,
      resolveApiKey: (ref) => tryDecryptKey(ref),
      canRequestCredential:
        canRequestDesktopCredential ??
        (() => !headless && desktopInteraction('Connector credential dialog').hasWindow()),
      permissionGrantRegistry,
      resolveSpecialistProfile: async (specialistId) => {
        try {
          return await specialistService.resolveRunnableById(specialistId)
        } catch {
          return undefined
        }
      },
      localToolHandlers: { 'molecule/preview_molecule': moleculePreviewHandler },
      onSkillsChanged: requestSkillCatalogRefresh
    } satisfies Parameters<typeof createConnectorApplicationModule>[0],
    createConnectorApplicationModule
  )
  const {
    connectorService,
    runtimeSettings: connectorRuntimeSettings,
    mcpClientManager,
    skillImporter: conversationSkillImporter,
    connectorApprovals: approvalBroker,
    credentialRequests: credentialRequestBroker,
    skillImportApprovals: skillImportApprovalBroker
  } = connectorApplication
  composition.phase('connectors')
  return {
    connectorService,
    connectorRuntimeSettings,
    mcpClientManager,
    conversationSkillImporter,
    approvalBroker,
    credentialRequestBroker,
    skillImportApprovalBroker
  }
}

export function composeConnectorRecovery({
  settingsRepository,
  runtimeRef,
  permissionGrantRegistry,
  removeResourceTagsOrThrow,
  connectorRuntimeSettings,
  hostRepository
}: {
  settingsRepository: SettingsRepository
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  removeResourceTagsOrThrow: (
    resources: Parameters<TagService['removeResources']>[0]
  ) => Promise<void>
  connectorRuntimeSettings: import('../connectors/runtime-settings-projection').ConnectorRuntimeSettingsProjection
  hostRepository: import('../compute/repository').ComputeHostRepository
}): { initialConnectorSkillsReady: ReturnType<typeof waitForInitialConnectorRefresh> } {
  const recoverPendingCustomServerDeletions = async (): Promise<void> => {
    const pendingCustomServerDeletionIds =
      (await settingsRepository.getSettings()).connectors?.pendingCustomServerDeletionIds ?? []
    await reconcilePendingCustomServerDeletions(permissionGrantRegistry, {
      pendingCustomServerDeletionIds,
      removeTagsForConnector: (serverId) =>
        removeResourceTagsOrThrow([{ resourceType: 'catalog.connector', resourceId: serverId }]),
      completeCustomServerDeletion: (serverId) =>
        settingsRepository.completeCustomServerDeletion(serverId)
    })
  }
  const initialConnectorSkillsReady = waitForInitialConnectorRefresh(
    recoverPendingCustomServerDeletions()
      .catch((error) =>
        permissionGrantsLog.error(
          'pending Connector relationship cleanup failed',
          errorLogFields(error)
        )
      )
      .then(() => connectorRuntimeSettings.refresh()),
    {
      // If custom MCP discovery outlives the startup barrier, the first agent may already have
      // materialized the old connector docs. Rotate it once the late refresh settles so the next
      // session/prompt uses the refreshed skills instead of waiting for another settings change.
      onLateSettled: () => runtimeRef.current?.requestSkillsReload()
    }
  )

  // Repair legacy UUID Connector grants and ComputeHost grants left behind without a deletion
  // journal. A failed/timeout Connector refresh leaves that owner class untouched; app-owned MCP
  // catalog ids are non-UUID and are never guessed to be stale.
  void initialConnectorSkillsReady
    .then(async () => {
      const hosts = await hostRepository.list()
      await reconcilePermissionGrantOwners(permissionGrantRegistry, {
        ...(connectorRuntimeSettings.current()
          ? {
              customServerIds:
                connectorRuntimeSettings.current()?.customMcpServers?.map((server) => server.id) ??
                []
            }
          : {}),
        computeProviderIds: hosts.map((host) => host.providerId)
      })
    })
    .catch((error) =>
      permissionGrantsLog.error(
        'permission grant owner reconciliation failed',
        errorLogFields(error)
      )
    )
  return { initialConnectorSkillsReady }
}
