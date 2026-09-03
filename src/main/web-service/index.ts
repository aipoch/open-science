import { join } from 'node:path'

import { app } from 'electron'

import type { ApplicationCommandComposition } from '../application-command-composition'
import { createLogger } from '../logger'
import type { ApplicationEventSource } from '../application-events'
import type { PermissionApprovalPresence } from '../permission-approval-presence'
import type { TaskControlPorts } from '../tasks/task-control-ports'
import { FileTaskRunJournal, type TaskRunJournal } from '../tasks/task-run-journal'
import type { TaskAgentPort, TaskComputePreferencePort } from '../tasks/task-runner'
import { resolveConfigRoot } from '../storage-root'
import { loadOrCreateWebToken } from './auth'
import { startWebHttpServer, type ExternalWebAccess, type RunningWebServer } from './http-server'
import { projectTaskRuntimeEvents } from './application-event-projections'
import { HeadlessTaskApi } from './task-api'
import { removeWebServiceState, writeWebServiceState, type WebServiceState } from './state-file'

const log = createLogger('web-service')

// A single-instance web service that can be started at launch (--serve) or later, on demand, when a
// second launch forwards a --serve request to the already-running instance. Starting is idempotent: a
// second ensureStarted while one is running (or in flight) reuses it rather than binding a new port.
export type WebServiceController = {
  // Starts serving on `port` if not already serving; returns the live port and authenticated URL.
  // `attached` records whether the service rides on a pre-existing instance (see WebServiceState).
  ensureStarted: (
    port: number,
    opts: { attached: boolean }
  ) => Promise<{ port: number; url: string }>
  // Stops the web service and removes its state file. Idempotent; safe to call when not running.
  close: () => Promise<void>
  // Permanently closes the service and its Task adapter. Used only by application shutdown.
  dispose: () => Promise<void>
  // Invalidates retained replay access and closes remote sockets without disturbing local clients.
  closeExternalConnections: (principalId?: string) => void
  // Subscribes to actual server stops, including attached shutdown requests from the CLI.
  onStopped: (listener: () => void) => () => void
  isRunning: () => boolean
  // The live port when serving, else undefined (used to build the tray's "Open Web" URL).
  runningPort: () => number | undefined
}

// The I/O the controller depends on, injectable so the idempotency/attached logic is unit-testable
// without Electron, the network, or the filesystem. Production callers omit these and get the real ones.
export type WebServiceControllerDeps = {
  startServer: (options: Parameters<typeof startWebHttpServer>[0]) => Promise<RunningWebServer>
  resolveConfigRoot: () => string
  loadWebToken: (configRoot: string) => Promise<string>
  writeState: (configRoot: string, state: Omit<WebServiceState, 'configRoot'>) => Promise<unknown>
  removeState: (configRoot: string) => Promise<void>
  createTaskRunJournal: (configRoot: string) => TaskRunJournal
  appInfo: () => {
    appPath: string
    appName: string
    appVersion: string
    versions: { electron: string; chrome: string; node: string }
    pid: number
  }
}

const authUrl = (token: string, port: number): string =>
  `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`

const buildAuthenticatedWebUrl = async (port: number): Promise<string> =>
  authUrl(await loadOrCreateWebToken(resolveConfigRoot()), port)

