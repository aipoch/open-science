import { createHmac } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { checkBrowserImportAvailability, prepareBrowserImport } from './browser-import.mjs'

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

it('rejects a valid readiness response that arrives after the deadline', async () => {
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
  await expect(transfer.send({ readyTimeoutMs: 50 })).rejects.toThrow(/did not become ready/)
})

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
  await expect(transfer.send()).rejects.toThrow(/offset/)
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
    return Response.json({ service: 'open-science-browser-import', version: 1, authorized: true })
  })
  await expect(
    checkBrowserImportAvailability({ origin: 'https://research.example' })
  ).resolves.toEqual({ status: 'available', authorized: true })
  expect(requests.map((request) => request.url)).toEqual([
    'http://127.0.0.1:49151/v1/browser-import/capabilities'
  ])
  expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false)
  expect(requests[0].init.body).toBeUndefined()
})

it.each([
  [403, {}, 'permission-denied'],
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
