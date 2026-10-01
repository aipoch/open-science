// Ordered fragments keep the public registration order when capabilities interleave.
import type {
  GitHubTokenStatus,
  SaveGitHubTokenRequest,
  ConnectorsSnapshot,
  DeviceCredentialsSnapshot,
  ConnectorDetailView,
  ConnectorTemplateExportPreview,
  ConnectorTemplateSelectionResult,
  SelectCustomServerTemplateRequest,
  ExportCustomServerTemplateRequest,
  ExportCustomServerTemplateResult,
  SetConnectorEnabledRequest,
  SetConnectorAutoAllowRequest,
  SetToolPermissionRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  ValidateOpenAlexCredentialRequest,
  OpenAlexCredentialValidation,
  AddCustomServerRequest,
  CreateDeviceCredentialRequest,
  CreateDeviceCredentialResult,
  DeviceCredentialAuthenticationRequest,
  AuthenticateCustomServerRequest,
  DisconnectCustomServerRequest,
  SetCustomServerEnabledRequest,
  RemoveCustomServerRequest,
  RemoveDeviceCredentialRequest,
  UpdateCustomServerRequest,
  UpdateDeviceCredentialRequest,
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  RespondApprovalRequest,
  RespondConnectorCredentialRequest
} from '../settings'

import {
  callable,
  LOCAL,
  ELECTRON,
  type AcpListener,
  type RemoveListener,
  EVENT,
  ELECTRON_EVENT
} from './definition'

