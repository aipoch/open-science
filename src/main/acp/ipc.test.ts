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
const { resetSessionContext, resumeSession, AcpRuntimeMock } = vi.hoisted(() => {
  const resetSessionContext = vi
    .fn()
    .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const AcpRuntimeMock = vi.fn().mockImplementation(function () {
    return { resetSessionContext, resumeSession, getSnapshot: vi.fn() }
  })
  return { resetSessionContext, resumeSession, AcpRuntimeMock }
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
