import { describe, expect, it, vi } from 'vitest'

import {
  ensureConversationRuntimeSegment,
  resolveMessageBranchPath,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  createSessionFile,
  materializeSessionConversationGraph,
  normalizeSessionFile,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AgentModelRoute } from '../agent-framework'
import { createAcpHandlerWorkflows } from './handler-workflows'

const createSession = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    agentFrameworkId: 'claude-code',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Build a reusable analysis workflow.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer-1',
        role: 'agent',
        content: 'The workflow is complete.',
        status: 'complete',
        eventIds: [],
        responseToMessageId: 'prompt-1',
        createdAt: 2,
        completedAt: 2,
        updatedAt: 2
      }
    ],
    createdAt: 1,
    updatedAt: 2
  })

const prepareControlTurn = (session: PersistedChatSession): void => {
  const createdAt = 3
  const controlMessage = {
    id: 'save-as-skill-control',
    role: 'user' as const,
    content: 'Save as skill',
    status: 'complete' as const,
    eventIds: [],
    turnIntent: 'save-as-skill' as const,
    createdAt,
    updatedAt: createdAt
  }
  session.messages.push(controlMessage)
  session.status = 'running'
  session.activeRun = { promptMessageId: controlMessage.id, startedAt: createdAt }
  const graph = session.conversationGraph!
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
  session.conversationGraph = synchronizeActiveConversationMessages(
    graph,
    [...resolveMessageBranchPath(graph, frame.activeBranchId), controlMessage],
    createdAt
  )
  session.updatedAt = createdAt
}

const createHarness = (
  mutate?: (session: ReturnType<typeof createSession>) => void,
  archiveAvailability?: Parameters<typeof createAcpHandlerWorkflows>[3],
  taskNotifications?: Parameters<typeof createAcpHandlerWorkflows>[2],
  saveAsSkillAdmission?: Parameters<typeof createAcpHandlerWorkflows>[5]
): {
  workflows: ReturnType<typeof createAcpHandlerWorkflows>
  startPrompt: ReturnType<typeof vi.fn>
  startContinuation: ReturnType<typeof vi.fn>
  startContinuationWhenDispatchAdmitted: ReturnType<typeof vi.fn>
  hasLiveSession: ReturnType<typeof vi.fn>
  captureSessionBackend: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  session: PersistedChatSession
  request: {
    projectId: string
    sessionId: string
    agentFrameId: string
    messageBranchId: string
    promptMessageId: string
  }
} => {
  const session = createSession()
  mutate?.(session)
  prepareControlTurn(session)
  const startPrompt = vi.fn(async (request: unknown) => void request)
  const startContinuation = vi.fn(async (request: unknown) => void request)
  const resumeSession = vi.fn(async (request: { sessionId: string; cwd: string }) => ({
    sessionId: request.sessionId,
    cwd: request.cwd
  }))
  const hasLiveSession = vi.fn(() => true)
  const captureSessionBackend = vi.fn(
    () =>
      ({
        framework: { id: session.agentFrameworkId ?? 'claude-code' },
        ...(session.agentBackendId ? { backendId: session.agentBackendId } : {}),
        modelRoute:
          session.agentFrameworkId === 'codex'
            ? 'codex-responses'
            : session.agentFrameworkId === 'opencode'
              ? 'opencode-openai'
              : 'claude-anthropic',
        context: { window: 100_000, supportsImageInput: true }
      }) as never
  )
  const snapshot = { status: 'connected' } as never
  const startContinuationWhenDispatchAdmitted = vi.fn(
    async (request: unknown, validate: () => Promise<void>) => {
      await validate()
      return startContinuation(request)
    }
  )
  const workflows = createAcpHandlerWorkflows(
    {
      getSnapshot: () => snapshot,
      hasLiveSession,
      captureSessionBackend,
      resumeSession,
      startPrompt,
      getLatestUserPrompt: vi.fn(),
      startContinuation,
      startContinuationWhenDispatchAdmitted
    },
    { create: vi.fn() } as never,
    taskNotifications,
    archiveAvailability,
    { loadSession: vi.fn(async () => session) },
    saveAsSkillAdmission
  )
  const graph = session.conversationGraph!
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
  return {
    workflows,
    startPrompt,
    startContinuation,
    startContinuationWhenDispatchAdmitted,
    hasLiveSession,
    captureSessionBackend,
    resumeSession,
    session,
    request: {
      projectId: session.projectId,
      sessionId: session.id,
      agentFrameId: frame.id,
      messageBranchId: frame.activeBranchId,
      promptMessageId: 'save-as-skill-control'
    }
  }
}

