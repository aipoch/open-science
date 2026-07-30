import { useCallback, useEffect, useState } from 'react'

import { useDeepLinkNavigation } from '@/lib/deep-link'
import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { LifecycleToast } from '@/components/LifecycleToast'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { UpdateDialog } from '@/components/UpdateDialog'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { resolveStartupView } from '@/pages/onboarding/startup-gate'
import { ComputeApprovalDialog } from '@/pages/settings/ComputeApprovalDialog'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { SkillImportApprovalDialog } from '@/pages/settings/SkillImportApprovalDialog'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import { useCloseActivePaneShortcut } from '@/hooks/useCloseActivePaneShortcut'
import { useLifecycleSync } from '@/hooks/useLifecycleSync'
import { useWindowFindAppearanceSync } from '@/hooks/useWindowFindAppearanceSync'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useComputeStore } from '@/stores/compute-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSkillImportStore } from '@/stores/skill-import-store'
import { useUpdateStore } from '@/stores/update-store'

const App = (): React.JSX.Element | null => {
  // Persistence is started once at the top so sessions stay loaded for both Home and Workspace.
  const sessionPersistence = useSessionPersistence()
  const isSessionPersistenceHydrated = sessionPersistence.isHydrated
  const isSessionPersistenceLoading = sessionPersistence.isLoading
  const isSessionPersistenceReady = sessionPersistence.isReady
  const lifecycleSync = useLifecycleSync({ isSessionPersistenceHydrated })
  useDeepLinkNavigation({
    isHydrated: isSessionPersistenceHydrated,
    isReady: isSessionPersistenceReady
  })
  const view = useNavigationStore((state) => state.view)
  // Cmd+W / Ctrl+W closes the open preview panel before it closes the window.
  useCloseActivePaneShortcut()
  useWindowFindAppearanceSync()
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded)
  const isSettingsLoading = useSettingsStore((state) => state.isLoading)
  const settingsLoadError = useSettingsStore((state) => state.loadError)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const loadSettings = useSettingsStore((state) => state.load)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const enqueueApproval = useSettingsStore((state) => state.enqueueApproval)
  const enqueueComputeApproval = useComputeStore((state) => state.enqueueApproval)
  const enqueueSkillImport = useSkillImportStore((state) => state.enqueue)
  const dismissSkillImport = useSkillImportStore((state) => state.dismiss)
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

  const retrySettingsInitialization = useCallback(async (): Promise<void> => {
    if (await loadSettings({ force: true })) await checkEnvironment()
  }, [checkEnvironment, loadSettings])

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

  useEffect(
    () => window.api.settings.onSkillImportApprovalRequest(enqueueSkillImport),
    [enqueueSkillImport]
  )
  useEffect(
    () => window.api.settings.onSkillImportApprovalSettled(dismissSkillImport),
    [dismissSkillImport]
  )
  // Main retains approval payloads while the agent tool call is parked. Ask it to replay after both
  // listeners are attached so a recreated window can recover requests emitted while no renderer
  // existed; duplicate delivery is harmless because the renderer queue is keyed by request id.
  useEffect(() => {
    void window.api.settings.replayPendingSkillImportApprovals()
  }, [])

  // Clicking a desktop notification opens the conversation the finished/failed task belongs to.
  // Main holds the target until it is pulled here, so a click that recreates the window (listener
  // not yet registered, sessions not yet hydrated) cannot lose the navigation.
  const openPendingNotificationSession = useCallback(async (): Promise<void> => {
    const pending = await window.api.notifications.takePendingOpenSession()

    if (pending) useNavigationStore.getState().openSessionById(pending.sessionId)
  }, [])

  // Fast path: a click while this renderer is alive arrives as a nudge; pull the target. A click
  // mid-recovery is left pending and consumed by the effect below once the full scan can distinguish
  // an omitted target from one that no longer exists.
  useEffect(
    () =>
      window.api.notifications.onOpenSession(() => {
        if (isSessionPersistenceReady) void openPendingNotificationSession()
      }),
    [isSessionPersistenceReady, openPendingNotificationSession]
  )

  // Slow path: the click recreated the window before this listener existed. Consume the pending
  // target only after session persistence has a complete store snapshot.
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

  // Load projects after each completed startup hydration pass. A retry temporarily clears Session
  // hydration, so its successful completion re-runs this effect and clears any project-list error
  // left by the same transient storage outage.
  useEffect(() => {
    if (!isSettingsLoaded || !isSessionPersistenceHydrated || isSessionPersistenceLoading) return

    void loadProjects()
  }, [isSessionPersistenceHydrated, isSessionPersistenceLoading, isSettingsLoaded, loadProjects])

  // Hydrate the persisted framework before checking it. Running these concurrently can make a
  // Codex/OpenCode result look stale against the renderer's initial Claude selection and discard the
  // only launch check that would surface a Home repair action.
  useEffect(() => {
    let active = true
    void loadSettings().then((loaded) => {
      if (active && loaded) void checkEnvironment()
    })

    return () => {
      active = false
    }
  }, [checkEnvironment, loadSettings])

  // Settings carry the persisted first-run marker. No environment result is awaited here: existing
  // users proceed directly to Home while the launch check runs in the background.
  if (!isSettingsLoaded) {
    if (settingsLoadError) {
      return (
        <main
          role="alert"
          className="flex h-screen items-center justify-center bg-bg-10 p-6 text-text-100"
        >
          <div className="w-full max-w-md rounded-xl border border-border-200 bg-bg-100 p-5 shadow-dialog">
            <h1 className="text-base font-semibold text-text-000">Settings could not be loaded</h1>
            <p className="mt-2 break-words text-sm text-text-300">{settingsLoadError}</p>
            <button
              type="button"
              data-testid="settings-startup-retry"
              disabled={isSettingsLoading}
              onClick={() => void retrySettingsInitialization()}
              className="mt-4 rounded-lg border border-border-200 px-3 py-1.5 text-sm font-medium text-text-000 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSettingsLoading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </main>
      )
    }

    return (
      <main
        data-testid="settings-startup-loading"
        role="status"
        className="flex h-screen items-center justify-center bg-bg-10 text-sm text-text-300"
      >
        Loading settings…
      </main>
    )
  }

  if (
    resolveStartupView({
      onboardingDone: onboardingCompletedAt !== undefined
    }) === 'onboarding'
  ) {
    return <OnboardingWizard />
  }

  if (!isSessionPersistenceHydrated && isSessionPersistenceLoading) {
    return (
      <main
        data-testid="session-persistence-startup-loading"
        role="status"
        className="flex h-screen items-center justify-center bg-bg-10 text-sm text-text-300"
      >
        Loading saved conversations…
      </main>
    )
  }

  // A hard load failure leaves no trustworthy session snapshot. Keep the interactive surfaces
  // closed until retry succeeds; partial loads set isHydrated and use the read-only alert below.
  if (!isSessionPersistenceHydrated && sessionPersistence.loadError) {
    return (
      <main
        data-testid="session-persistence-startup-error"
        className="flex h-screen items-center justify-center bg-bg-10 p-6 text-text-100"
      >
        <SessionPersistenceAlert
          title="Saved conversations could not be loaded"
          message={sessionPersistence.loadError}
          inline
          onRetry={sessionPersistence.retryLoad}
        />
      </main>
    )
  }

  return (
    <>
      <EnvStatusBanner ui={envUi} onRetry={() => void retryEnv()} />
      {sessionPersistence.loadError ? (
        <SessionPersistenceAlert
          title="Saved conversations could not be loaded"
          message={sessionPersistence.loadError}
          onRetry={sessionPersistence.retryLoad}
        />
      ) : sessionPersistence.writeError ? (
        <SessionPersistenceAlert
          title="Conversation storage needs attention"
          message={`${sessionPersistence.writeError} Open Science could not confirm that the latest changes were fully saved. Retry before closing the app.`}
          onRetry={sessionPersistence.retryWrites}
        />
      ) : sessionPersistence.loadWarning ? (
        <SessionPersistenceAlert
          title="Saved conversation data was damaged"
          message={sessionPersistence.loadWarning}
          variant="warning"
        />
      ) : null}
      {view === 'home' ? (
        <HomePage canDeleteProjects={isSessionPersistenceHydrated} />
      ) : (
        <WorkspacePage
          isSessionPersistenceHydrated={isSessionPersistenceHydrated}
          isSessionPersistenceReady={isSessionPersistenceReady}
        />
      )}
      <SettingsPage open={isSettingsOpen} onClose={closeSettings} />
      <ConnectorApprovalDialog />
      <SkillImportApprovalDialog />
      <LifecycleToast
        notice={lifecycleSync.notice}
        onDismiss={lifecycleSync.dismissNotice}
        onView={lifecycleSync.viewNotice}
      />
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
