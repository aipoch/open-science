import { expect, it, vi } from 'vitest'
import { capturePdfTranslationApiTarget } from './api-target'
import { ProviderTextGenerationService } from './text-generation'
vi.mock('electron', () => ({ net: {} }))
import type { SettingsSnapshot, ProviderView } from '../../../shared/settings'

const api: ProviderView = {
  id: 'api',
  name: 'API',
  type: 'custom',
  baseUrl: 'https://example.test',
  apiEndpoints: ['chat-completions'],
  models: ['one', 'two'],
  hasKey: true,
  needsKey: false,
  supportsImageInput: false
}
function setup(): {
  getSettingsView: ReturnType<typeof vi.fn<() => Promise<SettingsSnapshot>>>
  resolveExplicitDirectProvider: ReturnType<
    typeof vi.fn<
      Parameters<typeof capturePdfTranslationApiTarget>[0]['resolveExplicitDirectProvider']
    >
  >
} {
  return {
    getSettingsView: vi.fn(
      async () =>
        ({
          activeProviderId: 'subscription',
          activeModel: 'subscription-model',
          providers: [api, { ...api, id: 'subscription', type: 'codex-isolated' }]
        }) as SettingsSnapshot
    ),
    resolveExplicitDirectProvider: vi
      .fn<Parameters<typeof capturePdfTranslationApiTarget>[0]['resolveExplicitDirectProvider']>()
      .mockResolvedValue({
        providerId: 'api',
        provider: { type: 'custom', model: 'two', key: 'secret' },
        reasoningEffortProfile: { supported: false }
      })
  }
}
it('resolves the explicitly selected API model independently of the main subscription model', async () => {
  const settings = setup()
  const selected = { providerId: 'api', modelId: 'two' }
  await expect(capturePdfTranslationApiTarget(settings, selected)).resolves.toMatchObject({
    providerId: 'api',
    providerName: 'API',
    model: 'two'
  })
  expect(settings.resolveExplicitDirectProvider).toHaveBeenCalledWith({
    frameworkId: 'opencode',
    providerId: 'api',
    model: { kind: 'required', id: 'two' },
    reasoningEffort: 'low'
  })
  expect((await settings.getSettingsView()).activeProviderId).toBe('subscription')
})
it.each([
  undefined,
  { providerId: 'subscription', modelId: 'one' },
  { providerId: 'api', modelId: 'removed' },
  { providerId: 'deleted', modelId: 'one' }
])(
  'rejects unavailable or subscription models before resolving credentials: %j',
  async (selection) => {
    const settings = setup()
    await expect(capturePdfTranslationApiTarget(settings, selection)).rejects.toThrow(
      '[pdf-translation:unsupported-model]'
    )
    expect(settings.resolveExplicitDirectProvider).not.toHaveBeenCalled()
  }
)

it('executes an official API model admitted by the translation picker', async () => {
  const settings = setup()
  settings.getSettingsView.mockResolvedValue({
    activeProviderId: 'api',
    activeModel: 'two',
    providers: [{ ...api, type: 'official', vendorId: 'openai' }]
  } as SettingsSnapshot)
  settings.resolveExplicitDirectProvider.mockResolvedValue({
    providerId: 'api',
    provider: {
      type: 'official',
      vendorId: 'openai',
      model: 'two',
      baseUrl: 'https://example.invalid',
      apiEndpoints: ['chat-completions'],
      key: 'test-key'
    },
    reasoningEffortProfile: { supported: false }
  })
  const target = await capturePdfTranslationApiTarget(settings, {
    providerId: 'api',
    modelId: 'two'
  })
  const fetchImpl = vi.fn(async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: '细胞' } }] })
  )
  const service = new ProviderTextGenerationService(fetchImpl)
  await expect(
    service.run({
      target,
      systemPrompt: 'Translate faithfully.',
      prompt: 'Cell',
      signal: new AbortController().signal,
      maxOutputTokens: 1024,
      outputLimitBytes: 4096
    })
  ).resolves.toEqual({ text: '细胞', stopReason: 'end_turn' })
  expect(fetchImpl).toHaveBeenCalledOnce()
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://example.invalid/v1/chat/completions',
    expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({ authorization: 'Bearer test-key' })
    })
  )
})

it('projects only direct API configuration and rejects a stale subscription resolution', async () => {
  const settings = setup()
  settings.resolveExplicitDirectProvider.mockResolvedValue({
    providerId: 'api',
    provider: {
      type: 'custom',
      model: 'two',
      key: 'secret',
      baseUrl: 'https://example.test',
      apiEndpoints: ['chat-completions'],
      agentProviderId: 'runtime-only',
      contextWindow: 32000
    },
    reasoningEffortProfile: { supported: true, slots: ['none', 'low', 'medium', 'high', 'max'] }
  })
  const target = await capturePdfTranslationApiTarget(settings, {
    providerId: 'api',
    modelId: 'two'
  })
  expect(target.reasoningEffort).toBe('none')
  expect(target.provider).toEqual({
    type: 'custom',
    key: 'secret',
    baseUrl: 'https://example.test',
    chatCompletionsBaseUrl: undefined,
    apiEndpoints: ['chat-completions'],
    vendorId: undefined,
    reasoningEffortTransport: undefined,
    maxOutputTokens: undefined
  })
  expect(target).not.toHaveProperty('reasoningEffortProfile')
  settings.resolveExplicitDirectProvider.mockResolvedValue({
    providerId: 'api',
    provider: { type: 'codex-isolated' },
    reasoningEffortProfile: { supported: false }
  })
  await expect(
    capturePdfTranslationApiTarget(settings, { providerId: 'api', modelId: 'two' })
  ).rejects.toThrow('[pdf-translation:unsupported-model]')
})
