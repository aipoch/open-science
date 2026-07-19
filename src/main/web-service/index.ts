import { join } from 'node:path'

import { app } from 'electron'

import { createLogger } from '../logger'
import { resolveConfigRoot } from '../storage-root'
import { loadOrCreateWebToken } from './auth'
import { startWebHttpServer } from './http-server'
import type { RpcCapture } from './rpc-capture'
import { removeWebServiceState, writeWebServiceState } from './state-file'

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
  isRunning: () => boolean
  // The live port when serving, else undefined (used to build the tray's "Open Web" URL).
  runningPort: () => number | undefined
}

const buildAuthenticatedWebUrl = async (port: number): Promise<string> => {
  const token = await loadOrCreateWebToken(resolveConfigRoot())
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

// Builds the controller. `rpc` is the always-installed capture layer (so handlers registered before any
// serving are reachable over HTTP); `requestQuit` quits the whole app when a dedicated headless daemon
// is asked to shut down. An attached service instead only tears itself down and leaves the app running.
const createWebServiceController = ({
  rpc,
  requestQuit
}: {
  rpc: RpcCapture
  requestQuit: () => void
}): WebServiceController => {
  let running: { close: () => Promise<void>; port: number; configRoot: string } | undefined
  let starting: Promise<{ port: number; url: string }> | undefined

  const close = async (): Promise<void> => {
    const current = running
    running = undefined
    if (!current) return
    await current.close()
  }

  const start = async (port: number, attached: boolean): Promise<{ port: number; url: string }> => {
    const configRoot = resolveConfigRoot()
    const token = await loadOrCreateWebToken(configRoot)
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port,
      token,
      staticRoot: join(app.getAppPath(), 'out', 'web'),
      rpc,
      // Attached: a graceful shutdown request stops only the web service (the app keeps running). A
      // dedicated daemon quits the process, which is what stops it serving.
      onShutdownRequest: attached ? () => void close() : requestQuit,
      bootstrap: {
        appName: app.getName(),
        appVersion: app.getVersion(),
        platform: process.platform,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node
        }
      }
    })

    running = {
      port: server.port,
      configRoot,
      close: async () => {
        try {
          await server.close()
        } finally {
          await removeWebServiceState(configRoot)
        }
      }
    }

    try {
      await writeWebServiceState(configRoot, {
        pid: process.pid,
        port: server.port,
        startedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        attached
      })
    } catch (error) {
      await close()
      throw error
    }

    const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`
    createLogger('web-service').info('local web service started', {
      host: '127.0.0.1',
      port: server.port,
      attached
    })
    console.log(`Open Science Web: ${url}`)
    return { port: server.port, url }
  }

  const ensureStarted = async (
    port: number,
    { attached }: { attached: boolean }
  ): Promise<{ port: number; url: string }> => {
    if (running) return { port: running.port, url: await buildAuthenticatedWebUrl(running.port) }
    if (starting) return starting
    starting = start(port, attached).finally(() => {
      starting = undefined
    })
    return starting
  }

  return {
    ensureStarted,
    close,
    isRunning: () => running !== undefined,
    runningPort: () => running?.port
  }
}

export { parseWebModeOptions } from './options'
export { buildAuthenticatedWebUrl, createWebServiceController }
