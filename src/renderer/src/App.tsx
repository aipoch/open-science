import { useEffect, useMemo } from 'react'

import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { resolveStartupView, shouldMarkOnboardingComplete } from '@/pages/onboarding/startup-gate'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'

const App = (): React.JSX.Element | null => {
  // Persistence is started once at the top so sessions stay loaded for both Home and Workspace.
  const isSessionPersistenceReady = useSessionPersistence()
  const view = useNavigationStore((state) => state.view)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded)
  const preflight = useSettingsStore((state) => state.preflight)
  // #4 session latch: once true, a later gate flip in settings must not resurrect the wizard.
  const hasEnteredApp = useSettingsStore((state) => state.hasEnteredApp)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const loadSettings = useSettingsStore((state) => state.load)
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const closeSettings = useSettingsStore((state) => state.closeSettings)

  // Load the project list once on startup so Home can render immediately after hydration.
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // Load settings/preflight once so the startup gate can decide between onboarding and the app.
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // Stable so the auto-complete effect only re-runs when an actual gate value changes.
  const gateInput = useMemo(
    () => ({
      hasEnteredApp,
      onboardingDone: onboardingCompletedAt !== undefined,
      claudeReady: preflight.claudeReady,
      activeProviderReady: preflight.activeProviderReady
    }),
    [hasEnteredApp, onboardingCompletedAt, preflight.claudeReady, preflight.activeProviderReady]
  )

  // Already-configured installs that predate the marker: stamp it silently, without a wizard flash.
  useEffect(() => {
    if (isSettingsLoaded && shouldMarkOnboardingComplete(gateInput)) {
      void completeOnboarding()
    }
  }, [isSettingsLoaded, gateInput, completeOnboarding])

  // Hold rendering until the gate is known so the wizard does not flash for ready users.
  if (!isSettingsLoaded) {
    return null
  }

  if (resolveStartupView(gateInput) === 'onboarding') {
    return <OnboardingWizard />
  }

  return (
    <>
      {view === 'home' ? (
        <HomePage />
      ) : (
        <WorkspacePage isSessionPersistenceReady={isSessionPersistenceReady} />
      )}
      <SettingsPage open={isSettingsOpen} onClose={closeSettings} />
    </>
  )
}

export default App
