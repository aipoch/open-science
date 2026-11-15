import { createServer, type Server } from 'node:http'
import sharp from 'sharp'
import { afterEach, beforeAll, expect, it, vi, type Mock } from 'vitest'
import type { ResolvedImageModel } from '../settings/image-model-owner'
import { ImageModelService } from './service'
import { readImageResult } from './adapter'
import { MAX_IMAGE_RESPONSE_BYTES, type ImageModelRequest, type ImageModelResult } from './contract'

let png: Buffer
beforeAll(async () => {
  png = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#abcabc' } })
    .png()
    .toBuffer()
})
const target: ResolvedImageModel = {
  serviceId: 'service',
  adapter: 'minimax',
  baseUrl: 'https://images.example/v1',
  apiKey: 'private-key',
  model: { id: 'h3', wireModelId: 'relay/h3', presetId: 'minimax-h3/official' }
}
const request = (extra: Partial<ImageModelRequest> = {}): ImageModelRequest => ({
  operation: 'generate',
  prompt: 'A contour map',
  signal: new AbortController().signal,
  context: {
    projectId: 'project',
    sessionId: 'session',
    invocationId: 'call-1',
    frameworkId: 'test'
  },
  ...extra
})
const response = (extra: Record<string, unknown> = {}): Response =>
  Response.json({ data: [{ b64_json: png.toString('base64') }], ...extra })
function fixture(selected: ResolvedImageModel | undefined = target): {
  service: ImageModelService
  fetch: Mock<typeof globalThis.fetch>
  download: ReturnType<typeof vi.fn>
  record: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response())
  const download = vi.fn(async () => png)
  const record = vi.fn(async () => {})
  const resolve = vi.fn(async () => selected)
  return {
    service: new ImageModelService({
      resolveTarget: resolve,
      fetch,
      download,
      recordUsage: record
    }),
    fetch,
    download,
    record,
    resolve
  }
}

it('pins the model, endpoint and credential for a turn and captures changes for the next turn', async () => {
  const f = fixture()
  const currentTurn = f.service.capture()
  f.resolve.mockResolvedValue({
    ...target,
    baseUrl: 'https://next.example/v1',
    apiKey: 'next-key',
    model: { ...target.model, wireModelId: 'next/model' }
  })
  await currentTurn(request())
  await currentTurn(request({ context: { ...request().context, invocationId: 'call-2' } }))
  expect(f.resolve).toHaveBeenCalledOnce()
  for (const [url, init] of f.fetch.mock.calls) {
    expect(url).toBe('https://images.example/v1/images/generations')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-key' })
    expect(JSON.parse(init!.body as string).model).toBe('relay/h3')
  }
  await f.service.capture()(request())
  expect(f.fetch.mock.calls[2][0]).toBe('https://next.example/v1/images/generations')
  expect(f.fetch.mock.calls[2][1]?.headers).toMatchObject({ Authorization: 'Bearer next-key' })
  expect(JSON.parse(f.fetch.mock.calls[2][1]!.body as string).model).toBe('next/model')
})

it('does not enable an unconfigured turn retroactively or leak snapshot resolution failures', async () => {
  const f = fixture()
  f.resolve.mockResolvedValueOnce(undefined)
  const unconfiguredTurn = f.service.capture()
  await expect(unconfiguredTurn(request())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  f.resolve.mockRejectedValueOnce(new Error('secret credential failure'))
  const failedTurn = f.service.capture()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(failedTurn(request())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  expect(f.fetch).not.toHaveBeenCalled()
  await expect(f.service.capture()(request())).resolves.toMatchObject({ model: 'relay/h3' })
})

it('uses the captured official target, one output and measured token usage', async () => {
  const f = fixture()
  f.fetch.mockResolvedValue(
    response({ usage: { input_tokens: 12, output_tokens: 25, generated_images: 1 } })
  )
  const result = await f.service.execute(request({ options: { size: '1024x1024' } }))
  expect(f.fetch).toHaveBeenCalledTimes(1)
  const [url, init] = f.fetch.mock.calls[0]
  expect(url).toBe('https://images.example/v1/images/generations')
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: 'Bearer private-key' },
    signal: expect.any(AbortSignal)
  })
  expect(JSON.parse(init!.body as string)).toEqual({
    model: 'relay/h3',
    prompt: 'A contour map',
    n: 1,
    response_format: 'b64_json',
    size: '1024x1024'
  })
  expect(result).toMatchObject({
    mime: 'image/png',
    width: 128,
    height: 128,
    generatedImages: 1,
    model: 'relay/h3'
  })
  expect(result.bytes).toEqual(png)
  expect(f.record).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'image-generation',
      eventId: 'image:call-1',
      projectId: 'project',
      sessionId: 'session',
      usage: { inputTokens: 12, outputTokens: 25, cacheTokens: 0, turnCount: 1 }
    })
  )
  expect(JSON.stringify(result)).not.toContain('private-key')
})

