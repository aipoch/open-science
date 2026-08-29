import { describe, expect, it, vi } from 'vitest'

import { getAgentFramework } from '../agent-framework'
import type { StoredProvider } from './types'

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
      { kind: 'configured', requestedModel: 'unavailable-model' },
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
      maskedKey: 'secr…-key',
      hasKey: true,
      needsKey: false
    })
    expect(JSON.stringify(view)).not.toContain('secret-key')
    expect(provider).toEqual(before)
  })

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

  it('enables image input only for DeepSeek vision-exp while keeping native Responses', () => {
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
        { kind: 'required', model: 'deepseek-v4-flash-vision-exp' },
        getAgentFramework('codex')
      )
    ).toMatchObject({
      apiEndpoints: ['anthropic', 'openai', 'responses'],
      needsNativeResponsesCompatibility: true,
      provider: { supportsImageInput: true, model: 'deepseek-v4-flash-vision-exp' }
    })
    expect(
      owner.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: 'deepseek-v4-flash' },
        getAgentFramework('codex')
      ).provider.supportsImageInput
    ).toBe(false)
    expect(owner.toProviderView(provider).supportsImageInput).toBe(false)
  })

  it('projects regional Tencent Hy4 across every supported framework', () => {
    const owner = new ProviderRuntimeProjectionOwner()
    const provider: StoredProvider = {
      id: 'tencent-tokenhub',
      type: 'official',
      vendorId: 'tencent',
      region: 'singapore',
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
          baseUrl: 'https://tokenhub-intl.tencentmaas.com',
          openaiBaseUrl: 'https://tokenhub-intl.tencentmaas.com/v1',
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
