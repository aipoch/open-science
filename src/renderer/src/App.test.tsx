// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  // Captures the onOpenSession listener so tests can fire the notification nudge directly.
  const notificationNudgeBox: { current: (() => void) | undefined } = { current: undefined }

  return {
    settings: {
      isLoaded: false,
      onboardingCompletedAt: undefined as number | undefined,
      isEnvironmentRepairOpen: false,
      isSettingsOpen: false,
      isSettingsLoaded: true,
      enqueueApproval: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      checkEnvironment: vi.fn().mockResolvedValue(undefined),
      closeSettings: vi.fn()
    },
    navigation: { view: 'home' as 'home' | 'workspace' },
    environment: {
      ui: { state: 'idle' },
      init: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined)
    },
    loadProjects: vi.fn().mockResolvedValue(undefined),
    deepLinkNavigation: vi.fn(),
    initUpdates: vi.fn(),
    openSessionById: vi.fn(),
    notificationNudgeBox,
    notifications: {
      onOpenSession: vi.fn((listener: () => void) => {
        notificationNudgeBox.current = listener
        return () => undefined
      }),
      takePendingOpenSession: vi.fn().mockResolvedValue(null)
    },
    sessionPersistenceReady: true,
    startupView: 'home' as 'home' | 'onboarding',
    getInfo: vi.fn()
  }
})

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  useSessionPersistence: () => mocks.sessionPersistenceReady
}))
vi.mock('@/lib/deep-link', () => ({
  useDeepLinkNavigation: mocks.deepLinkNavigation
}))
vi.mock('@/hooks/useCloseActivePaneShortcut', () => ({
  useCloseActivePaneShortcut: vi.fn()
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: Object.assign(
    <T,>(selector: (state: typeof mocks.navigation) => T): T => selector(mocks.navigation),
    // Notification navigation reaches the store imperatively (outside React) via getState().
    { getState: () => ({ openSessionById: mocks.openSessionById }) }
  )
}))
vi.mock('@/stores/notebook-env-store', () => ({
  useNotebookEnvStore: <T,>(selector: (state: typeof mocks.environment) => T): T =>
    selector(mocks.environment)
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: <T,>(selector: (state: { loadProjects: typeof mocks.loadProjects }) => T): T =>
    selector({ loadProjects: mocks.loadProjects })
}))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: <T,>(selector: (state: typeof mocks.settings) => T): T =>
    selector(mocks.settings)
}))
vi.mock('@/stores/update-store', () => ({
  useUpdateStore: <T,>(selector: (state: { init: typeof mocks.initUpdates }) => T): T =>
    selector({ init: mocks.initUpdates })
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
vi.mock('@/components/UpdateDialog', () => ({
  UpdateDialog: (): React.JSX.Element => <div data-testid="update-dialog" />
}))
vi.mock('@/pages/home/HomePage', () => ({
  HomePage: (): React.JSX.Element => <div data-testid="home-page" />
}))
vi.mock('@/pages/onboarding/OnboardingWizard', () => ({
  OnboardingWizard: (): React.JSX.Element => <div data-testid="onboarding-page" />
}))
vi.mock('@/pages/settings/ConnectorApprovalDialog', () => ({
  ConnectorApprovalDialog: (): React.JSX.Element => <div data-testid="approval-dialog" />
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
    isSessionPersistenceReady
  }: {
    isSessionPersistenceReady: boolean
  }): React.JSX.Element => (
    <div data-testid="workspace-page">{String(isSessionPersistenceReady)}</div>
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
    mocks.settings.onboardingCompletedAt = undefined
    mocks.settings.isEnvironmentRepairOpen = false
    mocks.settings.isSettingsOpen = false
    mocks.navigation.view = 'home'
    mocks.startupView = 'home'
    mocks.sessionPersistenceReady = true
    mocks.deepLinkNavigation.mockClear()
    mocks.getInfo.mockResolvedValue({
      dataRoot: '/workspace/OpenScience',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      defaultParent: '/workspace'
    })
    window.api = {
      storage: { getInfo: mocks.getInfo },
      settings: { onConnectorApprovalRequest: vi.fn(() => vi.fn()) },
      notifications: mocks.notifications,
      compute: {
        onApprovalRequest: vi.fn(() => vi.fn()),
        onJobUpdated: vi.fn(() => vi.fn()),
        enabledHostsSet: vi.fn(() => Promise.resolve())
      }
    } as unknown as Window['api']
    mocks.openSessionById.mockClear()
    mocks.notifications.onOpenSession.mockClear()
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

  it('keeps the shell blank until settings have loaded', async () => {
    await render()

    expect(container.innerHTML).toBe('')
  })

  it('passes session persistence readiness to deep-link navigation', async () => {
    mocks.sessionPersistenceReady = false

    await render()

    expect(mocks.deepLinkNavigation).toHaveBeenCalledWith(false)
  })

  it('routes first-run users to onboarding after settings hydration', async () => {
    mocks.settings.isLoaded = true
    mocks.startupView = 'onboarding'

    await render()

    expect(container.querySelector('[data-testid="onboarding-page"]')).not.toBeNull()
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

    expect(container.querySelector('[data-testid="workspace-page"]')?.textContent).toBe('true')
    expect(container.querySelector('[data-testid="missing-root"]')?.textContent).toBe(
      '/Volumes/Science/OpenScience'
    )
  })

  it('opens the notification-target conversation once session persistence is ready', async () => {
    mocks.settings.isLoaded = true
    mocks.sessionPersistenceReady = false
    mocks.notifications.takePendingOpenSession.mockResolvedValue({ sessionId: 's-9' })

    await render()

    // Sessions still hydrating: the pending click target must not be consumed or dropped.
    expect(mocks.openSessionById).not.toHaveBeenCalled()

    // Hydration completes: the target is pulled and the conversation opens.
    mocks.sessionPersistenceReady = true
    await act(async () => root.render(<App />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.openSessionById).toHaveBeenCalledWith('s-9')
  })

  it('opens the conversation immediately when a notification nudge arrives hydrated', async () => {
    mocks.settings.isLoaded = true
    // The mount-time pull finds nothing; the nudge-triggered pull gets the click target.
    mocks.notifications.takePendingOpenSession
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ sessionId: 's-3' })

    await render()

    const nudge = mocks.notificationNudgeBox.current
    expect(nudge).toBeDefined()
    await act(async () => {
      nudge?.()
    })

    expect(mocks.openSessionById).toHaveBeenCalledWith('s-3')
  })
})
