import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BrowserImportError,
  launchOpenScience,
  checkBrowserImportAvailability,
  prepareBrowserImport
} from './browser-import.mjs'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([
  '研'.repeat(100) + '.science',
  '研'.repeat(83) + '.science',
  'CON.science',
  'aux.notes.science',
  'COM1.science',
  'COM¹.science',
  'lpt9.science'
])('rejects a filename that cannot be stored portably: %s', (filename) => {
  expect(() =>
    prepareBrowserImport(new Blob(['hello']), {
      filename,
      origin: 'https://research.example'
    })
  ).toThrow(/filename/)
})

it.each(['研'.repeat(82) + '.science', '研究.science', 'com10.science'])(
  'accepts a portable filename: %s',
  (filename) => {
    expect(() =>
      prepareBrowserImport(new Blob(['hello']), {
        filename,
        origin: 'https://research.example'
      })
    ).not.toThrow()
  }
)

it.each(['headers', 'body'])('bounds receiver readiness while waiting for %s', async (stage) => {
  const controller = new AbortController()
  // Fails promptly on the old implementation instead of waiting for its 30-second request budget.
  const fallback = setTimeout(
    () => controller.abort(new Error('Readiness budget was ignored')),
    500
  )
  vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
    const stalled = (): Promise<never> =>
      new Promise((_resolve, reject) => {
        init.signal!.throwIfAborted()
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    return stage === 'headers' ? stalled() : { ok: true, json: stalled }
  })
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  try {
    await expect(transfer.send({ signal: controller.signal, readyTimeoutMs: 20 })).rejects.toThrow(
      /did not become ready/
    )
  } finally {
    clearTimeout(fallback)
  }
})

it.each(['attempts', 'wait-for-launch'])(
  'rejects a valid proof arriving after the %s deadline',
  async (readinessMode) => {
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const secret = new URL(transfer.url).searchParams.get('secret')!
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal('fetch', async (input: string) => {
      const challenge = new URL(input).searchParams.get('challenge')
      const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`open-science-import-v1:${challenge}:5:1`)
        .digest('hex')
      now = 1100
      return new Response(JSON.stringify({ proof, offset: 5, accepted: true, chunkBytes: 4194304 }))
    })
    await expect(transfer.send({ readinessMode, readyTimeoutMs: 50 })).rejects.toThrow(
      /did not become ready/
    )
  }
)

it('never sends bytes or credentials to an endpoint that cannot prove its identity', async () => {
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push(init)
    return new Response(JSON.stringify({ proof: '00'.repeat(32), offset: 0, chunkBytes: 4194304 }))
  })
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  await expect(transfer.send()).rejects.toThrow(/identity/i)
  expect(requests).toHaveLength(1)
  expect(new Headers(requests[0].headers).has('Authorization')).toBe(false)
  expect(requests[0].body).toBeUndefined()
})

it('rejects empty packages, unsafe filenames and insecure public websites before launch', () => {
  for (const [file, options] of [
    [new Blob(), { filename: 'study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: '../study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: 'study.science', origin: 'http://research.example' }]
  ] as const)
    expect(() => prepareBrowserImport(file, options)).toThrow()
})

it('keeps bytes and the secret private if the listener is replaced after a valid handshake', async () => {
  const transfer = prepareBrowserImport(new Blob(['private research']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    requests.push(init)
    if (requests.length === 1) {
      const challenge = new URL(input).searchParams.get('challenge')
      const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`open-science-import-v1:${challenge}:0:0`)
        .digest('hex')
      return new Response(
        JSON.stringify({ proof, offset: 0, accepted: false, chunkBytes: 4194304 })
      )
    }
    return new Response(JSON.stringify({ offset: 16, proof: 'forged' }))
  })
  await expect(transfer.send()).rejects.toMatchObject({ code: 'transfer-failed' })
  expect(requests).toHaveLength(2)
  expect(new Headers(requests[1].headers).get('Authorization')).not.toContain(secret)
  expect(
    Buffer.from(requests[1].body as Uint8Array).includes(Buffer.from('private research'))
  ).toBe(false)
})

