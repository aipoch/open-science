import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { OpenSessionFromNotificationRequest } from '../../../shared/notifications'
import type { WebEventConnectionPhase } from '../../../shared/web-event-connection'
import {
  resolveAppShellPresentation,
  type AppShellPresentationProjection
} from '@/app-shell-presentation-owner'
import {
  useCloseActivePaneShortcut,
  type AppShellCloseRequest
} from '@/hooks/useCloseActivePaneShortcut'
import { useLifecycleSync } from '@/hooks/useLifecycleSync'
import { useUnreadTaskViewSync } from '@/hooks/useUnreadTaskViewSync'
import { useWebEventConnection } from '@/hooks/useWebEventConnection'
import { useWindowFindAppearanceSync } from '@/hooks/useWindowFindAppearanceSync'
import { useOpenSideChatParentSessionIds } from '@/pages/workspace/use-side-chat-controller'
import type { StartupView } from '@/pages/onboarding/startup-gate'
import { useComputeStore } from '@/stores/compute-store'
import { useNavigationStore, type NavigationView } from '@/stores/navigation-store'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSkillImportStore } from '@/stores/skill-import-store'
import { useUpdateStore } from '@/stores/update-store'

type NotificationOpenIntent = {
  generation: number
  userNavigationRevision: number
}

type ApplicationEventBindingsInput = Readonly<{
  startupView: StartupView | undefined
  sessionPersistence: Readonly<{
    isHydrated: boolean
    isLoading: boolean
    isReady: boolean
  }>
  hasDataRootRecovery: boolean
  hasLegacyDataMove: boolean
  closeActiveSettingsPane: () => void
}>

type ApplicationEventProjection = Readonly<{
  presentation: AppShellPresentationProjection
  webEventConnectionPhase: WebEventConnectionPhase
  blockedApprovalSessionIds: ReadonlySet<string>
  lifecycle: ReturnType<typeof useLifecycleSync>
  notification: Readonly<{
    unavailableToken: number | undefined
    dismissUnavailable: () => void
  }>
  allowsArchiveUndoShortcut: () => boolean
  navigation: Readonly<{
    view: NavigationView
  }>
  globalSearch: Readonly<{
    open: () => void
    setOpen: (open: boolean) => void
  }>
  closeConfirmation: Readonly<{
    setOpen: (open: boolean) => void
  }>
  settings: Readonly<{
    close: () => void
    openSession: (sessionId: string) => void
  }>
}>

