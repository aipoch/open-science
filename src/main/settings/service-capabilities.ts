import type { SettingsService } from './service'

// Transitional structural capabilities for callers that still consume the SettingsService façade.
// They keep integration modules independent of the concrete class while the façade remains available
// for compatibility through T3.
export type AcpSettingsCapabilities = Pick<
  SettingsService,
  | 'captureActiveAgentBackendSelection'
  | 'resolveAgentBackend'
  | 'resolveExplicitAgentBackend'
  | 'skillsNeedingForceLoad'
  | 'skillNudgeNamesForIds'
  | 'codexSkillDescriptorsForIds'
  | 'codexSkillCatalog'
  | 'codeBuddySkillCatalog'
  | 'getConversationSkillImportEnabled'
  | 'admitVisionModel'
  | 'getConnectors'
  | 'listSpecialistSkillCatalog'
  | 'provisionedConnectorSkillNames'
  | 'rememberCodexAutoHttpsFallback'
> &
  Partial<Pick<SettingsService, 'resolveAdmittedSubagentBackend'>>

export type WindowSettingsCapabilities = Pick<
  SettingsService,
  'getAppIconVariant' | 'getClosePreference' | 'setClosePreference'
>

export type ConnectorApplicationSettingsCapabilities = Pick<
  SettingsService,
  | 'getConnectors'
  | 'saveCustomServerOAuthState'
  | 'resolveDeviceOAuthCredential'
  | 'setDeviceCredentialAuthenticator'
  | 'setCustomServerRuntimeProjectionProvider'
  | 'setCustomServerAuthenticator'
  | 'previewSkillArchive'
  | 'importSkillArchiveBatch'
  | 'scanRepoSkills'
  | 'importSkill'
>
