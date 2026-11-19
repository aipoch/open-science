import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushLogs, initLogger } from '@aipoch/diagnostics/node'
import {
  IMAGE_VENDOR_CATALOG,
  type ImageServiceConfiguration
} from '../../shared/image-model-settings'
import { ImageModelOwner } from './image-model-owner'
import { SettingsRepository, sanitizeSettings } from './repository'

vi.mock('./crypto', async (original) => ({
  ...(await original<typeof import('./crypto')>()),
  encryptKey: (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString() : undefined
}))

let directory: string
let repository: SettingsRepository
let owner: ImageModelOwner
const service: ImageServiceConfiguration = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Local images',
  adapter: 'openai-images',
  baseUrl: 'http://127.0.0.1:3000/v1',
  models: [
    { id: 'h3', wireModelId: 'local/H3', presetId: 'minimax-h3/sglang' },
    { id: 'other', wireModelId: 'custom/image-model', presetId: 'openai-images/generic' }
  ]
}
const binding = { serviceId: service.id, modelId: 'h3' }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'image-model-settings-'))
  initLogger({ logDir: join(directory, 'logs'), mirrorToConsole: false })
  repository = new SettingsRepository(directory)
  owner = new ImageModelOwner(repository)
})
afterEach(async () => {
  await flushLogs()
  await rm(directory, { recursive: true, force: true })
})

it('selects the first model on creation and persists the binding with independent presets', async () => {
  expect(await owner.snapshot()).toEqual({ services: [], availableProviders: [] })
  const saved = await owner.mutate({ kind: 'save', ...service })
  expect(saved.imageModel).toEqual(binding)
  expect(saved.services[0]).toMatchObject({ ...service, configured: true })
  await owner.mutate({ kind: 'bind', binding })
  const restarted = new ImageModelOwner(new SettingsRepository(directory))
  expect(await restarted.snapshot()).toMatchObject({ imageModel: binding, services: [service] })
  await owner.mutate({ kind: 'save', ...service, models: [service.models[1]] })
  expect((await owner.snapshot()).imageModel).toBeUndefined()
  await expect(owner.mutate({ kind: 'bind', binding })).rejects.toThrow('unavailable')
  await owner.mutate({ kind: 'bind', binding: { ...binding, modelId: 'other' } })
  await owner.mutate({ kind: 'remove', id: service.id })
  expect(await owner.snapshot()).toEqual({ services: [], availableProviders: [] })
})

it('removes duplicate services and orphaned bindings before the repository writes settings', async () => {
  const committed = await repository.mutateImageModels(() => ({
    imageServices: [service, service],
    imageModel: { ...binding, modelId: 'missing' }
  }))
  const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  for (const settings of [committed, persisted]) {
    expect(settings.imageServices).toEqual([service])
    expect(settings).not.toHaveProperty('imageModel')
  }
})

it('notifies only committed execution changes and unsubscribes without exposing credentials', async () => {
  const changed = vi.fn()
  const unsubscribe = repository.subscribeImageModels(changed)
  const stopThrowing = repository.subscribeImageModels(() => {
    throw new Error('observer failed')
  })
  await owner.mutate({ kind: 'save', ...service })
  expect(changed).toHaveBeenCalledOnce()
  await owner.mutate({ kind: 'bind', binding })
  expect(changed.mock.calls).toEqual([[]])
  expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).imageModel).toEqual(
    binding
  )
  await owner.mutate({ kind: 'save', ...service, name: 'Renamed' })
  await owner.mutate({ kind: 'bind', binding })
  await expect(
    owner.mutate({ kind: 'bind', binding: { ...binding, modelId: 'missing' } })
  ).rejects.toThrow()
  expect(changed).toHaveBeenCalledOnce()
  await owner.mutate({ kind: 'save', ...service, apiKey: 'new-key' })
  expect(changed).toHaveBeenCalledTimes(2)
  await owner.mutate({ kind: 'bind', binding: { ...binding, modelId: 'other' } })
  expect(changed).toHaveBeenCalledTimes(3)
  await owner.mutate({ kind: 'bind' })
  expect(changed).toHaveBeenCalledTimes(4)
  unsubscribe()
  stopThrowing()
  await owner.mutate({ kind: 'bind', binding })
  expect(changed).toHaveBeenCalledTimes(4)
})

