import type { OpenScienceAPI } from '../shared/renderer-contract-catalog'
import type { StartupPresentationPhase } from '../shared/startup-presentation'

declare global {
  interface Window {
    api: OpenScienceAPI
    startupPresentation?: { phase: (phase: StartupPresentationPhase) => void }
  }
}

export {}