it('publishes the image and advances the queue while measured usage is being written', async () => {
  const f = fixture()
  const pending: Array<(value: Response) => void> = []
  f.fetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const usage = Promise.withResolvers<void>()
  f.record.mockReturnValueOnce(usage.promise)
  const publish = vi.fn(async () => ({ artifactId: 'image', versionId: 'version' }))
  const executing = Array.from({ length: 5 }, (_, index) =>
    f.service.execute(
      request({
        context: { ...request().context, invocationId: `usage-${index}` },
        onResult: publish
      })
    )
  )
  try {
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    pending[0](response({ usage: { input_tokens: 12, output_tokens: 25 } }))
    await vi.waitFor(() => expect(pending).toHaveLength(5))
    expect(f.record).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ bytes: png }))
  } finally {
    usage.resolve()
    pending.slice(1, 4).forEach((finish) => finish(response()))
    // If a regression holds the slot, resolve the final request after accounting completes.
    await vi.waitFor(() => expect(pending).toHaveLength(5))
    pending[4](response())
    await Promise.all(executing)
  }
})

it('keeps unknown model aliases on the minimal preset and does not invent tokens from image counts', async () => {
  const f = fixture({
    ...target,
    adapter: 'openai-images',
    model: { id: 'unknown', wireModelId: 'custom/unknown', presetId: 'openai-images/generic' }
  })
  f.fetch.mockResolvedValue(response({ usage: { generated_images: 1 } }))
  const result = await f.service.execute(request())
  expect(result.generatedImages).toBe(1)
  expect(result.usage).toBeUndefined()
  expect(f.record).not.toHaveBeenCalled()
  await expect(
    f.service.execute(request({ operation: 'edit', source: png }))
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  expect(f.fetch).toHaveBeenCalledTimes(1)
})

it('orients edit inputs and uses SGLang multipart versus official image data URLs', async () => {
  const jpeg = await sharp({
    create: { width: 256, height: 128, channels: 3, background: '#abcdef' }
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const local = fixture({
    ...target,
    adapter: 'openai-images',
    baseUrl: 'http://localhost:3000/v1/',
    apiKey: undefined,
    model: { ...target.model, presetId: 'minimax-h3/sglang' }
  })
  await local.service.execute(
    request({ operation: 'edit', source: jpeg, options: { size: '1024x1024', seed: 42 } })
  )
  const [url, init] = local.fetch.mock.calls[0]
  expect(url).toBe('http://localhost:3000/v1/images/edits')
  expect(init!.headers).toEqual({})
  const body = init!.body as FormData
  expect(body.get('seed')).toBe('42')
  expect(body.get('size')).toBe('1024x1024')
  expect(
    await sharp(Buffer.from(await (body.get('image') as Blob).arrayBuffer())).metadata()
  ).toMatchObject({ width: 128, height: 256, format: 'png' })
  const official = fixture()
  await official.service.execute(request({ operation: 'edit', source: jpeg }))
  expect(JSON.parse(official.fetch.mock.calls[0][1]!.body as string)).toMatchObject({
    images: [{ image_url: expect.stringMatching(/^data:image\/png;base64,/) }]
  })
})

it('rejects unavailable credentials, invalid options, prompts and source bytes before charging', async () => {
  const f = fixture()
  for (const input of [
    request({ prompt: ' ' }),
    request({ prompt: 'x'.repeat(32001) }),
    request({ options: { seed: 42 } }),
    request({ source: png }),
    request({ operation: 'edit' }),
    request({ operation: 'edit', source: Buffer.from('<svg/>') })
  ]) {
    await expect(f.service.execute(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  }
  expect(f.fetch).not.toHaveBeenCalled()
  f.resolve.mockResolvedValue(undefined)
  await expect(f.service.execute(request())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  const noKey = fixture({ ...target, apiKey: undefined })
  await expect(noKey.service.execute(request())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  expect(noKey.fetch).not.toHaveBeenCalled()
})

it('does not retry HTTP rejections or uncertain upstream failures, and keeps errors redacted', async () => {
  for (const status of [302, 400, 401, 422, 429, 408, 500, 502]) {
    const f = fixture()
    f.fetch.mockResolvedValue(new Response('private-key https://signed.example/token', { status }))
    await expect(f.service.execute(request())).rejects.toMatchObject({
      code:
        status >= 500 || status === 408
          ? 'OUTCOME_UNKNOWN'
          : status === 401
            ? 'AUTHENTICATION_FAILED'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 400 || status === 422
                ? 'INVALID_REQUEST'
                : 'PROVIDER_ERROR'
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  }
  const f = fixture()
  f.fetch.mockRejectedValue(new Error('private-key'))
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN',
    message: expect.not.stringContaining('private-key')
  })
  expect(f.fetch).toHaveBeenCalledTimes(1)
})

it('rejects oversized, forged, malformed and multiple results after a single submission', async () => {
  for (const b64_json of ['YR==', 'YWJ=', 'YWJ\n', 'A==='])
    expect(() => readImageResult({ data: [{ b64_json }] })).toThrow('Invalid image encoding.')
  const invalid = [
    new Response('ignored', {
      headers: { 'content-length': String(MAX_IMAGE_RESPONSE_BYTES + 1) }
    }),
    Response.json({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }),
    Response.json({ data: [{ b64_json: png.subarray(0, 40).toString('base64') }] }),
    Response.json({ data: [{ b64_json: '!!!!' }] }),
    Response.json({
      data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }]
    }),
    new Response('{')
  ]
  for (const reply of invalid) {
    const f = fixture()
    f.fetch.mockResolvedValue(reply)
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  }
})

it('retains measured usage when a result URL expires and never repeats generation', async () => {
  const f = fixture()
  const url = 'https://cdn.example/图片?secret=123'
  const body = Buffer.from(
    JSON.stringify({
      data: [{ url }],
      usage: { input_tokens: 10, output_tokens: 20 }
    })
  )
  const split = body.indexOf('图') + 1
  f.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(body.subarray(0, split))
          stream.enqueue(body.subarray(split))
          stream.close()
        }
      })
    )
  )
  f.download.mockRejectedValue(new Error(`expired ${url}`))
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: 'OUTCOME_UNKNOWN',
    message: expect.not.stringContaining('secret=123')
  })
  expect(f.download).toHaveBeenCalledWith(url, expect.any(AbortSignal))
  expect(f.record).toHaveBeenCalledTimes(1)
  expect(f.fetch).toHaveBeenCalledTimes(1)
})