it('stores encrypted custom credentials, masks snapshots, and requires a new key for a new endpoint', async () => {
  const remote = { ...service, baseUrl: 'https://images.example/v1' }
  await expect(owner.mutate({ kind: 'save', ...remote })).rejects.toThrow('API key')
  expect((await owner.snapshot()).imageModel).toBeUndefined()
  const snapshot = await owner.mutate({
    kind: 'save',
    ...remote,
    apiKey: 'secret-image-credential'
  })
  const original = await repository.getSettings()
  expect(original.imageServices?.[0].keyRef).toMatch(/^enc:/)
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain(
    'secret-image-credential'
  )
  expect(JSON.stringify(snapshot)).not.toMatch(/secret-image-credential|enc:|keyRef/)
  expect(snapshot.services[0].maskedKey).toBe('••••tial')
  await owner.mutate({ kind: 'save', ...remote, name: 'Renamed', apiKey: '' })
  expect((await repository.getSettings()).imageServices?.[0].keyRef).toBe(
    original.imageServices?.[0].keyRef
  )
  await expect(
    owner.mutate({ kind: 'save', ...remote, baseUrl: 'https://other.example/v1' })
  ).rejects.toThrow('API key')
  expect((await repository.getSettings()).imageServices?.[0].baseUrl).toBe(remote.baseUrl)
  await owner.mutate({ kind: 'save', ...service })
  expect((await repository.getSettings()).imageServices?.[0].keyRef).toBeUndefined()
})

it('links official credentials without copying them and cascades account deletion even with preserve handling', async () => {
  await repository.upsertProvider({
    id: 'fixture-account',
    type: 'official',
    vendorId: 'minimax',
    region: 'china',
    name: 'Fixture account',
    keyRef: 'enc:opaque',
    keyMask: '••••test'
  })
  const available = (await owner.snapshot()).availableProviders[0]
  expect(available.baseUrl).toBe('https://api.minimax.cn/v1')
  const official = {
    id: service.id,
    name: 'Official images',
    adapter: available.adapter,
    models: available.models,
    providerId: available.id
  }
  await owner.mutate({ kind: 'save', ...official })
  const stored = (await repository.getSettings()).imageServices?.[0]
  expect(stored).not.toHaveProperty('keyRef')
  expect(stored).not.toHaveProperty('baseUrl')
  await owner.mutate({
    kind: 'bind',
    binding: { serviceId: service.id, modelId: available.models[0].id }
  })
  const changed = vi.fn()
  const unsubscribe = repository.subscribeImageModels(changed)
  const provider = (await repository.getSettings()).providers[0]
  await repository.upsertProvider({ ...provider, name: 'Renamed account' })
  expect(changed).not.toHaveBeenCalled()
  await repository.upsertProvider({ ...provider, keyRef: 'enc:rotated' })
  expect(changed).toHaveBeenCalledOnce()
  await repository.upsertProvider({ ...provider, keyRef: 'enc:rotated', region: 'global' })
  expect(changed).toHaveBeenCalledTimes(2)
  await repository.deleteProvider(available.id, 'preserve')
  expect(changed).toHaveBeenCalledTimes(3)
  unsubscribe()
  expect(await owner.snapshot()).toEqual({ services: [], availableProviders: [] })
  await expect(owner.mutate({ kind: 'save', ...official })).rejects.toThrow('unavailable')
})

