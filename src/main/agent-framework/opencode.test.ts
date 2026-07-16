import { describe, expect, it } from 'vitest'

import { buildOpencodeConfig } from './opencode'

describe('buildOpencodeConfig', () => {
  it('registers the model under provider.models and selects it', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example/v1',
        model: 'deepseek-v4-pro',
        key: 'sk-secret'
      })
    )

    // A non-catalog model id is both selected and registered, so opencode treats it as a real model
    // instead of ignoring it and falling back to its own default.
    expect(config.model).toBe('anthropic/deepseek-v4-pro')
    expect(config.provider.anthropic.models).toEqual({ 'deepseek-v4-pro': {} })
    expect(config.provider.anthropic.options).toEqual({
      baseURL: 'https://gw.example/v1',
      apiKey: 'sk-secret'
    })
  })

  it('merges onto the user config, preserving their providers and mcp', () => {
    const base = {
      $schema: 'https://opencode.ai/config.json',
      mcp: { local: { type: 'local', command: ['x'] } },
      provider: {
        'minimax-cn-coding-plan': { options: { apiKey: 'keep-me' } },
        anthropic: { options: { timeout: 5 }, models: { 'other-model': {} } }
      }
    }

    const config = JSON.parse(
      buildOpencodeConfig(
        {
          type: 'custom',
          baseUrl: 'https://gw.example/v1',
          model: 'deepseek-v4-pro',
          key: 'sk-secret'
        },
        base
      )
    )

    // The user's own provider and mcp block survive untouched.
    expect(config.mcp).toEqual(base.mcp)
    expect(config.provider['minimax-cn-coding-plan']).toEqual({ options: { apiKey: 'keep-me' } })
    // Our additions merge into their anthropic block without dropping their existing keys.
    expect(config.provider.anthropic.options).toEqual({
      timeout: 5,
      baseURL: 'https://gw.example/v1',
      apiKey: 'sk-secret'
    })
    expect(config.provider.anthropic.models).toEqual({ 'other-model': {}, 'deepseek-v4-pro': {} })
    expect(config.model).toBe('anthropic/deepseek-v4-pro')
  })

  it('omits model + models registration when the provider has no model', () => {
    const config = JSON.parse(buildOpencodeConfig({ type: 'claude-default' }))

    expect(config.model).toBeUndefined()
    expect(config.provider.anthropic.models).toBeUndefined()
    expect(config.provider.anthropic.options).toEqual({})
  })
})
