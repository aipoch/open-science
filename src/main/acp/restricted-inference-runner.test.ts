import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CODEX_SHARED_PROVIDER_ID } from '../../shared/settings'
import type { AcpRuntimeEvent, AcpTurnTokenUsage } from '../../shared/acp'
import type { ResolvedAgentBackend } from '../agent-framework'
import { claudeCodeFramework } from '../agent-framework/claude-code'
import { codeBuddyFramework } from '../agent-framework/codebuddy'
import { codexFramework } from '../agent-framework/codex'
import { opencodeFramework } from '../agent-framework/opencode'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import {
  LOAD_SKILL_TOOL_CALLABLE_NAME,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
} from '../skills/runtime-mcp-server'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import type { AcpRuntimeOptions } from './runtime'
import { prepareRestrictedBackend } from './restricted-runtime-profile'
import {
  RestrictedInferenceError,
  RestrictedInferenceRunner,
  type RestrictedInferenceRuntime
} from './restricted-inference-runner'

let temporaryRoot: string | undefined

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

const target = (
  frameworkId: ExplicitAgentBackendTarget['frameworkId'] = 'claude-code',
  providerId = 'provider-a'
): ExplicitAgentBackendTarget => ({
  frameworkId,
  providerId,
  model: { kind: 'required', id: 'model-a' },
  reasoningEffort: 'high'
})

const backend = (
  framework: ResolvedAgentBackend['framework'],
  extra: Partial<ResolvedAgentBackend> = {}
): ResolvedAgentBackend => ({
  framework,
  executablePath: `/managed/${framework.id}`,
  env: {},
  sessionModel: 'model-a',
  contextUsageModel: 'model-a',
  ...extra
})

const codexToolLessBridgeLease = (): NonNullable<ResolvedAgentBackend['responsesBridgeLease']> => ({
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => true),
  release: vi.fn(async () => undefined)
})

type RuntimeHarnessOptions = Readonly<{
  response?: { stopReason: 'end_turn' | 'cancelled' }
  events?: AcpRuntimeEvent[]
  permissionRequest?: true
  onRuntime?: () => void
  onCreateSession?: (backend: ResolvedAgentBackend) => Promise<void>
  onPrompt?: () => Promise<void>
}>

const runtimeHarness = (
  options: AcpRuntimeOptions,
  input: RuntimeHarnessOptions = {}
): RestrictedInferenceRuntime => {
  let resolvedBackend: ResolvedAgentBackend | undefined
  return {
    createSession: vi.fn(async () => {
      resolvedBackend = await (options.resolveBackend as () => Promise<ResolvedAgentBackend>)()
      await input.onCreateSession?.(resolvedBackend)
      return { sessionId: 'provider-session-1' } as never
    }),
    sendPrompt: vi.fn(async () => {
      for (const event of input.events ?? []) options.callbacks?.onEvent?.(event)
      if (input.permissionRequest) {
        options.callbacks?.onPermissionRequest?.({
          requestId: 'permission-1',
          sessionId: 'provider-session-1',
          toolCallId: 'tool-1',
          title: 'Run a tool',
          options: []
        })
      }
      await input.onPrompt?.()
      return input.response ?? { stopReason: 'end_turn' }
    }),
    cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' }) as never),
    respondToPermission: vi.fn(async () => undefined),
    shutdownForQuit: vi.fn(async () => {
      await resolvedBackend?.responsesBridgeLease?.release()
    })
  } as unknown as RestrictedInferenceRuntime
}

const event = (value: Partial<AcpRuntimeEvent>): AcpRuntimeEvent =>
  ({
    id: 'event-1',
    timestamp: 1,
    kind: 'message',
    level: 'info',
    ...value
  }) as AcpRuntimeEvent

const makeRunner = async (
  resolved: ResolvedAgentBackend,
  runtime: RuntimeHarnessOptions = {}
): Promise<{
  runner: RestrictedInferenceRunner
  resolveTarget: ReturnType<typeof vi.fn>
  runtimes: RestrictedInferenceRuntime[]
}> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-restricted-inference-'))
  const resolveTarget = vi.fn(async () => resolved)
  const runtimes: RestrictedInferenceRuntime[] = []
  const runner = new RestrictedInferenceRunner({
    appVersion: '0.11.0',
    configRoot: temporaryRoot,
    profileNamespace: 'test-inference',
    resolveTarget,
    allowNativeCodexSubscription: true,
    createRuntime: (options) => {
      runtime.onRuntime?.()
      const created = runtimeHarness(options, runtime)
      runtimes.push(created)
      return created
    }
  })
  return { runner, resolveTarget, runtimes }
}