// Owns renderer-lifetime subscriptions, recovery ordering, and root interaction bindings. Callers
// receive only the event-driven projection needed to render the App Shell.
const useApplicationEventBindings = ({
  startupView,
  sessionPersistence,
  hasDataRootRecovery,
  hasLegacyDataMove,
  closeActiveSettingsPane
}: ApplicationEventBindingsInput): ApplicationEventProjection => {
  const openSideChatParentSessionIds = useOpenSideChatParentSessionIds()
  const view = useNavigationStore((state) => state.view)
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const hasConnectorApproval = useSettingsStore((state) =>
    state.pendingApprovals.some(
      (candidate) => !candidate.sessionId || !openSideChatParentSessionIds.has(candidate.sessionId)
    )
  )
  const enqueueConnectorApproval = useSettingsStore((state) => state.enqueueApproval)
  const dismissConnectorApproval = useSettingsStore((state) => state.dismissApproval)
  const hasSessionlessCredentialRequest = useSettingsStore((state) =>
    state.pendingCredentialRequests.some((request) => !request.sessionId)
  )
  const enqueueCredentialRequest = useSettingsStore((state) => state.enqueueCredentialRequest)
  const dismissCredentialRequest = useSettingsStore((state) => state.dismissCredentialRequest)
  const enqueueComputeApproval = useComputeStore((state) => state.enqueueApproval)
  const dismissComputeApproval = useComputeStore((state) => state.dismissApproval)
  const hasComputeApproval = useComputeStore((state) =>
    state.pendingApprovals.some(
      (candidate) => !candidate.sessionId || !openSideChatParentSessionIds.has(candidate.sessionId)
    )
  )
  const enqueueSkillImport = useSkillImportStore((state) => state.enqueue)
  const dismissSkillImport = useSkillImportStore((state) => state.dismiss)
  const hasSkillImportApproval = useSkillImportStore((state) =>
    state.pending.some((candidate) => !openSideChatParentSessionIds.has(candidate.sessionId))
  )
  const applyJobUpdate = useSessionJobStore((state) => state.applyUpdate)
  const hydrateNonTerminalJobs = useSessionJobStore((state) => state.hydrateNonTerminal)
  const isUpdateDialogOpen = useUpdateStore((state) => state.isDialogOpen)
  const isFilePreviewOpen = usePreviewWorkbenchStore((state) => state.fileDialogItem !== undefined)
  const isExpandedPreviewOpen = usePreviewWorkbenchStore(
    (state) => state.panelState === 'open' && state.expandedToolItemId === state.activeItemId
  )
  const listenForPermissionChanges = usePermissionGrantsStore((state) => state.listen)
  const listenForNotificationChanges = useNotificationInboxStore((state) => state.listen)
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false)
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false)
  const [unavailableNotificationToken, setUnavailableNotificationToken] = useState<number>()
  const deferredNotification = useRef<OpenSessionFromNotificationRequest | undefined>(undefined)
  const pendingNotificationOpenQueue = useRef<Promise<void>>(Promise.resolve())
  const notificationOpenIntent = useRef<NotificationOpenIntent>({
    generation: 0,
    userNavigationRevision: useNavigationStore.getState().userNavigationRevision
  })
  const lifecycle = useLifecycleSync({
    isSessionPersistenceHydrated: sessionPersistence.isHydrated
  })
  useWindowFindAppearanceSync()

  const isPreviewModalOpen = view === 'workspace' && (isFilePreviewOpen || isExpandedPreviewOpen)
  const webEventConnectionPhase = useWebEventConnection(
    startupView === 'app' && sessionPersistence.isHydrated
  )
  const presentation = useMemo(
    () =>
      resolveAppShellPresentation({
        startupView,
        isSessionPersistenceHydrated: sessionPersistence.isHydrated,
        isSessionPersistenceLoading: sessionPersistence.isLoading,
        view,
        presentations: {
          closeConfirmation: isCloseConfirmOpen,
          webEventRecovery: webEventConnectionPhase !== 'live',
          dataRootRecovery: hasDataRootRecovery,
          legacyDataMove: hasLegacyDataMove,
          update: isUpdateDialogOpen,
          computeApproval: hasComputeApproval,
          connectorApproval: hasConnectorApproval,
          credentialRequest: hasSessionlessCredentialRequest,
          skillImportApproval: hasSkillImportApproval,
          globalSearch: isGlobalSearchOpen,
          settings: isSettingsOpen,
          preview: isPreviewModalOpen
        }
      }),
    [
      hasComputeApproval,
      hasConnectorApproval,
      hasSessionlessCredentialRequest,
      hasDataRootRecovery,
      hasLegacyDataMove,
      hasSkillImportApproval,
      isCloseConfirmOpen,
      isGlobalSearchOpen,
      isPreviewModalOpen,
      isSettingsOpen,
      isUpdateDialogOpen,
      sessionPersistence.isHydrated,
      sessionPersistence.isLoading,
      startupView,
      webEventConnectionPhase,
      view
    ]
  )

  const resolveCloseRequest = useCallback((): AppShellCloseRequest => {
    const action = presentation.resolveCloseAction()
    if (action.kind === 'close-update') {
      const update = useUpdateStore.getState()
      if (update.status.state !== 'applying') update.closeDialog()
      return 'handled'
    }
    if (action.kind === 'close-global-search') {
      setIsGlobalSearchOpen(false)
      return 'handled'
    }
    if (action.kind === 'close-settings') {
      closeActiveSettingsPane()
      return 'handled'
    }
    if (action.kind === 'dismiss-dom-presentation') {
      action.target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      return 'handled'
    }
    if (action.kind === 'close-preview' || action.kind === 'close-base') return action.kind
    return 'handled'
  }, [closeActiveSettingsPane, presentation])
  useCloseActivePaneShortcut(resolveCloseRequest)
  useUnreadTaskViewSync({ isSessionContentVisible: presentation.isSessionContentVisible })

  const allowsArchiveUndoShortcut = useCallback(
    () => presentation.allowsShortcut('archiveUndo'),
    [presentation]
  )
  const openGlobalSearch = useCallback((): void => {
    if (presentation.allowsShortcut('globalSearch')) setIsGlobalSearchOpen(true)
  }, [presentation])
  const setGlobalSearchOpen = useCallback((open: boolean): void => setIsGlobalSearchOpen(open), [])
  const setCloseConfirmationOpen = useCallback(
    (open: boolean): void => setIsCloseConfirmOpen(open),
    []
  )
  const openPermissionSession = useCallback(
    (sessionId: string): void => {
      const sessionExists = useSessionStore
        .getState()
        .sessions.some((session) => session.id === sessionId)
      if (!sessionExists) return
      let completed = false
      const completeOpen = (): void => {
        if (completed) return
        completed = true
        closeSettings()
      }
      const opened = useNavigationStore.getState().openSessionById(sessionId, 'user', completeOpen)
      if (opened) completeOpen()
    },
    [closeSettings]
  )

  useEffect(() => {
    const api = window.api?.sideChat
    if (!api) return
    return api.onRelayDelivered(({ parentSessionId, message }) => {
      useSessionStore.getState().appendRoutedUserMessage({
        sessionId: parentSessionId,
        messageId: message.id,
        eventId: `side-chat-delivered:${message.id}`,
        content: message.content,
        createdAt: message.createdAt,
        responseToMessageId: message.responseToMessageId,
        relayedFrom: message.relayedFrom
      })
    })
  }, [])

  useEffect(() => {
    const openSettingsFromShortcut = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== ',' ||
        !(event.metaKey || event.ctrlKey) ||
        !presentation.allowsShortcut('settings')
      ) {
        return
      }
      event.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', openSettingsFromShortcut)
    return () => window.removeEventListener('keydown', openSettingsFromShortcut)
  }, [openSettings, presentation])

  useEffect(() => {
    const toggleGlobalSearch = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        !presentation.allowsShortcut('globalSearch')
      ) {
        return
      }
      event.preventDefault()
      setIsGlobalSearchOpen((current) => !current)
    }
    window.addEventListener('keydown', toggleGlobalSearch)
    return () => window.removeEventListener('keydown', toggleGlobalSearch)
  }, [presentation])

  useEffect(() => listenForPermissionChanges(), [listenForPermissionChanges])
  useEffect(() => listenForNotificationChanges(), [listenForNotificationChanges])

  // Listener-before-replay ordering recovers requests emitted while no renderer existed.
  useEffect(() => {
    const removeRequest = window.api.settings.onConnectorApprovalRequest(enqueueConnectorApproval)
    const removeSettled =
      window.api.settings.onConnectorApprovalSettled?.(dismissConnectorApproval) ??
      (() => undefined)
    void window.api.settings.replayPendingConnectorApprovals?.().catch(() => undefined)
    return () => {
      removeSettled()
      removeRequest()
    }
  }, [dismissConnectorApproval, enqueueConnectorApproval])

  useEffect(() => {
    const removeRequest =
      window.api.settings.onConnectorCredentialRequest?.(enqueueCredentialRequest) ??
      (() => undefined)
    const removeSettled =
      window.api.settings.onConnectorCredentialSettled?.(dismissCredentialRequest) ??
      (() => undefined)
    void window.api.settings.replayPendingConnectorCredentialRequests?.().catch(() => undefined)
    return () => {
      removeSettled()
      removeRequest()
    }
  }, [dismissCredentialRequest, enqueueCredentialRequest])

  useEffect(
    () => window.api.settings.onSkillImportApprovalRequest(enqueueSkillImport),
    [enqueueSkillImport]
  )
  useEffect(
    () => window.api.settings.onSkillImportApprovalSettled(dismissSkillImport),
    [dismissSkillImport]
  )
  useEffect(
    () =>
      window.api.settings.onChanged?.((snapshot) => {
        useSettingsStore.getState().acceptCommittedSnapshot(snapshot)
      }),
    []
  )
  useEffect(() => {
    void window.api.settings.replayPendingSkillImportApprovals()
  }, [])

  const openPendingNotificationSession = useCallback(
    (intent: NotificationOpenIntent = notificationOpenIntent.current): Promise<void> => {
      const attempt = async (): Promise<void> => {
        if (intent.generation !== notificationOpenIntent.current.generation) return
        const pending = await window.api.notifications.peekPendingOpenSession()
        if (!pending || intent.generation !== notificationOpenIntent.current.generation) return

        const sessionExists =
          sessionPersistence.isHydrated &&
          useSessionStore.getState().sessions.some((session) => session.id === pending.sessionId)
        if (!sessionExists && !sessionPersistence.isReady) {
          if (
            useNavigationStore.getState().userNavigationRevision === intent.userNavigationRevision
          ) {
            const deferred = deferredNotification.current
            if (!deferred || pending.token > deferred.token) deferredNotification.current = pending
          } else {
            await window.api.notifications.takePendingOpenSession(pending.token)
          }
          return
        }

        const consumed = await window.api.notifications.takePendingOpenSession(pending.token)
        if (!consumed) return
        if (deferredNotification.current?.token === consumed.token) {
          deferredNotification.current = undefined
        }
        if (
          intent.generation !== notificationOpenIntent.current.generation ||
          useNavigationStore.getState().userNavigationRevision !== intent.userNavigationRevision
        ) {
          return
        }
        if (!sessionExists) {
          setUnavailableNotificationToken(consumed.token)
          return
        }
        setUnavailableNotificationToken(undefined)
        useNavigationStore.getState().openSessionById(consumed.sessionId, 'notification')
      }

      pendingNotificationOpenQueue.current = pendingNotificationOpenQueue.current.then(
        attempt,
        attempt
      )
      return pendingNotificationOpenQueue.current
    },
    [sessionPersistence.isHydrated, sessionPersistence.isReady]
  )

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
  useEffect(
    () =>
      window.api.notifications.onOpenSession?.(() => {
        const intent = {
          generation: notificationOpenIntent.current.generation + 1,
          userNavigationRevision: useNavigationStore.getState().userNavigationRevision
        }
        notificationOpenIntent.current = intent
        void openPendingNotificationSession(intent)
      }),
    [openPendingNotificationSession]
  )
  useEffect(() => {
    void openPendingNotificationSession()
  }, [openPendingNotificationSession])

  useEffect(() => {
    const removeRequest = window.api.compute.onApprovalRequest(enqueueComputeApproval)
    const removeSettled =
      window.api.compute.onApprovalSettled?.(dismissComputeApproval) ?? (() => undefined)
    void window.api.compute.replayPendingApprovals?.().catch(() => undefined)
    return () => {
      removeSettled()
      removeRequest()
    }
  }, [dismissComputeApproval, enqueueComputeApproval])
  useEffect(() => window.api.compute.onJobUpdated(applyJobUpdate), [applyJobUpdate])
  useEffect(() => {
    if (startupView !== 'app' || !sessionPersistence.isHydrated) return
    let isActive = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const hydrate = (attempt = 0): void => {
      void hydrateNonTerminalJobs().catch(() => {
        if (!isActive || attempt >= 2) return
        retryTimer = setTimeout(() => hydrate(attempt + 1), 1_000 * 2 ** attempt)
      })
    }
    hydrate()
    return () => {
      isActive = false
      clearTimeout(retryTimer)
    }
  }, [hydrateNonTerminalJobs, sessionPersistence.isHydrated, startupView])

  return {
    presentation,
    webEventConnectionPhase,
    blockedApprovalSessionIds: openSideChatParentSessionIds,
    lifecycle,
    notification: {
      unavailableToken: unavailableNotificationToken,
      dismissUnavailable: () => setUnavailableNotificationToken(undefined)
    },
    allowsArchiveUndoShortcut,
    navigation: { view },
    globalSearch: { open: openGlobalSearch, setOpen: setGlobalSearchOpen },
    closeConfirmation: { setOpen: setCloseConfirmationOpen },
    settings: { close: closeSettings, openSession: openPermissionSession }
  }
}

export { useApplicationEventBindings }
export type { ApplicationEventBindingsInput, ApplicationEventProjection }
