// Pins the preload bridge channel strings and argument forwarding for the recently-added sessions
// and agent-framework/opencode settings methods.
//
// window.api methods are thin wrappers over ipcRenderer.invoke(<channel>, ...args). The main-process
// handlers and the renderer store are tested elsewhere, but nothing else pins the exact channel
// STRINGS the preload uses — so a typo in a channel name (mismatched against the handler) would still
// pass every other suite. These tests mock electron, load the preload module, capture the object it
// exposes via contextBridge, and assert each method invokes ipcRenderer.invoke with the precise
// channel and forwards its arguments verbatim.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { invokeMock, sendMock, exposeMock, getPathForFileMock, onMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sendMock: vi.fn(),
  exposeMock: vi.fn(),
  getPathForFileMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  webUtils: { getPathForFile: getPathForFileMock },
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    off: vi.fn(),
    send: sendMock,
    removeListener: vi.fn()
  }
}))

// The subset of the bridge these tests exercise. Args are unknown — forwarding, not shape, is asserted.
type PreloadApi = {
  saveSessionArtifacts: (request: unknown) => unknown
  lifecycle: {
    getClientId: () => unknown
  }
  sessions: {
    loadAll: () => unknown
    saveSession: (session: unknown) => unknown
    deleteSession: (request: unknown) => unknown
    saveManifest: (request: unknown) => unknown
  }
  settings: {
    detectOpencode: () => unknown
    detectCodex: () => unknown
    installOpencode: (request: unknown) => unknown
    installCodex: (request: unknown) => unknown
    setAgentFramework: (request: unknown) => unknown
    setNotificationsEnabled: (request: unknown) => unknown
    setConversationSkillImportEnabled: (request: unknown) => unknown
    setClosePreference: (request: unknown) => unknown
    setAppIconVariant: (request: unknown) => unknown
    listAppIcons: () => unknown
    uninstallClaude: () => unknown
    uninstallOpencode: () => unknown
    uninstallCodex: () => unknown
    cancelCodexLogin: () => unknown
    loginIsolatedCodex: () => unknown
    logoutIsolatedCodex: () => unknown
    cancelClaudeLogin: () => unknown
    loginSharedClaude: () => unknown
    logoutSharedClaude: () => unknown
    loginIsolatedClaude: (token: string) => unknown
    loginIsolatedClaudeBrowser: () => unknown
    cancelIsolatedClaudeLogin: () => unknown
    logoutIsolatedClaude: () => unknown
    previewGitHubSkill: (request: unknown) => unknown
    previewAgentHomeSkill: (request: unknown) => unknown
  }
  acp: {
    resumeSession: (request: unknown) => unknown
    resetSessionContext: (request: unknown) => unknown
    compactSession: (request: unknown) => unknown
  }
  notifications: {
    peekPendingOpenSession: () => unknown
    takePendingOpenSession: (expectedToken: number) => unknown
    syncViewState: (state: unknown) => void
    onViewProbe: (listener: (challengeId: number) => void) => () => void
  }
  cli: {
    getStatus: () => unknown
    install: () => unknown
    uninstall: () => unknown
  }
  officePreview: {
    attachFrame: (sessionId: string) => Promise<unknown>
    reportState: (sessionId: string, state: unknown) => void
  }
  uploads: {
    stageLocalFile: (file: File, request: unknown) => Promise<unknown>
    claimLocalFile: (request: unknown) => Promise<void>
  }
  window: {
    findInPage?: (request: unknown) => void
    clearFind?: () => void
    closeFind?: () => void
    onShowWindowFind?: (
      listener: (appearance: { theme: 'light' | 'dark'; followsSystem: boolean }) => void
    ) => unknown
    onWindowFindAppearance?: (
      listener: (appearance: { theme: 'light' | 'dark'; followsSystem: boolean }) => void
    ) => unknown
    announceWindowFindAppearance?: (appearance: {
      theme: 'light' | 'dark'
      followsSystem: boolean
    }) => void
    announceWindowFindReady?: () => unknown
  }
}

let api: PreloadApi

