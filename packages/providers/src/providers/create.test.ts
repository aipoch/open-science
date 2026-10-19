import { expect, expectTypeOf, it, vi } from 'vitest'
import { createProvider, type ClassificationModel, type ProviderConfiguration } from '../client'
import { getProviderDefinition, getProviderModels } from '../providers'
import { getVendorModelIds } from './lookup'
import type { ModelIdentity } from '../models/types'

const textInput = {
  systemPrompt: 'Translate',
  prompt: 'Cell',
  signal: new AbortController().signal,
  maxOutputTokens: 8,
  outputLimitBytes: 2048
}
const classificationInput = { state: 'Cell', questions: { q: { type: 'noul' } } }
const fetchResult = (url: string | URL | Request): Response =>
  Response.json(
    String(url).includes('completions')
      ? { choices: [{ finish_reason: 'stop', message: { content: 'cell' } }] }
      : {
          model: 'jev',
          usage: { input_tokens: 1, output_tokens: 2 },
          answers: { q: { type: 'noul', noul: 0.9 } }
        }
  )

it.each(['openrouter', 'opencode'])(
  'manages %s text and classification in one definition with separate capability lists',
  (id) => {
    const definition = getProviderDefinition(id)!
    expect(definition.textGeneration?.id).toBe(id)
    expect(definition.classification?.models.length).toBeGreaterThan(0)
    const classifiers = getProviderModels(id, 'classification')
    expect(classifiers.map((model) => model.modelId)).toEqual(
      definition.classification!.models.map((model) => model.id)
    )
    expect(getProviderModels(id, 'text-generation').map((model) => model.modelId)).toEqual(
      getVendorModelIds(definition.textGeneration!.id)
    )
    expect(
      getProviderModels(id, 'text-generation').every(
        (model) => model.capability === 'text-generation'
      )
    ).toBe(true)
    for (const model of classifiers) {
      expect(model).toMatchObject({
        providerId: id,
        capability: 'classification',
        execution: 'remote'
      })
      expect(
        getProviderModels(id, 'text-generation').some((text) => text.modelId === model.modelId)
      ).toBe(false)
      expect(Object.isFrozen(model)).toBe(true)
    }
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.classification!.models)).toBe(true)
  }
)

it('includes classification-only models and leaves local models unsupported', () => {
  expect(getProviderModels('typesafe', 'text-generation')).toEqual([])
  expect(getProviderModels('typesafe', 'classification')).toEqual([
    {
      providerId: 'typesafe',
      modelId: 'jev-latest',
      label: 'Jev Latest',
      capability: 'classification',
      execution: 'remote'
    },
    {
      providerId: 'typesafe',
      modelId: 'jev-preview',
      label: 'Jev Preview',
      capability: 'classification',
      execution: 'remote'
    }
  ])
  expect(getProviderDefinition('local')).toBeUndefined()
  expect(getProviderModels('local', 'text-generation')).toEqual([])
  expect(getProviderModels('local', 'classification')).toEqual([])
  expect(getProviderModels('unknown', 'text-generation')).toEqual([])
  expect(getProviderDefinition('toString')).toBeUndefined()
})

it.each(['typesafe', 'openrouter', 'opencode'])(
  'resolves %s classification endpoint inside the package',
  async (id) => {
    const fetch = vi.fn(async (url) => fetchResult(url))
    const provider = createProvider({ id, key: 'credential', fetch })
    const model = provider.classificationModel('future-model:opaque/id')
    const result = await model.classify(classificationInput)
    expect(result.answers.q).toMatchObject({ noul: 0.9 })
    expect(model).toMatchObject({
      providerId: id,
      modelId: 'future-model:opaque/id',
      capability: 'classification'
    })
    expect(fetch.mock.calls[0]).toEqual([
      getProviderDefinition(id)!.classification!.endpoint,
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer credential' },
        body: JSON.stringify({ model: 'future-model:opaque/id', ...classificationInput })
      })
    ])
    expect(fetch).toHaveBeenCalledOnce()
    expect(Object.isFrozen(model)).toBe(true)
    expect(model).not.toHaveProperty('key')
    expect(model).not.toHaveProperty('generate')
    expectTypeOf(model).toExtend<ModelIdentity<'classification'>>()
  }
)

