// Pure startup decision. First-time setup is an explicit flow even when the machine already satisfies
// every dependency; completed users always enter the app while launch checks continue invisibly in
// the background. They see the repair surface only after choosing the Home alert.

export type StartupView = 'onboarding' | 'app'

export type StartupGateInput = {
  onboardingDone: boolean
  repairRequested: boolean
}

export const resolveStartupView = (input: StartupGateInput): StartupView =>
  !input.onboardingDone || input.repairRequested ? 'onboarding' : 'app'
