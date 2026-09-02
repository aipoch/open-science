import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  SKILL_RUNTIME_ALLOWED_NAMES_ENV,
  SKILL_RUNTIME_ROOT_ENV
} from '../skills/runtime-mcp-server'
import { createCodeBuddyFramework } from './codebuddy'

const provider = {
  type: 'custom' as const,
  baseUrl: 'https://gateway.example.test',
  model: 'test-model',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsImageInput: true,
  key: 'test-key',
  apiEndpoints: ['openai' as const]
}

describe('codebuddy framework', () => {
  it('starts ACP with isolated, login-free Chat Completions configuration', () => {
    const spawnProcess = vi.fn(() => ({}) as ChildProcessWithoutNullStreams)
    const framework = createCodeBuddyFramework({
      platform: 'linux',
      sourceEnv: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://inherited-proxy.example.test:3128',
        NO_PROXY: 'inherited-bypass.example.test'
      },
      spawnProcess
    })
    const storageRoot = '/app-data'
    const configDir = join(storageRoot, 'codebuddy')
    const config = framework.prepareModelConfig(provider, {
      storageRoot,
      executablePath: '/usr/bin/codebuddy',
      systemPromptAppends: ['APP GUIDANCE'],
      reasoningEfforts: ['none', 'high']
    })

    expect(config.env).toMatchObject({
      CODEBUDDY_CONFIG_DIR: configDir,
      CODEBUDDY_API_KEY: 'test-key',
      CODEBUDDY_BASE_URL: 'https://gateway.example.test/v1',
      CODEBUDDY_MODEL: 'test-model',
      OPEN_SCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL:
        'https://gateway.example.test/v1/chat/completions',
      CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      NO_BROWSER: '1'
    })
    expect(config.args).toEqual([
      '--strict-mcp-config',
      '--setting-sources',
      'user',
      '--tools',
      expect.not.stringMatching(/Agent|Skill|Workflow|Task|WebFetch|WebSearch|Bash/),
      '--disallowedTools',
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(aria2c:*)',
      'Bash(http:*)',
      'Bash(https:*)',
      'Bash(ftp:*)',
      'Bash(lftp:*)',
      'Bash(ssh:*)',
      'Bash(scp:*)',
      'Bash(sftp:*)',
      'Bash(telnet:*)',
      'Bash(nc:*)',
      'Bash(ncat:*)',
      'Bash(netcat:*)',
      'Bash(socat:*)',
      'Bash(rsync:*)',
      'Bash(git clone:*)',
      'Bash(git fetch:*)',
      'Bash(git pull:*)',
      'Bash(git push:*)',
      'Bash(git ls-remote:*)',
      'Bash(git submodule:*)',
      '--system-prompt-file',
      join(configDir, 'system-prompt.md')
    ])
    expect(config.configFiles).toEqual([
      {
        path: join(configDir, 'models.json'),
        mode: 0o600,
        content: `${JSON.stringify(
          {
            models: [
              {
                id: 'test-model',
                name: 'test-model',
                vendor: 'OpenAI-compatible',
                apiKey: '${CODEBUDDY_API_KEY}',
                maxInputTokens: 128_000,
                maxOutputTokens: 8_192,
                url: '${OPEN_SCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL}',
                supportsToolCall: true,
                supportsImages: true,
                supportsReasoning: true
              }
            ],
            availableModels: ['test-model']
          },
          null,
          2
        )}\n`
      },
      {
        path: join(configDir, 'settings.json'),
        mode: 0o600,
        content: `${JSON.stringify(
          {
            cleanupPeriodDays: 7,
            autoCompactEnabled: false,
            permissions: { deny: ['WebFetch', 'WebSearch'] },
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: false,
              excludedCommands: [],
              allowUnsandboxedCommands: false,
              network: { allowUnixSockets: [], allowLocalBinding: false }
            }
          },
          null,
          2
        )}\n`
      },
      {
        path: join(configDir, 'system-prompt.md'),
        mode: 0o600,
        content: 'APP GUIDANCE'
      }
    ])
    expect(config.configFiles?.[0]?.content).not.toContain('test-key')
    expect(config.args).not.toContain('APP GUIDANCE')
    expect(config).not.toHaveProperty('authentication')
    framework.spawn({
      executablePath: '/usr/bin/codebuddy',
      env: config.env ?? {},
      args: config.args ?? []
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/codebuddy',
      ['--acp', ...(config.args ?? [])],
      expect.objectContaining({ stdio: 'pipe', shell: false })
    )
    const spawnedEnv = (
      spawnProcess.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv }]
    )[2].env
    expect(spawnedEnv?.HTTPS_PROXY).toBe('http://inherited-proxy.example.test:3128')
    expect(spawnedEnv?.NO_PROXY).toBe('inherited-bypass.example.test')
    expect(spawnedEnv?.DISABLE_TELEMETRY).toBe('1')
    expect(spawnedEnv?.DISABLE_ERROR_REPORTING).toBe('1')
  })

  it('preserves an empty restricted tool set through the Windows command wrapper', () => {
    const spawnProcess = vi.fn(() => ({}) as ChildProcessWithoutNullStreams)
    const framework = createCodeBuddyFramework({
      platform: 'win32',
      sourceEnv: {},
      spawnProcess
    })

    framework.spawn({
      executablePath: 'C:\\runtime\\codebuddy.cmd',
      env: {},
      args: ['--tools', '']
    })

    expect(spawnProcess).toHaveBeenCalledWith(
      '"C:\\runtime\\codebuddy.cmd"',
      ['--acp', '--tools', '""'],
      expect.objectContaining({ shell: true })
    )
  })

  it('keeps native Bash absent on Windows too', () => {
    const framework = createCodeBuddyFramework({ platform: 'win32' })
    const config = framework.prepareModelConfig(provider, {
      storageRoot: 'C:\\app-data',
      executablePath: 'C:\\codebuddy.cmd',
      systemPromptAppends: [],
      reasoningEfforts: []
    })
    const tools = config.args?.[config.args.indexOf('--tools') + 1]
    const settings = JSON.parse(config.configFiles?.[1]?.content ?? '{}')

    expect(tools).toBe('Read,Write,Edit,Glob,Grep')
    expect(config.args).toContain('Bash(curl:*)')
    expect(settings.sandbox.enabled).toBe(false)
  })

  it('routes shell work through the app-owned Notebook tool instead of native Bash', () => {
    const config = createCodeBuddyFramework({ platform: 'linux' }).prepareModelConfig(provider, {
      storageRoot: '/app-data',
      executablePath: '/usr/bin/codebuddy',
      systemPromptAppends: [],
      reasoningEfforts: []
    })
    const tools = config.args?.[config.args.indexOf('--tools') + 1]

    expect(tools).not.toContain('Bash')
  })

  it('replays dynamic MCP servers when activating the target Session before a prompt', async () => {
    const request = vi.fn(async () => ({}))
    const mcpServers = [
      {
        name: 'skills',
        command: '/app/electron',
        args: ['/app/main.js'],
        env: [{ name: SKILL_RUNTIME_ROOT_ENV, value: '/app-data/skill-runtime' }]
      },
      { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
    ]

    await createCodeBuddyFramework().beforePromptDispatch?.({
      connection: { agent: { request } } as never,
      providerSessionId: 'provider-session',
      cwd: '/workspace',
      mcpServers,
      skillRuntimeAllowlist: ['mcp-pubmed']
    })

    expect(request).toHaveBeenCalledWith('session/resume', {
      sessionId: 'provider-session',
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'skills',
          command: '/app/electron',
          args: ['/app/main.js'],
          env: [
            { name: SKILL_RUNTIME_ROOT_ENV, value: '/app-data/skill-runtime' },
            { name: SKILL_RUNTIME_ALLOWED_NAMES_ENV, value: '["mcp-pubmed"]' }
          ]
        },
        { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
      ]
    })
  })

  it('removes the Skill loader for a CodeBuddy turn with no routed Skill', async () => {
    const request = vi.fn(async () => ({}))

    await createCodeBuddyFramework().beforePromptDispatch?.({
      connection: { agent: { request } } as never,
      providerSessionId: 'provider-session',
      cwd: '/workspace',
      mcpServers: [
        { name: 'skills', command: '/app/electron', args: ['/app/main.js'], env: [] },
        { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
      ],
      skillRuntimeAllowlist: []
    })

    expect(request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({
        mcpServers: [
          { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
        ]
      })
    )
  })

  it('fails closed when the reserved Skill loader cannot carry an allowlist', async () => {
    const request = vi.fn(async () => ({}))

    await createCodeBuddyFramework().beforePromptDispatch?.({
      connection: { agent: { request } } as never,
      providerSessionId: 'provider-session',
      cwd: '/workspace',
      mcpServers: [
        { type: 'http', name: 'skills', url: 'http://127.0.0.1:1/mcp', headers: [] },
        { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
      ],
      skillRuntimeAllowlist: ['mcp-pubmed']
    })

    expect(request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({
        mcpServers: [
          { name: 'notebook', command: '/app/electron', args: ['/app/notebook.js'], env: [] }
        ]
      })
    )
  })

  it('maps full access onto CodeBuddy fullAccess mode', () => {
    const framework = createCodeBuddyFramework()
    expect(
      framework.mapPermissionProfile('full', {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'fullAccess', name: 'Full access' }
        ]
      })
    ).toMatchObject({ modeId: 'fullAccess', state: { fullAccessAvailable: true } })
  })

  it('adapts only CodeBuddy reasoning-effort aliases', () => {
    const framework = createCodeBuddyFramework()

    expect(framework.adaptSessionEffort?.('none')).toBe('disabled')
    expect(framework.adaptSessionEffort?.('default')).toBe('enabled')
    expect(framework.adaptSessionEffort?.('high')).toBe('high')
    expect(framework.adaptSessionEffort?.('max')).toBe('max')
  })

  it('leaves automatic compaction to the host at ninety percent', () => {
    expect(createCodeBuddyFramework().contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact',
      triggerAtPercent: 90
    })
  })

  it('keeps the app-owned Skill projection out of CodeBuddy model-callable tools', () => {
    const framework = createCodeBuddyFramework()
    const setup = framework.buildSessionSetup({
      systemPromptAppends: ['Load the matching `mcp-*` skill before the first `host.mcp` call.'],
      skillRuntimeScope: ['mcp-pubmed'],
      sessionOptions: {
        [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
          command: '/app/electron',
          entryPath: '/app/main.js',
          root: '/app-data/codebuddy/skill-runtime'
        }
      }
    })

    expect(setup.mcpServers).toBeUndefined()
    expect(setup.promptPrefix).toContain('pre-routes and loads required Skill documents')
    expect(setup.promptPrefix).toContain('do not call `mcp__skills__load_skill`')
  })

  it('does not let an empty Skill route fall back to native or shell web access', () => {
    const setup = createCodeBuddyFramework().buildSessionSetup({
      systemPromptAppends: [],
      skillRuntimeScope: []
    })

    expect(setup.mcpServers).toBeUndefined()
    expect(setup.promptPrefix).toContain('Do not use WebFetch, WebSearch, or direct HTTP')
    expect(setup.promptPrefix).toContain('report that external retrieval is unavailable')
  })
})
