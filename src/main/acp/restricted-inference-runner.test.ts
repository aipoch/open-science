import type { SessionNotification } from '@agentclientprotocol/sdk'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CODEX_SHARED_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'
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
import { ImageInputCompatibilityOwner } from './image-input-compatibility-owner'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import type { AcpRuntimeOptions } from './runtime'
import { prepareRestrictedBackend } from './restricted-runtime-profile'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import {
  RestrictedInferenceError,
  RestrictedInferenceRunner,
  type RestrictedInferenceRuntime
} from './restricted-inference-runner'

const providerNoticeLog = vi.hoisted(() => vi.fn())
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: (scope: string) => {
      const logger = actual.createLogger(scope)
      return scope === 'restricted-inference'
        ? { ...logger, info: providerNoticeLog, warn: providerNoticeLog, error: providerNoticeLog }
        : logger
    }
  }
})

// Frozen from the 127 assistant-message events in the native Codex capture (2026-11-04).
// Only public-paper response chunks are retained; runtime IDs and timestamps are replaced on replay.
// Keep the original chunk boundaries: the 77-byte banner precedes 126 chunks of 690-byte JSON.
const capturedCodexChunks = Object.freeze([
  'Warning: Falling back from WebSockets to HTTPS transport. request timed out\n\n',
  '{"',
  'question',
  '":"',
  'Can',
  ' an',
  ' attention',
  '-only',
  ' architecture',
  ' improve',
  ' sequence',
  ' trans',
  'duction',
  ' quality',
  ' and',
  ' training',
  ' efficiency',
  '?',
  '","',
  'population',
  '":"',
  'W',
  'MT',
  ' ',
  '201',
  '4',
  ' English',
  '-to',
  '-G',
  'erman',
  ' and',
  ' English',
  '-to',
  '-F',
  'rench',
  ' translation',
  ' tasks',
  ';',
  ' English',
  ' constituency',
  ' parsing',
  ' was',
  ' also',
  ' tested',
  '.","',
  'methods',
  '":"',
  'The',
  ' abstract',
  ' describes',
  ' a',
  ' Transformer',
  ' architecture',
  ' without',
  ' recurrence',
  ' or',
  ' convol',
  'utions',
  ',',
  ' evaluated',
  ' on',
  ' two',
  ' translation',
  ' tasks',
  ' and',
  ' English',
  ' constituency',
  ' parsing',
  '.","',
  'results',
  '":"',
  'The',
  ' abstract',
  ' reports',
  ' ',
  '28',
  '.',
  '4',
  ' BLE',
  'U',
  ' for',
  ' English',
  '-to',
  '-G',
  'erman',
  ' and',
  ' ',
  '41',
  '.',
  '8',
  ' BLE',
  'U',
  ' for',
  ' English',
  '-to',
  '-F',
  'rench',
  ',',
  ' along',
  ' with',
  ' greater',
  ' parallel',
  'iz',
  'ability',
  ' and',
  ' shorter',
  ' training',
  ' time',
  ' than',
  ' the',
  ' compared',
  ' models',
  '.',
  ' It',
  ' also',
  ' reports',
  ' successful',
  ' application',
  ' to',
  ' English',
  ' constituency',
  ' parsing',
  '.","',
  'limitations',
  '":',
  'null',
  '}'
])

const capturedCodexNotifications = (): SessionNotification[] =>
  capturedCodexChunks.map((text, index) => ({
    sessionId: 'provider-session-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      ...(index === 0 ? {} : { messageId: 'capture-response' }),
      content: { type: 'text', text }
    }
  }))

let temporaryRoot: string | undefined

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
  providerNoticeLog.mockClear()
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

const codexToolLessBridgeLease = (): NonNullable<
  ResolvedAgentBackend['responsesTransportLease']
> => ({
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => true),
  release: vi.fn(async () => undefined)
})

