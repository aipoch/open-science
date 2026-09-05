// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  // Captures the onOpenSession listener so tests can fire the notification nudge directly.
  const notificationNudgeBox: { current: (() => void) | undefined } = { current: undefined }
  const sideChatRelayBox: { current: ((event: unknown) => void) | undefined } = {
    current: undefined
  }
  type NavigationState = { view: 'home' | 'workspace'; userNavigationRevision: number }
  const navigationListeners = new Set<
    (state: NavigationState, previousState: NavigationState) => void
  >()

  return {
    settings: {
      isLoaded: false,
      isLoading: false,
      loadError: undefined as string | undefined,
      onboardingCompletedAt: undefined as number | undefined,
      isSettingsOpen: false,
      isSettingsLoaded: true,
      pendingApprovals: [] as unknown[],
      pendingCredentialRequests: [] as unknown[],
      enqueueApproval: vi.fn(),
      dismissApproval: vi.fn(),
      enqueueCredentialRequest: vi.fn(),
      dismissCredentialRequest: vi.fn(),
      load: vi.fn().mockResolvedValue(true),
      checkEnvironment: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
      closeSettings: vi.fn()
    },
    skillImport: { enqueue: vi.fn(), dismiss: vi.fn(), pending: [] as unknown[] },
    compute: {
      enqueueApproval: vi.fn(),
      dismissApproval: vi.fn(),
      pendingApprovals: [] as unknown[],
      jobsList: vi.fn().mockResolvedValue([]),
      jobsPendingNotification: vi.fn().mockResolvedValue([]),
      jobsMarkConsumed: vi.fn().mockResolvedValue(undefined),
      jobsTransitionAnalysis: vi.fn().mockResolvedValue([])
    },
    runtimeSendMessage: vi.fn(async (input: { sessionId?: string; messageId?: string }) => ({
      sessionId: input.sessionId ?? 'session-1',
      messageId: input.messageId ?? 'analysis-message'
    })),
    runtimeCancelRun: vi.fn(async () => undefined),
    navigation: { view: 'home' as 'home' | 'workspace', userNavigationRevision: 0 },
    sessions: [] as Array<{ id: string } & Record<string, unknown>>,
    appendRoutedUserMessage: vi.fn(),
    sideChatRelayBox,
    environment: {
      ui: { state: 'idle' },
      init: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined)
    },
    preview: {
      fileDialogItem: undefined as unknown | undefined,
      expandedToolItemId: null as string | null,
      activeItemId: undefined as string | undefined,
      panelState: 'collapsed' as 'open' | 'collapsed'
    },
    projects: [{ id: 'project-1', archivedAt: undefined }],
    loadProjects: vi.fn().mockResolvedValue(undefined),
    loadDeletionCleanup: vi.fn().mockResolvedValue(undefined),
    deepLinkNavigation: vi.fn(),
    lifecycleSync: vi.fn(() => ({
      notice: undefined,
      dismissNotice: vi.fn(),
      viewNotice: vi.fn()
    })),
    initUpdates: vi.fn(),
    openSessionById: vi.fn(),
    notificationNudgeBox,
    notifications: {
      onOpenSession: vi.fn((listener: () => void) => {
        notificationNudgeBox.current = listener
        return () => undefined
      }),
      peekPendingOpenSession: vi.fn().mockResolvedValue(null),
      takePendingOpenSession: vi.fn().mockResolvedValue(null)
    },
    navigationListeners,
    sessionPersistence: {
      isHydrated: true,
      isLoading: false,
      isReady: true,
      hasCompleteSessionCatalog: true,
      catalogRecovery: { kind: 'ready' } as
        | { kind: 'ready' }
        | { kind: 'repairable'; reason: 'session-scan' | 'startup-reconciliation' }
        | {
            kind: 'damaged-authority'
            affectedFiles: Array<{ projectId: string; fileName: string }>
          }
        | {
            kind: 'unsupported-version'
            affectedFileCount: number
          }
        | {
            kind: 'oversized-authority'
            affectedFiles: Array<{ projectId: string; fileName: string }>
          }
        | { kind: 'project-deletion-recovery' },
      canDeleteSessionsAndProjects: true,
      loadError: undefined as string | undefined,
      loadWarning: undefined as string | undefined,
      writeError: undefined as string | undefined,
      writeErrorRetryable: true,
      persistenceBlockedSessionIds: [] as string[],
      reportSessionSizeLimit: vi.fn(),
      dismissLoadWarning: vi.fn(),
      startNewConversationAfterSizeLimit: vi.fn(),
      retryLoad: vi.fn(),
      retryWrites: vi.fn()
    },
    update: {
      isDialogOpen: false,
      status: { state: 'idle' },
      closeDialog: vi.fn()
    },
    startupView: 'app' as 'app' | 'onboarding',
    getStatus: vi.fn(),
    getInfo: vi.fn(),
    onboarding: {
      props: undefined as { loadStorageInfo: () => Promise<unknown> } | undefined
    },
    syncWindowFindAppearance: vi.fn(),
    syncUnreadTaskView: vi.fn(),
    globalSearch: { props: undefined as { open: boolean } | undefined },
    homePage: { props: undefined as { onOpenGlobalSearch: () => void } | undefined },
    closeActiveModal: {
      handler: undefined as (() => 'handled' | 'close-preview' | 'close-base') | undefined
    },
    sideChatParentSessionIds: new Set<string>(),
    presentationProps: {
      closeConfirmation: undefined as { active?: boolean } | undefined,
      update: undefined as { active?: boolean } | undefined,
      computeApproval: undefined as { active?: boolean } | undefined,
      connectorApproval: undefined as { active?: boolean } | undefined,
      credentialRequest: undefined as { active?: boolean } | undefined,
      skillImportApproval: undefined as { active?: boolean } | undefined,
      workspace: undefined as
        | {
            isPreviewPresentationActive?: boolean
            persistenceBlockedSessionIds?: readonly string[]
            onSessionSizeLimit?: (sessionId: string) => void
          }
        | undefined
    }
  }
})

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  useSessionPersistence: () => mocks.sessionPersistence
}))
vi.mock('@/lib/deep-link', () => ({
  useDeepLinkNavigation: mocks.deepLinkNavigation
}))
vi.mock('@/hooks/useCloseActivePaneShortcut', () => ({
  useCloseActivePaneShortcut: (handler?: () => 'handled' | 'close-preview' | 'close-base') => {
    mocks.closeActiveModal.handler = handler
  }
}))
vi.mock('@/hooks/useLifecycleSync', () => ({
  useLifecycleSync: mocks.lifecycleSync
}))
vi.mock('@/hooks/useWindowFindAppearanceSync', () => ({
  useWindowFindAppearanceSync: mocks.syncWindowFindAppearance
}))
vi.mock('@/hooks/useUnreadTaskViewSync', () => ({
  useUnreadTaskViewSync: mocks.syncUnreadTaskView
}))
vi.mock('@/components/global-search/GlobalSearchDialog', () => ({
  GlobalSearchDialog: (props: { open: boolean }) => {
    mocks.globalSearch.props = props
    return <div data-testid="global-search" />
  }
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: Object.assign(
    <T,>(selector: (state: typeof mocks.navigation) => T): T => selector(mocks.navigation),
    // Notification navigation reaches the store imperatively (outside React) via getState().
    {
      getState: () => ({ ...mocks.navigation, openSessionById: mocks.openSessionById }),
      subscribe: (
        listener: (state: typeof mocks.navigation, previousState: typeof mocks.navigation) => void
      ) => {
        mocks.navigationListeners.add(listener)
        return () => mocks.navigationListeners.delete(listener)
      }
    }
  )
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: mocks.sessions,
      appendRoutedUserMessage: mocks.appendRoutedUserMessage
    }),
    subscribe: vi.fn(() => vi.fn())
  }
}))
vi.mock('@/stores/notebook-env-store', () => ({
  useNotebookEnvStore: <T,>(selector: (state: typeof mocks.environment) => T): T =>
    selector(mocks.environment)
}))
vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: <T,>(selector: (state: typeof mocks.preview) => T): T =>
    selector(mocks.preview)
}))
vi.mock('@/stores/compute-store', () => ({
  useComputeStore: <T,>(selector: (state: typeof mocks.compute) => T): T => selector(mocks.compute)
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: <T,>(
    selector: (state: {
      projects: typeof mocks.projects
      loadProjects: typeof mocks.loadProjects
      loadDeletionCleanup: typeof mocks.loadDeletionCleanup
    }) => T
  ): T =>
    selector({
      projects: mocks.projects,
      loadProjects: mocks.loadProjects,
      loadDeletionCleanup: mocks.loadDeletionCleanup
    })
}))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: <T,>(selector: (state: typeof mocks.settings) => T): T =>
    selector(mocks.settings)
}))
vi.mock('@/stores/skill-import-store', () => ({
  useSkillImportStore: <T,>(selector: (state: typeof mocks.skillImport) => T): T =>
    selector(mocks.skillImport)
}))
vi.mock('@/stores/update-store', () => {
  const getState = (): typeof mocks.update & { init: typeof mocks.initUpdates } => ({
    init: mocks.initUpdates,
    ...mocks.update
  })
  return {
    useUpdateStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof getState>) => T): T => selector(getState()),
      { getState }
    )
  }
})
vi.mock('@/pages/onboarding/startup-gate', () => ({
  resolveStartupView: vi.fn(() => mocks.startupView)
}))

