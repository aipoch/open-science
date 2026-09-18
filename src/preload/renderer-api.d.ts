import type { OpenScienceAPI } from '../shared/renderer-contract-catalog'
import type { MacInstallationAssistantResult } from '../shared/mac-installation'

declare global {
  interface Window {
    api: OpenScienceAPI
    installationAssistant: {
      restart: () => void
      continueUsing: () => void
      install: () => Promise<MacInstallationAssistantResult>
      showInFinder: () => void
    }
  }
}

export {}
