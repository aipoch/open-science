import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildOpencodeConfig, opencodeFramework } from './opencode'

describe('opencodeFramework.prepareModelConfig', () => {
  it('writes connector conventions and wires them into opencode.json instructions', () => {
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

  it('writes stable app guidance to native instructions instead of a user prompt', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      {
        storageRoot: '/data',
        executablePath: '/bin/opencode',
        systemPromptAppends: [
          'Use `notebook_execute` from `open-science-notebook`.',
          'Then call `write_artifact_file`.'
        ]
      }
    )

    const instructionsFile = config.configFiles?.find((file) =>
      file.path.endsWith('open-science.md')
    )
    expect(instructionsFile?.content).toBe(
      'Use `open_science_notebook_notebook_execute` from `open_science_notebook`.\n\nThen call `open_science_artifacts_write_artifact_file`.'
    )
    const opencodeJson = config.configFiles?.find((file) => file.path.endsWith('opencode.json'))
    expect(JSON.parse(opencodeJson?.content ?? '{}').instructions).toContain(instructionsFile?.path)
    expect(config.persistentSystemPrompt).toBe(instructionsFile?.content)
    expect(
      opencodeFramework.buildSessionSetup({
        systemPromptAppends: [],
        turnPromptReminders: ['turn-only reminder']
      })
    ).toEqual({ promptPrefix: 'turn-only reminder' })
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
      { type: 'custom', baseUrl: 'https://g/v1' },
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
    for (const tool of ['read', 'glob', 'grep', 'list', 'lsp', 'skill']) {
      expect(rules[tool]).toBe('allow')
    }
    for (const tool of ['edit', 'bash', 'webfetch', 'websearch', 'external_directory']) {
      expect(rules[tool]).toBe('ask')
    }
    expect(rules.task).toBe('deny')
    expect(JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}').agent).toEqual({
      general: { disable: true },
      explore: { disable: true },
      scout: { disable: true }
    })
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

  it('disables external skill discovery so host-global skills cannot enter the app catalog', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    // OpenCode scans ~/.agents/skills and ~/.claude/skills independently from its XDG config.
    // Keep both supported kill switches explicit so a host-global skill cannot be advertised in
    // the app session even if OpenCode's internal/test-only home override changes or is ignored.
    expect(config.env?.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('true')
    expect(config.env?.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe('true')
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
      {
        type: 'custom',
        baseUrl: 'https://gw.example/v1',
        model: 'deepseek-v4-pro',
        inputLimit: 128_000,
        key: 'k'
      },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    // The high-priority layer pins model + provider + baseURL so a lower-precedence ~/.opencode cannot
    // repoint the endpoint or swap the model while inheriting the key ref.
    expect(content.model).toBe('anthropic/deepseek-v4-pro')
    expect(content.provider.anthropic.options.baseURL).toBe('https://gw.example/v1')
    expect(content.provider.anthropic.models).toEqual({
      'deepseek-v4-pro': { limit: { input: 128_000 } }
    })
    // Permission policy is still pinned.
    expect(content.permission['*']).toBe('ask')
    // The key rides the env as a reference only — never a plaintext literal in the pinned layer.
    expect(content.provider.anthropic.options.apiKey).toBe('{env:OPENCODE_APP_API_KEY}')
    expect(config.env?.OPENCODE_CONFIG_CONTENT).not.toContain('"k"')
  })

  it('gives the Anthropic AI SDK a /v1 base so it requests /v1/messages', () => {
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'https://gateway.example',
        model: 'claude-opus-4-8',
        key: 'k'
      },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider.anthropic.options.baseURL).toBe('https://gateway.example/v1')
  })

  it('does not invent an output limit for a custom model', () => {
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'https://gateway.example',
        model: 'small-context-model',
        inputLimit: 16_000,
        key: 'k'
      },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider.anthropic.models['small-context-model'].limit).toEqual({
      input: 16_000
    })
  })

  it('declares image capability in the pinned layer for a multimodal model', () => {
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'kimi-k3',
        key: 'k',
        apiEndpoints: ['openai'],
        supportsImageInput: true
      },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider['openai-compatible'].models).toEqual({
      'kimi-k3': { attachment: true, modalities: { input: ['text', 'image'] } }
    })
  })

  it('mirrors the config file provider/model in the OPENCODE_CONFIG_CONTENT layer (no divergence)', () => {
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'gpt-x',
        key: 'k',
        apiEndpoints: ['openai']
      },
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

  it('declares the reasoning effort on the model in both config layers', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode', reasoningEffort: 'low' }
    )

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    // Both layers carry the per-model knob so neither the written file nor the pinned layer drops it.
    expect(fileConfig.provider.anthropic.models).toEqual({
      m: { options: { reasoningEffort: 'low' } }
    })
    expect(content.provider.anthropic.models).toEqual({
      m: { options: { reasoningEffort: 'low' } }
    })
  })

  it.each([
    ['none', 'none'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
    ['ultra', 'max']
  ] as const)('encodes model effort %s as OpenCode transport level %s', (effort, expected) => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode', reasoningEffort: effort }
    )

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    const expectedModel = { options: { reasoningEffort: expected } }
    expect(fileConfig.provider.anthropic.models).toEqual({ m: expectedModel })
    expect(content.provider.anthropic.models).toEqual({ m: expectedModel })
  })

  it.each([
    ['minimax', 'MiniMax-M3', 'none', { thinking: { type: 'disabled' } }],
    ['minimax', 'MiniMax-M3', 'high', { thinking: { type: 'adaptive' } }],
    ['xiaomimimo', 'mimo-v2.5-pro', 'none', { thinking: { type: 'disabled' } }],
    ['xiaomimimo', 'mimo-v2.5-pro', 'high', { thinking: { type: 'enabled' } }],
    ['deepseek', 'deepseek-v4-pro', 'none', { thinking: { type: 'disabled' } }],
    [
      'deepseek',
      'deepseek-v4-pro',
      'max',
      { reasoningEffort: 'max', thinking: { type: 'enabled' } }
    ],
    ['openrouter', 'qwen/qwen3.7-max', 'none', { reasoning: { enabled: false } }],
    ['openrouter', 'openai/gpt-5.5', 'high', { reasoning: { effort: 'high' } }]
  ] as const)(
    'encodes %s model %s effort %s with its provider-native options',
    (vendorId, model, reasoningEffort, expected) => {
      const config = opencodeFramework.prepareModelConfig(
        {
          type: 'custom',
          vendorId,
          baseUrl: 'https://gw.example/anthropic',
          openaiBaseUrl: 'https://gw.example/v1',
          apiEndpoints: ['anthropic', 'openai'],
          model,
          key: 'k'
        },
        { storageRoot: '/data', executablePath: '/bin/opencode', reasoningEffort }
      )

      const fileConfig = JSON.parse(
        config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
      )
      const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

      expect(fileConfig.provider['openai-compatible'].models[model].options).toEqual(expected)
      expect(content.provider['openai-compatible'].models[model].options).toEqual(expected)
    }
  )

  it('uses an explicit custom-provider transport without guessing from its URL or model', () => {
    const config = opencodeFramework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'https://private-gateway.example/v1',
        apiEndpoints: ['openai'],
        model: 'private-model',
        key: 'k',
        reasoningEffortTransport: 'deepseek'
      },
      { storageRoot: '/data', executablePath: '/bin/opencode', reasoningEffort: 'none' }
    )

    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    expect(content.provider['openai-compatible'].models['private-model'].options).toEqual({
      thinking: { type: 'disabled' }
    })
  })

  it('leaves the model block empty when no reasoning effort is set', () => {
    const config = opencodeFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/opencode' }
    )

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const content = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    expect(fileConfig.provider.anthropic.models).toEqual({ m: {} })
    expect(content.provider.anthropic.models).toEqual({ m: {} })
  })

  it('registers every same-route provider model so ACP can switch without a respawn', () => {
    const activeProvider = {
      type: 'official' as const,
      vendorId: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      apiEndpoints: ['anthropic' as const],
      model: 'deepseek-v4-pro',
      contextWindow: 128_000,
      key: 'k'
    }
    const config = opencodeFramework.prepareModelConfig(activeProvider, {
      storageRoot: '/data',
      executablePath: '/bin/opencode',
      reasoningEffort: 'high',
      providerModelCatalog: [
        { provider: activeProvider, reasoningEffort: 'high' },
        {
          provider: {
            ...activeProvider,
            model: 'deepseek-v3.2',
            contextWindow: 64_000,
            supportsImageInput: true
          },
          reasoningEffort: 'low'
        }
      ]
    })

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const pinnedConfig = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const expectedModels = {
      'deepseek-v4-pro': {
        options: { reasoningEffort: 'high', thinking: { type: 'enabled' } },
        limit: { context: 128_000 }
      },
      'deepseek-v3.2': {
        attachment: true,
        modalities: { input: ['text', 'image'] },
        options: { reasoningEffort: 'low', thinking: { type: 'enabled' } },
        limit: { context: 64_000 }
      }
    }

    expect(fileConfig.model).toBe('anthropic/deepseek-v4-pro')
    expect(fileConfig.provider.anthropic.models).toEqual(expectedModels)
    expect(pinnedConfig.provider.anthropic.models).toEqual(expectedModels)
  })

  it('registers immutable provider/model routes with separate local credentials', () => {
    const activeProvider = {
      type: 'custom' as const,
      agentProviderId: 'open-science-a',
      baseUrl: 'http://127.0.0.1:41001/v1',
      apiEndpoints: ['openai' as const],
      model: 'model-a',
      key: 'local-token-a'
    }
    const secondProvider = {
      type: 'custom' as const,
      agentProviderId: 'open-science-b',
      baseUrl: 'http://127.0.0.1:41002/v1',
      apiEndpoints: ['openai' as const],
      model: 'model-b',
      key: 'local-token-b'
    }
    const config = opencodeFramework.prepareModelConfig(activeProvider, {
      storageRoot: '/data',
      executablePath: '/bin/opencode',
      providerModelCatalog: [{ provider: activeProvider }, { provider: secondProvider }]
    })

    const fileConfig = JSON.parse(
      config.configFiles?.find((file) => file.path.endsWith('opencode.json'))?.content ?? '{}'
    )
    const pinnedConfig = JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')

    expect(config.sessionModel).toBe('open-science-a/model-a')
    expect(fileConfig.model).toBe('open-science-a/model-a')
    expect(Object.keys(fileConfig.provider)).toEqual(['open-science-a', 'open-science-b'])
    expect(fileConfig.provider['open-science-a'].options).toEqual({
      baseURL: 'http://127.0.0.1:41001/v1',
      apiKey: '{env:OPENCODE_APP_API_KEY_OPEN_SCIENCE_A}'
    })
    expect(fileConfig.provider['open-science-b'].options).toEqual({
      baseURL: 'http://127.0.0.1:41002/v1',
      apiKey: '{env:OPENCODE_APP_API_KEY_OPEN_SCIENCE_B}'
    })
    expect(fileConfig.provider['open-science-a'].models).toEqual({ 'model-a': {} })
    expect(fileConfig.provider['open-science-b'].models).toEqual({ 'model-b': {} })
    expect(pinnedConfig.provider).toEqual(fileConfig.provider)
    expect(config.env?.OPENCODE_APP_API_KEY_OPEN_SCIENCE_A).toBe('local-token-a')
    expect(config.env?.OPENCODE_APP_API_KEY_OPEN_SCIENCE_B).toBe('local-token-b')
  })
})