it('bounds readiness to five attempts with one-second gaps and leaves no retry timers', async () => {
  vi.useFakeTimers()
  const starts: number[] = []
  vi.stubGlobal('fetch', async () => {
    starts.push(Date.now())
    throw new TypeError('Network unavailable')
  })
  try {
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const result = expect(transfer.send()).rejects.toMatchObject({ code: 'readiness-exhausted' })
    await vi.advanceTimersByTimeAsync(5000)
    await result
    expect(starts).toHaveLength(5)
    expect(starts.slice(1).map((time, index) => time - starts[index])).toEqual([
      1000, 1000, 1000, 1000
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('checks one discovery endpoint without downloading a package or exposing credentials', async () => {
  const requests: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return Response.json({ service: 'open-science-browser-import', version: 1 })
  })
  await expect(
    checkBrowserImportAvailability({ origin: 'https://research.example' })
  ).resolves.toEqual({ status: 'available' })
  expect(requests.map((request) => request.url)).toEqual([
    'http://127.0.0.1:49151/v1/browser-import/capabilities'
  ])
  expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false)
  expect(requests[0].init.body).toBeUndefined()
})

it.each([
  [403, {}, 'incompatible'],
  [200, { service: 'another-app', version: 1 }, 'incompatible'],
  [200, { service: 'open-science-browser-import', version: 2 }, 'incompatible']
])('classifies discovery response %s %j', async (status, body, expected) => {
  vi.stubGlobal('fetch', async () => Response.json(body, { status }))
  await expect(
    checkBrowserImportAvailability({ origin: 'https://research.example' })
  ).resolves.toMatchObject({ status: expected })
})

it('aborts an in-flight readiness request without another attempt or remaining timers', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let requestSignal: AbortSignal | undefined
  let attempts = 0
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    attempts++
    requestSignal = init.signal!
    return new Promise((_resolve, reject) =>
      requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true })
    )
  })
  try {
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const result = expect(transfer.send({ signal: controller.signal })).rejects.toThrow(
      'User cancelled'
    )
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('User cancelled'))
    await result
    await vi.advanceTimersByTimeAsync(10000)
    expect(requestSignal?.aborted).toBe(true)
    expect(attempts).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('reports discovery timeout while reading a stalled body', async () => {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => ({
    status: 200,
    ok: true,
    json: () =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      )
  }))
  await expect(
    checkBrowserImportAvailability({ origin: 'https://research.example', timeoutMs: 10 })
  ).resolves.toEqual({ status: 'timeout' })
})

it('does not confuse unreachable with an installation check', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
  await expect(
    checkBrowserImportAvailability({ origin: 'https://research.example' })
  ).resolves.toEqual({ status: 'unavailable' })
})

it('rejects malformed readiness immediately instead of treating it as a network retry', async () => {
  let requests = 0
  vi.stubGlobal('fetch', async () => {
    requests++
    return Response.json(null)
  })
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  await expect(transfer.send({ readyTimeoutMs: 50 })).rejects.toMatchObject({
    code: 'incompatible'
  })
  expect(requests).toBe(1)
})

it('requests a pure launch synchronously without accessing Blob or the network', () => {
  const assign = vi.fn()
  const fetch = vi.fn()
  vi.stubGlobal('location', { assign })
  vi.stubGlobal('Blob', undefined)
  vi.stubGlobal('fetch', fetch)
  expect(launchOpenScience()).toBeUndefined()
  expect(assign).toHaveBeenCalledExactlyOnceWith('open-science://open')
  expect(fetch).not.toHaveBeenCalled()
})

it('reports only observable launch errors, without claiming installation status', () => {
  vi.stubGlobal('location', undefined)
  expect(launchOpenScience).toThrowError(expect.objectContaining({ code: 'unsupported-browser' }))
  vi.stubGlobal('location', {
    assign: () => {
      throw new Error('Navigation denied')
    }
  })
  expect(launchOpenScience).toThrowError(expect.objectContaining({ code: 'launch-failed' }))
  try {
    launchOpenScience()
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserImportError)
  }
})

