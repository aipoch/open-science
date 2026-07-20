import { join } from 'node:path'

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

  it('passes the decrypted key via the spawn env and keeps it out of the written config', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'sk-plaintext-secret' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    // The real key rides the env under the referenced var, never touching disk.
    expect(config.env?.OPENCODE_APP_API_KEY).toBe('sk-plaintext-secret')
    const opencodeJson = config.configFiles?.find((file) => file.path.endsWith('opencode.json'))
    expect(opencodeJson?.content).not.toContain('sk-plaintext-secret')
    expect(JSON.parse(opencodeJson?.content ?? '{}').provider.anthropic.options.apiKey).toBe(
      '{env:OPENCODE_APP_API_KEY}'
    )
  })

  it('does not set the key env var when the provider carries no key', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'claude-default' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )
    expect(config.env && 'OPENCODE_APP_API_KEY' in config.env).toBe(false)
  })

  it('enforces the permission policy via OPENCODE_CONFIG_CONTENT (above any project config)', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const rules = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}').permission
    expect(rules['*']).toBe('ask')
    for (const tool of ['read', 'glob', 'grep', 'list', 'lsp']) {
      expect(rules[tool]).toBe('allow')
    }
    for (const tool of [
      'edit',
      'bash',
      'task',
      'skill',
      'webfetch',
      'websearch',
      'external_directory'
    ]) {
      expect(rules[tool]).toBe('ask')
    }
  })

  it('redirects opencode home to an app-owned dir so the user ~/.opencode cannot inject config', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    // OPENCODE_TEST_HOME overrides opencode's Global.Path.home to an app-owned dir, so its home
    // `.opencode` config walk finds nothing — set alongside the existing XDG/config isolation env.
    expect(config.env?.OPENCODE_TEST_HOME).toBe(join('/data', 'opencode', 'home'))
    expect(config.env?.XDG_CONFIG_HOME).toBe(join('/data', 'opencode', 'config'))
    expect(config.env?.XDG_DATA_HOME).toBe(join('/data', 'opencode', 'data'))
    expect(config.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true')
    expect(config.env?.OPENCODE_CONFIG_CONTENT).toBeTruthy()
  })

  it('disables project config loading so a repo cannot inject opencode.json / .opencode config', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    // Truthy per opencode's truthy(): closes the whole project-config surface (both opencode.json/.jsonc
    // walked up from cwd and the .opencode/ directory), so a repo cannot add an exact-id allow rule or
    // repoint the provider at all.
    expect(config.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true')
  })

  it('pins the authoritative provider/model/baseURL (not just permission) in OPENCODE_CONFIG_CONTENT', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw.example/v1', model: 'deepseek-v4-pro', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    // The high-priority layer pins model + provider + baseURL so a lower-precedence ~/.opencode cannot
    // repoint the endpoint or swap the model while inheriting the key ref.
    expect(content.model).toBe('anthropic/deepseek-v4-pro')
    expect(content.provider.anthropic.options.baseURL).toBe('https://gw.example/v1')
    expect(content.provider.anthropic.models).toEqual({ 'deepseek-v4-pro': {} })
    // Permission policy is still pinned.
    expect(content.permission['*']).toBe('ask')
    // The key rides the env as a reference only — never a plaintext literal in the pinned layer.
    expect(content.provider.anthropic.options.apiKey).toBe('{env:OPENCODE_APP_API_KEY}')
    expect(config.env?.OPENCODE_CONFIG_CONTENT).not.toContain('"k"')
  })

  it('mirrors the config file provider/model in the OPENCODE_CONFIG_CONTENT layer (no divergence)', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'gpt-x', key: 'k', apiType: 'openai' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    // The pinned layer and the written file select the same model and provider block, so they cannot
    // drift out of sync.
    expect(content.model).toBe(fileConfig.model)
    expect(content.provider['openai-compatible'].npm).toBe('@ai-sdk/openai-compatible')
    expect(content.provider['openai-compatible'].options.baseURL).toBe(
      fileConfig.provider['openai-compatible'].options.baseURL
    )
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
    // The key is referenced via opencode env interpolation, never emitted as a plaintext literal.
    expect(config.provider.anthropic.options).toEqual({
      baseURL: 'https://gw.example/v1',
      apiKey: '{env:OPENCODE_APP_API_KEY}'
    })
  })

  it('never emits the decrypted key as a plaintext literal (only an env reference)', () => {
    const serialized = buildOpencodeConfig({
      type: 'custom',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      key: 'sk-super-secret'
    })

    expect(serialized).not.toContain('sk-super-secret')
    expect(JSON.parse(serialized).provider.anthropic.options.apiKey).toBe(
      '{env:OPENCODE_APP_API_KEY}'
    )
  })

  it('omits apiKey entirely when the provider carries no key', () => {
    const config = JSON.parse(
      buildOpencodeConfig({ type: 'custom', baseUrl: 'https://gw/v1', model: 'm' })
    )
    expect(config.provider.anthropic.options.apiKey).toBeUndefined()
  })

  it('pins sensitive built-in tools to ask so a workspace config cannot flip them to allow', () => {
    const config = JSON.parse(
      buildOpencodeConfig(
        { type: 'custom', baseUrl: 'https://gw/v1', model: 'm' },
        { permission: { edit: 'allow', bash: 'allow', task: 'allow' } }
      )
    )

    // Our rules override the base for every side-effecting built-in.
    for (const tool of [
      'edit',
      'bash',
      'task',
      'skill',
      'webfetch',
      'websearch',
      'external_directory'
    ]) {
      expect(config.permission[tool]).toBe('ask')
    }
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
    // Mutating/external tools are pinned to ask (and unlisted MCP tools fall through to "*" → ask).
    expect(config.permission.edit).toBe('ask')
    expect(config.permission.bash).toBe('ask')
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
      apiKey: '{env:OPENCODE_APP_API_KEY}'
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
      apiKey: '{env:OPENCODE_APP_API_KEY}'
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
