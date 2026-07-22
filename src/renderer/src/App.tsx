import { useCallback, useEffect, useState } from 'react'

import { useDeepLinkNavigation } from '@/lib/deep-link'
import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { UpdateDialog } from '@/components/UpdateDialog'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { resolveStartupView } from '@/pages/onboarding/startup-gate'
import { ComputeApprovalDialog } from '@/pages/settings/ComputeApprovalDialog'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import { useCloseActivePaneShortcut } from '@/hooks/useCloseActivePaneShortcut'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useComputeStore } from '@/stores/compute-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useUpdateStore } from '@/stores/update-store'

const App = (): React.JSX.Element | null => {
  // Persistence is started once at the top so sessions stay loaded for both Home and Workspace.
  const isSessionPersistenceReady = useSessionPersistence()
  useDeepLinkNavigation(isSessionPersistenceReady)
  const view = useNavigationStore((state) => state.view)
  // Cmd+W / Ctrl+W closes the open preview panel before it closes the window.
  useCloseActivePaneShortcut()
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const isEnvironmentRepairOpen = useSettingsStore((state) => state.isEnvironmentRepairOpen)
  const loadSettings = useSettingsStore((state) => state.load)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const enqueueApproval = useSettingsStore((state) => state.enqueueApproval)
  const enqueueComputeApproval = useComputeStore((state) => state.enqueueApproval)
  const applyJobUpdate = useSessionJobStore((state) => state.applyUpdate)
  const initUpdates = useUpdateStore((state) => state.init)
  const initEnv = useNotebookEnvStore((state) => state.init)
  const envUi = useNotebookEnvStore((state) => state.ui)
  const retryEnv = useNotebookEnvStore((state) => state.retry)
  // §20.4: settings.dataRoot configured but the folder is gone (deleted or an unmounted drive).
  const [missingDataRoot, setMissingDataRoot] = useState<string | undefined>(undefined)
  // Legacy (pre-§20) install whose data still lives in the hidden config root: offer the one-time
  // "move it into the visible OpenScience folder" prompt. Null once absent/answered.
  const [legacyMove, setLegacyMove] = useState<
    { currentDataRoot: string; defaultParent: string } | undefined
  >(undefined)

  // Load app info and subscribe to update-status broadcasts once at startup.
  useEffect(() => {
    initUpdates()
  }, [initUpdates])

  // Mirrors the main-process provisioner once at launch (Plan A auto-runs upgradeIfNeeded and
  // broadcasts progress); the returned `ui` drives the top-level upgrade/error banner below.
  useEffect(() => {
    void initEnv()
  }, [initEnv])

  // Checked once at startup, after the gate is settled: dataRootMissing only fires for an
  // explicitly-configured root, which implies onboarding already completed - never during the
  // wizard itself.
  useEffect(() => {
    void window.api.storage.getInfo().then((info) => {
      if (info.dataRootMissing) setMissingDataRoot(info.dataRoot)
      else if (info.legacyDataMovePrompt) {
        setLegacyMove({
          currentDataRoot: info.dataRoot,
          defaultParent: info.defaultParent
        })
      }
    })
  }, [])

  // Subscribe once to connector approval requests from the main-process gate; they surface as a
  // modal the user must answer before the held connector call proceeds.
  useEffect(
    () => window.api.settings.onConnectorApprovalRequest(enqueueApproval),
    [enqueueApproval]
  )

  // Clicking a desktop notification opens the conversation the finished/failed task belongs to.
  // Main holds the target until it is pulled here, so a click that recreates the window (listener
  // not yet registered, sessions not yet hydrated) cannot lose the navigation.
  const openPendingNotificationSession = useCallback(async (): Promise<void> => {
    const pending = await window.api.notifications.takePendingOpenSession()

    if (pending) useNavigationStore.getState().openSessionById(pending.sessionId)
  }, [])

  // Fast path: a click while this renderer is alive arrives as a nudge; pull the target. A click
  // mid-hydration is left pending and consumed by the effect below once sessions are ready.
  useEffect(
    () =>
      window.api.notifications.onOpenSession(() => {
        if (isSessionPersistenceReady) void openPendingNotificationSession()
      }),
    [isSessionPersistenceReady, openPendingNotificationSession]
  )

  // Slow path: the click recreated the window before this listener existed. Consume the pending
  // target as soon as session persistence has hydrated the store.
  useEffect(() => {
    if (isSessionPersistenceReady) void openPendingNotificationSession()
  }, [isSessionPersistenceReady, openPendingNotificationSession])

  // Subscribe once to compute approval requests. The card must be answered before the SSH call runs.
  useEffect(
    () => window.api.compute.onApprovalRequest(enqueueComputeApproval),
    [enqueueComputeApproval]
  )

  // Subscribe once to job-updated broadcasts so the session job feed stays live for the badge and
  // inline job rows. Updates are applied globally — the store filters by sessionId at query time.
  useEffect(() => window.api.compute.onJobUpdated(applyJobUpdate), [applyJobUpdate])

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
      <EnvStatusBanner ui={envUi} onRetry={() => void retryEnv()} />
      {view === 'home' ? (
        <HomePage />
      ) : (
        <WorkspacePage isSessionPersistenceReady={isSessionPersistenceReady} />
      )}
      <SettingsPage open={isSettingsOpen} onClose={closeSettings} />
      <ConnectorApprovalDialog />
      <ComputeApprovalDialog />
      <UpdateDialog />
      <CloseConfirmModal />
      <DataRootMissingDialog
        open={missingDataRoot !== undefined}
        dataRoot={missingDataRoot ?? ''}
        onResolved={() => setMissingDataRoot(undefined)}
      />
      {legacyMove !== undefined ? (
        <LegacyDataMoveDialog
          currentDataRoot={legacyMove.currentDataRoot}
          defaultParent={legacyMove.defaultParent}
          onDismiss={() => setLegacyMove(undefined)}
        />
      ) : null}
    </>
  )
}

export default App
