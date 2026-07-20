import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import { CODEX_BRIDGE_MODEL, createCodexFramework, normalizeResponsesBaseUrl } from './codex'

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
      CODEX_HOME: '/data/codex',
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
        path: '/data/codex/config.toml',
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
