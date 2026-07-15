import { useEffect } from 'react'

import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { UpdateDialog } from '@/components/UpdateDialog'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { resolveStartupView } from '@/pages/onboarding/startup-gate'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUpdateStore } from '@/stores/update-store'

const App = (): React.JSX.Element | null => {
  // Persistence is started once at the top so sessions stay loaded for both Home and Workspace.
  const isSessionPersistenceReady = useSessionPersistence()
  const view = useNavigationStore((state) => state.view)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const isEnvironmentRepairOpen = useSettingsStore((state) => state.isEnvironmentRepairOpen)
  const loadSettings = useSettingsStore((state) => state.load)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const enqueueApproval = useSettingsStore((state) => state.enqueueApproval)
  const initUpdates = useUpdateStore((state) => state.init)

  // Load app info and subscribe to update-status broadcasts once at startup.
  useEffect(() => {
    initUpdates()
  }, [initUpdates])

  // Subscribe once to connector approval requests from the main-process gate; they surface as a
  // modal the user must answer before the held connector call proceeds.
  useEffect(
    () => window.api.settings.onConnectorApprovalRequest(enqueueApproval),
    [enqueueApproval]
  )

  // Load the project list once on startup so Home can render immediately after hydration.
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // Load settings/preflight once so the startup gate can decide between onboarding and the app.
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // Required host capabilities are re-checked on every launch. Completed users remain on Home while
  // this runs; a required failure becomes an inline alert instead of flashing the setup page.
  useEffect(() => {
    void checkEnvironment()
  }, [checkEnvironment])

  // Settings carry the persisted first-run marker. No environment result is awaited here: existing
  // users proceed directly to Home while the launch check runs in the background.
  if (!isSettingsLoaded) {
    return null
  }

  if (
    resolveStartupView({
      onboardingDone: onboardingCompletedAt !== undefined,
      repairRequested: isEnvironmentRepairOpen
    }) === 'onboarding'
  ) {
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
      <ConnectorApprovalDialog />
      <UpdateDialog />
    </>
  )
}

export default App
