// Pins the ACP IPC bridge: the channel string and that it forwards verbatim to the runtime method.
// The runtime behavior is covered in runtime.test.ts; this guards the wiring itself so a channel typo
// (mismatched against the preload) can't slip through green. resetSessionContext is the overflow-recovery
// reset the renderer calls before replaying a compacted conversation, distinct from resume-session.

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpResumeSessionRequest } from '../../shared/acp'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

// Capture every ipcMain.handle registration so a handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const { mkdir, rm } = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('node:fs/promises', () => ({ mkdir, rm }))

// A fake runtime whose methods are spies; registration wires closures over these, so only the invoked
// handler's method needs meaningful behavior. Hoisted so the (hoisted) vi.mock factory can reference it.
const { createSession, resetSessionContext, resumeSession, sendPrompt, AcpRuntimeMock } =
  vi.hoisted(() => {
    const createSession = vi
      .fn()
      .mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
    const resetSessionContext = vi
      .fn()
      .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
    const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const AcpRuntimeMock = vi.fn().mockImplementation(function () {
      return { createSession, resetSessionContext, resumeSession, sendPrompt, getSnapshot: vi.fn() }
    })
    return { createSession, resetSessionContext, resumeSession, sendPrompt, AcpRuntimeMock }
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
const registerWithFakes = (overrides?: {
  taskNotifications?: {
    trackPrompt: ReturnType<typeof vi.fn>
    untrackPrompt: ReturnType<typeof vi.fn>
  }
}): void => {
  const taskNotifications =
    overrides?.taskNotifications ??
    ({ trackPrompt: vi.fn(), untrackPrompt: vi.fn() } as unknown as {
      trackPrompt: ReturnType<typeof vi.fn>
      untrackPrompt: ReturnType<typeof vi.fn>
    })

  registerAcpIpcHandlers({
    mcpEntryPath: '/app/out/main/index.js',
    repository: {} as never,
    runRegistry: {} as never,
    uploadRepository: {} as never,
    notebookRpcServer: {} as never,
    settingsService: {} as never,
    taskNotifications
  } as Parameters<typeof registerAcpIpcHandlers>[0])
}

afterEach(() => {
  clearMigrationPending()
  mkdir.mockClear()
  rm.mockClear()
  // Restore the default managed-workspace implementation (a test may have overridden it once).
  createSession.mockReset()
  createSession.mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  resetSessionContext.mockClear()
  resumeSession.mockClear()
  sendPrompt.mockReset()
  sendPrompt.mockResolvedValue(undefined)
  errorLogSpy.mockClear()
})

describe('registerAcpIpcHandlers — managed session workspace', () => {
  it('creates new sessions in a unique workspace under the configured data root', async () => {
    registerWithFakes()

    const firstResult = await handlers.get('acp:create-session')?.(
      {},
      { projectName: 'project-1', permissionProfile: 'ask' }
    )
    const secondResult = await handlers.get('acp:create-session')?.(
      {},
      { projectName: 'project-1', permissionProfile: 'ask' }
    )

    expect(createSession).toHaveBeenCalledTimes(2)
    const firstRequest = createSession.mock.calls[0][0]
    const secondRequest = createSession.mock.calls[1][0]
    expect(firstRequest).toMatchObject({
      projectName: 'project-1',
      permissionProfile: 'ask',
      cwd: expect.any(String)
    })
    expect(firstRequest.cwd).toMatch(
      new RegExp(`^${join('/tmp/data', 'workspaces').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
    expect(secondRequest.cwd).not.toBe(firstRequest.cwd)
    expect(mkdir).toHaveBeenNthCalledWith(1, firstRequest.cwd, { recursive: true })
    expect(mkdir).toHaveBeenNthCalledWith(2, secondRequest.cwd, { recursive: true })
    expect(firstResult).toEqual({ sessionId: 's-new', cwd: firstRequest.cwd })
    expect(secondResult).toEqual({ sessionId: 's-new', cwd: secondRequest.cwd })
  })

  it('preserves an explicitly supplied cwd without creating a managed workspace', async () => {
    registerWithFakes()
    const request = {
      cwd: 'D:\\research\\chosen-workspace',
      projectName: 'project-1',
      permissionProfile: 'ask' as const
    }

    await handlers.get('acp:create-session')?.({}, request)

    expect(createSession).toHaveBeenCalledWith(request)
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('trims an explicitly supplied cwd before creating the session', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.(
      {},
      {
        cwd: '  D:\\research\\chosen-workspace  ',
        projectName: 'project-1',
        permissionProfile: 'ask'
      }
    )

    expect(createSession).toHaveBeenCalledWith({
      cwd: 'D:\\research\\chosen-workspace',
      projectName: 'project-1',
      permissionProfile: 'ask'
    })
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('treats a blank cwd as missing and allocates a managed workspace', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.(
      {},
      { cwd: '   ', projectName: 'project-1', permissionProfile: 'ask' }
    )

    const request = createSession.mock.calls[0][0]
    expect(request.cwd).not.toBe('   ')
    expect(mkdir).toHaveBeenCalledWith(request.cwd, { recursive: true })
  })

  it('rejects managed workspace creation while a data-root migration is pending', async () => {
    registerWithFakes()
    beginMigration()

    await expect(
      handlers.get('acp:create-session')?.(
        {},
        { projectName: 'project-1', permissionProfile: 'ask' }
      )
    ).rejects.toThrow(/moving your data/i)

    expect(mkdir).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('keeps migration drain pending until managed session creation finishes', async () => {
    registerWithFakes()
    let finishCreateSession!: () => void
    createSession.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finishCreateSession = () => resolve({ sessionId: 's-new', cwd: request.cwd })
        })
    )

    const createPromise = handlers.get('acp:create-session')?.(
      {},
      { projectName: 'project-1', permissionProfile: 'ask' }
    )
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(drained).toBe(false)

    finishCreateSession()
    await createPromise
    await drainPromise
    expect(drained).toBe(true)
  })

  it('removes a managed workspace when session creation fails', async () => {
    registerWithFakes()
    const error = new Error('session creation failed')
    createSession.mockRejectedValueOnce(error)

    await expect(
      handlers.get('acp:create-session')?.(
        {},
        { projectName: 'project-1', permissionProfile: 'ask' }
      )
    ).rejects.toBe(error)

    const request = createSession.mock.calls[0][0]
    expect(mkdir).toHaveBeenCalledWith(request.cwd, { recursive: true })
    expect(rm).toHaveBeenCalledWith(request.cwd, { recursive: true, force: true })
  })
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

  it('still re-throws the original error to the renderer when the logger itself throws', async () => {
    registerWithFakes()
    const failure = Object.assign(new Error('Internal error'), { code: -32603 })
    createSession.mockRejectedValueOnce(failure)
    // A hostile/broken logger must never mask the error the renderer needs to see.
    errorLogSpy.mockImplementationOnce(() => {
      throw new Error('logger boom')
    })

    await expect(handlers.get('acp:create-session')?.({}, {})).rejects.toBe(failure)
  })
})

// Pins the IPC send-prompt → notification-tracking wire-up. TaskNotificationService has its own
// unit tests for the token/untrack primitives, but the orchestration in `acp/ipc.ts` — calling
// trackPrompt before sendPrompt and reverting via untrackPrompt if the runtime rejects before the
// turn starts — is what protects a still-running turn's notification name from being overwritten
// by a rejected prompt's tracking. An earlier spec review flagged exactly this kind of seam as the
// gap that let a connector-sessionId regression slip through green.
describe('registerAcpIpcHandlers — acp:send-prompt notification tracking', () => {
  it('reverts the tracked prompt when the runtime rejects the send', async () => {
    const trackPrompt = vi.fn().mockReturnValue({ token: 1, previousToken: undefined })
    const untrackPrompt = vi.fn()
    registerWithFakes({ taskNotifications: { trackPrompt, untrackPrompt } })

    const failure = new Error('Active session disposed')
    sendPrompt.mockRejectedValueOnce(failure)

    await expect(
      handlers.get('acp:send-prompt')?.({}, { sessionId: 'session-1', text: 'Plot the curve' })
    ).rejects.toBe(failure)

    expect(trackPrompt).toHaveBeenCalledTimes(1)
    expect(trackPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Plot the curve'
    })
    // The token the handler got back is the one it reverts, so a terminal event later cannot
    // overwrite the still-running turn's snippet.
    expect(untrackPrompt).toHaveBeenCalledTimes(1)
    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 1, previousToken: undefined })
  })

  it('does not revert when the send succeeds (a terminal event will clean up)', async () => {
    const trackPrompt = vi.fn().mockReturnValue({ token: 1, previousToken: undefined })
    const untrackPrompt = vi.fn()
    registerWithFakes({ taskNotifications: { trackPrompt, untrackPrompt } })

    await handlers.get('acp:send-prompt')?.({}, { sessionId: 'session-1', text: 'Plot the curve' })

    expect(trackPrompt).toHaveBeenCalledTimes(1)
    expect(untrackPrompt).not.toHaveBeenCalled()
  })
})
