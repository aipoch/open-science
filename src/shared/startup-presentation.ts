export type StartupPresentationPhase =
  | 'startup-database'
  | 'startup-runtime'
  | 'startup-settings'
  | 'startup-sessions'
  | 'interactive'
  | 'blocked'

export const STARTUP_PRESENTATION_CHANNEL = 'startup-presentation:phase'
