import { randomUUID } from 'node:crypto'

import type { ApplicationModule } from '../application-runtime'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type { ConnectorApplicationSettingsCapabilities } from '../settings/service-capabilities'
import type { UploadRepository } from '../uploads/repository'
import type { SpecialistProfileView } from '../../shared/specialist'
import type {
  ConnectorApprovalRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import { ConversationSkillImporter, SkillImportApprovalBroker } from '../skills/conversation-import'
import { ApprovalBroker } from './approval-broker'
import { ParserEngine } from './engine'
import { McpClientManager } from './mcp-client-manager'
import { toCustomMcpConfig } from './custom-mcp-bootstrap'
import { ConnectorRuntimeSettingsProjection } from './runtime-settings-projection'
import { ConnectorService, type ConnectorCallContext } from './service'

export type ConnectorApplicationDeps = {
  settings: ConnectorApplicationSettingsCapabilities
  skillsDir: string
  openExternal: (url: string) => Promise<void> | void
  notifyStatusChanged: () => void
  broadcastConnectorApproval: (request: ConnectorApprovalRequest) => void
  replayConnectorApproval: (request: ConnectorApprovalRequest) => void
  onConnectorApprovalSettled: (
    id: string,
    state: 'resolved' | 'rejected' | 'expired' | 'cancelled'
  ) => void
  broadcastSkillImportApproval: (request: ConversationSkillImportApprovalRequest) => void
  onSkillImportSettled: (id: string) => void
  onSkillImportLifecycleSettled: (id: string, state: 'resolved' | 'expired' | 'cancelled') => void
  uploads: Pick<UploadRepository, 'resolveManagedUpload' | 'resolveSessionUpload'>
  fetchImpl: typeof fetch
  resolveApiKey: (ref?: string) => string | undefined
  permissionGrantRegistry?: PermissionGrantRegistry
  resolveSpecialistProfile: (specialistId: string) => Promise<SpecialistProfileView | undefined>
  localToolHandlers?: Record<
    string,
    (
      args: Record<string, unknown>,
      context: ConnectorCallContext,
      signal?: AbortSignal
    ) => Promise<unknown>
  >
  onSkillsChanged?: () => void
  mcpClientManager?: McpClientManager
  connectorApprovals?: ApprovalBroker
  skillImportApprovals?: SkillImportApprovalBroker
}

type ConnectorApplication = {
  connectorService: ConnectorService
  runtimeSettings: ConnectorRuntimeSettingsProjection
  mcpClientManager: McpClientManager
  skillImporter: ConversationSkillImporter
  connectorApprovals: ApprovalBroker
  skillImportApprovals: SkillImportApprovalBroker
}

const previewArgs = (args: Record<string, unknown>): string => {
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    json = '{…}'
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

const createConnectorApplication = (
  deps: ConnectorApplicationDeps,
  mcpClientManager: McpClientManager
): ConnectorApplication => {
  const runtimeSettings = new ConnectorRuntimeSettingsProjection({
    readConnectors: () => deps.settings.getConnectors(),
    skillsDir: deps.skillsDir,
    mcpClientManager,
    notifyStatusChanged: deps.notifyStatusChanged
  })

  deps.settings.setCustomServerRuntimeProjectionProvider({
    materializedSkillNames: () => runtimeSettings.materializedCustomSkillNames(),
    availability: (id) => runtimeSettings.customServerAvailability(id),
    isRefreshing: (id) => runtimeSettings.isRefreshing(id)
  })
  deps.settings.setCustomServerAuthenticator(
    async (serverId) => {
      const server = (await deps.settings.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === serverId
      )
      if (!server) throw new Error(`Unknown custom connector: ${serverId}`)
      await mcpClientManager.authenticate(toCustomMcpConfig(server))
    },
    (serverId) => mcpClientManager.cancelAuthentication(serverId)
  )

  const connectorApprovals =
    deps.connectorApprovals ??
    new ApprovalBroker({
      generateId: () => randomUUID(),
      onSettled: deps.onConnectorApprovalSettled,
      broadcast: deps.broadcastConnectorApproval,
      replay: deps.replayConnectorApproval
    })
  const skillImportApprovals =
    deps.skillImportApprovals ??
    new SkillImportApprovalBroker({
      generateId: () => randomUUID(),
      broadcast: deps.broadcastSkillImportApproval,
      onSettled: deps.onSkillImportSettled,
      onLifecycleSettled: deps.onSkillImportLifecycleSettled
    })

  const skillImporter = new ConversationSkillImporter({
    uploads: deps.uploads,
    createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
      skillImportApprovals.createCancellationGuard(sessionId, turnToken, attachmentUri),
    createSessionCancellationGuard: (sessionId) =>
      skillImportApprovals.createSessionCancellationGuard(sessionId),
    previewBundle: (bundle) => deps.settings.previewSkillArchive(bundle),
    importBundle: (bundle, items) => deps.settings.importSkillArchiveBatch(bundle, items),
    scanGitHub: async (url) => (await deps.settings.scanRepoSkills({ repo: url })).skills,
    importGitHub: (url) => deps.settings.importSkill({ url }),
    requestApproval: (request, cancellation) => skillImportApprovals.request(request, cancellation),
    onSkillsChanged: deps.onSkillsChanged
  })

  const connectorService = new ConnectorService({
    engine: new ParserEngine({ fetchImpl: deps.fetchImpl }),
    getConnectors: () => runtimeSettings.current(),
    getConnectorsFresh: () => deps.settings.getConnectors(),
    resolveApiKey: deps.resolveApiKey,
    mcpClientManager,
    permissionGrantRegistry: deps.permissionGrantRegistry,
    requestApproval: ({ connector, method, args, sessionId, availableScopes }, signal) =>
      connectorApprovals.request(
        {
          connector,
          method,
          argsPreview: previewArgs(args),
          ...(sessionId ? { sessionId } : {}),
          availableScopes
        },
        signal
      ),
    resolveSpecialistProfile: deps.resolveSpecialistProfile,
    onCustomServerAvailabilityChanged: (serverId, availability) =>
      runtimeSettings.setCustomServerDispatchAvailability(serverId, availability),
    localToolHandlers: deps.localToolHandlers
  })

  return {
    connectorService,
    runtimeSettings,
    mcpClientManager,
    skillImporter,
    connectorApprovals,
    skillImportApprovals
  }
}

export const createConnectorApplicationModule = async (
  deps: ConnectorApplicationDeps
): Promise<ApplicationModule<ConnectorApplication>> => {
  const mcpClientManager =
    deps.mcpClientManager ??
    new McpClientManager({
      openExternal: deps.openExternal,
      saveOAuthState: (serverId, state) => deps.settings.saveCustomServerOAuthState(serverId, state)
    })

  try {
    return {
      name: 'connector-application',
      capability: createConnectorApplication(deps, mcpClientManager),
      dispose: () => mcpClientManager.closeAll()
    }
  } catch (error) {
    try {
      await mcpClientManager.closeAll()
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Connector application construction and disposal failed.'
      )
    }
    throw error
  }
}
