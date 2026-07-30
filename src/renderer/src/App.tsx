import { useCallback, useEffect, useRef, useState } from 'react'

import type { OpenSessionFromNotificationRequest } from '../../shared/notifications'

import { useDeepLinkNavigation } from '@/lib/deep-link'
import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { LifecycleToast } from '@/components/LifecycleToast'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { UpdateDialog } from '@/components/UpdateDialog'
import { Button } from '@/components/ui/button'
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
import { useUnreadTaskViewSync } from '@/hooks/useUnreadTaskViewSync'
import { useWindowFindAppearanceSync } from '@/hooks/useWindowFindAppearanceSync'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionStore } from '@/stores/session-store'
import { useComputeStore } from '@/stores/compute-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSkillImportStore } from '@/stores/skill-import-store'
import { useUpdateStore } from '@/stores/update-store'

type NotificationOpenIntent = {
  generation: number
  userNavigationRevision: number
}

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
  const hasConnectorApproval = useSettingsStore((state) => state.pendingApprovals.length > 0)
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const enqueueApproval = useSettingsStore((state) => state.enqueueApproval)
  const enqueueComputeApproval = useComputeStore((state) => state.enqueueApproval)
  const hasComputeApproval = useComputeStore((state) => state.pendingApprovals.length > 0)
  const enqueueSkillImport = useSkillImportStore((state) => state.enqueue)
  const dismissSkillImport = useSkillImportStore((state) => state.dismiss)
  const hasSkillImportApproval = useSkillImportStore((state) => state.pending.length > 0)
  const applyJobUpdate = useSessionJobStore((state) => state.applyUpdate)
  const initUpdates = useUpdateStore((state) => state.init)
  const isUpdateDialogOpen = useUpdateStore((state) => state.isDialogOpen)
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
  const deferredNotification = useRef<OpenSessionFromNotificationRequest | undefined>(undefined)
  const pendingNotificationOpenQueue = useRef<Promise<void>>(Promise.resolve())
  const notificationOpenIntent = useRef<NotificationOpenIntent>({
    generation: 0,
    userNavigationRevision: useNavigationStore.getState().userNavigationRevision
  })
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false)
  const startupView = isSettingsLoaded
    ? resolveStartupView({ onboardingDone: onboardingCompletedAt !== undefined })
    : undefined

  const retrySettingsInitialization = useCallback(async (): Promise<void> => {
    if (await loadSettings({ force: true })) await checkEnvironment()
  }, [checkEnvironment, loadSettings])

  // Only acknowledge a conversation when no app-level gate covers the workspace. The hook performs
  // the remaining navigation/session/DOM checks before main is allowed to clear its unread marker.
  const isSessionContentVisible =
    isSessionPersistenceHydrated &&
    !isSessionPersistenceLoading &&
    startupView === 'app' &&
    view === 'workspace' &&
    !isSettingsOpen &&
    !hasConnectorApproval &&
    !hasComputeApproval &&
    !hasSkillImportApproval &&
    !isUpdateDialogOpen &&
    !isCloseConfirmOpen &&
    missingDataRoot === undefined &&
    legacyMove === undefined

  useUnreadTaskViewSync({ isSessionContentVisible })

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
  // Main retains the target until this renderer confirms that the inspected session can be opened,
  // so a click that recreates the window or lands during partial recovery is not lost.
  const openPendingNotificationSession = useCallback(
    (intent: NotificationOpenIntent = notificationOpenIntent.current): Promise<void> => {
      const attempt = async (): Promise<void> => {
        // A newer click owns the main-process token. Let its queued attempt observe it instead of
        // allowing older recovery work to consume or discard that newer intent.
        if (intent.generation !== notificationOpenIntent.current.generation) return

        const pending = await window.api.notifications.peekPendingOpenSession()

        if (!pending) return
        if (intent.generation !== notificationOpenIntent.current.generation) return

        const sessionExists =
          isSessionPersistenceHydrated &&
          useSessionStore.getState().sessions.some((session) => session.id === pending.sessionId)

        if (!sessionExists && !isSessionPersistenceReady) {
          if (
            useNavigationStore.getState().userNavigationRevision === intent.userNavigationRevision
          ) {
            const deferred = deferredNotification.current
            if (!deferred || pending.token > deferred.token) deferredNotification.current = pending
          } else {
            // The user navigated while the peek was in flight. Drop only the stale target we saw; a
            // newer notification that replaced it remains pending in main.
            await window.api.notifications.takePendingOpenSession(pending.token)
          }
          return
        }

        const consumed = await window.api.notifications.takePendingOpenSession(pending.token)

        if (!consumed) return

        if (deferredNotification.current?.token === consumed.token) {
          deferredNotification.current = undefined
        }

        // A navigation after this attempt began takes precedence over the older notification click.
        if (
          intent.generation !== notificationOpenIntent.current.generation ||
          !sessionExists ||
          useNavigationStore.getState().userNavigationRevision !== intent.userNavigationRevision
        ) {
          return
        }

        useNavigationStore.getState().openSessionById(consumed.sessionId, 'notification')
      }

      // Dependency changes and push nudges can request the same pending target concurrently. Serialize
      // peeks, keep each attempt paired with the navigation state of its causal click, and let a newer
      // click generation supersede older queued recovery work.
      pendingNotificationOpenQueue.current = pendingNotificationOpenQueue.current.then(
        attempt,
        attempt
      )
      return pendingNotificationOpenQueue.current
    },
    [isSessionPersistenceHydrated, isSessionPersistenceReady]
  )

  // If a missing target is waiting for a persistence retry, explicit navigation transfers control
  // to the user. Conditionally consume that old target so recovery cannot yank them back later.
  useEffect(
    () =>
      useNavigationStore.subscribe((state, previousState) => {
        if (state.userNavigationRevision === previousState.userNavigationRevision) return

        const deferred = deferredNotification.current

        if (!deferred) return

        deferredNotification.current = undefined
        void window.api.notifications.takePendingOpenSession(deferred.token)
      }),
    []
  )

  // Fast path: a click while this renderer is alive arrives as a nudge. Already-hydrated targets
  // open during partial recovery; unresolved ones remain pending for the retry path below.
  useEffect(
    () =>
      window.api.notifications.onOpenSession(() => {
        const intent = {
          generation: notificationOpenIntent.current.generation + 1,
          userNavigationRevision: useNavigationStore.getState().userNavigationRevision
        }
        notificationOpenIntent.current = intent
        void openPendingNotificationSession(intent)
      }),
    [openPendingNotificationSession]
  )

  // Slow path: the click recreated the window before this listener existed. Peek immediately so
  // navigation during initial loading can dismiss it, then recheck after every hydration pass; a
  // partial snapshot may still open targets that it did load.
  useEffect(() => {
    void openPendingNotificationSession()
  }, [openPendingNotificationSession])

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
          className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
            <h1 className="text-base font-semibold text-foreground">
              Settings could not be loaded
            </h1>
            <p className="mt-2 break-words text-sm text-muted-foreground">{settingsLoadError}</p>
            <Button
              type="button"
              variant="outline"
              data-testid="settings-startup-retry"
              disabled={isSettingsLoading}
              onClick={() => void retrySettingsInitialization()}
              className="mt-4"
            >
              {isSettingsLoading ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </main>
      )
    }

    return (
      <main
        data-testid="settings-startup-loading"
        role="status"
        className="flex min-h-svh items-center justify-center bg-background text-foreground"
      >
        <span className="text-sm text-muted-foreground">Loading settings…</span>
      </main>
    )
  }

  if (startupView === 'onboarding') {
    return <OnboardingWizard />
  }

  if (!isSessionPersistenceHydrated && isSessionPersistenceLoading) {
    return (
      <main
        data-testid="session-persistence-startup-loading"
        role="status"
        className="flex min-h-svh items-center justify-center bg-background text-foreground"
      >
        <span className="text-sm text-muted-foreground">Loading saved conversations…</span>
      </main>
    )
  }

  // A hard load failure leaves no trustworthy session snapshot. Keep the interactive surfaces
  // closed until retry succeeds; partial loads set isHydrated and use the read-only alert below.
  if (!isSessionPersistenceHydrated && sessionPersistence.loadError) {
    return (
      <main
        data-testid="session-persistence-startup-error"
        className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
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
          message={sessionPersistence.writeError}
          onRetry={sessionPersistence.retryWrites}
        />
      ) : sessionPersistence.loadWarning ? (
        <SessionPersistenceAlert
          title="Saved conversation data was damaged"
          message={sessionPersistence.loadWarning}
          variant="warning"
          onDismiss={sessionPersistence.dismissLoadWarning}
        />
      ) : null}
      {view === 'home' ? (
        <HomePage
          canDeleteProjects={sessionPersistence.canDeleteSessionsAndProjects}
          hasCompleteSessionCatalog={sessionPersistence.hasCompleteSessionCatalog}
        />
      ) : (
        <WorkspacePage
          isSessionPersistenceHydrated={isSessionPersistenceHydrated}
          isSessionPersistenceReady={isSessionPersistenceReady}
          canDeleteConversations={sessionPersistence.canDeleteSessionsAndProjects}
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
      <CloseConfirmModal onOpenChange={setIsCloseConfirmOpen} />
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
