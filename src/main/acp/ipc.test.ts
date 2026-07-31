// Pins the ACP IPC bridge: the channel string and that it forwards verbatim to the runtime method.
// The runtime behavior is covered in runtime.test.ts; this guards the wiring itself so a channel typo
// (mismatched against the preload) can't slip through green. resetSessionContext is the overflow-recovery
// reset the renderer calls before replaying a compacted conversation, distinct from resume-session.

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpCompactSessionRequest, AcpResumeSessionRequest } from '../../shared/acp'
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
const {
  cancelPrompt,
  compactSession,
  createSession,
  deleteSession,
  disconnect,
  resetSessionContext,
  resumeSession,
  sendPrompt,
  AcpRuntimeMock
} = vi.hoisted(() => {
  const cancelPrompt = vi.fn().mockResolvedValue({})
  const compactSession = vi.fn().mockResolvedValue({ stopReason: 'end_turn' })
  const createSession = vi
    .fn()
    .mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  const deleteSession = vi.fn().mockResolvedValue({})
  const disconnect = vi.fn().mockResolvedValue({})
  const resetSessionContext = vi
    .fn()
    .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const sendPrompt = vi.fn().mockResolvedValue(undefined)
  const AcpRuntimeMock = vi.fn().mockImplementation(function () {
    return {
      createSession,
      cancelPrompt,
      compactSession,
      deleteSession,
      disconnect,
      resetSessionContext,
      resumeSession,
      sendPrompt,
      getSnapshot: vi.fn().mockReturnValue({
        status: 'idle',
        cwd: '/workspace',
        sessionIds: [],
        events: [],
        pendingPermissions: [],
        permissionProfiles: {},
        permissionGrants: {},
        promptInFlight: false,
        promptInFlightSessionIds: []
      })
    }
  })
  return {
    cancelPrompt,
    compactSession,
    createSession,
    deleteSession,
    disconnect,
    resetSessionContext,
    resumeSession,
    sendPrompt,
    AcpRuntimeMock
  }
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
  initializationBarrier?: Promise<unknown>
  taskNotifications?: {
    trackPrompt: ReturnType<typeof vi.fn>
    untrackPrompt: ReturnType<typeof vi.fn>
  }
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  profileService?: { getById: (id: string) => Promise<unknown> }
  specialistSkillCatalog?: Array<{ id: string; frameworkName: string; displayName: string }>
  provisionedConnectorSkillNames?: string[]
}): void => {
  const taskNotifications =
    overrides?.taskNotifications ??
    ({ trackPrompt: vi.fn(), untrackPrompt: vi.fn() } as unknown as {
      trackPrompt: ReturnType<typeof vi.fn>
      untrackPrompt: ReturnType<typeof vi.fn>
    })

  const options = {
    mcpEntryPath: '/app/out/main/index.js',
    repository: {} as never,
    runRegistry: {} as never,
    uploadRepository: {} as never,
    notebookRpcServer: {} as never,
    authorizeSkillImportReferencedUploads: vi.fn(async () => () => undefined),
    settingsService: {
      captureActiveAgentBackendSelection: vi.fn().mockResolvedValue({}),
      resolveAgentBackend: vi.fn().mockResolvedValue({}),
      listSpecialistSkillCatalog: vi
        .fn()
        .mockResolvedValue(overrides?.specialistSkillCatalog ?? []),
      provisionedConnectorSkillNames: vi
        .fn()
        .mockResolvedValue(overrides?.provisionedConnectorSkillNames ?? [])
    } as never,
    taskNotifications: taskNotifications as never,
    onSessionCancellationRequested: overrides?.onSessionCancellationRequested,
    onSessionUnavailable: overrides?.onSessionUnavailable,
    onAllSessionsCancellationRequested: overrides?.onAllSessionsCancellationRequested,
    beforeSessionDelete: overrides?.beforeSessionDelete,
    initializationBarrier: overrides?.initializationBarrier,
    profileService: overrides?.profileService as never
  }

  registerAcpIpcHandlers(options)
}

