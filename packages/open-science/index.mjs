/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { findServiceState, readWebToken } from './config-root.mjs'

const defaultSleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 30_000
const EVENT_RECONNECT_DELAY_MS = 100
const MAX_BUFFERED_EVENTS = 1_024
const TASK_EVENT_STREAM_PROTOCOL_VERSION = 1
const NORMAL_EVENT_STREAM_CLOSE_CODES = new Set([1000])
const FAILED_EVENT_STREAM_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009])

export class OpenScienceApiError extends Error {
  constructor(message, { code = 'request_failed', status } = {}) {
    super(message)
    this.name = 'OpenScienceApiError'
    this.code = code
    this.status = status
  }
}

const resolveRequestTimeout = (defaultTimeoutMs, timeoutMs) => {
  const resolved = timeoutMs ?? defaultTimeoutMs
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError('timeoutMs must be a positive number.')
  }
  return resolved
}

const createRequestLifecycle = ({ defaultTimeoutMs, signal, timeoutMs }) => {
  signal?.throwIfAborted()
  const resolvedTimeoutMs = resolveRequestTimeout(defaultTimeoutMs, timeoutMs)
  const timeoutController = new AbortController()
  const timeoutError = new OpenScienceApiError(
    `Open Science request timed out after ${resolvedTimeoutMs} milliseconds.`,
    { code: 'timeout' }
  )
  const timeout = setTimeout(() => timeoutController.abort(timeoutError), resolvedTimeoutMs)
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  let finalized = false

  return {
    signal: requestSignal,
    finalize() {
      if (finalized) return
      finalized = true
      clearTimeout(timeout)
    },
    normalizeError(error) {
      if (signal?.aborted) return signal.reason
      if (timeoutController.signal.aborted) return timeoutError
      return error
    }
  }
}

const withRequestTimeout = async (options, operation) => {
  const lifecycle = createRequestLifecycle(options)
  try {
    return await operation(lifecycle.signal)
  } catch (error) {
    throw lifecycle.normalizeError(error)
  } finally {
    lifecycle.finalize()
  }
}

const wrapResponseBodyLifecycle = (response, lifecycle) => {
  if (!response.body) {
    lifecycle.finalize()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          lifecycle.finalize()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        lifecycle.finalize()
        controller.error(lifecycle.normalizeError(error))
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        lifecycle.finalize()
      }
    }
  })
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  Object.defineProperties(wrapped, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url }
  })
  return wrapped
}

const sleepWithSignal = async (sleep, milliseconds, signal) => {
  signal?.throwIfAborted()
  if (!signal) {
    await sleep(milliseconds)
    return
  }
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => sleep(milliseconds))
      .then(
        () => finish(resolve),
        (error) => finish(reject, error)
      )
  })
}

export class OpenScienceClient {
  constructor({
    baseUrl,
    token,
    fetch: fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }) {
    if (!baseUrl) throw new Error('Open Science baseUrl is required.')
    if (!token) throw new Error('Open Science token is required.')
    if (!fetchImpl) throw new Error('A Fetch implementation is required.')
    resolveRequestTimeout(requestTimeoutMs)
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fetch = fetchImpl
    this.sleep = sleep
    this.requestTimeoutMs = requestTimeoutMs
  }

  async health(options = {}) {
    return withRequestTimeout(
      {
        defaultTimeoutMs: this.requestTimeoutMs,
        signal: options.signal,
        timeoutMs: options.timeoutMs
      },
      async (signal) => {
        const response = await this.fetch(`${this.baseUrl}/api/bootstrap`, {
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
          signal
        })
        if (!response.ok) {
          throw new OpenScienceApiError('Open Science is not running.', {
            code: 'daemon_unavailable',
            status: response.status
          })
        }
        return await response.json()
      }
    )
  }

  listProjects(options) {
    return this.request('/api/v1/projects', options)
  }