it.each([
  { baseUrl: 'http://192.168.1.1/v1' },
  { baseUrl: 'https://user:password@example.com/v1' },
  { baseUrl: 'https://example.com/v1?api_key=secret' },
  { providerId: 'official', apiKey: 'must-not-mix' },
  { models: [service.models[0], service.models[0]] },
  { models: [{ ...service.models[0], presetId: 'minimax-h3/official' }] },
  { keyRef: 'enc:injected' }
])(
  'rejects malformed transport input without changing persisted configuration: %j',
  async (patch) => {
    await owner.mutate({ kind: 'save', ...service })
    await expect(owner.mutate({ kind: 'save', ...service, ...patch } as never)).rejects.toThrow(
      'Invalid image model settings'
    )
    expect((await repository.getSettings()).imageServices).toEqual([service])
  }
)

it('drops invalid persisted records and dangling bindings while retaining valid unrelated settings', () => {
  const clean = sanitizeSettings({
    version: 2,
    providers: [],
    notificationsEnabled: false,
    imageServices: [
      { ...service, id: 'invalid' },
      service,
      service,
      {
        ...service,
        id: '22222222-2222-4222-8222-222222222222',
        baseUrl: 'http://remote.example/v1'
      }
    ],
    imageModel: { ...binding, modelId: 'missing' }
  })
  expect(clean.imageServices).toEqual([service])
  expect(clean.imageModel).toBeUndefined()
  expect(clean.notificationsEnabled).toBe(false)
})

it('rejects mismatched official accounts, unknown regions and credential overrides', async () => {
  const official = {
    ...service,
    adapter: 'minimax' as const,
    baseUrl: undefined,
    providerId: 'account',
    models: [
      { id: 'h3', wireModelId: 'MiniMax-H3-Image', presetId: 'minimax-h3/official' as const }
    ]
  }
  for (const provider of [
    { type: 'custom' as const },
    { type: 'official' as const, vendorId: 'openai' as const },
    { type: 'official' as const, vendorId: 'minimax' as const, region: 'unknown' }
  ]) {
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [{ id: 'account', name: 'Account', keyRef: 'enc:key', ...provider }]
      })
    )
    await expect(owner.mutate({ kind: 'save', ...official })).rejects.toThrow('unavailable')
    expect(
      (await owner.snapshot()).availableProviders.some((entry) => entry.vendorId === 'minimax')
    ).toBe(false)
  }
  await expect(owner.mutate({ kind: 'save', ...official, apiKey: 'override' })).rejects.toThrow(
    'Invalid'
  )
})

it('serializes unrelated concurrent changes and rejects a binding to a removed service', async () => {
  const other = { ...service, id: '22222222-2222-4222-8222-222222222222', name: 'Other' }
  await Promise.all([
    owner.mutate({ kind: 'save', ...service }),
    owner.mutate({ kind: 'save', ...other })
  ])
  expect((await owner.snapshot()).services.map(({ id }) => id)).toEqual([service.id, other.id])
  const removal = owner.mutate({ kind: 'remove', id: service.id })
  await expect(owner.mutate({ kind: 'bind', binding })).rejects.toThrow('unavailable')
  await removal
  expect((await owner.snapshot()).services.map(({ id }) => id)).toEqual([other.id])
})

it('resolves one Host-only credential snapshot and fails closed for unreadable keys', async () => {
  expect(await owner.resolve()).toBeUndefined()
  await owner.mutate({ kind: 'save', ...service })
  await owner.mutate({ kind: 'bind', binding })
  expect(await new ImageModelOwner(new SettingsRepository(directory)).resolve()).toMatchObject({
    serviceId: service.id,
    baseUrl: service.baseUrl,
    model: service.models[0]
  })
  await repository.upsertProvider({
    id: 'official',
    type: 'official',
    vendorId: 'minimax',
    region: 'china',
    name: 'China',
    keyRef: `enc:${Buffer.from('official-key').toString('base64')}`
  })
  const provider = (await owner.snapshot()).availableProviders[0]
  await owner.mutate({
    kind: 'save',
    id: service.id,
    name: 'Official',
    adapter: 'minimax',
    providerId: provider.id,
    models: provider.models
  })
  await owner.mutate({
    kind: 'bind',
    binding: { serviceId: service.id, modelId: provider.models[0].id }
  })
  expect(await new ImageModelOwner(new SettingsRepository(directory)).resolve()).toMatchObject({
    baseUrl: 'https://api.minimax.cn/v1',
    apiKey: 'official-key',
    providerId: 'official'
  })
  expect(JSON.stringify(await owner.snapshot())).not.toContain('official-key')
  await repository.upsertProvider({
    id: 'official',
    type: 'official',
    vendorId: 'minimax',
    region: 'china',
    name: 'China',
    keyRef: 'unreadable'
  })
  expect(await owner.resolve()).toBeUndefined()
})