it('binds both model capabilities to an immutable account connection without sharing mutable state', async () => {
  const fetch = vi.fn(async (url) => fetchResult(url))
  const configuration = {
    id: 'openrouter',
    key: 'first',
    fetch,
    textGeneration: {
      protocol: 'chat-completions' as const,
      url: 'https://first.test/completions'
    },
    classification: { url: 'https://first.test/decisions', maxResponseBytes: 2048 }
  }
  const provider = createProvider(configuration)
  configuration.key = 'second'
  configuration.textGeneration.url = 'https://second.test/completions'
  configuration.classification.url = 'https://second.test/decisions'
  const other = createProvider(configuration)
  const text = provider.textGenerationModel('chat-model')
  const classifier = provider.classificationModel('decision-model')
  await expect(text.generate(textInput)).resolves.toEqual({ text: 'cell', stopReason: 'end_turn' })
  await classifier.classify(classificationInput)
  await other.textGenerationModel('other-model').generate(textInput)
  await other.classificationModel('other-decision').classify(classificationInput)
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    'https://first.test/completions',
    'https://first.test/decisions',
    'https://second.test/completions',
    'https://second.test/decisions'
  ])
  const init = fetch.mock.calls.map((call) => (call as unknown as [unknown, RequestInit])[1])
  expect(init.map((value) => new Headers(value.headers).get('authorization'))).toEqual([
    'Bearer first',
    'Bearer first',
    'Bearer second',
    'Bearer second'
  ])
  expect(init.map((value) => JSON.parse(String(value.body)).model)).toEqual([
    'chat-model',
    'decision-model',
    'other-model',
    'other-decision'
  ])
  expect(Object.isFrozen(provider)).toBe(true)
  expect(Object.isFrozen(text)).toBe(true)
  expect(text).not.toHaveProperty('request')
  expectTypeOf(text).toExtend<ModelIdentity<'text-generation'>>()
})

it('requires explicit custom endpoints and rejects unavailable capabilities before network access', () => {
  const fetch = vi.fn()
  expect(() => createProvider({ id: 'typesafe', fetch }).textGenerationModel('jev')).toThrow(
    'text endpoint'
  )
  expect(() => createProvider({ id: 'local', fetch }).textGenerationModel('qwen')).toThrow(
    'remote text endpoint'
  )
  expect(() => createProvider({ id: 'openai', fetch }).classificationModel('m')).toThrow(
    'classification endpoint'
  )
  expect(() => createProvider({ id: 'custom', fetch }).classificationModel('m')).toThrow(
    'classification endpoint'
  )
  expect(() => createProvider({ id: ' ', fetch })).toThrow('nonempty')
  expect(() => createProvider({ id: 'typesafe', fetch }).classificationModel(' ')).toThrow(
    'nonempty'
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps custom classification bounds and does not source implicit environment credentials', async () => {
  const fetch = vi.fn(async () => new Response('x'.repeat(33)))
  const config: ProviderConfiguration = {
    id: 'custom',
    fetch,
    classification: { url: 'https://custom.test/classify', maxResponseBytes: 32 }
  }
  const exchange = createProvider(config)
    .classificationModel('future-model')
    .classify(classificationInput)
  await expect(exchange).rejects.toMatchObject({
    code: 'invalid-response',
    cause: expect.objectContaining({ message: expect.stringContaining('exceeded 32 bytes') })
  })
  expect(fetch.mock.calls[0]).toEqual([
    'https://custom.test/classify',
    expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
  ])
})

// The provider identity must not override the explicitly configured custom wire dialect.
it.each([
  {
    transport: 'reasoning-effort' as const,
    fields: { reasoning_effort: 'none', max_completion_tokens: 8 }
  },
  { transport: 'deepseek' as const, fields: { thinking: { type: 'disabled' }, max_tokens: 8 } },
  { transport: 'minimax' as const, fields: { thinking: { type: 'disabled' }, max_tokens: 8 } },
  { transport: 'xiaomimimo' as const, fields: { thinking: { type: 'disabled' }, max_tokens: 8 } },
  { transport: 'openrouter' as const, fields: { reasoning: { enabled: false }, max_tokens: 8 } }
])(
  'preserves custom $transport reasoning and token limit fields',
  async ({ transport, fields }) => {
    for (const id of ['custom', 'organization-gateway']) {
      const fetch = vi.fn(async (url) => fetchResult(url))
      const model = createProvider({
        id,
        fetch,
        textGeneration: {
          protocol: 'chat-completions',
          url: 'https://custom.test/completions',
          reasoningEffort: 'none',
          reasoningEffortTransport: transport
        }
      }).textGenerationModel('opaque-model')
      await model.generate(textInput)
      const body = JSON.parse(
        String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)
      )
      expect(body).toEqual({
        model: 'opaque-model',
        messages: [
          { role: 'system', content: textInput.systemPrompt },
          { role: 'user', content: textInput.prompt }
        ],
        stream: false,
        ...fields
      })
      expect(model.providerId).toBe(id)
    }
  }
)

