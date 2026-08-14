import type { SettingsService } from './service'

// Transitional structural capabilities for callers that still consume the SettingsService façade.
// They keep integration modules independent of the concrete class while the façade remains available
// for compatibility through T3.
export type AcpSettingsCapabilities = Pick<
  SettingsService,
  | 'captureActiveAgentBackendSelection'
  | 'resolveAgentBackend'
  | 'skillsNeedingForceLoad'
  | 'skillNudgeNamesForIds'
  | 'codexSkillDescriptorsForIds'
  | 'codexSkillCatalog'
  | 'getConversationSkillImportEnabled'
  | 'getConnectors'
  | 'listSpecialistSkillCatalog'
  | 'provisionedConnectorSkillNames'
> &
  Partial<Pick<SettingsService, 'resolveExplicitAgentBackend' | 'resolveAdmittedSubagentBackend'>>

export type WindowSettingsCapabilities = Pick<
  SettingsService,
  'getAppIconVariant' | 'getClosePreference' | 'setClosePreference'
>