beforeAll(async () => {
  // Take the contextBridge branch of the preload's expose logic (production path with context isolation).
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  invokeMock.mockResolvedValue(undefined)

  await import('./index')

  const exposed = exposeMock.mock.calls.find((call) => call[0] === 'api')?.[1] as
    PreloadApi | undefined
  if (!exposed) throw new Error('preload did not expose an "api" bridge')
  api = exposed
})

afterEach(() => {
  invokeMock.mockClear()
  sendMock.mockClear()
  getPathForFileMock.mockReset()
  onMock.mockClear()
})

describe('preload bridge — window find IPC channels', () => {
  it('forwards find and clear requests without exposing a raw Electron object', () => {
    const request = { requestId: 1, text: 'protein', findNext: true, forward: true }

    api.window.findInPage?.(request)
    api.window.clearFind?.()

    expect(sendMock).toHaveBeenNthCalledWith(1, 'window:find-in-page', request)
    expect(sendMock).toHaveBeenNthCalledWith(2, 'window:clear-find-in-page')
  })

  it('forwards the overlay close request and both appearance-bearing events from main', () => {
    const showListener = vi.fn()
    const appearanceListener = vi.fn()
    api.window.closeFind?.()
    api.window.onShowWindowFind?.(showListener)
    api.window.onWindowFindAppearance?.(appearanceListener)

    expect(sendMock).toHaveBeenCalledWith('window:find-close')
    expect(onMock).toHaveBeenCalledWith('window:find-show', expect.any(Function))
    expect(onMock).toHaveBeenCalledWith('window:find-appearance', expect.any(Function))

    const wrappedListener = onMock.mock.calls.find(
      ([channel]) => channel === 'window:find-show'
    )?.[1] as ((event: unknown, appearance: unknown) => void) | undefined
    const wrappedAppearanceListener = onMock.mock.calls.find(
      ([channel]) => channel === 'window:find-appearance'
    )?.[1] as ((event: unknown, appearance: unknown) => void) | undefined
    const appearance = { theme: 'dark' as const, followsSystem: false }
    wrappedListener?.({}, appearance)
    wrappedAppearanceListener?.({}, appearance)

    expect(showListener).toHaveBeenCalledWith(appearance)
    expect(appearanceListener).toHaveBeenCalledWith(appearance)
  })

  it('announces Workspace find readiness to main on mount', () => {
    api.window.announceWindowFindReady?.()

    expect(sendMock).toHaveBeenCalledWith('shortcut:window-find-ready')
  })

  it('forwards renderer theme changes to main as a typed appearance payload', () => {
    const appearance = { theme: 'dark' as const, followsSystem: false }

    api.window.announceWindowFindAppearance?.(appearance)

    expect(sendMock).toHaveBeenCalledWith('window:find-appearance-changed', appearance)
  })
})

// Each case: invoke a bridge method with sample args, then assert the exact channel + forwarded args.
type ForwardingCase = {
  name: string
  invoke: (api: PreloadApi) => void
  channel: string
  args: unknown[]
}

const sampleSession = { id: 's-1', projectId: 'p-1', title: 't' }
const sampleDeleteSession = { projectId: 'p-1', sessionId: 's-1' }
const sampleManifest = { projectId: 'p-1', sessionId: 's-1' }
const sampleInstall = { executablePath: '/usr/local/bin/opencode' }
const sampleFramework = { framework: 'opencode' }
const sampleResumeRequest = { sessionId: 's-1', cwd: '/workspace/project' }
const sampleGitHubPreview = { url: 'https://github.com/acme/skills/tree/main/foo' }
const sampleAgentHomePreview = { source: 'agents', slug: 'foo' }
const sampleSessionArtifactSelection = {
  projectId: 'p-1',
  sessionId: 's-1',
  files: [{ path: 'artifact://report', suggestedName: 'report.csv' }]
}

