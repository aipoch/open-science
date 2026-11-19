import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, expect, it, vi, type Mock } from 'vitest'
import type { ResolvedImageModel } from './contract'
import { ImageModelService } from './service'
import { ImageResultStore } from './result-store'
import { readImageResult } from './adapter'
import {
  ImageModelError,
  MAX_IMAGE_RESPONSE_BYTES,
  type ImageModelRequest,
  type ImageModelResult
} from './contract'

let png: Buffer
let png4k: Buffer
beforeAll(async () => {
  png = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#abcabc' } })
    .png()
    .toBuffer()
  png4k = await sharp({
    create: { width: 4096, height: 4096, channels: 4, background: '#12345678' }
  })
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
function fixture(
  selected: ResolvedImageModel | undefined = target,
  reserveResult?: () => Promise<() => void>
): {
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
      reserveResult,
      recordUsage: record
    }),
    fetch,
    download,
    record,
    resolve
  }
}

it('rejects known oversized sources before reading them or contacting the selected provider', async () => {
  const f = fixture({
    ...target,
    adapter: 'qwen-images',
    model: { id: 'qwen', wireModelId: 'qwen-image', presetId: 'qwen/image-3.0' }
  })
  const source = vi.fn(async () => png)
  await expect(
    f.service.execute(request({ operation: 'edit', source, sourceSizeBytes: 10 * 1024 * 1024 + 1 }))
  ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_EXCEEDED' })
  expect(source).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not contact the provider when local storage cannot hold the result', async () => {
  const f = fixture(target, async () => {
    throw new ImageModelError('STORAGE_FULL', 'Not enough disk space.')
  })
  await expect(f.service.execute(request())).rejects.toMatchObject({ code: 'STORAGE_FULL' })
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.record).not.toHaveBeenCalled()
})

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

it('publishes the image and keeps its execution slot until measured usage is staged', async () => {
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
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ bytes: png }))
    )
    expect(f.record).toHaveBeenCalledOnce()
    expect(pending).toHaveLength(4)
    usage.resolve()
    await vi.waitFor(() => expect(pending).toHaveLength(5))
  } finally {
    usage.resolve()
    pending.slice(1, 4).forEach((finish) => finish(response()))
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
    request({
      operation: 'edit',
      source: jpeg,
      options: { size: '1024x1024', seed: 42 },
      spatial: {
        naturalSize: { width: 128, height: 256 },
        regions: [
          {
            id: 'p1',
            number: 1,
            instruction: 'Remove the mark.',
            geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
          }
        ]
      }
    })
  )
  const [url, init] = local.fetch.mock.calls[0]
  expect(url).toBe('http://localhost:3000/v1/images/edits')
  expect(init!.headers).toEqual({})
  const body = init!.body as FormData
  expect(body.get('seed')).toBe('42')
  expect(body.get('size')).toBe('1024x1024')
  expect(body.get('output_format')).toBe('png')
  expect(body.getAll('image').map((file) => (file as Blob).type)).toEqual([
    'image/png',
    'image/jpeg'
  ])
  expect(body.get('prompt')).toEqual(expect.stringContaining('Use Picture 2 only'))
  expect(
    await sharp(Buffer.from(await (body.get('image') as Blob).arrayBuffer())).metadata()
  ).toMatchObject({ width: 128, height: 256, format: 'png' })
  const official = fixture()
  await official.service.execute(request({ operation: 'edit', source: jpeg }))
  expect(JSON.parse(official.fetch.mock.calls[0][1]!.body as string)).toMatchObject({
    images: [{ image_url: expect.stringMatching(/^data:image\/png;base64,/) }]
  })
})