vi.mock('@/components/CloseConfirmModal', () => ({
  CloseConfirmModal: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.closeConfirmation = props
    return <div data-testid="close-confirm" />
  }
}))
vi.mock('@/components/DataRootMissingDialog', () => ({
  DataRootMissingDialog: ({
    open,
    dataRoot
  }: {
    open: boolean
    dataRoot: string
  }): React.JSX.Element => <div data-testid="missing-root">{open ? dataRoot : 'closed'}</div>
}))
vi.mock('@/components/LegacyDataMoveDialog', () => ({
  LegacyDataMoveDialog: ({ currentDataRoot }: { currentDataRoot: string }): React.JSX.Element => (
    <div data-testid="legacy-move">{currentDataRoot}</div>
  )
}))
vi.mock('@/components/LifecycleToast', () => ({
  LifecycleToast: (): React.JSX.Element => <div data-testid="lifecycle-toast" />
}))
vi.mock('@/components/ConnectorAuthToast', () => ({
  ConnectorAuthToast: (): React.JSX.Element => <div data-testid="connector-auth-toast" />
}))
vi.mock('@/components/NotificationLiveToast', () => ({
  NotificationLiveToast: (): React.JSX.Element => <div data-testid="notification-live-toast" />
}))
vi.mock('@/components/UpdateDialog', () => ({
  UpdateDialog: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.update = props
    return <div data-testid="update-dialog" />
  }
}))
vi.mock('@/components/PermissionUndoSnackbar', () => ({
  PermissionUndoSnackbar: (): React.JSX.Element => <div data-testid="permission-undo" />
}))
vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  WorkspaceAgentRuntimeProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useWorkspaceAgentRuntime: () => ({
    pendingPermissions: [],
    promptInFlightSessionIds: [],
    sendPreparationInFlightSessionIds: [],
    saveAsSkillInFlightSessionIds: [],
    sendMessage: mocks.runtimeSendMessage,
    cancelRun: mocks.runtimeCancelRun
  })
}))
vi.mock('@/pages/home/HomePage', () => ({
  HomePage: ({
    canDeleteProjects,
    hasCompleteSessionCatalog,
    onOpenGlobalSearch
  }: {
    canDeleteProjects: boolean
    hasCompleteSessionCatalog: boolean
    onOpenGlobalSearch: () => void
  }): React.JSX.Element => {
    mocks.homePage.props = { onOpenGlobalSearch }
    return (
      <div
        data-testid="home-page"
        data-can-delete-projects={String(canDeleteProjects)}
        data-has-complete-session-catalog={String(hasCompleteSessionCatalog)}
      />
    )
  }
}))
vi.mock('@/pages/onboarding/OnboardingWizard', () => ({
  OnboardingWizard: (props: { loadStorageInfo: () => Promise<unknown> }): React.JSX.Element => {
    mocks.onboarding.props = props
    return <div data-testid="onboarding-page" />
  }
}))
vi.mock('@/pages/settings/ConnectorApprovalDialog', () => ({
  ConnectorApprovalDialog: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.connectorApproval = props
    return <div data-testid="approval-dialog" />
  }
}))
vi.mock('@/pages/settings/ConnectorCredentialDialog', () => ({
  ConnectorCredentialDialog: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.credentialRequest = props
    return <div data-testid="credential-dialog" />
  }
}))
vi.mock('@/pages/settings/SkillImportApprovalDialog', () => ({
  SkillImportApprovalDialog: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.skillImportApproval = props
    return <div data-testid="skill-import-dialog" />
  }
}))
vi.mock('@/pages/settings/ComputeApprovalDialog', () => ({
  ComputeApprovalDialog: (props: { active?: boolean }): React.JSX.Element => {
    mocks.presentationProps.computeApproval = props
    return <div data-testid="compute-approval-dialog" />
  }
}))
vi.mock('@/pages/settings/SettingsPage', () => ({
  SettingsPage: ({
    open,
    onOpenSession
  }: {
    open: boolean
    onOpenSession?: (sessionId: string) => void
  }): React.JSX.Element => (
    <div>
      <span data-testid="settings-page">{open ? 'open' : 'closed'}</span>
      <button
        type="button"
        data-testid="open-settings-session"
        onClick={() => onOpenSession?.('settings-session')}
      >
        Open settings session
      </button>
    </div>
  )
}))
vi.mock('@/pages/workspace/EnvStatusBanner', () => ({
  EnvStatusBanner: ({ onRetry }: { onRetry?: () => void }): React.JSX.Element => (
    <button type="button" data-testid="env-banner" onClick={onRetry} />
  )
}))
vi.mock('@/pages/workspace/WorkspacePage', () => ({
  WorkspacePage: ({
    isSessionPersistenceReady,
    persistenceBlockedSessionIds,
    onSessionSizeLimit,
    canDeleteConversations,
    isPreviewPresentationActive
  }: {
    isSessionPersistenceReady: boolean
    persistenceBlockedSessionIds?: readonly string[]
    onSessionSizeLimit?: (sessionId: string) => void
    canDeleteConversations: boolean
    isPreviewPresentationActive?: boolean
  }): React.JSX.Element => (
    <div
      ref={() => {
        mocks.presentationProps.workspace = {
          isPreviewPresentationActive,
          persistenceBlockedSessionIds,
          onSessionSizeLimit
        }
      }}
      data-testid="workspace-page"
      data-ready={String(isSessionPersistenceReady)}
      data-can-delete-conversations={String(canDeleteConversations)}
    />
  )
}))
vi.mock('@/pages/workspace/use-side-chat-controller', () => ({
  SideChatProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useOpenSideChatParentSessionIds: (): ReadonlySet<string> => mocks.sideChatParentSessionIds
}))

import { useStorageInfoStore } from '@/stores/storage-info-store'
import App from './App'