const images = {
  figure: { type: 'image' as const, format: 'png' as const, data_base64: 'aW1hZ2U=' }
}
it.each([
  ['typesafe', 'https://api.typesafe.ai/v1/systemone'],
  ['openrouter', 'https://openrouter.ai/api/v1/systemone'],
  ['opencode', 'https://opencode.ai/zen/v1/systemone']
])('encodes prepared images and chooses the %s image endpoint', async (id, endpoint) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => fetchResult('classification'))
  const signal = new AbortController().signal
  const model = createProvider({ id, key: 'credential', fetch }).classificationModel('jev-preview')
  await model.classify({ ...classificationInput, images, signal })
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    endpoint,
    expect.objectContaining({
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer credential',
        'TypeSafe-Danger-Zone-Images': 'true'
      },
      body: JSON.stringify({
        model: 'jev-preview',
        state: { text: 'Cell', images: ['figure'] },
        questions: classificationInput.questions,
        assets: images
      })
    })
  )
})

it.each(['custom', 'openrouter'])(
  'preserves an explicit %s endpoint for image requests',
  async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => fetchResult('classification'))
    const model = createProvider({
      id,
      fetch,
      classification: { url: 'https://gateway.test/decisions' }
    }).classificationModel('m')
    await model.classify({ ...classificationInput, images })
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/decisions')
  }
)

it('keeps empty image maps on the original text protocol and endpoint', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => fetchResult('classification'))
  await createProvider({ id: 'openrouter', fetch, classification: { maxRequestBytes: 1 } })
    .classificationModel('m')
    .classify({ ...classificationInput, images: {} })
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://openrouter.ai/api/alpha/decisions',
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', ...classificationInput })
    })
  )
})

it('bounds image requests in UTF-8 bytes before sending and permits the exact boundary', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => fetchResult('classification'))
  const input = { state: '🙂', questions: {}, images }
  const body = JSON.stringify({
    model: 'm',
    state: { text: input.state, images: ['figure'] },
    questions: {},
    assets: images
  })
  const bytes = Buffer.byteLength(body, 'utf8')
  expect(bytes).toBeGreaterThan(body.length)
  const model = (maxRequestBytes: number): ClassificationModel =>
    createProvider({
      id: 'typesafe',
      fetch,
      classification: { maxRequestBytes }
    }).classificationModel('m')
  await expect(model(bytes - 1).classify(input)).rejects.toThrow('body budget')
  expect(fetch).not.toHaveBeenCalled()
  await model(bytes).classify(input)
  expect(fetch).toHaveBeenCalledOnce()
})

it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects an invalid image request byte limit %s',
  (maxRequestBytes) => {
    expect(() =>
      createProvider({ id: 'typesafe', classification: { maxRequestBytes } }).classificationModel(
        'm'
      )
    ).toThrow('positive safe integer')
  }
)

it.each([
  ['openai', undefined, 'https://api.openai.com/v1/responses', 'responses', 'authorization'],
  ['anthropic', undefined, 'https://api.anthropic.com/v1/messages', 'anthropic', 'x-api-key'],
  [
    'deepseek',
    undefined,
    'https://api.deepseek.com/v1/chat/completions',
    'openai',
    'authorization'
  ],
  [
    'bailian',
    'global',
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions',
    'openai',
    'authorization'
  ]
])(
  'invokes built-in %s with just connection identity and a prompt',
  async (id, region, url, protocol, header) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        protocol === 'responses'
          ? {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'answer' }]
                }
              ]
            }
          : protocol === 'anthropic'
            ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }] }
            : { choices: [{ finish_reason: 'stop', message: { content: 'answer' } }] }
      )
    )
    const model = createProvider({ id: id!, region, key: 'secret', fetch }).textGenerationModel(
      'new-model'
    )
    expect(await model.generate({ prompt: 'hello' })).toEqual({
      text: 'answer',
      stopReason: 'end_turn'
    })
    expect(fetch.mock.calls[0][0]).toBe(url)
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get(header!)).toBe(
      header === 'x-api-key' ? 'secret' : 'Bearer secret'
    )
  }
)

it('resolves model-specific protocols and preserves explicit endpoints without mutating the connection', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'answer' } }] })
  )
  const endpoints = ['chat-completions'] as const
  const provider = createProvider({
    id: 'openai',
    fetch,
    textGeneration: { baseUrl: 'https://gateway.test/proxy?tenant=a', apiEndpoints: endpoints }
  })
  await provider.textGenerationModel('opaque-id').generate({ prompt: 'hello' })
  expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/proxy/v1/chat/completions?tenant=a')
  expect(
    createProvider({
      id: 'custom',
      textGeneration: { baseUrl: 'https://gateway.test', apiEndpoints: [] }
    }).supportsTextGeneration('m')
  ).toBe(false)
  expect(createProvider({ id: 'typesafe' }).supportsTextGeneration('m')).toBe(false)
})

