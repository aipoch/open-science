import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const { log } = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../logger', () => ({ createLogger: () => log }))

import { ApplicationEventHub } from '../application-events'
import type { ApplicationEventSource } from '../application-events'
import type { ApplicationCommandComposition } from '../application-command-composition'
import type { TaskAgentPort, TaskComputePreferencePort } from '../tasks/task-runner'
import { FileTaskRunJournal } from '../tasks/task-run-journal'
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
  runtime: {
    applicationEvents?: ApplicationEventSource
    taskAgent?: TaskAgentPort
    computePreferences?: TaskComputePreferencePort
  } = {}
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

  const runtimePorts = {
    applicationCommands,
    requestQuit,
    applicationEvents: runtime.applicationEvents ?? new ApplicationEventHub(),
    taskAgent: runtime.taskAgent ?? ({} as never),
    computePreferences: runtime.computePreferences ?? {
      withReservation: async (providerIds, operation) => operation([...new Set(providerIds)]),
      set: async () => {
        throw new Error('Unexpected existing Session Compute preference update.')
      }
    }
  }
  const controller = createWebServiceController(runtimePorts, {
    startServer,
    resolveConfigRoot: () => '/fake/root',
    loadWebToken: async () => 'tok-123',
    writeState,
    removeState,
    createTaskRunJournal: () => ({
      load: async () => [],
      replace: async () => undefined
    }),
    appInfo: () => ({
      appPath: '/fake/app',
      appName: 'Open Science',
      appVersion: '9.9.9',
      versions: { electron: 'e', chrome: 'c', node: 'n' },
      pid: 4242
    }),
    ...overrides
  })

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
  it('passes the Session Compute preference authority to the Task façade', async () => {
    const project = {
      id: 'project-compute',
      name: 'Project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    const sessions: unknown[] = []
    const applicationCommands = {
      localWeb: { commandNames: () => [], invoke: vi.fn() },
      remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() },
      task: {
        commandNames: () => [],
        invoke: vi.fn(async (name, invocation) => {
          if (name === 'projects:list') return [project]
          if (name === 'sessions:load-all') return { sessions, manifest: { version: 1 } }
          if (name === 'sessions:save-session') {
            const durable = {
              ...(invocation.args[0] as object),
              enabledComputeHosts: ['ssh:authority'],
              selectedComputeHosts: ['ssh:authority']
            }
            sessions.push(durable)
            return durable
          }
          throw new Error(`Unexpected Task command: ${name}`)
        })
      }
    } satisfies Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    const reserve = vi.fn()
    const h = makeController({}, vi.fn(), applicationCommands, {
      taskAgent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: vi.fn(async () => []),
        createSession: vi.fn(async () => ({ sessionId: 'session-compute' })),
        resumeSession: vi.fn(async (request) => ({ sessionId: request.sessionId })),
        setPermissionProfile: vi.fn(async () => undefined),
        cancelPrompt: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined)
      },
      computePreferences: {
        withReservation: async (providerIds, operation) => {
          reserve(providerIds)
          return operation([...new Set(providerIds)])
        },
        set: vi.fn(async () => {
          throw new Error('Unexpected existing Session update.')
        })
      }
    })

    await h.controller.ensureStarted(44100, { attached: true })
    const run = await h.lastOptions().tasks!.startRun({
      project: project.id,
      prompt: 'Research.',
      computeHostIds: ['ssh:requested']
    })

    expect(run.preferredComputeHostIds).toEqual(['ssh:authority'])
    expect(reserve).toHaveBeenCalledWith(['ssh:requested'])
  })

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

  it('keeps the bearer token out of daemon stdout when the service starts', async () => {
    const h = makeController()
    log.info.mockClear()

    const result = await h.controller.ensureStarted(44100, { attached: false })

    expect(result.url).toBe('http://127.0.0.1:44100/?token=tok-123')
    expect(log.info).toHaveBeenCalledWith('Open Science Web: http://127.0.0.1:44100/', {
      host: '127.0.0.1',
      port: 44100,
      attached: false
    })
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('tok-123')
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

  it('keeps replacement state when start is requested while the previous server closes', async () => {
    let releaseFirstClose: (() => void) | undefined
    const firstCloseGate = new Promise<void>((resolve) => {
      releaseFirstClose = resolve
    })
    const firstClose = vi.fn(async () => firstCloseGate)
    const startServer = vi.fn(async (options: StartOptions) => ({
      port: options.port,
      closeExternalConnections: vi.fn(),
      close: options.port === 44100 ? firstClose : vi.fn().mockResolvedValue(undefined)
    }))
    let statePort: number | undefined
    const h = makeController({
      startServer,
      writeState: vi.fn(async (_configRoot, state) => {
        statePort = state.port
      }),
      removeState: vi.fn(async () => {
        statePort = undefined
      })
    })
    const stopped = vi.fn()
    h.controller.onStopped(stopped)
    await h.controller.ensureStarted(44100, { attached: true })

    const close = h.controller.close()
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce())
    const restart = h.controller.ensureStarted(44101, { attached: true })
    releaseFirstClose?.()
    await Promise.all([close, restart])

    expect(startServer).toHaveBeenCalledTimes(2)
    expect(statePort).toBe(44101)
    expect(stopped).toHaveBeenCalledOnce()
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
        return invocation.args[0]
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

  it('recovers a terminal Task run after the Web service controller is reconstructed', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-task-runs-'))
    const project = {
      id: 'project-restart',
      name: 'Project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    const sessions: unknown[] = []
    const applicationCommands = {
      localWeb: { commandNames: () => [], invoke: vi.fn() },
      remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() },
      task: {
        commandNames: () => [],
        invoke: vi.fn(async (name, invocation) => {
          if (name === 'projects:list') return [project]
          if (name === 'sessions:load-all') return { sessions, manifest: { version: 1 } }
          if (name === 'sessions:save-session') {
            sessions.splice(0, sessions.length, invocation.args[0])
            return invocation.args[0]
          }
          throw new Error(`Unexpected Task command: ${name}`)
        })
      }
    } satisfies Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    const taskAgent: TaskAgentPort = {
      withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
      listAttachedSessionIds: vi.fn(async () => []),
      createSession: vi.fn(async () => ({ sessionId: 'session-restart' })),
      resumeSession: vi.fn(async (request) => ({ sessionId: request.sessionId })),
      setPermissionProfile: vi.fn(async () => undefined),
      cancelPrompt: vi.fn(async () => undefined),
      prompt: vi.fn(async () => undefined)
    }
    const controllers: ReturnType<typeof makeController>[] = []

    try {
      const first = makeController(
        {
          resolveConfigRoot: () => configRoot,
          createTaskRunJournal: (root) => new FileTaskRunJournal(root)
        },
        vi.fn(),
        applicationCommands,
        { taskAgent }
      )
      controllers.push(first)
      await first.controller.ensureStarted(44100, { attached: false })
      const started = await first.lastOptions().tasks!.startRun({
        project: project.id,
        prompt: 'Research across a restart.'
      })
      await vi.waitFor(() => {
        expect(first.lastOptions().tasks!.getRun(started.id).status).toBe('completed')
      })
      const terminal = first.lastOptions().tasks!.getRun(started.id)
      expect(terminal.status).toBe('completed')
      await first.controller.dispose()

      const second = makeController(
        {
          resolveConfigRoot: () => configRoot,
          createTaskRunJournal: (root) => new FileTaskRunJournal(root)
        },
        vi.fn(),
        applicationCommands,
        { taskAgent }
      )
      controllers.push(second)
      await second.controller.ensureStarted(44101, { attached: false })

      expect(second.lastOptions().tasks!.getRun(started.id)).toMatchObject({
        id: started.id,
        sessionId: started.sessionId,
        projectId: project.id,
        status: 'completed'
      })
    } finally {
      await Promise.all(
        controllers.map(({ controller }) => controller.dispose().catch(() => undefined))
      )
      await rm(configRoot, { recursive: true, force: true })
    }
  })

  it('marks a recorded running Task as failed when the process restarts', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-task-runs-'))
    const journal = new FileTaskRunJournal(configRoot)
    await journal.replace([
      {
        id: 'run-interrupted',
        sessionId: 'session-interrupted',
        projectId: 'project-interrupted',
        cwd: configRoot,
        status: 'running',
        startedAt: 10,
        artifacts: [],
        preferredComputeHostIds: []
      }
    ])
    const h = makeController({
      resolveConfigRoot: () => configRoot,
      createTaskRunJournal: (root) => new FileTaskRunJournal(root)
    })

    try {
      await h.controller.ensureStarted(44100, { attached: false })
      const tasks = h.lastOptions().tasks!

      expect(tasks.getRun('run-interrupted')).toMatchObject({
        status: 'failed',
        failureCode: 'process_restarted',
        error: 'Run interrupted because Open Science restarted.'
      })
      await expect(tasks.cancelRun('run-interrupted')).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'process_restarted'
      })
      await expect(journal.load()).resolves.toEqual([
        expect.objectContaining({
          id: 'run-interrupted',
          status: 'failed',
          failureCode: 'process_restarted'
        })
      ])
    } finally {
      await h.controller.dispose().catch(() => undefined)
      await rm(configRoot, { recursive: true, force: true })
    }
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