const cases: ForwardingCase[] = [
  {
    name: 'saveSessionArtifacts → file:save-session-artifacts',
    invoke: (a) => a.saveSessionArtifacts(sampleSessionArtifactSelection),
    channel: 'file:save-session-artifacts',
    args: [sampleSessionArtifactSelection]
  },
  {
    name: 'lifecycle.getClientId → lifecycle:client-id (no args)',
    invoke: (a) => a.lifecycle.getClientId(),
    channel: 'lifecycle:client-id',
    args: []
  },
  // sessions block
  {
    name: 'sessions.loadAll → sessions:load-all (no args)',
    invoke: (a) => a.sessions.loadAll(),
    channel: 'sessions:load-all',
    args: []
  },
  {
    name: 'sessions.saveSession → sessions:save-session',
    invoke: (a) => a.sessions.saveSession(sampleSession),
    channel: 'sessions:save-session',
    args: [sampleSession]
  },
  {
    name: 'sessions.deleteSession → sessions:delete-session',
    invoke: (a) => a.sessions.deleteSession(sampleDeleteSession),
    channel: 'sessions:delete-session',
    args: [sampleDeleteSession]
  },
  {
    name: 'sessions.saveManifest → sessions:save-manifest',
    invoke: (a) => a.sessions.saveManifest(sampleManifest),
    channel: 'sessions:save-manifest',
    args: [sampleManifest]
  },
  // agent-framework / opencode settings additions
  {
    name: 'settings.detectOpencode → settings:detect-opencode (no args)',
    invoke: (a) => a.settings.detectOpencode(),
    channel: 'settings:detect-opencode',
    args: []
  },
  {
    name: 'settings.installOpencode → settings:install-opencode',
    invoke: (a) => a.settings.installOpencode(sampleInstall),
    channel: 'settings:install-opencode',
    args: [sampleInstall]
  },
  {
    name: 'settings.detectCodex → settings:detect-codex (no args)',
    invoke: (a) => a.settings.detectCodex(),
    channel: 'settings:detect-codex',
    args: []
  },
  {
    name: 'settings.installCodex → settings:install-codex',
    invoke: (a) => a.settings.installCodex(sampleInstall),
    channel: 'settings:install-codex',
    args: [sampleInstall]
  },
  {
    name: 'settings.setAgentFramework → settings:set-agent-framework',
    invoke: (a) => a.settings.setAgentFramework(sampleFramework),
    channel: 'settings:set-agent-framework',
    args: [sampleFramework]
  },
  {
    name: 'settings.setNotificationsEnabled → settings:set-notifications-enabled',
    invoke: (a) => a.settings.setNotificationsEnabled({ enabled: false }),
    channel: 'settings:set-notifications-enabled',
    args: [{ enabled: false }]
  },
  {
    name: 'settings.setConversationSkillImportEnabled → settings:set-conversation-skill-import-enabled',
    invoke: (a) => a.settings.setConversationSkillImportEnabled({ enabled: false }),
    channel: 'settings:set-conversation-skill-import-enabled',
    args: [{ enabled: false }]
  },
  {
    name: 'settings.setClosePreference → settings:set-close-preference',
    invoke: (a) => a.settings.setClosePreference({ preference: 'minimize' }),
    channel: 'settings:set-close-preference',
    args: [{ preference: 'minimize' }]
  },
  {
    name: 'settings.setAppIconVariant → settings:set-app-icon-variant',
    invoke: (a) => a.settings.setAppIconVariant({ variant: 'dark' }),
    channel: 'settings:set-app-icon-variant',
    args: [{ variant: 'dark' }]
  },
  {
    name: 'settings.listAppIcons → settings:list-app-icons (no args)',
    invoke: (a) => a.settings.listAppIcons(),
    channel: 'settings:list-app-icons',
    args: []
  },
  {
    name: 'settings.uninstallClaude → settings:uninstall-claude (no args)',
    invoke: (a) => a.settings.uninstallClaude(),
    channel: 'settings:uninstall-claude',
    args: []
  },
  {
    name: 'settings.uninstallOpencode → settings:uninstall-opencode (no args)',
    invoke: (a) => a.settings.uninstallOpencode(),
    channel: 'settings:uninstall-opencode',
    args: []
  },
  {
    name: 'settings.uninstallCodex → settings:uninstall-codex (no args)',
    invoke: (a) => a.settings.uninstallCodex(),
    channel: 'settings:uninstall-codex',
    args: []
  },
  {
    name: 'settings.cancelCodexLogin → settings:cancel-codex-login (no args)',
    invoke: (a) => a.settings.cancelCodexLogin(),
    channel: 'settings:cancel-codex-login',
    args: []
  },
  {
    name: 'settings.loginIsolatedCodex → settings:login-isolated-codex (no args)',
    invoke: (a) => a.settings.loginIsolatedCodex(),
    channel: 'settings:login-isolated-codex',
    args: []
  },
  {
    name: 'settings.logoutIsolatedCodex → settings:logout-isolated-codex (no args)',
    invoke: (a) => a.settings.logoutIsolatedCodex(),
    channel: 'settings:logout-isolated-codex',
    args: []
  },
  {
    name: 'settings.cancelClaudeLogin → settings:cancel-claude-login (no args)',
    invoke: (a) => a.settings.cancelClaudeLogin(),
    channel: 'settings:cancel-claude-login',
    args: []
  },
  {
    name: 'settings.loginSharedClaude → settings:login-shared-claude (no args)',
    invoke: (a) => a.settings.loginSharedClaude(),
    channel: 'settings:login-shared-claude',
    args: []
  },
  {
    name: 'settings.logoutSharedClaude → settings:logout-shared-claude (no args)',
    invoke: (a) => a.settings.logoutSharedClaude(),
    channel: 'settings:logout-shared-claude',
    args: []
  },
  {
    name: 'settings.loginIsolatedClaude → settings:login-isolated-claude',
    invoke: (a) => a.settings.loginIsolatedClaude('sk-ant-test'),
    channel: 'settings:login-isolated-claude',
    args: ['sk-ant-test']
  },
  {
    name: 'settings.loginIsolatedClaudeBrowser → settings:login-isolated-claude-browser (no args)',
    invoke: (a) => a.settings.loginIsolatedClaudeBrowser(),
    channel: 'settings:login-isolated-claude-browser',
    args: []
  },
  {
    name: 'settings.cancelIsolatedClaudeLogin → settings:cancel-isolated-claude-login (no args)',
    invoke: (a) => a.settings.cancelIsolatedClaudeLogin(),
    channel: 'settings:cancel-isolated-claude-login',
    args: []
  },
  {
    name: 'settings.logoutIsolatedClaude → settings:logout-isolated-claude (no args)',
    invoke: (a) => a.settings.logoutIsolatedClaude(),
    channel: 'settings:logout-isolated-claude',
    args: []
  },
  {
    name: 'settings.previewGitHubSkill → settings:preview-github-skill',
    invoke: (a) => a.settings.previewGitHubSkill(sampleGitHubPreview),
    channel: 'settings:preview-github-skill',
    args: [sampleGitHubPreview]
  },
  {
    name: 'settings.previewAgentHomeSkill → settings:preview-agent-home-skill',
    invoke: (a) => a.settings.previewAgentHomeSkill(sampleAgentHomePreview),
    channel: 'settings:preview-agent-home-skill',
    args: [sampleAgentHomePreview]
  },
  // command-line launcher install/uninstall/status
  {
    name: 'cli.getStatus → cli:get-status (no args)',
    invoke: (a) => a.cli.getStatus(),
    channel: 'cli:get-status',
    args: []
  },
  {
    name: 'cli.install → cli:install (no args)',
    invoke: (a) => a.cli.install(),
    channel: 'cli:install',
    args: []
  },
  {
    name: 'cli.uninstall → cli:uninstall (no args)',
    invoke: (a) => a.cli.uninstall(),
    channel: 'cli:uninstall',
    args: []
  },
  // ACP session context: resume vs the overflow-recovery reset must hit distinct channels.
  {
    name: 'acp.resumeSession → acp:resume-session',
    invoke: (a) => a.acp.resumeSession(sampleResumeRequest),
    channel: 'acp:resume-session',
    args: [sampleResumeRequest]
  },
  {
    name: 'acp.resetSessionContext → acp:reset-session-context',
    invoke: (a) => a.acp.resetSessionContext(sampleResumeRequest),
    channel: 'acp:reset-session-context',
    args: [sampleResumeRequest]
  },
  {
    name: 'acp.compactSession → acp:compact-session',
    invoke: (a) => a.acp.compactSession({ sessionId: 's-1' }),
    channel: 'acp:compact-session',
    args: [{ sessionId: 's-1' }]
  },
  // Notification click target: inspect first so partial hydration can retain an omitted session.
  {
    name: 'notifications.peekPendingOpenSession → notifications:peek-pending-open-session',
    invoke: (a) => a.notifications.peekPendingOpenSession(),
    channel: 'notifications:peek-pending-open-session',
    args: []
  },
  {
    name: 'notifications.takePendingOpenSession → notifications:take-pending-open-session',
    invoke: (a) => a.notifications.takePendingOpenSession(7),
    channel: 'notifications:take-pending-open-session',
    args: [7]
  }
]

