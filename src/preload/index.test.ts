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

const { invokeMock, exposeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  exposeMock: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: {
    invoke: invokeMock,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn()
  }
}))

// The subset of the bridge these tests exercise. Args are unknown — forwarding, not shape, is asserted.
type PreloadApi = {
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
    uninstallClaude: () => unknown
    uninstallOpencode: () => unknown
    uninstallCodex: () => unknown
    cancelCodexLogin: () => unknown
    loginIsolatedCodex: () => unknown
    logoutIsolatedCodex: () => unknown
  }
  acp: {
    resumeSession: (request: unknown) => unknown
    resetSessionContext: (request: unknown) => unknown
  }
  cli: {
    getStatus: () => unknown
    install: () => unknown
    uninstall: () => unknown
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

const cases: ForwardingCase[] = [
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
  }
]

describe('preload bridge — sessions + agent-framework IPC channels', () => {
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
})