it.each(['attempts', 'wait-for-launch'])(
  'never announces transfer before proof in %s mode',
  async (readinessMode) => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ accepted: false, offset: 0, chunkBytes: 4194304, proof: 'forged' })
    )
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const phases: string[] = []
    await expect(
      transfer.send({ readinessMode, onPhase: (phase: string) => phases.push(phase) })
    ).rejects.toMatchObject({ code: 'incompatible' })
    expect(phases).toEqual(['waiting-for-receiver'])
  }
)

it('uses at most fourteen seconds for five stalled default readiness attempts', async () => {
  vi.useFakeTimers()
  const starts: number[] = []
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    starts.push(Date.now())
    return new Promise((_resolve, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    )
  })
  try {
    const start = Date.now()
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const result = expect(transfer.send()).rejects.toMatchObject({ code: 'readiness-exhausted' })
    await vi.advanceTimersByTimeAsync(13999)
    expect(starts.map((time) => time - start)).toEqual([0, 3000, 6000, 9000, 12000])
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves the caller abort reason after verified readiness and attempts authenticated cleanup', async () => {
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const controller = new AbortController()
  const reason = new Error('User cancelled this transfer')
  const methods: string[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    methods.push(init.method ?? 'GET')
    if (init.method === 'DELETE') {
      expect(new Headers(init.headers).get('Authorization')).toMatch(/^HMAC /)
      return new Response(null, { status: 204 })
    }
    const challenge = new URL(input).searchParams.get('challenge')
    const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(`open-science-import-v1:${challenge}:0:0`)
      .digest('hex')
    return Response.json({ proof, offset: 0, accepted: false, chunkBytes: 4194304 })
  })
  await expect(
    transfer.send({
      signal: controller.signal,
      onPhase: (phase: string) => {
        if (phase === 'transferring') controller.abort(reason)
      }
    })
  ).rejects.toBe(reason)
  expect(methods).toEqual(['GET', 'DELETE'])
})

it.each(['timeout', 'transfer-failed'])(
  'the guide reconnects after %s and a cancelled probe without relaunch',
  async (code) => {
    const markdown = readFileSync(new URL('./BROWSER_IMPORT.md', import.meta.url), 'utf8')
    const example = markdown
      .match(/```js\n([\s\S]*?)```/)![1]
      .replace(/import \{[\s\S]*?\} from '@aipoch\/open-science\/browser-import'/, '')
    const button = (): { disabled: boolean; onclick: () => void } => ({
      disabled: false,
      onclick: () => undefined
    })
    const elements = {
      continueButton: button(),
      openButton: button(),
      probeButton: button(),
      reconnectButton: button(),
      retryButton: button(),
      restartButton: button(),
      cancelButton: button(),
      status: { textContent: '' }
    }
    const send = vi
      .fn()
      .mockRejectedValueOnce(new BrowserImportError(code, 'Receiver unavailable'))
      .mockResolvedValue({ received: true })
    const prepare = vi.fn(() => ({ url: 'open-science://import?test', send }))
    const discovery = vi
      .fn()
      .mockResolvedValueOnce({ status: 'available' })
      .mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true })
          })
      )
    const assign = vi.fn()
    runInNewContext(example, {
      ...elements,
      AbortController,
      BrowserImportError,
      checkBrowserImportAvailability: discovery,
      prepareBrowserImport: prepare,
      launchOpenScience: vi.fn(),
      window: { location: { assign } },
      fetch: async () => ({ ok: true, blob: async () => new Blob(['package']) })
    })
    elements.continueButton.onclick()
    await vi.waitFor(() => expect(elements.cancelButton.disabled).toBe(true))
    expect(send).toHaveBeenCalledTimes(1)
    elements.probeButton.onclick()
    elements.cancelButton.onclick()
    await vi.waitFor(() => expect(elements.cancelButton.disabled).toBe(true))
    elements.reconnectButton.onclick()
    await vi.waitFor(() =>
      expect(elements.status.textContent).toContain('Received by Open-Science')
    )
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].signal).not.toBe(send.mock.calls[1][0].signal)
  }
)

