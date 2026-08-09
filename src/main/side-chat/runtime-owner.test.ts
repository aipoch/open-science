import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeOptions } from '../acp/runtime'
import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import type { ResolvedAgentBackend } from '../agent-framework'
import { claudeCodeFramework } from '../agent-framework/claude-code'
import { opencodeFramework } from '../agent-framework/opencode'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { SideChatRuntimeOwner, prepareSideChatBackend } from './runtime-owner'

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

  it('keeps Claude non-persistent with no built-in tool-loading surface', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-claude-'))
    const prepared = await prepareSideChatBackend(backend(claudeCodeFramework), temporaryRoot)

    expect(prepared.sessionOptions).toMatchObject({
      tools: [],
      skills: [],
      plugins: [],
      settings: {},
      settingSources: [],
      persistSession: false
    })
    expect(prepared.systemPromptAppends?.join(' ')).toContain('ephemeral Side chat')
  })
})

describe('SideChatRuntimeOwner lifecycle', () => {
  it('removes every leftover chat profile at startup because none can resume', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-sweep-'))
    const stale = join(temporaryRoot, 'runtime-support', 'side-chat', 'chat-leftover')
    await mkdir(stale, { recursive: true })
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(),
      resolveTarget: vi.fn(),
      relay: new SideChatRelayOwner({ targetState: () => 'completed' }),
      onEvent: vi.fn()
    })

    await owner.sweepStaleProfiles()

    await expect(access(stale)).rejects.toThrow()
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
    const relay = new SideChatRelayOwner({ targetState: () => 'idle' })
    let runtimeOptions: AcpRuntimeOptions | undefined
    const createSession = vi.fn(async () => ({
      sessionId: 'side-session-1',
      frameworkId: 'claude-code' as const
    }))
    const sendPrompt = vi.fn(async (request: { sessionId: string }) => {
      runtimeOptions!.callbacks?.onProviderPromptAccepted?.(request.sessionId)
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
        return resolved
      }),
      relay,
      onEvent: vi.fn(),
      createRuntime: (options) => {
        runtimeOptions = options
        return {
          createSession,
          sendPrompt,
          cancelPrompt: vi.fn(async () => ({ stopReason: 'cancelled' })),
          deleteSession,
          respondToPermission: vi.fn(async () => undefined),
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
      sideSessionId: 'side-session-1',
      frameworkId: 'claude-code',
      model: 'model-a'
    })
    expect(runtimeOptions?.sessionCapabilityPolicy).toMatchObject({ role: 'side-chat' })
    expect(sendPrompt).toHaveBeenCalledWith({
      sessionId: 'side-session-1',
      text: 'What context do you have?',
      historyPreamble: 'Main snapshot.',
      resumeFallback: { historyPreamble: 'Main snapshot.' }
    })
    expect(registerHostMessageSession).toHaveBeenCalledWith(
      'side-session-1',
      [expect.objectContaining({ name: 'send_message' })],
      { failClosedUnknownKeys: true }
    )
    expect(relay.claim('main-session-1')?.messages).toEqual([
      expect.objectContaining({ text: 'Use a black line.', sideSessionId: 'trusted-routing-1' })
    ])

    await owner.close({ sideSessionId: 'side-session-1' })

    expect(unregisterHostMessageSession).toHaveBeenCalledWith('side-session-1')
    expect(closeOrder).toEqual(['runtime', 'scope'])
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'side-session-1' })
    expect(shutdownForQuit).toHaveBeenCalledOnce()
    await expect(stat(join(temporaryRoot, 'runtime-support', 'side-chat'))).resolves.toBeDefined()
    expect(relay.claim('main-session-1')).toBeUndefined()
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
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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

  it('publishes a terminal lifecycle event and destroys a disconnected runtime', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-disconnected-'))
    let runtimeOptions: AcpRuntimeOptions | undefined
    const onEvent = vi.fn()
    const deleteSession = vi.fn(async () => ({ sessionIds: [] }))
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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

    await owner.start({
      parentSessionId: 'main-session-disconnected',
      projectId: 'project-1',
      text: 'Hello'
    })
    runtimeOptions?.callbacks?.onStateChanged?.({ status: 'error' } as never)

    expect(onEvent).toHaveBeenCalledWith({
      revision: expect.any(Number),
      parentSessionId: 'main-session-disconnected',
      projectId: 'project-1',
      sideSessionId: 'side-session-disconnected',
      event: { kind: 'closed', reason: 'connection-error' }
    })
    await vi.waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'side-session-disconnected' })
    )
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
    const resolveTarget = vi.fn(async (capturedTarget: ExplicitAgentBackendTarget) =>
      backend(capturedTarget.frameworkId === 'opencode' ? opencodeFramework : claudeCodeFramework)
    )
    const applyModelChange = vi.fn(async () => true)
    const requestProviderReconnect = vi.fn(async () => {
      await runtimeOptions?.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
    })
    const resumeSession = vi.fn(async () => ({
      sessionId: 'side-session-reconfigure',
      frameworkId: selectedFramework.id,
      ...(selectedFramework.id === 'opencode' ? { contextReset: true } : {})
    }))
    const sent: Array<Record<string, unknown>> = []
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget,
      resolveTarget,
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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

    await owner.start({
      parentSessionId: 'main-session-reconfigure',
      projectId: 'project-1',
      text: 'First question',
      historyPreamble: 'Main snapshot.'
    })
    await expect(owner.applyModelChange({ model: 'model-b' } as never)).resolves.toBe(true)
    expect(applyModelChange).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).not.toHaveBeenCalled()
    await Promise.resolve()
    await owner.send({ sideSessionId: 'side-session-reconfigure', text: 'After model switch' })
    expect(sent[1]).not.toHaveProperty('historyPreamble')
    await Promise.resolve()

    selectedFramework = opencodeFramework
    await owner.requestProviderReconnect()
    await owner.send({ sideSessionId: 'side-session-reconfigure', text: 'Follow up' })

    expect(captureTarget).toHaveBeenCalledTimes(2)
    expect(resolveTarget.mock.calls[1]?.[0]).toMatchObject({ frameworkId: 'opencode' })
    expect(resumeSession).toHaveBeenLastCalledWith({
      sessionId: 'side-session-reconfigure',
      cwd: expect.stringContaining('/cwd'),
      projectName: 'project-1'
    })
    expect(sent[2]).toMatchObject({
      sessionId: 'side-session-reconfigure',
      text: 'Follow up',
      historyPreamble: expect.stringContaining('First answer.'),
      resumeFallback: { historyPreamble: expect.stringContaining('First question') }
    })
    expect(String(sent[2]?.historyPreamble)).not.toContain('User: Follow up')
  })

  it('keeps independent temporary Sessions for different parent Sessions', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-side-chat-concurrent-'))
    const shutdowns: Array<ReturnType<typeof vi.fn>> = []
    let runtimeNumber = 0
    const owner = new SideChatRuntimeOwner({
      appVersion: '0.11.0',
      configRoot: temporaryRoot,
      captureTarget: vi.fn(async () => target),
      resolveTarget: vi.fn(async () => backend(claudeCodeFramework)),
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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

    await expect(owner.applyModelChange({ model: 'model-b' } as never)).resolves.toBe(true)
    await expect(owner.applyReasoningEffortChange('high')).resolves.toBe(true)
    await owner.requestProviderReconnect()

    for (const apply of modelChanges) expect(apply).toHaveBeenCalledOnce()
    for (const apply of reasoningChanges) expect(apply).toHaveBeenCalledWith('high')
    for (const reconnect of reconnects) expect(reconnect).toHaveBeenCalledOnce()
    await owner.shutdown()
  })

  it('does not admit another temporary Session until asynchronous teardown finishes', async () => {
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
      relay: new SideChatRelayOwner({ targetState: () => 'idle' }),
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
