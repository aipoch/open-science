import { expect, it, vi } from 'vitest'
import { ProviderModelCatalogOwner } from './provider-model-catalog-owner'
import type { SettingsRepository } from './repository'
import type { ResolvedProvider } from './provider-env'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
const { list, create } = vi.hoisted(() => {
  const list = vi.fn()
  return { list, create: vi.fn(() => ({ supportsModelDiscovery: true, listModels: list })) }
})
vi.mock('@aipoch/providers/client', () => ({ createProvider: create }))
const stored = {
  id: 'account',
  type: 'official' as const,
  vendorId: 'deepseek' as const,
  keyRef: 'encrypted'
}
const repository = (
  applied = true
): {
  getSettings: ReturnType<typeof vi.fn>
  updateProviderModelCatalogIfTargetMatches: ReturnType<typeof vi.fn>
} => ({
  getSettings: vi.fn(async () => ({ providers: [stored] })),
  updateProviderModelCatalogIfTargetMatches: vi.fn(async () => applied)
})
it('injects host network/resource policy and persists against the captured account', async () => {
  list.mockResolvedValue({ ok: true, models: ['model-a'] })
  const repo = repository(),
    owner = new ProviderModelCatalogOwner(
      repo as unknown as SettingsRepository,
      () => ({ key: 'decrypted' }) as ResolvedProvider,
      async () => ({ token: 'oauth' })
    )
  expect(await owner.refresh({ providerId: 'account' })).toMatchObject({
    ok: true,
    models: ['model-a']
  })
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'decrypted', id: 'deepseek', fetch: expect.any(Function) })
  )
  expect(list).toHaveBeenCalledWith({ limits: PROVIDER_RESOURCE_LIMITS })
  expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledWith(stored, ['model-a'], {
    modelCatalog: { fetchedAt: expect.any(Number), models: [{ id: 'model-a' }] },
    modelCatalogStatus: {
      attemptedAt: expect.any(Number),
      ok: true,
      code: undefined,
      status: undefined
    }
  })
})
it.each([
  { ok: true, models: ['model-a'] },
  { ok: false, code: 'authentication', status: 401 }
])('discards a stale discovery result (ok=$ok) after an account change', async (result) => {
  list.mockResolvedValue(result)
  const owner = new ProviderModelCatalogOwner(
    repository(false) as unknown as SettingsRepository,
    () => ({ key: 'decrypted' }) as ResolvedProvider,
    async () => ({ token: 'oauth' })
  )
  expect(await owner.refresh({ providerId: 'account' })).toMatchObject({
    ok: false,
    code: 'stale'
  })
})

it.each([
  { id: 'm', routes: { messages: 'https://example.test/' + 'a'.repeat(2048) } },
  { id: 'm', routes: { messages: 'broken URL' } },
  { id: '🧬'.repeat(513) }
])(
  'keeps the previous directory when a snapshot cannot round-trip through storage',
  async (model) => {
    list.mockResolvedValue({ ok: true, models: [model.id], catalog: [model] })
    const repo = repository()
    const owner = new ProviderModelCatalogOwner(
      repo as unknown as SettingsRepository,
      () => ({ key: 'decrypted' }) as ResolvedProvider,
      vi.fn()
    )
    expect(await owner.refresh({ providerId: stored.id })).toMatchObject({
      ok: false,
      code: 'invalid-response'
    })
    expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledExactlyOnceWith(
      stored,
      undefined,
      {
        modelCatalogStatus: expect.objectContaining({ ok: false, code: 'invalid-response' })
      }
    )
    const preview = await owner.refresh({ providerId: stored.id, draft: stored })
    expect(preview).toMatchObject({ ok: false, code: 'invalid-response' })
    expect(preview.draftToken).toBeUndefined()
    expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledTimes(1)
  }
)

it('keeps OAuth credential snapshots and chat filtering in the host', async () => {
  list.mockResolvedValue({ ok: true, models: ['grok-chat', 'image-model'] })
  const repo = repository()
  const subscription = { id: 'subscription', type: 'xai-subscription', keyRef: 'old' }
  repo.getSettings.mockResolvedValue({ providers: [subscription] })
  const owner = new ProviderModelCatalogOwner(
    repo as unknown as SettingsRepository,
    () => ({ key: 'old-token' }) as ResolvedProvider,
    async () => ({ token: 'fresh-token', keyRef: 'fresh-reference' })
  )
  expect(await owner.refresh({ providerId: 'subscription' })).toMatchObject({
    ok: true,
    category: 'ok',
    models: ['grok-chat'],
    catalog: { fetchedAt: expect.any(Number), models: [{ id: 'grok-chat' }] },
    catalogStatus: { attemptedAt: expect.any(Number), ok: true }
  })
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'xai', key: 'fresh-token' })
  )
  expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledWith(
    { ...subscription, keyRef: 'fresh-reference' },
    ['grok-chat'],
    {
      modelCatalog: { fetchedAt: expect.any(Number), models: [{ id: 'grok-chat' }] },
      modelCatalogStatus: {
        attemptedAt: expect.any(Number),
        ok: true,
        code: undefined,
        status: undefined
      }
    }
  )
})

it('refreshes the API-key xAI catalog without using OAuth credentials', async () => {
  list.mockResolvedValue({ ok: true, models: ['grok-4'] })
  const repo = repository()
  repo.getSettings.mockResolvedValue({ providers: [{ ...stored, vendorId: 'xai' }] })
  const resolve = vi.fn(() => ({ key: 'api-key' }) as ResolvedProvider),
    credential = vi.fn()
  const before = list.mock.calls.length
  const owner = new ProviderModelCatalogOwner(
    repo as unknown as SettingsRepository,
    resolve,
    credential
  )
  expect(await owner.refresh({ providerId: 'account' })).toMatchObject({
    ok: true,
    category: 'ok',
    models: ['grok-4']
  })
  expect(list.mock.calls).toHaveLength(before + 1)
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'xai', key: 'api-key' }))
  expect(resolve).toHaveBeenCalledWith({ ...stored, vendorId: 'xai' })
  expect(credential).not.toHaveBeenCalled()
})