// These fixtures prove readiness using each transfer's real secret, not discovery or UI events.
const waitingTransfer = (): {
  transfer: ReturnType<typeof prepareBrowserImport>
  sign: (message: string) => string
  ready: (input: string, accepted?: boolean) => Response
} => {
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const sign = (message: string): string =>
    createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex')
  const ready = (input: string, accepted = true): Response => {
    const challenge = new URL(input).searchParams.get('challenge')
    const offset = accepted ? 5 : 0
    return Response.json({
      accepted,
      offset,
      chunkBytes: 4194304,
      proof: sign(`open-science-import-v1:${challenge}:${offset}:${accepted ? 1 : 0}`)
    })
  }
  return { transfer, sign, ready }
}

it('waits beyond fifteen seconds for this transfer proof without consulting availability', async () => {
  vi.useFakeTimers()
  try {
    const { transfer, ready } = waitingTransfer()
    const start = Date.now()
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      requests.push(input)
      if (Date.now() - start < 16000) throw new TypeError('App has not been opened yet')
      return ready(input)
    })
    const phases: string[] = []
    const progress = vi.fn()
    const result = transfer
      .send({
        readinessMode: 'wait-for-launch',
        onPhase: (phase: string) => phases.push(phase),
        onProgress: progress
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(16000)
    expect(await result).toEqual({ received: true })
    expect(requests).toHaveLength(17)
    expect(requests.every((url) => new URL(url).pathname === '/v1/import/ready')).toBe(true)
    expect(phases).toEqual(['waiting-for-receiver']) // Already queued: no synthetic bytes or transfer phase.
    expect(progress).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it.each(['headers', 'body', 'gap'])(
  'enforces the 120-second total launch wait including %s',
  async (stage) => {
    vi.useFakeTimers()
    try {
      const { transfer } = waitingTransfer()
      const starts: number[] = []
      const signals: AbortSignal[] = []
      vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
        starts.push(Date.now())
        if (stage === 'gap') throw new TypeError('Connection refused')
        signals.push(init.signal!)
        const stalled = (): Promise<never> =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true
            })
          })
        return stage === 'headers' ? stalled() : { ok: true, json: stalled }
      })
      let settled = false
      const result = transfer
        .send({ readinessMode: 'wait-for-launch', readyTimeoutMs: 300000, attemptTimeoutMs: 30000 })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true
        })
      await vi.advanceTimersByTimeAsync(119999)
      expect(settled).toBe(false)
      expect(starts).toHaveLength(stage === 'gap' ? 120 : 40)
      if (stage !== 'gap') expect(starts[1] - starts[0]).toBe(3000) // 2-second request + 1-second gap.
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toMatchObject({ code: 'timeout' })
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }
)

it.each(['headers', 'body', 'gap'])(
  'cancels launch waiting immediately during %s and retains the reason',
  async (stage) => {
    vi.useFakeTimers()
    try {
      const { transfer } = waitingTransfer()
      const controller = new AbortController()
      const reason = { action: 'user-cancelled' }
      const fetch = vi.fn(async (_input: string, init: RequestInit) => {
        if (stage === 'gap') throw new TypeError('Connection refused')
        const stalled = (): Promise<never> =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true
            })
          })
        return stage === 'headers' ? stalled() : { ok: true, json: stalled }
      })
      vi.stubGlobal('fetch', fetch)
      const result = transfer
        .send({ readinessMode: 'wait-for-launch', signal: controller.signal })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(10)
      controller.abort(reason)
      expect(await result).toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(120000)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }
)

