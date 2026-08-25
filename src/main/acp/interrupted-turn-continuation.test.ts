import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { AcpPromptRequest, AcpStateSnapshot } from '../../shared/acp'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { continueInterruptedTurn } from './interrupted-turn-continuation'

const snapshot = (promptInFlightSessionIds: string[] = []): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['session-1'],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: promptInFlightSessionIds.length > 0,
  agentPromptInFlightSessionIds: promptInFlightSessionIds,
  promptInFlightSessionIds
})

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  content: string,
  partial: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...partial
})

const session = (messages: PersistedChatMessage[]): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Interrupted turn',
  cwd: '/workspace',
  status: 'error',
  agentFrameworkId: 'claude-code',
  messages,
  conversationGraph: createLinearConversationGraph({
    sessionId: 'session-1',
    messages,
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 1
  }),
  resumeRecovery: {
    kind: 'resume-required',
    cause: 'app-restart',
    promptMessageId: 'prompt-1'
  },
  createdAt: 1,
  updatedAt: 1
})

describe('continueInterruptedTurn', () => {
  it('reconstructs the hidden Save as skill turn after restart', async () => {
    const durable = session([
      message('prompt-1', 'user', 'Save as skill', { turnIntent: 'save-as-skill' })
    ])
    durable.memoryEnabled = false
    const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})

    await continueInterruptedTurn(
      {
        runtime: {
          getSnapshot: vi.fn(() => snapshot()),
          getLatestUserPrompt: vi.fn(() => undefined),
          startContinuation
        },
        loadSession: vi.fn(async () => durable)
      },
      { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
    )

    const request = startContinuation.mock.calls[0][0]
    expect(request).toEqual(
      expect.objectContaining({
        text: expect.stringMatching(
          /Distill this session.*Review the active conversation branch.*First decide.*If it does not.*If it does.*load Customize/s
        ),
        memoryEnabled: false,
        suppressUserMessage: true,
        provenanceContext: expect.objectContaining({ promptMessageId: 'prompt-1' })
      })
    )
    expect(request).not.toHaveProperty('forcedSkillIds')
  })

  it('reconstructs app-owned continuation authority from the durable active user turn', async () => {
    const durable = session([
      message('prompt-1', 'user', 'Analyze the attached evidence', {
        turnIntent: 'plan-first',
        parts: [
          { type: 'skill', id: 'skill-1', name: 'Evidence Review' },
          {
            type: 'artifact',
            id: 'artifact-1',
            name: 'evidence.csv',
            path: '/workspace/evidence.csv',
            source: 'artifact'
          }
        ]
      })
    ])
    const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})
    const trackPrompt = vi.fn(() => ({ token: 1 }))
    const untrackPrompt = vi.fn()
    const runtime = {
      getSnapshot: vi.fn(() => snapshot()),
      getLatestUserPrompt: vi.fn(() => undefined),
      startContinuation
    }

    await continueInterruptedTurn(
      {
        runtime,
        loadSession: vi.fn(async () => durable),
        notifications: { trackPrompt, untrackPrompt }
      },
      { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
    )

    expect(startContinuation).toHaveBeenCalledOnce()
    expect(startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        text: expect.stringMatching(/continue the interrupted turn/i),
        turnIntent: 'plan-first',
        forcedSkillIds: ['skill-1'],
        referencedArtifacts: [expect.objectContaining({ id: 'artifact-1' })],
        suppressUserMessage: true,
        provenanceContext: expect.objectContaining({ promptMessageId: 'prompt-1' })
      })
    )
    expect(startContinuation.mock.calls[0][0]).not.toHaveProperty('historyPreamble')
    expect(trackPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Analyze the attached evidence'
    })
    expect(untrackPrompt).not.toHaveBeenCalled()
  })

  it('removes notification tracking when continuation startup is rejected', async () => {
    const durable = session([message('prompt-1', 'user', 'Analyze the durable request')])
    const failure = new Error('Provider rejected continuation')
    const trackPrompt = vi.fn(() => ({ token: 7 }))
    const untrackPrompt = vi.fn()

    await expect(
      continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => snapshot(),
            getLatestUserPrompt: () => undefined,
            startContinuation: vi.fn(async () => {
              throw failure
            })
          },
          loadSession: vi.fn(async () => durable),
          notifications: { trackPrompt, untrackPrompt }
        },
        { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
      )
    ).rejects.toBe(failure)

    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 7 })
  })

  it('carries the original task and media when native resume did not retain the provider prompt', async () => {
    const durable = session([
      message('prompt-1', 'user', 'Compare the two microscopy images', {
        uploads: [
          {
            id: 'upload-1',
            versionId: 'upload-version-1',
            sessionId: 'session-1',
            name: 'cells.png',
            originalName: 'cells.png',
            mimeType: 'image/png',
            size: 42
          }
        ]
      })
    ])
    const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})

    await continueInterruptedTurn(
      {
        runtime: {
          getSnapshot: () => snapshot(),
          getLatestUserPrompt: () => undefined,
          startContinuation
        },
        loadSession: vi.fn(async () => durable)
      },
      { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
    )

    expect(startContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Compare the two microscopy images'),
        attachments: [
          expect.objectContaining({
            id: 'upload-1',
            path: 'upload-version:project-1/session-1/upload-version-1'
          })
        ],
        suppressUserMessage: true
      })
    )
  })

  it.each([
    ['Claude Code', 'claude-code', 'claude-code'],
    ['OpenCode', 'opencode', 'opencode'],
    ['Codex Responses', 'codex', 'codex-response'],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ] as const)(
    'replays the interrupted active branch into a validated fresh Runtime Segment for %s',
    async (_name, frameworkId, historyReplayTarget) => {
      const durable = session([
        message('prompt-0', 'user', 'Collect baseline evidence'),
        message('answer-0', 'agent', 'Baseline is ready', { responseToMessageId: 'prompt-0' }),
        message('save-control-0', 'user', 'Save as skill', { turnIntent: 'save-as-skill' }),
        message('save-answer-0', 'agent', 'No reusable workflow was found', {
          responseToMessageId: 'save-control-0'
        }),
        message('prompt-1', 'user', 'Compare the cohorts'),
        message('answer-1', 'agent', 'I loaded both cohort tables', {
          responseToMessageId: 'prompt-1',
          status: 'error'
        })
      ])
      durable.agentFrameworkId = frameworkId
      durable.conversationGraph!.runtimeSegments.push({
        id: 'runtime-resumed',
        agentFrameId: durable.conversationGraph!.activeFrameId,
        frameworkId,
        startedAt: 2
      })
      const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})

      await continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => snapshot(),
            getLatestUserPrompt: () => undefined,
            startContinuation
          },
          loadSession: vi.fn(async () => durable)
        },
        {
          sessionId: 'session-1',
          projectId: 'project-1',
          promptMessageId: 'prompt-1',
          contextReset: {
            runtimeSegmentId: 'runtime-resumed',
            historyReplayTarget,
            contextWindow: 100_000,
            supportsImageInput: false
          }
        }
      )

      const request = startContinuation.mock.calls[0][0]
      expect(request.contextReset).toBe(true)
      expect(request.provenanceContext?.runtimeSegmentId).toBe('runtime-resumed')
      expect(request.historyPreamble).toContain('Collect baseline evidence')
      expect(request.historyPreamble).toContain('Compare the cohorts')
      expect(request.historyPreamble).toContain('I loaded both cohort tables')
      expect(request.historyPreamble).not.toContain('Save as skill')
      expect(request.text).not.toContain('Compare the cohorts')
    }
  )

  it('replays only the durable active branch when a hidden turn recovers after context reset', async () => {
    const durable = session([
      message('prompt-0', 'user', 'Build the active workflow'),
      message('answer-0', 'agent', 'The active workflow is ready', {
        responseToMessageId: 'prompt-0'
      }),
      message('prompt-1', 'user', 'Save as skill', { turnIntent: 'save-as-skill' })
    ])
    const graph = durable.conversationGraph!
    const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
    const inactiveMessage = message('inactive-prompt', 'user', 'Use unrelated branch rules')
    durable.messages.push(inactiveMessage)
    graph.messages.push({
      ...inactiveMessage,
      agentFrameId: frame.id,
      introducedOnBranchId: 'inactive-branch',
      parentMessageId: 'answer-0',
      revisionRootMessageId: inactiveMessage.id,
      runtimeSegmentId: graph.runtimeSegments[0].id
    })
    graph.branches.push({
      id: 'inactive-branch',
      agentFrameId: frame.id,
      parentBranchId: frame.activeBranchId,
      forkMessageId: 'answer-0',
      headMessageId: inactiveMessage.id,
      createdAt: 2,
      updatedAt: 2
    })
    graph.runtimeSegments.push({
      id: 'runtime-resumed',
      agentFrameId: frame.id,
      frameworkId: 'claude-code',
      startedAt: 2
    })
    const startContinuation = vi.fn<(request: AcpPromptRequest) => Promise<void>>(async () => {})

    await continueInterruptedTurn(
      {
        runtime: {
          getSnapshot: () => snapshot(),
          getLatestUserPrompt: () => undefined,
          startContinuation
        },
        loadSession: vi.fn(async () => durable)
      },
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        promptMessageId: 'prompt-1',
        contextReset: {
          runtimeSegmentId: 'runtime-resumed',
          historyReplayTarget: 'claude-code',
          contextWindow: 100_000,
          supportsImageInput: false
        }
      }
    )

    const request = startContinuation.mock.calls[0][0]
    expect(request.historyPreamble).toContain('Build the active workflow')
    expect(request.historyPreamble).not.toContain('Use unrelated branch rules')
    expect(request.historyPreamble).not.toContain('Save as skill')
  })

  it('fails closed after context reset when only hidden controls remain for replay', async () => {
    const durable = session([
      message('prompt-1', 'user', 'Save as skill', { turnIntent: 'save-as-skill' })
    ])
    durable.conversationGraph!.runtimeSegments.push({
      id: 'runtime-resumed',
      agentFrameId: durable.conversationGraph!.activeFrameId,
      frameworkId: 'claude-code',
      startedAt: 2
    })
    const startContinuation = vi.fn()
    const trackPrompt = vi.fn(() => ({ token: 11 }))
    const untrackPrompt = vi.fn()

    await expect(
      continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => snapshot(),
            getLatestUserPrompt: () => undefined,
            startContinuation
          },
          loadSession: vi.fn(async () => durable),
          notifications: { trackPrompt, untrackPrompt }
        },
        {
          sessionId: 'session-1',
          projectId: 'project-1',
          promptMessageId: 'prompt-1',
          contextReset: {
            runtimeSegmentId: 'runtime-resumed',
            historyReplayTarget: 'claude-code',
            contextWindow: 100_000,
            supportsImageInput: false
          }
        }
      )
    ).rejects.toThrow('history could not be replayed after context reset')
    expect(startContinuation).not.toHaveBeenCalled()
    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 11 })
  })

  it('does not dispatch a second continuation while the recovered prompt is already running', async () => {
    const durable = session([message('prompt-1', 'user', 'Keep going')])
    const startContinuation = vi.fn()
    const current = snapshot(['session-1'])

    await expect(
      continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => current,
            getLatestUserPrompt: () => ({
              sessionId: 'session-1',
              text: 'Keep going',
              provenanceContext: { promptMessageId: 'prompt-1' }
            }),
            startContinuation
          },
          loadSession: vi.fn(async () => durable)
        },
        { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
      )
    ).resolves.toBe(current)
    expect(startContinuation).not.toHaveBeenCalled()
  })

  it('revalidates the durable turn inside dispatch-admitted root admission', async () => {
    const durable = session([message('prompt-1', 'user', 'Keep going')])
    const startContinuation = vi.fn()
    const startDispatchAdmittedContinuation = vi.fn(
      async (_request: AcpPromptRequest, validate: () => Promise<void>) => {
        durable.resumeRecovery = {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'newer-prompt'
        }
        await validate()
      }
    )

    await expect(
      continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => snapshot(),
            getLatestUserPrompt: () => undefined,
            startContinuation
          },
          loadSession: vi.fn(async () => durable),
          startDispatchAdmittedContinuation
        },
        { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-1' }
      )
    ).rejects.toThrow(/no longer matches the interrupted turn/i)

    expect(startDispatchAdmittedContinuation).toHaveBeenCalledOnce()
    expect(startContinuation).not.toHaveBeenCalled()
  })

  it('rejects a stale or cross-branch recovery prompt', async () => {
    const durable = session([message('prompt-1', 'user', 'Keep going')])

    await expect(
      continueInterruptedTurn(
        {
          runtime: {
            getSnapshot: () => snapshot(),
            getLatestUserPrompt: () => undefined,
            startContinuation: vi.fn()
          },
          loadSession: vi.fn(async () => durable)
        },
        { sessionId: 'session-1', projectId: 'project-1', promptMessageId: 'prompt-other' }
      )
    ).rejects.toThrow(/no longer matches the interrupted turn/i)
  })
})
