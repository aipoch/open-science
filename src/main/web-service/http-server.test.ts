import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() }
}))

import { broadcastToRenderers } from '../renderer-broadcast'
import { startWebHttpServer, type RunningWebServer } from './http-server'

const roots: string[] = []
const servers: RunningWebServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('startWebHttpServer', () => {
  it('authenticates, serves the UI, invokes RPC, and mirrors events over WebSocket', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Web test</title>')
    const rpc = {
      channels: () => ['test:echo'],
      invoke: vi.fn(async (_channel: string, _client: string, args: unknown[]) => args[0]),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(base, { redirect: 'manual' })).status).toBe(401)
    const login = await fetch(`${base}/?token=test-token&project=project-1&session=session-1`, {
      redirect: 'manual'
    })
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/?project=project-1&session=session-1')
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]

    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { cookie } })
    expect(await bootstrap.json()).toMatchObject({
      appName: 'Open Science',
      rpcChannels: ['test:echo']
    })

    const rpcResponse = await fetch(`${base}/rpc/test%3Aecho`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-open-science-client': 'test-client'
      },
      body: JSON.stringify({ args: [{ value: 1 }] })
    })
    expect(await rpcResponse.json()).toEqual({ ok: true, result: { value: 1 } })

    // Channels the browser reimplements client-side (native-dialog / window handlers) are rejected
    // over /rpc without ever reaching the handler.
    const blockedResponse = await fetch(`${base}/rpc/window%3Aclose`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] })
    })
    expect(blockedResponse.status).toBe(403)
    expect(await blockedResponse.json()).toMatchObject({ ok: false })
    expect(rpc.invoke).toHaveBeenCalledTimes(1)

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?client=test-client`, {
      headers: { cookie, origin: base }
    })
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const message = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(data.toString()))
    )
    broadcastToRenderers('test:event', { ready: true })
    expect(JSON.parse(await message)).toEqual({
      channel: 'test:event',
      payload: { ready: true }
    })
    socket.close()
  })

  it('authenticates shutdown requests before invoking the callback', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const onShutdownRequest = vi.fn()
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      onShutdownRequest,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const endpoint = `http://127.0.0.1:${server.port}/api/shutdown`

    expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
    expect(onShutdownRequest).not.toHaveBeenCalled()

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' }
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    await vi.waitFor(() => expect(onShutdownRequest).toHaveBeenCalledOnce())
  })
})