export const settingsAddCustomServerContracts = {
  'settings.addCustomServer': callable<
    (request: AddCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:add-custom-server', LOCAL]),
  'settings.createDeviceCredential': callable<
    (request: CreateDeviceCredentialRequest) => Promise<CreateDeviceCredentialResult>
  >()('settings', ['settings:create-device-credential', LOCAL]),
  'settings.authenticateDeviceCredential': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:authenticate-device-credential', LOCAL]),
  'settings.cancelDeviceCredentialAuthentication': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<void>
  >()('settings', ['settings:cancel-device-credential-authentication', LOCAL]),
  'settings.disconnectDeviceCredential': callable<
    (request: DeviceCredentialAuthenticationRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:disconnect-device-credential', LOCAL]),
  'settings.authenticateCustomServer': callable<
    (request: DisconnectCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:authenticate-custom-server', LOCAL])
} as const

export const settingsCancelCustomServerAuthenticationContracts = {
  'settings.cancelCustomServerAuthentication': callable<
    (request: AuthenticateCustomServerRequest) => Promise<void>
  >()('settings', ['settings:cancel-custom-server-authentication', LOCAL]),
  'settings.disconnectCustomServer': callable<
    (request: AuthenticateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:disconnect-custom-server', LOCAL])
} as const

export const settingsExportCustomServerTemplateContracts = {
  'settings.exportCustomServerTemplate': callable<
    (request: ExportCustomServerTemplateRequest) => Promise<ExportCustomServerTemplateResult>
  >()('settings', ['settings:export-custom-server-template', ELECTRON])
} as const

export const settingsGetConnectorDetailContracts = {
  'settings.getConnectorDetail': callable<(id: string) => Promise<ConnectorDetailView>>()(
    'settings',
    ['settings:get-connector-detail']
  ),
  'settings.getGitHubTokenStatus': callable<() => Promise<GitHubTokenStatus>>()('settings', [
    'settings:get-github-token-status',
    LOCAL
  ])
} as const

export const settingsListConnectorsContracts = {
  'settings.listConnectors': callable<() => Promise<ConnectorsSnapshot>>()('settings', [
    'settings:list-connectors'
  ]),
  'settings.listDeviceCredentials': callable<() => Promise<DeviceCredentialsSnapshot>>()(
    'settings',
    ['settings:list-device-credentials', LOCAL]
  )
} as const

export const settingsOnConnectorApprovalRequestContracts = {
  'settings.onConnectorApprovalRequest': callable<
    (listener: AcpListener<ConnectorApprovalRequest>) => RemoveListener
  >()('settings', ['connectors:approval-request', EVENT]),
  'settings.onConnectorApprovalSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['connectors:approval-settled', EVENT], { optionalMember: true }),
  'settings.onConnectorCredentialRequest': callable<
    (listener: AcpListener<ConnectorCredentialRequest>) => RemoveListener
  >()('settings', ['connectors:credential-request', ELECTRON_EVENT], { optionalMember: true }),
  'settings.onConnectorCredentialSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['connectors:credential-settled', ELECTRON_EVENT], { optionalMember: true }),
  'settings.onConnectorRuntimeChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('settings', ['settings:connector-runtime-changed', EVENT])
} as const

export const settingsPreviewCustomServerTemplateExportContracts = {
  'settings.previewCustomServerTemplateExport': callable<
    (id: string) => Promise<ConnectorTemplateExportPreview>
  >()('settings', ['settings:preview-custom-server-template-export', ELECTRON])
} as const

export const settingsRemoveCustomServerContracts = {
  'settings.removeCustomServer': callable<
    (request: RemoveCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:remove-custom-server', LOCAL]),
  'settings.removeDeviceCredential': callable<
    (request: RemoveDeviceCredentialRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:remove-device-credential', LOCAL]),
  'settings.removeGitHubToken': callable<() => Promise<GitHubTokenStatus>>()('settings', [
    'settings:remove-github-token',
    LOCAL
  ]),
  'settings.replayConnectorApproval': callable<
    (id: string) => Promise<ConnectorApprovalRequest | null>
  >()('settings', ['connectors:approval-replay']),
  'settings.replayPendingConnectorApprovals': callable<() => Promise<void>>()(
    'settings',
    ['connectors:approval-replay-pending'],
    { optionalMember: true }
  ),
  'settings.replayPendingConnectorCredentialRequests': callable<() => Promise<void>>()(
    'settings',
    ['connectors:credential-replay-pending', ELECTRON],
    { optionalMember: true }
  )
} as const

export const settingsRespondConnectorApprovalContracts = {
  'settings.respondConnectorApproval': callable<
    (request: RespondApprovalRequest) => Promise<void>
  >()('settings', ['connectors:approval-respond']),
  'settings.respondConnectorCredentialRequest': callable<
    (request: RespondConnectorCredentialRequest) => Promise<void>
  >()('settings', ['connectors:credential-respond', ELECTRON], { optionalMember: true })
} as const

export const settingsRetryConnectorProjectionContracts = {
  'settings.retryConnectorProjection': callable<() => Promise<ConnectorsSnapshot>>()('settings', [
    'settings:retry-connector-projection',
    LOCAL
  ]),
  'settings.retryCustomServer': callable<
    (request: AuthenticateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:retry-custom-server', LOCAL]),
  'settings.saveGitHubToken': callable<
    (request: SaveGitHubTokenRequest) => Promise<GitHubTokenStatus>
  >()('settings', ['settings:save-github-token', LOCAL])
} as const

export const settingsSelectCustomServerTemplateContracts = {
  'settings.selectCustomServerTemplate': callable<
    (request?: SelectCustomServerTemplateRequest) => Promise<ConnectorTemplateSelectionResult>
  >()('settings', ['settings:select-custom-server-template', ELECTRON])
} as const

export const settingsSetConnectorAutoAllowContracts = {
  'settings.setConnectorAutoAllow': callable<
    (request: SetConnectorAutoAllowRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-connector-auto-allow']),
  'settings.setConnectorEnabled': callable<
    (request: SetConnectorEnabledRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-connector-enabled'])
} as const

export const settingsSetCustomServerEnabledContracts = {
  'settings.setCustomServerEnabled': callable<
    (request: SetCustomServerEnabledRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-custom-server-enabled', LOCAL])
} as const

export const settingsSetNcbiCredentialsContracts = {
  'settings.setNcbiCredentials': callable<
    (request: SetNcbiCredentialsRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-ncbi-credentials'])
} as const

export const settingsSetOpenAlexCredentialContracts = {
  'settings.setOpenAlexCredential': callable<
    (request: SetOpenAlexCredentialRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:set-openalex-credential', LOCAL]),
  'settings.validateOpenAlexCredential': callable<
    (request: ValidateOpenAlexCredentialRequest) => Promise<OpenAlexCredentialValidation>
  >()('settings', ['settings:validate-openalex-credential', LOCAL])
} as const

export const settingsSetToolPermissionContracts = {
  'settings.setToolPermission': callable<
    (request: SetToolPermissionRequest) => Promise<ConnectorDetailView>
  >()('settings', ['settings:set-tool-permission'])
} as const

export const settingsUpdateCustomServerContracts = {
  'settings.updateCustomServer': callable<
    (request: UpdateCustomServerRequest) => Promise<ConnectorsSnapshot>
  >()('settings', ['settings:update-custom-server', LOCAL]),
  'settings.updateDeviceCredential': callable<
    (request: UpdateDeviceCredentialRequest) => Promise<DeviceCredentialsSnapshot>
  >()('settings', ['settings:update-device-credential', LOCAL])
} as const
