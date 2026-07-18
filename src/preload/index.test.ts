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
    deleteProjectSessions: (request: unknown) => unknown
    saveManifest: (request: unknown) => unknown
  }
  settings: {
    detectOpencode: () => unknown
    installOpencode: (request: unknown) => unknown
    setAgentFramework: (request: unknown) => unknown
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
const sampleDeleteProject = { projectId: 'p-1' }
const sampleManifest = { projectId: 'p-1', sessionId: 's-1' }
const sampleInstall = { executablePath: '/usr/local/bin/opencode' }
const sampleFramework = { framework: 'opencode' }

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
    name: 'sessions.deleteProjectSessions → sessions:delete-project-sessions',
    invoke: (a) => a.sessions.deleteProjectSessions(sampleDeleteProject),
    channel: 'sessions:delete-project-sessions',
    args: [sampleDeleteProject]
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
    name: 'settings.setAgentFramework → settings:set-agent-framework',
    invoke: (a) => a.settings.setAgentFramework(sampleFramework),
    channel: 'settings:set-agent-framework',
    args: [sampleFramework]
  }
]

describe('preload bridge — sessions + agent-framework IPC channels', () => {
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
