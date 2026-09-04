import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PersistedSideChat } from '../../shared/session-persistence'
import { SIDE_CHAT_MESSAGE_LIMIT } from '../../shared/side-chat'
import type { AcpRuntimeOptions } from '../acp/runtime'
import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import type { AgentModelChangeTarget, ResolvedAgentBackend } from '../agent-framework'
import { claudeCodeFramework } from '../agent-framework/claude-code'
import { codexFramework } from '../agent-framework/codex'
import { opencodeFramework } from '../agent-framework/opencode'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import {
  SIDE_CHAT_SYSTEM_PROMPT,
  SideChatRuntimeOwner,
  prepareSideChatBackend
} from './runtime-owner'

const createRelayOwner = (targetState: 'idle' | 'completed' = 'idle'): SideChatRelayOwner =>
  new SideChatRelayOwner({
    targetState: () => targetState,
    appendRelay: async () => undefined
  })

type PersistenceSave = (input: {
  projectId: string
  parentSessionId: string
  sideChat: PersistedSideChat
}) => Promise<PersistedSideChat>

type PersistenceClear = (input: {
  projectId: string
  parentSessionId: string
  sideChatId: string
}) => Promise<boolean>

const createPersistence = (): {
  save: ReturnType<typeof vi.fn<PersistenceSave>>
  clear: ReturnType<typeof vi.fn<PersistenceClear>>
} => ({
  save: vi.fn<PersistenceSave>(async (input) => input.sideChat),
  clear: vi.fn<PersistenceClear>(async () => true)
})

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

let temporaryRoot: string | undefined

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

const backend = (
  framework: ResolvedAgentBackend['framework'],
  env: Record<string, string> = {}
): ResolvedAgentBackend => ({
  framework,
  providerId: 'provider-a',
  executablePath: `/managed/${framework.id}`,
  env,
  sessionModel: 'model-a',
  contextUsageModel: 'model-a'
})

const target: ExplicitAgentBackendTarget = {
  frameworkId: 'claude-code',
  providerId: 'provider-a',
  model: { kind: 'required', id: 'model-a' },
  reasoningEffort: 'medium'
}

const modelChangeTarget = (model: string): AgentModelChangeTarget => ({
  frameworkId: 'claude-code',
  providerId: 'provider-a',
  backendId: 'claude-code:provider-a',
  route: 'claude-anthropic',
  model,
  sessionModel: model,
  sessionModelRequired: false,
  reasoningEffort: 'medium',
  supportsImageInput: false
})

describe('Side chat relay instructions', () => {
  it('requires a new explicit user request before every message sent to Main', () => {
    expect(SIDE_CHAT_SYSTEM_PROMPT).toContain(
      'Do not call send_message for ordinary Side chat questions, requests, follow-ups, or suggestions.'
    )
    expect(SIDE_CHAT_SYSTEM_PROMPT).toContain(
      'Call it only when the user explicitly asks in the current Side chat turn to send, relay, forward, or tell something to Main.'
    )
    expect(SIDE_CHAT_SYSTEM_PROMPT).toContain(
      'Do not call it again on a later turn unless the user explicitly asks again.'
    )
    expect(SIDE_CHAT_SYSTEM_PROMPT).toContain(
      'While Main is running, it tries to inject advisory context into that turn'
    )
    expect(SIDE_CHAT_SYSTEM_PROMPT).toContain(
      'Send only the advisory content; do not prepend a Side chat source or relay label.'
    )
  })
})

describe('Side chat restricted backend profile', () => {
  it('uses an isolated OpenCode deny-all agent with one exact host-message allow', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-opencode-'))
    const prepared = await prepareSideChatBackend(
      backend(opencodeFramework, {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'provider/model-a' })
      }),
      temporaryRoot
    )

    const config = JSON.parse(
      await readFile(join(prepared.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')
    ) as Record<string, unknown>
    expect(config).toMatchObject({
      model: 'provider/model-a',
      default_agent: 'open-science-side-chat',
      permission: {
        '*': 'deny',
        open_science_host_message_send_message: 'allow'
      },
      agent: {
        'open-science-side-chat': {
          mode: 'primary',
          permission: {
            '*': 'deny',
            open_science_host_message_send_message: 'allow'
          }
        }
      }
    })
  })

  it('keeps Claude resumable with no built-in tool-loading surface', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-claude-'))
    const prepared = await prepareSideChatBackend(
      backend(claudeCodeFramework, { CLAUDE_CONFIG_DIR: '/profiles/shared-claude' }),
      temporaryRoot
    )

    expect(prepared.sessionOptions).toMatchObject({
      tools: [],
      skills: [],
      plugins: [],
      settings: {},
      settingSources: [],
      persistSession: true
    })
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe('/profiles/shared-claude')
    expect(prepared.systemPromptAppends?.join(' ')).toContain('Side chat')
  })

  it('persists token-authenticated Claude inside the Side chat profile', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-claude-token-'))
    const prepared = await prepareSideChatBackend(
      backend(claudeCodeFramework, {
        CLAUDE_CONFIG_DIR: '/profiles/shared-claude',
        CLAUDE_CODE_OAUTH_TOKEN: 'portable-token'
      }),
      temporaryRoot
    )

    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(join(temporaryRoot, 'claude'))
    expect(prepared.sessionOptions).toMatchObject({ persistSession: true })
  })

  it('keeps Codex provider state in the Side chat-owned home', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-codex-'))
    const prepared = await prepareSideChatBackend(backend(codexFramework), temporaryRoot)

    expect(prepared.env.CODEX_HOME).toBe(join(temporaryRoot, 'codex'))
    await expect(
      readFile(join(prepared.env.CODEX_HOME!, 'config.toml'), 'utf8')
    ).resolves.toContain('cli_auth_credentials_store = "ephemeral"')
    expect(prepared.systemPromptAppends?.join(' ')).toContain('Side chat')
  })
})