// Builds the controller over application-owned narrow command views. `requestQuit` quits the whole
// app when a dedicated headless daemon is asked to shut down. An attached service instead only tears
// itself down.
const createWebServiceController = (
  {
    applicationCommands,
    requestQuit,
    externalAccess,
    applicationEvents,
    permissionApprovalPresence,
    taskAgent,
    taskControls,
    computePreferences
  }: {
    applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
    requestQuit: () => void
    externalAccess?: ExternalWebAccess
    applicationEvents: ApplicationEventSource
    permissionApprovalPresence?: PermissionApprovalPresence
    taskAgent: TaskAgentPort
    taskControls?: TaskControlPorts
    computePreferences: TaskComputePreferencePort
  },
  deps: Partial<WebServiceControllerDeps> = {}
): WebServiceController => {
  const startServer = deps.startServer ?? startWebHttpServer
  const getConfigRoot = deps.resolveConfigRoot ?? resolveConfigRoot
  const loadWebToken = deps.loadWebToken ?? loadOrCreateWebToken
  const writeState = deps.writeState ?? writeWebServiceState
  const removeState = deps.removeState ?? removeWebServiceState
  const createTaskRunJournal = deps.createTaskRunJournal ?? ((root) => new FileTaskRunJournal(root))
  const appInfo =
    deps.appInfo ??
    (() => ({
      appPath: app.getAppPath(),
      appName: app.getName(),
      appVersion: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      pid: process.pid
    }))
  const tasks = new HeadlessTaskApi(
    {
      commands: applicationCommands.task,
      agent: taskAgent,
      controls: taskControls,
      computePreferences
    },
    {
      runJournal: createTaskRunJournal(getConfigRoot()),
      subscribeEvents: (listener) =>
        applicationEvents.subscribe((event) => {
          for (const runtimeEvent of projectTaskRuntimeEvents(event)) listener(runtimeEvent)
        })
    }
  )
  let running:
    | {
        close: () => Promise<void>
        closeExternalConnections: (principalId?: string) => void
        port: number
        configRoot: string
      }
    | undefined
  let starting: Promise<{ port: number; url: string }> | undefined
  let closing: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  let disposed = false
  const stoppedListeners = new Set<() => void>()

  const closeRunning = async (): Promise<void> => {
    const current = running
    running = undefined
    if (!current) return
    try {
      await current.close()
    } finally {
      for (const listener of stoppedListeners) listener()
    }
  }

  const close = (): Promise<void> => {
    if (closing) return closing
    const operation = (async () => {
      const pending = starting
      if (pending) await pending.catch(() => undefined)
      await closeRunning()
    })()
    const settled = operation.finally(() => {
      if (closing === settled) closing = undefined
    })
    closing = settled
    return settled
  }

  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    disposal = (async () => {
      try {
        await close()
      } finally {
        await tasks.dispose()
      }
    })()
    return disposal
  }

  const start = async (port: number, attached: boolean): Promise<{ port: number; url: string }> => {
    const configRoot = getConfigRoot()
    await tasks.initialize()
    const token = await loadWebToken(configRoot)
    const info = appInfo()
    const server = await startServer({
      host: '127.0.0.1',
      port,
      token,
      staticRoot: join(info.appPath, 'out', 'web'),
      applicationCommands: {
        localWeb: applicationCommands.localWeb,
        remoteWeb: applicationCommands.remoteWeb
      },
      applicationEvents,
      permissionApprovalPresence,
      externalAccess,
      tasks,
      // Attached: a graceful shutdown request stops only the web service (the app keeps running). A
      // dedicated daemon quits the process, which is what stops it serving.
      onShutdownRequest: attached ? () => void close() : requestQuit,
      bootstrap: {
        appName: info.appName,
        appVersion: info.appVersion,
        configRoot,
        platform: process.platform,
        versions: info.versions
      }
    })

    running = {
      port: server.port,
      configRoot,
      closeExternalConnections: server.closeExternalConnections,
      close: async () => {
        try {
          await server.close()
        } finally {
          await removeState(configRoot)
        }
      }
    }

    try {
      await writeState(configRoot, {
        pid: info.pid,
        port: server.port,
        startedAt: new Date().toISOString(),
        appVersion: info.appVersion,
        attached
      })
    } catch (error) {
      await closeRunning()
      throw error
    }

    const url = authUrl(token, server.port)
    log.info(`Open Science Web: http://127.0.0.1:${server.port}/`, {
      host: '127.0.0.1',
      port: server.port,
      attached
    })
    return { port: server.port, url }
  }

  const ensureStarted = async (
    port: number,
    { attached }: { attached: boolean }
  ): Promise<{ port: number; url: string }> => {
    if (disposed) throw new Error('Web service controller is disposed.')
    if (closing) await closing
    if (disposed) throw new Error('Web service controller is disposed.')
    if (running) {
      const token = await loadWebToken(running.configRoot)
      return { port: running.port, url: authUrl(token, running.port) }
    }
    if (starting) return starting
    starting = start(port, attached).finally(() => {
      starting = undefined
    })
    return starting
  }

  return {
    ensureStarted,
    close,
    dispose,
    closeExternalConnections: (principalId) => running?.closeExternalConnections(principalId),
    onStopped: (listener) => {
      stoppedListeners.add(listener)
      return () => stoppedListeners.delete(listener)
    },
    isRunning: () => running !== undefined,
    runningPort: () => running?.port
  }
}

export { DEFAULT_WEB_PORT, parseWebModeOptions } from './options'
export { buildAuthenticatedWebUrl, createWebServiceController }