it('resolves a per-request model without changing the default or falling back from a missing selection', async () => {
  await owner.mutate({ kind: 'save', ...service })
  await owner.mutate({ kind: 'bind', binding })
  const changed = vi.fn()
  const unsubscribe = repository.subscribeImageModels(changed)
  expect(await owner.resolve({ ...binding, modelId: 'other' })).toMatchObject({
    model: service.models[1]
  })
  expect(await owner.resolve({ ...binding, modelId: 'removed-model' })).toBeUndefined()
  expect(
    await owner.resolve({ ...binding, serviceId: '22222222-2222-4222-8222-222222222222' })
  ).toBeUndefined()
  expect((await owner.snapshot()).imageModel).toEqual(binding)
  expect(changed).not.toHaveBeenCalled()
  unsubscribe()
})

it.each(['openai', 'bailian', 'volcengine'] as const)(
  'persists independent %s image credentials and restores the binding',
  async (vendorId) => {
    const vendor = IMAGE_VENDOR_CATALOG.find((entry) => entry.id === vendorId)!
    const official = {
      id: service.id,
      name: vendor.label,
      vendorId,
      adapter: vendor.adapter,
      baseUrl: vendor.regions[0].baseUrl,
      models: vendor.models
    }
    await repository.upsertProvider({
      id: 'chat-account',
      name: 'Chat account',
      type: 'official',
      vendorId,
      keyRef: 'enc:Y2hhdC1rZXk=',
      keyMask: '••••chat'
    })
    const accounts = (await repository.getSettings()).providers
    await owner.mutate({ kind: 'save', ...official, apiKey: 'image-key' })
    await owner.mutate({
      kind: 'bind',
      binding: { serviceId: service.id, modelId: vendor.models[0].id }
    })
    expect((await repository.getSettings()).providers).toEqual(accounts)
    expect((await owner.snapshot()).services[0]).toMatchObject({ vendorId, configured: true })
    // Resolve again from the repository owner after persistence; plaintext remains Host-only.
    expect(await new ImageModelOwner(new SettingsRepository(directory)).resolve()).toMatchObject({
      baseUrl: official.baseUrl,
      apiKey: 'image-key'
    })
    expect(JSON.stringify(await owner.snapshot())).not.toContain('image-key')
    await expect(
      owner.mutate({
        kind: 'save',
        ...official,
        baseUrl: 'https://attacker.example/v1',
        apiKey: 'other'
      })
    ).rejects.toThrow('Invalid image')
  }
)

it('keeps the legacy Bailian address and accepts official workspace URLs for both credential modes', async () => {
  const vendor = IMAGE_VENDOR_CATALOG.find(({ id }) => id === 'bailian')!
  const baseUrl = 'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  const qwen = {
    kind: 'save' as const,
    id: service.id,
    name: vendor.label,
    vendorId: vendor.id,
    adapter: vendor.adapter,
    models: vendor.models
  }
  const account = {
    id: 'bailian-account',
    name: 'Bailian',
    type: 'official' as const,
    vendorId: vendor.id,
    region: 'china',
    keyRef: 'enc:Y2hhdC1rZXk='
  }
  await repository.upsertProvider(account)
  await owner.mutate({ ...qwen, providerId: account.id })
  await owner.mutate({ kind: 'bind', binding: { serviceId: qwen.id, modelId: qwen.models[0].id } })
  expect((await owner.resolve())?.baseUrl).toBe(vendor.regions[0].baseUrl)

  await owner.mutate({ ...qwen, baseUrl, apiKey: 'image-key' })
  expect(await new ImageModelOwner(new SettingsRepository(directory)).resolve()).toMatchObject({
    baseUrl,
    apiKey: 'image-key'
  })
  await owner.mutate({ ...qwen, baseUrl, providerId: account.id })
  expect(await new ImageModelOwner(new SettingsRepository(directory)).resolve()).toMatchObject({
    baseUrl,
    apiKey: 'chat-key'
  })
  for (const invalid of [
    baseUrl.replace('.aliyuncs.com/', '.aliyuncs.com.attacker.example/'),
    baseUrl.replace('https://', 'http://'),
    baseUrl + '?redirect=elsewhere'
  ]) {
    await expect(
      owner.mutate({ ...qwen, baseUrl: invalid, providerId: account.id })
    ).rejects.toThrow('Invalid image')
  }
  expect((await owner.resolve())?.baseUrl).toBe(baseUrl)
})

