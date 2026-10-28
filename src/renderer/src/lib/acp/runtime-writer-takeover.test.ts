import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeWriterOwner } from '../../../../main/session-persistence/runtime-writer'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import { applyWorkspaceRuntimeEvent } from './workspace-events'
import {
  processIncrementalWorkspaceRuntimeEvents,
  resetWorkspaceRuntimeEventOwnerForTests
} from './workspace-runtime-event-owner'
import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { useDesktopRuntimeRecoveryStore } from '../../stores/desktop-runtime-recovery-store'
import { ensureRuntimeWriter } from './runtime-writer-client'
import { liveWorkspaceRuntimePresentation } from './workspace-runtime-presentation-buffer'

afterEach(() => vi.unstubAllGlobals())
it('a successor reloads durable messages before replaying the host window without duplicating text', async () => {
  let now = 0
  vi.stubGlobal('performance', { now: () => now })
  const owner = new RuntimeWriterOwner(() => now)
  owner.claim('electron:desktop')
  const base = {
    id: 'session',
    projectId: 'project',
    title: 'Existing',
    cwd: '/test',
    status: 'running' as const,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1
  }
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().hydrateSessions([base])
  const event = {
    id: 'text-already-saved',
    kind: 'message' as const,
    role: 'assistant' as const,
    level: 'info' as const,
    sessionId: 'session',
    runId: 'run',
    timestamp: 2,
    text: 'Already saved by desktop'
  }
  await applyWorkspaceRuntimeEvent(event)
  const durable = { ...toPersistedSession(useSessionStore.getState().sessions[0]), revision: 2 }
  expect(durable.messages).toHaveLength(1)
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().hydrateSessions([base])
  const loadOne = vi.fn(async () => durable)
  vi.stubGlobal('window', {
    api: {
      lifecycle: { claimRuntimeWriter: vi.fn(async () => owner.claim('web:phone')) },
      sessions: { loadOne },
      acp: { getState: vi.fn(async () => ({ events: [event] })) }
    }
  })
  await processIncrementalWorkspaceRuntimeEvents([event])
  expect(useSessionStore.getState().sessions[0].messages).toHaveLength(0)
  now = 21_000
  await processIncrementalWorkspaceRuntimeEvents([event])
  expect(loadOne).toHaveBeenCalledTimes(1)
  expect(useSessionStore.getState().sessions[0].messages).toEqual(durable.messages)
  expect(useSessionStore.getState().streamingMessages).toEqual({})
})

describe('incremental batches waiting for writer presentation backlog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', generation: undefined })
    resetWorkspaceRuntimeEventOwnerForTests()
  })

  it.each([false, true])(
    'preserves batch provenance when service replacement is %s',
    async (replaceService) => {
      const epoch = useDesktopRuntimeRecoveryStore.getState().epoch + 1
      useDesktopRuntimeRecoveryStore.setState({
        phase: 'connected',
        epoch,
        generation: 'service-a',
        closing: false
      })
      useSessionStore.setState(createInitialSessionState())
      resetWorkspaceRuntimeEventOwnerForTests()
      useSessionStore.getState().hydrateSessions([
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Original',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
          runtimeTranscriptOwner: 'main'
        }
      ])
      useSessionStore
        .getState()
        .appendUserMessage({ sessionId: 'session-1', content: 'Original request' })
      const promptMessageId = useSessionStore.getState().sessions[0].messages[0].id
      let owner = new RuntimeWriterOwner()
      let snapshotEvents: AcpRuntimeEvent[] = [1, 2].map((index) => ({
        id: `service-a:backlog-${index}`,
        kind: 'message',
        role: 'assistant',
        level: 'info',
        timestamp: index,
        sessionId: 'session-1',
        promptMessageId,
        text: 'x'.repeat(100)
      }))
      vi.stubGlobal('window', {
        api: {
          lifecycle: { claimRuntimeWriter: vi.fn(async () => owner.claim('electron:desktop')) },
          sessions: { loadOne: vi.fn(async () => undefined) },
          acp: { getState: vi.fn(async () => ({ events: snapshotEvents })) }
        }
      })
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      vi.spyOn(liveWorkspaceRuntimePresentation, 'shouldAnimate').mockReturnValue(true)
      vi.spyOn(liveWorkspaceRuntimePresentation, 'schedule').mockImplementation((callback) => {
        release = callback
        entered()
        return () => undefined
      })
      expect(await ensureRuntimeWriter()).toBe(true)
      const compaction: AcpRuntimeEvent = {
        id: 'service-a:compaction-start',
        kind: 'compaction',
        level: 'info',
        timestamp: 3,
        sessionId: 'session-1',
        promptMessageId,
        status: 'in_progress',
        title: 'Compacting',
        toolCallId: 'old-compaction'
      }
      const oldBatch = processIncrementalWorkspaceRuntimeEvents([compaction])
      await waiting
      expect(useSessionStore.getState().sessions[0].compacting).toBeUndefined()
      useSessionStore.getState().finishRun('session-1')
      if (replaceService) {
        useDesktopRuntimeRecoveryStore.setState({ epoch: epoch + 1, generation: 'service-b' })
        owner = new RuntimeWriterOwner()
        snapshotEvents = []
        expect(await ensureRuntimeWriter()).toBe(true)
      }
      release()
      await oldBatch
      const session = useSessionStore.getState().sessions[0]
      expect(Boolean(session.compacting)).toBe(!replaceService)
      expect(
        toPersistedSession(session).activities?.some((activity) =>
          activity.eventIds.includes(compaction.id)
        ) ?? false
      ).toBe(!replaceService)
    }
  )
})