afterEach(() => {
  clearMigrationPending()
  mkdir.mockClear()
  rm.mockClear()
  // Restore the default managed-workspace implementation (a test may have overridden it once).
  createSession.mockReset()
  createSession.mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  resetSessionContext.mockClear()
  compactSession.mockClear()
  cancelPrompt.mockClear()
  deleteSession.mockClear()
  disconnect.mockClear()
  resumeSession.mockClear()
  sendPrompt.mockReset()
  sendPrompt.mockResolvedValue(undefined)
  errorLogSpy.mockClear()
  AcpRuntimeMock.mockClear()
})

describe('registerAcpIpcHandlers — Specialist identity resolver', () => {
  it('passes a ProfileService-backed resolver into each runtime', async () => {
    const profile = {
      name: 'RNA-seq Reviewer',
      systemPrompt: 'Review RNA-seq quality.',
      enabled: true
    }
    const profileService = { getById: vi.fn().mockResolvedValue(profile) }

    registerWithFakes({ profileService })

    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistIdentity?: (id: string, framework: string) => Promise<unknown>
    }
    expect(options.resolveSpecialistIdentity).toBeTypeOf('function')
    await expect(
      options.resolveSpecialistIdentity?.('uuid-1', 'claude-code')
    ).resolves.toMatchObject({
      append: expect.stringContaining('RNA-seq Reviewer'),
      prefix: ''
    })
    expect(profileService.getById).toHaveBeenCalledWith('uuid-1')
  })

  it('wires the production ProfileService and live catalog into the Specialist Skill resolver', async () => {
    const profileService = {
      getById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: ['main-disabled'], connectorIds: [], connectorTools: [] }
      })
    }
    registerWithFakes({
      profileService,
      specialistSkillCatalog: [
        { id: 'main-disabled', frameworkName: 'Main Disabled', displayName: 'Main Disabled' }
      ]
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    await expect(options.resolveSpecialistSkills?.('uuid-1')).resolves.toEqual({
      kind: 'specialist',
      skillIds: ['main-disabled'],
      frameworkNames: ['Main Disabled'],
      missingSkillIds: []
    })
  })

  it('merges only the specialist-allowed connector skills into the whitelist (selected mode)', async () => {
    const profileService = {
      getById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: ['skill-a'],
          connectorIds: ['chemistry'],
          connectorTools: []
        }
      })
    }
    registerWithFakes({
      profileService,
      specialistSkillCatalog: [{ id: 'skill-a', frameworkName: 'Skill A', displayName: 'Skill A' }],
      provisionedConnectorSkillNames: ['mcp-chemistry', 'mcp-literature']
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    const result = (await options.resolveSpecialistSkills?.('uuid-1')) as {
      frameworkNames: string[]
    }
    // Selected mode: only connectorIds are allowed, so mcp-literature is filtered out.
    expect(result.frameworkNames).toEqual(['Skill A', 'mcp-chemistry'])
  })

  it('excludes full-access blocked connectors from the whitelist (full mode)', async () => {
    const profileService = {
      getById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'full',
        fullAccess: {
          excludedSkillIds: [],
          excludedConnectorIds: ['literature'],
          connectorTools: []
        },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      })
    }
    registerWithFakes({
      profileService,
      specialistSkillCatalog: [],
      provisionedConnectorSkillNames: ['mcp-chemistry', 'mcp-literature']
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    const result = (await options.resolveSpecialistSkills?.('uuid-1')) as {
      frameworkNames: string[]
    }
    // Full mode: all connectors except excludedConnectorIds; literature is excluded.
    expect(result.frameworkNames).toEqual(['mcp-chemistry'])
  })
})

