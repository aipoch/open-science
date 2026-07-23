import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CODEX_BRIDGE_MODEL,
  buildCodexConfig,
  createCodexFramework,
  normalizeResponsesBaseUrl
} from './codex'

const fakeChild = {} as ChildProcessWithoutNullStreams

describe('codexFramework', () => {
  it('configures an isolated Responses provider without serializing its key', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://gateway.example/v1/responses',
        model: 'gpt-coding',
        key: 'sk-plaintext-secret'
      },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config.env).toMatchObject({
      CODEX_HOME: join('/data', 'codex'),
      MODEL_PROVIDER: 'open-science',
      NO_BROWSER: '1'
    })
    expect(config.env?.CODEX_API_KEY).toBeUndefined()
    expect(config.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'sk-plaintext-secret' } }
    })
    expect(config.configFiles).toEqual([
      {
        path: join('/data', 'codex', 'config.toml'),
        content: 'cli_auth_credentials_store = "ephemeral"\n',
        mode: 0o600
      }
    ])

    const serialized = config.env?.CODEX_CONFIG ?? ''
    expect(serialized).not.toContain('sk-plaintext-secret')
    expect(JSON.parse(serialized)).toMatchObject({
      model: 'gpt-coding',
      model_provider: 'open-science',
      model_providers: {
        'open-science': {
          base_url: 'https://gateway.example/v1',
          requires_openai_auth: true,
          wire_api: 'responses'
        }
      }
    })
  })

  it('routes Chat Completions providers through the main-process Responses bridge', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        baseUrl: 'https://gateway.example/v1',
        model: 'chat-model',
        key: 'upstream-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        responsesBridge: { baseUrl: 'http://127.0.0.1:43123/v1', token: 'local-token' }
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
      model: CODEX_BRIDGE_MODEL,
      model_provider: 'open-science',
      model_providers: {
        'open-science': {
          base_url: 'http://127.0.0.1:43123/v1',
          wire_api: 'responses'
        }
      }
    })
    // The bridge aliases its app-owned namespaced notebook tools, so no Codex tool-deferral override
    // belongs in config.toml.
    expect(config.configFiles?.[0]?.content).toBe('cli_auth_credentials_store = "ephemeral"\n')
    expect(config.authentication).toBeUndefined()
    expect(config.sessionModel).toBe(CODEX_BRIDGE_MODEL)
    expect(config.providerConfiguration).toEqual({
      providerId: 'custom-gateway',
      apiType: 'openai',
      baseUrl: 'http://127.0.0.1:43123/v1',
      headers: { authorization: 'Bearer local-token' }
    })
    expect(config.env?.CODEX_CONFIG).not.toContain('upstream-secret')
  })

  it('drives a native-Responses vendor directly on its OpenAI /v1 base, ignoring the bridge', () => {
    const framework = createCodexFramework()
    // A dual-endpoint vendor (e.g. MiniMax) advertises openai + responses and keeps its Anthropic
    // route in baseUrl and its OpenAI/Responses /v1 root in openaiBaseUrl. Even if a bridge object
    // is present, native Responses must post to the vendor's own /v1 base with the vendor key.
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        baseUrl: 'https://api.minimaxi.com/anthropic',
        openaiBaseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        key: 'mm-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        responsesBridge: { baseUrl: 'http://127.0.0.1:43123/v1', token: 'local-token' }
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
      model: 'MiniMax-M3',
      model_providers: {
        'open-science': {
          base_url: 'https://api.minimaxi.com/v1',
          requires_openai_auth: true,
          wire_api: 'responses'
        }
      }
    })
    // Direct native path: vendor key auth, no bridge provider-configuration, no bridge model.
    expect(config.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'mm-secret' } }
    })
    expect(config.providerConfiguration).toBeUndefined()
    expect(config.sessionModel).toBeUndefined()
    expect(config.env?.CODEX_CONFIG).not.toContain('127.0.0.1:43123')
  })

  it('reuses the normal Codex profile for a shared subscription without overriding it', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      { type: 'codex-shared', apiEndpoints: ['responses'] },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config).toEqual({ env: {} })
  })

  it('uses persistent app-owned storage for an isolated Codex subscription', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      { type: 'codex-isolated', apiEndpoints: ['responses'] },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config).toEqual({ env: { CODEX_HOME: join('/data', 'codex-subscription') } })
  })

  it('seeds the selected model into CODEX_CONFIG for an isolated Codex subscription', () => {
    // Without a model here, codex-acp falls back to its account default and we have to switch the
    // model via session/set_config_option after session creation. The late switch makes the first
    // prompt of every new session wait ~2 min for the new model to come online (issue #277).
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'codex-isolated',
        apiEndpoints: ['responses'],
        model: 'gpt-5.6-terra'
      },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config.env?.CODEX_HOME).toBe(join('/data', 'codex-subscription'))
    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toEqual({ model: 'gpt-5.6-terra' })
  })

  it('seeds reasoning effort alongside the model for an isolated Codex subscription', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'codex-isolated',
        apiEndpoints: ['responses'],
        model: 'gpt-5.6-terra'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        reasoningEffort: 'high'
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toEqual({
      model: 'gpt-5.6-terra',
      model_reasoning_effort: 'high'
    })
  })

  it('seeds reasoning effort without a model for an isolated Codex subscription', () => {
    // No model picked but the user set an effort: still worth seeding so codex-acp does not have
    // to apply it via session/set_config_option (issue #277, same root cause as the model case).
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      { type: 'codex-isolated', apiEndpoints: ['responses'] },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        reasoningEffort: 'high'
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toEqual({
      model_reasoning_effort: 'high'
    })
  })

  it('does not add a custom model_provider for an isolated Codex subscription', () => {
    // The ChatGPT subscription is codex-acp's default provider; layering an open-science custom
    // provider on top would route the request through a gateway the user did not configure.
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'codex-isolated',
        apiEndpoints: ['responses'],
        model: 'gpt-5.6-terra'
      },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    const parsed = JSON.parse(config.env?.CODEX_CONFIG ?? '{}')
    expect(parsed).not.toHaveProperty('model_provider')
    expect(parsed).not.toHaveProperty('model_providers')
  })

  it.each([
    // Bare origins gain the `/v1` version segment Codex needs before `/responses`.
    ['https://api.openai.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com/v1'],
    // Anything already carrying a path is preserved, including `/v1` and custom gateway paths.
    ['http://127.0.0.1:5/v1', 'http://127.0.0.1:5/v1'],
    ['https://gw.example/foo', 'https://gw.example/foo'],
    // Trailing `/responses` (bare or under `/v1`) still collapses to the versioned root.
    ['https://api.openai.com/responses', 'https://api.openai.com/v1'],
    ['https://gateway.example/v1/responses', 'https://gateway.example/v1']
  ])('normalizes %s to %s for the Responses base URL', (input, expected) => {
    expect(normalizeResponsesBaseUrl(input)).toBe(expected)
  })

  it('appends /v1 to a bare official OpenAI base URL in the serialized Codex config', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5.6-sol',
        key: 'sk-plaintext-secret'
      },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
      model_providers: {
        'open-science': {
          base_url: 'https://api.openai.com/v1',
          wire_api: 'responses'
        }
      }
    })
  })

  it('delivers Open Science session guidance as a prompt prefix', () => {
    const framework = createCodexFramework()

    expect(framework.buildSessionSetup({ systemPromptAppends: ['one', 'two'] })).toEqual({
      promptPrefix: 'one\n\ntwo'
    })
  })

  it.each([
    ['ask', 'read-only'],
    ['auto', 'agent'],
    ['full', 'agent-full-access']
  ] as const)('maps the %s profile to Codex mode %s', (profile, modeId) => {
    const framework = createCodexFramework()
    const modes = {
      currentModeId: 'agent',
      availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
    }

    expect(framework.mapPermissionProfile(profile, modes)).toMatchObject({
      modeId,
      state: {
        selectedProfile: profile,
        effectiveProfile: profile,
        currentModeId: modeId,
        fullAccessAvailable: true
      }
    })
  })

  it('fails closed when Codex does not advertise the read-only mode required by Ask', () => {
    const framework = createCodexFramework()

    expect(() =>
      framework.mapPermissionProfile('ask', {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent', name: 'Agent' }]
      })
    ).toThrow(/not available: ask/i)
  })

  it('uses conservative review when Codex does not advertise its native Auto mode', () => {
    const framework = createCodexFramework()

    expect(
      framework.mapPermissionProfile('auto', {
        currentModeId: 'agent-full-access',
        availableModes: [
          { id: 'read-only', name: 'Read only' },
          { id: 'agent-full-access', name: 'Full access' }
        ]
      })
    ).toMatchObject({
      modeId: 'read-only',
      state: {
        effectiveProfile: 'auto',
        currentModeId: 'read-only',
        autoReviewStrategy: 'conservative'
      }
    })
  })

  it('runs an app-managed JavaScript adapter with Electron as Node', () => {
    const spawnProcess = vi.fn().mockReturnValue(fakeChild)
    const framework = createCodexFramework({
      execPath: '/Applications/Open Science/Electron',
      platform: 'darwin',
      spawnProcess
    })

    expect(
      framework.spawn({
        executablePath: '/data/codex-acp/dist/index.js',
        env: { CODEX_HOME: '/data/codex' },
        args: ['--flag']
      })
    ).toBe(fakeChild)
    expect(spawnProcess).toHaveBeenCalledWith(
      '/Applications/Open Science/Electron',
      ['/data/codex-acp/dist/index.js', '--flag'],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/data/codex',
          ELECTRON_RUN_AS_NODE: '1'
        }),
        shell: false,
        stdio: 'pipe',
        windowsHide: true
      })
    )
  })

  it('drops inherited Codex credentials and configuration before applying app-owned overrides', () => {
    const spawnProcess = vi.fn().mockReturnValue(fakeChild)
    const framework = createCodexFramework({
      sourceEnv: {
        PATH: '/isolated-parent-bin',
        OPENAI_API_KEY: 'inherited-openai-key',
        CODEX_API_KEY: 'inherited-codex-key',
        CODEX_PATH: '/untrusted/codex',
        CODEX_CONFIG: '{"untrusted":true}'
      },
      spawnProcess
    })

    framework.spawn({
      executablePath: '/usr/local/bin/codex-acp',
      env: {
        CODEX_HOME: '/data/codex',
        CODEX_API_KEY: 'app-key',
        CODEX_CONFIG: '{"app":true}'
      },
      args: []
    })

    const env = spawnProcess.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(env).toMatchObject({
      PATH: expect.stringContaining('/isolated-parent-bin'),
      CODEX_HOME: '/data/codex',
      CODEX_API_KEY: 'app-key',
      CODEX_CONFIG: '{"app":true}'
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_PATH).toBeUndefined()
  })
})

describe('buildCodexConfig reasoning effort', () => {
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    // Codex config tops out at xhigh; the app's top level 'max' maps onto it.
    ['max', 'xhigh']
  ] as const)('maps the %s level to model_reasoning_effort %s', (effort, expected) => {
    expect(buildCodexConfig({ reasoningEffort: effort }).model_reasoning_effort).toBe(expected)
  })

  it.each([undefined, 'default'] as const)('omits model_reasoning_effort for %s', (effort) => {
    expect(buildCodexConfig({ reasoningEffort: effort })).not.toHaveProperty(
      'model_reasoning_effort'
    )
  })

  it('threads the ctx level into the serialized CODEX_CONFIG env', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://gateway.example/v1',
        model: 'gpt-5',
        key: 'sk-plaintext-secret'
      },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp', reasoningEffort: 'max' }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '').model_reasoning_effort).toBe('xhigh')
  })
})