  createProject({ name, description, agentContext }, options) {
    return this.request('/api/v1/projects', {
      ...options,
      method: 'POST',
      body: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(agentContext === undefined ? {} : { agentContext })
      }
    })
  }

  updateProject(projectId, request, options) {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      ...options,
      method: 'PATCH',
      body: request
    })
  }

  getProjectSessionDefaults(projectId, options) {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/session-defaults`,
      options
    )
  }

  updateProjectSessionDefaults(projectId, request, options) {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/session-defaults`, {
      ...options,
      method: 'PATCH',
      body: request
    })
  }

  listSessions(projectId, options) {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
    return this.request(`/api/v1/sessions${query}`, options)
  }

  getSession(sessionId, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, options)
  }

  getSessionConfiguration(sessionId, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/config`, options)
  }

  updateSessionConfiguration(sessionId, request, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/config`, {
      ...options,
      method: 'PATCH',
      body: request
    })
  }

  getAgentRouting(options) {
    return this.request('/api/v1/settings/agent-routing', options)
  }

  updateAgentRouting(request, options) {
    return this.request('/api/v1/settings/agent-routing', {
      ...options,
      method: 'PATCH',
      body: request
    })
  }

  getSessionPlan(sessionId, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/plan`, options)
  }

  respondSessionPlan(sessionId, response, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/plan/respond`, {
      ...options,
      method: 'POST',
      body: response
    })
  }

  startRun(request, options) {
    return this.request('/api/v1/runs', { ...options, method: 'POST', body: request })
  }

  getRun(runId, options) {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}`, options)
  }

  cancelRun(runId, options) {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      ...options,
      method: 'POST'
    })
  }

  async waitForRun(
    runId,
    { pollIntervalMs = 250, returnOnAttention = false, signal, timeoutMs } = {}
  ) {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError('timeoutMs must be a positive number.')
    }
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new OpenScienceApiError(`Timed out waiting for run ${runId}.`, { code: 'timeout' })
      }
      const remainingMs = deadline === undefined ? undefined : Math.max(1, deadline - Date.now())
      let run
      try {
        run = await this.getRun(runId, { signal, timeoutMs: remainingMs })
      } catch (error) {
        signal?.throwIfAborted()
        if (
          deadline !== undefined &&
          (Date.now() >= deadline ||
            (error instanceof OpenScienceApiError && error.code === 'timeout'))
        ) {
          throw new OpenScienceApiError(`Timed out waiting for run ${runId}.`, { code: 'timeout' })
        }
        throw error
      }
      if (run.status !== 'running') return run
      if (returnOnAttention && run.attention) return run
      const sleepMs =
        deadline === undefined
          ? pollIntervalMs
          : Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))
      await sleepWithSignal(this.sleep, sleepMs, signal)
    }
  }

  listArtifacts(sessionId, options) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`, options)
  }

  async downloadArtifact(artifactId, { signal, timeoutMs } = {}) {
    const lifecycle = createRequestLifecycle({
      defaultTimeoutMs: this.requestTimeoutMs,
      signal,
      timeoutMs
    })
    try {
      const response = await this.fetch(
        `${this.baseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
        {
          headers: { authorization: `Bearer ${this.token}` },
          signal: lifecycle.signal
        }
      )
      if (!response.ok) {
        await this.throwResponseError(response)
      }
      return wrapResponseBodyLifecycle(response, lifecycle)
    } catch (error) {
      lifecycle.finalize()
      throw lifecycle.normalizeError(error)
    }
  }

  events({
    idleTimeoutMs = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
    signal,
    WebSocket: WebSocketImpl = globalThis.WebSocket
  } = {}) {
    if (!WebSocketImpl) throw new Error('A WebSocket implementation is required.')
    signal?.throwIfAborted()
    resolveRequestTimeout(DEFAULT_EVENT_IDLE_TIMEOUT_MS, idleTimeoutMs)
    const clientId = `sdk-${globalThis.crypto.randomUUID()}`
    const queue = []
    const waiters = []
    let finished = false
    let failure
    let socket
    let resolveReady
    let rejectReady
    let readySettled = false
    let streamId
    let lastSequence = 0
    let idleTimer
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Iteration without awaiting `ready` still receives the same terminal error through `next()`;
    // keep the parallel readiness promise from becoming an unhandled rejection in that usage.
    void ready.catch(() => undefined)

    const flush = () => {
      while (waiters.length && queue.length) waiters.shift().resolve(queue.shift())
      if (!finished || !waiters.length) return
      for (const waiter of waiters.splice(0)) {
        if (failure) waiter.reject(failure)
        else waiter.resolve(undefined)
      }
    }
    const settleReady = (error) => {
      if (readySettled) return
      readySettled = true
      if (error) rejectReady(error)
      else resolveReady()
    }
    const finish = ({ error, closeSocket = false, discardQueue = false } = {}) => {
      if (finished) return
      finished = true
      failure = error
      clearTimeout(idleTimer)
      if (discardQueue) queue.splice(0)
      if (!readySettled) {
        settleReady(
          error ??
            new OpenScienceApiError('Open Science event stream closed before it was ready.', {
              code: 'event_stream_failed'
            })
        )
      }
      signal?.removeEventListener('abort', abort)
      if (closeSocket) socket?.close()
      flush()
    }
    const fail = (message, code) => {
      finish({
        error: new OpenScienceApiError(message, { code }),
        closeSocket: true,
        discardQueue: true
      })
    }
    const armIdleTimeout = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () =>
          fail(
            `Open Science event stream timed out after ${idleTimeoutMs} milliseconds.`,
            'timeout'
          ),
        idleTimeoutMs
      )
    }
    const enqueue = (event) => {
      if (queue.length >= MAX_BUFFERED_EVENTS) {
        fail(
          'Open Science event stream exceeded its buffered event limit.',
          'event_stream_overflow'
        )
        return
      }
      queue.push(event)
      flush()
    }
    const scheduleReconnect = () => {
      void sleepWithSignal(this.sleep, EVENT_RECONNECT_DELAY_MS, signal).then(
        () => {
          if (!finished) connect()
        },
        (error) => {
          if (!finished) finish({ error, discardQueue: true })
        }
      )
    }
    const connect = () => {
      const endpoint = new URL('/api/v1/events', this.baseUrl)
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
      endpoint.searchParams.set('token', this.token)
      endpoint.searchParams.set('client', clientId)
      endpoint.searchParams.set('liveness', '1')
      endpoint.searchParams.set('eventProtocol', String(TASK_EVENT_STREAM_PROTOCOL_VERSION))
      if (streamId !== undefined) {
        endpoint.searchParams.set('stream', streamId)
        endpoint.searchParams.set('after', String(lastSequence))
      }
      const current = new WebSocketImpl(endpoint)
      socket = current
      let connectionOpened = false
      current.addEventListener('message', (event) => {
        if (finished || socket !== current) return
        armIdleTimeout()
        let parsed
        try {
          parsed = JSON.parse(String(event.data))
        } catch {
          fail(
            'Open Science event stream returned an invalid message.',
            'event_stream_invalid_message'
          )
          return
        }
        if (parsed?.type === 'connection.heartbeat') return
        if (parsed?.type === 'stream.ready') {
          if (
            parsed.data?.protocolVersion !== TASK_EVENT_STREAM_PROTOCOL_VERSION ||
            typeof parsed.data?.streamId !== 'string' ||
            !Number.isSafeInteger(parsed.data?.latestSequence)
          ) {
            fail(
              'Open Science event stream returned an invalid message.',
              'event_stream_invalid_message'
            )
            return
          }
          streamId = parsed.data.streamId
          lastSequence = parsed.data.latestSequence
          return
        }
        if (parsed?.type === 'stream.resync-required') {
          if (
            parsed.data?.protocolVersion !== TASK_EVENT_STREAM_PROTOCOL_VERSION ||
            typeof parsed.data?.streamId !== 'string' ||
            !Number.isSafeInteger(parsed.data?.latestSequence)
          ) {
            fail(
              'Open Science event stream returned an invalid message.',
              'event_stream_invalid_message'
            )
            return
          }
          streamId = parsed.data.streamId
          lastSequence = parsed.data.latestSequence
          enqueue(parsed)
          return
        }
        if (Number.isSafeInteger(parsed?.sequence)) {
          if (parsed.sequence <= lastSequence) return
          lastSequence = parsed.sequence
        }
        enqueue(parsed)
      })
      current.addEventListener('open', () => {
        if (finished || socket !== current) return
        connectionOpened = true
        armIdleTimeout()
        settleReady()
      })
      current.addEventListener('error', () => {
        if (finished || socket !== current) return
        if (!readySettled) {
          fail('Open Science event stream failed.', 'event_stream_failed')
        } else {
          current.close()
        }
      })
      current.addEventListener('close', (event) => {
        if (finished || socket !== current) return
        if (!connectionOpened && !readySettled) {
          finish({
            error: new OpenScienceApiError(
              'Open Science event stream closed before it was ready.',
              { code: 'event_stream_failed' }
            ),
            discardQueue: true
          })
          return
        }
        if (NORMAL_EVENT_STREAM_CLOSE_CODES.has(event.code)) {
          finish()
          return
        }
        if (FAILED_EVENT_STREAM_CLOSE_CODES.has(event.code)) {
          finish({
            error: new OpenScienceApiError(
              event.code === 1008
                ? 'Open Science event stream access was revoked.'
                : 'Open Science event stream closed permanently.',
              { code: 'event_stream_failed' }
            ),
            discardQueue: true
          })
          return
        }
        scheduleReconnect()
      })
    }
    const abort = () => {
      if (!readySettled) {
        finish({ error: signal.reason, closeSocket: true, discardQueue: true })
      } else {
        finish({ closeSocket: true })
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    armIdleTimeout()
    connect()

    return {
      ready,
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
        finish({ closeSocket: true })
        return { value: undefined, done: true }
      }
    }
  }

  async request(path, { method = 'GET', body, idempotencyKey, signal, timeoutMs } = {}) {
    const headers = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json'
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey
    return withRequestTimeout(
      { defaultTimeoutMs: this.requestTimeoutMs, signal, timeoutMs },
      async (requestSignal) => {
        const response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: requestSignal
        })
        if (!response.ok) await this.throwResponseError(response)
        const payload = await response.json()
        return payload.data
      }
    )
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

export const connectToOpenScience = async ({
  configRoot,
  env,
  fetch,
  requestTimeoutMs,
  signal
} = {}) => {
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
    fetch,
    requestTimeoutMs
  })
  await client.health({ signal })
  return client
}
