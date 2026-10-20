import { redactSensitiveText } from '@aipoch/diagnostics'
import { mcpHostDependencies } from '../connectors/mcp-host-dependencies'
import { builtinConnectorRegistry } from '../connectors/registry'
import { randomUUID } from 'node:crypto'

import type { ApplicationModule } from '../application-runtime'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type { ConnectorApplicationSettingsCapabilities } from '../settings/service-capabilities'
import type { SpecialistView } from '../../shared/specialist'
import type { ConnectorApprovalRequest, ConnectorCredentialRequest } from '../../shared/settings'
import { ApprovalBroker } from '../connectors/approval-broker'
import { CredentialRequestBroker } from '../connectors/credential-request-broker'
import { ParserEngine } from '@aipoch/connector-core'
import { McpClientManager } from '@aipoch/connector-mcp-client'
import { hasUsableCustomMcpCredentials, toCustomMcpConfig } from '../connectors/custom-mcp-config'
import { ConnectorRuntimeSettingsProjection } from '../connectors/runtime-settings-projection'
import {
  ConnectorService,
  CONNECTOR_USER_AGENT,
  type ConnectorCallContext
} from '../connectors/service'

const log = createLogger('connectors:application')

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
  broadcastCredentialRequest: (request: ConnectorCredentialRequest) => void
  replayCredentialRequest: (request: ConnectorCredentialRequest) => void
  onCredentialRequestSettled: (id: string, configured: boolean) => void
  fetchImpl: typeof fetch
  resolveApiKey: (ref?: string) => string | undefined
  canRequestCredential: () => boolean
  permissionGrantRegistry?: PermissionGrantRegistry
  resolveSpecialistProfile: (specialistId: string) => Promise<SpecialistView | undefined>
  localToolHandlers?: Record<
    string,
    (
      args: Record<string, unknown>,
      context: ConnectorCallContext,
      signal?: AbortSignal
    ) => Promise<unknown>
  >
  mcpClientManager?: McpClientManager
  connectorApprovals?: ApprovalBroker
  credentialRequests?: CredentialRequestBroker
}

type ConnectorApplication = {
  connectorService: ConnectorService
  runtimeSettings: ConnectorRuntimeSettingsProjection
  mcpClientManager: McpClientManager
  connectorApprovals: ApprovalBroker
  credentialRequests: CredentialRequestBroker
}

const MAX_APPROVAL_ARGS_JSON_CHARS = 64_000