describe('App startup routing', () => {
  let container: HTMLDivElement
  let root: Root
  let canvasContextSpy: { mockRestore: () => void }

  beforeEach(() => {
    useStorageInfoStore.setState({
      status: null,
      info: null,
      scannedAt: null,
      isLoading: false,
      isRefreshing: false,
      loadError: undefined
    })
    canvasContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => null)
    container = document.createElement('div')
    document.body.appendChild(container)
    mocks.settings.isLoaded = false
    mocks.settings.isLoading = false
    mocks.settings.loadError = undefined
    mocks.settings.onboardingCompletedAt = undefined
    mocks.settings.isSettingsOpen = false
    mocks.settings.load.mockReset().mockResolvedValue(true)
    mocks.settings.checkEnvironment.mockReset().mockResolvedValue(undefined)
    mocks.settings.openSettings.mockClear()
    mocks.settings.closeSettings.mockClear()
    mocks.settings.enqueueApproval.mockClear()
    mocks.settings.dismissApproval.mockClear()
    mocks.settings.enqueueCredentialRequest.mockClear()
    mocks.settings.dismissCredentialRequest.mockClear()
    mocks.skillImport.enqueue.mockClear()
    mocks.skillImport.dismiss.mockClear()
    mocks.compute.enqueueApproval.mockClear()
    mocks.compute.dismissApproval.mockClear()
    mocks.compute.jobsList.mockClear()
    mocks.compute.jobsPendingNotification.mockClear()
    mocks.compute.jobsMarkConsumed.mockClear()
    mocks.compute.jobsTransitionAnalysis.mockClear()
    mocks.runtimeSendMessage.mockClear()
    mocks.runtimeCancelRun.mockReset().mockResolvedValue(undefined)
    mocks.navigation.view = 'home'
    mocks.startupView = 'app'
    mocks.sessionPersistence.isReady = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.hasCompleteSessionCatalog = true
    mocks.sessionPersistence.catalogRecovery = { kind: 'ready' }
    mocks.sessionPersistence.canDeleteSessionsAndProjects = true
    mocks.sessionPersistence.loadError = undefined
    mocks.sessionPersistence.loadWarning = undefined
    mocks.sessionPersistence.writeError = undefined
    mocks.sessionPersistence.writeErrorRetryable = true
    mocks.sessionPersistence.persistenceBlockedSessionIds = []
    mocks.sessionPersistence.reportSessionSizeLimit.mockClear()
    mocks.update.isDialogOpen = false
    mocks.update.status.state = 'idle'
    mocks.update.closeDialog.mockClear()
    mocks.sessionPersistence.dismissLoadWarning.mockClear()
    mocks.sessionPersistence.startNewConversationAfterSizeLimit.mockClear()
    mocks.sessionPersistence.retryLoad.mockClear()
    mocks.sessionPersistence.retryWrites.mockClear()
    mocks.settings.pendingApprovals = []
    mocks.settings.pendingCredentialRequests = []
    mocks.compute.pendingApprovals = []
    mocks.skillImport.pending = []
    mocks.preview.fileDialogItem = undefined
    mocks.preview.expandedToolItemId = null
    mocks.preview.activeItemId = undefined
    mocks.preview.panelState = 'collapsed'
    mocks.deepLinkNavigation.mockClear()
    mocks.lifecycleSync.mockClear()
    mocks.environment.init.mockClear()
    mocks.environment.retry.mockClear()
    mocks.syncWindowFindAppearance.mockClear()
    mocks.syncUnreadTaskView.mockClear()
    const storageStatus = {
      dataRoot: '/workspace/OpenScience',
      isDefault: true,
      defaultDataRoot: '/workspace/OpenScience',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      defaultParent: '/workspace'
    }
    mocks.getStatus.mockReset().mockResolvedValue(storageStatus)
    mocks.getInfo.mockReset().mockResolvedValue({
      ...storageStatus,
      usage: { categories: [], totalBytes: 0 },
      availableBytes: 1_000_000_000
    })
    mocks.onboarding.props = undefined
    window.api = {
      storage: { getStatus: mocks.getStatus, getInfo: mocks.getInfo },
      settings: {
        onConnectorApprovalRequest: vi.fn(() => vi.fn()),
        onConnectorApprovalSettled: vi.fn(() => vi.fn()),
        replayPendingConnectorApprovals: vi.fn().mockResolvedValue(undefined),
        onConnectorCredentialRequest: vi.fn(() => vi.fn()),
        onConnectorCredentialSettled: vi.fn(() => vi.fn()),
        replayPendingConnectorCredentialRequests: vi.fn().mockResolvedValue(undefined),
        onSkillImportApprovalRequest: vi.fn(() => vi.fn()),
        onSkillImportApprovalSettled: vi.fn(() => vi.fn()),
        replayPendingSkillImportApprovals: vi.fn().mockResolvedValue(undefined)
      },
      notifications: mocks.notifications,
      sessions: {
        openRecoveryFolder: vi.fn().mockResolvedValue(undefined)
      },
      compute: {
        onApprovalRequest: vi.fn(() => vi.fn()),
        onApprovalSettled: vi.fn(() => vi.fn()),
        replayPendingApprovals: vi.fn().mockResolvedValue(undefined),
        onJobUpdated: vi.fn(() => vi.fn()),
        jobsList: mocks.compute.jobsList,
        jobsPendingNotification: mocks.compute.jobsPendingNotification,
        jobsMarkConsumed: mocks.compute.jobsMarkConsumed,
        jobsTransitionAnalysis: mocks.compute.jobsTransitionAnalysis,
        enabledHostsSet: vi.fn(() => Promise.resolve())
      },
      permissions: { onChanged: vi.fn(() => vi.fn()) },
      sideChat: {
        onRelayDelivered: vi.fn((listener: (event: unknown) => void) => {
          mocks.sideChatRelayBox.current = listener
          return vi.fn()
        })
      }
    } as unknown as Window['api']
    mocks.openSessionById.mockReset()
    mocks.sessions = []
    mocks.navigation.view = 'home'
    mocks.navigation.userNavigationRevision = 0
    mocks.navigationListeners.clear()
    mocks.notifications.onOpenSession.mockClear()
    mocks.notifications.peekPendingOpenSession.mockReset().mockResolvedValue(null)
    mocks.notifications.takePendingOpenSession.mockReset().mockResolvedValue(null)
    mocks.notificationNudgeBox.current = undefined
    mocks.sideChatRelayBox.current = undefined
    mocks.appendRoutedUserMessage.mockClear()
    mocks.globalSearch.props = undefined
    mocks.homePage.props = undefined
    mocks.closeActiveModal.handler = undefined
    mocks.sideChatParentSessionIds.clear()
    for (const key of Object.keys(mocks.presentationProps) as Array<
      keyof typeof mocks.presentationProps
    >) {
      mocks.presentationProps[key] = undefined
    }
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root?.unmount())
    canvasContextSpy.mockRestore()
    container.remove()
  })

  const render = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => root.render(<App />))
  }

  it('hydrates the persisted non-terminal Compute Job projection at app startup', async () => {
    mocks.settings.isLoaded = true
    await render()

    expect(mocks.compute.jobsList).toHaveBeenCalledWith({ nonTerminal: true })
  })

  it('retries global Compute Job activity hydration after a transient startup failure', async () => {
    vi.useFakeTimers()
    mocks.settings.isLoaded = true
    mocks.compute.jobsList
      .mockRejectedValueOnce(new Error('main process unavailable'))
      .mockResolvedValueOnce([])

    await render()
    await act(async () => Promise.resolve())
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(mocks.compute.jobsList).toHaveBeenCalledTimes(2)
    expect(mocks.compute.jobsList).toHaveBeenLastCalledWith({ nonTerminal: true })
  })

  it('keeps the remote-job analysis owner active while Home is presented', async () => {
    mocks.settings.isLoaded = true
    mocks.sessions = [
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Background Session',
        cwd: '/workspace/project-1',
        status: 'idle',
        messages: [],
        conversationGraph: {
          activeFrameId: 'frame-1',
          frames: [{ id: 'frame-1', activeBranchId: 'branch-1' }]
        },
        createdAt: 1,
        updatedAt: 1
      }
    ]
    mocks.compute.jobsPendingNotification.mockResolvedValueOnce([
      {
        job_id: 'job-1',
        provider_id: 'ssh:cluster',
        display_name: 'Cluster',
        shape: 'direct_ssh',
        session_id: 'session-1',
        status: 'success',
        intent: 'Analyze results',
        created_at: 1,
        started_at: 2,
        finished_at: 3,
        exit_code: 0,
        error_code: undefined,
        remote_workdir: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        notified_at: 4,
        notification_consumed_at: undefined
      }
    ])

    await render()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
    expect(mocks.compute.jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })
    expect(mocks.runtimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        requireExistingSession: true,
        attribution: expect.objectContaining({ feature: 'compute' })
      })
    )
  })

  it('opens Settings with Cmd/Ctrl+, after startup is interactive', async () => {
    await render()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )
    expect(mocks.settings.openSettings).not.toHaveBeenCalled()

    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    await act(async () => root.render(<App />))

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )
    expect(mocks.settings.openSettings).not.toHaveBeenCalled()

    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.loadError = 'saved conversations unavailable'
    await act(async () => root.render(<App />))

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', ctrlKey: true, cancelable: true })
    )
    expect(mocks.settings.openSettings).not.toHaveBeenCalled()

    mocks.sessionPersistence.isHydrated = true
    await act(async () => root.render(<App />))

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', ctrlKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).toHaveBeenCalledTimes(2)
  })

  it('toggles global search with Cmd/Ctrl+K after startup is interactive', async () => {
    mocks.settings.isLoaded = true
    await render()

    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      )
    })
    expect(mocks.globalSearch.props?.open).toBe(true)

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true })
      )
    })
    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()
  })

  it('opens the same global search from the Home header action', async () => {
    mocks.settings.isLoaded = true
    await render()

    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()

    await act(async () => mocks.homePage.props?.onOpenGlobalSearch())

    expect(mocks.globalSearch.props?.open).toBe(true)
  })

  it('does not open Settings over global search', async () => {
    mocks.settings.isLoaded = true
    await render()

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      )
    })
    expect(mocks.globalSearch.props?.open).toBe(true)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).not.toHaveBeenCalled()

    act(() => {
      expect(mocks.closeActiveModal.handler?.()).toBe('handled')
    })
    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()
  })

  it('does not open Settings over an active dialog', async () => {
    mocks.settings.isLoaded = true
    await render()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).not.toHaveBeenCalled()
    dialog.remove()
  })

  it('does not open global search from a shortcut or Home action over an active dialog', async () => {
    mocks.settings.isLoaded = true
    await render()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      )
      mocks.homePage.props?.onOpenGlobalSearch()
    })

    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()
    dialog.remove()
  })

  it('activates only the highest-priority pending approval and resumes the next one', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isSettingsOpen = true
    mocks.settings.pendingApprovals = [{ id: 'connector', sessionId: 'connector-session' }]
    mocks.compute.pendingApprovals = [{ id: 'compute', sessionId: 'compute-session' }]
    mocks.skillImport.pending = [{ id: 'skill', sessionId: 'skill-session' }]
    await render()

    expect(mocks.presentationProps.computeApproval?.active).toBe(true)
    expect(mocks.presentationProps.connectorApproval?.active).toBe(false)
    expect(mocks.presentationProps.skillImportApproval?.active).toBe(false)
    expect(container.querySelector('[data-testid="settings-page"]')?.textContent).toBe('closed')
    expect(
      container.querySelector('[data-testid="home-page"]')?.closest('[aria-hidden="true"]')
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="lifecycle-toast"]')?.closest('[aria-hidden="true"]')
    ).not.toBeNull()
    expect(
      container
        .querySelector('[data-testid="connector-auth-toast"]')
        ?.closest('[aria-hidden="true"]')
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="permission-undo"]')?.closest('[aria-hidden="true"]')
    ).not.toBeNull()

    mocks.compute.pendingApprovals = []
    await act(async () => root.render(<App />))

    expect(mocks.presentationProps.computeApproval?.active).toBe(false)
    expect(mocks.presentationProps.connectorApproval?.active).toBe(true)
    expect(mocks.presentationProps.skillImportApproval?.active).toBe(false)
  })

  it('keeps Session credential recovery in the workspace and reserves the dialog for sessionless calls', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.settings.pendingCredentialRequests = [
      { id: 'credential', connectorId: 'openalex', sessionId: 'session-1' }
    ]
    await render()

    expect(mocks.presentationProps.credentialRequest?.active).toBe(false)
    expect(mocks.presentationProps.workspace?.isPreviewPresentationActive).toBe(true)

    mocks.settings.pendingCredentialRequests = [{ id: 'credential', connectorId: 'openalex' }]
    await act(async () => root.render(<App />))

    expect(mocks.presentationProps.credentialRequest?.active).toBe(true)
    expect(mocks.presentationProps.workspace?.isPreviewPresentationActive).toBe(false)
  })

  it('does not let Side Chat-owned approvals block workspace visibility or global search', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.sideChatParentSessionIds.add('side-chat-session')
    mocks.compute.pendingApprovals = [{ id: 'compute', sessionId: 'side-chat-session' }]
    await render()

    expect(mocks.presentationProps.computeApproval?.active).toBe(false)
    expect(mocks.presentationProps.workspace?.isPreviewPresentationActive).toBe(true)
    expect(mocks.syncUnreadTaskView).toHaveBeenLastCalledWith({
      isSessionContentVisible: true
    })

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      )
    })

    expect(mocks.globalSearch.props?.open).toBe(true)
  })

  it('consumes the close shortcut while a decision-required approval is active', async () => {
    mocks.settings.isLoaded = true
    mocks.compute.pendingApprovals = [{ id: 'compute', sessionId: 'compute-session' }]
    await render()

    expect(mocks.closeActiveModal.handler?.()).toBe('handled')
    expect(mocks.update.closeDialog).not.toHaveBeenCalled()
  })

  it('ignores a closed dialog portal when opening Settings', async () => {
    mocks.settings.isLoaded = true
    await render()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.state = 'closed'
    document.body.appendChild(dialog)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    dialog.remove()
    expect(mocks.settings.openSettings).toHaveBeenCalledOnce()
  })

  it('closes the update dialog before underlying surfaces', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isSettingsOpen = true
    mocks.update.isDialogOpen = true
    await render()

    act(() => {
      expect(mocks.closeActiveModal.handler?.()).toBe('handled')
    })

    expect(mocks.update.closeDialog).toHaveBeenCalledOnce()
    expect(mocks.settings.closeSettings).not.toHaveBeenCalled()
  })

  it('dispatches the close-pane Escape to an open Context window dialog', async () => {
    mocks.settings.isLoaded = true
    await render()
    const dialog = document.createElement('div')
    dialog.dataset.slot = 'context-window-dialog'
    dialog.dataset.state = 'open'
    const onKeyDown = vi.fn()
    dialog.addEventListener('keydown', onKeyDown)
    document.body.appendChild(dialog)

    act(() => {
      expect(mocks.closeActiveModal.handler?.()).toBe('handled')
    })

    expect(onKeyDown).toHaveBeenCalledOnce()
    expect((onKeyDown.mock.calls[0]?.[0] as KeyboardEvent).key).toBe('Escape')
    dialog.remove()
  })

  it('does not open global search while a file preview modal is open', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.preview.fileDialogItem = { id: 'previewed-file' }
    await render()

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      )
    })

    expect(document.querySelector('[data-testid="global-search"]')).toBeNull()
  })

  it('routes the close shortcut directly to the owned file preview modal', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.preview.fileDialogItem = { id: 'previewed-file' }
    const previewDialog = document.createElement('div')
    previewDialog.setAttribute('role', 'dialog')
    previewDialog.dataset.slot = 'file-preview-dialog'
    document.body.appendChild(previewDialog)
    await render()

    expect(mocks.closeActiveModal.handler?.()).toBe('close-preview')
    previewDialog.remove()
  })

  it('does not open Settings under the active expanded preview modal', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.preview.expandedToolItemId = 'project-files'
    mocks.preview.activeItemId = 'project-files'
    mocks.preview.panelState = 'open'
    await render()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).not.toHaveBeenCalled()
  })

  it('does not open Settings under a Streamdown fullscreen viewer', async () => {
    mocks.settings.isLoaded = true
    await render()
    const fullscreen = document.createElement('div')
    fullscreen.dataset.streamdown = 'table-fullscreen'
    document.body.appendChild(fullscreen)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    fullscreen.remove()
    expect(mocks.settings.openSettings).not.toHaveBeenCalled()
  })

  it('ignores a stale expansion after another preview becomes active', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.preview.expandedToolItemId = 'project-files'
    mocks.preview.activeItemId = 'paper'
    mocks.preview.panelState = 'open'
    await render()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).toHaveBeenCalledOnce()
  })

  it('ignores stale workspace preview modals when opening Settings from Home', async () => {
    mocks.settings.isLoaded = true
    mocks.preview.fileDialogItem = { id: 'previewed-file' }
    mocks.preview.expandedToolItemId = 'project-files'
    await render()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    )

    expect(mocks.settings.openSettings).toHaveBeenCalledOnce()
  })

  it('shows startup progress until settings have loaded', async () => {
    await render()

    const shell = container.querySelector('[data-testid="settings-startup-loading"]')
    expect(shell).not.toBeNull()
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('bg-background')).toBe(true)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
    const logo = shell?.querySelector<HTMLCanvasElement>(
      'canvas[data-testid="open-science-logo-loader"]'
    )
    expect(logo).not.toBeNull()
    expect(logo?.getAttribute('aria-hidden')).toBe('true')
    expect(container.textContent).toContain('Loading settings')
    expect(mocks.syncWindowFindAppearance).toHaveBeenCalledTimes(1)
  })

  it('renders Home while existing-user runtime probes continue', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isLoading = true
    mocks.startupView = 'app'

    await render()

    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="settings-startup-loading"]')).toBeNull()
  })

  it('keeps first-run onboarding behind runtime initialization', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isLoading = true
    mocks.startupView = 'onboarding'

    await render()

    expect(container.querySelector('[data-testid="settings-startup-loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="onboarding-page"]')).toBeNull()
  })

  it('shows a settings load error in the standard error notice and retries initialization', async () => {
    mocks.settings.loadError = 'settings IPC unavailable'
    mocks.settings.load.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await render()

    const shell = container.querySelector('[role="alert"]')
    expect(shell?.textContent).toContain('settings IPC unavailable')
    expect(shell?.querySelector('section > svg[aria-hidden="true"]')).not.toBeNull()
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
    expect(mocks.settings.checkEnvironment).not.toHaveBeenCalled()

    const retry = container.querySelector<HTMLButtonElement>('button')
    expect(retry).not.toBeNull()
    expect(retry?.dataset.slot).toBe('button')
    expect(retry?.className).toContain('focus-visible:ring-3')
    expect(retry?.className).toContain('disabled:pointer-events-none')
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(mocks.settings.load).toHaveBeenCalledTimes(2)
    expect(mocks.settings.load).toHaveBeenLastCalledWith({ force: true })
    expect(mocks.settings.checkEnvironment).toHaveBeenCalledOnce()
  })

  it('waits for session hydration before enabling deep-link navigation', async () => {
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isReady = false

    await render()

    expect(mocks.deepLinkNavigation).toHaveBeenCalledWith({
      isHydrated: false,
      isReady: false
    })
  })

  it('allows navigation and target-validated deletion after a partial session load', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isReady = false
    mocks.sessionPersistence.hasCompleteSessionCatalog = false
    mocks.sessionPersistence.catalogRecovery = { kind: 'repairable', reason: 'session-scan' }
    mocks.sessionPersistence.canDeleteSessionsAndProjects = true

    await render()

    expect(mocks.lifecycleSync).toHaveBeenCalledWith({
      isSessionPersistenceHydrated: true
    })
    expect(mocks.deepLinkNavigation).toHaveBeenCalledWith({
      isHydrated: true,
      isReady: false
    })
    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset.canDeleteProjects
    ).toBe('true')
    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset
        .hasCompleteSessionCatalog
    ).toBe('false')
  })

  it('disables deletion when Project deletion recovery is incomplete', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isReady = false
    mocks.sessionPersistence.canDeleteSessionsAndProjects = false
    mocks.sessionPersistence.catalogRecovery = { kind: 'project-deletion-recovery' }

    await render()

    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset.canDeleteProjects
    ).toBe('false')
    expect(container.textContent).toContain('Project recovery needs attention')
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="session-persistence-retry"]')
        ?.textContent
    ).toBe('Retry recovery')
  })

  it('renders the partial session recovery alert on an opaque semantic surface', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isReady = false
    mocks.sessionPersistence.loadError = 'one saved conversation could not be read'
    mocks.sessionPersistence.catalogRecovery = { kind: 'repairable', reason: 'session-scan' }

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.classList.contains('bg-card')).toBe(true)
    expect(alert?.classList.contains('bg-bg-000')).toBe(false)
    expect(alert?.classList.contains('bg-bg-100')).toBe(false)
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
  })

  it('reloads projects after a partial session load is retried successfully', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isReady = false
    mocks.loadProjects.mockClear()

    await render()

    expect(mocks.loadProjects).toHaveBeenCalledOnce()

    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    await act(async () => root.render(<App />))

    expect(mocks.loadProjects).toHaveBeenCalledOnce()

    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.isReady = true
    await act(async () => root.render(<App />))

    expect(mocks.loadProjects).toHaveBeenCalledTimes(2)
  })

  it('reports that the conversation is hidden while Settings covers the workspace', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isSettingsOpen = true
    mocks.navigation.view = 'workspace'

    await render()

    expect(mocks.syncUnreadTaskView).toHaveBeenLastCalledWith({
      isSessionContentVisible: false
    })
  })

  it('closes Settings only after remembered-session navigation completes', async () => {
    mocks.settings.isLoaded = true
    mocks.settings.isSettingsOpen = true
    let resumeNavigation: (() => void) | undefined
    mocks.openSessionById.mockImplementation(
      (_sessionId: string, _origin: string, afterNavigate?: () => void) => {
        resumeNavigation = afterNavigate
        return false
      }
    )
    await render()

    const openSession = container.querySelector<HTMLButtonElement>(
      '[data-testid="open-settings-session"]'
    )
    await act(async () => openSession?.click())

    expect(mocks.openSessionById).not.toHaveBeenCalled()
    expect(mocks.settings.closeSettings).not.toHaveBeenCalled()

    mocks.sessions = [{ id: 'settings-session' }]
    await act(async () => openSession?.click())

    expect(mocks.openSessionById).toHaveBeenCalledWith(
      'settings-session',
      'user',
      expect.any(Function)
    )
    expect(mocks.settings.closeSettings).not.toHaveBeenCalled()

    act(() => resumeNavigation?.())

    expect(mocks.settings.closeSettings).toHaveBeenCalledOnce()
  })

  it('reports retained session content as hidden during retry loading and hard failure', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.sessions = [{ id: 'session-retained' }]

    await render()

    expect(mocks.syncUnreadTaskView).toHaveBeenLastCalledWith({
      isSessionContentVisible: true
    })

    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    await act(async () => root.render(<App />))

    expect(mocks.syncUnreadTaskView).toHaveBeenLastCalledWith({
      isSessionContentVisible: false
    })

    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.loadError = 'saved conversations unavailable'
    await act(async () => root.render(<App />))

    expect(mocks.syncUnreadTaskView).toHaveBeenLastCalledWith({
      isSessionContentVisible: false
    })
  })

  it('routes first-run users to onboarding after settings hydration', async () => {
    mocks.settings.isLoaded = true
    mocks.startupView = 'onboarding'

    await render()

    expect(container.querySelector('[data-testid="onboarding-page"]')).not.toBeNull()
    const envBanner = container.querySelector<HTMLButtonElement>('[data-testid="env-banner"]')
    expect(envBanner).not.toBeNull()
    await act(async () => envBanner?.click())
    expect(mocks.environment.retry).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull()
  })

  it('uses lightweight storage status at startup and defers the full scan to onboarding', async () => {
    mocks.settings.isLoaded = true
    mocks.startupView = 'onboarding'

    await render()
    expect(mocks.getStatus).toHaveBeenCalledOnce()
    expect(mocks.getInfo).not.toHaveBeenCalled()

    await act(async () => {
      await mocks.onboarding.props?.loadStorageInfo()
    })

    expect(mocks.getInfo).toHaveBeenCalledOnce()
  })

  it('allows onboarding to retry a failed deferred storage scan', async () => {
    mocks.settings.isLoaded = true
    mocks.startupView = 'onboarding'
    mocks.getInfo.mockRejectedValueOnce(new Error('storage unavailable'))

    await render()

    await expect(mocks.onboarding.props?.loadStorageInfo()).rejects.toThrow('storage unavailable')
    await act(async () => {
      await mocks.onboarding.props?.loadStorageInfo()
    })

    expect(mocks.getStatus).toHaveBeenCalledOnce()
    expect(mocks.getInfo).toHaveBeenCalledTimes(2)
  })

  it('falls back to legacy getInfo when storage status is unavailable', async () => {
    mocks.settings.isLoaded = true
    mocks.startupView = 'onboarding'
    mocks.getStatus.mockRejectedValueOnce(
      new Error("No handler registered for 'storage:get-status'")
    )
    mocks.getInfo.mockResolvedValue({
      dataRoot: '/workspace/OpenScience',
      isDefault: true,
      defaultDataRoot: '/workspace/OpenScience',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      defaultParent: '/workspace',
      usage: { categories: [], totalBytes: 0 },
      availableBytes: 1_000_000_000
    })

    await render()
    await act(async () => {
      await mocks.onboarding.props?.loadStorageInfo()
    })

    expect(mocks.getStatus).toHaveBeenCalledOnce()
    expect(mocks.getInfo).toHaveBeenCalledOnce()
  })

  it('continues the startup animation while the initial session snapshot loads', async () => {
    await render()

    const settingsLogo = container.querySelector<HTMLCanvasElement>(
      '[data-testid="settings-startup-loading"] canvas[data-testid="open-science-logo-loader"]'
    )
    expect(settingsLogo).not.toBeNull()

    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    await act(async () => root.render(<App />))

    const shell = container.querySelector('[data-testid="session-persistence-startup-loading"]')
    expect(shell).not.toBeNull()
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
    expect(
      shell?.querySelector<HTMLCanvasElement>('canvas[data-testid="open-science-logo-loader"]')
    ).toBe(settingsLogo)
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull()
  })

  it('loads startup services and renders Home with the shared overlays', async () => {
    mocks.settings.isLoaded = true

    await render()

    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="env-banner"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="settings-page"]')?.textContent).toBe('closed')
    expect(mocks.initUpdates).toHaveBeenCalled()
    expect(mocks.environment.init).toHaveBeenCalled()
    expect(mocks.loadProjects).toHaveBeenCalled()
    expect(mocks.loadDeletionCleanup).toHaveBeenCalled()
    expect(mocks.settings.load).toHaveBeenCalled()
    expect(mocks.settings.checkEnvironment).toHaveBeenCalled()
    expect(mocks.getStatus).toHaveBeenCalled()
    expect(window.api.permissions.onChanged).toHaveBeenCalledOnce()
  })

  it('projects delivered Side chat relays even while Home owns the route', async () => {
    mocks.settings.isLoaded = true
    await render()

    act(() => {
      mocks.sideChatRelayBox.current?.({
        parentSessionId: 'main-1',
        projectId: 'project-1',
        message: {
          id: 'relay-1',
          content: 'Use black.',
          createdAt: 10,
          responseToMessageId: 'prompt-1',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' }
        }
      })
    })

    expect(mocks.appendRoutedUserMessage).toHaveBeenCalledWith({
      sessionId: 'main-1',
      messageId: 'relay-1',
      eventId: 'side-chat-delivered:relay-1',
      content: 'Use black.',
      createdAt: 10,
      responseToMessageId: 'prompt-1',
      relayedFrom: { kind: 'side-chat', direction: 'to-main' }
    })
  })

  it('surfaces a session load failure with a retry action', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isReady = false
    mocks.sessionPersistence.loadError = 'sessions directory unavailable'

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert?.textContent).toContain('sessions directory unavailable')
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull()
    const shell = container.querySelector('[data-testid="session-persistence-startup-error"]')
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )
    expect(retry?.dataset.slot).toBe('button')
    expect(retry?.className).toContain('focus-visible:ring-3')
    retry?.click()
    expect(mocks.sessionPersistence.retryLoad).toHaveBeenCalledOnce()
  })

  it('warns that in-memory conversation changes are not durable and retries them', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.writeError =
      'Open Science could not save the latest conversation changes. Retry before closing the app.'

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert?.textContent).toContain('Conversation storage needs attention')
    expect(alert?.textContent).toContain(
      'Open Science could not save the latest conversation changes. Retry before closing the app.'
    )
    expect(alert?.textContent).not.toContain('could not confirm')

    container.querySelector<HTMLButtonElement>('[data-testid="session-persistence-retry"]')?.click()
    expect(mocks.sessionPersistence.retryWrites).toHaveBeenCalledOnce()
  })

  it('offers a new conversation instead of retrying a Session size-limit failure', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.sessionPersistence.writeError =
      'This conversation exceeded the 256 MiB storage limit. Its current run was stopped. Start a new conversation to keep working. Changes after the last successful save are not durable.'
    mocks.sessionPersistence.writeErrorRetryable = false
    mocks.sessionPersistence.persistenceBlockedSessionIds = ['session-1']

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert?.textContent).toContain('Conversation storage limit reached')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()

    container
      .querySelector<HTMLButtonElement>('[data-testid="session-persistence-action"]')
      ?.click()
    expect(mocks.sessionPersistence.startNewConversationAfterSizeLimit).toHaveBeenCalledOnce()
    expect(mocks.presentationProps.workspace?.persistenceBlockedSessionIds).toEqual(['session-1'])
    mocks.presentationProps.workspace?.onSessionSizeLimit?.('session-plan')
    expect(mocks.sessionPersistence.reportSessionSizeLimit).toHaveBeenCalledWith('session-plan')
  })

  it('stops a persistence-blocked active run while the Home page is visible', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'home'
    mocks.sessions = [
      {
        id: 'session-1',
        status: 'running',
        activeRun: { promptMessageId: 'message-1', startedAt: 1 }
      }
    ]
    mocks.sessionPersistence.persistenceBlockedSessionIds = ['session-1']
    mocks.runtimeCancelRun
      .mockRejectedValueOnce(new Error('transient cancellation failure'))
      .mockResolvedValueOnce(undefined)

    await render()

    await vi.waitFor(() => expect(mocks.runtimeCancelRun).toHaveBeenCalledTimes(2))
    expect(container.querySelector('[data-testid="home-page"]')).toBeTruthy()
  })

  it('keeps failed writes retryable while catalog recovery is visible', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.hasCompleteSessionCatalog = false
    mocks.sessionPersistence.catalogRecovery = { kind: 'repairable', reason: 'session-scan' }
    mocks.sessionPersistence.writeError =
      'Open Science could not save the latest conversation changes. Retry before closing the app.'

    await render()

    const alerts = Array.from(
      container.querySelectorAll('[data-testid="session-persistence-alert"]')
    )
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.textContent).toContain('Project index needs repair')
    expect(alerts[1]?.textContent).toContain('Conversation storage needs attention')

    const retries = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="session-persistence-retry"]')
    )
    const repairIndex = retries.find((button) => button.textContent === 'Repair index')
    const retryWrites = retries.find((button) => button.textContent === 'Retry')
    repairIndex?.click()
    retryWrites?.click()
    expect(mocks.sessionPersistence.retryLoad).toHaveBeenCalledOnce()
    expect(mocks.sessionPersistence.retryWrites).toHaveBeenCalledOnce()
  })

  it('reports quarantined corrupt conversation files without blocking healthy sessions', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.hasCompleteSessionCatalog = false
    mocks.sessionPersistence.catalogRecovery = {
      kind: 'damaged-authority',
      affectedFiles: [{ projectId: 'project-1', fileName: 'session-1.json' }]
    }
    mocks.sessionPersistence.loadWarning =
      '1 saved conversation file was damaged and moved aside. The remaining conversations were loaded.'

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert?.textContent).toContain('Project archive needs attention')
    expect(alert?.textContent).toContain('A damaged saved conversation was moved aside')
    expect(alert?.textContent).toContain('You can still permanently delete the project')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-dismiss"]'
    )
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss storage warning')
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset
        .hasCompleteSessionCatalog
    ).toBe('false')

    await act(async () => dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('[data-testid="session-persistence-alert"]')).toBeNull()
    expect(container.textContent).not.toContain('saved conversation file was damaged')
    expect(container.querySelector('[data-testid="home-page"]')).not.toBeNull()
    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset
        .hasCompleteSessionCatalog
    ).toBe('false')
  })

  it('recovers pending Skill import approvals after the renderer starts', async () => {
    const pending = {
      id: 'approval-recovered',
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'recovered.skill' },
      previews: [],
      skipped: []
    }
    window.api.settings.onSkillImportApprovalRequest = vi.fn((listener) => {
      window.api.settings.replayPendingSkillImportApprovals = vi.fn(async () => listener(pending))
      return () => undefined
    })

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.api.settings.replayPendingSkillImportApprovals).toHaveBeenCalledOnce()
    expect(mocks.skillImport.enqueue).toHaveBeenCalledWith(pending)
  })

  it('recovers and settles pending Connector and Compute approvals after the renderer starts', async () => {
    const connector = {
      id: 'connector-recovered',
      connector: 'pubmed',
      method: 'search',
      argsPreview: '{}'
    }
    const compute = {
      id: 'compute-recovered',
      provider_id: 'ssh:cluster',
      provider_name: 'Cluster',
      shape: 'direct_ssh',
      intent: 'Inspect the host',
      command_preview: 'pwd',
      command_full: 'pwd'
    }
    let connectorRequestListener: ((request: typeof connector) => void) | undefined
    let connectorSettledListener: ((id: string) => void) | undefined
    let computeRequestListener: ((request: typeof compute) => void) | undefined
    let computeSettledListener: ((id: string) => void) | undefined

    window.api.settings.onConnectorApprovalRequest = vi.fn((listener) => {
      connectorRequestListener = listener
      return () => undefined
    })
    window.api.settings.onConnectorApprovalSettled = vi.fn((listener) => {
      connectorSettledListener = listener
      return () => undefined
    })
    window.api.settings.replayPendingConnectorApprovals = vi.fn(async () => {
      connectorRequestListener?.(connector)
    })
    window.api.compute.onApprovalRequest = vi.fn((listener) => {
      computeRequestListener = listener
      return () => undefined
    })
    window.api.compute.onApprovalSettled = vi.fn((listener) => {
      computeSettledListener = listener
      return () => undefined
    })
    window.api.compute.replayPendingApprovals = vi.fn(async () => {
      computeRequestListener?.(compute)
    })

    await render()
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.api.settings.replayPendingConnectorApprovals).toHaveBeenCalledOnce()
    expect(window.api.compute.replayPendingApprovals).toHaveBeenCalledOnce()
    expect(mocks.settings.enqueueApproval).toHaveBeenCalledWith(connector)
    expect(mocks.compute.enqueueApproval).toHaveBeenCalledWith(compute)

    act(() => {
      connectorSettledListener?.(connector.id)
      computeSettledListener?.(compute.id)
    })
    expect(mocks.settings.dismissApproval).toHaveBeenCalledWith(connector.id)
    expect(mocks.compute.dismissApproval).toHaveBeenCalledWith(compute.id)
  })

  it('waits for persisted settings before checking the selected agent environment', async () => {
    let resolveSettings: ((loaded: boolean) => void) | undefined
    mocks.settings.load.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSettings = resolve
        })
    )

    await render()

    expect(mocks.settings.load).toHaveBeenCalledOnce()
    expect(mocks.settings.checkEnvironment).not.toHaveBeenCalled()

    await act(async () => resolveSettings?.(true))

    expect(mocks.settings.checkEnvironment).toHaveBeenCalledOnce()
  })

  it('renders Workspace and exposes a missing data-root recovery dialog', async () => {
    mocks.settings.isLoaded = true
    mocks.navigation.view = 'workspace'
    mocks.getStatus.mockResolvedValue({
      dataRoot: '/Volumes/Science/OpenScience',
      dataRootMissing: true,
      legacyDataMovePrompt: false,
      defaultParent: '/Users/example'
    })

    await render()

    expect(
      container.querySelector<HTMLElement>('[data-testid="workspace-page"]')?.dataset.ready
    ).toBe('true')
    expect(
      container.querySelector<HTMLElement>('[data-testid="workspace-page"]')?.dataset
        .canDeleteConversations
    ).toBe('true')
    expect(container.querySelector('[data-testid="missing-root"]')?.textContent).toBe(
      '/Volumes/Science/OpenScience'
    )
  })

  it('exposes missing data-root recovery while saved conversations are still hydrating', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    mocks.getStatus.mockResolvedValue({
      dataRoot: '/Volumes/Science/OpenScience',
      dataRootMissing: true,
      legacyDataMovePrompt: false,
      defaultParent: '/Users/example'
    })

    await render()

    expect(container.querySelector('[data-testid="missing-root"]')?.textContent).toBe(
      '/Volumes/Science/OpenScience'
    )
    expect(
      container.querySelector('[data-testid="session-persistence-startup-loading"]')
    ).toBeNull()
  })

  it('retains a notification target until recovery completes', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockResolvedValue({ sessionId: 's-9', token: 9 })
    mocks.notifications.takePendingOpenSession.mockResolvedValue({ sessionId: 's-9', token: 9 })

    await render()

    // Sessions still hydrating: the pending click target must not be consumed or dropped.
    expect(mocks.openSessionById).not.toHaveBeenCalled()

    // Partial hydration cannot prove an absent target was deleted, so only the non-destructive peek
    // runs and the target stays pending in main until a complete retry.
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    await act(async () => root.render(<App />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalled()
    expect(mocks.notifications.takePendingOpenSession).not.toHaveBeenCalled()
    expect(mocks.openSessionById).not.toHaveBeenCalled()

    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    await act(async () => root.render(<App />))

    mocks.sessions = [{ id: 's-9' }]
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.isReady = true
    await act(async () => root.render(<App />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(9)
    expect(mocks.openSessionById).toHaveBeenCalledWith('s-9', 'notification')
  })

  it('opens an already-hydrated notification target during partial recovery', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isReady = false
    mocks.sessions = [{ id: 's-3' }]

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    mocks.notifications.peekPendingOpenSession.mockResolvedValue({ sessionId: 's-3', token: 3 })
    mocks.notifications.takePendingOpenSession.mockResolvedValue({ sessionId: 's-3', token: 3 })
    const nudge = mocks.notificationNudgeBox.current
    expect(nudge).toBeDefined()

    await act(async () => {
      nudge?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(3)
    expect(mocks.openSessionById).toHaveBeenCalledWith('s-3', 'notification')
  })

  it('explains when a desktop-notification target is no longer available', async () => {
    mocks.settings.isLoaded = true
    mocks.notifications.peekPendingOpenSession.mockResolvedValue({ sessionId: 's-gone', token: 4 })
    mocks.notifications.takePendingOpenSession.mockResolvedValue({ sessionId: 's-gone', token: 4 })

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(4)
    expect(mocks.openSessionById).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This session was deleted or is unavailable.')
  })

  it('explains a quit canceled by a Session persistence conflict and offers retry', async () => {
    let notifyFlushAborted: (event: { reason: 'conflict' }) => void = () => undefined
    ;(
      window.api as unknown as {
        sessions: {
          onFlushAborted: (listener: typeof notifyFlushAborted) => () => void
          onFlushRequest: (listener: (request: { requestId: string }) => void) => () => void
          sendFlushResponse: (response: { requestId: string; status: string }) => void
        }
      }
    ).sessions = {
      onFlushAborted: (listener) => {
        notifyFlushAborted = listener
        return () => undefined
      },
      onFlushRequest: () => () => undefined,
      sendFlushResponse: vi.fn()
    }
    mocks.settings.isLoaded = true

    await render()
    act(() => notifyFlushAborted({ reason: 'conflict' }))

    expect(container.textContent).toContain('Quit was canceled')
    expect(container.textContent).toContain(
      'A conversation changed elsewhere and could not be saved safely.'
    )

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )
    act(() => retry?.click())
    expect(mocks.sessionPersistence.retryWrites).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Quit was canceled')
  })

  it('keeps quit recovery controls interactive while Settings covers the base presentation', async () => {
    let notifyFlushAborted: (event: { reason: 'renderer-failed' }) => void = () => undefined
    ;(
      window.api as unknown as {
        sessions: {
          onFlushAborted: (listener: typeof notifyFlushAborted) => () => void
          onFlushRequest: (listener: (request: { requestId: string }) => void) => () => void
          sendFlushResponse: (response: { requestId: string; status: string }) => void
        }
      }
    ).sessions = {
      onFlushAborted: (listener) => {
        notifyFlushAborted = listener
        return () => undefined
      },
      onFlushRequest: () => () => undefined,
      sendFlushResponse: vi.fn()
    }
    mocks.settings.isLoaded = true
    mocks.settings.isSettingsOpen = true
    mocks.sessionPersistence.loadError = 'selected conversation unavailable'

    await render()
    act(() => notifyFlushAborted({ reason: 'renderer-failed' }))

    const alert = Array.from(
      container.querySelectorAll('[data-testid="session-persistence-alert"]')
    ).find((candidate) => candidate.textContent?.includes('Quit was canceled'))
    expect(alert?.textContent).toContain('Quit was canceled')
    expect(alert?.closest('[inert]')).toBeNull()
    expect(alert?.closest('[aria-hidden="true"]')).toBeNull()
    expect(alert?.classList.contains('z-toast')).toBe(true)
  })

  it('does not let a later notification peek override navigation while an earlier peek is pending', async () => {
    const target = { sessionId: 's-3', token: 3 }
    let pending: typeof target | null = target
    let resolveFirstPeek: ((value: typeof target | null) => void) | undefined
    let peekCount = 0
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockImplementation(() => {
      peekCount += 1
      if (peekCount === 1) {
        return new Promise((resolve) => {
          resolveFirstPeek = resolve
        })
      }
      return Promise.resolve(pending ? { ...pending } : null)
    })
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()
    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalledOnce()

    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.userNavigationRevision += 1
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
    })

    mocks.sessions = [{ id: target.sessionId }]
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.isReady = true
    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(mocks.openSessionById).not.toHaveBeenCalled()

    await act(async () => resolveFirstPeek?.(target))
    expect(mocks.openSessionById).not.toHaveBeenCalled()
  })

  it('runs a queued notification peek after persistence becomes ready', async () => {
    const target = { sessionId: 's-3', token: 3 }
    let pending: typeof target | null = target
    let resolveFirstPeek: ((value: typeof target | null) => void) | undefined
    let peekCount = 0
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockImplementation(() => {
      peekCount += 1
      if (peekCount === 1) {
        return new Promise((resolve) => {
          resolveFirstPeek = resolve
        })
      }
      return Promise.resolve(pending ? { ...pending } : null)
    })
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()

    mocks.sessions = [{ id: target.sessionId }]
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.isReady = true
    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })

    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalledOnce()

    await act(async () => {
      resolveFirstPeek?.(target)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalledTimes(2)
    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(target.token)
    expect(mocks.openSessionById).toHaveBeenCalledWith(target.sessionId, 'notification')
  })

  it('does not let a pre-navigation queued task discard a later notification click', async () => {
    const target = { sessionId: 's-new', token: 7 }
    let pending: typeof target | null = null
    let resolveFirstPeek: ((value: typeof target | null) => void) | undefined
    let peekCount = 0
    mocks.settings.isLoaded = true
    mocks.sessions = [{ id: target.sessionId }]
    mocks.notifications.peekPendingOpenSession.mockImplementation(() => {
      peekCount += 1
      if (peekCount === 1) {
        return new Promise((resolve) => {
          resolveFirstPeek = resolve
        })
      }
      return Promise.resolve(pending ? { ...pending } : null)
    })
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()
    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalledOnce()

    const nudge = mocks.notificationNudgeBox.current
    nudge?.()
    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.userNavigationRevision += 1
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
    })

    pending = target
    nudge?.()
    await act(async () => {
      resolveFirstPeek?.(null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(target.token)
    expect(mocks.openSessionById).toHaveBeenCalledWith(target.sessionId, 'notification')
  })

  it('does not let a notification queued before navigation override that navigation', async () => {
    const target = { sessionId: 's-old', token: 6 }
    let pending: typeof target | null = null
    let resolveFirstPeek: ((value: typeof target | null) => void) | undefined
    let peekCount = 0
    mocks.settings.isLoaded = true
    mocks.sessions = [{ id: target.sessionId }]
    mocks.notifications.peekPendingOpenSession.mockImplementation(() => {
      peekCount += 1
      if (peekCount === 1) {
        return new Promise((resolve) => {
          resolveFirstPeek = resolve
        })
      }
      return Promise.resolve(pending ? { ...pending } : null)
    })
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()
    expect(mocks.notifications.peekPendingOpenSession).toHaveBeenCalledOnce()

    pending = target
    mocks.notificationNudgeBox.current?.()
    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.userNavigationRevision += 1
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
      resolveFirstPeek?.(null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(target.token)
    expect(mocks.openSessionById).not.toHaveBeenCalled()
  })

  it('discards a deferred notification when the user navigates elsewhere', async () => {
    let pending: { sessionId: string; token: number } | null = { sessionId: 's-3', token: 3 }
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockImplementation(async () => pending)
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).not.toHaveBeenCalled()

    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.userNavigationRevision += 1
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(3)

    mocks.sessions = [{ id: 's-3' }]
    mocks.sessionPersistence.isReady = true
    await act(async () => root.render(<App />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.openSessionById).not.toHaveBeenCalled()
  })

  it('does not consume a newer same-session click while clearing a deferred target', async () => {
    let pending: { sessionId: string; token: number } | null = { sessionId: 's-3', token: 1 }
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockImplementation(async () =>
      pending ? { ...pending } : null
    )
    mocks.notifications.takePendingOpenSession.mockImplementation(async (token: number) => {
      if (pending?.token !== token) return null
      const consumed = pending
      pending = null
      return consumed
    })

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    pending = { sessionId: 's-3', token: 2 }

    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.userNavigationRevision += 1
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(1)
    expect(pending).toEqual({ sessionId: 's-3', token: 2 })
  })

  it('retains a deferred notification across automatic navigation redirects', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isReady = false
    mocks.notifications.peekPendingOpenSession.mockResolvedValue({ sessionId: 's-4', token: 4 })
    mocks.notifications.takePendingOpenSession.mockResolvedValue({ sessionId: 's-4', token: 4 })

    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await act(async () => {
      const previousNavigation = { ...mocks.navigation }
      mocks.navigation.view = 'workspace'
      for (const listener of mocks.navigationListeners) {
        listener(mocks.navigation, previousNavigation)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).not.toHaveBeenCalled()

    mocks.sessions = [{ id: 's-4' }]
    mocks.sessionPersistence.isReady = true
    await act(async () => root.render(<App />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.notifications.takePendingOpenSession).toHaveBeenCalledWith(4)
    expect(mocks.openSessionById).toHaveBeenCalledWith('s-4', 'notification')
  })
})
