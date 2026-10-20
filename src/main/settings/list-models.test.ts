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
  expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledWith(stored, ['model-a'])
})
it('rejects a model list if the account changed during discovery', async () => {
  list.mockResolvedValue({ ok: true, models: ['model-a'] })
  const owner = new ProviderModelCatalogOwner(
    repository(false) as unknown as SettingsRepository,
    () => ({ key: 'decrypted' }) as ResolvedProvider,
    async () => ({ token: 'oauth' })
  )
  expect(await owner.refresh({ providerId: 'account' })).toMatchObject({
    ok: false,
    message: 'The provider changed while loading models. Try again.'
  })
})

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
  expect(await owner.refresh({ providerId: 'subscription' })).toEqual({
    ok: true,
    category: 'ok',
    models: ['grok-chat']
  })
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'xai', key: 'fresh-token' })
  )
  expect(repo.updateProviderModelCatalogIfTargetMatches).toHaveBeenCalledWith(
    { ...subscription, keyRef: 'fresh-reference' },
    ['grok-chat']
  )
})

it('retains the curated API-key xAI picker without requesting a live inventory', async () => {
  const repo = repository()
  repo.getSettings.mockResolvedValue({ providers: [{ ...stored, vendorId: 'xai' }] })
  const resolve = vi.fn(),
    credential = vi.fn()
  const before = list.mock.calls.length
  const owner = new ProviderModelCatalogOwner(
    repo as unknown as SettingsRepository,
    resolve,
    credential
  )
  expect(await owner.refresh({ providerId: 'account' })).toMatchObject({
    ok: false,
    category: 'unknown'
  })
  expect(list.mock.calls).toHaveLength(before)
  expect(resolve).not.toHaveBeenCalled()
  expect(credential).not.toHaveBeenCalled()
})
