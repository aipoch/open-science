import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProviderBridge } from './anthropic-provider-bridge'
import { ResponsesBridge } from './responses-bridge'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { ChatProviderCompatibilityBridge } from './chat-provider-compatibility'
import { BackendRoutePlanner } from './backend-route-planner'
import { OpenAiProviderBridge } from './openai-provider-bridge'
import { ProviderTransportOwner } from './provider-transport-owner'
import { SettingsRepository } from './repository'
import { providerValidationFailed } from '../../shared/settings'
import { ProviderRuntimeHealthOwner } from './provider-runtime-health-owner'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import { getAgentFramework } from '../agent-framework'
import type { StoredProvider } from './types'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (s: Buffer) => s.toString()
  }
}))

let dir: string
let repository: SettingsRepository
const projection = new ProviderRuntimeProjectionOwner()
const original: StoredProvider = {
  id: 'gateway',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'http://localhost:9999/v1',
  model: 'model-a',
  apiEndpoints: ['openai'],
  configRevision: 1,
  lastValidatedAt: 1,
  lastValidatedTarget: { model: 'model-a', endpoint: 'openai' }
}
const target = (
  provider = original
): ReturnType<ProviderRuntimeProjectionOwner['resolveRuntimeTarget']> =>
  projection.resolveRuntimeTarget(provider, { kind: 'configured' }, getAgentFramework('opencode'))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provider-health-'))
  repository = new SettingsRepository(dir)
  await repository.upsertProvider(original)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ProviderRuntimeHealthOwner', () => {
  it('makes a verified gateway unavailable and publishes after a runtime authentication rejection', async () => {
    const published = vi.fn(async () => {
      expect(providerValidationFailed((await repository.getSettings()).providers[0])).toBe(true)
    })
    const owner = new ProviderRuntimeHealthOwner(repository, published)
    await owner.observe(target(), {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth', status: 401 })
    expect(stored.lastValidationFailure?.target).toBeUndefined()
    expect(published).toHaveBeenCalledOnce()
  })
  it('does not invalidate a replacement configuration when an old request fails late', async () => {
    const oldTarget = target()
    await repository.upsertProvider({ ...original, model: 'model-b' }, original.id, {
      expectedConfigRevision: 1
    })
    const before = await repository.getSettings()
    const published = vi.fn()
    await new ProviderRuntimeHealthOwner(repository, published).observe(oldTarget, {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    expect(await repository.getSettings()).toEqual(before)
    expect(published).not.toHaveBeenCalled()
  })
  it('keeps a newer explicit successful validation when an earlier request fails late', async () => {
    const oldTarget = target()
    await repository.updateProviderValidationIfTargetMatches(
      original.id,
      () => true,
      { ok: true, category: 'ok' },
      { model: 'model-a', endpoint: 'openai' }
    )
    const before = await repository.getSettings()
    await new ProviderRuntimeHealthOwner(repository).observe(oldTarget, {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it.each([
    ['custom', 401],
    ['custom', 403],
    ['official', 401],
    ['official', 403]
  ] as const)(
    'updates settings after a real %s provider transport returns a synthetic %s',
    async (type, status) => {
      const provider: StoredProvider =
        type === 'custom' ? original : { ...original, type, vendorId: 'openai', model: 'gpt-5.4' }
      await repository.upsertProvider(provider)
      const active = target(provider)
      const published = vi.fn()
      const health = new ProviderRuntimeHealthOwner(repository, published)
      const transports = new ProviderTransportOwner({
        onProviderFailure: (source, failure) => health.observe(source, failure),
        createOpenAiProviderBridge: (targets, initial) =>
          new OpenAiProviderBridge(targets, initial, async () =>
            Response.json({ error: { message: 'Invalid API key' } }, { status })
          )
      })
      const generation = await transports.acquire({
        activeTarget: active,
        plan: {
          modelRoute: 'opencode-openai',
          backendProviderId: provider.id,
          providerModelCatalog: [],
          transport: { kind: 'opencode-openai', targets: [{ id: 'target', target: active }] }
        }
      })
      try {
        const resolved = generation.provider!
        const response = await fetch(`${resolved.openaiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${resolved.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] })
        })
        expect(response.status).toBe(400)
        expect(response.headers.get('x-open-science-upstream-status')).toBe(String(status))
        expect(providerValidationFailed((await repository.getSettings()).providers[0])).toBe(true)
        expect(published).toHaveBeenCalledOnce()
      } finally {
        await generation.release()
      }
    }
  )

  it('ignores a credential replacement that preserves the configuration revision', async () => {
    await repository.upsertProvider({
      ...original,
      keyRef: 'enc:' + Buffer.from('replacement').toString('base64')
    })
    const before = await repository.getSettings()
    await new ProviderRuntimeHealthOwner(repository).observe(target(), {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it.each([401, 403])(
    'retains provider identity through Claude route planning for upstream %s',
    async (status) => {
      const provider: StoredProvider = { ...original, apiEndpoints: ['anthropic'] }
      await repository.upsertProvider(provider)
      const framework = getAgentFramework('claude-code')
      const active = projection.resolveRuntimeTarget(provider, { kind: 'configured' }, framework)
      const plan = new BackendRoutePlanner({ providers: projection }).planBackend({
        settings: await repository.getSettings(),
        frameworkId: framework.id,
        target: active,
        effortIntent: 'default',
        conversationSkillImportEnabled: false
      })
      const published = vi.fn()
      const health = new ProviderRuntimeHealthOwner(repository, published)
      const transports = new ProviderTransportOwner({
        onProviderFailure: (source, failure) => health.observe(source, failure),
        createAnthropicProviderBridge: (targets, initial) =>
          new AnthropicProviderBridge(targets, initial, async () =>
            Response.json({ error: { message: 'invalid key' } }, { status })
          )
      })
      const generation = await transports.acquire({ activeTarget: active, plan })
      try {
        const config = generation.providerConfiguration!
        const response = await fetch(`${config.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { ...config.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: provider.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }]
          })
        })
        expect(response.status).toBe(400)
        expect(providerValidationFailed((await repository.getSettings()).providers[0])).toBe(true)
        expect(published).toHaveBeenCalledOnce()
      } finally {
        await generation.release()
      }
    }
  )

  it.each([
    ['codex', 'openai', 401],
    ['codex', 'openai', 403],
    ['codex', 'responses', 401],
    ['codex', 'responses', 403],
    ['codebuddy', 'openai', 401],
    ['codebuddy', 'openai', 403],
    ['codebuddy', 'responses', 401],
    ['codebuddy', 'responses', 403],
    ['codebuddy', 'anthropic', 401],
    ['codebuddy', 'anthropic', 403],
    ['opencode', 'anthropic', 401],
    ['opencode', 'anthropic', 403]
  ] as const)(
    'publishes confirmed failures through %s / %s for upstream %s',
    async (frameworkId, endpoint, status) => {
      const provider: StoredProvider = { ...original, apiEndpoints: [endpoint] }
      await repository.upsertProvider(provider)
      const framework = getAgentFramework(frameworkId)
      const active = projection.resolveRuntimeTarget(provider, { kind: 'configured' }, framework)
      const plan = new BackendRoutePlanner({ providers: projection }).planBackend({
        settings: await repository.getSettings(),
        frameworkId,
        target: active,
        effortIntent: 'default',
        conversationSkillImportEnabled: false
      })
      const published = vi.fn()
      const health = new ProviderRuntimeHealthOwner(repository, published)
      const upstream = async (): Promise<Response> =>
        Response.json({ error: { message: 'invalid key' } }, { status })
      const transports = new ProviderTransportOwner({
        onProviderFailure: (source, failure) => health.observe(source, failure),
        createOpenAiProviderBridge: (targets, initial) =>
          new OpenAiProviderBridge(targets, initial, upstream),
        createAnthropicProviderBridge: (targets, initial) =>
          new AnthropicProviderBridge(targets, initial, upstream),
        createResponsesBridge: (source, options) => new ResponsesBridge(source, upstream, options),
        createNativeResponsesProxy: (source) =>
          new NativeResponsesCompatibilityProxy(source, upstream),
        createChatProviderCompatibilityBridge: (source) =>
          new ChatProviderCompatibilityBridge(source, upstream)
      })
      const generation = await transports.acquire({ activeTarget: active, plan })
      try {
        const bridge = generation.responsesBridge
        const local = generation.provider
        const url = bridge
          ? `${bridge.baseUrl}/responses`
          : endpoint === 'anthropic' && frameworkId === 'opencode'
            ? `${local!.baseUrl}/v1/messages`
            : `${local!.openaiBaseUrl}/chat/completions`
        const key = bridge?.token ?? local?.key
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'x-api-key': key ?? '',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'model-a',
            input: 'Hi',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }]
          })
        })
        await response.text()
        expect(providerValidationFailed((await repository.getSettings()).providers[0])).toBe(true)
        expect(published).toHaveBeenCalledOnce()
      } finally {
        await generation.release()
      }
    }
  )

  it('limits missing-model failures to the actual model and protocol, including background models', async () => {
    await new ProviderRuntimeHealthOwner(repository).observe(target(), {
      category: 'model-not-found',
      status: 404,
      startedAt: 2,
      model: 'background-mini',
      endpoint: 'openai'
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(providerValidationFailed(stored, { model: 'background-mini', endpoint: 'openai' })).toBe(
      true
    )
    expect(providerValidationFailed(stored, { model: 'model-a', endpoint: 'openai' })).toBe(false)
    expect(
      providerValidationFailed(stored, { model: 'background-mini', endpoint: 'anthropic' })
    ).toBe(false)
  })

  it('does not recreate a deleted provider on a late failure', async () => {
    await repository.deleteProvider(original.id)
    const published = vi.fn()
    await new ProviderRuntimeHealthOwner(repository, published).observe(target(), {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    expect((await repository.getSettings()).providers).toHaveLength(0)
    expect(published).not.toHaveBeenCalled()
  })
  it('never narrows an existing account authentication failure on a later model error', async () => {
    const health = new ProviderRuntimeHealthOwner(repository)
    await health.observe(target(), {
      category: 'auth',
      status: 401,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    const before = await repository.getSettings()
    await health.observe(target(), {
      category: 'model-not-found',
      status: 404,
      startedAt: Date.now() + 1,
      model: 'other',
      endpoint: 'openai'
    })
    expect(await repository.getSettings()).toEqual(before)
    expect(
      providerValidationFailed((await repository.getSettings()).providers[0], {
        model: 'model-a',
        endpoint: 'openai'
      })
    ).toBe(true)
  })
  it('keeps independent model failures when another model is validated successfully', async () => {
    const health = new ProviderRuntimeHealthOwner(repository)
    const failure = {
      category: 'model-not-found' as const,
      status: 404,
      startedAt: 2,
      endpoint: 'openai' as const
    }
    await health.observe(target(), { ...failure, model: 'model-a' })
    await health.observe(target(), { ...failure, model: 'model-b' })
    let stored = (await repository.getSettings()).providers[0]
    expect(providerValidationFailed(stored, { model: 'model-a', endpoint: 'openai' })).toBe(true)
    expect(providerValidationFailed(stored, { model: 'model-b', endpoint: 'openai' })).toBe(true)
    await repository.updateProviderValidationIfTargetMatches(
      original.id,
      () => true,
      { ok: true, category: 'ok' },
      { model: 'model-a', endpoint: 'openai' }
    )
    await health.observe(target(), { ...failure, model: 'model-c' })
    stored = (await repository.getSettings()).providers[0]
    expect(providerValidationFailed(stored, { model: 'model-a', endpoint: 'openai' })).toBe(false)
    expect(providerValidationFailed(stored, { model: 'model-b', endpoint: 'openai' })).toBe(true)
    expect(providerValidationFailed(stored, { model: 'model-c', endpoint: 'openai' })).toBe(true)
    await health.observe(target(), { ...failure, model: 'model-c', startedAt: Date.now() + 1 })
    stored = (await repository.getSettings()).providers[0]
    expect(providerValidationFailed(stored, { model: 'model-c', endpoint: 'openai' })).toBe(true)
  })
  it('does not undo an earlier model recovery after a different model was also validated', async () => {
    const health = new ProviderRuntimeHealthOwner(repository)
    for (const model of ['model-a', 'model-b']) {
      await repository.updateProviderValidationIfTargetMatches(
        original.id,
        () => true,
        { ok: true, category: 'ok' },
        { model, endpoint: 'openai' }
      )
    }
    const before = await repository.getSettings()
    await health.observe(target(), {
      category: 'model-not-found',
      status: 404,
      startedAt: 2,
      model: 'model-a',
      endpoint: 'openai'
    })
    expect(await repository.getSettings()).toEqual(before)
  })
})