it('classifies without exposing response ownership and preserves billed failures', async () => {
  const measured = vi.fn()
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      model: 'm',
      usage: { input_tokens: 5, output_tokens: 1 },
      answers: { q: { type: 'noul', noul: 2 } }
    })
  )
  const model = createProvider({ id: 'typesafe', fetch }).classificationModel('m')
  expect(model).not.toHaveProperty('request')
  await expect(model.classify(classificationInput, { onUsage: measured })).rejects.toMatchObject({
    code: 'invalid-response'
  })
  expect(measured).toHaveBeenCalledExactlyOnceWith({ model: 'm', inputTokens: 5, outputTokens: 1 })
})

it('discards a retryable body only when explicitly requested and no billing observer needs it', async () => {
  const cancel = vi.fn()
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(new ReadableStream({ cancel }), { status: 429 })
  )
  const model = createProvider({ id: 'typesafe', fetch }).classificationModel('m')
  await expect(
    model.classify(classificationInput, { retryableErrors: 'discard' })
  ).rejects.toMatchObject({ status: 429 })
  expect(cancel).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
  const measured = vi.fn()
  const billed = createProvider({
    id: 'typesafe',
    fetch: async () =>
      Response.json({ usage: { input_tokens: 3, output_tokens: 1 } }, { status: 429 })
  }).classificationModel('m')
  await expect(
    billed.classify(classificationInput, { onUsage: measured, retryableErrors: 'discard' })
  ).rejects.toMatchObject({ status: 429 })
  expect(measured).toHaveBeenCalledOnce()
})

it('accepts undefined optional generation settings without overriding defaults', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })
  )
  const model = createProvider({ id: 'deepseek', fetch }).textGenerationModel('m')
  expect(
    await model.generate({
      prompt: 'hello',
      systemPrompt: undefined,
      signal: undefined,
      maxOutputTokens: undefined,
      outputLimitBytes: undefined
    })
  ).toEqual({ text: 'ok', stopReason: 'end_turn' })
})

it('preserves classification cancellation and response transport errors rather than mislabeling them', async () => {
  const controller = new AbortController(),
    measured = vi.fn()
  const model = createProvider({
    id: 'typesafe',
    fetch: async () =>
      Response.json({ model: 'm', usage: { input_tokens: 3, output_tokens: 1 }, answers: {} })
  }).classificationModel('m')
  await expect(
    model.classify(
      { state: 's', questions: {}, signal: controller.signal },
      {
        onUsage: (value) => {
          measured(value)
          controller.abort()
        }
      }
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(measured).toHaveBeenCalledOnce()
  const dropped = new Error('stream disconnected')
  const broken = createProvider({
    id: 'typesafe',
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.error(dropped)
          }
        })
      )
  }).classificationModel('m')
  await expect(broken.classify({ state: 's', questions: {} })).rejects.toBe(dropped)
})

it.each([
  ['deepseek', undefined, 'https://api.deepseek.com/v1/models', 'authorization'],
  ['anthropic', undefined, 'https://api.anthropic.com/v1/models', 'x-api-key'],
  ['xai', undefined, 'https://api.x.ai/v1/models', 'authorization'],
  ['stepfun', 'global', 'https://api.stepfun.ai/v1/models', 'authorization']
])(
  'discovers %s models with the same connection credentials and region',
  async (id, region, url, header) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: [{ id: 'new-model' }] })
    )
    const provider = createProvider({ id: id!, region, key: 'secret', fetch })
    expect(provider.supportsModelDiscovery).toBe(true)
    await expect(provider.listModels()).resolves.toMatchObject({ ok: true, models: ['new-model'] })
    expect(fetch.mock.calls[0][0]).toBe(url)
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get(header!)).toBe(
      header === 'x-api-key' ? 'secret' : 'Bearer secret'
    )
  }
)

it('snapshots an explicit discovery endpoint and retains per-call resource limits', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: [{ id: 'a' }, { id: 'b' }] })
  )
  const config = { id: 'custom', fetch, discovery: { url: 'https://first.test/models' } }
  const provider = createProvider(config)
  config.discovery.url = 'https://second.test/models'
  await expect(provider.listModels({ limits: { fetchedModels: 1 } })).resolves.toMatchObject({
    ok: false,
    status: 200
  })
  await expect(provider.listModels()).resolves.toMatchObject({ ok: true, models: ['a', 'b'] })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://first.test/models',
    'https://first.test/models'
  ])
})

it.each(['custom', 'typesafe', 'local'])(
  'reports unavailable %s model discovery without network access',
  async (id) => {
    const fetch = vi.fn()
    const provider = createProvider({ id, fetch })
    expect(provider.supportsModelDiscovery).toBe(false)
    await expect(provider.listModels()).resolves.toEqual({
      ok: false,
      message: 'This provider has no model-list endpoint.'
    })
    expect(fetch).not.toHaveBeenCalled()
  }
)
