// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { materializeSessionConversationGraph } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import type { WorkspaceSessionRuntimeSelection } from './useWorkspaceAgentRuntime'
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
  agentModel: 'selected-model',
  agentFrameworkId: 'claude-code',
  agentBackendId: 'claude-code:session-provider',
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

const sessionRuntimeSelection = (): WorkspaceSessionRuntimeSelection => ({
  supportsImageInput: true,
  supportsImageRelay: false,
  agentFrameworkId: 'claude-code' as const,
  agentBackendId: 'claude-code:session-provider',
  agentModel: 'selected-model',
  agentTarget: {
    frameworkId: 'claude-code' as const,
    providerId: 'session-provider',
    model: 'selected-model',
    reasoningEffort: 'high' as const
  },
  historyReplayDescriptor: { target: 'claude-code' as const, contextWindow: 100_000 }
})

describe('workspace Save as skill owner', () => {
  let root: Root | undefined

  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      activeProviderId: 'session-provider',
      activeModel: 'selected-model',
      agentFrameworkId: 'claude-code',
      providers: [
        {
          id: 'session-provider',
          type: 'custom',
          name: 'Session provider',
          models: ['selected-model'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })
  })

  afterEach(() => {
    if (root) act(() => root?.unmount())
    root = undefined
    vi.restoreAllMocks()
  })

  it('deduplicates one Session and keeps its target instead of the active Settings default', async () => {
    useSessionStore.setState({ sessions: [session] })
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      activeProviderId: 'global-provider',
      activeModel: 'global-model',
      providers: [
        ...useSettingsStore.getState().providers,
        {
          id: 'global-provider',
          type: 'custom',
          name: 'Global provider',
          models: ['global-model'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
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
    const resumeSession = vi.fn()
    const runtime = {
      state: { sessionIds: ['session-1'] },
      resumeSession
    } as never
    let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
    const Harness = (): null => {
      owner = useWorkspaceRuntimeSaveAsSkillOwner({
        runtime,
        resolveSessionRuntimeSelection: sessionRuntimeSelection
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
      promptMessageId: expect.any(String)
    })
    expect(resumeSession).toHaveBeenCalledWith(
      session.id,
      session.cwd,
      session.projectId,
      undefined,
      session.agentFrameworkId,
      session.agentBackendId,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionRuntimeSelection().agentTarget,
      true
    )
    expect(useSessionStore.getState().sessions[0].agentModel).toBe('selected-model')

    await act(async () => {
      release()
      await first
    })
    expect(owner.saveAsSkillInFlightSessionIds).toEqual([])
  })

  it('keeps a rejected hidden turn recoverable', async () => {
    useSessionStore.setState({
      sessions: [{ ...session, branchContextResetRequired: true }]
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        acp: { saveAsSkill: vi.fn(async () => Promise.reject(new Error('Disconnected'))) },
        notebook: { shutdown: vi.fn(async () => ({ sessionId: session.id, status: 'shutdown' })) }
      }
    })
    const runtime = {
      state: { sessionIds: ['session-1'] },
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(async () => ({
        sessionId: session.id,
        cwd: session.cwd,
        contextReset: true
      }))
    } as never
    let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
    const Harness = (): null => {
      owner = useWorkspaceRuntimeSaveAsSkillOwner({
        runtime,
        resolveSessionRuntimeSelection: sessionRuntimeSelection
      })
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root?.render(createElement(Harness)))
    const graph = session.conversationGraph!
    const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!

    await expect(
      act(() =>
        owner.saveAsSkill({
          projectId: session.projectId,
          sessionId: session.id,
          agentFrameId: frame.id,
          messageBranchId: frame.activeBranchId
        })
      )
    ).rejects.toThrow('Disconnected')

    const rejected = useSessionStore.getState().sessions[0]
    const control = rejected?.messages.at(-1)
    expect(control).toMatchObject({ turnIntent: 'save-as-skill', interrupted: true })
    expect(rejected?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'connection-lost',
      promptMessageId: control?.id
    })
    expect(rejected?.pendingHistoryReplay).toEqual({ kind: 'all' })
  })

  it.each([{ contextReset: false }, { contextReset: true }])(
    'replays history after resume only when contextReset is $contextReset',
    async ({ contextReset }) => {
      useSessionStore.setState({ sessions: [session] })
      const originalRuntimeSegmentId = session.conversationGraph?.runtimeSegments.at(-1)?.id
      const originalRuntimeSegmentCount = session.conversationGraph?.runtimeSegments.length ?? 0
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
          resolveSessionRuntimeSelection: sessionRuntimeSelection
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

      const persistedSession = useSessionStore.getState().sessions[0]
      const persistedRuntimeSegments = persistedSession?.conversationGraph?.runtimeSegments ?? []
      const persistedRuntimeSegmentId = persistedRuntimeSegments.at(-1)?.id
      expect(persistedRuntimeSegmentId === originalRuntimeSegmentId).toBe(!contextReset)
      expect(persistedRuntimeSegments).toHaveLength(
        originalRuntimeSegmentCount + (contextReset ? 1 : 0)
      )
      const controlMessage = persistedSession?.messages.at(-1)
      expect(controlMessage).toMatchObject({
        role: 'user',
        turnIntent: 'save-as-skill'
      })
      expect(persistedSession).toMatchObject({
        status: 'running',
        agentModel: 'selected-model',
        activeRun: { promptMessageId: controlMessage?.id }
      })
      expect(persistedSession?.pendingHistoryReplay).toBeUndefined()

      expect(saveAsSkill).toHaveBeenCalledWith({
        projectId: session.projectId,
        sessionId: session.id,
        agentFrameId: frame.id,
        messageBranchId: frame.activeBranchId,
        promptMessageId: controlMessage?.id
      })
    }
  )

  it.each([
    {
      name: 'removed Provider',
      persistedFrameworkId: 'codex' as const,
      persistedBackendId: 'codex:removed-provider',
      attached: true
    },
    {
      name: 'legacy Session without Provider identity',
      persistedFrameworkId: undefined,
      persistedBackendId: undefined,
      attached: false
    }
  ])(
    'adopts the current Provider for a $name',
    async ({ persistedFrameworkId, persistedBackendId, attached }) => {
      const original = structuredClone(session)
      original.agentFrameworkId = persistedFrameworkId
      original.agentBackendId = persistedBackendId
      useSessionStore.setState({ sessions: [original] })
      const saveAsSkill = vi.fn(async () => undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { acp: { saveAsSkill } }
      })
      const resumeSession = vi.fn(async () => ({
        sessionId: session.id,
        cwd: session.cwd,
        frameworkId: 'opencode' as const,
        backendId: 'opencode:active-provider',
        contextReset: true
      }))
      const runtime = {
        state: { cwd: session.cwd, sessionIds: attached ? [session.id] : [] },
        resumeSession,
        resetSessionContext: vi.fn()
      } as never
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        activeProviderId: 'active-provider',
        activeModel: 'active-model',
        agentFrameworkId: 'opencode',
        visionModel: {
          providerId: 'vision-provider',
          model: 'vision-model',
          reasoningEffort: 'default'
        },
        providers: [
          {
            id: 'active-provider',
            type: 'custom',
            name: 'Active provider',
            models: ['active-model'],
            supportsImageInput: false,
            hasKey: true,
            needsKey: false
          },
          {
            id: 'vision-provider',
            type: 'custom',
            name: 'Vision provider',
            models: ['vision-model'],
            supportsImageInput: true,
            hasKey: true,
            needsKey: false
          }
        ]
      })
      let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
      const Harness = (): null => {
        owner = useWorkspaceRuntimeSaveAsSkillOwner({
          runtime,
          resolveSessionRuntimeSelection: () => ({
            supportsImageInput: false,
            supportsImageRelay: true,
            agentFrameworkId: 'opencode',
            agentBackendId: 'opencode:active-provider',
            agentModel: 'active-model',
            agentTarget: {
              frameworkId: 'opencode',
              providerId: 'active-provider',
              model: 'active-model',
              reasoningEffort: 'default'
            },
            historyReplayDescriptor: { target: 'opencode', contextWindow: 200_000 }
          })
        })
        return null
      }
      root = createRoot(document.createElement('div'))
      act(() => root?.render(createElement(Harness)))
      const graph = original.conversationGraph!
      const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!

      await act(() =>
        owner.saveAsSkill({
          projectId: original.projectId,
          sessionId: original.id,
          agentFrameId: frame.id,
          messageBranchId: frame.activeBranchId
        })
      )

      expect(resumeSession).toHaveBeenCalledOnce()
      expect(useSessionStore.getState().sessions[0]).toMatchObject({
        agentFrameworkId: 'opencode',
        agentBackendId: 'opencode:active-provider',
        agentModel: 'active-model'
      })
      expect(saveAsSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: original.projectId,
          sessionId: original.id,
          supportsImageRelay: true,
          promptMessageId: expect.any(String)
        })
      )
    }
  )

  it('resets and replays the selected Branch before dispatch', async () => {
    useSessionStore.setState({
      sessions: [{ ...session, branchContextResetRequired: true }]
    })
    const shutdown = vi.fn(async () => ({ sessionId: session.id, status: 'shutdown' }))
    const saveAsSkill = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { saveAsSkill }, notebook: { shutdown } }
    })
    const resetSessionContext = vi.fn(async () => ({
      sessionId: session.id,
      cwd: session.cwd,
      contextReset: true
    }))
    const runtime = {
      state: { cwd: session.cwd, sessionIds: [session.id] },
      resumeSession: vi.fn(),
      resetSessionContext
    } as never
    let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
    const Harness = (): null => {
      owner = useWorkspaceRuntimeSaveAsSkillOwner({
        runtime,
        resolveSessionRuntimeSelection: sessionRuntimeSelection
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

    expect(shutdown).toHaveBeenCalledWith({
      sessionId: session.id,
      workspaceCwd: session.cwd,
      projectId: session.projectId
    })
    expect(resetSessionContext).toHaveBeenCalledOnce()
    expect(resetSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      saveAsSkill.mock.invocationCallOrder[0]
    )
    expect(saveAsSkill).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: expect.any(String) })
    )
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBeUndefined()
  })

  it('replays after a Specialist switch before dispatch', async () => {
    useSessionStore.setState({
      sessions: [{ ...session, specialistSwitchResetRequired: true }]
    })
    const saveAsSkill = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { acp: { saveAsSkill } }
    })
    const runtime = {
      state: { cwd: session.cwd, sessionIds: [session.id] },
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn()
    } as never
    let owner!: ReturnType<typeof useWorkspaceRuntimeSaveAsSkillOwner>
    const Harness = (): null => {
      owner = useWorkspaceRuntimeSaveAsSkillOwner({
        runtime,
        resolveSessionRuntimeSelection: sessionRuntimeSelection
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

    expect(saveAsSkill).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: expect.any(String) })
    )
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()
  })
})
