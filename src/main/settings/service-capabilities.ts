import type { SettingsService } from './service'

// Transitional structural capabilities for callers that still consume the SettingsService façade.
// They keep integration modules independent of the concrete class while the façade remains available
// for compatibility through T3.
export type AcpSettingsCapabilities = Pick<
  SettingsService,
  | 'captureActiveAgentBackendSelection'
  | 'captureActiveExplicitAgentBackendTarget'
  | 'resolveAgentBackend'
  | 'skillsNeedingForceLoad'
  | 'skillNudgeNamesForIds'
  | 'codexSkillDescriptorsForIds'
  | 'codexSkillCatalog'
  | 'getConversationSkillImportEnabled'
  | 'getConnectors'
  | 'listSpecialistSkillCatalog'
  | 'provisionedConnectorSkillNames'
  | 'resolveExplicitAgentBackend'
> &
  Partial<Pick<SettingsService, 'resolveAdmittedSubagentBackend'>>

export type WindowSettingsCapabilities = Pick<
  SettingsService,
  'getAppIconVariant' | 'getClosePreference' | 'setClosePreference'
>