describe('preload bridge — sessions + agent-framework IPC channels', () => {
  it('sends desktop-only unread visibility without adding a Web invoke route', () => {
    const state = { visibleSessionId: 's-1' }

    api.notifications.syncViewState(state)

    expect(sendMock).toHaveBeenCalledWith('notifications:sync-unread-view', state)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('exposes the unread visibility probe as a narrow renderer event', () => {
    const listener = vi.fn()

    api.notifications.onViewProbe(listener)

    expect(onMock).toHaveBeenCalledWith('notifications:probe-unread-view', expect.any(Function))
    const wrappedListener = onMock.mock.calls.at(-1)?.[1] as
      ((_event: unknown, challengeId: number) => void) | undefined
    wrappedListener?.({}, 41)
    expect(listener).toHaveBeenCalledWith(41)
  })

  it('does not expose the legacy half-delete project-session command', () => {
    expect(api.sessions).not.toHaveProperty('deleteProjectSessions')
  })

  it.each(cases)('$name', ({ invoke, channel, args }) => {
    invoke(api)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(channel, ...args)
  })

  it('forwards the exact argument reference given by the caller', () => {
    // Guards against accidental cloning/reshaping in the bridge: the same object reference must reach
    // ipcRenderer.invoke unchanged.
    api.settings.installOpencode(sampleInstall)
    expect(invokeMock.mock.calls[0]?.[1]).toBe(sampleInstall)
  })

  it('attaches the OOPIF and reports runtime state over the narrow Office bridge', async () => {
    invokeMock.mockResolvedValueOnce({ kind: 'attached' })
    await api.officePreview.attachFrame('office-session-1')
    api.officePreview.reportState('office-session-1', {
      sessionId: 'office-session-1',
      phase: 'ready'
    })

    expect(invokeMock).toHaveBeenCalledWith('office-preview:attach-frame', 'office-session-1')
    expect(sendMock).toHaveBeenCalledWith('office-preview:report-state', 'office-session-1', {
      sessionId: 'office-session-1',
      phase: 'ready'
    })
  })

  it('resolves native upload paths in preload and sends only metadata to main', async () => {
    const file = { name: 'large.csv', size: 1024, type: 'text/csv' } as File
    const attachment = { path: '/managed/.pending/large.csv' }
    const request = {
      transferId: 'transfer-1',
      name: 'large.csv',
      size: 1024,
      mimeType: 'text/csv'
    }
    getPathForFileMock.mockReturnValue('/data/large.csv')
    invokeMock.mockResolvedValueOnce(attachment)

    await expect(api.uploads.stageLocalFile(file, request)).resolves.toBe(attachment)
    await api.uploads.claimLocalFile({ transferId: request.transferId })

    expect(getPathForFileMock).toHaveBeenCalledWith(file)
    expect(invokeMock).toHaveBeenCalledWith('uploads:stage-local-file', {
      ...request,
      sourcePath: '/data/large.csv'
    })
    expect(invokeMock).toHaveBeenCalledWith('uploads:claim-local-file', {
      transferId: request.transferId
    })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})