describe('registerAcpIpcHandlers — Skill import cancellation lifecycle', () => {
  it('invalidates a stopped prompt and deleted session before runtime teardown starts', async () => {
    const onSessionCancellationRequested = vi.fn()
    const onSessionUnavailable = vi.fn()
    const beforeSessionDelete = vi.fn().mockResolvedValue(undefined)
    registerWithFakes({
      onSessionCancellationRequested,
      onSessionUnavailable,
      beforeSessionDelete
    })

    await handlers.get('acp:cancel')?.({}, { sessionId: 'session-1' })
    await handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })

    expect(onSessionCancellationRequested).toHaveBeenCalledTimes(2)
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(1, 'session-1')
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(2, 'session-2')
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-2')
    expect(beforeSessionDelete).toHaveBeenCalledWith('session-2')
    expect(cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'session-2' })
    expect(onSessionCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      cancelPrompt.mock.invocationCallOrder[0]
    )
    expect(onSessionCancellationRequested.mock.invocationCallOrder[1]).toBeLessThan(
      beforeSessionDelete.mock.invocationCallOrder[0]
    )
    expect(beforeSessionDelete.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSession.mock.invocationCallOrder[0]
    )
    expect(deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      onSessionUnavailable.mock.invocationCallOrder[0]
    )
  })

  it('keeps the agent session when notebook teardown fails', async () => {
    const onSessionUnavailable = vi.fn()
    const beforeSessionDelete = vi.fn().mockRejectedValue(new Error('notebook shutdown failed'))
    registerWithFakes({ onSessionUnavailable, beforeSessionDelete })

    await expect(
      handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })
    ).rejects.toThrow('notebook shutdown failed')

    expect(deleteSession).not.toHaveBeenCalled()
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('keeps pending imports invalidated when prompt or session teardown fails', async () => {
    const onSessionCancellationRequested = vi.fn()
    const onSessionUnavailable = vi.fn()
    registerWithFakes({ onSessionCancellationRequested, onSessionUnavailable })
    cancelPrompt.mockRejectedValueOnce(new Error('cancel failed'))
    deleteSession.mockRejectedValueOnce(new Error('delete failed'))

    await expect(handlers.get('acp:cancel')?.({}, { sessionId: 'session-1' })).rejects.toThrow(
      'cancel failed'
    )
    await expect(
      handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })
    ).rejects.toThrow('delete failed')

    expect(onSessionCancellationRequested).toHaveBeenCalledTimes(2)
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(1, 'session-1')
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(2, 'session-2')
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('invalidates every pending import before all agent runtimes disconnect', async () => {
    const onAllSessionsCancellationRequested = vi.fn()
    registerWithFakes({ onAllSessionsCancellationRequested })

    await handlers.get('acp:disconnect')?.({}, undefined)

    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]
    )
  })

  it('keeps pending imports invalidated when global disconnect fails', async () => {
    const onAllSessionsCancellationRequested = vi.fn()
    registerWithFakes({ onAllSessionsCancellationRequested })
    disconnect.mockRejectedValueOnce(new Error('disconnect failed'))

    await expect(handlers.get('acp:disconnect')?.({}, undefined)).rejects.toThrow(
      'disconnect failed'
    )

    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]
    )
  })
})

describe('registerAcpIpcHandlers — managed session workspace', () => {
  it('registers immediately but waits for initialization before creating the first session', async () => {
    let finishInitialization: (() => void) | undefined
    const initializationBarrier = new Promise<void>((resolve) => {
      finishInitialization = resolve
    })

    registerWithFakes({ initializationBarrier })
    expect(handlers.has('acp:create-session')).toBe(true)

    const creation = handlers.get('acp:create-session')?.(
      {},
      { cwd: '/workspace', projectName: 'project-1', permissionProfile: 'ask' }
    )
    await Promise.resolve()
    expect(createSession).not.toHaveBeenCalled()

    finishInitialization?.()
    await creation

    expect(createSession).toHaveBeenCalledOnce()
  })

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

describe('registerAcpIpcHandlers — native context compaction bridge', () => {
  it('forwards the session to its runtime and returns the refreshed snapshot', async () => {
    registerWithFakes()
    const request: AcpCompactSessionRequest = { sessionId: 's-1' }

    const result = await handlers.get('acp:compact-session')?.({}, request)

    expect(compactSession).toHaveBeenCalledOnce()
    expect(compactSession).toHaveBeenCalledWith(request)
    expect(result).toMatchObject({ status: 'idle', cwd: '/workspace' })
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
    const trackPrompt = vi.fn().mockReturnValue({ token: 1 })
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
    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 1 })
  })

  it('does not revert when the send succeeds (a terminal event will clean up)', async () => {
    const trackPrompt = vi.fn().mockReturnValue({ token: 1 })
    const untrackPrompt = vi.fn()
    registerWithFakes({ taskNotifications: { trackPrompt, untrackPrompt } })

    await handlers.get('acp:send-prompt')?.({}, { sessionId: 'session-1', text: 'Plot the curve' })

    expect(trackPrompt).toHaveBeenCalledTimes(1)
    expect(untrackPrompt).not.toHaveBeenCalled()
  })
})