it('preserves existing defaults and leaves historical or explicitly disabled services unselected on edit', async () => {
  await repository.mutateImageModels(() => ({ imageServices: [service] }))
  expect(
    (await new ImageModelOwner(new SettingsRepository(directory)).snapshot()).imageModel
  ).toBeUndefined()
  expect(
    (await owner.mutate({ kind: 'save', ...service, name: 'Edited' })).imageModel
  ).toBeUndefined()
  const other = { ...service, id: '22222222-2222-4222-8222-222222222222' }
  const otherBinding = { serviceId: other.id, modelId: other.models[0].id }
  expect((await owner.mutate({ kind: 'save', ...other })).imageModel).toEqual(otherBinding)
  expect((await owner.mutate({ kind: 'save', ...service })).imageModel).toEqual(otherBinding)
  const third = { ...service, id: '33333333-3333-4333-8333-333333333333' }
  expect((await owner.mutate({ kind: 'save', ...third })).imageModel).toEqual(otherBinding)
  await owner.mutate({ kind: 'bind' })
  expect((await owner.mutate({ kind: 'save', ...other })).imageModel).toBeUndefined()
})

it('tests drafts without saving and only reuses credentials for the saved destination', async () => {
  const testGeneration = vi.fn(async () => ({ ok: true as const }))
  const testOwner = new ImageModelOwner(repository, testGeneration)
  const remote = { ...service, baseUrl: 'https://images.example/v1' }
  await owner.mutate({ kind: 'save', ...remote, apiKey: 'saved-key' })
  const before = await readFile(join(directory, 'settings.json'), 'utf8')
  const changed = vi.fn()
  const unsubscribe = repository.subscribeImageModels(changed)
  expect(await testOwner.test({ kind: 'save', ...remote, name: 'Unsaved edit' })).toEqual({
    ok: true
  })
  expect(testGeneration).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiKey: 'saved-key', model: service.models[0] })
  )
  expect(
    await testOwner.test({ kind: 'save', ...remote, baseUrl: 'https://other.example/v1' })
  ).toMatchObject({ ok: false })
  expect(testGeneration).toHaveBeenCalledOnce()
  expect(await testOwner.test({ kind: 'save', ...remote, apiKey: 'draft-key' })).toEqual({
    ok: true
  })
  expect(testGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'draft-key' }))
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(before)
  expect(changed).not.toHaveBeenCalled()
  unsubscribe()
})

it('bounds simultaneous tests without blocking saves', async () => {
  let complete!: (result: { ok: true }) => void
  const testGeneration = vi.fn(
    () =>
      new Promise<{ ok: true }>((resolve) => {
        complete = resolve
      })
  )
  const testOwner = new ImageModelOwner(repository, testGeneration)
  const pending = testOwner.test({ kind: 'save', ...service })
  await vi.waitFor(() => expect(testGeneration).toHaveBeenCalledOnce())
  expect(await testOwner.test({ kind: 'save', ...service })).toEqual({
    ok: false,
    error: { code: 'RATE_LIMITED' }
  })
  expect((await testOwner.mutate({ kind: 'save', ...service })).imageModel).toEqual(binding)
  complete({ ok: true })
  expect(await pending).toEqual({ ok: true })
})