type RuntimeHarnessOptions = Readonly<{
  response?: {
    stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal'
    _meta?: Record<string, unknown>
  }
  events?: AcpRuntimeEvent[]
  notifications?: SessionNotification[]
  permissionRequest?: true
  onRuntime?: (options: AcpRuntimeOptions) => void
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
      if (input.notifications?.length) {
        // Use the real production owner composition and projector, without starting a provider.
        const projectionOptions = { ...options, framework: resolvedBackend?.framework }
        const owners = composeAcpRuntimeSessionOwners(
          projectionOptions,
          composeAcpRuntimeBaseOwners(projectionOptions)
        )
        for (const notification of input.notifications)
          owners.sessionUpdateProjector.route(notification)
        owners.sessionUpdateProjector.finishAssistantOutput('provider-session-1')
        owners.sessionUpdateProjector.dispose()
      }
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
      await resolvedBackend?.responsesTransportLease?.release()
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
      runtime.onRuntime?.(options)
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
  it('keeps OpenCode structured inference out of the forced-summary step', async () => {
    const { runner } = await makeRunner(backend(opencodeFramework), {
      events: [event({ role: 'assistant', text: '{"title":"Research"}' })],
      onCreateSession: async (prepared) => {
        const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!)
        const agent = config.agent['open-science-test-inference']
        // OpenCode injects its MAX_STEPS summary instruction when step >= agent.steps,
        // including the very first model request when steps is 1.
        expect(agent.steps).toBeUndefined()
        expect(agent.permission).toEqual({ '*': 'deny' })
        expect(config.permission).toEqual({ '*': 'deny' })
      }
    })

    await expect(runner.run(runInput({ target: target('opencode') }))).resolves.toMatchObject({
      text: '{"title":"Research"}',
      stopReason: 'end_turn'
    })
  })

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
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
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

  it.each([claudeCodeFramework, opencodeFramework, codeBuddyFramework, codexFramework])(
    'separates provider notices from model output by default: $id',
    async (framework) => {
      const notice = 'Provider diagnostic\n'
      const body = '{"question":null}'
      const { runner } = await makeRunner(backend(framework), {
        notifications: [
          {
            sessionId: 'provider-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: notice },
              _meta: { 'open-science/provider-notice': { version: 1, level: 'warning' } }
            }
          },
          {
            sessionId: 'provider-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'model-message',
              content: { type: 'text', text: body }
            }
          }
        ],
        onRuntime: (options) => expect(options.separateProviderNotices).toBe(true)
      })
      const result = await runner.run(
        runInput({ target: target(framework.id, CODEX_SHARED_PROVIDER_ID) })
      )
      expect(result.text).toBe(body)
      expect(providerNoticeLog).toHaveBeenCalledTimes(1)
    }
  )

  // Codex ACP 1.6.2 AIR records. The terminal response, not session-wide notices,
  // attributes a failure to the prompt being collected.
  const airFailureMeta = (severity: string, version = 1): Record<string, unknown> => ({
    jetbrains: {
      air: {
        version,
        sessionFailure: {
          id: 'incident-1',
          revision: 1,
          category: severity === 'error' ? 'service' : 'unknown',
          severity,
          title: 'Provider diagnostic that must not enter the answer',
          actions: []
        }
      }
    }
  })

  const identifiedAnswer = (text: string): SessionNotification => ({
    sessionId: 'provider-session-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'model-message',
      content: { type: 'text', text }
    }
  })

  it('collects AIR warnings and legacy compaction without changing the model answer or byte budget', async () => {
    const body = '{"question":null}'
    const { runner, runtimes } = await makeRunner(backend(codexFramework), {
      notifications: [
        {
          sessionId: 'provider-session-1',
          update: { sessionUpdate: 'session_info_update', _meta: airFailureMeta('warning') }
        },
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: "*Context compacted to fit the model's context window.*\n\n"
            }
          }
        },
        identifiedAnswer(body)
      ],
      response: { stopReason: 'end_turn', _meta: airFailureMeta('warning') }
    })
    const result = await runner.run(
      runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID), outputLimitBytes: body.length })
    )
    expect(result.text).toBe(body)
    expect(runtimes[0]?.cancelPrompt).not.toHaveBeenCalled()
  })

  it.each([
    ['terminal error', airFailureMeta('error'), 'failed inference'],
    ['unknown AIR version', airFailureMeta('error', 2), 'unsupported inference outcome'],
    ['unknown severity', airFailureMeta('fatal'), 'unsupported inference outcome']
  ] as const)('rejects %s even after valid JSON was streamed', async (_name, meta, message) => {
    const { runner } = await makeRunner(backend(codexFramework), {
      notifications: [identifiedAnswer('{"question":null}')],
      response: { stopReason: 'end_turn', _meta: meta }
    })
    await expect(
      runner.run(runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID) }))
    ).rejects.toThrow(message)
  })

  it('does not fail the current prompt from a late session-wide AIR error', async () => {
    const { runner } = await makeRunner(backend(codexFramework), {
      notifications: [
        {
          sessionId: 'provider-session-1',
          update: { sessionUpdate: 'session_info_update', _meta: airFailureMeta('error') }
        },
        identifiedAnswer('{"question":null}')
      ],
      response: { stopReason: 'end_turn' }
    })
    await expect(
      runner.run(runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID) }))
    ).resolves.toMatchObject({ text: '{"question":null}' })
  })

  it('replays the native Codex transport warning capture without changing the JSON answer', async () => {
    const notifications = capturedCodexNotifications()
    expect(notifications).toHaveLength(127)
    expect(Buffer.byteLength(capturedCodexChunks[0]!, 'utf8')).toBe(77)
    expect(
      new Set(
        notifications
          .slice(1)
          .map((entry) => ('messageId' in entry.update ? entry.update.messageId : undefined))
      )
    ).toEqual(new Set(['capture-response']))
    const expectedBody = capturedCodexChunks.slice(1).join('')
    expect(Buffer.byteLength(expectedBody, 'utf8')).toBe(690)
    const { runner, runtimes } = await makeRunner(backend(codexFramework), {
      notifications,
      onRuntime: (options) => expect(options.separateProviderNotices).toBe(true)
    })

    const result = await runner.run(
      runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID), outputLimitBytes: 690 })
    )

    expect(result.text).toBe(expectedBody)
    const sections = JSON.parse(result.text)
    expect(sections.question).toBe(
      'Can an attention-only architecture improve sequence transduction quality and training efficiency?'
    )
    expect(sections.results).toContain('28.4 BLEU')
    expect(sections.limitations).toBeNull()
    expect(runtimes[0]?.cancelPrompt).not.toHaveBeenCalled()
    // Exact structured arguments prove neither the raw warning nor model response is logged.
    expect(providerNoticeLog.mock.calls).toEqual([
      ['Restricted inference provider notice', { code: 'provider-notice', level: 'warning' }]
    ])
  })

  it.each([
    ['malformed JSON', '{"question":'],
    ['unvalidated JSON structure', '{"question":null}']
  ] as const)('retains %s after removing the transport warning', async (_name, text) => {
    const { runner } = await makeRunner(backend(codexFramework), {
      notifications: [
        capturedCodexNotifications()[0]!,
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'model-message',
            content: { type: 'text', text }
          }
        }
      ]
    })
    const result = await runner.run(runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID) }))

    expect(result.text).toBe(text)
  })

  it('still rejects and cancels when the captured JSON body exceeds its byte limit', async () => {
    const { runner, runtimes } = await makeRunner(backend(codexFramework), {
      notifications: capturedCodexNotifications()
    })

    await expect(
      runner.run(
        runInput({ target: target('codex', CODEX_SHARED_PROVIDER_ID), outputLimitBytes: 689 })
      )
    ).rejects.toMatchObject({ code: 'output-limit' })
    expect(runtimes[0]?.cancelPrompt).toHaveBeenCalledTimes(1)
  })

  it('keeps canonical informational levels out of unscoped model JSON', async () => {
    const chunks = capturedCodexChunks.slice(1)
    const notifications: SessionNotification[] = chunks.map((text) => ({
      sessionId: 'provider-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    }))
    for (const [index, level] of (['info', 'warning', 'error'] as const).entries()) {
      notifications.splice(index * 3, 0, {
        sessionId: 'provider-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Provider-only ${level} diagnostic` },
          _meta: { 'open-science/provider-notice': { version: 1, level } }
        }
      })
    }
    const { runner } = await makeRunner(backend(claudeCodeFramework), { notifications })

    const result = await runner.run(runInput({ outputLimitBytes: 690 }))

    expect(result.text).toBe(chunks.join(''))
    expect(JSON.parse(result.text).limitations).toBeNull()
    expect(providerNoticeLog.mock.calls).toEqual(
      (['info', 'warning', 'error'] as const).map((level) => [
        'Restricted inference provider notice',
        { code: 'provider-notice', level }
      ])
    )
  })

  it('keeps malformed informational metadata in the body so strict JSON still fails', async () => {
    const { runner } = await makeRunner(backend(claudeCodeFramework), {
      notifications: [
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Warning: unproven source' },
            _meta: { 'open-science/provider-notice': { version: 1, level: 'fatal' } }
          }
        },
        ...capturedCodexNotifications().slice(1)
      ]
    })

    const result = await runner.run(runInput())

    expect(result.text.startsWith('Warning: unproven source')).toBe(true)
    expect(() => JSON.parse(result.text)).toThrow(SyntaxError)
    expect(providerNoticeLog).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'separates captured CodeBuddy hook notices without masking a final failure (%s)',
    async (fails) => {
      const failure = new Error('Provider failed after partial output')
      const body = '{"question":"What works?"}'
      const { runner } = await makeRunner(backend(codeBuddyFramework), {
        notifications: [
          {
            sessionId: 'provider-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'hook-message',
              content: { type: 'text', text: 'Hook diagnostic' },
              _meta: {
                'codebuddy.ai/messageId': 'hook-message',
                'codebuddy.ai/hook': { event: 'UserPromptSubmit', status: 'warning', exitCode: 1 }
              }
            }
          },
          {
            sessionId: 'provider-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'model-message',
              content: { type: 'text', text: body }
            }
          }
        ],
        onPrompt: async () => {
          if (fails) throw failure
        }
      })
      const result = runner.run(runInput({ outputLimitBytes: Buffer.byteLength(body) }))
      if (fails) await expect(result).rejects.toBe(failure)
      else await expect(result).resolves.toMatchObject({ text: body })
    }
  )

  it('preserves a fatal prompt rejection after a nonterminal provider error notice', async () => {
    const failure = new Error('Provider connection failed')
    const { runner } = await makeRunner(backend(claudeCodeFramework), {
      notifications: [
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Nonterminal provider error detail' },
            _meta: { 'open-science/provider-notice': { version: 1, level: 'error' } }
          }
        }
      ],
      onPrompt: async () => {
        throw failure
      }
    })

    await expect(runner.run(runInput())).rejects.toBe(failure)
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
        responsesTransportLease: codexToolLessBridgeLease()
      }),
      target('codex')
    ],
    [
      'Codex Bridge',
      backend(codexFramework, {
        modelRoute: 'codex-bridge',
        responsesTransportLease: codexToolLessBridgeLease()
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
        responsesTransportLease: {
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
          responsesTransportLease: codexToolLessBridgeLease()
        }),
      target('codex')
    ],
    [
      'Codex Bridge',
      () =>
        backend(codexFramework, {
          modelRoute: 'codex-bridge',
          responsesTransportLease: codexToolLessBridgeLease()
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
            responsesTransportLease: {
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
        responsesTransportLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: releaseResponses
        },
        messagesBridgeLease: { setTarget: vi.fn(() => true), release: releaseAnthropic },
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
        responsesTransportLease: {
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

it.each(['max_tokens', 'cancelled', 'refusal'] as const)(
  'does not persist visual evidence when the runtime ends with %s',
  async (stopReason) => {
    const { runner } = await makeRunner(backend(opencodeFramework), {
      response: { stopReason },
      events: [
        event({
          role: 'assistant',
          text: JSON.stringify({
            summary: 'Partial evidence',
            findings: [],
            transcription: '',
            regions: [],
            entities: [],
            relations: [],
            uncertainty: []
          })
        })
      ]
    })
    const save = vi.fn(async () => undefined)
    const owner = new ImageInputCompatibilityOwner({
      captureTarget: async () => target('opencode'),
      runner,
      evidenceRepository: { find: vi.fn(async () => undefined), save }
    })
    const outcome = await owner
      .prepare({
        content: [
          { type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') }
        ],
        supportsImageInput: false,
        projectId: 'project-1',
        sessionId: 'session-1',
        imageSources: [{ kind: 'upload-version', uploadVersionId: 'version-1' }]
      })
      .then(
        () => 'accepted',
        () => 'rejected'
      )
    expect.soft(outcome).toBe('rejected')
    expect(save).not.toHaveBeenCalled()
  }
)
