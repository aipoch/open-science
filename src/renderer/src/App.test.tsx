// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  // Captures the onOpenSession listener so tests can fire the notification nudge directly.
  const notificationNudgeBox: { current: (() => void) | undefined } = { current: undefined }
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
      enqueueApproval: vi.fn(),
      load: vi.fn().mockResolvedValue(true),
      checkEnvironment: vi.fn().mockResolvedValue(undefined),
      closeSettings: vi.fn()
    },
    skillImport: { enqueue: vi.fn(), dismiss: vi.fn(), pending: [] as unknown[] },
    compute: { enqueueApproval: vi.fn(), pendingApprovals: [] as unknown[] },
    navigation: { view: 'home' as 'home' | 'workspace', userNavigationRevision: 0 },
    sessions: [] as Array<{ id: string }>,
    environment: {
      ui: { state: 'idle' },
      init: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined)
    },
    loadProjects: vi.fn().mockResolvedValue(undefined),
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
      canDeleteSessionsAndProjects: true,
      loadError: undefined as string | undefined,
      loadWarning: undefined as string | undefined,
      writeError: undefined as string | undefined,
      dismissLoadWarning: vi.fn(),
      retryLoad: vi.fn(),
      retryWrites: vi.fn()
    },
    startupView: 'app' as 'app' | 'onboarding',
    getInfo: vi.fn(),
    syncWindowFindAppearance: vi.fn(),
    syncUnreadTaskView: vi.fn()
  }
})

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  useSessionPersistence: () => mocks.sessionPersistence
}))
vi.mock('@/lib/deep-link', () => ({
  useDeepLinkNavigation: mocks.deepLinkNavigation
}))
vi.mock('@/hooks/useCloseActivePaneShortcut', () => ({
  useCloseActivePaneShortcut: vi.fn()
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
  useSessionStore: { getState: () => ({ sessions: mocks.sessions }) }
}))
vi.mock('@/stores/notebook-env-store', () => ({
  useNotebookEnvStore: <T,>(selector: (state: typeof mocks.environment) => T): T =>
    selector(mocks.environment)
}))
vi.mock('@/stores/compute-store', () => ({
  useComputeStore: <T,>(selector: (state: typeof mocks.compute) => T): T => selector(mocks.compute)
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: <T,>(selector: (state: { loadProjects: typeof mocks.loadProjects }) => T): T =>
    selector({ loadProjects: mocks.loadProjects })
}))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: <T,>(selector: (state: typeof mocks.settings) => T): T =>
    selector(mocks.settings)
}))
vi.mock('@/stores/skill-import-store', () => ({
  useSkillImportStore: <T,>(selector: (state: typeof mocks.skillImport) => T): T =>
    selector(mocks.skillImport)
}))
vi.mock('@/stores/update-store', () => ({
  useUpdateStore: <T,>(
    selector: (state: { init: typeof mocks.initUpdates; isDialogOpen: boolean }) => T
  ): T => selector({ init: mocks.initUpdates, isDialogOpen: false })
}))
vi.mock('@/pages/onboarding/startup-gate', () => ({
  resolveStartupView: vi.fn(() => mocks.startupView)
}))

