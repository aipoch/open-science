import { describe, expect, it, vi } from 'vitest'

import { ApplicationEventHub } from '../application-events'
import type { ApplicationEventSource } from '../application-events'
import type { ApplicationCommandComposition } from '../application-command-composition'
import type { TaskAgentPort } from '../tasks/task-runner'
import { createWebServiceController, type WebServiceControllerDeps } from './index'

type StartOptions = Parameters<WebServiceControllerDeps['startServer']>[0]

// Builds a controller over fully faked I/O so the idempotency + attached logic is exercised without
// Electron, the network, or the filesystem. `startServer` echoes the requested port and records the
// options it was given (so the test can drive onShutdownRequest).
const makeController = (
  overrides: Partial<WebServiceControllerDeps> = {},
  requestQuit = vi.fn(),
  applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'> = {
    localWeb: { commandNames: () => [], invoke: vi.fn() },
    remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() },
    task: { commandNames: () => [], invoke: vi.fn() }
  },
  runtime: { applicationEvents?: ApplicationEventSource; taskAgent?: TaskAgentPort } = {}
): {
  controller: ReturnType<typeof createWebServiceController>
  startServer: ReturnType<typeof vi.fn>
  writeState: ReturnType<typeof vi.fn>
  removeState: ReturnType<typeof vi.fn>
  serverClose: ReturnType<typeof vi.fn>
  serverCloseExternalConnections: ReturnType<typeof vi.fn>
  lastOptions: () => StartOptions
  requestQuit: ReturnType<typeof vi.fn>
} => {
  const serverClose = vi.fn().mockResolvedValue(undefined)
  const closeExternalConnections = vi.fn()
  const seen: StartOptions[] = []
  const startServer = vi.fn(async (options: StartOptions) => {
    seen.push(options)
    return { port: options.port, closeExternalConnections, close: serverClose }
  })
  const writeState = vi.fn().mockResolvedValue(undefined)
  const removeState = vi.fn().mockResolvedValue(undefined)

  const controller = createWebServiceController(
    {
      applicationCommands,
      requestQuit,
      applicationEvents: runtime.applicationEvents ?? new ApplicationEventHub(),
      taskAgent: runtime.taskAgent ?? ({} as never)
    },
    {
      startServer,
      resolveConfigRoot: () => '/fake/root',
      loadWebToken: async () => 'tok-123',
      writeState,
      removeState,
      appInfo: () => ({
        appPath: '/fake/app',
        appName: 'Open Science',
        appVersion: '9.9.9',
        versions: { electron: 'e', chrome: 'c', node: 'n' },
        pid: 4242
      }),
      ...overrides
    }
  )

  return {
    controller,
    startServer,
    writeState,
    removeState,
    serverClose,
    serverCloseExternalConnections: closeExternalConnections,
    lastOptions: () => seen[seen.length - 1],
    requestQuit
  }
}