it('can reconnect the same transfer after launch timeout without another protocol navigation', async () => {
  vi.useFakeTimers()
  try {
    const { transfer, ready } = waitingTransfer()
    let available = false
    vi.stubGlobal('fetch', async (input: string) => {
      if (!available) throw new TypeError('Not running')
      return ready(input)
    })
    const originalUrl = transfer.url
    const result = transfer
      .send({ readinessMode: 'wait-for-launch' })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(120000)
    expect(await result).toMatchObject({ code: 'timeout' })
    available = true
    await expect(transfer.send({ readinessMode: 'wait-for-launch' })).resolves.toEqual({
      received: true
    })
    expect(transfer.url).toBe(originalUrl)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('authenticates before transferring and allows file transfer to outlast the readiness budget', async () => {
  vi.useFakeTimers()
  try {
    const { transfer, ready, sign } = waitingTransfer()
    const events: string[] = []
    let chunkStarted!: () => void
    const started = new Promise<void>((resolve) => {
      chunkStarted = resolve
    })
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      if (new URL(input).pathname.endsWith('/ready')) return ready(input, false)
      if (init.method === 'PUT') {
        events.push('chunk')
        chunkStarted()
        await new Promise((resolve) => setTimeout(resolve, 10000))
        init.signal!.throwIfAborted()
        return Response.json({ offset: 5, proof: sign('offset:5') })
      }
      return Response.json({ received: true, proof: sign('received:5') }, { status: 202 })
    })
    const result = transfer.send({
      readinessMode: 'wait-for-launch',
      readyTimeoutMs: 1000,
      onPhase: (phase: string) => events.push(phase),
      onProgress: ({ sentBytes }: { sentBytes: number }) => events.push(`ack:${sentBytes}`)
    })
    await started
    expect(events).toEqual(['waiting-for-receiver', 'transferring', 'chunk'])
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toEqual({ received: true })
    expect(events).toEqual(['waiting-for-receiver', 'transferring', 'chunk', 'ack:5'])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('ends the total wait during a response body read and rejects concurrent sends', async () => {
  vi.useFakeTimers()
  try {
    const { transfer } = waitingTransfer()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
      signal = init.signal!
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
          })
      }
    })
    const result = transfer
      .send({ readinessMode: 'wait-for-launch', readyTimeoutMs: 1500 })
      .catch((error: unknown) => error)
    await expect(transfer.send({ readinessMode: 'wait-for-launch' })).rejects.toThrow(
      'already running'
    )
    await vi.advanceTimersByTimeAsync(1500)
    expect(await result).toMatchObject({ code: 'timeout' })
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('treats authenticated desktop cancellation as terminal without retrying or sending bytes', async () => {
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: 'cancelled',
          proof: createHmac('sha256', Buffer.from(secret, 'hex')).update('cancelled').digest('hex')
        }),
        { status: 410 }
      )
  )
  vi.stubGlobal('fetch', fetch)
  await expect(transfer.send({ readinessMode: 'wait-for-launch' })).rejects.toMatchObject({
    code: 'cancelled'
  })
  await expect(transfer.send()).rejects.toMatchObject({ code: 'cancelled' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('does not trust an unsigned desktop cancellation or treat it as a retryable network fault', async () => {
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example'
  })
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ code: 'cancelled', proof: '00'.repeat(32) }), { status: 410 })
  )
  vi.stubGlobal('fetch', fetch)
  await expect(transfer.send({ readinessMode: 'wait-for-launch' })).rejects.toMatchObject({
    code: 'incompatible'
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['', '{invalid'])(
  'rejects an unverifiable cancellation body after readiness: %s',
  async (body) => {
    const transfer = prepareBrowserImport(new Blob(['hello']), {
      filename: 'study.science',
      origin: 'https://research.example'
    })
    const secret = new URL(transfer.url).searchParams.get('secret')!
    let requests = 0
    vi.stubGlobal('fetch', async (input: string) => {
      if (++requests === 1) {
        const challenge = new URL(input).searchParams.get('challenge')
        const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
          .update(`open-science-import-v1:${challenge}:0:0`)
          .digest('hex')
        return new Response(
          JSON.stringify({ proof, offset: 0, accepted: false, chunkBytes: 4194304 })
        )
      }
      return new Response(body, { status: 410 })
    })
    await expect(transfer.send()).rejects.toMatchObject({ code: 'incompatible' })
    expect(requests).toBe(2)
  }
)