it('validates a 4K result without changing the global preview pixel limit', async () => {
  const image = await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: '#fff' }
  })
    .png()
    .toBuffer()
  const f = fixture()
  f.fetch.mockResolvedValue(Response.json({ data: [{ b64_json: image.toString('base64') }] }))
  expect(await f.service.execute(request())).toMatchObject({ width: 4096, height: 4096 })
})

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
it('aborts a live upstream request without retrying and rejects later calls after shutdown', async () => {
  let requests = 0
  let received!: () => void
  let closed!: () => void
  const started = new Promise<void>((resolve) => {
    received = resolve
  })
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve
  })
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.on('close', closed)
    received()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const f = fixture({ ...target, baseUrl: `http://127.0.0.1:${port}/v1` })
  f.fetch.mockImplementation(globalThis.fetch)
  const abort = new AbortController()
  const call = f.service.execute(request({ signal: abort.signal }))
  const failure = expect(call).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  await started
  abort.abort()
  await failure
  await disconnected
  expect(requests).toBe(1)
  f.service.close()
  await expect(f.service.execute(request())).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(requests).toBe(1)
})

it('records cancellation during receipt creation without calling the provider', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ImageResultStore } = await import('./result-store')
  const root = await mkdtemp(join(tmpdir(), 'image-receipt-'))
  const abort = new AbortController()
  const upstream = vi.fn(async () => response())
  const results = new ImageResultStore(
    () => root,
    async () => {
      throw new Error('No published Version')
    }
  )
  const begin = results.begin.bind(results)
  vi.spyOn(results, 'begin').mockImplementation(async (...args) => {
    await begin(...args)
    abort.abort()
  })
  const service = new ImageModelService({
    results,
    resolveTarget: async () => target,
    fetch: upstream,
    download: async () => png,
    recordUsage: async () => {}
  })
  const input = request({ signal: abort.signal })
  try {
    await expect(service.execute(input)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(results.inspectReceipt(input.context)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(upstream).not.toHaveBeenCalled()
  } finally {
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('times out without retrying a request that may already have been accepted', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
  )
  const service = new ImageModelService({
    resolveTarget: async () => target,
    fetch,
    download: async () => png,
    recordUsage: async () => {},
    timeoutMs: 20
  })
  await expect(service.execute(request())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('captures the explicitly selected model without consulting the default on later invocations', async () => {
  const f = fixture()
  const selection = { serviceId: 'selected-service', modelId: 'selected-model' }
  const invoke = f.service.capture(selection)
  selection.modelId = 'changed-after-send'
  expect(f.resolve).toHaveBeenCalledWith({
    serviceId: 'selected-service',
    modelId: 'selected-model'
  })
  f.resolve.mockResolvedValue(undefined)
  await invoke(request())
  expect(f.resolve).toHaveBeenCalledOnce()
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('sends a separate guide for dense lasso selections without exhausting the prompt budget', async () => {
  const f = fixture()
  const source = await sharp({
    create: { width: 800, height: 1600, channels: 3, background: '#abcabc' }
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const original = Buffer.from(source)
  const spatial = {
    naturalSize: { width: 1600, height: 800 },
    regions: Array.from({ length: 3 }, (_, index) => ({
      id: `region-${index + 1}`,
      number: index + 1,
      instruction: `Change region ${index + 1} to warm sand`,
      geometry: {
        kind: 'polygon' as const,
        points: Array.from({ length: 256 }, (_, point) => {
          const angle = (point * Math.PI) / 128
          return { x: 0.22 + index * 0.27 + Math.cos(angle) * 0.11, y: 0.5 + Math.sin(angle) * 0.3 }
        })
      }
    }))
  }
  const result = await f.service.execute(request({ operation: 'edit', source, spatial }))
  const body = JSON.parse(f.fetch.mock.calls[0][1]!.body as string)
  expect(body.images).toHaveLength(2)
  expect(body.images[0].image_url).toMatch(/^data:image\/png;base64,/)
  expect(body.images[1].image_url).toMatch(/^data:image\/jpeg;base64,/)
  const clean = Buffer.from(body.images[0].image_url.split(',')[1], 'base64')
  const annotated = Buffer.from(body.images[1].image_url.split(',')[1], 'base64')
  expect(clean).toEqual(await sharp(source).autoOrient().png().toBuffer())
  expect(source).toEqual(original)
  expect(await sharp(annotated).metadata()).toMatchObject({ width: 1280, height: 640 })
  const guidePixels = await sharp(annotated).raw().toBuffer()
  expect(guidePixels.some((value, index) => index % 3 === 0 && value < 50)).toBe(true)
  expect(body.prompt).toContain('Edit Picture 1')
  expect(body.prompt).toContain('Use Picture 2 only to locate the numbered instructions')
  expect(body.prompt).toContain('3. Change region 3 to warm sand')
  expect(body.prompt.length).toBeLessThan(1000)
  expect(result.promptLength).toBe(Array.from(body.prompt).length)
  await expect(
    f.service.execute(
      request({
        operation: 'edit',
        source,
        spatial: { ...spatial, naturalSize: { width: 127, height: 128 } }
      })
    )
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  expect(f.fetch).toHaveBeenCalledOnce()
})

it.each([
  ['openai/gpt-image-2.6', 'openai-images'],
  ['qwen/image-3.0', 'qwen-images'],
  ['seedream/5.5', 'seedream']
] as const)('encodes generation and edits with the %s contract', async (presetId, adapter) => {
  const f = fixture({ ...target, adapter, model: { ...target.model, presetId } })
  for (const operation of ['generate', 'edit'] as const) {
    if (adapter === 'qwen-images')
      f.fetch.mockResolvedValueOnce(
        Response.json({
          data: [{ url: 'https://images.example/result.png' }],
          usage: { output_image_count: 1, input_image_count: operation === 'edit' ? 1 : 0 }
        })
      )
    else if (adapter === 'seedream')
      f.fetch.mockResolvedValueOnce(
        response({ usage: { generated_images: 1, output_tokens: 64, total_tokens: 64 } })
      )
    else f.fetch.mockResolvedValueOnce(response({ usage: { input_tokens: 12, output_tokens: 32 } }))
    const result = await f.service.execute(
      request({ operation, ...(operation === 'edit' ? { source: png } : {}) })
    )
    const [url, init] = f.fetch.mock.calls.at(-1)!
    expect(url).toBe(
      `https://images.example/v1/images/${operation === 'edit' && adapter === 'openai-images' ? 'edits' : 'generations'}`
    )
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe('relay/h3')
    if (adapter === 'seedream') expect(body).not.toHaveProperty('n')
    else expect(body.n).toBe(1)
    expect(body).not.toHaveProperty('sequential_image_generation')
    if (adapter !== 'seedream') expect(body).not.toHaveProperty('response_format')
    if (operation === 'edit') {
      if (adapter === 'openai-images')
        expect(body.images[0].image_url).toMatch(/^data:image\/png;base64,/)
      else expect(body.image).toMatch(/^data:image\/png;base64,/)
    } else {
      expect(body).not.toHaveProperty('image')
      expect(body).not.toHaveProperty('images')
    }
    expect(result.mime).toBe('image/png')
  }
  if (adapter === 'qwen-images') {
    expect(f.download).toHaveBeenCalledTimes(2)
    expect(f.record).not.toHaveBeenCalled()
  } else {
    expect(f.record).toHaveBeenCalledTimes(2)
    if (adapter === 'seedream')
      expect(f.record.mock.calls[0][0].usage).toMatchObject({ inputTokens: 0, outputTokens: 64 })
  }
})

it('shares four execution slots across captured and direct calls and cancels queued work', async () => {
  const f = fixture()
  const turn = f.service.capture()
  const pending: Array<(value: Response) => void> = []
  f.fetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const active = Array.from({ length: 4 }, (_, index) =>
    index % 2
      ? turn(request({ context: { ...request().context, invocationId: `active-${index}` } }))
      : f.service.execute(
          request({ context: { ...request().context, invocationId: `active-${index}` } })
        )
  )
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(4))
  const controller = new AbortController()
  const cancelled = f.service.execute(
    request({
      signal: controller.signal,
      context: { ...request().context, invocationId: 'cancelled' }
    })
  )
  const cancelledResult = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
  const waiting = turn(request())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.fetch).toHaveBeenCalledTimes(4)
  controller.abort()
  await cancelledResult
  pending.shift()!(response())
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(5))
  for (const finish of pending) finish(response())
  await Promise.all([...active, waiting])
  expect(f.record).not.toHaveBeenCalled()
})

it('reserves extra slots for large edits and advances FIFO when a queued edit is cancelled', async () => {
  const f = fixture()
  const pending: Array<(value: Response) => void> = []
  f.fetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const call = (
    invocationId: string,
    input: Partial<ImageModelRequest> = {}
  ): Promise<ImageModelResult> =>
    f.service.execute(request({ ...input, context: { ...request().context, invocationId } }))
  const heavy: Partial<ImageModelRequest> = {
    operation: 'edit',
    source: async () => png,
    sourceSizeBytes: 2 * 1024 * 1024,
    sourcePixels: 16_000_000
  }
  const first = call('heavy', heavy)
  const second = call('small')
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
  const controller = new AbortController()
  const queued = call('queued', { ...heavy, signal: controller.signal })
  const cancelled = expect(queued).rejects.toMatchObject({ code: 'CANCELLED' })
  const waiting = call('waiting')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.fetch).toHaveBeenCalledTimes(2)
  controller.abort()
  await cancelled
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3))
  for (const finish of pending) finish(response())
  await Promise.all([first, second, waiting])
})

it('cancels queued calls on shutdown without submitting them', async () => {
  const f = fixture()
  f.fetch.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
  )
  const calls = Array.from({ length: 6 }, (_, index) =>
    f.service.execute(request({ context: { ...request().context, invocationId: `call-${index}` } }))
  )
  const settled = Promise.allSettled(calls)
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(4))
  f.service.close()
  expect((await settled).map((result) => result.status)).toEqual(Array(6).fill('rejected'))
  expect(f.fetch).toHaveBeenCalledTimes(4)
})

it.each([
  [200, { base_resp: { status_code: 1008, status_msg: 'private-key' } }, 'QUOTA_EXCEEDED'],
  [200, { base_resp: { status_code: 1001 } }, 'OUTCOME_UNKNOWN'],
  [200, { error: { code: 'moderation_blocked', message: 'private-key' } }, 'CONTENT_BLOCKED'],
  [200, { data: [{ error: { code: 'OutputImageSensitiveContentDetected' } }] }, 'CONTENT_BLOCKED'],
  [429, { error: { type: 'insufficient_quota' } }, 'QUOTA_EXCEEDED'],
  [403, { code: 'Arrearage', message: 'private-key' }, 'QUOTA_EXCEEDED'],
  [200, { error: { code: 'constructor', message: 'private-key' } }, 'PROVIDER_ERROR'],
  [503, { error: { code: 'invalid_api_key' } }, 'OUTCOME_UNKNOWN'],
  [200, { code: 'DataInspectionFailed' }, 'CONTENT_BLOCKED']
])(
  'classifies HTTP %s business failures without exposing upstream text',
  async (status, body, code) => {
    const f = fixture()
    f.fetch.mockResolvedValue(Response.json(body, { status: status as number }))
    const error = await f.service.execute(request()).catch((error) => error)
    expect(error).toMatchObject({ code, detail: { code, httpStatus: status } })
    expect(String(error)).not.toContain('private-key')
    expect(f.fetch).toHaveBeenCalledOnce()
  }
)
it('bounds rejection bodies and retains the HTTP classification', async () => {
  const f = fixture()
  f.fetch.mockResolvedValue(new Response('x'.repeat(20_000), { status: 401 }))
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: 'AUTHENTICATION_FAILED'
  })
})

