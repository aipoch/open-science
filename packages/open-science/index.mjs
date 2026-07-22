/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { findServiceState, readWebToken } from './config-root.mjs'

const defaultSleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

export class OpenScienceApiError extends Error {
  constructor(message, { code = 'request_failed', status } = {}) {
    super(message)
    this.name = 'OpenScienceApiError'
    this.code = code
    this.status = status
  }
}

export class OpenScienceClient {
  constructor({ baseUrl, token, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
    if (!baseUrl) throw new Error('Open Science baseUrl is required.')
    if (!token) throw new Error('Open Science token is required.')
    if (!fetchImpl) throw new Error('A Fetch implementation is required.')
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetch = fetchImpl
    this.sleep = sleep
  }

  async health() {
    const response = await this.fetch(`${this.baseUrl}/api/bootstrap`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' }
    })
    if (!response.ok) {
      throw new OpenScienceApiError('Open Science is not running.', {
        code: 'daemon_unavailable',
        status: response.status
      })
    }
    return response.json()
  }

  listProjects() {
    return this.request('/api/v1/projects')
  }

  createProject({ name, description }) {
    return this.request('/api/v1/projects', {
      method: 'POST',
      body: { name, ...(description === undefined ? {} : { description }) }
    })
  }

  listSessions(project) {
    const query = project ? `?project=${encodeURIComponent(project)}` : ''
    return this.request(`/api/v1/sessions${query}`)
  }

  getSession(sessionId) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  startRun(request) {
    return this.request('/api/v1/runs', { method: 'POST', body: request })
  }

  getRun(runId) {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}`)
  }

  async waitForRun(runId, { pollIntervalMs = 250, signal } = {}) {
    for (;;) {
      signal?.throwIfAborted()
      const run = await this.getRun(runId)
      if (run.status !== 'running') return run
      await this.sleep(pollIntervalMs)
    }
  }

  listArtifacts(sessionId) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`)
  }

  async downloadArtifact(artifactId, { signal } = {}) {
    const response = await this.fetch(
      `${this.baseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        signal
      }
    )
    if (!response.ok) await this.throwResponseError(response)
    return response
  }

  events({ signal, WebSocket: WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!WebSocketImpl) throw new Error('A WebSocket implementation is required.')
    signal?.throwIfAborted()
    const endpoint = new URL('/api/v1/events', this.baseUrl)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.searchParams.set('token', this.token)
    endpoint.searchParams.set('client', `sdk-${globalThis.crypto.randomUUID()}`)
    const socket = new WebSocketImpl(endpoint)
    const queue = []
    const waiters = []
    let finished = false
    let failure

    const flush = () => {
      while (waiters.length && queue.length) waiters.shift().resolve(queue.shift())
      if (!finished || !waiters.length) return
      for (const waiter of waiters.splice(0)) {
        if (failure) waiter.reject(failure)
        else waiter.resolve(undefined)
      }
    }
    socket.addEventListener('message', (event) => {
      queue.push(JSON.parse(String(event.data)))
      flush()
    })
    socket.addEventListener('error', () => {
      failure = new OpenScienceApiError('Open Science event stream failed.', {
        code: 'event_stream_failed'
      })
      finished = true
      flush()
    })
    socket.addEventListener('close', () => {
      finished = true
      flush()
    })
    const abort = () => socket.close()
    signal?.addEventListener('abort', abort, { once: true })

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        if (queue.length) return { value: queue.shift(), done: false }
        if (finished) {
          if (failure) throw failure
          return { value: undefined, done: true }
        }
        const value = await new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        return value === undefined ? { value: undefined, done: true } : { value, done: false }
      },
      async return() {
        signal?.removeEventListener('abort', abort)
        socket.close()
        return { value: undefined, done: true }
      }
    }
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const headers = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json'
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
    if (!response.ok) await this.throwResponseError(response)
    const payload = await response.json()
    return payload.data
  }

  async throwResponseError(response) {
    let error
    try {
      error = (await response.json()).error
    } catch {
      error = undefined
    }
    throw new OpenScienceApiError(
      error?.message ?? `Open Science request failed (${response.status}).`,
      {
        code: error?.code,
        status: response.status
      }
    )
  }
}

export const connectToOpenScience = async ({ configRoot, env, fetch } = {}) => {
  const state = await findServiceState({ override: configRoot, env })
  if (!state) {
    throw new OpenScienceApiError(
      'Open Science is not running. Start it with "open-science start".',
      {
        code: 'daemon_unavailable'
      }
    )
  }
  const token = await readWebToken(state.configRoot)
  const client = new OpenScienceClient({
    baseUrl: `http://127.0.0.1:${state.port}`,
    token,
    fetch
  })
  await client.health()
  return client
}
