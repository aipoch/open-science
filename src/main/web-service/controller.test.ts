import { describe, expect, it, vi } from 'vitest'

import type { WebRpcRouter } from '../ipc-handler-registry'
import { createWebServiceController, type WebServiceControllerDeps } from './index'

type StartOptions = Parameters<WebServiceControllerDeps['startServer']>[0]

// Builds a controller over fully faked I/O so the idempotency + attached logic is exercised without
// Electron, the network, or the filesystem. `startServer` echoes the requested port and records the
// options it was given (so the test can drive the captured onShutdownRequest).
const makeController = (
  overrides: Partial<WebServiceControllerDeps> = {},
  requestQuit = vi.fn()
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
    { rpc: {} as WebRpcRouter, requestQuit },
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