describe('ACP resume Session workflow', () => {
  const persistedProjectId = 'persisted-project'
  const archiveAvailability = {
    withSessionAvailable: async <Result>(
      _projectId: string,
      _sessionId: string,
      operation: () => Promise<Result>
    ): Promise<Result> => operation(),
    withSessionAvailableById: async <Result>(
      _sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result> => operation(persistedProjectId)
  }

  it('injects the persisted Project owner when the request omits projectId', async () => {
    const harness = createHarness(undefined, archiveAvailability)
    const request = { sessionId: 'session-1', cwd: '/workspace' }

    await harness.workflows.resumeSession(request)

    expect(harness.resumeSession).toHaveBeenCalledWith({
      ...request,
      projectId: persistedProjectId
    })
  })

  it('rejects a request whose projectId disagrees with the persisted owner', async () => {
    const harness = createHarness(undefined, archiveAvailability)

    await expect(
      harness.workflows.resumeSession({
        sessionId: 'session-1',
        cwd: '/workspace',
        projectId: 'forged-project'
      })
    ).rejects.toThrow('Session does not belong to the requested Project.')

    expect(harness.resumeSession).not.toHaveBeenCalled()
  })
})

describe('ACP interrupted turn workflow', () => {
  it('does not re-enter archive admission while continuing an interrupted turn', async () => {
    let archiveQueue: Promise<void> = Promise.resolve()
    const enqueueArchive = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = archiveQueue.then(operation, operation)
      archiveQueue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const harness = createHarness(undefined, {
      withSessionAvailable: (_projectId, _sessionId, operation) => enqueueArchive(operation),
      withSessionAvailableById: (_sessionId, operation) =>
        enqueueArchive(() => operation('project-1'))
    })
    harness.session.status = 'error'
    harness.session.activeRun = undefined
    harness.session.resumeRecovery = {
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    }
    // The ordinary continuation path enters the dispatch admission guard, which is backed by the
    // same archive queue in production. Calling it while withSessionAvailable is active waits on
    // itself; the dispatch-admitted path intentionally bypasses only that nested guard.
    harness.startContinuation.mockImplementationOnce(() => enqueueArchive(async () => undefined))
    harness.startContinuationWhenDispatchAdmitted.mockImplementationOnce(
      async (_request: unknown, validate: () => Promise<void>) => {
        await validate()
        return 'provider_prompt_accepted'
      }
    )

    await harness.workflows.continueInterruptedTurn({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'prompt-1'
    })

    expect(harness.startContinuationWhenDispatchAdmitted).toHaveBeenCalledOnce()
  })
})

describe('ACP send prompt workflow', () => {
  it('returns the current snapshot after provider admission', async () => {
    const harness = createHarness()

    await expect(
      harness.workflows.sendPrompt({ sessionId: 'session-1', text: 'Research this.' })
    ).resolves.toEqual({ status: 'connected' })

    expect(harness.startPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Research this.'
    })
  })

  it('rolls back notification tracking when provider admission fails', async () => {
    const trackPrompt = vi.fn(() => ({ token: 9 }))
    const untrackPrompt = vi.fn()
    const harness = createHarness(undefined, undefined, { trackPrompt, untrackPrompt })
    const failure = new Error('Provider rejected prompt admission')
    harness.startPrompt.mockRejectedValueOnce(failure)

    await expect(
      harness.workflows.sendPrompt({ sessionId: 'session-1', text: 'Research this.' })
    ).rejects.toBe(failure)

    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 9 })
  })
})