it.each([
  [4000, 1, 1280, 1],
  [1, 4000, 1, 1280]
])(
  'sends a valid point guide for a %i × %i source',
  async (width, height, guideWidth, guideHeight) => {
    const source = await sharp({ create: { width, height, channels: 3, background: 'white' } })
      .png()
      .toBuffer()
    const f = fixture({
      ...target,
      adapter: 'openai-images',
      model: { ...target.model, presetId: 'minimax-h3/sglang' }
    })
    await f.service.execute(
      request({
        operation: 'edit',
        source,
        options: { size: '1024x1024' },
        spatial: {
          naturalSize: { width, height },
          regions: [
            {
              id: 'pin',
              number: 1,
              instruction: 'Recolor the center.',
              geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
            }
          ]
        }
      })
    )
    const body = f.fetch.mock.calls[0][1]!.body as FormData
    const [original, guide] = body.getAll('image') as Blob[]
    expect(Buffer.from(await original.arrayBuffer())).toEqual(source)
    expect(await sharp(Buffer.from(await guide.arrayBuffer())).metadata()).toMatchObject({
      width: guideWidth,
      height: guideHeight,
      format: 'jpeg'
    })
  }
)

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
  for (const status of [302, 400, 401, 422, 429, 408, 499, 500, 502]) {
    const f = fixture()
    f.fetch.mockResolvedValue(new Response('private-key https://signed.example/token', { status }))
    await expect(f.service.execute(request())).rejects.toMatchObject({
      code:
        status >= 500 || status === 408 || status === 499
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
  expect(f.download).toHaveBeenCalledWith(
    url,
    expect.any(AbortSignal),
    'https://images.example/v1/images/generations',
    expect.any(Function)
  )
  expect(f.record).toHaveBeenCalledTimes(1)
  expect(f.fetch).toHaveBeenCalledTimes(1)
})

it('validates a 4K result without changing the global preview pixel limit', async () => {
  const f = fixture()
  f.fetch.mockResolvedValue(Response.json({ data: [{ b64_json: png4k.toString('base64') }] }))
  expect(await f.service.execute(request())).toMatchObject({ width: 4096, height: 4096 })
})

it.each(['wire size', 'decoded pixels'])(
  'lets small responses through while a large result owns the delivery slot by %s',
  async (largeBy) => {
    const f = fixture()
    const body = JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })
    const large =
      largeBy === 'wire size'
        ? ' '.repeat(8 * 1024 * 1024) + body
        : JSON.stringify({ data: [{ b64_json: png4k.toString('base64') }] })
    if (largeBy === 'decoded pixels') expect(large.length).toBeLessThan(1024 * 1024)
    f.fetch
      .mockResolvedValueOnce(new Response(large))
      .mockResolvedValueOnce(new Response(large))
      .mockResolvedValueOnce(new Response(body))
    const publication = Promise.withResolvers<{ artifactId: string; versionId: string }>()
    const onResult = vi.fn(() => publication.promise)
    const one = f.service.execute(request({ onResult }))
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce())
    const secondPublication = vi.fn(async () => ({ artifactId: 'file', versionId: 'two' }))
    const two = f.service.execute(
      request({
        context: { ...request().context, invocationId: 'two' },
        onResult: secondPublication
      })
    )
    const small = f.service.execute(
      request({ context: { ...request().context, invocationId: 'small' } })
    )
    try {
      await expect(small).resolves.toMatchObject({ width: 128 })
      expect(f.fetch).toHaveBeenCalledTimes(3)
      expect(secondPublication).not.toHaveBeenCalled()
    } finally {
      publication.resolve({ artifactId: 'file', versionId: 'version' })
    }
    await expect(Promise.all([one, two])).resolves.toHaveLength(2)
    expect(secondPublication).toHaveBeenCalledOnce()
  }
)

