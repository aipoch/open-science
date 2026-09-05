import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PUBLIC_TERMINAL_FIXTURE } from '../../test/fixtures/renderer-contract-certification'
import { connectToOpenScience, OpenScienceClient } from './index.mjs'

const response = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })

class ControllableWebSocket {
  static instance: ControllableWebSocket

  readonly listeners = new Map<
    string,
    Array<(event: { code?: number; data?: string; reason?: string }) => void>
  >()
  closed = false

  constructor(readonly url: URL) {
    ControllableWebSocket.instance = this
  }

  addEventListener(
    name: string,
    listener: (event: { code?: number; data?: string; reason?: string }) => void
  ): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  emit(name: string, event: { code?: number; data?: string; reason?: string } = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenScienceClient', () => {
  it('pins the SDK method inventory without exposing management capabilities', () => {
    expect(Object.getOwnPropertyNames(OpenScienceClient.prototype).sort()).toEqual(
      [
        'constructor',
        'health',
        'listProjects',
        'createProject',
        'updateProject',
        'getProjectSessionDefaults',
        'updateProjectSessionDefaults',
        'listSessions',
        'getSession',
        'getSessionConfiguration',
        'updateSessionConfiguration',
        'getAgentRouting',
        'updateAgentRouting',
        'getSessionPlan',
        'respondSessionPlan',
        'startRun',
        'getRun',
        'cancelRun',
        'waitForRun',
        'listArtifacts',
        'downloadArtifact',
        'events',
        'request',
        'throwResponseError'
      ].sort()
    )
  })

  it('uses versioned endpoints for Session, Project-default, and Agent-routing configuration', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(200, { data: { ok: true } }))
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch
    })

    await client.getProjectSessionDefaults('project/1')
    await client.updateProjectSessionDefaults('project/1', {
      expectedUpdatedAt: 2,
      patch: { memoryEnabled: false }
    })
    await client.getSessionConfiguration('session/1')
    await client.updateSessionConfiguration('session/1', {
      expectedRevision: 3,
      memoryEnabled: false
    })
    await client.getAgentRouting()
    await client.updateAgentRouting({ framework: 'codex' })

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:44100/api/v1/projects/project%2F1/session-defaults',
      'http://127.0.0.1:44100/api/v1/projects/project%2F1/session-defaults',
      'http://127.0.0.1:44100/api/v1/sessions/session%2F1/config',
      'http://127.0.0.1:44100/api/v1/sessions/session%2F1/config',
      'http://127.0.0.1:44100/api/v1/settings/agent-routing',
      'http://127.0.0.1:44100/api/v1/settings/agent-routing'
    ])
    expect(fetch.mock.calls.map(([, options]) => options?.method ?? 'GET')).toEqual([
      'GET',
      'PATCH',
      'GET',
      'PATCH',
      'GET',
      'PATCH'
    ])
  })

  it('starts and waits for a run through the authenticated versioned API', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(202, {
          data: {
            id: 'run-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            cwd: '/workspace/research',
            status: 'running',
            startedAt: 1,
            preferredComputeHostIds: ['ssh:authority'],
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
            cwd: '/workspace/research',
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
            cwd: '/workspace/research',
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

    const started = await client.startRun(
      {
        project: 'project-1',
        prompt: 'Research this.',
        cwd: '/workspace/research',
        permissionProfile: 'auto',
        skillIds: ['literature-review'],
        computeHostIds: ['ssh:alpha', 'ssh:beta']
      },
      { idempotencyKey: 'start-run-1' }
    )
    const completed = await client.waitForRun(started.id)

    expect(completed).toMatchObject({
      cwd: '/workspace/research',
      status: 'completed',
      output: 'Done'
    })
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:44100/api/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret-token',
          'idempotency-key': 'start-run-1'
        }),
        body: JSON.stringify({
          project: 'project-1',
          prompt: 'Research this.',
          cwd: '/workspace/research',
          permissionProfile: 'auto',
          skillIds: ['literature-review'],
          computeHostIds: ['ssh:alpha', 'ssh:beta']
        })
      })
    )
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('returns a running run only when actionable waiting is explicitly enabled', async () => {
    const attention = {
      kind: 'plan-approval',
      plan: { artifactVersionId: 'plan-version', revision: 2 }
    }
    const fetch = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          id: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          status: 'running',
          startedAt: 1,
          artifacts: [],
          attention
        }
      })
    )
    const sleep = vi.fn().mockResolvedValue(undefined)
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch,
      sleep
    })

    await expect(client.waitForRun('run-1', { returnOnAttention: true })).resolves.toMatchObject({
      status: 'running',
      attention
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops waiting after the requested timeout without cancelling the run', async () => {
    const fetch = vi.fn().mockImplementation(async () =>
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
    const sleep = vi.fn(async (milliseconds: number) => {
      vi.setSystemTime(Date.now() + milliseconds)
    })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'secret-token',
        fetch,
        sleep
      })

      await expect(
        client.waitForRun('run-1', { pollIntervalMs: 250, timeoutMs: 500 })
      ).rejects.toMatchObject({
        code: 'timeout',
        message: 'Timed out waiting for run run-1.'
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting when the timeout expires during an in-flight polling request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn((_input: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'secret-token',
        fetch
      })
      let outcome: unknown = 'still-pending'

      void client.waitForRun('run-1', { timeoutMs: 500 }).then(
        () => {
          outcome = 'resolved'
        },
        (error: unknown) => {
          outcome = error
        }
      )
      expect(fetch).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(500)

      expect(outcome).toMatchObject({
        code: 'timeout',
        message: 'Timed out waiting for run run-1.'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels one run through the explicit server operation', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(200, {
        data: {
          id: 'run/1',
          sessionId: 'session-1',
          projectId: 'project-1',
          status: 'cancelled',
          startedAt: 1,
          cancelRequestedAt: 2,
          cancelledAt: 3,
          completedAt: 3,
          artifacts: []
        }
      })
    )
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch
    })

    await expect(client.cancelRun('run/1')).resolves.toMatchObject({
      id: 'run/1',
      status: 'cancelled'
    })
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:44100/api/v1/runs/run%2F1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' })
      })
    )
  })

  it('honors caller cancellation before polling without invoking run cancellation', async () => {
    const fetch = vi.fn()
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch
    })
    const abortController = new AbortController()
    const cancellation = new Error('caller cancelled the wait')
    abortController.abort(cancellation)

    await expect(client.waitForRun('run-1', { signal: abortController.signal })).rejects.toBe(
      cancellation
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(client.cancelRun).toEqual(expect.any(Function))
    expect(client).not.toHaveProperty('permissions')
    expect(client).not.toHaveProperty('specialists')
    expect(client).not.toHaveProperty('compute')
    expect(client).not.toHaveProperty('notebook')
    expect(client).not.toHaveProperty('notebookEnv')
    expect(client).not.toHaveProperty('runtime')
  })

  it('honors caller cancellation while a polling request is in flight', async () => {
    const fetch = vi.fn((_input: string, init?: RequestInit) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch
    })
    const abortController = new AbortController()
    const cancellation = new Error('caller cancelled the in-flight poll')
    let outcome: unknown = 'still-pending'

    void client.waitForRun('run-1', { signal: abortController.signal }).then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    abortController.abort(cancellation)

    await vi.waitFor(() => expect(outcome).toBe(cancellation))
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

  it('applies the client request timeout while an SDK request is in flight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn((_input: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'secret-token',
        fetch,
        requestTimeoutMs: 30_000
      })
      let outcome: unknown = 'still-pending'

      void client.getRun('run-1').then(
        () => {
          outcome = 'resolved'
        },
        (error: unknown) => {
          outcome = error
        }
      )

      await vi.advanceTimersByTimeAsync(30_000)

      expect(outcome).toMatchObject({ code: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the request timeout active while a JSON response body is being consumed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn((_input: string, init?: RequestInit) => {
        const signal = init?.signal
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
        } as Response)
      })
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'secret-token',
        fetch,
        requestTimeoutMs: 30_000
      })
      let outcome: unknown = 'still-pending'

      void client.getRun('run-1').then(
        () => {
          outcome = 'resolved'
        },
        (error: unknown) => {
          outcome = error
        }
      )

      await vi.advanceTimersByTimeAsync(30_000)

      expect(outcome).toMatchObject({ code: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the request timeout active while an artifact response body is streaming', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn((_input: string, init?: RequestInit) => {
        const signal = init?.signal
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true
                })
              }
            }),
            { status: 200 }
          )
        )
      })
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'secret-token',
        fetch,
        requestTimeoutMs: 30_000
      })
      const response = await client.downloadArtifact('artifact-1')
      let outcome: unknown = 'still-pending'
      void response.text().then(
        () => {
          outcome = 'resolved'
        },
        (error: unknown) => {
          outcome = error
        }
      )

      await vi.advanceTimersByTimeAsync(30_000)

      expect(outcome).toMatchObject({ code: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors per-request cancellation while an SDK request is in flight', async () => {
    const fetch = vi.fn((_input: string, init?: RequestInit) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'secret-token',
      fetch
    })
    const abortController = new AbortController()
    const cancellation = new Error('caller cancelled the SDK request')
    let outcome: unknown = 'still-pending'

    void client.getRun('run-1', { signal: abortController.signal }).then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    abortController.abort(cancellation)

    await vi.waitFor(() => expect(outcome).toBe(cancellation))
  })

  it('covers project, session, artifact, and authenticated download operations', async () => {
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      if (path === '/api/v1/projects' && init?.method === 'POST') {
        return response(201, { data: { id: 'project-1', name: 'Created' } })
      }
      if (path === '/api/v1/projects/project%2F1' && init?.method === 'PATCH') {
        return response(200, {
          data: { id: 'project-1', name: 'Created', hasAgentContext: true }
        })
      }
      if (path === '/api/v1/projects') return response(200, { data: [] })
      if (path === '/api/v1/sessions') return response(200, { data: [] })
      if (path === '/api/v1/sessions/session%2F1') {
        return response(200, { data: { id: 'session-1', status: 'idle' } })
      }
      if (path === '/api/v1/sessions/session%2F1/plan' && init?.method !== 'POST') {
        return response(200, {
          data: { artifactVersionId: 'plan-version', revision: 2 }
        })
      }
      if (path === '/api/v1/sessions/session%2F1/plan/respond') {
        return response(200, { data: { changed: true } })
      }
      if (path === '/api/v1/sessions/session%2F1/artifacts') {
        return response(200, { data: [{ id: 'artifact-1' }] })
      }
      if (path === '/api/v1/artifacts/artifact%2F1/content') return new Response('file bytes')
      throw new Error(`Unexpected path: ${path}`)
    })
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch
    })

    await client.listProjects()
    await client.createProject({ name: 'Created', agentContext: 'Always cite sources.' })
    await client.updateProject('project/1', {
      expectedUpdatedAt: 7,
      agentContext: 'Prefer Python.'
    })
    await client.listSessions('project-1')
    await client.getSession('session/1')
    await client.getSessionPlan('session/1')
    await client.respondSessionPlan('session/1', {
      decision: 'approved',
      artifactVersionId: 'plan-version',
      expectedRevision: 2
    })
    await client.listArtifacts('session/1')
    expect(await (await client.downloadArtifact('artifact/1')).text()).toBe('file bytes')

    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer token-1' })
    }
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ name: 'Created', agentContext: 'Always cite sources.' })
    )
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ expectedUpdatedAt: 7, agentContext: 'Prefer Python.' })
    )
    expect(
      fetch.mock.calls.map(([input]) => new URL(input).pathname + new URL(input).search)
    ).toEqual([
      '/api/v1/projects',
      '/api/v1/projects',
      '/api/v1/projects/project%2F1',
      '/api/v1/sessions?project=project-1',
      '/api/v1/sessions/session%2F1',
      '/api/v1/sessions/session%2F1/plan',
      '/api/v1/sessions/session%2F1/plan/respond',
      '/api/v1/sessions/session%2F1/artifacts',
      '/api/v1/artifacts/artifact%2F1/content'
    ])
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
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'stream.ready',
        data: { protocolVersion: 1, streamId: 'stream-1', latestSequence: 0 }
      })
    })
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'connection.heartbeat',
        data: { timestamp: 100 }
      })
    })
    const first = events.next()
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify(PUBLIC_TERMINAL_FIXTURE)
    })
    const second = events.next()
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'permission.requested',
        data: { sessionId: 'session-1', requestId: 'permission-1' }
      })
    })
    const third = events.next()
    FakeWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'run.progress',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          phase: 'provider-accepted',
          timestamp: 250,
          elapsedMs: 249,
          heartbeat: false
        }
      })
    })

    await expect(first).resolves.toEqual({
      value: PUBLIC_TERMINAL_FIXTURE,
      done: false
    })
    await expect(second).resolves.toEqual({
      value: {
        type: 'permission.requested',
        data: { sessionId: 'session-1', requestId: 'permission-1' }
      },
      done: false
    })
    await expect(third).resolves.toEqual({
      value: {
        type: 'run.progress',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          phase: 'provider-accepted',
          timestamp: 250,
          elapsedMs: 249,
          heartbeat: false
        }
      },
      done: false
    })
    expect(FakeWebSocket.instance.url.pathname).toBe('/api/v1/events')
    expect(FakeWebSocket.instance.url.searchParams.get('token')).toBe('token-1')
    expect(FakeWebSocket.instance.url.searchParams.get('client')).toMatch(/^sdk-/)
    expect(FakeWebSocket.instance.url.searchParams.get('liveness')).toBe('1')
    expect(FakeWebSocket.instance.url.searchParams.get('eventProtocol')).toBe('1')
    await events.return?.()
    expect(FakeWebSocket.instance.closed).toBe(true)
  })

  it('yields an explicit resync state without exposing stream readiness frames', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ControllableWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    ControllableWebSocket.instance.emit('open')
    ControllableWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'stream.ready',
        data: { protocolVersion: 1, streamId: 'stream-2', latestSequence: 7 }
      })
    })
    const next = iterator.next()
    ControllableWebSocket.instance.emit('message', {
      data: JSON.stringify({
        type: 'stream.resync-required',
        data: {
          protocolVersion: 1,
          streamId: 'stream-2',
          latestSequence: 9,
          reason: 'cursor-expired'
        }
      })
    })

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: 'stream.resync-required',
        data: {
          protocolVersion: 1,
          streamId: 'stream-2',
          latestSequence: 9,
          reason: 'cursor-expired'
        }
      }
    })
    await iterator.return?.()
  })

  it('rejects event readiness when the socket reports a connection error', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ControllableWebSocket as never })

    ControllableWebSocket.instance.emit('error')

    await expect(events.ready).rejects.toMatchObject({
      code: 'event_stream_failed',
      message: 'Open Science event stream failed.'
    })
  })

  it('keeps iterating after an established event socket closes unexpectedly', async () => {
    class ReconnectingWebSocket extends ControllableWebSocket {
      static readonly instances: ReconnectingWebSocket[] = []

      constructor(url: URL) {
        super(url)
        ReconnectingWebSocket.instances.push(this)
      }
    }
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ReconnectingWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    const firstSocket = ReconnectingWebSocket.instances[0]
    firstSocket.emit('open')
    await events.ready
    firstSocket.emit('message', {
      data: JSON.stringify({
        type: 'stream.ready',
        data: { protocolVersion: 1, streamId: 'stream-1', latestSequence: 0 }
      })
    })
    const first = iterator.next()
    firstSocket.emit('message', {
      data: JSON.stringify({
        sequence: 1,
        runId: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        type: 'run.progress',
        data: { runId: 'run-1' }
      })
    })
    await expect(first).resolves.toMatchObject({ done: false, value: { sequence: 1 } })

    firstSocket.emit('close', { code: 1005 })

    await vi.waitFor(() => expect(ReconnectingWebSocket.instances).toHaveLength(2))
    const secondSocket = ReconnectingWebSocket.instances[1]
    expect(secondSocket.url.searchParams.get('eventProtocol')).toBe('1')
    expect(secondSocket.url.searchParams.get('stream')).toBe('stream-1')
    expect(secondSocket.url.searchParams.get('after')).toBe('1')
    secondSocket.emit('open')
    const next = iterator.next()
    secondSocket.emit('message', {
      data: JSON.stringify({
        sequence: 2,
        runId: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        type: 'run.progress',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          phase: 'provider-accepted',
          timestamp: 250,
          elapsedMs: 249,
          heartbeat: false
        }
      })
    })

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { sequence: 2, type: 'run.progress', data: { runId: 'run-1' } }
    })
    await iterator.return?.()
  })

  it('completes without reconnecting after a normal event socket close', async () => {
    class TrackingWebSocket extends ControllableWebSocket {
      static readonly instances: TrackingWebSocket[] = []

      constructor(url: URL) {
        super(url)
        TrackingWebSocket.instances.push(this)
      }
    }
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: TrackingWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    const socket = TrackingWebSocket.instances[0]
    socket.emit('open')
    await events.ready

    const next = iterator.next()
    socket.emit('close', { code: 1000, reason: 'Service stopped' })

    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(TrackingWebSocket.instances).toHaveLength(1)
  })

  it('fails without reconnecting after event stream access is revoked', async () => {
    class TrackingWebSocket extends ControllableWebSocket {
      static readonly instances: TrackingWebSocket[] = []

      constructor(url: URL) {
        super(url)
        TrackingWebSocket.instances.push(this)
      }
    }
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: TrackingWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    const socket = TrackingWebSocket.instances[0]
    socket.emit('open')
    await events.ready

    const next = iterator.next()
    socket.emit('close', { code: 1008, reason: 'Remote access revoked' })

    await expect(next).rejects.toMatchObject({
      code: 'event_stream_failed',
      message: 'Open Science event stream access was revoked.'
    })
    expect(TrackingWebSocket.instances).toHaveLength(1)
  })

  it('fails a ready event iterator when the connection stops receiving liveness frames', async () => {
    vi.useFakeTimers()
    try {
      const client = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'token-1',
        fetch: vi.fn()
      })
      const events = client.events({
        idleTimeoutMs: 25,
        WebSocket: ControllableWebSocket as never
      })
      const iterator = events[Symbol.asyncIterator]()
      ControllableWebSocket.instance.emit('open')
      await events.ready
      let outcome: unknown = 'still-pending'
      void iterator.next().then(
        () => {
          outcome = 'resolved'
        },
        (error: unknown) => {
          outcome = error
        }
      )

      await vi.advanceTimersByTimeAsync(25)

      expect(outcome).toMatchObject({
        code: 'timeout',
        message: 'Open Science event stream timed out after 25 milliseconds.'
      })
      expect(ControllableWebSocket.instance.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects event readiness when the socket closes before opening', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ControllableWebSocket as never })
    let outcome: unknown = 'still-pending'
    void events.ready.then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )

    ControllableWebSocket.instance.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    expect(outcome).toMatchObject({ code: 'event_stream_failed' })
  })

  it('rejects event readiness with the caller reason when cancelled before opening', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const abortController = new AbortController()
    const cancellation = new Error('caller cancelled event setup')
    const events = client.events({
      signal: abortController.signal,
      WebSocket: ControllableWebSocket as never
    })

    abortController.abort(cancellation)

    await expect(events.ready).rejects.toBe(cancellation)
    expect(ControllableWebSocket.instance.closed).toBe(true)
  })

  it('reports malformed event JSON through the async iterator failure channel', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ControllableWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    ControllableWebSocket.instance.emit('open')
    await events.ready
    let iteratorOutcome: unknown = 'still-pending'
    void iterator.next().then(
      () => {
        iteratorOutcome = 'resolved'
      },
      (error: unknown) => {
        iteratorOutcome = error
      }
    )
    let callbackError: unknown

    try {
      ControllableWebSocket.instance.emit('message', { data: '{not-json' })
    } catch (error) {
      callbackError = error
    }
    await Promise.resolve()
    await Promise.resolve()

    expect(callbackError).toBeUndefined()
    expect(iteratorOutcome).toMatchObject({ code: 'event_stream_invalid_message' })
    expect(ControllableWebSocket.instance.closed).toBe(true)
  })

  it('fails closed when more than 1024 events are buffered without a consumer', async () => {
    const client = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'token-1',
      fetch: vi.fn()
    })
    const events = client.events({ WebSocket: ControllableWebSocket as never })
    const iterator = events[Symbol.asyncIterator]()
    ControllableWebSocket.instance.emit('open')
    await events.ready

    for (let sequence = 1; sequence <= 1_025; sequence += 1) {
      ControllableWebSocket.instance.emit('message', {
        data: JSON.stringify({
          type: 'run.event',
          data: { sequence }
        })
      })
    }

    await expect(iterator.next()).rejects.toMatchObject({ code: 'event_stream_overflow' })
    expect(ControllableWebSocket.instance.closed).toBe(true)
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
