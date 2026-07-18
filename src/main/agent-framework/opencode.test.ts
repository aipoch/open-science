import { describe, expect, it } from 'vitest'

import { buildOpencodeConfig, opencodeFramework } from './opencode'

describe('opencodeFramework.prepareModelConfig', () => {
  it('writes the connector instructions file and wires it into opencode.json instructions', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      {
        storageRoot: '/data',
        executablePath: '/bin/opencode',
        instructions: '# connectors\nhost.mcp(...)'
      }
    )

    const instructionsFile = config.configFiles?.find((file) => file.path.endsWith('connectors.md'))
    expect(instructionsFile?.content).toContain('host.mcp(')

    const opencodeJson = config.configFiles?.find((file) => file.path.endsWith('opencode.json'))
    const parsed = JSON.parse(opencodeJson?.content ?? '{}')
    expect(parsed.instructions).toContain(instructionsFile?.path)
  })

  it('omits instructions when none are provided', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    expect(config.configFiles?.some((file) => file.path.endsWith('connectors.md'))).toBe(false)
    const parsed = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    expect(parsed.instructions).toBeUndefined()
  })
})

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

  it('delegates every side-effecting tool (incl. MCP) via a "*" catch-all, allowing safe reads', () => {
    // Without the "*" rule, opencode keys permissions by tool name and MCP/websearch/task tools are
    // unmatched → run silently. The wildcard forces them to prompt; read-only tools stay allow.
    const config = JSON.parse(
      buildOpencodeConfig({ type: 'custom', baseUrl: 'https://gw/v1', model: 'm' })
    )

    expect(config.permission['*']).toBe('ask')
    // Safe read-only tools run without prompting (parity with Claude's Ask mode).
    for (const tool of ['read', 'glob', 'grep', 'list', 'lsp']) {
      expect(config.permission[tool]).toBe('allow')
    }
    // Mutating/external tools are NOT allowlisted, so they fall through to "*" → ask.
    expect(config.permission.edit).toBeUndefined()
    expect(config.permission.bash).toBeUndefined()
  })

  it('keeps delegation on even if the base config tried to disable it', () => {
    const config = JSON.parse(
      buildOpencodeConfig(
        { type: 'custom', baseUrl: 'https://gw/v1', model: 'm' },
        { permission: { '*': 'allow', edit: 'allow', extra: 'allow' } }
      )
    )

    // Our catch-all + read allowlist win over the base; unrelated base keys are preserved.
    expect(config.permission['*']).toBe('ask')
    expect(config.permission.read).toBe('allow')
    expect(config.permission.extra).toBe('allow')
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

  it('maps an openai (or both) provider to an @ai-sdk/openai-compatible provider block', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'gpt-x',
        key: 'k',
        apiType: 'openai'
      })
    )

    expect(config.model).toBe('openai-compatible/gpt-x')
    expect(config.provider['openai-compatible'].npm).toBe('@ai-sdk/openai-compatible')
    expect(config.provider['openai-compatible'].options).toEqual({
      baseURL: 'https://gw/v1',
      apiKey: 'k'
    })
    expect(config.provider['openai-compatible'].models).toEqual({ 'gpt-x': {} })
    // A 'both' provider prefers OpenAI on opencode (which supports both).
    const both = JSON.parse(
      buildOpencodeConfig({ type: 'custom', baseUrl: 'https://gw/v1', model: 'm', apiType: 'both' })
    )
    expect(both.model).toBe('openai-compatible/m')
  })

  it('uses the OpenAI base for a dual-endpoint vendor, not its Anthropic base (DeepSeek)', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://api.deepseek.com/anthropic',
        openaiBaseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        key: 'sk-ds',
        apiType: 'both'
      })
    )

    // 'both' → OpenAI on opencode, pointed at the OpenAI base with /v1 (the @ai-sdk/openai-compatible
    // client appends /chat/completions), not the /anthropic route.
    expect(config.model).toBe('openai-compatible/deepseek-v4-pro')
    expect(config.provider['openai-compatible'].options.baseURL).toBe('https://api.deepseek.com/v1')
  })

  it('normalizes a custom OpenAI base to end at /v1 (no doubling)', () => {
    const rooted = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example',
        model: 'm',
        apiType: 'openai'
      })
    )
    expect(rooted.provider['openai-compatible'].options.baseURL).toBe('https://gw.example/v1')

    const withV1 = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example/v1',
        model: 'm',
        apiType: 'openai'
      })
    )
    expect(withV1.provider['openai-compatible'].options.baseURL).toBe('https://gw.example/v1')
  })

  it('omits model + models registration when the provider has no model', () => {
    const config = JSON.parse(buildOpencodeConfig({ type: 'claude-default' }))

    expect(config.model).toBeUndefined()
    expect(config.provider.anthropic.models).toBeUndefined()
    expect(config.provider.anthropic.options).toEqual({})
  })
})