vi.mock('@/components/CloseConfirmModal', () => ({
  CloseConfirmModal: (): React.JSX.Element => <div data-testid="close-confirm" />
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
vi.mock('@/components/UpdateDialog', () => ({
  UpdateDialog: (): React.JSX.Element => <div data-testid="update-dialog" />
}))
vi.mock('@/pages/home/HomePage', () => ({
  HomePage: ({
    canDeleteProjects,
    hasCompleteSessionCatalog
  }: {
    canDeleteProjects: boolean
    hasCompleteSessionCatalog: boolean
  }): React.JSX.Element => (
    <div
      data-testid="home-page"
      data-can-delete-projects={String(canDeleteProjects)}
      data-has-complete-session-catalog={String(hasCompleteSessionCatalog)}
    />
  )
}))
vi.mock('@/pages/onboarding/OnboardingWizard', () => ({
  OnboardingWizard: (): React.JSX.Element => <div data-testid="onboarding-page" />
}))
vi.mock('@/pages/settings/ConnectorApprovalDialog', () => ({
  ConnectorApprovalDialog: (): React.JSX.Element => <div data-testid="approval-dialog" />
}))
vi.mock('@/pages/settings/SkillImportApprovalDialog', () => ({
  SkillImportApprovalDialog: (): React.JSX.Element => <div data-testid="skill-import-dialog" />
}))
vi.mock('@/pages/settings/SettingsPage', () => ({
  SettingsPage: ({ open }: { open: boolean }): React.JSX.Element => (
    <div data-testid="settings-page">{open ? 'open' : 'closed'}</div>
  )
}))
vi.mock('@/pages/workspace/EnvStatusBanner', () => ({
  EnvStatusBanner: (): React.JSX.Element => <div data-testid="env-banner" />
}))
vi.mock('@/pages/workspace/WorkspacePage', () => ({
  WorkspacePage: ({
    isSessionPersistenceReady,
    canDeleteConversations
  }: {
    isSessionPersistenceReady: boolean
    canDeleteConversations: boolean
  }): React.JSX.Element => (
    <div
      data-testid="workspace-page"
      data-ready={String(isSessionPersistenceReady)}
      data-can-delete-conversations={String(canDeleteConversations)}
    />
  )
}))

import App from './App'

describe('App startup routing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    mocks.settings.isLoaded = false
    mocks.settings.isLoading = false
    mocks.settings.loadError = undefined
    mocks.settings.onboardingCompletedAt = undefined
    mocks.settings.isSettingsOpen = false
    mocks.settings.load.mockReset().mockResolvedValue(true)
    mocks.settings.checkEnvironment.mockReset().mockResolvedValue(undefined)
    mocks.skillImport.enqueue.mockClear()
    mocks.skillImport.dismiss.mockClear()
    mocks.navigation.view = 'home'
    mocks.startupView = 'app'
    mocks.sessionPersistence.isReady = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isLoading = false
    mocks.sessionPersistence.hasCompleteSessionCatalog = true
    mocks.sessionPersistence.canDeleteSessionsAndProjects = true
    mocks.sessionPersistence.loadError = undefined
    mocks.sessionPersistence.loadWarning = undefined
    mocks.sessionPersistence.writeError = undefined
    mocks.sessionPersistence.dismissLoadWarning.mockClear()
    mocks.sessionPersistence.retryLoad.mockClear()
    mocks.sessionPersistence.retryWrites.mockClear()
    mocks.settings.pendingApprovals = []
    mocks.compute.pendingApprovals = []
    mocks.skillImport.pending = []
    mocks.deepLinkNavigation.mockClear()
    mocks.lifecycleSync.mockClear()
    mocks.syncWindowFindAppearance.mockClear()
    mocks.syncUnreadTaskView.mockClear()
    mocks.getInfo.mockResolvedValue({
      dataRoot: '/workspace/OpenScience',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      defaultParent: '/workspace'
    })
    window.api = {
      storage: { getInfo: mocks.getInfo },
      settings: {
        onConnectorApprovalRequest: vi.fn(() => vi.fn()),
        onSkillImportApprovalRequest: vi.fn(() => vi.fn()),
        onSkillImportApprovalSettled: vi.fn(() => vi.fn()),
        replayPendingSkillImportApprovals: vi.fn().mockResolvedValue(undefined)
      },
      notifications: mocks.notifications,
      compute: {
        onApprovalRequest: vi.fn(() => vi.fn()),
        onJobUpdated: vi.fn(() => vi.fn()),
        enabledHostsSet: vi.fn(() => Promise.resolve())
      }
    } as unknown as Window['api']
    mocks.openSessionById.mockClear()
    mocks.sessions = []
    mocks.navigation.view = 'home'
    mocks.navigation.userNavigationRevision = 0
    mocks.navigationListeners.clear()
    mocks.notifications.onOpenSession.mockClear()
    mocks.notifications.peekPendingOpenSession.mockReset().mockResolvedValue(null)
    mocks.notifications.takePendingOpenSession.mockReset().mockResolvedValue(null)
    mocks.notificationNudgeBox.current = undefined
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
  })

  const render = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => root.render(<App />))
  }

  it('shows startup progress until settings have loaded', async () => {
    await render()

    const shell = container.querySelector('[data-testid="settings-startup-loading"]')
    expect(shell).not.toBeNull()
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('bg-background')).toBe(true)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
    expect(container.textContent).toContain('Loading settings')
    expect(mocks.syncWindowFindAppearance).toHaveBeenCalledTimes(1)
  })

  it('shows a settings load error and retries the complete initialization', async () => {
    mocks.settings.loadError = 'settings IPC unavailable'
    mocks.settings.load.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await render()

    const shell = container.querySelector('[role="alert"]')
    expect(shell?.textContent).toContain('settings IPC unavailable')
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
    expect(mocks.settings.checkEnvironment).not.toHaveBeenCalled()

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-startup-retry"]'
    )
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

    await render()

    expect(
      container.querySelector<HTMLElement>('[data-testid="home-page"]')?.dataset.canDeleteProjects
    ).toBe('false')
  })

  it('renders the partial session recovery alert on an opaque semantic surface', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = true
    mocks.sessionPersistence.isReady = false
    mocks.sessionPersistence.loadError = 'one saved conversation could not be read'

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
    expect(container.querySelector('[data-testid="home-page"]')).toBeNull()
  })

  it('blocks Home while the initial session snapshot is loading', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.isHydrated = false
    mocks.sessionPersistence.isLoading = true
    mocks.sessionPersistence.isReady = false

    await render()

    const shell = container.querySelector('[data-testid="session-persistence-startup-loading"]')
    expect(shell).not.toBeNull()
    expect(shell?.classList.contains('min-h-svh')).toBe(true)
    expect(shell?.classList.contains('h-screen')).toBe(false)
    expect(shell?.classList.contains('text-foreground')).toBe(true)
    expect(shell?.classList.contains('text-muted-foreground')).toBe(false)
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
    expect(mocks.settings.load).toHaveBeenCalled()
    expect(mocks.settings.checkEnvironment).toHaveBeenCalled()
    expect(mocks.getInfo).toHaveBeenCalled()
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

  it('reports quarantined corrupt conversation files without blocking healthy sessions', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistence.hasCompleteSessionCatalog = false
    mocks.sessionPersistence.loadWarning =
      '1 saved conversation file was damaged and moved aside. The remaining conversations were loaded.'

    await render()

    const alert = container.querySelector('[data-testid="session-persistence-alert"]')
    expect(alert?.textContent).toContain('Saved conversation data was damaged')
    expect(alert?.textContent).toContain('damaged and moved aside')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()
    container
      .querySelector<HTMLButtonElement>('[data-testid="session-persistence-dismiss"]')
      ?.click()
    expect(mocks.sessionPersistence.dismissLoadWarning).toHaveBeenCalledOnce()
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
      attachmentName: 'recovered.skill',
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
    mocks.getInfo.mockResolvedValue({
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
