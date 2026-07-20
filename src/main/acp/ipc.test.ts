// Pins the ACP IPC bridge: the channel string and that it forwards verbatim to the runtime method.
// The runtime behavior is covered in runtime.test.ts; this guards the wiring itself so a channel typo
// (mismatched against the preload) can't slip through green. resetSessionContext is the overflow-recovery
// reset the renderer calls before replaying a compacted conversation, distinct from resume-session.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpResumeSessionRequest } from '../../shared/acp'

// Capture every ipcMain.handle registration so a handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

// A fake runtime whose methods are spies; registration wires closures over these, so only the invoked
// handler's method needs meaningful behavior. Hoisted so the (hoisted) vi.mock factory can reference it.
const { resetSessionContext, resumeSession, createSession, AcpRuntimeMock } = vi.hoisted(() => {
  const resetSessionContext = vi
    .fn()
    .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const createSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const AcpRuntimeMock = vi.fn().mockImplementation(function () {
    return { resetSessionContext, resumeSession, createSession, getSnapshot: vi.fn() }
  })
  return { resetSessionContext, resumeSession, createSession, AcpRuntimeMock }
})

// Spy on the file logger so the create-session failure path can be asserted (routes to main.log, not a
// bare console.error). errorLogFields stays real so the assertion also covers its output shape.
const { errorLogSpy } = vi.hoisted(() => ({ errorLogSpy: vi.fn() }))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({ ...actual.createLogger(scope), error: errorLogSpy })
  }
})

vi.mock('./runtime', () => ({ AcpRuntime: AcpRuntimeMock }))
vi.mock('./shutdown-guard', () => ({ installAgentShutdownGuard: vi.fn() }))
vi.mock('./mcp-http-host', () => ({ AgentMcpHttpHost: vi.fn() }))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => '/tmp/config',
  resolveDataRoot: () => '/tmp/data'
}))

const { registerAcpIpcHandlers } = await import('./ipc')

// Minimal options — createRuntime just forwards them into the mocked AcpRuntime constructor.
const registerWithFakes = (): void => {
  registerAcpIpcHandlers({
    mcpEntryPath: '/app/out/main/index.js',
    repository: {} as never,
    runRegistry: {} as never,
    uploadRepository: {} as never,
    notebookRpcServer: {} as never,
    settingsService: {} as never
  } as Parameters<typeof registerAcpIpcHandlers>[0])
}

afterEach(() => {
  resetSessionContext.mockClear()
  resumeSession.mockClear()
  createSession.mockClear()
  createSession.mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  errorLogSpy.mockClear()
})

describe('registerAcpIpcHandlers — reset-session-context bridge', () => {
  it('registers the acp:reset-session-context channel', () => {
    registerWithFakes()
    expect(handlers.has('acp:reset-session-context')).toBe(true)
  })

  it('forwards the request to runtime.resetSessionContext and returns its result', async () => {
    registerWithFakes()
    const request: AcpResumeSessionRequest = { sessionId: 's-1', cwd: '/workspace' }

    const result = await handlers.get('acp:reset-session-context')?.({}, request)

    expect(resetSessionContext).toHaveBeenCalledTimes(1)
    expect(resetSessionContext).toHaveBeenCalledWith(request)
    // The distinct resume channel must not be driven by the reset call.
    expect(resumeSession).not.toHaveBeenCalled()
    expect(result).toEqual({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  })
})

describe('registerAcpIpcHandlers — create-session failure logging', () => {
  it('logs the failure via the file logger and re-throws so the renderer still sees the error', async () => {
    registerWithFakes()
    const failure = Object.assign(new Error('Internal error'), { code: -32603 })
    createSession.mockRejectedValueOnce(failure)

    await expect(handlers.get('acp:create-session')?.({}, {})).rejects.toBe(failure)

    expect(errorLogSpy).toHaveBeenCalledTimes(1)
    const [message, data] = errorLogSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('acp:create-session failed')
    // Full error, not a bare "Internal error" string: message + JSON-RPC code both survive.
    expect(data.error).toBe('Internal error')
    expect(data.code).toBe(-32603)
  })

  it('does not log on the success path', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.({}, {})

    expect(errorLogSpy).not.toHaveBeenCalled()
  })
})