describe('ACP Save as skill workflow', () => {
  it('dispatches through the Session admission already held by the workflow', async () => {
    const harness = createHarness()

    await harness.workflows.saveAsSkill(harness.request)

    expect(harness.startContinuationWhenDispatchAdmitted).toHaveBeenCalledOnce()
  })

  it('holds archive admission until the hidden turn is accepted', async () => {
    let admissionActive = false
    const admitted = vi.fn()
    const harness = createHarness(undefined, {
      withSessionAvailable: async <Result>(
        projectId: string,
        sessionId: string,
        operation: () => Promise<Result>
      ): Promise<Result> => {
        admitted(projectId, sessionId)
        admissionActive = true
        try {
          return await operation()
        } finally {
          admissionActive = false
        }
      },
      withSessionAvailableById: vi.fn()
    })
    harness.startContinuation.mockImplementationOnce(async () => {
      expect(admissionActive).toBe(true)
    })

    await harness.workflows.saveAsSkill(harness.request)

    expect(admitted).toHaveBeenCalledWith('project-1', 'session-1')
    expect(admissionActive).toBe(false)
  })

  it('starts one hidden evaluation turn on the exact durable conversation branch', async () => {
    const harness = createHarness()

    await expect(harness.workflows.saveAsSkill(harness.request)).resolves.toEqual({
      status: 'connected'
    })

    expect(harness.startContinuation).toHaveBeenCalledOnce()
    const request = harness.startContinuation.mock.calls[0][0]
    expect(request).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        suppressUserMessage: true,
        text: expect.stringMatching(
          /Distill this session.*Review the active conversation branch.*First decide.*If it does not.*If it does.*load Customize/s
        ),
        provenanceContext: expect.objectContaining({
          agentFrameId: harness.request.agentFrameId,
          messageBranchId: harness.request.messageBranchId,
          promptMessageId: 'save-as-skill-control'
        }),
        resumeFallback: expect.objectContaining({
          historyPreamble: expect.stringContaining('Build a reusable analysis workflow.')
        })
      })
    )
    expect(request).not.toHaveProperty('forcedSkillIds')
  })

  it('retains history images for a text-only model when the Vision relay is available', async () => {
    const harness = createHarness((session) => {
      const images = [
        {
          id: 'history-image',
          mimeType: 'image/png' as const,
          data: Buffer.from('history-image').toString('base64'),
          byteLength: Buffer.byteLength('history-image')
        }
      ]
      session.messages[0].images = images
      session.conversationGraph!.messages[0].images = structuredClone(images)
    })
    harness.captureSessionBackend.mockReturnValue({
      framework: { id: 'claude-code' },
      modelRoute: 'claude-anthropic',
      context: { window: 100_000, supportsImageInput: false }
    })

    await harness.workflows.saveAsSkill({ ...harness.request, supportsImageRelay: true })

    expect(harness.startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeFallback: expect.objectContaining({
          historyImages: [expect.objectContaining({ mimeType: 'image/png', byteLength: 13 })]
        })
      })
    )
  })

  it('rejects at provider admission while Side chat owns the parent Session', async () => {
    const admission = vi.fn(() => {
      throw new Error('Close Side chat before saving this conversation as a Skill.')
    })
    const harness = createHarness(undefined, undefined, undefined, admission)

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow('Close Side chat')

    expect(admission).toHaveBeenCalledWith('session-1')
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('tracks the accepted hidden turn with a safe task notification label', async () => {
    const trackPrompt = vi.fn(() => ({ token: 1 }))
    const untrackPrompt = vi.fn()
    const harness = createHarness(undefined, undefined, { trackPrompt, untrackPrompt })

    await harness.workflows.saveAsSkill(harness.request)

    expect(trackPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Save as skill'
    })
    expect(trackPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startContinuation.mock.invocationCallOrder[0]
    )
    expect(untrackPrompt).not.toHaveBeenCalled()
  })

  it('reverts task notification tracking when continuation admission fails', async () => {
    const trackPrompt = vi.fn(() => ({ token: 7 }))
    const untrackPrompt = vi.fn()
    const harness = createHarness(undefined, undefined, { trackPrompt, untrackPrompt })
    const failure = new Error('Provider rejected continuation')
    harness.startContinuation.mockRejectedValueOnce(failure)

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toBe(failure)

    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 7 })
  })

  it('accepts the exact prepared control after a live provider adoption normalizes its read', async () => {
    const harness = createHarness()
    harness.session.status = 'error'
    harness.session.activeRun = undefined
    harness.session.resumeRecovery = {
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: harness.request.promptMessageId
    }

    await expect(harness.workflows.saveAsSkill(harness.request)).resolves.toEqual({
      status: 'connected'
    })

    expect(harness.hasLiveSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(harness.startContinuation).toHaveBeenCalledOnce()
  })

  it('rejects a normalized control when its provider Session is no longer live', async () => {
    const harness = createHarness()
    harness.session.status = 'error'
    harness.session.activeRun = undefined
    harness.session.resumeRecovery = {
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: harness.request.promptMessageId
    }
    harness.hasLiveSession.mockReturnValue(false)

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'requires a prepared Session'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it.each<readonly [string, AgentFrameworkId, AgentModelRoute]>([
    ['Claude Code', 'claude-code', 'claude-anthropic'],
    ['OpenCode', 'opencode', 'opencode-openai'],
    ['Codex Responses', 'codex', 'codex-responses'],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ])('accepts pending context-reset replay on %s', async (_name, frameworkId, modelRoute) => {
    const harness = createHarness((session) => {
      session.agentFrameworkId = frameworkId
      session.pendingHistoryReplay = { kind: 'all' }
      session.conversationGraph = ensureConversationRuntimeSegment(session.conversationGraph!, {
        id: 'runtime-segment-after-context-reset',
        frameworkId,
        startedAt: 3,
        forceNew: true
      })
    })
    harness.captureSessionBackend.mockReturnValue({
      framework: { id: frameworkId },
      modelRoute,
      context: { window: 100_000, supportsImageInput: true }
    } as never)

    await harness.workflows.saveAsSkill(harness.request)

    expect(harness.startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        contextReset: true,
        provenanceContext: expect.objectContaining({
          runtimeSegmentId: 'runtime-segment-after-context-reset'
        })
      })
    )
  })

  it.each<readonly [string, AgentFrameworkId, AgentModelRoute]>([
    ['Claude Code', 'claude-code', 'claude-anthropic'],
    ['OpenCode', 'opencode', 'opencode-openai'],
    ['Codex Responses', 'codex', 'codex-responses'],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ])(
    'accepts pending context-reset replay after the prepared control is normalized on read for %s',
    async (_name, frameworkId, modelRoute) => {
      const harness = createHarness((session) => {
        session.agentFrameworkId = frameworkId
        session.pendingHistoryReplay = { kind: 'all' }
        session.conversationGraph = ensureConversationRuntimeSegment(session.conversationGraph!, {
          id: 'runtime-segment-after-context-reset',
          frameworkId,
          startedAt: 3,
          forceNew: true
        })
      })
      const normalized = normalizeSessionFile(createSessionFile(harness.session))
      expect(normalized).toMatchObject({
        status: 'error',
        pendingHistoryReplay: { kind: 'all' },
        resumeRecovery: {
          kind: 'resume-required',
          promptMessageId: harness.request.promptMessageId
        }
      })
      const normalizedFrame = normalized?.conversationGraph?.frames.find(
        ({ id }) => id === normalized.conversationGraph?.activeFrameId
      )
      const normalizedMessages =
        normalized?.conversationGraph && normalizedFrame
          ? resolveMessageBranchPath(normalized.conversationGraph, normalizedFrame.activeBranchId)
          : []
      expect(normalizedMessages.slice(-2).map(({ runtimeSegmentId }) => runtimeSegmentId)).toEqual([
        expect.not.stringMatching('runtime-segment-after-context-reset'),
        'runtime-segment-after-context-reset'
      ])
      Object.assign(harness.session, normalized)
      harness.captureSessionBackend.mockReturnValue({
        framework: { id: frameworkId },
        modelRoute,
        context: { window: 100_000, supportsImageInput: true }
      } as never)

      await harness.workflows.saveAsSkill(harness.request)

      expect(harness.startContinuation).toHaveBeenCalledWith(
        expect.objectContaining({
          contextReset: true,
          provenanceContext: expect.objectContaining({
            runtimeSegmentId: 'runtime-segment-after-context-reset'
          })
        })
      )
    }
  )

  it('rejects normalized pending full replay without a fresh durable Runtime Segment', async () => {
    const harness = createHarness((session) => {
      session.pendingHistoryReplay = { kind: 'all' }
    })
    Object.assign(harness.session, normalizeSessionFile(createSessionFile(harness.session)))

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'requires a prepared Session'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('rejects normalized pending interrupted-turn replay after a context reset', async () => {
    const harness = createHarness((session) => {
      session.pendingHistoryReplay = { kind: 'before-message', messageId: 'prompt-1' }
      session.conversationGraph = ensureConversationRuntimeSegment(session.conversationGraph!, {
        id: 'runtime-segment-after-context-reset',
        frameworkId: 'claude-code',
        startedAt: 3,
        forceNew: true
      })
    })
    Object.assign(harness.session, normalizeSessionFile(createSessionFile(harness.session)))

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'requires a prepared Session'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('rejects when the prepared control changes before runtime admission', async () => {
    const harness = createHarness()
    harness.startContinuationWhenDispatchAdmitted.mockImplementationOnce(
      async (_request: unknown, validate: () => Promise<void>) => {
        harness.session.activeRun = { promptMessageId: 'newer-prompt', startedAt: 4 }
        await validate()
      }
    )

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'prepared control turn'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('does not infer context reset without a fresh durable Runtime Segment', async () => {
    const harness = createHarness()

    await harness.workflows.saveAsSkill(harness.request)

    expect(harness.startContinuation).toHaveBeenCalledWith(
      expect.not.objectContaining({ contextReset: true })
    )
  })

  it('filters earlier hidden Save as skill controls from replay', async () => {
    const harness = createHarness((session) => {
      const messages = [
        ...session.messages,
        {
          id: 'previous-save-control',
          role: 'user' as const,
          content: 'Save as skill',
          status: 'complete' as const,
          eventIds: [],
          turnIntent: 'save-as-skill' as const,
          createdAt: 3,
          updatedAt: 3
        },
        {
          id: 'previous-save-answer',
          role: 'agent' as const,
          content: 'The earlier evaluation found no reusable workflow.',
          status: 'complete' as const,
          eventIds: [],
          responseToMessageId: 'previous-save-control',
          createdAt: 4,
          completedAt: 4,
          updatedAt: 4
        }
      ]
      session.messages = messages
      session.conversationGraph = materializeSessionConversationGraph({
        ...session,
        conversationGraph: undefined,
        messages
      }).conversationGraph
    })

    await harness.workflows.saveAsSkill(harness.request)

    const preamble = harness.startContinuation.mock.calls[0]?.[0].resumeFallback?.historyPreamble
    expect(preamble).toContain('The earlier evaluation found no reusable workflow.')
    expect(preamble).not.toContain('Save as skill')
  })

  it('fails closed when conversation history cannot fit the replay budget', async () => {
    const harness = createHarness()
    harness.captureSessionBackend.mockReturnValue({
      framework: { id: 'claude-code' },
      modelRoute: 'claude-anthropic',
      context: { window: 1, supportsImageInput: true }
    } as never)

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'conversation history could not be replayed'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it.each<readonly [string, AgentFrameworkId, AgentModelRoute]>([
    ['Claude Code', 'claude-code', 'claude-anthropic'],
    ['OpenCode', 'opencode', 'opencode-openai'],
    ['Codex Responses', 'codex', 'codex-responses'],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ])('keeps shared hidden-turn semantics on %s', async (_name, frameworkId, modelRoute) => {
    const harness = createHarness((session) => {
      session.agentFrameworkId = frameworkId
    })
    harness.captureSessionBackend.mockReturnValue({
      framework: { id: frameworkId },
      modelRoute,
      context: { window: 100_000, supportsImageInput: true }
    } as never)

    await harness.workflows.saveAsSkill(harness.request)

    expect(harness.startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressUserMessage: true,
        text: expect.stringMatching(
          /Distill this session.*Review the active conversation branch.*First decide.*load Customize/s
        ),
        resumeFallback: expect.objectContaining({
          historyPreamble: expect.stringContaining('Build a reusable analysis workflow.')
        })
      })
    )
  })

  it('validates and replays the active Branch instead of the flat compatibility projection', async () => {
    const harness = createHarness((session) => {
      session.messages.push({
        id: 'off-branch-flat-tail',
        role: 'user',
        content: 'This flat tail is not on the active Branch.',
        status: 'complete',
        eventIds: [],
        createdAt: 3,
        updatedAt: 3
      })
    })

    await harness.workflows.saveAsSkill(harness.request)

    const sent = harness.startContinuation.mock.calls[0]?.[0]
    expect(sent?.resumeFallback?.historyPreamble).toContain('Build a reusable analysis workflow.')
    expect(sent?.resumeFallback?.historyPreamble).not.toContain('flat tail')
  })

  it('fails closed when the durable branch changed after the click', async () => {
    const harness = createHarness()

    await expect(
      harness.workflows.saveAsSkill({ ...harness.request, messageBranchId: 'stale-branch' })
    ).rejects.toThrow('active conversation branch changed')
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('fails closed when the durable control Message does not match the request', async () => {
    const harness = createHarness()

    await expect(
      harness.workflows.saveAsSkill({ ...harness.request, promptMessageId: 'forged-control' })
    ).rejects.toThrow('requires a prepared control turn')
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('does not start unless the durable Session is idle', async () => {
    const harness = createHarness((session) => {
      session.resumeRecovery = { kind: 'resume-required', cause: 'connection-lost' }
    })

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'requires a prepared Session'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })

  it('does not start while a delegated Attempt is running', async () => {
    const harness = createHarness((session) => {
      session.runtimeContext = {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  status: 'running',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: [],
                  startedAt: 3
                }
              ]
            }
          ]
        }
      }
    })

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'delegated work is still running'
    )
    expect(harness.startContinuation).not.toHaveBeenCalled()
  })
})