const runInput = (
  overrides: Partial<Parameters<RestrictedInferenceRunner['run']>[0]> = {}
): Parameters<RestrictedInferenceRunner['run']>[0] => ({
  prompt: 'Return PONG.',
  target: target(),
  systemPrompt: 'Do not use tools.',
  agentName: 'open-science-test-inference',
  description: 'Test inference without tools.',
  ...overrides
})

describe('RestrictedInferenceRunner', () => {
  it('builds a disposable tool-less profile from app-owned Codex subscription auth', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-restricted-codex-subscription-'))
    const sourceHome = join(temporaryRoot, 'subscription-home')
    await mkdir(sourceHome)
    await writeFile(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}')
    await writeFile(
      join(sourceHome, 'config.toml'),
      [
        'cli_auth_credentials_store = "file"',
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

    const prepared = await prepareRestrictedBackend(
      backend(codexFramework, {
        backendId: `codex:${CODEX_SHARED_PROVIDER_ID}`,
        env: {
          CODEX_HOME: sourceHome,
          HOME: sourceHome,
          USERPROFILE: sourceHome,
          CODEX_CONFIG: JSON.stringify({
            developer_instructions: 'load every tool',
            features: { multi_agent: false }
          })
        }
      }),
      temporaryRoot,
      {
        agentName: 'restricted-fixture',
        description: 'Synthetic restricted inference fixture.',
        systemPrompt: 'Do not use tools.',
        openCodePermissions: { '*': 'deny' }
      }
    )

    expect(await readFile(join(prepared.env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('secret')
    const configToml = await readFile(join(prepared.env.CODEX_HOME!, 'config.toml'), 'utf8')
    expect(configToml).toContain('cli_auth_credentials_store = "file"')
    expect(configToml).toContain('model_provider = "subscription-route"')
    expect(configToml).toContain('base_url = "http://127.0.0.1:43123/v1"')
    expect(configToml).not.toContain('mcp_servers')
    expect(configToml).not.toContain('unsafe-tool')
    expect(prepared.env.HOME).toBe(prepared.env.CODEX_HOME)
    expect(prepared.env.USERPROFILE).toBe(prepared.env.CODEX_HOME)
    expect(JSON.parse(prepared.env.CODEX_CONFIG!)).toMatchObject({
      experimental_use_unified_exec_tool: false,
      features: {
        multi_agent: false,
        shell_tool: false,
        code_mode: false,
        code_mode_host: false,
        apply_patch_freeform: false,
        apps: false,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        workspace_dependencies: false
      },
      tools: { web_search: false }
    })
  })

  it('removes the Claude Skill projection and loader from restricted Session setup', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-restricted-inference-'))
    const projectionRoot = '/runtime-support/agent-skills/claude/revision'
    const prepared = await prepareRestrictedBackend(
      backend(claudeCodeFramework, {
        sessionOptions: {
          additionalDirectories: [projectionRoot, '/preserved-directory'],
          sandbox: {
            filesystem: {
              allowRead: [projectionRoot, '/preserved-read'],
              denyWrite: [projectionRoot, '/preserved-write'],
              denyRead: ['/restricted-secret']
            },
            network: { allowUnixSockets: ['/preserved.sock'] }
          },
          [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
            command: '/app/open-science',
            entryPath: '/app/main.js',
            root: projectionRoot
          }
        }
      }),
      temporaryRoot,
      {
        agentName: 'restricted-fixture',
        description: 'Synthetic restricted inference fixture.',
        systemPrompt: 'Do not use tools.',
        openCodePermissions: { '*': 'deny' }
      }
    )
    const presentation = new AcpSessionPresentationPolicy().buildSessionSetup({
      framework: prepared.framework,
      tooling: { artifacts: false, notebook: false, skillImport: false },
      sessionOptions: prepared.sessionOptions,
      backendSystemPromptAppends: prepared.systemPromptAppends
    })
    const claudeOptions = (
      presentation.metaArg._meta?.claudeCode as { options?: Record<string, unknown> } | undefined
    )?.options

    expect(prepared.sessionOptions).not.toHaveProperty(OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION)
    expect(prepared.sessionOptions?.additionalDirectories).toEqual(['/preserved-directory'])
    expect(prepared.sessionOptions?.sandbox).toEqual({
      filesystem: {
        allowRead: ['/preserved-read'],
        denyWrite: ['/preserved-write'],
        denyRead: ['/restricted-secret']
      },
      network: { allowUnixSockets: ['/preserved.sock'] }
    })
    expect(claudeOptions?.mcpServers).toBeUndefined()
    expect(claudeOptions?.toolAliases).toBeUndefined()
    expect(claudeOptions?.allowedTools).toBeUndefined()
    expect(JSON.stringify(claudeOptions)).not.toContain(projectionRoot)
    expect(JSON.stringify(claudeOptions)).not.toContain(LOAD_SKILL_TOOL_CALLABLE_NAME)
  })

  it('isolates CodeBuddy configuration and removes native tools from restricted inference', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-restricted-codebuddy-'))
    const sourceConfigDir = join(temporaryRoot, 'source-codebuddy')
    await mkdir(sourceConfigDir, { recursive: true })
    await writeFile(join(sourceConfigDir, 'models.json'), '{"models":[]}\n')
    await writeFile(join(sourceConfigDir, 'system-prompt.md'), 'Do not preserve this prompt.\n')

    const prepared = await prepareRestrictedBackend(
      backend(codeBuddyFramework, {
        env: { CODEBUDDY_CONFIG_DIR: sourceConfigDir },
        args: [
          '--strict-mcp-config',
          '--tools',
          'Read,Write,Edit,Glob,Grep,Bash',
          '--system-prompt-file',
          join(sourceConfigDir, 'system-prompt.md')
        ],
        sessionOptions: {
          [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
            command: '/app/open-science',
            entryPath: '/app/main.js',
            root: '/runtime-support/agent-skills/codebuddy/revision'
          }
        },
        persistentSystemPrompt: 'Do not preserve this prompt.'
      }),
      join(temporaryRoot, 'profile'),
      {
        agentName: 'restricted-fixture',
        description: 'Synthetic restricted inference fixture.',
        systemPrompt: 'Do not use tools.',
        openCodePermissions: { '*': 'deny' }
      }
    )

    expect(prepared.env.CODEBUDDY_CONFIG_DIR).toBe(join(temporaryRoot, 'profile', 'codebuddy'))
    await expect(
      readFile(join(prepared.env.CODEBUDDY_CONFIG_DIR!, 'models.json'), 'utf8')
    ).resolves.toBe('{"models":[]}\n')
    expect(prepared.args?.slice(-2)).toEqual(['--tools', ''])
    expect(prepared.args).not.toContain('--system-prompt-file')
    expect(prepared.sessionOptions).not.toHaveProperty(OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION)
    expect(prepared.systemPromptAppends).toEqual(['Do not use tools.'])
    expect(prepared.persistentSystemPrompt).toBeUndefined()
  })

  it('runs a native Codex subscription target through its restricted profile', async () => {
    const { runner, resolveTarget } = await makeRunner(backend(codexFramework), {
      events: [event({ role: 'assistant', text: 'PONG' })]
    })

    expect(runner.supportsTarget(target('claude-code'))).toBe(true)
    expect(runner.supportsTarget(target('opencode'))).toBe(true)
    expect(runner.supportsTarget(target('codex'))).toBe(true)
    await expect(
      runner.run(runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID) }))
    ).resolves.toMatchObject({
      text: 'PONG',
      frameworkId: 'codex'
    })
    expect(resolveTarget).toHaveBeenCalledWith(target('codex', CODEX_SHARED_PROVIDER_ID), {
      systemPromptAppends: [],
      includeSkillAndConnectorContext: false
    })
  })

  it('excludes normalized thought events from restricted inference output', async () => {
    const { runner } = await makeRunner(backend(claudeCodeFramework), {
      events: [
        event({ kind: 'thought', role: 'assistant', text: 'private analysis' }),
        event({ role: 'assistant', text: 'Visible result.' })
      ]
    })

    await expect(runner.run(runInput())).resolves.toMatchObject({ text: 'Visible result.' })
  })

  it('keeps restricted instructions out of the shared OpenCode config used by the first conversation', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-restricted-inference-'))
    const sharedInstructionsDir = join(temporaryRoot, 'shared-opencode', 'instructions')
    const sharedInstructionsPath = join(sharedInstructionsDir, 'open-science.md')
    const mainInstructions = 'Answer the user request normally.'
    await mkdir(sharedInstructionsDir, { recursive: true })
    await writeFile(sharedInstructionsPath, mainInstructions)

    const runner = new RestrictedInferenceRunner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      profileNamespace: 'test-inference',
      resolveTarget: async (_target, context) => {
        if (context.systemPromptAppends.length > 0) {
          await writeFile(sharedInstructionsPath, context.systemPromptAppends.join('\n\n'))
        }
        return backend(opencodeFramework, { modelRoute: 'opencode-openai' })
      },
      createRuntime: (options) =>
        runtimeHarness(options, {
          events: [
            event({
              role: 'assistant',
              text: '{"title":"Plot sine wave","description":"Plot a sine function."}'
            })
          ]
        })
    })

    await expect(
      runner.run(
        runInput({
          target: target('opencode'),
          systemPrompt: 'Return Session metadata only.'
        })
      )
    ).resolves.toMatchObject({ frameworkId: 'opencode' })
    await expect(readFile(sharedInstructionsPath, 'utf8')).resolves.toBe(mainInstructions)
  })

  it.each([
    ['Claude Code', backend(claudeCodeFramework), target('claude-code')],
    ['OpenCode', backend(opencodeFramework), target('opencode')],
    [
      'Codex Responses',
      backend(codexFramework, {
        modelRoute: 'codex-responses',
        responsesBridgeLease: codexToolLessBridgeLease()
      }),
      target('codex')
    ],
    [
      'Codex Bridge',
      backend(codexFramework, {
        modelRoute: 'codex-bridge',
        responsesBridgeLease: codexToolLessBridgeLease()
      }),
      target('codex')
    ]
  ] as const)(
    'installs restricted instructions after resolving the %s backend',
    async (_name, resolved, runTarget) => {
      const onCreateSession = vi.fn(async (prepared: ResolvedAgentBackend) => {
        expect(prepared.systemPromptAppends).toEqual(['Do not use tools.'])
      })
      const { runner, resolveTarget } = await makeRunner(resolved, {
        events: [event({ role: 'assistant', text: 'PONG' })],
        onCreateSession
      })

      await expect(runner.run(runInput({ target: runTarget }))).resolves.toMatchObject({
        text: 'PONG'
      })
      expect(resolveTarget).toHaveBeenCalledWith(
        runTarget,
        expect.objectContaining({ systemPromptAppends: [] })
      )
      expect(onCreateSession).toHaveBeenCalledOnce()
    }
  )

  it('collects text and provider-neutral usage while verifying the Codex tool-less scope', async () => {
    const usage: AcpTurnTokenUsage = {
      inputTokens: 12,
      cacheTokens: 3,
      cachedReadTokens: 2,
      cachedWriteTokens: 1,
      outputTokens: 4,
      turnCount: 1
    }
    const registered = new Set<string>()
    const registerToolLessSession = vi.fn((id: string) => registered.add(id))
    const unregisterToolLessSession = vi.fn((id: string) => registered.delete(id))
    const release = vi.fn(async () => undefined)
    const { runner, resolveTarget } = await makeRunner(
      backend(codexFramework, {
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          registerToolLessSession,
          unregisterToolLessSession,
          release
        }
      }),
      {
        events: [
          event({ role: 'assistant', text: 'PONG' }),
          event({ kind: 'stop', text: 'end_turn', turnUsage: usage })
        ]
      }
    )

    await expect(runner.run(runInput({ target: target('codex') }))).resolves.toEqual({
      text: 'PONG',
      frameworkId: 'codex',
      model: 'model-a',
      stopReason: 'end_turn',
      usage
    })
    expect(resolveTarget).toHaveBeenCalledWith(target('codex'), {
      systemPromptAppends: [],
      includeSkillAndConnectorContext: false,
      forceCodexNativeResponsesCompatibility: true
    })
    expect(registerToolLessSession).toHaveBeenCalledWith('provider-session-1')
    expect(unregisterToolLessSession).toHaveBeenCalledWith('provider-session-1')
    expect(release).toHaveBeenCalledOnce()
    await expect(
      readdir(join(temporaryRoot!, 'runtime-support', 'test-inference'))
    ).resolves.toEqual([])
  })

  it.each([
    [
      'Claude Code',
      () => backend(claudeCodeFramework, { modelRoute: 'claude-anthropic' }),
      target('claude-code')
    ],
    [
      'OpenCode',
      () => backend(opencodeFramework, { modelRoute: 'opencode-openai' }),
      target('opencode')
    ],
    [
      'Codex Responses',
      () =>
        backend(codexFramework, {
          modelRoute: 'codex-responses',
          responsesBridgeLease: codexToolLessBridgeLease()
        }),
      target('codex')
    ],
    [
      'Codex Bridge',
      () =>
        backend(codexFramework, {
          modelRoute: 'codex-bridge',
          responsesBridgeLease: codexToolLessBridgeLease()
        }),
      target('codex')
    ]
  ] as const)(
    'forwards sanitized images through the %s visual route',
    async (_name, route, runTarget) => {
      const image = {
        mimeType: 'image/png' as const,
        data: Buffer.from('image').toString('base64'),
        byteLength: 5
      }
      const { runner, runtimes } = await makeRunner(route(), {
        events: [event({ role: 'assistant', text: '{}' })]
      })

      await runner.run(runInput({ images: [image], target: runTarget }))

      expect(runtimes[0]?.sendPrompt).toHaveBeenCalledWith({
        sessionId: 'provider-session-1',
        text: 'Return PONG.',
        historyImages: [image],
        suppressUserMessage: true
      })
    }
  )

  it('cancels and rejects tool events and oversized output', async () => {
    const cases: Array<{
      name: string
      runtime: RuntimeHarnessOptions
      expectedCode: RestrictedInferenceError['code']
      outputLimitBytes?: number
    }> = [
      {
        name: 'tool event',
        runtime: { events: [event({ kind: 'tool' })] },
        expectedCode: 'tool-violation'
      },
      {
        name: 'oversized output',
        runtime: { events: [event({ role: 'assistant', text: '12345' })] },
        expectedCode: 'output-limit',
        outputLimitBytes: 4
      }
    ]

    for (const current of cases) {
      const { runner, runtimes } = await makeRunner(
        backend(current.name === 'oversized output' ? opencodeFramework : claudeCodeFramework),
        current.runtime
      )
      await expect(
        runner.run(runInput({ outputLimitBytes: current.outputLimitBytes }))
      ).rejects.toMatchObject({ code: current.expectedCode })
      expect(runtimes[0]?.cancelPrompt).toHaveBeenCalled()
      await rm(temporaryRoot!, { recursive: true, force: true })
      temporaryRoot = undefined
    }
  })

  it('preserves provider usage reported before a restricted-inference failure', async () => {
    const usage: AcpTurnTokenUsage = {
      inputTokens: 12,
      cacheTokens: 3,
      outputTokens: 4
    }
    const { runner } = await makeRunner(backend(claudeCodeFramework), {
      events: [event({ kind: 'tool' }), event({ kind: 'stop', text: 'end_turn', turnUsage: usage })]
    })

    await expect(runner.run(runInput())).rejects.toMatchObject({
      code: 'tool-violation',
      usage
    })
  })

  it.each([
    ['claude-code', claudeCodeFramework, target('claude-code')],
    ['opencode', opencodeFramework, target('opencode')],
    ['codex response routes', codexFramework, target('codex')]
  ] as const)('fails closed on %s permission requests', async (_name, framework, runTarget) => {
    const resolved = backend(
      framework,
      framework.id === 'codex'
        ? {
            responsesBridgeLease: {
              selectSkills: vi.fn(async () => []),
              registerReviewerSession: vi.fn(),
              unregisterReviewerSession: vi.fn(() => false),
              registerToolLessSession: vi.fn(),
              unregisterToolLessSession: vi.fn(() => true),
              release: vi.fn(async () => undefined)
            }
          }
        : {}
    )
    const { runner, runtimes } = await makeRunner(resolved, { permissionRequest: true })

    await expect(runner.run(runInput({ target: runTarget }))).rejects.toMatchObject({
      code: 'tool-violation'
    })
    expect(runtimes[0]?.respondToPermission).toHaveBeenCalledWith({
      requestId: 'permission-1',
      cancelled: true
    })
    expect(runtimes[0]?.cancelPrompt).toHaveBeenCalled()
  })

  it('releases every unattached backend lease when tool-less enforcement is unavailable', async () => {
    const releaseResponses = vi.fn(async () => undefined)
    const releaseAnthropic = vi.fn(async () => undefined)
    const releaseTransport = vi.fn(async () => undefined)
    const { runner, runtimes } = await makeRunner(
      backend(codexFramework, {
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: releaseResponses
        },
        anthropicBridgeLease: { setTarget: vi.fn(() => true), release: releaseAnthropic },
        providerTransportLease: { setTarget: vi.fn(() => true), release: releaseTransport }
      })
    )

    await expect(runner.run(runInput({ target: target('codex') }))).rejects.toMatchObject({
      code: 'transport-unavailable'
    })
    expect(runtimes).toHaveLength(0)
    expect(releaseResponses).toHaveBeenCalledOnce()
    expect(releaseAnthropic).toHaveBeenCalledOnce()
    expect(releaseTransport).toHaveBeenCalledOnce()
  })

  it('leaves output unbounded when an Adapter does not opt into a limit', async () => {
    const text = 'x'.repeat(300 * 1024)
    const { runner } = await makeRunner(backend(claudeCodeFramework), {
      events: [event({ role: 'assistant', text })]
    })

    await expect(runner.run(runInput())).resolves.toMatchObject({ text })
  })

  it('propagates caller cancellation and drains active work during shutdown', async () => {
    let releasePrompt = (): void => undefined
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const { runner, runtimes } = await makeRunner(backend(claudeCodeFramework), {
      response: { stopReason: 'cancelled' },
      onPrompt: () => promptBlocked
    })
    const call = runner.run(runInput())

    await vi.waitFor(() => expect(runtimes).toHaveLength(1))
    const shutdown = runner.shutdown()
    await vi.waitFor(() => expect(runtimes[0]?.cancelPrompt).toHaveBeenCalled())
    releasePrompt()

    await expect(call).rejects.toMatchObject({ code: 'cancelled' })
    await expect(shutdown).resolves.toBeUndefined()
    await expect(runner.run(runInput())).rejects.toMatchObject({ code: 'shutting-down' })
  })

  it('rejects a pre-aborted caller before resolving a backend', async () => {
    const controller = new AbortController()
    controller.abort()
    const { runner, resolveTarget, runtimes } = await makeRunner(backend(claudeCodeFramework))

    await expect(runner.run(runInput({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(runtimes).toHaveLength(0)
  })

  it('does not dispatch a prompt when cancellation lands during session setup', async () => {
    let finishCreate = (): void => undefined
    const creating = new Promise<void>((resolve) => {
      finishCreate = resolve
    })
    const controller = new AbortController()
    const { runner, runtimes } = await makeRunner(backend(claudeCodeFramework), {
      onCreateSession: () => creating
    })
    const call = runner.run(runInput({ signal: controller.signal }))

    await vi.waitFor(() => expect(runtimes[0]?.createSession).toHaveBeenCalled())
    controller.abort()
    finishCreate()

    await expect(call).rejects.toMatchObject({ code: 'cancelled' })
    expect(runtimes[0]?.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not create a session when cancellation lands after profile preparation', async () => {
    const controller = new AbortController()
    const { runner, runtimes } = await makeRunner(backend(claudeCodeFramework), {
      onRuntime: () => controller.abort()
    })

    await expect(runner.run(runInput({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(runtimes[0]?.createSession).not.toHaveBeenCalled()
  })

  it('does not dispatch a prompt when cancellation lands during tool-less scope registration', async () => {
    const controller = new AbortController()
    const registerToolLessSession = vi.fn(() => controller.abort())
    const unregisterToolLessSession = vi.fn(() => true)
    const { runner, runtimes } = await makeRunner(
      backend(codexFramework, {
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          registerToolLessSession,
          unregisterToolLessSession,
          release: vi.fn(async () => undefined)
        }
      })
    )

    await expect(
      runner.run(runInput({ target: target('codex'), signal: controller.signal }))
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(registerToolLessSession).toHaveBeenCalledWith('provider-session-1')
    expect(runtimes[0]?.sendPrompt).not.toHaveBeenCalled()
  })
})
