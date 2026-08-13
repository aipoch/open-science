import { describe, expect, it, vi } from 'vitest'

import { ensureConversationRuntimeSegment } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { HistoryReplayTarget } from '../../shared/history-preamble'
import type { AgentFrameworkId } from '../../shared/settings'
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

const createHarness = (
  mutate?: (session: ReturnType<typeof createSession>) => void,
  archiveAvailability?: Parameters<typeof createAcpHandlerWorkflows>[3]
): {
  workflows: ReturnType<typeof createAcpHandlerWorkflows>
  sendPrompt: ReturnType<typeof vi.fn>
  request: {
    projectId: string
    sessionId: string
    agentFrameId: string
    messageBranchId: string
    historyReplay: { target: HistoryReplayTarget }
  }
} => {
  const session = createSession()
  mutate?.(session)
  const sendPrompt = vi.fn(async () => undefined)
  const snapshot = { status: 'connected' } as never
  const workflows = createAcpHandlerWorkflows(
    {
      getSnapshot: () => snapshot,
      resumeSession: vi.fn(),
      sendPrompt,
      getLatestUserPrompt: vi.fn(),
      startContinuation: vi.fn()
    },
    { create: vi.fn() } as never,
    undefined,
    archiveAvailability,
    { loadSession: vi.fn(async () => session) }
  )
  const graph = session.conversationGraph!
  const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
  return {
    workflows,
    sendPrompt,
    request: {
      projectId: session.projectId,
      sessionId: session.id,
      agentFrameId: frame.id,
      messageBranchId: frame.activeBranchId,
      historyReplay: { target: 'claude-code' as const }
    }
  }
}

describe('ACP Save as skill workflow', () => {
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
    harness.sendPrompt.mockImplementationOnce(async () => {
      expect(admissionActive).toBe(true)
    })

    await harness.workflows.saveAsSkill(harness.request)

    expect(admitted).toHaveBeenCalledWith('project-1', 'session-1')
    expect(admissionActive).toBe(false)
  })

  it('starts one hidden Customize turn on the exact durable conversation branch', async () => {
    const harness = createHarness()

    await expect(harness.workflows.saveAsSkill(harness.request)).resolves.toEqual({
      status: 'connected'
    })

    expect(harness.sendPrompt).toHaveBeenCalledOnce()
    expect(harness.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        suppressUserMessage: true,
        forcedSkillIds: ['customize'],
        text: expect.stringMatching(/reusable Skill.*Customize/s),
        provenanceContext: expect.objectContaining({
          agentFrameId: harness.request.agentFrameId,
          messageBranchId: harness.request.messageBranchId,
          promptMessageId: expect.stringMatching(/^message-/)
        }),
        resumeFallback: expect.objectContaining({
          historyPreamble: expect.stringContaining('Build a reusable analysis workflow.')
        })
      })
    )
  })

  it('binds context-reset hidden-turn provenance to the fresh runtime segment', async () => {
    const harness = createHarness((session) => {
      session.conversationGraph = ensureConversationRuntimeSegment(session.conversationGraph!, {
        id: 'runtime-segment-after-context-reset',
        frameworkId: 'claude-code',
        startedAt: 3,
        forceNew: true
      })
    })

    await harness.workflows.saveAsSkill({
      ...harness.request,
      historyReplay: { target: 'claude-code', contextReset: true }
    })

    expect(harness.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        provenanceContext: expect.objectContaining({
          runtimeSegmentId: 'runtime-segment-after-context-reset'
        })
      })
    )
  })

  it.each<readonly [string, AgentFrameworkId, HistoryReplayTarget]>([
    ['Claude Code', 'claude-code', 'claude-code'],
    ['OpenCode', 'opencode', 'opencode'],
    ['Codex Responses', 'codex', 'codex-response'],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ])('keeps shared hidden-turn semantics on %s', async (_name, frameworkId, target) => {
    const harness = createHarness((session) => {
      session.agentFrameworkId = frameworkId
    })

    await harness.workflows.saveAsSkill({
      ...harness.request,
      historyReplay: { target }
    })

    expect(harness.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressUserMessage: true,
        forcedSkillIds: ['customize'],
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

    const sent = harness.sendPrompt.mock.calls[0]?.[0]
    expect(sent?.resumeFallback?.historyPreamble).toContain('Build a reusable analysis workflow.')
    expect(sent?.resumeFallback?.historyPreamble).not.toContain('flat tail')
  })

  it('fails closed when the durable branch changed after the click', async () => {
    const harness = createHarness()

    await expect(
      harness.workflows.saveAsSkill({ ...harness.request, messageBranchId: 'stale-branch' })
    ).rejects.toThrow('active conversation branch changed')
    expect(harness.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not start unless the durable Session is idle', async () => {
    const harness = createHarness((session) => {
      session.status = 'running'
      session.activeRun = { promptMessageId: 'prompt-1', startedAt: 3 }
    })

    await expect(harness.workflows.saveAsSkill(harness.request)).rejects.toThrow(
      'requires an idle Session'
    )
    expect(harness.sendPrompt).not.toHaveBeenCalled()
  })

  it('ignores renderer-only replay budget overrides', async () => {
    const harness = createHarness()

    await harness.workflows.saveAsSkill({
      ...harness.request,
      historyReplay: { target: 'claude-code', budget: 1 } as never
    })

    expect(harness.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeFallback: expect.objectContaining({
          historyPreamble: expect.stringContaining('Build a reusable analysis workflow.')
        })
      })
    )
  })

  it('rejects an unknown renderer replay target', async () => {
    const harness = createHarness()

    await expect(
      harness.workflows.saveAsSkill({
        ...harness.request,
        historyReplay: { target: 'renderer-owned-policy' } as never
      })
    ).rejects.toThrow('history replay target is invalid')
    expect(harness.sendPrompt).not.toHaveBeenCalled()
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
    expect(harness.sendPrompt).not.toHaveBeenCalled()
  })
})