describe('SideChatRuntimeOwner lifecycle', () => {
  it('rejects oversized initial prompts before creating provider state', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-input-limit-'))
    const captureTarget = vi.fn(async () => target)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn()
    })

    await expect(
      owner.start({
        parentSessionId: 'main-oversized',
        projectId: 'project-1',
        text: 'x'.repeat(SIDE_CHAT_MESSAGE_LIMIT + 1)
      })
    ).rejects.toThrow('must not exceed 12,000 characters')
    expect(captureTarget).not.toHaveBeenCalled()
    expect(owner.hasForParent('main-oversized')).toBe(false)
  })

  it('rejects oversized follow-ups before provider dispatch or transcript mutation', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-follow-up-limit-'))
    let runtimeOptions: AcpRuntimeOptions | undefined
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'side-session-input-limit',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    const started = await owner.start({
      parentSessionId: 'main-follow-up-limit',
      projectId: 'project-1',
      text: 'Initial prompt'
    })
    const entriesBefore = owner.list().chats[0]?.entries

    await expect(
      owner.send({
        sideSessionId: started.sideSessionId,
        text: 'x'.repeat(SIDE_CHAT_MESSAGE_LIMIT + 1)
      })
    ).rejects.toThrow('must not exceed 12,000 characters')

    expect(sendPrompt).toHaveBeenCalledOnce()
    expect(owner.list().chats[0]?.entries).toEqual(entriesBefore)
    await owner.close({ sideSessionId: started.sideSessionId })
  })

  it('removes every leftover chat profile at startup because none can resume', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-sweep-'))
    const stale = join(temporaryRoot, 'runtime-support', 'side-chat', 'chat-leftover')
    await mkdir(stale, { recursive: true })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(),
      resolveTarget: vi.fn(),
      relay: createRelayOwner('completed'),
      persistence: createPersistence(),
      onEvent: vi.fn()
    })

    await owner.sweepStaleProfiles()

    await expect(access(stale)).rejects.toThrow()
  })

  it('sweeps only unreferenced profiles after a complete durable catalog scan', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-safe-sweep-'))
    const root = join(temporaryRoot, 'runtime-support', 'side-chat')
    const retained = join(root, 'side-chat-retained')
    const orphan = join(root, 'side-chat-orphan')
    await Promise.all([mkdir(retained, { recursive: true }), mkdir(orphan, { recursive: true })])
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(),
      resolveTarget: vi.fn(),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn()
    })

    await owner.sweepStaleProfiles(new Set(['side-chat-retained']), true)

    await expect(access(retained)).resolves.toBeUndefined()
    await expect(access(orphan)).rejects.toThrow()

    await mkdir(orphan, { recursive: true })
    await owner.sweepStaleProfiles(new Set(['side-chat-retained']), false)
    await expect(access(orphan)).resolves.toBeUndefined()
  })

  it('admits a first turn, binds the trusted MCP sender, and destroys the runtime on close', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-owner-'))
    const closeOrder: string[] = []
    const registerHostMessageSession = vi.fn()
    const unregisterHostMessageSession = vi.fn(() => {
      closeOrder.push('scope')
      return true
    })
    const resolved: ResolvedAgentBackend = {
      ...backend(claudeCodeFramework),
      responsesBridgeLease: {
        selectSkills: vi.fn(async () => []),
        registerReviewerSession: vi.fn(),
        unregisterReviewerSession: vi.fn(() => false),
        registerHostMessageSession,
        unregisterHostMessageSession,
        release: vi.fn(async () => undefined)
      }
    }
    const relay = createRelayOwner()
    const deliverRelay = vi.fn(async (_parentSessionId, queued) => queued)
    const setParentInteractionsPaused = vi.fn()
    let runtimeOptions: AcpRuntimeOptions | undefined
    const createSession = vi.fn(async () => ({
      sessionId: 'side-session-1',
      providerSessionId: 'provider-session-1',
      frameworkId: 'claude-code' as const
    }))
    const permissionDecision = deferred<{
      requestId: string
      optionId?: string
      cancelled?: boolean
    }>()
    const respondToPermission = vi.fn(async (decision) => {
      permissionDecision.resolve(decision)
      return true
    })
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      runtimeOptions!.callbacks?.onPermissionRequest?.({
        requestId: 'host-message-permission',
        sessionId: request.sessionId,
        toolCallId: 'host-message-call',
        title: 'mcp.open-science-host-message.send_message',
        providerToolName: 'send_message',
        isMcp: true,
        mcpIdentity: 'open-science-host-message/send_message',
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once', scope: 'once' },
          { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
        ]
      })
      const decision = await permissionDecision.promise
      if (decision.optionId !== 'allow-once') throw new Error('Host message permission was denied.')
      await runtimeOptions!.sideChat!.sendMessage('trusted-routing-1', {
        target: 'main',
        text: 'Use a black line.'
      })
      return { stopReason: 'end_turn' as const }
    })
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const shutdownForQuit = vi.fn(async () => {
      closeOrder.push('runtime')
    })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async (_target, context) => {
        expect(context.forceCodexNativeResponsesCompatibility).toBe(true)
        expect(context.includeSkillAndConnectorContext).toBe(false)
        return resolved
      }),
      relay,
      deliverRelay,
      persistence: createPersistence(),
      onEvent: vi.fn(),
      setParentInteractionsPaused,
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession,
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission,
          shutdownForQuit
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-session-1',
      projectId: 'project-1',
      text: 'What context do you have?',
      historyPreamble: 'Main snapshot.'
    })

    expect(started).toMatchObject({
      sideSessionId: expect.stringMatching(/^side-chat-/),
      frameworkId: 'claude-code',
      model: 'model-a'
    })
    expect(owner.hasForParent('main-session-1')).toBe(true)
    expect(setParentInteractionsPaused).toHaveBeenCalledWith('main-session-1', true)
    expect(runtimeOptions?.sessionCapabilityPolicy).toMatchObject({ role: 'side-chat' })
    expect(sendPrompt).toHaveBeenCalledWith({
      sessionId: 'side-session-1',
      text: 'What context do you have?',
      historyPreamble: 'Main snapshot.',
      resumeFallback: { historyPreamble: 'Main snapshot.' }
    })
    expect(registerHostMessageSession).toHaveBeenCalledWith(
      'provider-session-1',
      [expect.objectContaining({ name: 'send_message' })],
      { failClosedUnknownKeys: true }
    )
    expect(respondToPermission).toHaveBeenCalledWith({
      requestId: 'host-message-permission',
      optionId: 'allow-once'
    })
    expect(deliverRelay).toHaveBeenCalledWith(
      'main-session-1',
      expect.objectContaining({ status: 'queued', delivery: 'next-user-turn' })
    )
    const queuedRelay = relay.claim('main-session-1')
    expect(queuedRelay?.messages).toEqual([
      expect.objectContaining({ text: 'Use a black line.', sideSessionId: 'trusted-routing-1' })
    ])
    queuedRelay?.restore()

    await runtimeOptions?.sideChat?.sendMessage(started.sideSessionId, {
      target: 'main',
      text: 'Keep the labels.'
    })
    const reconnectedRelay = relay.claim('main-session-1')
    expect(reconnectedRelay?.messages).toEqual([
      expect.objectContaining({ text: 'Use a black line.', sideSessionId: 'trusted-routing-1' }),
      expect.objectContaining({ text: 'Keep the labels.', sideSessionId: started.sideSessionId })
    ])
    reconnectedRelay?.restore()

    await owner.closeForParent('main-session-1')

    expect(unregisterHostMessageSession).toHaveBeenCalledWith('provider-session-1')
    expect(closeOrder).toEqual(['runtime', 'scope'])
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'side-session-1' })
    expect(shutdownForQuit).toHaveBeenCalledOnce()
    expect(owner.hasForParent('main-session-1')).toBe(false)
    expect(setParentInteractionsPaused).toHaveBeenLastCalledWith('main-session-1', false)
    await expect(stat(join(temporaryRoot, 'runtime-support', 'side-chat'))).resolves.toBeDefined()
    expect(relay.claim('main-session-1')?.messages).toEqual([
      expect.objectContaining({ text: 'Use a black line.', sideSessionId: 'trusted-routing-1' }),
      expect.objectContaining({ text: 'Keep the labels.', sideSessionId: started.sideSessionId })
    ])
  })

  it('coalesces streamed transcript chunks into the latest durable projection', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-coalesce-'))
    const persistence = createPersistence()
    const recordUsage = vi.fn(async () => undefined)
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      recordUsage,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-coalesce',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            runtimeOptions!.callbacks?.onEvent?.({
              id: 'thought-private',
              messageId: 'assistant-coalesced:thought',
              timestamp: 0,
              sessionId: request.sessionId,
              kind: 'thought',
              role: 'assistant',
              text: 'private analysis'
            } as never)
            for (let index = 0; index < 100; index += 1) {
              runtimeOptions!.callbacks?.onEvent?.({
                id: `event-${index}`,
                messageId: 'assistant-coalesced',
                timestamp: index,
                sessionId: request.sessionId,
                kind: 'message',
                role: 'assistant',
                text: 'x'.repeat(200)
              } as never)
            }
            runtimeOptions!.callbacks?.onEvent?.({
              id: 'stop-coalesced',
              timestamp: 101,
              sessionId: request.sessionId,
              kind: 'stop',
              turnUsage: { inputTokens: 9, cacheTokens: 2, outputTokens: 3, turnCount: 1 }
            } as never)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-coalesce',
      projectId: 'project-1',
      text: 'Stream'
    })
    await expect(
      runtimeOptions!.auxiliaryUsage!.projectIdForSession('provider-coalesce')
    ).resolves.toBe('project-1')
    await runtimeOptions!.auxiliaryUsage!.record({
      projectId: 'project-1',
      sessionId: 'provider-coalesce',
      eventId: 'context-compaction:side-chat',
      source: 'context-compaction',
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      model: 'model-a',
      completedAtMs: 100,
      usage: { inputTokens: 7, cacheTokens: 1, outputTokens: 2, turnCount: 1 }
    })
    await vi.waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          sessionId: 'main-coalesce',
          eventId: `${started.sideSessionId}:user-1`,
          source: 'side-chat',
          frameworkId: 'claude-code',
          providerId: 'provider-a',
          model: 'model-a',
          completedAtMs: 101,
          usage: expect.objectContaining({ inputTokens: 9, outputTokens: 3 })
        })
      )
    )
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'main-coalesce',
        eventId: 'context-compaction:side-chat',
        source: 'context-compaction',
        providerId: 'provider-a'
      })
    )
    expect(owner.list().chats[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'assistant-coalesced', text: 'x'.repeat(20_000) })
      ])
    )
    expect(JSON.stringify(owner.list().chats[0]?.entries)).not.toContain('private analysis')
    expect(persistence.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sideChat: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              id: 'assistant-coalesced',
              text:
                '[Earlier message content truncated]\n' + 'x'.repeat(SIDE_CHAT_MESSAGE_LIMIT - 36)
            })
          ])
        })
      })
    )

    await owner.close({ sideSessionId: started.sideSessionId })
  })

  it('keeps send_message-like assistant text in the transcript without relaying it', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-text-tool-call-'))
    const relay = createRelayOwner()
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay,
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'side-session-text-tool-call',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            runtimeOptions!.callbacks?.onEvent?.({
              id: 'assistant-text-tool-call',
              messageId: 'assistant-text-tool-call',
              timestamp: 1,
              sessionId: request.sessionId,
              kind: 'message',
              role: 'assistant',
              text: '<send_message>draw a cosine curve</send_message>'
            } as never)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-text-tool-call',
      projectId: 'project-1',
      text: 'Draw a cosine curve.'
    })

    expect(owner.list().chats[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          text: '<send_message>draw a cosine curve</send_message>'
        })
      ])
    )
    expect(relay.claim('main-text-tool-call')).toBeUndefined()

    await owner.close({ sideSessionId: started.sideSessionId })
  })

  it('honors a panel close requested while the temporary runtime is starting', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-close-starting-'))
    let releaseTarget!: (value: ExplicitAgentBackendTarget) => void
    const pendingTarget = new Promise<ExplicitAgentBackendTarget>((resolve) => {
      releaseTarget = resolve
    })
    const captureTarget = vi.fn(() => pendingTarget)
    const sendPrompt = vi.fn()
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const shutdownForQuit = vi.fn(async () => undefined)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: () =>
        ({
          createSession: vi.fn(async () => ({
            sessionId: 'side-session-starting',
            frameworkId: 'claude-code'
          })),
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit
        }) as never
    })

    const start = owner.start({
      parentSessionId: 'main-session-starting',
      projectId: 'project-1',
      text: 'Hello'
    })
    const rejection = expect(start).rejects.toThrow('closed before startup completed')
    await vi.waitFor(() => expect(captureTarget).toHaveBeenCalledOnce())
    const close = owner.closeActiveForParent('main-session-starting')
    releaseTarget(target)

    await close
    await rejection
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'side-session-starting' })
    expect(shutdownForQuit).toHaveBeenCalledOnce()
  })

  it('rejects a preflighted start after authoritative parent deletion wins the race', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-invalid-parent-'))
    const captureTarget = vi.fn(async () => target)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn()
    })

    await owner.invalidateParents(['main-session-deleted'])

    await expect(
      owner.start({
        parentSessionId: 'main-session-deleted',
        projectId: 'project-1',
        text: 'Too late'
      })
    ).rejects.toThrow('parent Session is unavailable')
    expect(captureTarget).not.toHaveBeenCalled()
  })

  it('cleans a dormant provider profile after parent deletion without rewriting deleted JSON', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-parent-deleted-'))
    const persistence = createPersistence()
    const profile = join(temporaryRoot, 'runtime-support', 'side-chat', 'side-chat-parent-deleted')
    await mkdir(profile, { recursive: true })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(),
      resolveTarget: vi.fn(),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn()
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-parent-deleted',
        sideChat: {
          version: 1,
          id: 'side-chat-parent-deleted',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          historyPreamble: '',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await owner.invalidateParents(['main-parent-deleted'])

    expect(persistence.clear).not.toHaveBeenCalled()
    await expect(access(profile)).rejects.toThrow()
    expect(owner.list().chats).toEqual([])
  })

  it('invalidates every Side chat in a deleted Project and rejects concurrent starts', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-project-deleted-'))
    const persistence = createPersistence()
    const captureTarget = vi.fn()
    const relay = createRelayOwner()
    const deletedProfile = join(
      temporaryRoot,
      'runtime-support',
      'side-chat',
      'side-chat-project-deleted'
    )
    await mkdir(deletedProfile, { recursive: true })
    relay.hydrate([
      {
        projectId: 'project-deleted',
        parentSessionId: 'parent-deleted',
        relays: [
          {
            sideChatId: 'side-chat-project-deleted',
            id: 'relay-deleted',
            text: 'Do not deliver after deletion.',
            createdAt: 10
          }
        ]
      },
      {
        projectId: 'project-kept',
        parentSessionId: 'parent-kept',
        relays: [
          {
            sideChatId: 'side-chat-project-kept',
            id: 'relay-kept',
            text: 'Keep this advisory.',
            createdAt: 20
          }
        ]
      }
    ])
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget: vi.fn(),
      relay,
      persistence,
      onEvent: vi.fn()
    })
    owner.hydrate([
      {
        projectId: 'project-deleted',
        parentSessionId: 'parent-deleted',
        sideChat: {
          version: 1,
          id: 'side-chat-project-deleted',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          historyPreamble: '',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      },
      {
        projectId: 'project-kept',
        parentSessionId: 'parent-kept',
        sideChat: {
          version: 1,
          id: 'side-chat-project-kept',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          historyPreamble: '',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await owner.invalidateProject('project-deleted')
    await owner.invalidateParents(['parent-deleted'])
    const deletedRelayClaim = relay.claim('parent-deleted')

    expect(owner.list().chats).toEqual([
      expect.objectContaining({ parentSessionId: 'parent-kept', projectId: 'project-kept' })
    ])
    await expect(access(deletedProfile)).resolves.toBeUndefined()
    expect(deletedRelayClaim?.messages).toEqual([expect.objectContaining({ id: 'relay-deleted' })])
    expect(persistence.clear).not.toHaveBeenCalled()
    await expect(
      owner.start({
        parentSessionId: 'another-parent',
        projectId: 'project-deleted',
        text: 'Too late'
      })
    ).rejects.toThrow('parent Project is unavailable')
    expect(captureTarget).not.toHaveBeenCalled()

    owner.restoreProject('project-deleted')

    expect(owner.list().chats).toEqual([
      expect.objectContaining({ parentSessionId: 'parent-deleted', projectId: 'project-deleted' }),
      expect.objectContaining({ parentSessionId: 'parent-kept', projectId: 'project-kept' })
    ])
    captureTarget.mockRejectedValueOnce(new Error('backend unavailable'))
    await expect(
      owner.start({
        parentSessionId: 'another-parent',
        projectId: 'project-deleted',
        text: 'Available after rollback'
      })
    ).rejects.toThrow('backend unavailable')
    expect(captureTarget).toHaveBeenCalledOnce()

    await owner.invalidateProject('project-deleted')
    await owner.completeProjectDeletion('project-deleted')
    await expect(access(deletedProfile)).rejects.toThrow()
    expect(deletedRelayClaim?.commit()).toEqual([])
    deletedRelayClaim?.restore()
    expect(relay.claim('parent-deleted')).toBeUndefined()
    expect(relay.claim('parent-kept')?.messages).toEqual([
      expect.objectContaining({ id: 'relay-kept' })
    ])
    owner.restoreProject('project-deleted')
    expect(owner.list().chats).toEqual([
      expect.objectContaining({ parentSessionId: 'parent-kept', projectId: 'project-kept' })
    ])
  })

  it('retains dormant Side chats when Project profile cleanup fails', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-project-cleanup-'))
    const relay = createRelayOwner()
    relay.hydrate([
      {
        projectId: 'project-deleted',
        parentSessionId: 'parent-deleted',
        relays: [
          {
            sideChatId: 'side-chat-\u0000-invalid',
            id: 'relay-retry',
            text: 'Retain until cleanup succeeds.',
            createdAt: 10
          }
        ]
      }
    ])
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(),
      resolveTarget: vi.fn(),
      relay,
      persistence: createPersistence(),
      onEvent: vi.fn()
    })
    owner.hydrate([
      {
        projectId: 'project-deleted',
        parentSessionId: 'parent-deleted',
        sideChat: {
          version: 1,
          id: 'side-chat-\u0000-invalid',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          historyPreamble: '',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])
    await owner.invalidateProject('project-deleted')

    await expect(owner.completeProjectDeletion('project-deleted')).rejects.toThrow(
      'Side chat Project cleanup failed: project-deleted'
    )
    const retryRelayClaim = relay.claim('parent-deleted')
    expect(retryRelayClaim?.messages).toEqual([expect.objectContaining({ id: 'relay-retry' })])
    retryRelayClaim?.restore()

    owner.restoreProject('project-deleted')
    expect(owner.list().chats).toEqual([
      expect.objectContaining({
        parentSessionId: 'parent-deleted',
        projectId: 'project-deleted'
      })
    ])
  })

  it('publishes a terminal lifecycle event and keeps a disconnected runtime dormant', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-disconnected-'))
    let runtimeOptions: AcpRuntimeOptions | undefined
    const onEvent = vi.fn()
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent,
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'side-session-disconnected',
            frameworkId: 'claude-code'
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-session-disconnected',
      projectId: 'project-1',
      text: 'Hello'
    })
    runtimeOptions?.callbacks?.onStateChanged?.({ status: 'error' } as never)

    expect(onEvent).toHaveBeenCalledWith({
      revision: expect.any(Number),
      parentSessionId: 'main-session-disconnected',
      projectId: 'project-1',
      sideSessionId: started.sideSessionId,
      event: { kind: 'closed', reason: 'connection-error' }
    })
    await vi.waitFor(() =>
      expect(owner.list().chats).toContainEqual(
        expect.objectContaining({
          sideSessionId: started.sideSessionId,
          running: false,
          error: expect.stringContaining('reconnect')
        })
      )
    )
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('hydrates a dormant Side chat without starting ACP and resumes it on the next Follow up', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-resume-'))
    const persistence = createPersistence()
    const recordUsage = vi.fn(async () => undefined)
    const resumeSession = vi.fn(async () => ({
      sessionId: 'side-chat-restored',
      providerSessionId: 'provider-restored',
      frameworkId: 'claude-code' as const,
      backendId: 'claude-code:provider-a'
    }))
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    const createRuntime = vi.fn((options: AcpRuntimeOptions) => {
      runtimeOptions = options
      return {
        createSession: vi.fn(),
        resumeSession,
        sendPrompt,
        cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
        deleteSession: vi.fn(async () => ({ sessionIds: [] })),
        respondToPermission: vi.fn(async () => undefined),
        shutdownForQuit: vi.fn(async () => undefined)
      } as never
    })
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => ({
        ...backend(claudeCodeFramework),
        backendId: 'claude-code:provider-a'
      })),
      relay: createRelayOwner(),
      persistence,
      recordUsage,
      onEvent: vi.fn(),
      createRuntime
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-restored',
        sideChat: {
          version: 1,
          id: 'side-chat-restored',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          providerId: 'provider-a',
          backendId: 'claude-code:provider-a',
          providerSessionId: 'provider-restored',
          historyPreamble: 'Original Main snapshot.',
          entries: [
            { id: 'user-1001', kind: 'message', role: 'user', text: 'Earlier question' },
            { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Earlier answer' }
          ],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    expect(createRuntime).not.toHaveBeenCalled()
    expect(owner.list().chats).toEqual([
      expect.objectContaining({
        parentSessionId: 'main-restored',
        sideSessionId: 'side-chat-restored',
        running: false
      })
    ])

    await owner.send({ sideSessionId: 'side-chat-restored', text: 'Continue' })

    await expect(
      runtimeOptions!.auxiliaryUsage!.projectIdForSession('side-chat-restored')
    ).resolves.toBe('project-1')
    await runtimeOptions!.auxiliaryUsage!.record({
      projectId: 'project-1',
      sessionId: 'side-chat-restored',
      eventId: 'context-compaction:restored-side-chat',
      source: 'context-compaction',
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      completedAtMs: 30,
      usage: { inputTokens: 5, cacheTokens: 0, outputTokens: 1, turnCount: 1 }
    })

    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: 'side-chat-restored',
      providerSessionId: 'provider-restored',
      cwd: join(temporaryRoot, 'runtime-support', 'side-chat', 'side-chat-restored', 'cwd'),
      projectId: 'project-1',
      previousFrameworkId: 'claude-code',
      previousBackendId: 'claude-code:provider-a'
    })
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'side-chat-restored', text: 'Continue' })
    )
    expect(sendPrompt.mock.calls[0]?.[0]).not.toHaveProperty('historyPreamble')
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'main-restored',
        eventId: 'context-compaction:restored-side-chat',
        source: 'context-compaction',
        providerId: 'provider-a'
      })
    )
    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'main-restored',
        sideChat: expect.objectContaining({
          id: 'side-chat-restored',
          entries: expect.arrayContaining([
            expect.objectContaining({ id: 'user-1002', role: 'user', text: 'Continue' })
          ])
        })
      })
    )
  })

  it('scopes every Responses bridge resolved while a dormant Side chat resumes', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-resume-bridge-'))
    const registrations = [vi.fn(), vi.fn()]
    const bridges = registrations.map((registerHostMessageSession) => ({
      selectSkills: vi.fn(async () => []),
      registerReviewerSession: vi.fn(),
      unregisterReviewerSession: vi.fn(() => false),
      registerHostMessageSession,
      unregisterHostMessageSession: vi.fn(() => true),
      release: vi.fn(async () => undefined)
    }))
    let resolution = 0
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => ({ ...target, frameworkId: 'codex' as const })),
      resolveTarget: vi.fn(async () => ({
        ...backend(codexFramework),
        backendId: 'codex:provider-a',
        responsesBridgeLease: bridges[Math.min(resolution++, bridges.length - 1)]
      })),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(),
          resumeSession: vi.fn(async () => {
            await options.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
            await options.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
            return {
              sessionId: 'side-chat-restored',
              providerSessionId: 'provider-restored',
              frameworkId: 'codex' as const,
              backendId: 'codex:provider-a'
            }
          }),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-restored',
        sideChat: {
          version: 1,
          id: 'side-chat-restored',
          lifecycle: 'open',
          frameworkId: 'codex',
          backendId: 'codex:provider-a',
          providerSessionId: 'provider-restored',
          historyPreamble: 'Original Main snapshot.',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await owner.send({ sideSessionId: 'side-chat-restored', text: 'Continue' })

    for (const registerHostMessageSession of registrations) {
      expect(registerHostMessageSession).toHaveBeenCalledWith(
        'provider-restored',
        [expect.objectContaining({ name: 'send_message' })],
        { failClosedUnknownKeys: true }
      )
      expect(registerHostMessageSession).not.toHaveBeenCalledWith(
        'side-chat-restored',
        expect.any(Array),
        expect.any(Object)
      )
    }
  })

  it('rolls back an unadmitted follow-up when its durable write fails', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-save-retry-'))
    const persistence = createPersistence()
    let runtimeOptions: AcpRuntimeOptions | undefined
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-save-retry',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    const started = await owner.start({
      parentSessionId: 'main-save-retry',
      projectId: 'project-1',
      text: 'Initial turn'
    })
    await vi.waitFor(() => expect(persistence.save.mock.calls.length).toBeGreaterThanOrEqual(2))
    persistence.save.mockRejectedValueOnce(new Error('Session file is busy'))

    await expect(
      owner.send({ sideSessionId: started.sideSessionId, text: 'Retry this exact turn' })
    ).rejects.toThrow('Session file is busy')
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(owner.list().chats).toContainEqual(
      expect.objectContaining({
        sideSessionId: started.sideSessionId,
        running: false,
        entries: [expect.objectContaining({ kind: 'message', role: 'user', text: 'Initial turn' })]
      })
    )

    await owner.send({ sideSessionId: started.sideSessionId, text: 'Retry this exact turn' })
    expect(sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('restores dormant ownership when resumed identity persistence fails', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-resume-save-retry-'))
    const persistence = createPersistence()
    persistence.save.mockRejectedValueOnce(new Error('Session file is busy'))
    let runtimeNumber = 0
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        runtimeNumber += 1
        return {
          createSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionId: `provider-resume-${runtimeNumber}`,
            providerSessionId: `provider-resume-${runtimeNumber}`,
            frameworkId: 'claude-code' as const
          })),
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-resume-save-retry',
        sideChat: {
          version: 1,
          id: 'side-chat-resume-save-retry',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          providerSessionId: 'provider-old',
          historyPreamble: 'Main snapshot.',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await expect(
      owner.send({ sideSessionId: 'side-chat-resume-save-retry', text: 'First attempt' })
    ).rejects.toThrow('Session file is busy')
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(owner.list().chats).toContainEqual(
      expect.objectContaining({
        sideSessionId: 'side-chat-resume-save-retry',
        running: false,
        error: expect.stringContaining('reconnect')
      })
    )

    await owner.send({ sideSessionId: 'side-chat-resume-save-retry', text: 'Second attempt' })
    expect(runtimeNumber).toBe(2)
    expect(sendPrompt).toHaveBeenCalledOnce()
  })

  it('injects bounded replay only when dormant provider resume adopts fresh context', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-replay-'))
    let runtimeOptions: AcpRuntimeOptions | undefined
    const sent: Array<Record<string, unknown>> = []
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionId: 'side-chat-reset',
            providerSessionId: 'provider-new',
            frameworkId: 'claude-code' as const,
            contextReset: true
          })),
          sendPrompt: vi.fn(async (request: Record<string, unknown>) => {
            sent.push(request)
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId as string)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-reset',
        sideChat: {
          version: 1,
          id: 'side-chat-reset',
          lifecycle: 'interrupted',
          frameworkId: 'claude-code',
          providerSessionId: 'provider-old',
          historyPreamble: 'Original Main snapshot.',
          entries: [
            { id: 'user-1', kind: 'message', role: 'user', text: 'Earlier question' },
            { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Earlier answer' }
          ],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await owner.send({ sideSessionId: 'side-chat-reset', text: 'Continue after restart' })

    expect(sent[0]).toMatchObject({
      sessionId: 'side-chat-reset',
      text: 'Continue after restart',
      historyPreamble: expect.stringContaining('Original Main snapshot.'),
      resumeFallback: { historyPreamble: expect.stringContaining('Earlier answer') }
    })
    expect(String(sent[0].historyPreamble)).not.toContain('Continue after restart')
  })

  it('retains context-reset replay until the provider admits a follow-up', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-replay-admission-'))
    let runtimeOptions: AcpRuntimeOptions | undefined
    const sent: Array<Record<string, unknown>> = []
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(),
          resumeSession: vi.fn(async () => ({
            sessionId: 'side-chat-replay-admission',
            providerSessionId: 'provider-new',
            frameworkId: 'claude-code' as const,
            contextReset: true
          })),
          sendPrompt: vi.fn(async (request: Record<string, unknown>) => {
            sent.push(request)
            if (sent.length === 1) throw new Error('Provider rejected before admission')
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId as string)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-replay-admission',
        sideChat: {
          version: 1,
          id: 'side-chat-replay-admission',
          lifecycle: 'interrupted',
          frameworkId: 'claude-code',
          providerSessionId: 'provider-old',
          historyPreamble: 'Original Main snapshot.',
          entries: [
            { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Earlier answer' }
          ],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    await expect(
      owner.send({ sideSessionId: 'side-chat-replay-admission', text: 'First attempt' })
    ).rejects.toThrow('before admission')
    await owner.send({ sideSessionId: 'side-chat-replay-admission', text: 'Retry attempt' })

    expect(sent[0]).toMatchObject({
      historyPreamble: expect.stringContaining('Earlier answer')
    })
    expect(sent[1]).toMatchObject({
      historyPreamble: expect.stringContaining('First attempt')
    })
  })

  it('lets close win while a dormant provider Session is reconnecting', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-close-resume-'))
    const persistence = createPersistence()
    const resumed = deferred<{
      sessionId: string
      providerSessionId: string
      frameworkId: 'claude-code'
    }>()
    const resumeSession = vi.fn(() => resumed.promise)
    const sendPrompt = vi.fn()
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: () =>
        ({
          createSession: vi.fn(),
          resumeSession,
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        }) as never
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-close-resume',
        sideChat: {
          version: 1,
          id: 'side-chat-close-resume',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          providerSessionId: 'provider-old',
          historyPreamble: 'Main snapshot.',
          entries: [{ id: 'user-1', kind: 'message', role: 'user', text: 'Earlier' }],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    const send = owner.send({ sideSessionId: 'side-chat-close-resume', text: 'Continue' })
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledOnce())
    const close = owner.close({ sideSessionId: 'side-chat-close-resume' })
    resumed.resolve({
      sessionId: 'provider-restored',
      providerSessionId: 'provider-restored',
      frameworkId: 'claude-code'
    })

    await expect(send).rejects.toThrow('closed while reconnecting')
    await close
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(persistence.clear).toHaveBeenCalledWith({
      projectId: 'project-1',
      parentSessionId: 'main-close-resume',
      sideChatId: 'side-chat-close-resume'
    })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'provider-restored' })
    expect(owner.list().chats).toEqual([])
  })

  it('hot-switches models in place and replays only after an incompatible reconnect', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-reconfigure-'))
    let selectedFramework: ResolvedAgentBackend['framework'] = claudeCodeFramework
    let runtimeOptions: AcpRuntimeOptions | undefined
    let initialBackendConsumed = false
    const captureTarget = vi.fn(async () => ({
      ...target,
      frameworkId: selectedFramework.id
    }))
    const registerHostMessageSession = vi.fn()
    const unregisterHostMessageSession = vi.fn(() => true)
    const resolveTarget = vi.fn(async (capturedTarget: ExplicitAgentBackendTarget) => {
      const resolved = backend(
        capturedTarget.frameworkId === 'opencode' ? opencodeFramework : claudeCodeFramework
      )
      return capturedTarget.frameworkId === 'opencode'
        ? {
            ...resolved,
            responsesBridgeLease: {
              selectSkills: vi.fn(async () => []),
              registerReviewerSession: vi.fn(),
              unregisterReviewerSession: vi.fn(() => false),
              registerHostMessageSession,
              unregisterHostMessageSession,
              release: vi.fn(async () => undefined)
            }
          }
        : resolved
    })
    const applyModelChange = vi.fn(async () => true)
    const requestProviderReconnect = vi.fn(async () => {
      await runtimeOptions?.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
    })
    const resumeSession = vi.fn(async () => ({
      sessionId:
        selectedFramework.id === 'opencode'
          ? 'side-session-reconfigured'
          : 'side-session-reconfigure',
      providerSessionId:
        selectedFramework.id === 'opencode'
          ? 'provider-session-reconfigured'
          : 'side-session-reconfigure',
      frameworkId: selectedFramework.id,
      ...(selectedFramework.id === 'opencode' ? { contextReset: true } : {})
    }))
    const sent: Array<Record<string, unknown>> = []
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget,
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => {
            if (!initialBackendConsumed) {
              initialBackendConsumed = true
              await options.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
            }
            return {
              sessionId: 'side-session-reconfigure',
              frameworkId: 'claude-code' as const
            }
          }),
          resumeSession,
          sendPrompt: vi.fn(async (request: Record<string, unknown>) => {
            sent.push(request)
            options.callbacks?.onProviderPromptAccepted?.(request.sessionId as string)
            if (sent.length === 1) {
              options.callbacks?.onEvent?.({
                id: 'assistant-1',
                timestamp: 1,
                sessionId: 'side-session-reconfigure',
                kind: 'message',
                role: 'assistant',
                text: 'First answer.'
              } as never)
            }
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          requestProviderReconnect,
          applyModelChange,
          applyReasoningEffortChange: vi.fn(async () => true),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-session-reconfigure',
      projectId: 'project-1',
      text: 'First question',
      historyPreamble: 'Main snapshot.'
    })
    await expect(owner.applyModelChange(modelChangeTarget('model-b'))).resolves.toBe(true)
    expect(applyModelChange).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).not.toHaveBeenCalled()
    await Promise.resolve()
    await owner.send({ sideSessionId: started.sideSessionId, text: 'After model switch' })
    expect(sent[1]).not.toHaveProperty('historyPreamble')
    expect(resumeSession).not.toHaveBeenCalled()
    await Promise.resolve()

    selectedFramework = opencodeFramework
    await owner.requestProviderReconnect()
    await owner.send({ sideSessionId: started.sideSessionId, text: 'Follow up' })

    expect(captureTarget).toHaveBeenCalledTimes(2)
    expect(resolveTarget.mock.calls[1]?.[0]).toMatchObject({ frameworkId: 'opencode' })
    expect(resumeSession).toHaveBeenLastCalledWith({
      sessionId: 'side-session-reconfigure',
      providerSessionId: 'side-session-reconfigure',
      cwd: join(temporaryRoot, 'runtime-support', 'side-chat', started.sideSessionId, 'cwd'),
      projectId: 'project-1',
      previousFrameworkId: 'claude-code',
      previousBackendId: 'claude-code:provider-a'
    })
    expect(sent[2]).toMatchObject({
      sessionId: 'side-session-reconfigured',
      text: 'Follow up',
      historyPreamble: expect.stringContaining('First answer.'),
      resumeFallback: { historyPreamble: expect.stringContaining('First question') }
    })
    expect(String(sent[2]?.historyPreamble)).not.toContain('User: Follow up')
    expect(registerHostMessageSession).toHaveBeenCalledWith(
      'side-session-reconfigure',
      expect.any(Array),
      { failClosedUnknownKeys: true }
    )
    expect(registerHostMessageSession).toHaveBeenCalledWith(
      'provider-session-reconfigured',
      expect.any(Array),
      { failClosedUnknownKeys: true }
    )
    expect(registerHostMessageSession).not.toHaveBeenCalledWith(
      'side-session-reconfigured',
      expect.any(Array),
      expect.any(Object)
    )

    await owner.close({ sideSessionId: started.sideSessionId })
    expect(unregisterHostMessageSession).toHaveBeenCalledWith('side-session-reconfigure')
    expect(unregisterHostMessageSession).toHaveBeenCalledWith('provider-session-reconfigured')
  })

  it('retains context-reset replay when reconnect identity persistence fails', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-reconnect-save-retry-'))
    const persistence = createPersistence()
    let runtimeOptions: AcpRuntimeOptions | undefined
    const sent: Array<Record<string, unknown>> = []
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => ({
        ...backend(claudeCodeFramework),
        backendId: 'claude-code:provider-a'
      })),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-before-reset',
            providerSessionId: 'provider-before-reset',
            frameworkId: 'claude-code' as const,
            backendId: 'claude-code:provider-a'
          })),
          resumeSession: vi.fn(async () => ({
            sessionId: 'provider-after-reset',
            providerSessionId: 'provider-after-reset',
            frameworkId: 'claude-code' as const,
            backendId: 'claude-code:provider-a',
            contextReset: true
          })),
          sendPrompt: vi.fn(async (request: Record<string, unknown>) => {
            sent.push(request)
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId as string)
            if (sent.length === 1) {
              runtimeOptions!.callbacks?.onEvent?.({
                id: 'assistant-before-reset',
                messageId: 'assistant-before-reset',
                timestamp: 1,
                sessionId: request.sessionId as string,
                kind: 'message',
                role: 'assistant',
                text: 'Initial answer.'
              } as never)
            }
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          requestProviderReconnect: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    const started = await owner.start({
      parentSessionId: 'main-reconnect-save-retry',
      projectId: 'project-1',
      text: 'Initial question'
    })
    await vi.waitFor(() => expect(persistence.save.mock.calls.length).toBeGreaterThanOrEqual(2))
    await owner.requestProviderReconnect()
    persistence.save.mockRejectedValueOnce(new Error('Session file is busy'))

    await expect(
      owner.send({ sideSessionId: started.sideSessionId, text: 'Failed follow-up' })
    ).rejects.toThrow('Session file is busy')
    expect(sent).toHaveLength(1)

    await owner.send({ sideSessionId: started.sideSessionId, text: 'Retry follow-up' })
    expect(sent[1]).toMatchObject({
      sessionId: 'provider-after-reset',
      text: 'Retry follow-up',
      historyPreamble: expect.stringContaining('Initial answer.')
    })
    expect(String(sent[1]?.historyPreamble)).not.toContain('Failed follow-up')
  })

  it('keeps durable state and blocks prompt admission until a handoff is released', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-shutdown-'))
    const persistence = createPersistence()
    let runtimeOptions: AcpRuntimeOptions | undefined
    let finishTurn!: () => void
    const turn = new Promise<{ stopReason: 'cancelled' }>((resolve) => {
      finishTurn = () => resolve({ stopReason: 'cancelled' })
    })
    const cancelPrompt = vi.fn(async () => {
      finishTurn()
      return { stopReason: 'cancelled' as const }
    })
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const shutdownForQuit = vi.fn(async () => undefined)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-shutdown',
            frameworkId: 'claude-code' as const
          })),
          resumeSession: vi.fn(async () => ({
            sessionId: 'provider-shutdown',
            providerSessionId: 'provider-shutdown',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn((request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return turn
          }),
          cancelPrompt,
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-shutdown',
      projectId: 'project-1',
      text: 'Still running'
    })
    await owner.suspendAll({ holdAdmission: true })

    expect(cancelPrompt).toHaveBeenCalledWith({ sessionId: 'provider-shutdown' })
    expect(deleteSession).not.toHaveBeenCalled()
    expect(persistence.clear).not.toHaveBeenCalled()
    expect(shutdownForQuit).toHaveBeenCalledOnce()
    expect(persistence.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sideChat: expect.objectContaining({
          id: started.sideSessionId,
          lifecycle: 'interrupted'
        })
      })
    )
    expect(owner.list().chats).toContainEqual(
      expect.objectContaining({
        sideSessionId: started.sideSessionId,
        running: false,
        error: expect.stringContaining('interrupted')
      })
    )
    await expect(
      stat(join(temporaryRoot, 'runtime-support', 'side-chat', started.sideSessionId))
    ).resolves.toBeDefined()

    await expect(
      owner.send({ sideSessionId: started.sideSessionId, text: 'Blocked during handoff' })
    ).rejects.toThrow('Side chat is shutting down.')

    owner.resumeAfterHandoff()
    await expect(
      owner.send({ sideSessionId: started.sideSessionId, text: 'Continue after handoff' })
    ).resolves.toBeUndefined()

    await owner.suspendAll()
    await expect(
      owner.send({
        sideSessionId: started.sideSessionId,
        text: 'Continue after ordinary suspension'
      })
    ).resolves.toBeUndefined()
    await owner.close({ sideSessionId: started.sideSessionId })
  })

  it('waits for an admitted prompt before completing handoff suspension', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-handoff-dispatch-'))
    const persistence = createPersistence()
    const followUpSave = deferred<void>()
    let blockedFollowUpSave = false
    persistence.save.mockImplementation(async (input) => {
      if (
        !blockedFollowUpSave &&
        input.sideChat.entries.some(
          (entry) => entry.kind === 'message' && entry.text === 'Admitted before handoff'
        )
      ) {
        blockedFollowUpSave = true
        await followUpSave.promise
      }
      return input.sideChat
    })

    let runtimeOptions: AcpRuntimeOptions | undefined
    const followUpTurn = deferred<{ stopReason: 'cancelled' }>()
    let promptCount = 0
    const sendPrompt = vi.fn((request: { sessionId: string }) => {
      promptCount += 1
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
      if (promptCount === 1) return Promise.resolve({ stopReason: 'end_turn' as const })
      return followUpTurn.promise
    })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-handoff-dispatch',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt,
          cancelPrompt: vi.fn(async () => {
            followUpTurn.resolve({ stopReason: 'cancelled' })
            return { stopReason: 'cancelled' as const }
          }),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-handoff-dispatch',
      projectId: 'project-1',
      text: 'Initial question'
    })
    await vi.waitFor(() => expect(owner.list().chats[0]?.running).toBe(false))

    const send = owner.send({
      sideSessionId: started.sideSessionId,
      text: 'Admitted before handoff'
    })
    await vi.waitFor(() => expect(blockedFollowUpSave).toBe(true))
    const suspension = owner.suspendAll({ holdAdmission: true })
    followUpSave.resolve()
    await expect(send).rejects.toThrow('Side chat is shutting down.')
    await suspension
    expect(sendPrompt).toHaveBeenCalledOnce()
    expect(persistence.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sideChat: expect.objectContaining({
          lifecycle: 'interrupted',
          entries: expect.arrayContaining([
            expect.objectContaining({ text: 'Admitted before handoff' })
          ])
        })
      })
    )
  })

  it('waits for dormant activation and blocks prompt admission during app shutdown', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-shutdown-resume-'))
    const resumed = deferred<{
      sessionId: string
      providerSessionId: string
      frameworkId: 'claude-code'
    }>()
    const resumeSession = vi.fn(() => resumed.promise)
    const sendPrompt = vi.fn()
    const shutdownForQuit = vi.fn(async () => undefined)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: () =>
        ({
          createSession: vi.fn(),
          resumeSession,
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit
        }) as never
    })
    owner.hydrate([
      {
        projectId: 'project-1',
        parentSessionId: 'main-shutdown-resume',
        sideChat: {
          version: 1,
          id: 'side-chat-shutdown-resume',
          lifecycle: 'open',
          frameworkId: 'claude-code',
          providerSessionId: 'provider-old',
          historyPreamble: 'Main snapshot.',
          entries: [],
          createdAt: 10,
          updatedAt: 20
        }
      }
    ])

    const send = owner.send({ sideSessionId: 'side-chat-shutdown-resume', text: 'Continue' })
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledOnce())
    let shutdownFinished = false
    const shutdown = owner.shutdown().then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    resumed.resolve({
      sessionId: 'provider-restored',
      providerSessionId: 'provider-restored',
      frameworkId: 'claude-code'
    })

    await expect(send).rejects.toThrow('shutting down')
    await shutdown
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(shutdownForQuit).toHaveBeenCalledOnce()
  })

  it('reports a final durable write failure while still shutting down the provider', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-shutdown-save-fail-'))
    const persistence = createPersistence()
    let runtimeOptions: AcpRuntimeOptions | undefined
    const shutdownForQuit = vi.fn(async () => undefined)
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'provider-shutdown-save-fail',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit
        } as never
      }
    })
    const started = await owner.start({
      parentSessionId: 'main-shutdown-save-fail',
      projectId: 'project-1',
      text: 'Initial turn'
    })
    await vi.waitFor(() => expect(persistence.save.mock.calls.length).toBeGreaterThanOrEqual(2))
    persistence.save.mockRejectedValueOnce(new Error('Session file is busy'))

    await expect(owner.shutdown()).rejects.toThrow(
      'Side chat shutdown did not persist every conversation.'
    )
    expect(shutdownForQuit).toHaveBeenCalledOnce()
    expect(owner.list().chats).toContainEqual(
      expect.objectContaining({
        sideSessionId: started.sideSessionId,
        running: false,
        error: expect.stringContaining('reconnect')
      })
    )
  })

  it('drains a failed in-flight close before Project invalidation and keeps it retryable', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-close-retry-'))
    const persistence = createPersistence()
    const clearStarted = deferred<void>()
    const failClear = deferred<void>()
    persistence.clear.mockImplementationOnce(async () => {
      clearStarted.resolve()
      await failClear.promise
      throw new Error('Session file is busy')
    })
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence,
      onEvent: vi.fn(),
      createRuntime: (options) =>
        ({
          createSession: vi.fn(async () => ({
            sessionId: 'provider-close-retry',
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            options.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(async () => undefined)
        }) as never
    })
    const started = await owner.start({
      parentSessionId: 'main-close-retry',
      projectId: 'project-1',
      text: 'Hello'
    })

    const closeFailure = expect(
      owner.close({ sideSessionId: started.sideSessionId })
    ).rejects.toThrow('Session file is busy')
    await clearStarted.promise
    const invalidationFailure = expect(owner.invalidateProject('project-1')).rejects.toThrow(
      'Side chat Project invalidation failed: project-1'
    )
    failClear.resolve()

    await Promise.all([closeFailure, invalidationFailure])
    expect(deleteSession).not.toHaveBeenCalled()
    owner.restoreProject('project-1')
    expect(owner.list().chats).toContainEqual(
      expect.objectContaining({ sideSessionId: started.sideSessionId })
    )

    await owner.close({ sideSessionId: started.sideSessionId })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'provider-close-retry' })
    expect(owner.list().chats).toEqual([])
  })

  it('keeps independent Side chat Sessions for different parent Sessions', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-concurrent-'))
    const shutdowns: Array<ReturnType<typeof vi.fn>> = []
    let runtimeNumber = 0
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeNumber += 1
        const sideSessionId = `side-session-${runtimeNumber}`
        const shutdownForQuit = vi.fn(async () => undefined)
        shutdowns.push(shutdownForQuit)
        return {
          createSession: vi.fn(async () => ({
            sessionId: sideSessionId,
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            options.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit
        } as never
      }
    })

    const first = await owner.start({
      parentSessionId: 'main-session-1',
      projectId: 'project-1',
      text: 'First parent'
    })
    await expect(
      owner.start({
        parentSessionId: 'main-session-1',
        projectId: 'project-1',
        text: 'Duplicate parent'
      })
    ).rejects.toThrow('already open')
    const second = await owner.start({
      parentSessionId: 'main-session-2',
      projectId: 'project-1',
      text: 'Second parent'
    })

    expect(owner.list().chats).toEqual([
      expect.objectContaining({
        parentSessionId: 'main-session-1',
        sideSessionId: first.sideSessionId
      }),
      expect.objectContaining({
        parentSessionId: 'main-session-2',
        sideSessionId: second.sideSessionId
      })
    ])

    await owner.close({ sideSessionId: first.sideSessionId })

    expect(shutdowns[0]).toHaveBeenCalledOnce()
    expect(shutdowns[1]).not.toHaveBeenCalled()
    expect(owner.list().chats).toEqual([
      expect.objectContaining({
        parentSessionId: 'main-session-2',
        sideSessionId: second.sideSessionId
      })
    ])
    await owner.close({ sideSessionId: second.sideSessionId })
  })

  it('fans Settings runtime changes out to every live Side chat', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-settings-fanout-'))
    const modelChanges: Array<ReturnType<typeof vi.fn>> = []
    const reasoningChanges: Array<ReturnType<typeof vi.fn>> = []
    const reconnects: Array<ReturnType<typeof vi.fn>> = []
    let runtimeNumber = 0
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeNumber += 1
        const sideSessionId = `side-settings-${runtimeNumber}`
        const applyModelChange = vi.fn(async () => true)
        const applyReasoningEffortChange = vi.fn(async () => true)
        const requestProviderReconnect = vi.fn(async () => undefined)
        modelChanges.push(applyModelChange)
        reasoningChanges.push(applyReasoningEffortChange)
        reconnects.push(requestProviderReconnect)
        return {
          createSession: vi.fn(async () => ({
            sessionId: sideSessionId,
            frameworkId: 'claude-code' as const
          })),
          resumeSession: vi.fn(async () => ({
            sessionId: sideSessionId,
            frameworkId: 'claude-code' as const
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            options.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          requestProviderReconnect,
          applyModelChange,
          applyReasoningEffortChange,
          shutdownForQuit: vi.fn(async () => undefined)
        } as never
      }
    })
    await owner.start({ parentSessionId: 'main-a', projectId: 'project-1', text: 'A' })
    await owner.start({ parentSessionId: 'main-b', projectId: 'project-1', text: 'B' })

    await expect(owner.applyModelChange(modelChangeTarget('model-b'))).resolves.toBe(true)
    await expect(owner.applyReasoningEffortChange('high')).resolves.toBe(true)
    await owner.requestProviderReconnect()

    for (const apply of modelChanges) expect(apply).toHaveBeenCalledOnce()
    for (const apply of reasoningChanges) expect(apply).toHaveBeenCalledWith('high')
    for (const reconnect of reconnects) expect(reconnect).toHaveBeenCalledOnce()
    await owner.shutdown()
  })

  it('does not admit another Side chat until asynchronous teardown finishes', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-close-drain-'))
    let finishShutdown!: () => void
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    let runtimeOptions: AcpRuntimeOptions | undefined
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: createRelayOwner(),
      persistence: createPersistence(),
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession: vi.fn(async () => ({
            sessionId: 'side-session-drain',
            frameworkId: 'claude-code'
          })),
          sendPrompt: vi.fn(async (request: { sessionId: string }) => {
            runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
            return { stopReason: 'end_turn' as const }
          }),
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession: vi.fn(async () => ({ sessionIds: [] })),
          respondToPermission: vi.fn(async () => undefined),
          shutdownForQuit: vi.fn(() => shutdown)
        } as never
      }
    })

    const started = await owner.start({
      parentSessionId: 'main-session-drain',
      projectId: 'project-1',
      text: 'Hello'
    })
    const close = owner.close({ sideSessionId: started.sideSessionId })

    await expect(
      owner.start({
        parentSessionId: 'main-session-drain',
        projectId: 'project-1',
        text: 'Too early'
      })
    ).rejects.toThrow('already open')
    finishShutdown()
    await close
  })
})
