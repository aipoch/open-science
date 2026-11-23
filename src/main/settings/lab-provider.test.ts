import { describe, expect, it } from 'vitest'

import type { LabBootstrap } from '../../shared/lab'
import { resolveProviderEffectiveModel } from '../../shared/provider-reasoning-effort'
import { buildLabProviderRecord } from './lab-provider'

const BOOTSTRAP: LabBootstrap = {
  user: { id: 'usr_1' },
  device: { id: 'dev_1' },
  models: [
    {
      id: 'research-default',
      protocol: 'openai',
      capabilities: {
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 64_000 }
      }
    },
    { id: 'plain-chat' },
    { id: 'lab:research-default', protocol: 'openai-response', streaming: false },
    { id: 'unsupported-model', protocols: ['anthropic'] },
    { id: 'disabled-model', protocol: 'openai', enabled: false },
    { id: 'unavailable-model', protocol: 'openai', available: false }
  ],
  model_base_url: '/v1'
}

describe('buildLabProviderRecord', () => {
  it('stores raw capabilities under the namespaced model id', () => {
    const record = buildLabProviderRecord('https://lab.example.com', BOOTSTRAP)
    expect(record.modelCapabilities).toEqual({
      'lab:research-default': {
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 64_000 }
      }
    })
    expect(record.fetchedModels).toEqual([
      'lab:research-default',
      'lab:plain-chat',
      'lab:lab:research-default'
    ])
    expect(record.modelProtocols).toMatchObject({
      'lab:research-default': ['chat-completions'],
      'lab:plain-chat': ['chat-completions'],
      'lab:lab:research-default': ['responses']
    })
    expect(record.apiEndpoints).toEqual(['chat-completions', 'responses'])
    expect(record.modelStreaming).toEqual({ 'lab:lab:research-default': false })
  })

  it.each([null, 'disabled-model', 'unavailable-model', 'unsupported-model', 'unknown-model'])(
    'leaves the default unset when the published default is %s',
    (default_model_id) => {
      const record = buildLabProviderRecord('https://lab.example.com', {
        ...BOOTSTRAP,
        default_model_id
      })
      expect(record.model).toBeUndefined()
      expect(
        resolveProviderEffectiveModel({ ...record, models: record.fetchedModels }, undefined)
      ).toBe('lab:research-default')
    }
  )

  it('publishes an empty catalog when no model has a supported protocol', () => {
    const record = buildLabProviderRecord('https://lab.example.com', {
      ...BOOTSTRAP,
      models: [{ id: 'unsupported', protocol: 'anthropic' }]
    })
    expect(record.fetchedModels).toEqual([])
    expect(record.apiEndpoints).toEqual([])
  })

  it('omits the map when no model advertises capabilities', () => {
    const record = buildLabProviderRecord('https://lab.example.com', {
      ...BOOTSTRAP,
      models: [{ id: 'plain-chat', protocol: 'openai' }]
    })
    expect(record).not.toHaveProperty('modelCapabilities')
  })
})
