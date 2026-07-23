import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { net } from 'electron'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() }
}))

import { broadcastToRenderers } from '../renderer-broadcast'
import { startWebHttpServer, type RunningWebServer } from './http-server'
import { TaskApiError } from './task-api'

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

    const publicSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`
    )
    await new Promise<void>((resolve) => publicSocket.once('open', resolve))
    const publicMessage = new Promise<string>((resolve) =>
      publicSocket.once('message', (data) => resolve(data.toString()))
    )
    broadcastToRenderers('acp:event', { sessionId: 'session-1', kind: 'message', text: 'Hi' })
    expect(JSON.parse(await publicMessage)).toEqual({
      type: 'run.event',
      data: { sessionId: 'session-1', kind: 'message', text: 'Hi' }
    })
    publicSocket.close()
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

  it('serves the versioned task API without exposing internal RPC channels', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const tasks = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'running',
        startedAt: 1,
        artifacts: []
      }),
      getRun: vi.fn().mockReturnValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        output: 'Done',
        artifacts: []
      }),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn(),
      releaseArtifact: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const headers = { authorization: 'Bearer test-token' }

    const projects = await fetch(`${base}/api/v1/projects`, { headers })
    expect(projects.status).toBe(200)
    expect(await projects.json()).toEqual({ data: [{ id: 'project-1', name: 'Research' }] })

    const started = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', prompt: 'Research this.' })
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ data: { id: 'run-1', status: 'running' } })
    expect(tasks.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.'
    })

    const status = await fetch(`${base}/api/v1/runs/run-1`, { headers })
    expect(await status.json()).toMatchObject({ data: { status: 'completed', output: 'Done' } })

    tasks.startRun.mockRejectedValueOnce(
      new TaskApiError('session_busy', 'Session already has an active run: session-1')
    )
    const conflict = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', sessionId: 'session-1', prompt: 'Again' })
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: {
        code: 'session_busy',
        message: 'Session already has an active run: session-1'
      }
    })
  })

  it('streams an acquired artifact and always releases its capability', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response('artifact bytes', {
        headers: { 'content-type': 'text/plain', 'content-length': '14' }
      })
    )
    const tasks = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn().mockResolvedValue({
        resourceId: 'resource-1',
        url: 'open-science-preview://resource-1/report.txt',
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 14
      }),
      releaseArtifact: vi.fn().mockResolvedValue(undefined)
    }
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
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const download = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/artifacts/artifact-1/content`,
      { headers: { authorization: 'Bearer test-token' } }
    )
    expect(await download.text()).toBe('artifact bytes')
    expect(download.headers.get('content-disposition')).toContain('report.txt')
    expect(tasks.acquireArtifact).toHaveBeenCalledWith('artifact-1')
    expect(tasks.releaseArtifact).toHaveBeenCalledWith('resource-1')
  })

  it('cancels the artifact stream and releases its capability when the client disconnects', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const cancelStream = vi.fn()
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024))
          },
          cancel: cancelStream
        }),
        { headers: { 'content-type': 'application/octet-stream' } }
      )
    )
    const tasks = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn().mockResolvedValue({
        resourceId: 'resource-disconnect',
        url: 'open-science-preview://resource-disconnect/report.bin',
        name: 'report.bin',
        mimeType: 'application/octet-stream',
        size: 2 * 1024 * 1024
      }),
      releaseArtifact: vi.fn().mockResolvedValue(undefined)
    }
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
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${server.port}/api/v1/artifacts/artifact-disconnect/content`,
        { headers: { authorization: 'Bearer test-token' } },
        (response) => {
          response.once('data', () => {
            response.destroy()
            resolve()
          })
        }
      )
      request.once('error', reject)
      request.end()
    })

    await vi.waitFor(() => {
      expect(cancelStream).toHaveBeenCalledOnce()
      expect(tasks.releaseArtifact).toHaveBeenCalledWith('resource-disconnect')
    })
  })
})
