// Pure startup-gate decision: combines #4's in-memory session latch (hasEnteredApp), the persisted
// onboarding marker, and the two preflight gates (Claude present + an active validated provider) into
// a single renderable view. Kept free of React and the store so the full truth table is unit-testable.
//
// Policy: the onboarding wizard is a *first-run-only* gate. Once onboarding has completed (marker set)
// — or the user has entered the app this session — later Claude/provider problems are fixed in
// Settings, never by re-showing the full-screen wizard (Q3: "not every error → recovery").

export type StartupView = 'onboarding' | 'app'

export type StartupGateInput = {
  // #4 session latch: true once both gates first passed this session (never flips back off).
  hasEnteredApp: boolean
  // Whether first-run onboarding has ever finished (settings.onboardingCompletedAt is set).
  onboardingDone: boolean
  // Preflight: a runnable claude executable was detected.
  claudeReady: boolean
  // Preflight: the active provider exists, validated at least once, and has usable credentials.
  activeProviderReady: boolean
}

const isConfigValid = (input: StartupGateInput): boolean =>
  input.claudeReady && input.activeProviderReady

// Show the wizard only on a genuine first run: never entered this session, never onboarded, and no
// usable config yet. Every other case enters the app.
export const resolveStartupView = (input: StartupGateInput): StartupView => {
  if (input.hasEnteredApp) return 'app'
  if (input.onboardingDone) return 'app'
  if (isConfigValid(input)) return 'app'

  return 'onboarding'
}

// True for the already-configured user who predates the marker: silently stamp it on entry.
export const shouldMarkOnboardingComplete = (input: StartupGateInput): boolean =>
  !input.onboardingDone && isConfigValid(input)
