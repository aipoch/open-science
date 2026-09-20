export const MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL = 'mac-installation-assistant:action'
export const MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL = 'mac-installation-assistant:result'

export const MAC_INSTALLATION_RESUME_UPDATE_ARG = '--resume-update-after-installation'
export type MacInstallationAssistantAction = 'continue' | 'install' | 'show-in-finder' | 'restart'

export type MacInstallationAssistantResult =
  Readonly<{ status: 'installed' }> | Readonly<{ status: 'error' }>
