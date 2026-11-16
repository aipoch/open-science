import { describe, expect, it } from 'vitest'

import type { LabBootstrap } from '../../shared/lab'
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
    { id: 'plain-chat', protocol: 'openai' },
    { id: 'disabled-model', protocol: 'openai', enabled: false }
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
    expect(record.fetchedModels).toEqual(['lab:research-default', 'lab:plain-chat'])
  })

  it('omits the map when no model advertises capabilities', () => {
    const record = buildLabProviderRecord('https://lab.example.com', {
      ...BOOTSTRAP,
      models: [{ id: 'plain-chat', protocol: 'openai' }]
    })
    expect(record).not.toHaveProperty('modelCapabilities')
  })
})