describe('createWebServiceController', () => {
  it('passes only Web command views to the server and the narrow Task view to its façade', async () => {
    const taskInvoke = vi.fn(async () => [])
    const applicationCommands = {
      localWeb: { commandNames: () => ['projects:list'], invoke: vi.fn() },
      remoteWeb: {
        commandNames: () => ['projects:list'],
        rejectedCommandNames: () => [],
        invoke: vi.fn()
      },
      task: { commandNames: () => ['projects:list'], invoke: taskInvoke }
    } satisfies Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    const h = makeController({}, vi.fn(), applicationCommands)

    await h.controller.ensureStarted(44100, { attached: true })

    expect(h.lastOptions().applicationCommands).toEqual({
      localWeb: applicationCommands.localWeb,
      remoteWeb: applicationCommands.remoteWeb
    })
    await expect(h.lastOptions().tasks?.listProjects()).resolves.toEqual([])
    expect(taskInvoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        callerContext: expect.objectContaining({ surface: 'task' }),
        args: []
      })
    )
  })

  it('starts once and records the port/url plus the attached flag in the state file', async () => {
    const h = makeController()
    const result = await h.controller.ensureStarted(44100, { attached: true })

    expect(result).toEqual({ port: 44100, url: 'http://127.0.0.1:44100/?token=tok-123' })
    expect(h.startServer).toHaveBeenCalledTimes(1)
    expect(h.lastOptions().bootstrap.configRoot).toBe('/fake/root')
    expect(h.writeState).toHaveBeenCalledWith(
      '/fake/root',
      expect.objectContaining({ pid: 4242, port: 44100, appVersion: '9.9.9', attached: true })
    )
    expect(h.controller.isRunning()).toBe(true)
    expect(h.controller.runningPort()).toBe(44100)
  })

  it('is idempotent: a second ensureStarted while running reuses the server (no second start)', async () => {
    const h = makeController()
    await h.controller.ensureStarted(44100, { attached: false })
    const again = await h.controller.ensureStarted(59999, { attached: true })

    expect(h.startServer).toHaveBeenCalledTimes(1)
    // Reuses the already-running port, ignoring the second call's requested port/attached.
    expect(again.port).toBe(44100)
  })

  it('dedupes concurrent ensureStarted calls into a single server start', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const startServer = vi.fn(async (options: StartOptions) => {
      await gate
      return {
        port: options.port,
        closeExternalConnections: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined)
      }
    })
    const h = makeController({ startServer })

    const a = h.controller.ensureStarted(44100, { attached: false })
    const b = h.controller.ensureStarted(44100, { attached: false })
    release?.()
    await Promise.all([a, b])

    expect(startServer).toHaveBeenCalledTimes(1)
  })

  it('close stops the server, removes state, and allows a fresh start afterwards', async () => {
    const h = makeController()
    await h.controller.ensureStarted(44100, { attached: true })

    await h.controller.close()
    expect(h.serverClose).toHaveBeenCalledTimes(1)
    expect(h.removeState).toHaveBeenCalledWith('/fake/root')
    expect(h.controller.isRunning()).toBe(false)
    expect(h.controller.runningPort()).toBeUndefined()

    await h.controller.ensureStarted(44100, { attached: true })
    expect(h.startServer).toHaveBeenCalledTimes(2)
  })

  it('preserves Task run state and its caller lease across a restartable close', async () => {
    const project = {
      id: 'project-1',
      name: 'Project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    const callerSignals: AbortSignal[] = []
    const sessions: unknown[] = []
    const taskInvoke = vi.fn(async (name, invocation) => {
      callerSignals.push(invocation.callerLease.signal)
      if (name === 'projects:list') return [project]
      if (name === 'sessions:load-all') return { sessions, manifest: { version: 1 } }
      if (name === 'sessions:save-session') {
        sessions.splice(0, sessions.length, invocation.args[0])
        return undefined
      }
      throw new Error(`Unexpected Task command: ${name}`)
    })
    const applicationCommands = {
      localWeb: { commandNames: () => [], invoke: vi.fn() },
      remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() },
      task: { commandNames: () => ['projects:list'], invoke: taskInvoke }
    } satisfies Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    const h = makeController({}, vi.fn(), applicationCommands, {
      taskAgent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: vi.fn(async () => []),
        createSession: vi.fn(async () => ({ sessionId: 'session-created' })),
        resumeSession: vi.fn(async (request) => ({ sessionId: request.sessionId })),
        setPermissionProfile: vi.fn(async () => undefined),
        cancelPrompt: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined)
      }
    })

    await h.controller.ensureStarted(44100, { attached: true })
    const firstTasks = h.lastOptions().tasks!
    const run = await firstTasks.startRun({ project: project.id, prompt: 'Research.' })

    await h.controller.close()
    expect(callerSignals.every((signal) => !signal.aborted)).toBe(true)

    await h.controller.ensureStarted(44100, { attached: true })
    const restartedTasks = h.lastOptions().tasks!
    expect(restartedTasks).toBe(firstTasks)
    expect(restartedTasks.getRun(run.id)).toMatchObject({ id: run.id, sessionId: run.sessionId })
  })

  it('terminal dispose is idempotent, releases Task once, and rejects later starts', async () => {
    const unsubscribe = vi.fn()
    const applicationEvents = { subscribe: vi.fn(() => unsubscribe) }
    const callerSignals: AbortSignal[] = []
    const applicationCommands = {
      localWeb: { commandNames: () => [], invoke: vi.fn() },
      remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() },
      task: {
        commandNames: () => ['projects:list'],
        invoke: vi.fn(async (_name, invocation) => {
          callerSignals.push(invocation.callerLease.signal)
          return []
        })
      }
    } satisfies Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    const h = makeController({}, vi.fn(), applicationCommands, { applicationEvents })

    await h.controller.ensureStarted(44100, { attached: true })
    await h.lastOptions().tasks?.listProjects()
    await h.controller.dispose()
    await h.controller.dispose()

    expect(h.serverClose).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(callerSignals[0]?.aborted).toBe(true)
    await expect(h.controller.ensureStarted(44100, { attached: true })).rejects.toThrow(
      'Web service controller is disposed.'
    )
  })

  it('waits for a pending start before terminal disposal closes the server', async () => {
    let releaseStart: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const serverClose = vi.fn().mockResolvedValue(undefined)
    const startServer = vi.fn(async (options: StartOptions) => {
      await gate
      return { port: options.port, closeExternalConnections: vi.fn(), close: serverClose }
    })
    const h = makeController({ startServer })

    const start = h.controller.ensureStarted(44100, { attached: true })
    const dispose = h.controller.dispose()
    expect(serverClose).not.toHaveBeenCalled()
    releaseStart?.()
    await Promise.all([start, dispose])

    expect(serverClose).toHaveBeenCalledOnce()
    expect(h.removeState).toHaveBeenCalledWith('/fake/root')
    expect(h.controller.isRunning()).toBe(false)
  })

  it('does not deadlock after start failure and still releases Task on terminal dispose', async () => {
    const failure = new Error('listen failed')
    const unsubscribe = vi.fn()
    const h = makeController(
      { startServer: vi.fn().mockRejectedValue(failure) },
      vi.fn(),
      undefined,
      { applicationEvents: { subscribe: vi.fn(() => unsubscribe) } }
    )

    await expect(h.controller.ensureStarted(44100, { attached: true })).rejects.toBe(failure)
    await expect(h.controller.dispose()).resolves.toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('releases Task even when terminal server cleanup fails', async () => {
    const failure = new Error('server close failed')
    const unsubscribe = vi.fn()
    const h = makeController(
      {
        startServer: async (options) => ({
          port: options.port,
          closeExternalConnections: vi.fn(),
          close: vi.fn().mockRejectedValue(failure)
        })
      },
      vi.fn(),
      undefined,
      { applicationEvents: { subscribe: vi.fn(() => unsubscribe) } }
    )

    await h.controller.ensureStarted(44100, { attached: true })
    await expect(h.controller.dispose()).rejects.toBe(failure)
    expect(h.removeState).toHaveBeenCalledWith('/fake/root')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('forwards remote socket closure to the running server', async () => {
    const h = makeController()
    await h.controller.ensureStarted(44100, { attached: true })

    h.controller.closeExternalConnections('trusted-browser')

    expect(h.serverCloseExternalConnections).toHaveBeenCalledWith('trusted-browser')
  })

  it('an attached shutdown request tears down only the web service, never quitting the app', async () => {
    const h = makeController()
    await h.controller.ensureStarted(44100, { attached: true })

    // The server was wired with an onShutdownRequest; invoking it (as /api/shutdown would) must close
    // the web service without quitting the app.
    h.lastOptions().onShutdownRequest?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.serverClose).toHaveBeenCalledTimes(1)
    expect(h.removeState).toHaveBeenCalledWith('/fake/root')
    expect(h.requestQuit).not.toHaveBeenCalled()
  })

  it('notifies dependants when an attached shutdown stops the web service', async () => {
    const h = makeController()
    const stopped = vi.fn()
    h.controller.onStopped(stopped)
    await h.controller.ensureStarted(44100, { attached: true })

    h.lastOptions().onShutdownRequest?.()
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1))
  })

  it('a non-attached (dedicated daemon) shutdown request quits the app', async () => {
    const h = makeController()
    await h.controller.ensureStarted(44100, { attached: false })

    h.lastOptions().onShutdownRequest?.()

    expect(h.requestQuit).toHaveBeenCalledTimes(1)
  })
})
