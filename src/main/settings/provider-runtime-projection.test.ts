import { describe, expect, it, vi } from 'vitest'

import { getAgentFramework } from '../agent-framework'
import type { StoredProvider } from './types'
import { resolveProviderDraft } from './provider-draft-projection'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  }
}))

const { ProviderRuntimeProjectionOwner } = await import('./provider-runtime-projection')
const { encryptKey } = await import('./crypto')

describe('ProviderRuntimeProjectionOwner', () => {
  it('projects DeepSeek native Responses traffic to its documented origin', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'deepseek',
      type: 'official',
      vendorId: 'deepseek',
      name: 'DeepSeek',
      model: 'deepseek-flash'
    }

    expect(resolveProviderDraft(provider)).toMatchObject({
      baseUrl: 'https://api.deepseek.com/anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      responsesBaseUrl: 'https://api.deepseek.com'
    })
    expect(owner.resolveProvider(provider, 'deepseek-flash')).toMatchObject({
      baseUrl: 'https://api.deepseek.com/anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      responsesBaseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash'
    })
  })

  it.each([
    [undefined, 'cn'],
    ['china', 'cn'],
    ['global', 'ai']
  ])('resolves the SenseNova validation draft for region %s', (region, domain) => {
    expect(
      resolveProviderDraft({
        type: 'official',
        vendorId: 'sensenova',
        region,
        key: 'synthetic-key'
      })
    ).toMatchObject({
      baseUrl: `https://token.sensenova.${domain}`,
      openaiBaseUrl: `https://token.sensenova.${domain}/v1`,
      model: 'sensenova-6.8-flash-lite',
      apiEndpoints: ['anthropic', 'openai']
    })
  })

  it('exposes current OpenAI models to API and Codex subscription providers', () => {
    const owner = new ProviderRuntimeProjectionOwner()

    const openai: StoredProvider = {
      id: 'openai',
      type: 'official',
      vendorId: 'openai',
      name: 'OpenAI'
    }
    const codex: StoredProvider = {
      id: 'builtin-codex-isolated',
      type: 'codex-isolated',
      name: 'Codex subscription'
    }

    expect(owner.toProviderView(openai).models).toEqual(
      expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna'])
    )
    expect(owner.toProviderView(codex).models).toEqual(
      expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna'])
    )
  })

  it('resolves Claude Opus 5.5 for API and pinned subscription targets', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const framework = getAgentFramework('claude-code')
    const providers: StoredProvider[] = [
      {
        id: 'anthropic',
        type: 'official',
        vendorId: 'anthropic',
        name: 'Anthropic'
      },
      {
        id: 'builtin-claude-isolated',
        type: 'claude-isolated',
        name: 'Claude subscription',
        model: 'claude-opus-5-5'
      }
    ]

    for (const provider of providers) {
      const target = owner.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: 'claude-opus-5-5' },
        framework
      )

      expect(target.effectiveModel).toBe('claude-opus-5-5')
      expect(target.provider).toMatchObject({
        model: 'claude-opus-5-5',
        contextWindow: 1_000_000,
        supportsImageInput: true
      })
    }
  })

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'resolves an omitted model from the changing provider default for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const provider: StoredProvider = {
        id: 'anthropic',
        type: 'official',
        vendorId: 'anthropic',
        name: 'Anthropic',
        model: 'claude-opus-4-6',
        fetchedModels: ['claude-sonnet-4-6', 'claude-opus-4-6']
      }
      const framework = getAgentFramework(frameworkId)
      expect(
        owner.resolveRuntimeTarget(provider, { kind: 'configured' }, framework).effectiveModel
      ).toBe('claude-opus-4-6')
      const changed = { ...provider, model: 'claude-sonnet-4-6' }
      expect(
        owner.resolveRuntimeTarget(changed, { kind: 'configured' }, framework).effectiveModel
      ).toBe('claude-sonnet-4-6')
      expect(
        owner.resolveRuntimeTarget(
          changed,
          {
            kind: 'configured',
            requestedModel: 'claude-opus-4-6'
          },
          framework
        ).effectiveModel
      ).toBe('claude-opus-4-6')
    }
  )

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'offers Grok 4.7 without replacing saved xAI selections for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const framework = getAgentFramework(frameworkId)
      for (const type of ['official', 'xai-subscription'] as const) {
        const provider: StoredProvider = {
          id: `xai-${type}`,
          type,
          vendorId: 'xai',
          name: 'xAI',
          model: 'grok-4.6'
        }
        const before = structuredClone(provider)
        expect(owner.toProviderView(provider).models).toContain('grok-4.7')
        expect(
          owner.resolveRuntimeTarget(provider, { kind: 'configured' }, framework).effectiveModel
        ).toBe('grok-4.6')
        const target = owner.resolveRuntimeTarget(
          provider,
          { kind: 'required', model: 'grok-4.7' },
          framework
        )
        expect(target.effectiveModel).toBe('grok-4.7')
        expect(target.frameworkCompatible).toBe(
          type === 'xai-subscription' || frameworkId !== 'claude-code'
        )
        expect(target.provider).toMatchObject({
          model: 'grok-4.7',
          contextWindow: 500_000,
          supportsImageInput: true
        })
        expect(provider).toEqual(before)
      }
    }
  )

  it('fails closed when a required model is outside the provider catalog', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'provider-1',
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      apiEndpoints: ['openai']
    }

    expect(() =>
      owner.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: 'unavailable-model' },
        getAgentFramework('codex')
      )
    ).toThrow(
      'The requested model "unavailable-model" is not available for provider "Lab gateway".'
    )
  })

  it('projects a configured target without mutating or exposing the stored credential', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'provider-1',
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      keyRef: encryptKey('secret-key'),
      keyMask: 'secr…-key',
      apiEndpoints: ['openai']
    }
    const before = structuredClone(provider)

    const target = owner.resolveRuntimeTarget(
      provider,
      { kind: 'configured', requestedModel: 'lab-model' },
      getAgentFramework('codex')
    )
    const view = owner.toProviderView(provider)

    expect(target).toMatchObject({
      providerId: 'provider-1',
      effectiveModel: 'lab-model',
      provider: { model: 'lab-model', key: 'secret-key' },
      needsChatResponsesBridge: true
    })
    expect(view).toMatchObject({
      models: ['lab-model'],
      maskedKey: '••••-key',
      hasKey: true,
      needsKey: false
    })
    expect(JSON.stringify(view)).not.toContain('secret-key')
    expect(provider).toEqual(before)
  })

  it('hardens historical persisted key masks before projecting them', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'provider-1',
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      keyRef: encryptKey('secret-key'),
      keyMask: 'secr…-key',
      apiEndpoints: ['openai']
    }

    expect(owner.toProviderView(provider).maskedKey).toBe('••••-key')
    expect(provider.keyMask).toBe('secr…-key')
  })

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'preserves pinned DeepSeek legacy ids after a cached refresh for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const provider: StoredProvider = {
        id: 'deepseek',
        type: 'official',
        vendorId: 'deepseek',
        name: 'DeepSeek',
        fetchedModels: ['deepseek-flash', 'deepseek-v4-pro']
      }
      for (const model of [
        'deepseek-v4-pro[1m]',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp'
      ]) {
        expect(owner.toProviderView(provider).models).toContain(model)
        expect(
          owner.resolveRuntimeTarget(
            provider,
            { kind: 'required', model },
            getAgentFramework(frameworkId)
          )
        ).toMatchObject({ effectiveModel: model, provider: { model }, frameworkCompatible: true })
      }
    }
  )

  it('routes DeepSeek V4 Pro through native Responses for Codex', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'deepseek',
      type: 'official',
      vendorId: 'deepseek',
      name: 'DeepSeek'
    }

    expect(
      owner.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: 'deepseek-v4-pro' },
        getAgentFramework('codex')
      )
    ).toMatchObject({
      apiEndpoints: ['anthropic', 'openai', 'responses'],
      frameworkCompatible: true,
      needsChatResponsesBridge: false,
      needsNativeResponsesCompatibility: true
    })
  })

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'projects Ark capabilities without changing a saved selection for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const provider: StoredProvider = {
        id: 'ark',
        type: 'official',
        vendorId: 'volcengine',
        name: 'Ark',
        model: 'doubao-seed-2-1-pro-260628'
      }
      const before = structuredClone(provider)
      const framework = getAgentFramework(frameworkId)
      for (const model of [
        'doubao-seed-2-1-pro-260915',
        'deepseek-v4-1-flash-260910',
        'glm-5-3-flash-260828'
      ]) {
        const target = owner.resolveRuntimeTarget(provider, { kind: 'required', model }, framework)
        expect(target).toMatchObject({
          effectiveModel: model,
          frameworkCompatible: true,
          needsChatResponsesBridge: false,
          needsNativeResponsesCompatibility: frameworkId === 'codex',
          provider: { supportsImageInput: true, contextWindow: 1_024_000 }
        })
      }
      expect(
        owner.resolveRuntimeTarget(provider, { kind: 'configured' }, framework).effectiveModel
      ).toBe('doubao-seed-2-1-pro-260628')
      expect(provider).toEqual(before)
      expect(
        resolveProviderDraft({ type: 'official', vendorId: 'volcengine', key: 'synthetic-key' })
      ).toMatchObject({ model: 'doubao-seed-2-1-pro-260915' })
    }
  )

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'projects the SenseNova catalog and preserves a pinned legacy model for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const provider: StoredProvider = {
        id: 'sensenova',
        type: 'official',
        vendorId: 'sensenova',
        name: 'SenseNova'
      }
      const before = structuredClone(provider)
      const framework = getAgentFramework(frameworkId)
      const targets = owner.resolveRuntimeModelCatalog(provider, framework)

      expect(targets.map(({ effectiveModel }) => effectiveModel)).toEqual([
        'sensenova-6.8-flash-lite',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'glm-5.2',
        'kimi-k3',
        'sensenova-6.7-flash-lite'
      ])
      for (const target of targets) {
        const messagesSupported = [
          'sensenova-6.8-flash-lite',
          'deepseek-v4-flash',
          'sensenova-6.7-flash-lite'
        ].includes(target.effectiveModel ?? '')
        expect(target).toMatchObject({
          frameworkCompatible: frameworkId !== 'claude-code' || messagesSupported,
          needsChatResponsesBridge: frameworkId === 'codex',
          needsNativeResponsesCompatibility: false,
          provider: {
            vendorId: 'sensenova',
            baseUrl: 'https://token.sensenova.cn',
            openaiBaseUrl: 'https://token.sensenova.cn/v1',
            supportsImageInput: [
              'sensenova-6.8-flash-lite',
              'kimi-k3',
              'sensenova-6.7-flash-lite'
            ].includes(target.effectiveModel ?? '')
          }
        })
      }
      expect(
        owner.resolveRuntimeTarget(provider, { kind: 'provider-default' }, framework).effectiveModel
      ).toBe('sensenova-6.8-flash-lite')
      expect(
        owner.resolveRuntimeTarget(
          provider,
          { kind: 'configured', requestedModel: 'sensenova-6.7-flash-lite' },
          framework
        ).effectiveModel
      ).toBe('sensenova-6.7-flash-lite')
      expect(provider).toEqual(before)
    }
  )

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'routes SenseNova Global and rejects China-only models for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      const provider: StoredProvider = {
        id: 'sensenova-global',
        type: 'official',
        vendorId: 'sensenova',
        name: 'SenseNova Global',
        region: 'global',
        fetchedModels: ['deepseek-v4-pro', 'sensenova-6.7-flash-lite']
      }
      const before = structuredClone(provider)
      const framework = getAgentFramework(frameworkId)
      expect(owner.toProviderView(provider).models).toEqual(['sensenova-6.8-flash-lite'])
      expect(owner.resolveRuntimeModelCatalog(provider, framework)).toEqual([
        expect.objectContaining({
          effectiveModel: 'sensenova-6.8-flash-lite',
          frameworkCompatible: true,
          needsChatResponsesBridge: frameworkId === 'codex',
          needsNativeResponsesCompatibility: false,
          provider: expect.objectContaining({
            baseUrl: 'https://token.sensenova.ai',
            openaiBaseUrl: 'https://token.sensenova.ai/v1',
            supportsImageInput: true
          })
        })
      ])
      for (const model of ['deepseek-v4-pro', 'sensenova-6.7-flash-lite']) {
        expect(() =>
          owner.resolveRuntimeTarget(provider, { kind: 'required', model }, framework)
        ).toThrow('not available')
        expect(() =>
          owner.resolveRuntimeTarget(
            provider,
            { kind: 'configured', requestedModel: model },
            framework
          )
        ).toThrow()
      }
      expect(
        owner.resolveRuntimeTarget(provider, { kind: 'provider-default' }, framework).effectiveModel
      ).toBe('sensenova-6.8-flash-lite')
      expect(provider).toEqual(before)
    }
  )

  it('enables image input for DeepSeek V4.1 Flash and aliases while keeping native Responses', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'deepseek',
      type: 'official',
      vendorId: 'deepseek',
      name: 'DeepSeek'
    }

    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(
        owner.resolveRuntimeTarget(
          provider,
          { kind: 'required', model },
          getAgentFramework('codex')
        )
      ).toMatchObject({
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        needsNativeResponsesCompatibility: true,
        provider: { supportsImageInput: true, model }
      })
    }
    expect(owner.toProviderView(provider).supportsImageInput).toBe(false)
  })

  it('projects regional Tencent Hy4 across every supported framework', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'tencent-tokenhub',
      type: 'official',
      vendorId: 'tencent',
      region: 'international',
      name: 'Tencent TokenHub'
    }

    for (const frameworkId of ['claude-code', 'opencode', 'codex', 'codebuddy'] as const) {
      expect(
        owner.resolveRuntimeTarget(
          provider,
          { kind: 'required', model: 'hy4-preview' },
          getAgentFramework(frameworkId)
        )
      ).toMatchObject({
        effectiveModel: 'hy4-preview',
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        frameworkCompatible: true,
        provider: {
          vendorId: 'tencent',
          baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com',
          openaiBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
          model: 'hy4-preview',
          contextWindow: 1_000_000,
          supportsImageInput: false
        }
      })
    }

    expect(
      owner.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: 'hy4-preview' },
        getAgentFramework('codex')
      )
    ).toMatchObject({
      needsChatResponsesBridge: false,
      needsNativeResponsesCompatibility: true
    })
  })

  it.each([
    {
      vendorId: 'tencentcodingplan' as const,
      name: 'Tencent Coding Plan',
      model: 'deepseek-v4-flash-202605',
      baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
      openaiBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3'
    },
    {
      vendorId: 'tencenttokenplan' as const,
      name: 'Tencent Token Plan',
      model: 'glm-5.2',
      baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic',
      openaiBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3'
    }
  ])('projects $name across every supported framework', (expected) => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: expected.vendorId,
      type: 'official',
      vendorId: expected.vendorId,
      name: expected.name
    }

    for (const frameworkId of ['claude-code', 'opencode', 'codex', 'codebuddy'] as const) {
      expect(
        owner.resolveRuntimeTarget(
          provider,
          { kind: 'required', model: expected.model },
          getAgentFramework(frameworkId)
        )
      ).toMatchObject({
        effectiveModel: expected.model,
        apiEndpoints: ['anthropic', 'openai'],
        frameworkCompatible: true,
        needsChatResponsesBridge: frameworkId === 'codex',
        needsNativeResponsesCompatibility: false,
        provider: {
          vendorId: expected.vendorId,
          baseUrl: expected.baseUrl,
          openaiBaseUrl: expected.openaiBaseUrl,
          model: expected.model
        }
      })
    }
  })

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'projects free gateway models through their supported protocols for %s',
    (frameworkId) => {
      const owner = new ProviderRuntimeProjectionOwner()
      for (const [vendorId, models] of [
        ['openrouter', ['openrouter/free', 'google/gemma-4-31b-it:free']],
        ['opencode', ['big-pickle', 'mimo-v2.5-free']]
      ] as const) {
        const provider: StoredProvider = {
          id: vendorId,
          type: 'official',
          vendorId,
          name: vendorId
        }
        const framework = getAgentFramework(frameworkId)
        const catalog = owner.resolveRuntimeModelCatalog(provider, framework)
        for (const model of models) {
          expect(catalog.map(({ effectiveModel }) => effectiveModel)).toContain(model)
          expect(
            owner.resolveRuntimeTarget(provider, { kind: 'required', model }, framework)
          ).toMatchObject({
            effectiveModel: model,
            apiEndpoints: vendorId === 'openrouter' ? ['anthropic', 'openai'] : ['openai'],
            frameworkCompatible: vendorId === 'openrouter' || frameworkId !== 'claude-code',
            needsChatResponsesBridge: frameworkId === 'codex',
            needsNativeResponsesCompatibility: false,
            provider: { model, supportsImageInput: model !== 'big-pickle' }
          })
        }
      }
    }
  )

  it('routes mixed OpenCode Zen models only through their documented protocol', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'opencode-zen',
      type: 'official',
      vendorId: 'opencode',
      name: 'OpenCode Zen'
    }

    const responsesTarget = owner.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: 'gpt-5.6-sol' },
      getAgentFramework('codex')
    )
    const incompatibleResponsesTarget = owner.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: 'gpt-5.6-sol' },
      getAgentFramework('opencode')
    )
    const messagesTarget = owner.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: 'claude-opus-5' },
      getAgentFramework('claude-code')
    )

    expect(responsesTarget).toMatchObject({
      apiEndpoints: ['responses'],
      frameworkCompatible: true,
      needsChatResponsesBridge: false,
      needsNativeResponsesCompatibility: true
    })
    expect(incompatibleResponsesTarget).toMatchObject({
      apiEndpoints: ['responses'],
      frameworkCompatible: false
    })
    expect(messagesTarget).toMatchObject({
      apiEndpoints: ['anthropic'],
      frameworkCompatible: true,
      needsChatResponsesBridge: false,
      needsNativeResponsesCompatibility: false
    })
  })

  it('keeps an exact required model when a subscription catalog is unknown', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'builtin-claude-shared',
      type: 'claude-shared',
      name: 'Claude shared'
    }

    const target = owner.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: 'account-model' },
      getAgentFramework('claude-code')
    )

    expect(target).toMatchObject({
      effectiveModel: 'account-model',
      provider: { model: 'account-model' }
    })
  })

  it('builds a catalog and reasoning profile through the same effective-model policy', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'provider-1',
      type: 'custom',
      name: 'Lab gateway',
      model: 'lab-model',
      apiEndpoints: ['anthropic']
    }

    expect(owner.resolveRuntimeModelCatalog(provider, getAgentFramework('claude-code'))).toEqual([
      expect.objectContaining({ effectiveModel: 'lab-model', frameworkCompatible: true })
    ])
    expect(owner.resolveRuntimeReasoningEffortProfile(provider, 'unavailable-model')).toMatchObject(
      {
        supported: true
      }
    )
  })
})

it('rejects a persisted remote HTTP provider before projecting credentials into an agent process', () => {
  const owner = new ProviderRuntimeProjectionOwner()
  const provider: StoredProvider = {
    id: 'legacy',
    name: 'Legacy',
    type: 'custom',
    baseUrl: 'http://remote-gateway.invalid',
    model: 'model',
    keyRef: encryptKey('PRIVACY_CANARY')
  }
  expect(() => owner.resolveProvider(provider)).toThrow(/HTTPS/)
  expect(owner.toProviderView(provider).baseUrl).toBe(provider.baseUrl)
})
