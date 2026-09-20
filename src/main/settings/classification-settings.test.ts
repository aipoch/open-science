import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SettingsRepository } from './repository'
import { ClassificationSettingsOwner } from './classification-settings'
import { classificationSettingsSchema } from './classification-config'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { flushLogs, initLogger } from '../logger'

vi.mock('./crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crypto')>()),
  encryptKey: (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
  maskKey: (value: string) => `••••${value.slice(-4)}`,
  tryDecryptKey: (value: string) => Buffer.from(value.slice(4), 'base64').toString()
}))
vi.mock('../skills/net-fetch', () => ({ netFetchStandard: vi.fn() }))
let dir: string
let repository: SettingsRepository
let owner: ClassificationSettingsOwner
const fetchMock = vi.fn<typeof fetch>()
const serviceId = '55555555-5555-4555-8555-555555555555'
const otherServiceId = '88888888-8888-4888-8888-888888888888'
const candidate = {
  name: 'analysis',
  description: 'Analyze scientific data',
  path: '/private/SKILL.md'
}
const request = (): { text: string; catalog: (typeof candidate)[]; signal: AbortSignal } => ({
  text: 'Analyze data',
  catalog: [candidate],
  signal: new AbortController().signal
})
const response = (noul = 0.95): Response =>
  new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: { s0: { type: 'noul', noul } },
      usage: { input_tokens: 20, output_tokens: 1 }
    })
  )
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'classification-'))
  initLogger({ logDir: join(dir, 'logs'), mirrorToConsole: false })
  repository = new SettingsRepository(dir)
  owner = new ClassificationSettingsOwner(repository, fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    return body.questions?.test
      ? new Response(
          JSON.stringify({
            model: body.model,
            answers: { test: { type: 'noul', noul: 1 } },
            usage: { input_tokens: 3, output_tokens: 1 }
          })
        )
      : response()
  })
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await flushLogs()
  await rm(dir, { recursive: true, force: true })
})
const diagnosticRecords = async (): Promise<{ msg: string; data: Record<string, unknown> }[]> => {
  await flushLogs()
  return (await readFile(join(dir, 'logs', 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
const configure = async (): Promise<void> => {
  await owner.mutate({
    revision: 0,
    kind: 'save',
    id: serviceId,
    adapter: 'typesafe',
    name: 'My account',
    apiKey: 'secret-api-key'
  })
  await owner.mutate({ revision: 1, kind: 'bind', binding: { serviceId } })
  fetchMock.mockClear()
}
it.each([
  ['null', null],
  ['invalid revision', { revision: -1, services: [] }],
  ['malformed service', { revision: 0, services: [{}] }],
  ['invalid binding', { revision: 0, services: [], capabilitySelection: { serviceId: 'invalid' } }]
])(
  'keeps settings readable with %s classification configuration',
  async (_name, classification) => {
    const providers = [{ id: 'existing-provider', type: 'custom', name: 'Existing provider' }]
    const contents = JSON.stringify({
      version: SETTINGS_FILE_VERSION,
      providers,
      notificationsEnabled: false,
      classification
    })
    const path = join(dir, 'settings.json')
    await writeFile(path, contents)

    const settings = await repository.getSettings()
    expect(settings.providers).toEqual(providers)
    expect(settings.notificationsEnabled).toBe(false)
    expect(settings.classification).toBeUndefined()
    await expect(owner.snapshot()).resolves.toMatchObject({ revision: 0, services: [] })
    await expect(owner.selectSkills(request())).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(contents)
  }
)
it('validates a new service before writing any credential or configuration', async () => {
  const probe = fetchMock.getMockImplementation()!
  fetchMock.mockImplementationOnce(async (...args) => {
    expect((await repository.getSettings()).classification).toBeUndefined()
    expect(JSON.parse(String(args[1]?.body))).toMatchObject({
      state: 'A test connection.',
      questions: { test: { type: 'noul' } }
    })
    return probe(...args)
  })
  const saved = await owner.mutate({
    kind: 'save',
    revision: 0,
    id: serviceId,
    adapter: 'typesafe',
    name: 'New service',
    apiKey: 'synthetic-new-key'
  })
  expect(saved.services[0]).toMatchObject({ configured: true, name: 'New service' })
  expect(saved.revision).toBe(1)
  expect(fetchMock).toHaveBeenCalledOnce()
})
it('rejects a new invalid key without creating settings and redacts validation details', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { message: 'Invalid synthetic-bad-key' } }), {
      status: 401
    })
  )
  const result = await owner.mutate({
    kind: 'save',
    revision: 0,
    id: serviceId,
    adapter: 'openrouter',
    name: 'Rejected service',
    apiKey: 'synthetic-bad-key'
  })
  expect(result).toMatchObject({
    revision: 0,
    services: [],
    validation: { ok: false, category: 'auth', status: 401 }
  })
  expect(JSON.stringify(result)).not.toContain('synthetic-bad-key')
  expect((await repository.getSettings()).classification).toBeUndefined()
  await expect(readFile(join(dir, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each([
  [401, 'auth'],
  [402, 'unknown'],
  [503, 'server-error']
] as const)(
  'preserves a saved key and binding when validation returns HTTP %s',
  async (status, category) => {
    await configure()
    const before = await readFile(join(dir, 'settings.json'), 'utf8')
    fetchMock.mockResolvedValueOnce(new Response('{}', { status }))
    const result = await owner.mutate({
      kind: 'save',
      revision: 2,
      id: serviceId,
      adapter: 'typesafe',
      name: 'Changed service',
      apiKey: 'synthetic-replacement-key'
    })
    expect(result.validation).toMatchObject({ ok: false, category, status })
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(before)
  }
)
it('does not accept a successful HTTP status without the validation answer', async () => {
  fetchMock.mockResolvedValueOnce(response())
  const result = await owner.mutate({
    kind: 'save',
    revision: 0,
    id: serviceId,
    adapter: 'typesafe',
    name: 'Incomplete service',
    apiKey: 'synthetic-new-key'
  })
  expect(result.validation).toMatchObject({ ok: false, category: 'unknown' })
  expect((await repository.getSettings()).classification).toBeUndefined()
})
it('preserves historical unconfigured behavior and never registers a chat provider', async () => {
  expect(await owner.snapshot()).toEqual({ revision: 0, services: [], availableProviders: [] })
  expect(await owner.selectSkills(request())).toBeUndefined()
  expect(fetchMock).not.toHaveBeenCalled()
  await configure()
  expect((await repository.getSettings()).providers).toEqual([])
  expect((await repository.getSettings()).classification?.services[0]?.models).toEqual([
    'jev-latest'
  ])
  expect((await owner.snapshot()).services[0]).toMatchObject({
    configured: true,
    maskedKey: '••••-key',
    needsKey: false
  })
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).not.toContain('secret-api-key')
  expect(JSON.stringify(await owner.snapshot())).not.toContain('keyRef')
  expect(
    (await new ClassificationSettingsOwner(repository).snapshot()).capabilitySelection?.serviceId
  ).toBe(serviceId)
})
it('reads legacy model fields while the runtime keeps Jev fixed', () => {
  expect(
    classificationSettingsSchema.parse({
      revision: 4,
      services: [
        {
          id: serviceId,
          adapter: 'typesafe',
          name: 'Legacy account',
          models: ['jev-1.13.0'],
          keyRef: 'enc:c2VjcmV0'
        }
      ],
      skillSelection: { serviceId, modelId: 'jev-1.13.0' }
    })
  ).toMatchObject({
    services: [{ models: ['jev-1.13.0'] }],
    skillSelection: { serviceId, modelId: 'jev-1.13.0' }
  })
})
it('rejects stale writes and unknown bindings; deleting a service restores the default', async () => {
  await configure()
  await expect(owner.mutate({ revision: 1, kind: 'remove', id: serviceId })).rejects.toThrow(
    'changed'
  )
  await expect(
    owner.mutate({
      revision: 2,
      kind: 'bind',
      binding: { serviceId: '66666666-6666-4666-8666-666666666666' }
    })
  ).rejects.toThrow('unavailable')
  expect(await owner.mutate({ revision: 2, kind: 'remove', id: serviceId })).toEqual({
    revision: 3,
    services: [],
    capabilitySelection: undefined,
    availableProviders: []
  })
})
it('sends only text and candidate metadata, maps paths locally, and separates usage', async () => {
  await configure()
  const observeUsage = vi.fn()
  expect(await owner.selectSkills({ ...request(), observeUsage })).toEqual([
    { name: candidate.name, path: candidate.path }
  ])
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(init).toMatchObject({
    redirect: 'manual',
    headers: { Authorization: 'Bearer secret-api-key' }
  })
  expect(init!.body).not.toContain('/private/')
  expect(observeUsage).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: `classification:${serviceId}`,
      model: 'jev-latest',
      usage: { inputTokens: 20, outputTokens: 1, cacheTokens: 0, turnCount: 1 }
    })
  )
})
it('uses one selection read and one settings read before and after the request', async () => {
  await configure()
  const reads = vi.spyOn(repository, 'getSettings')
  expect(await owner.selectSkills(request())).toEqual([
    { name: candidate.name, path: candidate.path }
  ])
  expect(reads).toHaveBeenCalledTimes(3)
})
it.each([0.5, -1, 2])('falls back for uncertain or invalid probability %s', async (probability) => {
  await configure()
  fetchMock.mockResolvedValue(response(probability))
  expect(await owner.selectSkills(request())).toBeUndefined()
  expect(fetchMock).toHaveBeenCalledOnce()
})
it.each([
  ['literature and report', [0.35, 0.26, 0.98, 0.06, 0.96, 0.05], [2, 4]],
  ['analysis and plotting', [0.98, 0.97, 0.11, 0.08, 0.23, 0.24], [0, 1]],
  ['greeting', [0.03, 0.02, 0.02, 0.02, 0.04, 0.02], []],
  ['uncertain without a clear match', [0.2, 0.79, 0.35], undefined],
  ['positive boundary', [0.79, 0.8], [1]],
  ['negative boundary', [0, 0.2], []],
  ['top three in descending order', [0.85, 0.99, 0.91, 0.97, 0.1], [1, 3, 2]],
  ['invalid answer alongside a clear match', [0.95, 1.2], undefined]
] as const)(
  'handles %s across a mixed capability catalog',
  async (_label, probabilities, selected) => {
    await configure()
    const catalog = probabilities.map((_, index) => ({
      ...candidate,
      name: `capability-${index}`,
      path: `/private/capability-${index}/SKILL.md`,
      ...(index % 2 ? { source: 'connector' as const } : {})
    }))
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'typesafe/jev-1.13',
          answers: Object.fromEntries(
            probabilities.map((noul, index) => [`s${index}`, { type: 'noul', noul }])
          ),
          usage: { input_tokens: 684, output_tokens: 106 }
        })
      )
    )
    expect(await owner.selectSkills({ ...request(), catalog })).toEqual(
      selected?.map((index) => ({ name: catalog[index]!.name, path: catalog[index]!.path }))
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  }
)
it('falls back for a missing answer even when another candidate is clearly relevant', async () => {
  await configure()
  expect(
    await owner.selectSkills({
      ...request(),
      catalog: [candidate, { ...candidate, name: 'another-skill' }]
    })
  ).toBeUndefined()
})
it.each([1600, 3000])('applies the default request budget at %s ms', async (elapsed) => {
  await configure()
  vi.spyOn(repository, 'getSettings').mockResolvedValue(await repository.getSettings())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  fetchMock.mockImplementationOnce(
    (_url, init) =>
      new Promise((resolve, reject) => {
        const finish = setTimeout(() => resolve(response()), elapsed === 1600 ? 1600 : 10000)
        init!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(finish)
            reject(new Error('aborted'))
          },
          { once: true }
        )
        started()
      })
  )
  const work = owner.selectSkills(request())
  await ready
  await vi.advanceTimersByTimeAsync(elapsed)
  expect(await work).toEqual(
    elapsed === 1600 ? [{ name: candidate.name, path: candidate.path }] : undefined
  )
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('allows zero selected skills and keeps explicit connector routing local', async () => {
  await configure()
  fetchMock.mockResolvedValue(response(0.05))
  expect(await owner.selectSkills(request())).toEqual([])
  fetchMock.mockClear()
  expect(
    await owner.selectSkills({
      ...request(),
      text: 'use pubmed',
      catalog: [{ ...candidate, name: 'mcp-pubmed', source: 'connector' }]
    })
  ).toEqual([{ name: 'mcp-pubmed', path: candidate.path }])
  expect(fetchMock).not.toHaveBeenCalled()
})
it('bounds response size and falls back on HTTP errors without exposing response bodies', async () => {
  await configure()
  fetchMock.mockResolvedValue(new Response('private-server-error', { status: 401 }))
  expect(await owner.selectSkills(request())).toBeUndefined()
  fetchMock.mockResolvedValue(new Response('x'.repeat(128 * 1024 + 1)))
  expect(await owner.selectSkills(request())).toBeUndefined()
})
it.each([429, 529])('retries transient TypeSafe responses once for status %s', async (status) => {
  owner = new ClassificationSettingsOwner(repository, fetchMock, 500)
  await configure()
  fetchMock.mockResolvedValueOnce(new Response('retry later', { status }))
  fetchMock.mockResolvedValueOnce(response())

  await expect(owner.selectSkills(request())).resolves.toEqual([
    { name: candidate.name, path: candidate.path }
  ])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const records = await diagnosticRecords()
  const started = records.filter(
    ({ msg, data }) =>
      msg === 'classification request started' && data.purpose === 'capability-selection'
  )
  expect(started.map(({ data }) => data.attempt)).toEqual([1, 2])
  expect(new Set(started.map(({ data }) => data.requestId)).size).toBe(1)
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification request retrying',
      data: expect.objectContaining({ requestId: started[0].data.requestId, status })
    })
  )
})
it.each(['cancel', 'timeout'] as const)('interrupts retry backoff on %s', async (reason) => {
  owner = new ClassificationSettingsOwner(repository, fetchMock, 30)
  await configure()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let received!: () => void
  const ready = new Promise<void>((resolve) => {
    received = resolve
  })
  fetchMock.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel: received }), { status: 429 })
  )
  const controller = new AbortController()
  const work = owner.selectSkills({ ...request(), signal: controller.signal })
  await ready
  await setImmediate()
  if (reason === 'cancel') controller.abort()
  else await vi.advanceTimersByTimeAsync(30)
  expect(await work).toEqual(reason === 'cancel' ? [] : undefined)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['timeout', 'cancel', 'change'] as const)(
  'invalidates in-flight work on %s',
  async (reason) => {
    if (reason === 'timeout') owner = new ClassificationSettingsOwner(repository, fetchMock, 30)
    await configure()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
          started()
        })
    )
    const controller = new AbortController()
    const work = owner.selectSkills({ ...request(), signal: controller.signal })
    await ready
    if (reason === 'cancel') controller.abort()
    if (reason === 'change') await owner.mutate({ revision: 2, kind: 'remove', id: serviceId })
    expect(await work).toEqual(reason === 'cancel' ? [] : undefined)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await diagnosticRecords()).toContainEqual(
      expect.objectContaining({
        msg: 'classification request failed',
        data: expect.objectContaining({
          purpose: 'capability-selection',
          attempt: 1,
          reason:
            reason === 'cancel' ? 'cancelled' : reason === 'change' ? 'settings-changed' : 'timeout'
        })
      })
    )
  }
)
it('tests the fixed Jev model without sending task content', async () => {
  await configure()
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: { test: { type: 'noul', noul: 1 } },
        usage: { input_tokens: 3, output_tokens: 1 }
      })
    )
  )
  expect(await owner.probe({ serviceId, revision: 2 })).toEqual({ ok: true })
  expect(await owner.probe({ serviceId, revision: 1 })).toEqual({
    ok: false
  })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
    model: 'jev-latest'
  })
})