const serializeArgs = (
  args: Record<string, unknown>
): { preview: string; json: string; truncated: boolean } => {
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    json = '{…}'
  }
  const truncated = json.length > MAX_APPROVAL_ARGS_JSON_CHARS
  return {
    preview: json.length > 300 ? `${json.slice(0, 300)}…` : json,
    json: truncated ? `${json.slice(0, MAX_APPROVAL_ARGS_JSON_CHARS)}…` : json,
    truncated
  }
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
    isRefreshing: (id) => runtimeSettings.isRefreshing(id),
    isDegraded: () => runtimeSettings.isDegraded()
  })
  deps.settings.setCustomServerAuthenticator(
    async (serverId) => {
      const server = (await deps.settings.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === serverId
      )
      if (!server) throw new Error(`Unknown custom connector: ${serverId}`)
      if (!hasUsableCustomMcpCredentials(server)) throw new Error('credential_unavailable')
      await mcpClientManager.authenticate(toCustomMcpConfig(server))
    },
    (serverId) => mcpClientManager.cancelAuthentication(serverId),
    (serverId) => mcpClientManager.close(serverId)
  )
  deps.settings.setDeviceCredentialAuthenticator(
    async (credentialId) => {
      const credential = await deps.settings.resolveDeviceOAuthCredential(credentialId)
      if (!credential) throw new Error(`Unknown OAuth credential: ${credentialId}`)
      if (credential.hasClientSecret && credential.clientSecret === undefined) {
        throw new Error('credential_unavailable')
      }
      const syntheticServerId = `credential:${credentialId}`
      try {
        await mcpClientManager.authenticate({
          id: syntheticServerId,
          name: credential.id,
          transport: credential.transport,
          url: credential.resourceUri,
          oauth: {
            ...credential.oauth,
            credentialId,
            ...(credential.clientSecret ? { clientSecret: credential.clientSecret } : {}),
            ...(credential.state ? { state: credential.state } : {})
          }
        })
      } finally {
        // This identity only drives the Credentials-panel OAuth flow; tool calls use real Connector
        // ids, so keeping its authenticated MCP transport cached would leak an idle session.
        await mcpClientManager.close(syntheticServerId)
      }
    },
    (credentialId) => mcpClientManager.cancelAuthentication(`credential:${credentialId}`),
    (credentialId) => mcpClientManager.close(`credential:${credentialId}`)
  )

  const connectorApprovals =
    deps.connectorApprovals ??
    new ApprovalBroker({
      generateId: () => randomUUID(),
      onSettled: deps.onConnectorApprovalSettled,
      broadcast: deps.broadcastConnectorApproval,
      replay: deps.replayConnectorApproval
    })
  const credentialRequests =
    deps.credentialRequests ??
    new CredentialRequestBroker({
      generateId: () => randomUUID(),
      broadcast: deps.broadcastCredentialRequest,
      replay: deps.replayCredentialRequest,
      onSettled: deps.onCredentialRequestSettled
    })

  const connectorService = new ConnectorService({
    registry: builtinConnectorRegistry,
    engine: new ParserEngine({
      userAgent: CONNECTOR_USER_AGENT,
      fetchImpl: deps.fetchImpl,
      redactDiagnosticText: redactSensitiveText
    }),
    getConnectors: () => runtimeSettings.current(),
    getConnectorsFresh: () => deps.settings.getConnectors(),
    resolveApiKey: deps.resolveApiKey,
    mcpClientManager,
    permissionGrantRegistry: deps.permissionGrantRegistry,
    requestApproval: (
      { connector, method, args, sessionId, availableScopes, approvalTarget },
      signal
    ) => {
      const serializedArgs = serializeArgs(args)
      return connectorApprovals.request(
        {
          connector,
          ...(approvalTarget ?? {}),
          method,
          argsPreview: serializedArgs.preview,
          argsJson: serializedArgs.json,
          ...(serializedArgs.truncated ? { argsJsonTruncated: true } : {}),
          ...(sessionId ? { sessionId } : {}),
          availableScopes
        },
        signal
      )
    },
    requestCredential: (request, signal) =>
      deps.canRequestCredential()
        ? credentialRequests.request(request, signal)
        : Promise.resolve(false),
    resolveSpecialistProfile: deps.resolveSpecialistProfile,
    onCustomServerAvailabilityChanged: (serverId, availability) =>
      runtimeSettings.setCustomServerDispatchAvailability(serverId, availability),
    localToolHandlers: deps.localToolHandlers
  })

  return {
    connectorService,
    runtimeSettings,
    mcpClientManager,
    connectorApprovals,
    credentialRequests
  }
}

export const createConnectorApplicationModule = async (
  deps: ConnectorApplicationDeps
): Promise<ApplicationModule<ConnectorApplication>> => {
  const mcpClientManager =
    deps.mcpClientManager ??
    new McpClientManager({
      ...mcpHostDependencies,
      openExternal: deps.openExternal,
      saveOAuthState: (serverId, state, guard) =>
        deps.settings.saveCustomServerOAuthState(
          serverId,
          state,
          guard?.configurationFingerprint,
          guard?.oauthClientSecretRef
        )
    })

  try {
    const capability = createConnectorApplication(deps, mcpClientManager)
    return {
      name: 'connector-application',
      capability,
      dispose: async () => {
        capability.credentialRequests.cancelAll()
        const refreshesStopped = capability.runtimeSettings.dispose()
        try {
          await mcpClientManager.closeAll()
        } catch (error) {
          // Draining can outlive the outer module budget. Record the known close failure now,
          // before a later timeout replaces it in the application shutdown outcome.
          log.error('MCP client shutdown failed', diagnosticErrorFields(error))
          throw error
        } finally {
          await refreshesStopped
        }
      }
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
