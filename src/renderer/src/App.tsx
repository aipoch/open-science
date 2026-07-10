import { useEffect } from 'react'

import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
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
  const loadSettings = useSettingsStore((state) => state.load)
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

  // Hold rendering until the preflight gate is known so the wizard does not flash for ready users.
  if (!isSettingsLoaded) {
    return null
  }

  // Hard startup gate: a runnable claude plus a validated active provider are both required.
  if (!preflight.claudeReady || !preflight.activeProviderReady) {
    return <OnboardingWizard onComplete={() => undefined} />
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
