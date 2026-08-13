// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { materializeSessionConversationGraph } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import { useWorkspaceRuntimeSaveAsSkillOwner } from './workspace-runtime-save-as-skill-owner'

vi.mock('../session-persistence/session-persistence', () => ({
  flushSessionPersistence: vi.fn(async () => undefined)
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = materializeSessionConversationGraph({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Reusable workflow',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Analyze these samples.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer-1',
      role: 'agent',
      content: 'Analysis complete.',
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
}) as ChatSession

describe('workspace Save as skill owner', () => {
  let root: Root | undefined

  afterEach(() => {
    if (root) act(() => root?.unmount())
    root = undefined
    vi.restoreAllMocks()
  })

  it('deduplicates one Session while flushing its exact active Branch before dispatch', async () => {
    useSessionStore.setState({ sessions: [session] })
    let release!: () => void
    const saveAsSkill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { saveAsSkill } }
    })
    const runtime = {
      state: { sessionIds: ['session-1'] },
      resumeSession: vi.fn()
    } as never
    let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
    const Harness = (): null => {
      owner = useWorkspaceRuntimeSaveAsSkillOwner({
        runtime,
        supportsImageInput: true,
        getHistoryReplayDescriptor: () => ({ target: 'claude-code', contextWindow: 100_000 })
      })
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root?.render(createElement(Harness)))
    const graph = session.conversationGraph!
    const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
    const request = {
      projectId: session.projectId,
      sessionId: session.id,
      agentFrameId: frame.id,
      messageBranchId: frame.activeBranchId
    }

    let first!: Promise<void>
    await act(async () => {
      first = owner.saveAsSkill(request)
      void owner.saveAsSkill(request)
      await vi.waitFor(() => expect(saveAsSkill).toHaveBeenCalledOnce())
    })

    expect(owner.saveAsSkillInFlightSessionIds).toEqual(['session-1'])
    expect(flushSessionPersistence).toHaveBeenCalledOnce()
    expect(saveAsSkill).toHaveBeenCalledWith({
      ...request,
      historyReplay: {
        target: 'claude-code',
        contextWindow: 100_000,
        supportsImageInput: true
      }
    })

    await act(async () => {
      release()
      await first
    })
    expect(owner.saveAsSkillInFlightSessionIds).toEqual([])
  })

  it.each([
    { contextReset: false, expectedContextReset: undefined },
    { contextReset: true, expectedContextReset: true }
  ])(
    'replays history after resume only when contextReset is $contextReset',
    async ({ contextReset, expectedContextReset }) => {
      useSessionStore.setState({ sessions: [session] })
      const saveAsSkill = vi.fn(async () => undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { acp: { saveAsSkill } }
      })
      const runtime = {
        state: { cwd: '/workspace', sessionIds: [] },
        resumeSession: vi.fn(async () => ({
          sessionId: 'session-1',
          cwd: '/workspace',
          contextReset
        }))
      } as never
      let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
      const Harness = (): null => {
        owner = useWorkspaceRuntimeSaveAsSkillOwner({
          runtime,
          supportsImageInput: true,
          getHistoryReplayDescriptor: () => ({ target: 'claude-code', contextWindow: 100_000 })
        })
        return null
      }
      root = createRoot(document.createElement('div'))
      act(() => root?.render(createElement(Harness)))
      const graph = session.conversationGraph!
      const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!

      await act(() =>
        owner.saveAsSkill({
          projectId: session.projectId,
          sessionId: session.id,
          agentFrameId: frame.id,
          messageBranchId: frame.activeBranchId
        })
      )

      expect(saveAsSkill).toHaveBeenCalledWith({
        projectId: session.projectId,
        sessionId: session.id,
        agentFrameId: frame.id,
        messageBranchId: frame.activeBranchId,
        historyReplay: {
          target: 'claude-code',
          contextWindow: 100_000,
          supportsImageInput: true,
          ...(expectedContextReset ? { contextReset: expectedContextReset } : {})
        }
      })
    }
  )
})