it('keeps queued source buffers lazy, bounds the queue, and deduplicates concurrent identities', async () => {
  const f = fixture()
  const pending: Array<(value: Response) => void> = []
  f.fetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const source = vi.fn(async () => png)
  const make = (index: number, signal = new AbortController().signal): ImageModelRequest =>
    request({
      operation: 'edit',
      source,
      sourceIdentity: `source-${index}`,
      sourcePixels: 128 * 128,
      signal,
      context: { ...request().context, invocationId: `lazy-${index}` }
    })
  const active = Array.from({ length: 4 }, (_, i) => f.service.execute(make(i)))
  const duplicate = f.service.execute(make(0))
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(4))
  const controller = new AbortController()
  const waiting = Array.from({ length: 32 }, (_, i) =>
    f.service.execute(make(i + 4, controller.signal))
  )
  const settled = Promise.allSettled(waiting)
  await expect(f.service.execute(make(99))).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  expect(source).toHaveBeenCalledTimes(4)
  controller.abort()
  expect((await settled).every(({ status }) => status === 'rejected')).toBe(true)
  pending.forEach((finish) => finish(response()))
  await Promise.all([...active, duplicate])
  expect(f.fetch).toHaveBeenCalledTimes(4)
})

it('preserves paid bytes when cancellation arrives after downloading the result', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.fetch.mockResolvedValue(Response.json({ data: [{ url: 'https://images.example/result' }] }))
  f.download.mockImplementation(async () => {
    controller.abort()
    return png
  })
  await expect(f.service.execute(request({ signal: controller.signal }))).resolves.toMatchObject({
    mime: 'image/png'
  })
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('does not repeat a paid request when Artifact publication fails', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ImageResultStore } = await import('./result-store')
  const root = await mkdtemp(join(tmpdir(), 'image-receipt-'))
  const upstream = vi.fn(async () => response())
  const create = (): ImageModelService =>
    new ImageModelService({
      results: new ImageResultStore(
        () => root,
        async () => {
          throw new Error('No published Version')
        }
      ),
      resolveTarget: async () => target,
      fetch: upstream,
      download: async () => png,
      recordUsage: async () => {}
    })
  try {
    await expect(
      create().execute(
        request({
          onResult: async () => {
            throw new Error('disk unavailable')
          }
        })
      )
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    await expect(create().execute(request())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(upstream).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains execution slots while large results wait for publication', async () => {
  const f = fixture()
  const publications: Array<() => void> = []
  const calls = Array.from({ length: 5 }, (_, index) =>
    f.service.execute(
      request({
        context: { ...request().context, invocationId: `publish-${index}` },
        onResult: async () => {
          await new Promise<void>((resolve) => publications.push(resolve))
          return { artifactId: 'a', versionId: 'v' }
        }
      })
    )
  )
  await vi.waitFor(() => expect(publications).toHaveLength(4))
  expect(f.fetch).toHaveBeenCalledTimes(4)
  publications.shift()!()
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(5))
  await vi.waitFor(() => expect(publications).toHaveLength(4))
  publications.forEach((finish) => finish())
  await Promise.all(calls)
})
