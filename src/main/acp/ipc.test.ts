// Pins the ACP IPC bridge: the channel string and that it forwards verbatim to the runtime method.
// The runtime behavior is covered in runtime.test.ts; this guards the wiring itself so a channel typo
// (mismatched against the preload) can't slip through green. resetSessionContext is the overflow-recovery
// reset the renderer calls before replaying a compacted conversation, distinct from resume-session.

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpResumeSessionRequest } from '../../shared/acp'

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
const { createSession, resetSessionContext, resumeSession, AcpRuntimeMock } = vi.hoisted(() => {
  const createSession = vi
    .fn()
    .mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  const resetSessionContext = vi
    .fn()
    .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const AcpRuntimeMock = vi.fn().mockImplementation(function () {
    return { createSession, resetSessionContext, resumeSession, getSnapshot: vi.fn() }
  })
  return { createSession, resetSessionContext, resumeSession, AcpRuntimeMock }
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
  mkdir.mockClear()
  rm.mockClear()
  createSession.mockClear()
  resetSessionContext.mockClear()
  resumeSession.mockClear()
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