it('cancels a queued large replay without reading it or losing the original result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-replay-'))
  const input = request()
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.operation, input.prompt, null, null, null]))
    .digest('hex')
  const bytes = Buffer.alloc(9 * 1024 * 1024)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const readRange = vi.fn(async () => bytes)
  const openVersion = vi.fn(async () => ({
    logicalFile: { sessionId: input.context.sessionId },
    version: { checksum },
    size: bytes.length,
    readRange,
    verifyUnchanged: async () => {},
    close: async () => {}
  }))
  const results = new ImageResultStore(() => root, openVersion)
  const fetch = vi.fn(async () => response())
  const service = new ImageModelService({
    results,
    resolveTarget: async () => target,
    fetch,
    download: async () => png,
    recordUsage: async () => {}
  })
  const publication = Promise.withResolvers<{ artifactId: string; versionId: string }>()
  const onResult = vi.fn(() => publication.promise)
  const reference = { artifactId: 'artifact', versionId: 'version' }
  const contexts = [input.context, { ...input.context, invocationId: 'second-replay' }]
  const replays: Promise<ImageModelResult>[] = []
  try {
    for (const context of contexts) {
      await results.begin(context, fingerprint)
      await results.published(
        context,
        {
          bytes,
          mime: 'image/png',
          width: 4096,
          height: 4096,
          model: target.model.wireModelId,
          presetId: target.model.presetId,
          serviceId: target.serviceId,
          parameters: {}
        },
        reference
      )
    }
    replays.push(service.execute({ ...input, onResult }))
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const waiting = expect(
      service.execute({ ...input, context: contexts[1], signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(openVersion).toHaveBeenCalledTimes(2))
    await expect(
      service.execute({ ...input, context: { ...input.context, invocationId: 'small-provider' } })
    ).resolves.toMatchObject({ width: 128 })
    expect(readRange).toHaveBeenCalledOnce()
    controller.abort()
    await waiting
    expect(readRange).toHaveBeenCalledOnce()
    publication.resolve(reference)
    replays.push(service.execute({ ...input, context: contexts[1] }))
    await expect(Promise.all(replays)).resolves.toHaveLength(2)
    expect(readRange).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    publication.resolve(reference)
    await Promise.allSettled(replays)
    service.close()
    await rm(root, { recursive: true, force: true })
  }
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
  expect(body.prompt).toContain('Lasso 3: spans 65%–87% from the left and 20%–80% from the top.')
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
  ['minimax-h3/official', 'minimax'],
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
      request({
        operation,
        ...(operation === 'edit'
          ? {
              source: png,
              spatial: {
                naturalSize: { width: 128, height: 128 },
                regions: [
                  {
                    id: 'pin',
                    number: 1,
                    instruction: 'Change the marked object to red.',
                    geometry: { kind: 'point', point: { x: 0.387, y: 0.418 } }
                  },
                  {
                    id: 'box',
                    number: 2,
                    instruction: 'Soften the background.',
                    geometry: {
                      kind: 'rectangle',
                      start: { x: 0.1, y: 0.1 },
                      end: { x: 0.3, y: 0.3 }
                    }
                  },
                  {
                    id: 'arrow',
                    number: 3,
                    instruction: 'Keep the label readable.',
                    geometry: {
                      kind: 'arrow',
                      start: { x: 0.7, y: 0.8 },
                      end: { x: 0.9, y: 0.6 }
                    }
                  },
                  {
                    id: 'lasso',
                    number: 4,
                    instruction: 'Lighten this area.',
                    geometry: {
                      kind: 'polygon',
                      points: [
                        { x: 0.25, y: 0.65 },
                        { x: 0.1, y: 0.5 },
                        { x: 0.3, y: 0.6 },
                        { x: 0.4, y: 0.85 }
                      ]
                    }
                  }
                ]
              }
            }
          : {})
      })
    )
    const [url, init] = f.fetch.mock.calls.at(-1)!
    expect(url).toBe(
      `https://images.example/v1/images/${operation === 'edit' && (adapter === 'minimax' || adapter === 'openai-images') ? 'edits' : 'generations'}`
    )
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe('relay/h3')
    if (adapter === 'seedream') expect(body).not.toHaveProperty('n')
    else expect(body.n).toBe(1)
    expect(body).not.toHaveProperty('sequential_image_generation')
    if (adapter === 'minimax' || adapter === 'seedream')
      expect(body.response_format).toBe('b64_json')
    else expect(body).not.toHaveProperty('response_format')
    if (operation === 'edit') {
      const images =
        adapter === 'openai-images' || adapter === 'minimax'
          ? body.images.map(({ image_url }: { image_url: string }) => image_url)
          : body.image
      const original = await sharp(png).autoOrient().png().toBuffer()
      expect(images).toEqual([
        'data:image/png;base64,' + original.toString('base64'),
        expect.stringMatching(/^data:image\/jpeg;base64,/)
      ])
      expect(body.prompt).toContain('Use Picture 2 only to locate the numbered instructions')
      expect(body.prompt).toContain('target its interior')
      expect(body.prompt).toContain('target what its tip points to')
      if (adapter === 'seedream') {
        expect(body.prompt).toContain(
          '图1<point>387 418</point>.\n1. Change the marked object to red.'
        )
        expect(body.prompt).toContain('图1<bbox>100 100 300 300</bbox>.\n2. Soften the background.')
        expect(body.prompt).toContain(
          'Arrow 3 points to 图1<point>900 600</point> from (70% from the left edge, 80% from the top edge).\n3. Keep the label readable.'
        )
        expect(body.prompt.match(/<bbox>/g)).toHaveLength(1)
      } else {
        expect(body.prompt).toContain('Edit only the object at that same location in the original')
        expect(body.prompt).toContain(
          'Instruction for the teal badge labeled 1: Change the marked object to red.'
        )
        expect(body.prompt).toContain(
          'Target point 1: 38.7% from the left edge, 41.8% from the top'
        )
        expect(body.prompt).toContain(
          'Rectangle 2: upper-left (10% from the left edge, 10% from the top edge), lower-right (30% from the left edge, 30% from the top edge).\n2. Soften the background.'
        )
        expect(body.prompt).toContain(
          'Arrow 3: tip (90% from the left edge, 60% from the top edge), tail (70% from the left edge, 80% from the top edge).\n3. Keep the label readable.'
        )
        expect(body.prompt).not.toMatch(/<point>|<bbox>/)
      }
      expect(body.prompt).toContain(
        'Lasso 4: spans 10%–40% from the left and 50%–85% from the top. Follow its drawn outline.\n4. Lighten this area.'
      )
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

it.each([
  ['minimax-h3/official', 'minimax', 'MiniMax-H3-Image'],
  ['openai/gpt-image-2.6', 'openai-images', 'gpt-image-2.6-flare'],
  ['qwen/image-3.0', 'qwen-images', 'qwen-image-3.0-pro'],
  ['seedream/5.5', 'seedream', 'doubao-seedream-5-5-261028']
] as const)(
  'keeps oriented pixels and all spatial targets aligned on the %s wire',
  async (presetId, adapter, wireModelId) => {
    // Raw left red strip becomes the top strip after EXIF rotation, independently of the overlay.
    const source = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600"><rect width="800" height="1600" fill="white"/><rect width="80" height="1600" fill="red"/></svg>'
      )
    )
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const f = fixture({ ...target, adapter, model: { ...target.model, presetId, wireModelId } })
    await f.service.execute(
      request({
        operation: 'edit',
        source,
        spatial: {
          naturalSize: { width: 1600, height: 800 },
          regions: [
            {
              id: 'point',
              number: 1,
              instruction: 'Recolor this object.',
              geometry: { kind: 'point', point: { x: 0, y: 0.2 } }
            },
            {
              id: 'box',
              number: 2,
              instruction: 'Recolor the box interior.',
              geometry: { kind: 'rectangle', start: { x: 0.1, y: 0.65 }, end: { x: 0.3, y: 0.85 } }
            },
            {
              id: 'arrow',
              number: 3,
              instruction: 'Recolor the target, not the tail.',
              geometry: { kind: 'arrow', start: { x: 0.5, y: 0.8 }, end: { x: 0.5, y: 0.4 } }
            },
            {
              id: 'lasso',
              number: 4,
              instruction: 'Recolor the L-shaped area.',
              geometry: {
                kind: 'polygon',
                points: [
                  { x: 0.6, y: 0.1 },
                  { x: 0.9, y: 0.1 },
                  { x: 0.9, y: 0.5 },
                  { x: 0.8, y: 0.5 },
                  { x: 0.8, y: 0.3 },
                  { x: 0.6, y: 0.3 }
                ]
              }
            }
          ]
        }
      })
    )
    const body = JSON.parse(f.fetch.mock.calls[0][1]!.body as string)
    const images: string[] =
      body.images?.map((image: { image_url: string }) => image.image_url) ?? body.image
    const markup = adapter === 'openai-images'
    expect(images).toHaveLength(markup ? 1 : 2)
    expect(body).not.toHaveProperty('mask')
    expect(body).not.toHaveProperty('regions')
    expect(body.model).toBe(wireModelId)
    const decode = (url: string): Buffer => Buffer.from(url.split(',')[1], 'base64')
    const clean = await sharp(decode(images[0])).raw().toBuffer({ resolveWithObject: true })
    expect(clean.info).toMatchObject({ width: 1600, height: 800 })
    const rgbAt = (pixels: typeof clean, x: number, y: number): number[] => {
      const offset =
        (Math.round(y * (pixels.info.height - 1)) * pixels.info.width +
          Math.round(x * (pixels.info.width - 1))) *
        pixels.info.channels
      return [...pixels.data.subarray(offset, offset + 3)]
    }
    const [r, g, b] = rgbAt(clean, 0.5, 0.05)
    expect(r).toBeGreaterThan(240)
    expect(Math.max(g, b)).toBeLessThan(15)
    expect(rgbAt(clean, 0.05, 0.5)).toEqual([255, 255, 255])
    const guide = await sharp(decode(markup ? body.markup.image_url : images[1]))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(guide.info).toMatchObject({
      width: markup ? 1600 : 1280,
      height: markup ? 800 : 640,
      channels: 4
    })
    // Sample visible strokes, including the concave lasso edge (not its bounding rectangle).
    for (const [x, y] of [
      [0.004, 0.2],
      [0.2, 0.85],
      [0.5, 0.42],
      [0.7, 0.3]
    ]) {
      const [red, green, blue] = rgbAt(guide, x, y)
      expect(red, `mark at ${x},${y}`).toBeLessThan(140)
      expect(green).toBeGreaterThan(red + 20)
      expect(blue).toBeGreaterThan(red + 10)
    }
    if (markup) {
      const alpha = (x: number, y: number): number =>
        guide.data[(Math.round(y * 799) * 1600 + Math.round(x * 1599)) * 4 + 3]
      expect(alpha(0.016, 0.2)).toBe(0)
      expect(alpha(0.7, 0.5)).toBe(0)
      expect(alpha(0.2, 0.75)).toBe(0)
      expect(body.prompt).not.toContain('Picture 2')
    } else {
      expect(rgbAt(guide, 0.016, 0.2)).toEqual([255, 255, 255])
      expect(rgbAt(guide, 0.7, 0.5)).toEqual([255, 255, 255])
      expect(body.prompt).toContain('Edit Picture 1, the clean original')
      expect(body.prompt).toContain('Use Picture 2 only to locate')
    }
    if (adapter === 'seedream') {
      expect(body.prompt).toContain('图1<point>0 200</point>')
      expect(body.prompt).toContain('图1<bbox>100 650 300 850</bbox>')
      expect(body.prompt).toContain('Arrow 3 points to 图1<point>500 400</point>')
    } else {
      expect(body.prompt).toContain('Target point 1: 0% from the left edge, 20% from the top edge')
      expect(body.prompt).toContain('Arrow 3: tip (50% from the left edge, 40% from the top edge)')
    }
    expect(body.prompt).toContain(
      'Lasso 4: spans 60%–90% from the left and 10%–50% from the top. Follow its drawn outline.'
    )
  }
)