it('batches both capabilities on one service and records one usage event', async () => {
  await configure()
  const connector = { ...candidate, name: 'mcp-pubmed', source: 'connector' as const }
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: { s0: { type: 'noul', noul: 0.95 }, s1: { type: 'noul', noul: 0.95 } },
        usage: { input_tokens: 30, output_tokens: 2 }
      })
    )
  )
  const observeUsage = vi.fn()
  expect(
    await owner.selectSkills({
      ...request(),
      catalog: [candidate, connector],
      observeUsage
    })
  ).toHaveLength(2)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(observeUsage).toHaveBeenCalledOnce()
})
it('clears the unified binding when its service is removed', async () => {
  await configure()
  expect(
    (await owner.mutate({ revision: 2, kind: 'remove', id: serviceId })).capabilitySelection
  ).toBeUndefined()
})

const providerId = 'p_1750000000000_1'
const addOpenRouter = async (key = 'router-key'): Promise<void> => {
  await repository.upsertProvider({
    id: providerId,
    type: 'official',
    vendorId: 'openrouter',
    name: 'Shared router',
    keyRef: `enc:${Buffer.from(key).toString('base64')}`
  })
}
const configureRouter = async (linked = true): Promise<void> => {
  if (linked) await addOpenRouter()
  await owner.mutate({
    revision: 0,
    kind: 'save',
    id: serviceId,
    adapter: 'openrouter',
    name: 'Router',
    ...(linked ? { providerId } : { apiKey: 'own-router-key' })
  })
  await owner.mutate({
    revision: 1,
    kind: 'bind',
    binding: { serviceId, modelId: 'typesafe/jev-1.13' }
  })
  fetchMock.mockClear()
}
it.each(['during validation', 'before commit'] as const)(
  'rejects a linked account key rotated %s',
  async (phase) => {
    await configureRouter()
    const before = (await repository.getSettings()).classification
    if (phase === 'during validation') {
      const probe = fetchMock.getMockImplementation()!
      fetchMock.mockImplementationOnce(async (...args) => {
        await addOpenRouter('rotated-synthetic-key')
        return probe(...args)
      })
    } else {
      const mutate = repository.mutateClassification.bind(repository)
      vi.spyOn(repository, 'mutateClassification').mockImplementationOnce(async (update) => {
        await addOpenRouter('rotated-synthetic-key')
        return mutate(update)
      })
    }
    const save = owner.mutate({
      kind: 'save',
      revision: 2,
      id: serviceId,
      adapter: 'openrouter',
      name: 'Unvalidated change',
      providerId
    })
    if (phase === 'during validation') expect((await save).validation?.ok).toBe(false)
    else await expect(save).rejects.toThrow('changed')
    expect((await repository.getSettings()).classification).toEqual(before)
  }
)
it.each([true, false])(
  'uses the Decisions endpoint and selected model with linked credentials=%s',
  async (linked) => {
    await configureRouter(linked)
    const observeUsage = vi.fn()
    await owner.selectSkills({ ...request(), observeUsage })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${linked ? 'router-key' : 'own-router-key'}`
    })
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('typesafe/jev-1.13')
    expect(body.questions.s0.type).toBe('noul')
    expect(body.questions.s0.instructions).toMatchObject({
      skill: candidate.name,
      description: candidate.description
    })
    expect(init?.body).not.toContain('/private/')
    expect(observeUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: linked ? providerId : `classification:${serviceId}`,
        usage: { inputTokens: 20, outputTokens: 1, cacheTokens: 0, turnCount: 1 }
      })
    )
    const stored = (await repository.getSettings()).classification!.services[0]!
    expect(stored.providerId).toBe(linked ? providerId : undefined)
    expect(Boolean(stored.keyRef)).toBe(!linked)
    expect(JSON.stringify(await owner.snapshot())).not.toContain('router-key')
    expect(JSON.stringify(await owner.snapshot())).not.toContain('keyRef')
    expect(
      (await new ClassificationSettingsOwner(repository).snapshot()).capabilitySelection
    ).toEqual({ serviceId, modelId: 'typesafe/jev-1.13' })
  }
)
it('resolves a rotated shared key and falls back after the shared account is removed', async () => {
  await configureRouter()
  await addOpenRouter('rotated-key')
  await owner.selectSkills(request())
  expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
    Authorization: 'Bearer rotated-key'
  })
  await repository.deleteProvider(providerId)
  fetchMock.mockClear()
  expect(await owner.selectSkills(request())).toBeUndefined()
  expect(fetchMock).not.toHaveBeenCalled()
  expect((await owner.snapshot()).services[0]).toMatchObject({ configured: false, needsKey: true })
})
it('removing a linked service preserves the shared account and its key', async () => {
  await configureRouter()
  await owner.mutate({ revision: 2, kind: 'remove', id: serviceId })
  expect((await repository.getSettings()).providers[0]).toMatchObject({
    id: providerId,
    keyRef: expect.any(String)
  })
})
it('rejects unsupported models, cross-provider keys and implicit key reuse after adapter changes', async () => {
  await configureRouter()
  await expect(
    owner.mutate({ revision: 2, kind: 'bind', binding: { serviceId, modelId: 'openai/gpt-5' } })
  ).rejects.toThrow('unavailable')
  await expect(
    owner.mutate({
      revision: 2,
      kind: 'save',
      id: serviceId,
      adapter: 'typesafe',
      name: 'Wrong key',
      providerId
    })
  ).rejects.toThrow('unavailable')
  await expect(
    owner.mutate({
      revision: 2,
      kind: 'save',
      id: serviceId,
      adapter: 'typesafe',
      name: 'Missing key'
    })
  ).rejects.toThrow('required')
})
it('discards decisions when a linked credential changes during a request', async () => {
  await configureRouter()
  let finish!: (value: Response) => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
        started()
      })
  )
  const observeUsage = vi.fn()
  const work = owner.selectSkills({ ...request(), observeUsage })
  await ready
  await repository.deleteProvider(providerId)
  finish(response())
  expect(await work).toBeUndefined()
  expect(observeUsage).toHaveBeenCalledOnce()
})
it('discards externally invalidated decisions while recording their billed usage', async () => {
  await configure()
  fetchMock.mockImplementationOnce(async () => {
    await repository.mutateClassification((state) => ({
      ...state!,
      revision: state!.revision + 1,
      capabilitySelection: undefined
    }))
    return response()
  })
  const observeUsage = vi.fn()
  expect(await owner.selectSkills({ ...request(), observeUsage })).toBeUndefined()
  expect(observeUsage).toHaveBeenCalledOnce()
})
it('does not accept a result cancelled during the final settings read', async () => {
  await configure()
  const controller = new AbortController()
  const readSettings = repository.getSettings.bind(repository)
  fetchMock.mockImplementationOnce(async () => {
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(async () => {
      const settings = await readSettings()
      controller.abort()
      return settings
    })
    return response()
  })
  expect(await owner.selectSkills({ ...request(), signal: controller.signal })).toEqual([])
})
it('hardens historical masks for both direct services and linked accounts without rewriting them', async () => {
  await configure()
  await repository.mutateClassification((state) => ({
    ...state!,
    services: state!.services.map((service) => ({ ...service, keyMask: 'secr…-key' }))
  }))
  await repository.upsertProvider({
    id: providerId,
    type: 'official',
    vendorId: 'openrouter',
    name: 'Shared router',
    keyRef: 'enc:c2VjcmV0',
    keyMask: 'secr…-key'
  })
  await owner.mutate({
    revision: 2,
    kind: 'save',
    id: otherServiceId,
    adapter: 'openrouter',
    name: 'Linked router',
    providerId
  })
  const before = await readFile(join(dir, 'settings.json'), 'utf8')
  const snapshot = await owner.snapshot()
  expect(snapshot.services.map((service) => service.maskedKey)).toEqual(['••••-key', '••••-key'])
  expect(snapshot.availableProviders[0]?.maskedKey).toBe('••••-key')
  expect(JSON.stringify(snapshot)).not.toContain('secr')
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(before)
})
it.each(['same', 'different', 'skills-only', 'connectors-only'] as const)(
  'reads legacy %s bindings without expanding their scope',
  async (mode) => {
    await configure()
    await repository.mutateClassification((state) => ({
      revision: state!.revision + 1,
      services: state!.services,
      skillSelection: mode === 'connectors-only' ? undefined : { serviceId },
      connectorSelection:
        mode === 'skills-only'
          ? undefined
          : { serviceId: mode === 'different' ? otherServiceId : serviceId }
    }))
    const reopened = new ClassificationSettingsOwner(new SettingsRepository(dir), fetchMock)
    expect((await reopened.snapshot()).capabilitySelection).toEqual(
      mode === 'same' ? { serviceId, modelId: 'jev-latest' } : undefined
    )
    expect(await reopened.selectSkills(request())).toEqual(
      mode === 'same' ? [{ name: candidate.name, path: candidate.path }] : undefined
    )
    expect(fetchMock).toHaveBeenCalledTimes(mode === 'same' ? 1 : 0)
    await reopened.mutate({ revision: 3, kind: 'bind' })
    const stored = (await new SettingsRepository(dir).getSettings()).classification!
    expect(stored.skillSelection).toBeUndefined()
    expect(stored.connectorSelection).toBeUndefined()
    expect(stored.capabilitySelection).toBeUndefined()
  }
)

it('distinguishes validation, probe and selection calls without logging private content', async () => {
  await configure()
  await owner.probe({ serviceId, revision: 2 })
  await owner.selectSkills(request())
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ error: { message: 'private-provider-response secret-api-key' } }),
      { status: 401 }
    )
  )
  await owner.selectSkills(request())
  fetchMock.mockRejectedValueOnce(new Error('private-network-message /private/SKILL.md'))
  await owner.selectSkills(request())
  const records = await diagnosticRecords()
  const started = records.filter(({ msg }) => msg === 'classification request started')
  expect(started.map(({ data }) => data.purpose)).toEqual([
    'save-validation',
    'probe',
    'capability-selection',
    'capability-selection',
    'capability-selection'
  ])
  expect(new Set(started.map(({ data }) => data.requestId)).size).toBe(5)
  const selectedRequestId = started[2].data.requestId
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification request completed',
      data: expect.objectContaining({
        requestId: selectedRequestId,
        model: 'jev-latest',
        adapter: 'typesafe',
        status: 200,
        inputTokens: 20,
        outputTokens: 1,
        durationMs: expect.any(Number)
      })
    })
  )
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification decision available',
      data: expect.objectContaining({ requestId: selectedRequestId, selectedCount: 1 })
    })
  )
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification request failed',
      data: expect.objectContaining({ status: 401, reason: 'auth' })
    })
  )
  const serialized = JSON.stringify(records)
  for (const privateValue of [
    'secret-api-key',
    request().text,
    candidate.description,
    candidate.path,
    'private-provider-response',
    'private-network-message'
  ]) {
    expect(serialized).not.toContain(privateValue)
  }
})
it('distinguishes skipped and ambiguous selections from confident empty decisions', async () => {
  await owner.selectSkills(request())
  expect(fetchMock).not.toHaveBeenCalled()
  await configure()
  fetchMock.mockResolvedValueOnce(response(0.5))
  expect(await owner.selectSkills(request())).toBeUndefined()
  fetchMock.mockResolvedValueOnce(response(0.05))
  expect(await owner.selectSkills(request())).toEqual([])
  const records = await diagnosticRecords()
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification selection skipped',
      data: { reason: 'not-configured' }
    })
  )
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification decision unavailable',
      data: expect.objectContaining({ reason: 'ambiguous-answer' })
    })
  )
  expect(records).toContainEqual(
    expect.objectContaining({
      msg: 'classification decision available',
      data: expect.objectContaining({ selectedCount: 0 })
    })
  )
})

it('supports a loopback custom typed-decision endpoint without an API key', async () => {
  const endpoint = 'http://127.0.0.1:8000/classify'
  const model = 'laya-typed-decisions'
  const saved = await owner.mutate({
    revision: 0,
    kind: 'save',
    id: serviceId,
    adapter: 'custom',
    name: 'Local Laya adaptor',
    baseUrl: endpoint,
    modelId: model
  })
  expect(saved.services[0]).toMatchObject({
    adapter: 'custom',
    baseUrl: endpoint,
    modelId: model,
    configured: true,
    needsKey: false
  })
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe(endpoint)
  expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(JSON.parse(String(init?.body))).toMatchObject({ model })

  const bound = await owner.mutate({
    revision: 1,
    kind: 'bind',
    binding: { serviceId, modelId: model }
  })
  expect(bound.capabilitySelection).toEqual({ serviceId, modelId: model })
})

it('requires a key for a remote custom typed-decision endpoint', async () => {
  await expect(
    owner.mutate({
      revision: 0,
      kind: 'save',
      id: serviceId,
      adapter: 'custom',
      name: 'Remote adaptor',
      baseUrl: 'https://classifier.example.test/v1/decisions',
      modelId: 'laya-typed-decisions'
    })
  ).rejects.toThrow('API key is required')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects insecure custom endpoints before attempting validation', async () => {
  await expect(
    owner.mutate({
      revision: 0,
      kind: 'save',
      id: serviceId,
      adapter: 'custom',
      name: 'Insecure adaptor',
      baseUrl: 'http://classifier.example.test/decisions',
      modelId: 'laya-typed-decisions',
      apiKey: 'remote-key'
    })
  ).rejects.toThrow('endpoint is invalid')
  expect(fetchMock).not.toHaveBeenCalled()
})
