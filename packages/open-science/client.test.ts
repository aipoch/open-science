import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectToOpenScience, OpenScienceClient } from './index.mjs'

const response = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenScienceClient', () => {
  it('starts and waits for a run through the authenticated versioned API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(202, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'running',
            startedAt: 1,
            artifacts: []
          }
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'running',
            startedAt: 1,
            artifacts: []
          }
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            status: 'completed',
            startedAt: 1,
            completedAt: 2,
            output: 'Done',
            artifacts: []
          }
        })
      )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch,
      sleep: vi.fn().mockResolvedValue(undefined)
    })

    const started = await client.startRun({ project: 'project-1', prompt: 'Research this.' })
    const completed = await client.waitForRun(started.id)

    expect(completed).toMatchObject({ status: 'completed', output: 'Done' })
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:44100/api/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' })
      })
    )
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('surfaces stable API errors without including the authentication token', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(404, {
        error: { code: 'project_not_found', message: 'Project not found: missing' }
      })
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'do-not-leak',
      fetch
    })

    await expect(client.listSessions('missing')).rejects.toMatchObject({
      code: 'project_not_found',
      status: 404,
      message: 'Project not found: missing'
    })
    await expect(client.listSessions('missing')).rejects.not.toThrow('do-not-leak')
  })

  it('covers project, session, artifact, and authenticated download operations', async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      if (path === '/api/v1/projects' && init?.method === 'POST') {
        return response(201, { data: { id: 'project-1', name: 'Created' } })
      }
      if (path === '/api/v1/projects') return response(200, { data: [] })
      if (path === '/api/v1/sessions') return response(200, { data: [] })
      if (path === '/api/v1/sessions/session-1') {
        return response(200, { data: { id: 'session-1', status: 'idle' } })
      }
      if (path === '/api/v1/sessions/session-1/artifacts') {
        return response(200, { data: [{ id: 'artifact-1' }] })
      }
      if (path === '/api/v1/artifacts/artifact-1/content') return new Response('file bytes')
      throw new Error(`Unexpected path: ${path}`)
    })
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch
    })

    await client.listProjects()
    await client.createProject({ name: 'Created' })
    await client.listSessions('project-1')
    await client.getSession('session-1')
    await client.listArtifacts('session-1')
    expect(await (await client.downloadArtifact('artifact-1')).text()).toBe('file bytes')

    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer token-1' })
    }
  })

  it('yields normalized public events and closes the WebSocket iterator', async () => {
    class FakeWebSocket {
      static instance: FakeWebSocket
      readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>()
      closed = false

      constructor(readonly url: URL) {
        FakeWebSocket.instance = this
      }

      addEventListener(name: string, listener: (event: { data?: string }) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      }

      emit(name: string, event: { data?: string } = {}): void {
        for (const listener of this.listeners.get(name) ?? []) listener(event)
      }

      close(): void {
        this.closed = true
        this.emit('close')
      }
    }
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: FakeWebSocket as never })[Symbol.asyncIterator]()
    FakeWebSocket.instance.emit('open')
    const next = events.next()
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify({ type: 'run.event', data: { sessionId: 'session-1' } })
    })

    await expect(next).resolves.toEqual({
      value: { type: 'run.event', data: { sessionId: 'session-1' } },
      done: false
    })
    await events.return?.()
    expect(FakeWebSocket.instance.closed).toBe(true)
  })

  it('discovers a daemon from its state and token files before returning a client', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-sdk-'))
    roots.push(configRoot)
    await writeFile(
      join(configRoot, 'web-service.json'),
      JSON.stringify({ pid: process.pid, port: 44100, startedAt: new Date().toISOString() })
    )
    await writeFile(join(configRoot, 'web-token'), 'discovered-token\n')
    const fetch = vi.fn().mockImplementation(async () => response(200, { appName: 'Open Science' }))

    const client = await connectToOpenScience({ configRoot, fetch })

    await expect(client.health()).resolves.toEqual({ appName: 'Open Science' })
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:44100/api/bootstrap',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer discovered-token' })
      })
    )
  })
})