describe('buildOpencodeConfig', () => {
  it('registers the model under provider.models and selects it', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example/v1',
        model: 'deepseek-v4-pro',
        key: 'sk-secret',
        inputLimit: 128_000
      })
    )

    // A non-catalog model id is both selected and registered, so opencode treats it as a real model
    // instead of ignoring it and falling back to its own default.
    expect(config.model).toBe('anthropic/deepseek-v4-pro')
    expect(config.provider.anthropic.models).toEqual({
      'deepseek-v4-pro': { limit: { input: 128_000 } }
    })
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

  it('replaces stale app-generated model limits without preserving an output cap', () => {
    const config = JSON.parse(
      buildOpencodeConfig(
        {
          type: 'custom',
          baseUrl: 'https://gw.example/v1',
          model: 'deepseek-v4-pro',
          inputLimit: 64_000
        },
        {
          provider: {
            anthropic: {
              models: {
                'deepseek-v4-pro': {
                  limit: { context: 128_000, output: 32_000 }
                }
              }
            }
          }
        }
      )
    )

    expect(config.provider.anthropic.models['deepseek-v4-pro'].limit).toEqual({
      input: 64_000
    })
  })

  it('omits apiKey entirely when the provider carries no key', () => {
    const config = JSON.parse(
      buildOpencodeConfig({ type: 'custom', baseUrl: 'https://gw/v1', model: 'm' })
    )
    expect(config.provider.anthropic.options.apiKey).toBeUndefined()
  })

  it('pins sensitive built-in tools to ask and disables native task delegation', () => {
    const config = JSON.parse(
      buildOpencodeConfig(
        { type: 'custom', baseUrl: 'https://gw/v1', model: 'm' },
        { permission: { edit: 'allow', bash: 'allow', task: 'allow' } }
      )
    )

    // Our rules override the base for every side-effecting built-in.
    for (const tool of ['edit', 'bash', 'webfetch', 'websearch', 'external_directory']) {
      expect(config.permission[tool]).toBe('ask')
    }
    expect(config.permission.task).toBe('deny')
    expect(config.agent).toEqual({
      general: { disable: true },
      explore: { disable: true },
      scout: { disable: true }
    })
    expect(config.permission.skill).toBe('allow')
  })

  it('delegates every side-effecting tool (incl. MCP) via a "*" catch-all, allowing safe reads', () => {
    // Without the "*" rule, opencode keys permissions by tool name and MCP/websearch/task tools are
    // unmatched → run silently. The wildcard forces them to prompt; read-only tools stay allow.
    const config = JSON.parse(
      buildOpencodeConfig({ type: 'custom', baseUrl: 'https://gw/v1', model: 'm' })
    )

    expect(config.permission['*']).toBe('ask')
    // Safe read-only tools run without prompting (parity with Claude's Ask mode).
    for (const tool of ['read', 'glob', 'grep', 'list', 'lsp', 'skill']) {
      expect(config.permission[tool]).toBe('allow')
    }
    // Mutating/external tools are pinned to ask (and unlisted MCP tools fall through to "*" → ask).
    expect(config.permission.edit).toBe('ask')
    expect(config.permission.bash).toBe('ask')
    expect(config.permission.task).toBe('deny')
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
        apiEndpoints: ['openai']
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
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'm',
        apiEndpoints: ['anthropic', 'openai']
      })
    )
    expect(both.model).toBe('openai-compatible/m')
  })

  it('declares image capability on the model when it supports image input', () => {
    // opencode strips image parts for a registered model that does not advertise vision, so a
    // multimodal model must carry the attachment capability and an image input modality.
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'kimi-k3',
        key: 'k',
        apiEndpoints: ['openai'],
        supportsImageInput: true
      })
    )

    expect(config.provider['openai-compatible'].models).toEqual({
      'kimi-k3': { attachment: true, modalities: { input: ['text', 'image'] } }
    })
  })

  it('leaves a text-only model without image capability', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw/v1',
        model: 'deepseek-v4-flash',
        key: 'k',
        apiEndpoints: ['openai'],
        supportsImageInput: false
      })
    )

    expect(config.provider['openai-compatible'].models).toEqual({ 'deepseek-v4-flash': {} })
  })

  it('declares the reasoning effort passed as the fourth argument on the model', () => {
    const config = JSON.parse(
      buildOpencodeConfig(
        { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
        {},
        [],
        'medium'
      )
    )

    expect(config.provider.anthropic.models).toEqual({
      m: { options: { reasoningEffort: 'medium' } }
    })
  })

  it('uses the OpenAI base for a dual-endpoint vendor, not its Anthropic base (DeepSeek)', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://api.deepseek.com/anthropic',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
        key: 'sk-ds',
        apiEndpoints: ['anthropic', 'openai']
      })
    )

    // 'both' → OpenAI on opencode, pointed at the vendor's exact OpenAI base (the
    // @ai-sdk/openai-compatible client appends /chat/completions), not the /anthropic route.
    expect(config.model).toBe('openai-compatible/deepseek-v4-pro')
    expect(config.provider['openai-compatible'].options.baseURL).toBe('https://api.deepseek.com/v1')
  })

  it('points a GLM dual-endpoint vendor at its verbatim OpenAI base (/api/paas/v4, not /v1)', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://api.z.ai/api/anthropic',
        openaiBaseUrl: 'https://api.z.ai/api/paas/v4',
        model: 'glm-5.2',
        key: 'k',
        apiEndpoints: ['anthropic', 'openai']
      })
    )

    // 'both' → OpenAI on opencode. The @ai-sdk/openai-compatible client appends /chat/completions to
    // baseURL, so it must be the vendor's exact versioned base — not a hard-coded /v1.
    expect(config.model).toBe('openai-compatible/glm-5.2')
    expect(config.provider['openai-compatible'].options.baseURL).toBe(
      'https://api.z.ai/api/paas/v4'
    )
  })

  it('normalizes a custom OpenAI root-with-path to <root>/v1', () => {
    const config = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://host/proxy',
        model: 'm',
        apiEndpoints: ['openai']
      })
    )

    expect(config.provider['openai-compatible'].options.baseURL).toBe('https://host/proxy/v1')
  })

  it('normalizes a custom OpenAI base to end at /v1 (no doubling)', () => {
    const rooted = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example',
        model: 'm',
        apiEndpoints: ['openai']
      })
    )
    expect(rooted.provider['openai-compatible'].options.baseURL).toBe('https://gw.example/v1')

    const withV1 = JSON.parse(
      buildOpencodeConfig({
        type: 'custom',
        baseUrl: 'https://gw.example/v1',
        model: 'm',
        apiEndpoints: ['openai']
      })
    )
    expect(withV1.provider['openai-compatible'].options.baseURL).toBe('https://gw.example/v1')
  })

  it('omits model + models registration when the provider has no model', () => {
    const config = JSON.parse(buildOpencodeConfig({ type: 'custom' }))

    expect(config.model).toBeUndefined()
    expect(config.provider.anthropic.models).toBeUndefined()
    expect(config.provider.anthropic.options).toEqual({})
  })
})
