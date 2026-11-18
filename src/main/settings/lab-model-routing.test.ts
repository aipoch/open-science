import { describe, expect, it } from 'vitest'

import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'
import { LAB_PROVIDER_ID } from '../../shared/settings-runtime'
import { buildLabProviderRecord } from './lab-provider'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import type { StoredProvider } from './types'

const labProvider = (): StoredProvider => ({
  id: LAB_PROVIDER_ID,
  type: 'lab',
  name: 'Lab',
  baseUrl: 'https://lab.example.com/v1',
  apiEndpoints: ['chat-completions', 'responses'],
  fetchedModels: ['lab:research-default', 'lab:research-fast']
})

const personalProvider: StoredProvider = {
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://api.example.com',
  model: 'research-default',
  keyRef: 'enc:key'
}

describe('Lab provider model routing', () => {
  it('strips the renderer namespace before the model reaches the gateway', () => {
    const projection = new ProviderRuntimeProjectionOwner()
    const resolved = projection.resolveProvider(labProvider(), 'lab:research-default')
    expect(resolved.type).toBe('lab')
    expect(resolved.model).toBe('research-default')
    expect(resolved.baseUrl).toBe('https://lab.example.com/v1')
    expect(resolved.key).toBeUndefined()
    expect(resolved.apiEndpoints).toEqual(['chat-completions', 'responses'])
  })

  it('lists Lab models next to personal models without colliding', () => {
    const projection = new ProviderRuntimeProjectionOwner()
    const lab = projection.toProviderView(labProvider())
    const personal = projection.toProviderView(personalProvider)
    expect(lab.models).toEqual(['lab:research-default', 'lab:research-fast'])
    expect(personal.models).toEqual(['research-default'])

    const catalog = buildConfiguredModelCatalog({
      providers: [personal, lab],
      activeProviderId: 'p1',
      frameworkId: 'open-science-agent',
      frameworkEndpoints: ['responses', 'messages', 'chat-completions']
    })
    expect(catalog.filter((entry) => entry.providerType === 'lab')).toEqual([
      expect.objectContaining({
        model: 'lab:research-default',
        label: 'research-default',
        selectable: true
      }),
      expect.objectContaining({
        model: 'lab:research-fast',
        label: 'research-fast',
        selectable: true
      })
    ])
    const keys = catalog.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('routes each model by its own protocols and disables unsupported framework pairings', () => {
    const provider = {
      ...labProvider(),
      modelProtocols: {
        'lab:research-default': ['chat-completions' as const],
        'lab:research-fast': ['responses' as const]
      }
    }
    const projection = new ProviderRuntimeProjectionOwner()
    expect(projection.resolveProvider(provider, 'lab:research-default').apiEndpoints).toEqual([
      'chat-completions'
    ])
    expect(projection.resolveProvider(provider, 'lab:research-fast').apiEndpoints).toEqual([
      'responses'
    ])

    const agentCatalog = buildConfiguredModelCatalog({
      providers: [projection.toProviderView(provider)],
      frameworkId: 'open-science-agent',
      frameworkEndpoints: ['responses', 'messages', 'chat-completions']
    })
    expect(agentCatalog.every((entry) => entry.selectable)).toBe(true)

    const codexCatalog = buildConfiguredModelCatalog({
      providers: [projection.toProviderView(provider)],
      frameworkId: 'codex',
      frameworkEndpoints: ['responses']
    })
    expect(codexCatalog).toEqual([
      expect.objectContaining({ model: 'lab:research-default', selectable: false }),
      expect.objectContaining({ model: 'lab:research-fast', selectable: true })
    ])

    const codeBuddyCatalog = buildConfiguredModelCatalog({
      providers: [projection.toProviderView(provider)],
      frameworkId: 'codebuddy',
      frameworkEndpoints: ['chat-completions']
    })
    expect(codeBuddyCatalog).toEqual([
      expect.objectContaining({ model: 'lab:research-default', selectable: true }),
      expect.objectContaining({ model: 'lab:research-fast', selectable: false })
    ])
  })

  it('rejects a model gateway outside the configured deployment', () => {
    expect(() =>
      buildLabProviderRecord('https://lab.example.com', {
        user: { id: 'usr_1' },
        device: { id: 'dev_1' },
        models: [{ id: 'research-default', protocol: 'openai' }],
        model_base_url: 'https://evil.example/v1'
      })
    ).toThrow('Lab model_base_url must stay on the configured deployment.')
  })

  it('marks Lab models unusable for a Messages-only framework', () => {
    const projection = new ProviderRuntimeProjectionOwner()
    const catalog = buildConfiguredModelCatalog({
      providers: [projection.toProviderView(labProvider())],
      frameworkId: 'claude-code',
      frameworkEndpoints: ['messages']
    })
    expect(catalog).toHaveLength(2)
    expect(catalog.every((entry) => !entry.selectable)).toBe(true)
    expect(catalog[0]?.unavailableReason).toBe('framework-incompatible')
  })
})
