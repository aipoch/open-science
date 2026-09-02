import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CODEX_BRIDGE_MODEL,
  buildCodexConfig,
  createCodexFramework,
  isOfficialOpenAiResponsesBase,
  normalizeResponsesBaseUrl
} from './codex'
import codexNativeModelInstructions from './codex-native-model-instructions.md?raw'
import { terminateProcessTree } from '../process-tree'
import { CODEX_VERSION } from '../settings/managed-codex'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'

const fakeChild = {} as ChildProcessWithoutNullStreams

describe('codexFramework', () => {
  it.runIf(process.platform !== 'win32')(
    'reaps a descendant that leaves the owned ACP process group while its leader is alive',
    async () => {
      const framework = createCodexFramework()
      const child = framework.spawn({
        executablePath: process.execPath,
        env: {},
        args: [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { detached: true, stdio: 'ignore' })",
            'process.stdout.write(`${descendant.pid}\\n`)',
            'setInterval(() => undefined, 1_000)'
          ].join('\n')
        ]
      })
      let descendantPid: number | undefined

      try {
        expect(child.pid).toBeTypeOf('number')
        descendantPid = Number((await once(child.stdout, 'data'))[0].toString().trim())
        expect(descendantPid).toBeGreaterThan(0)

        const childProcessGroup = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()
        )
        const descendantProcessGroup = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(descendantPid)], {
            encoding: 'utf8'
          }).trim()
        )
        expect(descendantProcessGroup).toBe(descendantPid)
        expect(descendantProcessGroup).not.toBe(childProcessGroup)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        expect(() => process.kill(descendantPid as number, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, 'SIGKILL')
          } catch {
            // The process-tree teardown already reaped it.
          }
        }
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'reaps the owned ACP process group after its leader exits and its grandchild is reparented',
    async () => {
      const framework = createCodexFramework()
      const child = framework.spawn({
        executablePath: process.execPath,
        env: {},
        args: [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { stdio: 'ignore' })",
            'process.stdout.write(`${grandchild.pid}\\n`, () => process.exit(0))'
          ].join('\n')
        ]
      })
      let grandchildPid: number | undefined

      try {
        expect(child.pid).toBeTypeOf('number')
        const childProcessGroup = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], {
            encoding: 'utf8'
          }).trim()
        )
        const applicationProcessGroup = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
            encoding: 'utf8'
          }).trim()
        )

        expect(childProcessGroup).not.toBe(applicationProcessGroup)
        expect(childProcessGroup).toBe(child.pid)

        const leaderExited = once(child, 'exit')
        grandchildPid = Number((await once(child.stdout, 'data'))[0].toString().trim())
        expect(grandchildPid).toBeGreaterThan(0)
        await leaderExited
        expect(() => process.kill(grandchildPid as number, 0)).not.toThrow()

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        expect(() => process.kill(grandchildPid as number, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {
            // The owned process-group teardown already reaped it.
          }
        }
      }
    }
  )

  it('projects subscription authentication into a Windows delegated runtime home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-delegated-subscription-'))
    const sourceHome = join(root, 'subscription')
    const runtimeHome = join(root, 'runtime')
    await mkdir(sourceHome, { recursive: true })
    await writeFile(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}\n')
    await writeFile(
      join(sourceHome, 'config.toml'),
      [
        'model_provider = "subscription-route"',
        '',
        '[model_providers."subscription-route"]',
        'name = "Subscription route"',
        'base_url = "http://127.0.0.1:43123/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
        '[mcp_servers.persisted-tool]',
        'command = "unsafe-tool"',
        ''
      ].join('\n')
    )

    try {
      const framework = createCodexFramework({ platform: 'win32' })
      const prepared = await framework.prepareDelegatedSpawn!(
        {
          framework,
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          executablePath: '/runtime/codex-acp.exe',
          env: { CODEX_HOME: sourceHome }
        },
        runtimeHome
      )

      expect(prepared.env).toMatchObject({
        HOME: runtimeHome,
        USERPROFILE: runtimeHome,
        CODEX_HOME: runtimeHome
      })
      expect(await readFile(join(runtimeHome, 'auth.json'), 'utf8')).toContain('secret')
      const configToml = await readFile(join(runtimeHome, 'config.toml'), 'utf8')
      expect(configToml).toContain('cli_auth_credentials_store = "file"')
      expect(configToml).toContain('model_provider = "subscription-route"')
      expect(configToml).not.toContain('mcp_servers')
      expect(configToml).not.toContain('unsafe-tool')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['https', 'open-science-chatgpt-https', false],
    ['websocket', 'open-science-chatgpt-websocket', true]
  ] as const)(
    'projects the resolved %s subscription transport into a delegated runtime home',
    async (codexSubscriptionTransport, providerId, supportsWebsockets) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-delegated-transport-'))
      const sourceHome = join(root, 'subscription')
      const runtimeHome = join(root, 'runtime')
      await mkdir(sourceHome, { recursive: true })
      await writeFile(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}\n')
      // This is the app-owned non-loopback route used by subscription sessions. It is deliberately
      // not imported as an arbitrary provider route; the trusted resolved transport below owns it.
      await writeFile(
        join(sourceHome, 'config.toml'),
        [
          'model_provider = "open-science-chatgpt-https"',
          '',
          '[model_providers."open-science-chatgpt-https"]',
          'name = "OpenAI HTTPS"',
          'base_url = "https://chatgpt.com/backend-api/codex"',
          'wire_api = "responses"',
          'requires_openai_auth = true',
          'supports_websockets = false',
          ''
        ].join('\n')
      )

      try {
        const framework = createCodexFramework({ platform: 'darwin' })
        await framework.prepareDelegatedSpawn!(
          {
            framework,
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            codexSubscriptionTransport,
            executablePath: '/runtime/codex-acp',
            env: { CODEX_HOME: sourceHome }
          },
          runtimeHome
        )

        const configToml = await readFile(join(runtimeHome, 'config.toml'), 'utf8')
        expect(configToml).toContain(`model_provider = "${providerId}"`)
        expect(configToml).toContain('base_url = "https://chatgpt.com/backend-api/codex"')
        expect(configToml).toContain(`supports_websockets = ${String(supportsWebsockets)}`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('does not copy stale subscription authentication for an API-key delegated backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-delegated-api-key-'))
    const sourceHome = join(root, 'shared-codex-home')
    const runtimeHome = join(root, 'runtime')
    await mkdir(sourceHome, { recursive: true })
    await writeFile(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"stale"}}\n')
    await writeFile(
      join(sourceHome, 'config.toml'),
      [
        'model_provider = "stale-subscription-route"',
        '',
        '[model_providers."stale-subscription-route"]',
        'name = "Stale route"',
        'base_url = "http://127.0.0.1:43123/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        ''
      ].join('\n')
    )

    try {
      const framework = createCodexFramework({ platform: 'darwin' })
      const prepared = await framework.prepareDelegatedSpawn!(
        {
          framework,
          providerId: 'api-key-provider',
          executablePath: '/runtime/codex-acp',
          env: { CODEX_HOME: sourceHome, CODEX_CONFIG: '{"model":"gpt-5.4"}' }
        },
        runtimeHome
      )

      expect(prepared.env.CODEX_HOME).toBe(runtimeHome)
      expect(existsSync(join(runtimeHome, 'auth.json'))).toBe(false)
      expect(await readFile(join(runtimeHome, 'config.toml'), 'utf8')).toBe(
        'cli_auth_credentials_store = "ephemeral"\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('describes the base role as a general agent instead of narrowing every task to coding', () => {
    expect(codexNativeModelInstructions).toContain('You are an agent')
    expect(codexNativeModelInstructions).not.toContain('coding agent')
  })

  it('disables native multi-agent, Shell, and memory across every backend route', () => {
    const framework = createCodexFramework()
    const configurations = [
      framework.prepareModelConfig(
        {
          type: 'official',
          vendorId: 'openai',
          apiEndpoints: ['responses'],
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
          key: 'secret'
        },
        { storageRoot: '/data/official', executablePath: '/runtime/codex-acp' }
      ),
      framework.prepareModelConfig(
        {
          type: 'custom',
          apiEndpoints: ['responses'],
          baseUrl: 'https://gateway.example/v1',
          model: 'custom-responses',
          key: 'secret'
        },
        { storageRoot: '/data/custom', executablePath: '/runtime/codex-acp' }
      ),
      framework.prepareModelConfig(
        {
          type: 'custom',
          apiEndpoints: ['openai'],
          baseUrl: 'https://gateway.example/v1',
          model: 'chat-model',
          key: 'secret'
        },
        {
          storageRoot: '/data/bridge',
          executablePath: '/runtime/codex-acp',
          responsesBridge: { baseUrl: 'http://127.0.0.1:43123/v1', token: 'local-token' }
        }
      ),
      framework.prepareModelConfig(
        {
          type: 'custom',
          apiEndpoints: ['responses'],
          baseUrl: 'https://gateway.example/v1',
          model: 'compatibility-model',
          key: 'secret'
        },
        {
          storageRoot: '/data/compatibility',
          executablePath: '/runtime/codex-acp',
          responsesBridge: {
            baseUrl: 'http://127.0.0.1:43124/v1',
            token: 'local-token',
            kind: 'responses-compatibility'
          }
        }
      ),
      framework.prepareModelConfig(
        { type: 'codex-shared', model: 'gpt-5.4' },
        { storageRoot: '/data/shared', executablePath: '/runtime/codex-acp' }
      ),
      framework.prepareModelConfig(
        { type: 'codex-isolated', model: 'gpt-5.4' },
        { storageRoot: '/data/subscription', executablePath: '/runtime/codex-acp' }
      )
    ]

    const codexConfigs = configurations.map(({ env }) => JSON.parse(env?.CODEX_CONFIG ?? '{}'))

    expect(codexConfigs.map(({ features }) => features)).toEqual(
      configurations.map(() => ({
        memories: false,
        multi_agent: false,
        multi_agent_v2: false,
        shell_tool: false
      }))
    )
    expect(codexConfigs.map(({ memories }) => memories)).toEqual(
      configurations.map(() => ({ generate_memories: false, use_memories: false }))
    )
  })

  it.each([
    ['darwin', 'posix'],
    ['win32', 'powershell']
  ] as const)('reports the %s command shell as %s', (platform, shellDialect) => {
    expect(createCodexFramework({ platform }).commandShellDialect).toBe(shellDialect)
  })

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
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        nativeVersion: CODEX_VERSION
      }
    )

    expect(config.env).toMatchObject({
      HOME: join('/data', 'codex'),
      CODEX_HOME: join('/data', 'codex'),
      MODEL_PROVIDER: 'open-science',
      NO_BROWSER: '1'
    })
    expect(config.env?.CODEX_API_KEY).toBeUndefined()
    expect(config.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'sk-plaintext-secret' } }
    })
    expect(config.configFiles?.[0]).toEqual({
      path: join('/data', 'codex', 'config.toml'),
      content: 'cli_auth_credentials_store = "ephemeral"\n',
      mode: 0o600
    })
    const modelCatalogFile = config.configFiles?.[1]
    expect(modelCatalogFile).toMatchObject({
      path: expect.stringMatching(/[/\\]codex[/\\]model-catalog-[a-f0-9]{64}\.json$/),
      mode: 0o600,
      contentAddressed: true
    })

    const serialized = config.env?.CODEX_CONFIG ?? ''
    expect(serialized).not.toContain('sk-plaintext-secret')
    expect(JSON.parse(serialized)).toMatchObject({
      model: 'gpt-coding',
      model_provider: 'open-science',
      model_catalog_json: modelCatalogFile?.path,
      model_providers: {
        'open-science': {
          base_url: 'https://gateway.example/v1',
          requires_openai_auth: true,
          wire_api: 'responses'
        }
      }
    })
  })

  it('keeps Codex bundled model metadata for a trusted official OpenAI model', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'official',
        vendorId: 'openai',
        apiEndpoints: ['responses'],
        baseUrl: 'https://gateway.example/v1',
        model: 'gpt-5.4',
        key: 'sk-plaintext-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        nativeVersion: CODEX_VERSION
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).not.toHaveProperty('model_catalog_json')
    expect(config.configFiles).toEqual([
      {
        path: join('/data', 'codex', 'config.toml'),
        content: 'cli_auth_credentials_store = "ephemeral"\n',
        mode: 0o600
      }
    ])
  })

  it('keeps bundled metadata for a custom Responses provider on the official OpenAI API host', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5.4',
        key: 'sk-plaintext-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        nativeVersion: CODEX_VERSION
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).not.toHaveProperty('model_catalog_json')
    expect(config.configFiles).toEqual([
      {
        path: join('/data', 'codex', 'config.toml'),
        content: 'cli_auth_credentials_store = "ephemeral"\n',
        mode: 0o600
      }
    ])
  })

  it('uses conservative local metadata for an unrecognized native Codex version', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'official',
        vendorId: 'openai',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        key: 'sk-plaintext-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        nativeVersion: '0.144.2'
      }
    )

    const codexConfig = JSON.parse(config.env?.CODEX_CONFIG ?? '')
    const modelCatalogFile = config.configFiles?.find(
      (file) => file.path === codexConfig.model_catalog_json
    )

    expect(JSON.parse(modelCatalogFile?.content ?? '').models[0]).toMatchObject({
      slug: 'gpt-5.4',
      apply_patch_tool_type: null,
      supports_parallel_tool_calls: false,
      supports_search_tool: false
    })
    expect(JSON.parse(modelCatalogFile?.content ?? '').models[0]).not.toHaveProperty(
      'web_search_tool_type'
    )
  })

  it('uses conservative local metadata when a custom gateway reuses a bundled model slug', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://gateway.example/v1',
        model: 'gpt-5.4',
        key: 'sk-plaintext-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        nativeVersion: CODEX_VERSION
      }
    )

    const codexConfig = JSON.parse(config.env?.CODEX_CONFIG ?? '')
    const modelCatalogFile = config.configFiles?.find(
      (file) => file.path === codexConfig.model_catalog_json
    )
    const modelMetadata = JSON.parse(modelCatalogFile?.content ?? '').models[0]

    expect(modelMetadata).toMatchObject({
      slug: 'gpt-5.4',
      apply_patch_tool_type: null,
      supports_parallel_tool_calls: false,
      supports_search_tool: false
    })
    expect(modelMetadata).not.toHaveProperty('web_search_tool_type')
  })

  it('routes Chat Completions providers through the main-process Responses bridge', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['openai'],
        baseUrl: 'https://gateway.example/v1',
        model: 'chat-model',
        contextWindow: 128_000,
        key: 'upstream-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        responsesBridge: { baseUrl: 'http://127.0.0.1:43123/v1', token: 'local-token' },
        systemPromptAppends: ['Stable bridge guidance.']
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
      model: CODEX_BRIDGE_MODEL,
      developer_instructions: 'Stable bridge guidance.',
      model_context_window: 128_000,
      model_auto_compact_token_limit: 121_600,
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
      providerId: 'openai',
      apiType: 'openai',
      baseUrl: 'http://127.0.0.1:43123/v1',
      headers: { authorization: 'Bearer local-token' }
    })
    expect(config.env?.CODEX_CONFIG).not.toContain('upstream-secret')
    expect(config.persistentSystemPrompt).toBe('Stable bridge guidance.')
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
        contextWindow: 1_000_000,
        key: 'mm-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        reasoningEffort: 'none',
        reasoningEfforts: ['none', 'high'],
        responsesBridge: { baseUrl: 'http://127.0.0.1:43123/v1', token: 'local-token' }
      }
    )

    const codexConfig = JSON.parse(config.env?.CODEX_CONFIG ?? '')
    expect(codexConfig).toMatchObject({
      model: 'MiniMax-M3',
      model_reasoning_effort: 'none',
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 950_000,
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

    const modelCatalogFile = config.configFiles?.find(
      (file) => file.path === codexConfig.model_catalog_json
    )
    expect(modelCatalogFile).toMatchObject({
      path: expect.stringMatching(/[/\\]codex[/\\]model-catalog-[a-f0-9]{64}\.json$/),
      mode: 0o600
    })
    expect(codexConfig.model_catalog_json).toBe(modelCatalogFile?.path)
    const modelCatalog = JSON.parse(modelCatalogFile?.content ?? '')
    expect(modelCatalog).toMatchObject({
      models: [
        {
          slug: 'MiniMax-M3',
          display_name: 'MiniMax-M3',
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          base_instructions: expect.stringContaining(
            'inside Open Science through the Agent Client Protocol'
          ),
          include_skills_usage_instructions: true,
          default_reasoning_level: 'none',
          supported_reasoning_levels: [
            { effort: 'none', description: 'None reasoning effort' },
            { effort: 'high', description: 'High reasoning effort' }
          ],
          apply_patch_tool_type: null,
          supports_parallel_tool_calls: false,
          supports_image_detail_original: false,
          context_window: 1_000_000,
          max_context_window: 1_000_000,
          input_modalities: ['text'],
          supports_search_tool: false,
          use_responses_lite: false
        }
      ]
    })
    expect(modelCatalog.models[0]).not.toHaveProperty('web_search_tool_type')
    expect(modelCatalogFile?.content).not.toContain('used_fallback_model_metadata')
    expect(modelCatalog.models[0].base_instructions).not.toContain('update_plan')
    expect(modelCatalog.models[0].base_instructions).not.toContain('apply_patch')
  })

  it('preserves native model metadata through the Responses compatibility proxy', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        contextWindow: 1_000_000,
        key: 'mm-secret'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        responsesBridge: {
          baseUrl: 'http://127.0.0.1:43123/v1',
          token: 'local-token',
          kind: 'responses-compatibility'
        }
      }
    )

    const codexConfig = JSON.parse(config.env?.CODEX_CONFIG ?? '')
    expect(codexConfig).toMatchObject({
      model: 'MiniMax-M3',
      model_provider: 'open-science',
      model_providers: {
        'open-science': {
          base_url: 'http://127.0.0.1:43123/v1',
          wire_api: 'responses'
        }
      },
      model_catalog_json: expect.stringMatching(/model-catalog-[a-f0-9]{64}\.json$/)
    })
    expect(codexConfig.model_providers['open-science']).not.toHaveProperty('requires_openai_auth')
    expect(config.authentication).toBeUndefined()
    expect(config.sessionModel).toBeUndefined()
    expect(config.providerConfiguration).toEqual({
      providerId: 'openai',
      apiType: 'openai',
      baseUrl: 'http://127.0.0.1:43123/v1',
      headers: { authorization: 'Bearer local-token' }
    })
    expect(config.env?.CODEX_CONFIG).not.toContain('mm-secret')
    const modelCatalogFile = config.configFiles?.find(
      (file) => file.path === codexConfig.model_catalog_json
    )
    expect(JSON.parse(modelCatalogFile?.content ?? '').models[0].slug).toBe('MiniMax-M3')
  })

  it('keeps concurrent native model metadata in distinct immutable catalogs', () => {
    const framework = createCodexFramework()
    const prepare = (model: string): ReturnType<typeof framework.prepareModelConfig> =>
      framework.prepareModelConfig(
        {
          type: 'custom',
          apiEndpoints: ['responses'],
          baseUrl: 'https://gateway.example/v1',
          model,
          key: 'secret'
        },
        { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
      )

    const first = prepare('vendor-model-a')
    const second = prepare('vendor-model-b')
    const firstCatalog = first.configFiles?.[1]
    const secondCatalog = second.configFiles?.[1]

    expect(firstCatalog?.path).not.toBe(secondCatalog?.path)
    expect(JSON.parse(firstCatalog?.content ?? '').models[0].slug).toBe('vendor-model-a')
    expect(JSON.parse(secondCatalog?.content ?? '').models[0].slug).toBe('vendor-model-b')
    expect(JSON.parse(first.env?.CODEX_CONFIG ?? '').model_catalog_json).toBe(firstCatalog?.path)
    expect(JSON.parse(second.env?.CODEX_CONFIG ?? '').model_catalog_json).toBe(secondCatalog?.path)
  })

  it('advertises every same-route native model in one catalog for live ACP switching', () => {
    const framework = createCodexFramework()
    const activeProvider = {
      type: 'custom' as const,
      apiEndpoints: ['responses' as const],
      baseUrl: 'https://gateway.example/v1',
      model: 'vendor-model-a',
      contextWindow: 128_000,
      key: 'secret'
    }
    const config = framework.prepareModelConfig(activeProvider, {
      storageRoot: '/data',
      executablePath: '/runtime/codex-acp',
      providerModelCatalog: [
        {
          provider: activeProvider,
          reasoningEffort: 'high',
          reasoningEfforts: ['low', 'high']
        },
        {
          provider: {
            ...activeProvider,
            model: 'vendor-model-b',
            contextWindow: 64_000,
            supportsImageInput: true
          },
          reasoningEffort: 'low',
          reasoningEfforts: ['low', 'medium']
        }
      ]
    })

    const codexConfig = JSON.parse(config.env?.CODEX_CONFIG ?? '')
    const modelCatalogFile = config.configFiles?.find(
      (file) => file.path === codexConfig.model_catalog_json
    )
    const models = JSON.parse(modelCatalogFile?.content ?? '').models

    expect(models.map(({ slug }: { slug: string }) => slug)).toEqual([
      'vendor-model-a',
      'vendor-model-b'
    ])
    expect(models[0]).toMatchObject({
      default_reasoning_level: 'high',
      context_window: 128_000,
      input_modalities: ['text']
    })
    expect(models[1]).toMatchObject({
      default_reasoning_level: 'low',
      context_window: 64_000,
      input_modalities: ['text', 'image']
    })
  })

  it('maps the legacy shared subscription to the app-owned subscription home', () => {
    const framework = createCodexFramework({ platform: 'darwin' })
    const config = framework.prepareModelConfig(
      { type: 'codex-shared', apiEndpoints: ['responses'] },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config).toEqual({
      env: {
        HOME: join('/data', 'codex-subscription'),
        CODEX_HOME: join('/data', 'codex-subscription'),
        CODEX_CONFIG: JSON.stringify({
          features: {
            memories: false,
            multi_agent: false,
            multi_agent_v2: false,
            shell_tool: false
          },
          memories: { generate_memories: false, use_memories: false }
        })
      }
    })
  })

  it('uses persistent app-owned storage for an isolated Codex subscription', () => {
    const framework = createCodexFramework({ platform: 'darwin' })
    const config = framework.prepareModelConfig(
      { type: 'codex-isolated', apiEndpoints: ['responses'] },
      { storageRoot: '/data', executablePath: '/runtime/codex-acp' }
    )

    expect(config).toEqual({
      env: {
        HOME: join('/data', 'codex-subscription'),
        CODEX_HOME: join('/data', 'codex-subscription'),
        CODEX_CONFIG: JSON.stringify({
          features: {
            memories: false,
            multi_agent: false,
            multi_agent_v2: false,
            shell_tool: false
          },
          memories: { generate_memories: false, use_memories: false }
        })
      }
    })
  })

  it('isolates the native Windows home used for user-installed Skills', () => {
    const framework = createCodexFramework({ platform: 'win32' })
    const config = framework.prepareModelConfig(
      { type: 'codex-isolated', apiEndpoints: ['responses'] },
      { storageRoot: 'C:\\OpenScience', executablePath: 'C:\\runtime\\codex-acp.exe' }
    )

    expect(config.env).toMatchObject({
      HOME: join('C:\\OpenScience', 'codex-subscription'),
      USERPROFILE: join('C:\\OpenScience', 'codex-subscription'),
      CODEX_HOME: join('C:\\OpenScience', 'codex-subscription')
    })
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
    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({ model: 'gpt-5.6-terra' })
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

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
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

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '')).toMatchObject({
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

  it.each([
    ['https://api.openai.com', true],
    ['https://API.OPENAI.COM/v1/responses', true],
    ['https://api.openai.com.proxy.example/v1', false],
    ['https://openai.com/v1', false],
    ['not a URL', false],
    [undefined, false]
  ])('classifies %s as an official OpenAI Responses base: %s', (input, expected) => {
    expect(isOfficialOpenAiResponsesBase(input)).toBe(expected)
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

  it('delivers Open Science session guidance as persistent developer instructions', () => {
    const framework = createCodexFramework()

    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6-sol'
      },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        systemPromptAppends: ['one', 'two']
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '{}').developer_instructions).toBe('one\n\ntwo')
    expect(config.persistentSystemPrompt).toBe('one\n\ntwo')
    expect(
      framework.buildSessionSetup({
        systemPromptAppends: [],
        turnPromptReminders: ['turn-only reminder']
      })
    ).toEqual({
      promptPrefix: 'turn-only reminder'
    })
  })

  it('persists app guidance for a subscription backend', () => {
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      { type: 'codex-isolated', apiEndpoints: ['responses'], model: 'gpt-5.6-terra' },
      {
        storageRoot: '/data',
        executablePath: '/runtime/codex-acp',
        systemPromptAppends: ['Stable subscription guidance.']
      }
    )

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '{}')).toMatchObject({
      model: 'gpt-5.6-terra',
      developer_instructions: 'Stable subscription guidance.'
    })
    expect(config.persistentSystemPrompt).toBe('Stable subscription guidance.')
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
        detached: true,
        shell: false,
        stdio: 'pipe',
        windowsHide: true
      })
    )
  })

  it('does not request a detached Windows console for the ACP process', () => {
    const spawnProcess = vi.fn().mockReturnValue(fakeChild)
    const framework = createCodexFramework({ platform: 'win32', spawnProcess })

    framework.spawn({ executablePath: 'C:\\codex-acp.exe', env: {}, args: [] })

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\codex-acp.exe',
      [],
      expect.objectContaining({ detached: false })
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

  it('replaces every inherited proxy shape for a subscription spawn', () => {
    const spawnProcess = vi.fn().mockReturnValue(fakeChild)
    const framework = createCodexFramework({
      sourceEnv: {
        PATH: '/parent-bin',
        ALL_PROXY: 'socks5://stale-proxy.example.test:9050',
        HTTPS_PROXY: 'http://stale-proxy.example.test:3128',
        NO_PROXY: 'stale-bypass.example.test'
      },
      spawnProcess
    })

    framework.spawn({
      executablePath: '/usr/local/bin/codex-acp',
      proxyEnvironmentMode: 'replace',
      env: {
        CODEX_HOME: '/data/codex-subscription',
        HTTP_PROXY: 'http://system-proxy.example.test:3128',
        HTTPS_PROXY: 'http://system-proxy.example.test:3128',
        NO_PROXY: 'localhost,127.0.0.1,::1'
      },
      args: []
    })

    const env = spawnProcess.mock.calls[0][2].env as NodeJS.ProcessEnv
    expect(env).toMatchObject({
      HTTP_PROXY: 'http://system-proxy.example.test:3128',
      HTTPS_PROXY: 'http://system-proxy.example.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.NO_PROXY).not.toContain('stale-bypass.example.test')

    framework.spawn({
      executablePath: '/usr/local/bin/codex-acp',
      proxyEnvironmentMode: 'replace',
      env: { CODEX_HOME: '/data/codex-subscription' },
      args: []
    })
    const directEnv = spawnProcess.mock.calls[1][2].env as NodeJS.ProcessEnv
    expect(directEnv.HTTP_PROXY).toBeUndefined()
    expect(directEnv.HTTPS_PROXY).toBeUndefined()
    expect(directEnv.ALL_PROXY).toBeUndefined()
    expect(directEnv.NO_PROXY).toBeUndefined()
  })

  it('preserves inherited proxies when subscription proxy resolution fails', () => {
    const spawnProcess = vi.fn().mockReturnValue(fakeChild)
    const framework = createCodexFramework({
      sourceEnv: {
        PATH: '/parent-bin',
        HTTPS_PROXY: 'http://inherited-proxy.example.test:3128',
        NO_PROXY: 'inherited-bypass.example.test'
      },
      spawnProcess
    })

    framework.spawn({
      executablePath: '/usr/local/bin/codex-acp',
      proxyEnvironmentMode: 'inherit',
      env: { CODEX_HOME: '/data/codex-subscription' },
      args: []
    })

    expect(spawnProcess.mock.calls[0][2].env).toMatchObject({
      HTTPS_PROXY: 'http://inherited-proxy.example.test:3128',
      NO_PROXY: 'inherited-bypass.example.test'
    })
  })
})

describe('buildCodexConfig reasoning effort', () => {
  it.each([
    ['none', 'none'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
    ['ultra', 'ultra']
  ] as const)('preserves the %s level as model_reasoning_effort %s', (effort, expected) => {
    expect(buildCodexConfig({ reasoningEffort: effort }).model_reasoning_effort).toBe(expected)
  })

  it('omits model_reasoning_effort when no model value is resolved', () => {
    expect(buildCodexConfig({ reasoningEffort: undefined })).not.toHaveProperty(
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

    expect(JSON.parse(config.env?.CODEX_CONFIG ?? '').model_reasoning_effort).toBe('max')
  })
})