it('sends the OpenAI 2.6 markup as a transparent PNG at the original dimensions', async () => {
  const f = fixture({
    ...target,
    adapter: 'openai-images',
    model: { ...target.model, wireModelId: 'gpt-image-2.6-flare', presetId: 'openai/gpt-image-2.6' }
  })
  await f.service.execute(
    request({
      operation: 'edit',
      source: png,
      options: { size: '1536x864', quality: 'xhigh', background: 'transparent' },
      spatial: {
        naturalSize: { width: 128, height: 128 },
        regions: [
          {
            id: 'p1',
            number: 1,
            instruction: 'Remove the mark.',
            geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
          }
        ]
      }
    })
  )
  const body = JSON.parse(f.fetch.mock.calls[0][1]!.body as string)
  expect(body).toMatchObject({
    size: '1536x864',
    quality: 'xhigh',
    background: 'transparent',
    images: [{ image_url: `data:image/png;base64,${png.toString('base64')}` }],
    markup: { image_url: expect.stringMatching(/^data:image\/png;base64,/) }
  })
  expect(body.prompt).not.toContain('Picture 2')
  const pixels = await sharp(Buffer.from(body.markup.image_url.split(',')[1], 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(pixels.info).toMatchObject({ width: 128, height: 128, channels: 4 })
  expect(pixels.data[3]).toBe(0)
  expect(pixels.data[(64 * 128 + 64) * 4 + 3]).toBe(255)
  expect(pixels.data[(54 * 128 + 54) * 4 + 3]).toBe(0)
  expect(pixels.data[(64 * 128 + 80) * 4 + 3]).toBe(0)
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
  [
    422,
    { error: { type: 'invalid_request_error' }, data: [{ error: { code: '1027' } }] },
    'CONTENT_BLOCKED'
  ],
  [422, { error: { type: 'invalid_request_error' } }, 'CONTENT_BLOCKED'],
  [402, { error: { type: 'invalid_request_error' } }, 'QUOTA_EXCEEDED'],
  [422, { error: { message: 'private-key (1026)' } }, 'CONTENT_BLOCKED'],
  [429, { error: { type: 'insufficient_quota' } }, 'QUOTA_EXCEEDED'],
  [429, { error: { code: 'ModelAccountIpmRateLimitExceeded' } }, 'RATE_LIMITED'],
  [429, { error: { code: 'QuotaExceeded' } }, 'QUOTA_EXCEEDED'],
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
    expect(error.detail).toMatchObject({ code })
    expect(error.detail.httpStatus).toBe(Number(status) >= 400 ? status : undefined)
    expect(String(error)).not.toContain('private-key')
    expect(f.fetch).toHaveBeenCalledOnce()
  }
)
it('preserves documented provider codes and request identifiers without exposing the response', async () => {
  const f = fixture()
  const requestId = '31f808fd-8eef-9004-b128-deaf00000000'
  f.fetch.mockResolvedValueOnce(
    Response.json(
      {
        error: { code: 'ModelNotOpen', message: 'private-key', param: 'model' },
        request_id: requestId
      },
      { status: 404 }
    )
  )
  await expect(f.service.execute(request())).rejects.toMatchObject({
    detail: {
      code: 'ACCESS_DENIED',
      httpStatus: 404,
      providerCode: 'ModelNotOpen',
      requestId,
      parameter: 'model'
    }
  })
  f.fetch.mockResolvedValueOnce(
    Response.json(
      {
        error: { code: 'sk-private-secret', message: 'private-key', param: 'sk-private-secret' },
        request_id: 'sk-private-secret'
      },
      { status: 400 }
    )
  )
  const failure = await f.service.execute(request()).catch((error) => error)
  expect(failure.detail).toEqual({ code: 'INVALID_REQUEST', httpStatus: 400 })
  expect(String(failure)).not.toContain('private-key')
})

it('bounds rejection bodies and retains the HTTP classification', async () => {
  const f = fixture()
  f.fetch.mockResolvedValue(new Response('x'.repeat(20_000), { status: 401 }))
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: 'AUTHENTICATION_FAILED'
  })
})

it('keeps safe diagnostics from a server failure without treating the outcome as known', async () => {
  const f = fixture()
  const requestId = '021792308678142a2c883cf675b9804d'
  f.fetch.mockResolvedValueOnce(
    Response.json(
      { error: { message: 'private-key (1000)' }, request_id: requestId },
      { status: 500 }
    )
  )
  const failure = await f.service.execute(request()).catch((error) => error)
  expect(failure.detail).toEqual({
    code: 'OUTCOME_UNKNOWN',
    httpStatus: 500,
    providerCode: '1000',
    requestId
  })
  expect(String(failure)).not.toContain('private-key')
  expect(f.fetch).toHaveBeenCalledOnce()
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
    return png4k
  })
  await expect(f.service.execute(request({ signal: controller.signal }))).resolves.toMatchObject({
    mime: 'image/png',
    width: 4096
  })
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('does not repeat a paid request when Artifact publication fails', async () => {
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

it('retains execution slots until results are published', async () => {
  const f = fixture()
  const body = JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })
  f.fetch.mockImplementation(
    async () => new Response(body, { headers: { 'content-length': String(body.length) } })
  )
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
