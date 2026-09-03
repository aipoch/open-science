import type {
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpStateSnapshot
} from '../../../../shared/acp'
import type { HistoryReplayTarget } from '../../../../shared/history-preamble'
import type {
  DelegationPolicy,
  PersistedChatSession,
  SessionPdfContext
} from '../../../../shared/session-persistence'
import type { AgentFrameworkId } from '../../../../shared/settings'
import {
  MAX_COMPOSER_ATTACHMENTS,
  type FinalizeUploadSessionRequest,
  type UploadedAttachment
} from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore,
  type ChatMessage,
  type ChatSession
} from '../../stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { resetSessionPersistenceWriteFailuresForTests } from '../session-persistence/session-persistence'
import { applyWorkspaceRuntimeEvent } from './workspace-events'
import {
  clearLinkedPendingPdfContext,
  createWorkspaceRuntimeEventProcessor,
  getResumeFailureMessage,
  markRunningSessionsDisconnectedOnDrop,
  pendingWorkspacePermissions,
  processVisibleWorkspaceRuntimeEvents,
  revealLinkedPdfContext,
  setWorkspacePermissionProfile,
  syncWorkspaceContextUsage
} from './useWorkspaceAgentRuntime'
import {
  resendEditedWorkspaceMessage,
  sendWorkspaceMessage
} from './workspace-runtime-command-owner'
import { respondToWorkspaceElicitation } from './workspace-elicitation-runtime'
import {
  resetWorkspaceRuntimeEventOwnerForTests,
  syncWorkspaceElicitationState,
  syncWorkspacePermissionState
} from './workspace-runtime-event-owner'
import {
  cancelWorkspaceRun,
  compactWorkspaceSession,
  createWorkspaceRuntimeSessionLifecycleOwner,
  processContextOverflowRecovery,
  recoverContextOverflowWorkspaceSession,
  resumeInterruptedWorkspaceSession
} from './workspace-runtime-session-lifecycle-owner'

// Runtime boundary tests deliberately feed incomplete provider/IPC events through defensive guards.
const createEvent = (overrides: Partial<AcpRuntimeEvent>): AcpRuntimeEvent =>
  ({
    id: 'event-1',
    timestamp: 1710000000000,
    kind: 'message',
    level: 'info',
    sessionId: 'transport-session-1',
    ...overrides
  }) as unknown as AcpRuntimeEvent

const createSnapshot = (sessionIds: string[] = []): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace/project',
  sessionIds,
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}

const createSessionPolicyApi = (): {
  saveSession: Mock<(session: PersistedChatSession) => Promise<PersistedChatSession>>
  setDelegationPolicy: Mock<
    (
      projectId: string,
      sessionId: string,
      policy: DelegationPolicy
    ) => Promise<PersistedChatSession>
  >
} => ({
  saveSession: vi.fn(async (session: PersistedChatSession) => session),
  setDelegationPolicy: vi.fn(
    async (_projectId: string, sessionId: string, policy: DelegationPolicy) => {
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      return {
        ...toPersistedSession(session),
        revision: (session.revision ?? 0) + 1,
        delegationPolicy: policy
      }
    }
  )
})

const createAttachment = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: '.pending',
  name: 'notes.txt',
  originalName: 'notes.txt',
  path: '/Users/example/.open-science/uploads/default-project/.pending/notes.txt',
  mimeType: 'text/plain',
  size: 12,
  ...overrides
})

const flushRuntimeTasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetSessionPersistenceWriteFailuresForTests()
})

describe('workspace permission wait recovery', () => {
  it('projects a restored main-owned request and prefers a matching live request', () => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    const durableRequest = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: durableRequest,
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))

    expect(pendingWorkspacePermissions(useSessionStore.getState().sessions, [])).toEqual([
      durableRequest
    ])

    const liveRequest = { ...durableRequest, title: 'Live runtime title' }
    expect(pendingWorkspacePermissions(useSessionStore.getState().sessions, [liveRequest])).toEqual(
      [liveRequest]
    )

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? { ...session, status: 'error', error: 'Continuation failed' }
          : session
      )
    }))
    expect(pendingWorkspacePermissions(useSessionStore.getState().sessions, [])).toEqual([
      durableRequest
    ])

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        runtimeContext: session.runtimeContext?.permission
          ? {
              ...session.runtimeContext,
              permission: { ...session.runtimeContext.permission, state: 'continuing' }
            }
          : session.runtimeContext
      }))
    }))
    expect(pendingWorkspacePermissions(useSessionStore.getState().sessions, [])).toEqual([])
  })
})

describe('workspace permission profile persistence', () => {
  it('persists the profile committed by the runtime instead of a superseded request', async () => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Test permission mode',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'full'
    })
    const committedSnapshot = createSnapshot(['session-1'])
    committedSnapshot.permissionProfiles['session-1'] = {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      availableModeIds: [],
      fullAccessAvailable: true
    }
    const runtime = {
      state: createSnapshot(['session-1']),
      setPermissionProfile: vi.fn().mockResolvedValue(committedSnapshot)
    }

    await expect(setWorkspacePermissionProfile(runtime, 'session-1', 'full')).resolves.toBe(true)

    expect(runtime.setPermissionProfile).toHaveBeenCalledWith('session-1', 'full')
    expect(
      useSessionStore.getState().sessions.find(({ id }) => id === 'session-1')?.permissionProfile
    ).toBe('ask')
  })
})

describe('workspace agent runtime event processing', () => {
  const createTextEvents = (count: number): AcpRuntimeEvent[] =>
    Array.from({ length: count }, (_, index) =>
      createEvent({
        id: `message-event-${index + 1}`,
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: '字'
      })
    )

  const createTimerPresentation = (): {
    now: () => number
    schedule: (callback: () => void, delayMs: number) => () => void
    shouldAnimate: () => boolean
  } => ({
    now: Date.now,
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    shouldAnimate: () => true
  })

  it('does not replay a retained snapshot after incremental events were already applied', async () => {
    const appliedEventIds: string[] = []
    const processor = createWorkspaceRuntimeEventProcessor(async (event) => {
      appliedEventIds.push(event.id)
      return true
    })
    const events = Array.from({ length: 600 }, (_, index) =>
      createEvent({
        id: `tool-event-${index + 1}`,
        kind: 'tool',
        toolCallId: `tool-${index + 1}`,
        status: 'completed'
      })
    )

    for (const event of events) await processor.processIncremental([event])
    await processor.process(events.slice(-500))

    expect(appliedEventIds).toEqual(events.map((event) => event.id))
  })

  it('does not replay a processed event from an oversized incremental batch', async () => {
    const appliedEventIds: string[] = []
    const processor = createWorkspaceRuntimeEventProcessor(async (event) => {
      appliedEventIds.push(event.id)
      return true
    })
    const firstEvent = createEvent({ id: 'tool-event-1', kind: 'tool', status: 'completed' })
    const laterEvents = Array.from({ length: 600 }, (_, index) =>
      createEvent({
        id: `tool-event-${index + 2}`,
        kind: 'tool',
        status: 'completed'
      })
    )

    await processor.processIncremental([firstEvent])
    await processor.processIncremental([firstEvent, ...laterEvents])
    await processor.drain()

    expect(appliedEventIds).toEqual([firstEvent, ...laterEvents].map((event) => event.id))
  })

  it('keeps synchronous incremental event admission within a linear main-thread work budget', async () => {
    let eventIdReads = 0
    const appliedEventIds: string[] = []
    const processor = createWorkspaceRuntimeEventProcessor(async (event) => {
      appliedEventIds.push(event.id)
      return true
    })
    const events = Array.from({ length: 1_200 }, (_, index) => {
      const event = createEvent({
        id: `thought-event-${index + 1}`,
        kind: 'thought',
        role: 'assistant',
        text: 'x'
      })
      const eventId = event.id
      Object.defineProperty(event, 'id', {
        enumerable: true,
        get: () => {
          eventIdReads += 1
          return eventId
        }
      })
      return event
    })

    // IPC listeners admit live events synchronously and intentionally do not await presentation.
    const drains = events.map((event) => processor.processIncremental([event]))
    const admissionEventIdReads = eventIdReads
    await Promise.all(drains)
    await processor.drain()

    expect(admissionEventIdReads).toBeLessThan(events.length * 20)
    expect(appliedEventIds).toEqual(events.map((event) => event.id))
  })

  it('keeps live presentation drain of a thought burst within a linear main-thread work budget', async () => {
    let eventIdReads = 0
    const appliedEventIds: string[] = []
    const processor = createWorkspaceRuntimeEventProcessor(
      async (event) => {
        appliedEventIds.push(event.id)
        return true
      },
      { presentation: createTimerPresentation() }
    )
    const events = Array.from({ length: 1_200 }, (_, index) => {
      const event = createEvent({
        id: `thought-event-${index + 1}`,
        kind: 'thought',
        role: 'assistant',
        text: 'x'
      })
      const eventId = event.id
      Object.defineProperty(event, 'id', {
        enumerable: true,
        get: () => {
          eventIdReads += 1
          return eventId
        }
      })
      return event
    })

    const drains = events.map((event) => processor.processIncremental([event]))
    await Promise.all(drains)
    await processor.drain()

    // Admission-only budget is 20 reads/event. Live drain also walks the pending lane and the
    // selected batch, so allow a still-linear 32. The unfixed presentation path was ~4,600.
    expect(eventIdReads).toBeLessThan(events.length * 32)
    expect(appliedEventIds).toEqual(events.map((event) => event.id))
  })

  it('releases fast assistant text in grapheme-budgeted 30 fps batches', async () => {
    vi.useFakeTimers()
    try {
      const visibleBatches: Array<{ ids: string[]; timestamp: number }> = []
      const applyEvent = vi
        .fn<(event: AcpRuntimeEvent) => Promise<boolean>>()
        .mockResolvedValue(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent, {
        applyEventBatch: async (events) => {
          visibleBatches.push({ ids: events.map((event) => event.id), timestamp: Date.now() })
          return true
        },
        presentation: createTimerPresentation()
      })

      const drain = processor.process(createTextEvents(24))
      await vi.advanceTimersByTimeAsync(200)
      await drain

      expect(visibleBatches.map(({ ids }) => ids.length)).toEqual([8, 8, 8])
      expect(visibleBatches.flatMap(({ ids }) => ids)).toEqual(
        createTextEvents(24).map((event) => event.id)
      )
      expect(
        visibleBatches
          .slice(1)
          .every((batch, index) => batch.timestamp - visibleBatches[index].timestamp >= 33)
      ).toBe(true)
      expect(applyEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('catches up before an ordinary tool boundary within four presentation frames', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{ kind: 'text' | 'tool'; timestamp: number; count: number }> = []
      const processor = createWorkspaceRuntimeEventProcessor(
        async (event) => {
          calls.push({
            kind: event.kind === 'tool' ? 'tool' : 'text',
            timestamp: Date.now(),
            count: 1
          })
          return true
        },
        {
          applyEventBatch: async (events) => {
            calls.push({ kind: 'text', timestamp: Date.now(), count: events.length })
            return true
          },
          presentation: createTimerPresentation()
        }
      )
      const tool = createEvent({
        id: 'tool-event-1',
        kind: 'tool',
        toolCallId: 'tool-1',
        status: 'in_progress'
      })

      const drain = processor.process([...createTextEvents(32), tool])
      await vi.advanceTimersByTimeAsync(200)
      await drain

      expect(calls.map(({ kind, count }) => `${kind}:${count}`)).toEqual([
        'text:8',
        'text:8',
        'text:8',
        'text:8',
        'tool:1'
      ])
      expect(calls.at(-1)!.timestamp - calls[0].timestamp).toBeLessThanOrEqual(132)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes all pending text immediately at a terminal boundary', async () => {
    const calls: string[] = []
    const processor = createWorkspaceRuntimeEventProcessor(
      async (event) => {
        calls.push(event.kind)
        return true
      },
      {
        applyEventBatch: async (events) => {
          calls.push(`text:${events.length}`)
          return true
        },
        presentation: createTimerPresentation()
      }
    )

    await processor.process([
      ...createTextEvents(24),
      createEvent({ id: 'stop-event-1', kind: 'stop' })
    ])

    expect(calls).toEqual(['text:24', 'stop'])
  })

  it('flushes accepted text immediately at a persistence barrier', async () => {
    vi.useFakeTimers()
    try {
      const visibleEventIds: string[] = []
      const processor = createWorkspaceRuntimeEventProcessor(async () => true, {
        applyEventBatch: async (events) => {
          visibleEventIds.push(...events.map((event) => event.id))
          return true
        },
        presentation: createTimerPresentation()
      })

      const visibleDrain = processor.process(createTextEvents(24))
      await Promise.resolve()
      await Promise.resolve()
      const persistenceDrain = processor.drain()
      await Promise.all([visibleDrain, persistenceDrain])

      expect(visibleEventIds).toEqual(createTextEvents(24).map((event) => event.id))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mark failed runtime events as processed so they can retry', async () => {
    const processedEventIds = new Set<string>()
    const event = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      runId: 'run-1',
      artifactClaimId: 'claim-1'
    })
    const applyEvent = vi
      .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce(true)

    await processVisibleWorkspaceRuntimeEvents([event], processedEventIds, applyEvent)

    expect(processedEventIds.has('artifact-event-1')).toBe(false)

    await processVisibleWorkspaceRuntimeEvents([event], processedEventIds, applyEvent)

    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(processedEventIds.has('artifact-event-1')).toBe(true)
  })

  it('retries a transiently failed runtime event without requiring new runtime input', async () => {
    vi.useFakeTimers()
    try {
      const event = createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactClaimId: 'claim-1'
      })
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('move failed'))
        .mockResolvedValueOnce(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

      await processor.process([event])
      expect(applyEvent).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(249)
      expect(applyEvent).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1)

      expect(applyEvent).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transiently failed text batch without requiring new runtime input', async () => {
    vi.useFakeTimers()
    try {
      const events = createTextEvents(2)
      const applyEventBatch = vi
        .fn<(runtimeEvents: AcpRuntimeEvent[]) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('batch apply failed'))
        .mockResolvedValueOnce(true)
      const processor = createWorkspaceRuntimeEventProcessor(async () => true, {
        applyEventBatch
      })

      await processor.process(events)
      expect(applyEventBatch).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(249)
      expect(applyEventBatch).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1)

      expect(applyEventBatch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a scheduled retry before resolving an explicit session drain', async () => {
    vi.useFakeTimers()
    try {
      const event = createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactClaimId: 'claim-1'
      })
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('move failed'))
        .mockResolvedValueOnce(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

      await processor.process([event])
      await processor.drain(event.sessionId)

      expect(applyEvent).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminalizes a persistently failing event across later snapshots and drains', async () => {
    vi.useFakeTimers()
    try {
      const event = createEvent({
        id: 'artifact-event-1',
        kind: 'artifact',
        runId: 'run-1',
        artifactClaimId: 'claim-1'
      })
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockRejectedValue(new Error('move failed'))
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

      await processor.process([event])
      await vi.runAllTimersAsync()
      await processor.process([event])
      await processor.processIncremental([event])
      await processor.drain()

      expect(applyEvent).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks ignored runtime events as processed after the adapter handles them', async () => {
    const processedEventIds = new Set<string>()
    const event = createEvent({ id: 'tool-event-1', kind: 'tool' })
    const applyEvent = vi
      .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
      .mockResolvedValue(false)

    await processVisibleWorkspaceRuntimeEvents([event], processedEventIds, applyEvent)
    await processVisibleWorkspaceRuntimeEvents([event], processedEventIds, applyEvent)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(processedEventIds.has('tool-event-1')).toBe(true)
  })

  it('does not start duplicate processing while an event is already in flight', async () => {
    const processedEventIds = new Set<string>()
    const processingEventIds = new Set<string>()
    const event = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    let finishProcessing: ((wasApplied: boolean) => void) | undefined
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>(
      () =>
        new Promise((resolve) => {
          finishProcessing = resolve
        })
    )

    const firstPass = processVisibleWorkspaceRuntimeEvents(
      [event],
      processedEventIds,
      applyEvent,
      processingEventIds
    )
    await processVisibleWorkspaceRuntimeEvents(
      [event],
      processedEventIds,
      applyEvent,
      processingEventIds
    )

    finishProcessing?.(true)
    await firstPass

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(processedEventIds.has('artifact-event-1')).toBe(true)
  })

  it('keeps failed runtime events retryable while processing later visible events', async () => {
    const processedEventIds = new Set<string>()
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    const stopEvent = createEvent({ id: 'stop-event-1', kind: 'stop' })
    const applyEvent = vi
      .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await processVisibleWorkspaceRuntimeEvents(
      [artifactEvent, stopEvent],
      processedEventIds,
      applyEvent
    )

    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(processedEventIds.has('artifact-event-1')).toBe(false)
    expect(processedEventIds.has('stop-event-1')).toBe(true)

    await processVisibleWorkspaceRuntimeEvents(
      [artifactEvent, stopEvent],
      processedEventIds,
      applyEvent
    )

    expect(applyEvent).toHaveBeenCalledTimes(3)
    expect(processedEventIds.has('artifact-event-1')).toBe(true)
    expect(processedEventIds.has('stop-event-1')).toBe(true)
  })

  it.each([
    ['one session', 'transport-session-1'],
    ['unscoped events', undefined]
  ] as const)('serializes overlapping snapshots for %s', async (_scope, sessionId) => {
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact', sessionId })
    const stopEvent = createEvent({ id: 'stop-event-1', kind: 'stop', sessionId })
    let finishArtifact: ((wasApplied: boolean) => void) | undefined
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) => {
      if (event.id === 'artifact-event-1') {
        return new Promise((resolve) => {
          finishArtifact = resolve
        })
      }

      return Promise.resolve(true)
    })
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    const secondDrain = processor.process([artifactEvent, stopEvent])

    await Promise.resolve()

    expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual(['artifact-event-1'])

    finishArtifact?.(true)
    await Promise.all([firstDrain, secondDrain])

    expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual([
      'artifact-event-1',
      'stop-event-1'
    ])
  })

  it('processes another session while an earlier session event is still in flight', async () => {
    const artifactEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      sessionId: 'transport-session-1'
    })
    const messageEvent = createEvent({
      id: 'message-event-2',
      sessionId: 'transport-session-2'
    })
    const artifact = createDeferred<boolean>()
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) =>
      event.id === artifactEvent.id ? artifact.promise : Promise.resolve(true)
    )
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    const secondDrain = processor.process([artifactEvent, messageEvent])

    await Promise.resolve()

    expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual([
      'artifact-event-1',
      'message-event-2'
    ])

    artifact.resolve(true)
    await Promise.all([firstDrain, secondDrain])
  })

  it('keeps an accepted session event when a newer snapshot no longer contains it', async () => {
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    const stopEvent = createEvent({ id: 'stop-event-1', kind: 'stop' })
    const artifact = createDeferred<boolean>()
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) =>
      event.id === artifactEvent.id ? artifact.promise : Promise.resolve(true)
    )
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    const secondDrain = processor.process([artifactEvent, stopEvent])
    const emptySnapshotDrain = processor.process([])

    artifact.resolve(true)
    await Promise.all([firstDrain, secondDrain, emptySnapshotDrain])

    expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual([
      'artifact-event-1',
      'stop-event-1'
    ])
  })

  it('retries an accepted event that fails after a newer snapshot evicts it', async () => {
    vi.useFakeTimers()
    try {
      const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
      let rejectFirstAttempt!: (reason: Error) => void
      const firstAttempt = new Promise<boolean>((_resolve, reject) => {
        rejectFirstAttempt = reject
      })
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockImplementationOnce(() => firstAttempt)
        .mockResolvedValueOnce(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

      const firstDrain = processor.process([artifactEvent])
      void processor.process([])
      rejectFirstAttempt(new Error('move failed'))
      await firstDrain
      await vi.advanceTimersByTimeAsync(250)

      expect(applyEvent).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases an evicted event after its deferred retry also fails', async () => {
    vi.useFakeTimers()
    try {
      const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
      let rejectFirstAttempt!: (reason: Error) => void
      const firstAttempt = new Promise<boolean>((_resolve, reject) => {
        rejectFirstAttempt = reject
      })
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockImplementationOnce(() => firstAttempt)
        .mockRejectedValueOnce(new Error('move still failing'))
        .mockResolvedValue(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

      const firstDrain = processor.process([artifactEvent])
      void processor.process([])
      rejectFirstAttempt(new Error('move failed'))
      await firstDrain
      await vi.advanceTimersByTimeAsync(250)

      await processor.process([])
      await processor.drain()

      expect(applyEvent).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues with later lane events after an evicted retry fails', async () => {
    vi.useFakeTimers()
    try {
      const failedEvent = createEvent({
        id: 'message-event-1',
        role: 'assistant',
        messageId: 'assistant-message-1',
        text: '字'.repeat(100)
      })
      const laterEvents = createTextEvents(2).map((event, index) => ({
        ...event,
        id: `message-event-${index + 2}`
      }))
      const applyEvent = vi
        .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('move failed'))
        .mockRejectedValueOnce(new Error('move still failing'))
        .mockResolvedValue(true)
      const processor = createWorkspaceRuntimeEventProcessor(applyEvent, {
        presentation: createTimerPresentation()
      })

      await processor.process([failedEvent])
      await processor.processIncremental(laterEvents)
      await processor.process(laterEvents)
      await vi.advanceTimersByTimeAsync(250)

      expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual([
        'message-event-1',
        'message-event-1',
        'message-event-2',
        'message-event-3'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a snapshot without waiting for an in-flight lane that is no longer visible', async () => {
    const artifactEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      sessionId: 'transport-session-1'
    })
    const messageEvent = createEvent({
      id: 'message-event-2',
      sessionId: 'transport-session-2'
    })
    const artifact = createDeferred<boolean>()
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) =>
      event.id === artifactEvent.id ? artifact.promise : Promise.resolve(true)
    )
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    const secondDrain = processor.process([messageEvent])
    const secondDrainFinished = await Promise.race([
      secondDrain.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0))
    ])

    expect(applyEvent.mock.calls.map(([event]) => event.id)).toEqual([
      'artifact-event-1',
      'message-event-2'
    ])
    expect(secondDrainFinished).toBe(true)

    artifact.resolve(true)
    await Promise.all([firstDrain, secondDrain])
  })

  it('waits for every accepted lane at an explicit persistence barrier', async () => {
    const artifactEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      sessionId: 'transport-session-1'
    })
    const artifact = createDeferred<boolean>()
    const processor = createWorkspaceRuntimeEventProcessor(() => artifact.promise)

    const firstDrain = processor.process([artifactEvent])
    await processor.process([])
    const persistenceDrain = processor.drain()
    let persistenceFinished = false
    void persistenceDrain.then(() => (persistenceFinished = true))

    await Promise.resolve()
    expect(persistenceFinished).toBe(false)

    artifact.resolve(true)
    await Promise.all([firstDrain, persistenceDrain])
    expect(persistenceFinished).toBe(true)
  })

  it('waits for a lane accepted while the persistence barrier is in progress', async () => {
    const firstSessionEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      sessionId: 'transport-session-1'
    })
    const secondSessionEvent = createEvent({
      id: 'artifact-event-2',
      kind: 'artifact',
      sessionId: 'transport-session-2'
    })
    const firstArtifact = createDeferred<boolean>()
    const secondArtifact = createDeferred<boolean>()
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) =>
      event.sessionId === firstSessionEvent.sessionId
        ? firstArtifact.promise
        : secondArtifact.promise
    )
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([firstSessionEvent])
    const persistenceDrain = processor.drain()
    let persistenceFinished = false
    void persistenceDrain.then(() => (persistenceFinished = true))
    const secondDrain = processor.process([secondSessionEvent])

    firstArtifact.resolve(true)
    await firstDrain
    await Promise.resolve()
    expect(persistenceFinished).toBe(false)

    secondArtifact.resolve(true)
    await Promise.all([persistenceDrain, secondDrain])
  })

  it('waits only for the requested session at an explicit resume barrier', async () => {
    const firstSessionEvent = createEvent({
      id: 'artifact-event-1',
      kind: 'artifact',
      sessionId: 'transport-session-1'
    })
    const secondSessionEvent = createEvent({
      id: 'artifact-event-2',
      kind: 'artifact',
      sessionId: 'transport-session-2'
    })
    const firstArtifact = createDeferred<boolean>()
    const secondArtifact = createDeferred<boolean>()
    const applyEvent = vi.fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>((event) =>
      event.sessionId === firstSessionEvent.sessionId
        ? firstArtifact.promise
        : secondArtifact.promise
    )
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const visibleDrain = processor.process([firstSessionEvent, secondSessionEvent])
    const firstSessionDrain = processor.drain('transport-session-1')
    firstArtifact.resolve(true)

    await firstSessionDrain
    expect(applyEvent).toHaveBeenCalledTimes(2)

    secondArtifact.resolve(true)
    await visibleDrain
  })
})

describe('resume failure classification', () => {
  it('classifies an opaque ACP Internal error as unknown without guessing a cause', () => {
    const message = getResumeFailureMessage(
      new Error("Error invoking remote method 'acp:resume-session': RequestError: Internal error")
    )

    expect(message).toBe('Agent session resume failed: Unknown error')
  })

  it('classifies a bare Internal error as unknown when IPC drops the custom error name', () => {
    const message = getResumeFailureMessage(
      new Error("Error invoking remote method 'acp:resume-session': Error: Internal error")
    )

    expect(message).toBe('Agent session resume failed: Unknown error')
  })

  it('classifies an empty downstream failure at the Electron IPC seam as unknown', () => {
    const message = getResumeFailureMessage(
      new Error("Error invoking remote method 'acp:resume-session': Error")
    )

    expect(message).toBe('Agent session resume failed: Unknown error')
  })

  it('keeps a specific RequestError cause visible', () => {
    const message = getResumeFailureMessage(
      new Error(
        "Error invoking remote method 'acp:resume-session': RequestError: Internal error while loading provider configuration"
      )
    )

    expect(message).toBe(
      'Agent session resume failed: RequestError: Internal error while loading provider configuration'
    )
  })

  it('rewrites a genuine model↔framework incompatibility into the actionable settings message', () => {
    // Verbatim error thrown by settings/service.ts when the active provider cannot drive the framework.
    const message = getResumeFailureMessage(
      new Error(
        "The active model isn't compatible with Claude Code. Open Settings → Model to pick a compatible model or switch the agent framework."
      )
    )

    expect(message).toBe(
      "The active model isn't compatible with this agent framework. Open Settings → Model to pick a compatible model or switch frameworks."
    )
  })

  it('does not mislabel an ACP protocol-version mismatch as a model incompatibility', () => {
    // Different "not compatible with" phrase from the ACP handshake; must pass through unchanged.
    const message = getResumeFailureMessage(
      new Error('ACP protocol version is not compatible with this client')
    )

    expect(message).toBe(
      'Agent session resume failed: ACP protocol version is not compatible with this client'
    )
  })
})

describe('workspace context usage persistence', () => {
  it('keeps detached snapshots and replaces or clears attached snapshots', () => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Persist context usage',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    const usage = { used: 24_890, size: 200_000 }
    const updatedAt = useSessionStore.getState().sessions[0].updatedAt

    syncWorkspaceContextUsage(['session-1'], { 'session-1': usage })
    const sessionWithUsage = useSessionStore.getState().sessions[0]
    expect(toPersistedSession(sessionWithUsage).contextUsage).toEqual(usage)
    expect(sessionWithUsage.updatedAt).toBe(updatedAt)

    syncWorkspaceContextUsage([], {})
    expect(useSessionStore.getState().sessions[0]).toBe(sessionWithUsage)

    syncWorkspaceContextUsage(['session-1'], { 'session-1': { ...usage } })
    expect(useSessionStore.getState().sessions[0]).toBe(sessionWithUsage)

    syncWorkspaceContextUsage(['session-1'], {
      'session-1': { used: 30_000, size: 200_000 }
    })
    expect(useSessionStore.getState().sessions[0].contextUsage?.used).toBe(30_000)

    syncWorkspaceContextUsage(['session-1'], {})
    expect(useSessionStore.getState().sessions[0].contextUsage).toBeUndefined()
  })
})

describe('workspace durable elicitation', () => {
  beforeEach(() => {
    resetWorkspaceRuntimeEventOwnerForTests()
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-choice-1',
      content: 'Build something',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'opencode',
      agentBackendId: 'opencode:provider-1'
    })
    useSessionStore.getState().finishRun('session-choice-1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps another session waiting on a restored permission after answering a durable question', async () => {
    const permissionRequest: AcpPermissionRequest = {
      requestId: 'permission-restored',
      sessionId: 'session-permission-1',
      toolCallId: 'tool-permission-1',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      durable: true
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: permissionRequest.sessionId,
      content: 'Run the verification',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun(permissionRequest.sessionId)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === permissionRequest.sessionId
          ? {
              ...session,
              status: 'waiting-permission',
              runtimeContext: {
                version: 1,
                revision: 1,
                permission: {
                  state: 'pending',
                  request: permissionRequest,
                  originatingPromptMessageId: session.messages[0].id,
                  fingerprint: 'a'.repeat(64),
                  createdAt: 1
                }
              }
            }
          : session
      )
    }))
    syncWorkspacePermissionState([permissionRequest])
    useSessionStore.getState().setElicitationPending('session-choice-1', true)

    await respondToWorkspaceElicitation(
      {
        state: createSnapshot(['session-choice-1']),
        resumeSession: vi.fn(),
        respondToElicitation: vi.fn().mockResolvedValue(createSnapshot(['session-choice-1']))
      },
      {
        requestId: 'choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Minimal' }],
        request: {
          requestId: 'choice-1',
          sessionId: 'session-choice-1',
          toolCallId: 'tool-choice-1',
          message: 'Choose an approach',
          fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
          durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
        }
      }
    )

    expect(
      useSessionStore
        .getState()
        .sessions.find((session) => session.id === permissionRequest.sessionId)
    ).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: { permission: { state: 'pending', request: permissionRequest } }
    })
  })

  it('falls back to a pending permission in the same session after answering a durable question', async () => {
    const permissionRequest: AcpPermissionRequest = {
      requestId: 'permission-live',
      sessionId: 'session-choice-1',
      toolCallId: 'tool-permission-live',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const elicitationRequest = {
      requestId: 'choice-1',
      sessionId: 'session-choice-1',
      toolCallId: 'tool-choice-1',
      message: 'Choose an approach',
      fields: [{ id: 'question_0', label: 'Approach', kind: 'text' as const }],
      durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
    }
    syncWorkspacePermissionState([permissionRequest])
    syncWorkspaceElicitationState([elicitationRequest])
    const continued = {
      ...createSnapshot(['session-choice-1']),
      pendingPermissions: [permissionRequest],
      pendingElicitations: []
    }

    await respondToWorkspaceElicitation(
      {
        state: {
          ...createSnapshot(['session-choice-1']),
          pendingPermissions: [permissionRequest],
          pendingElicitations: [elicitationRequest]
        },
        resumeSession: vi.fn(),
        respondToElicitation: vi.fn().mockResolvedValue(continued)
      },
      {
        requestId: elicitationRequest.requestId,
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'Minimal' }],
        request: elicitationRequest
      }
    )

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')
  })

  it('returns to running when no actionable user choice remains', async () => {
    useSessionStore.getState().setElicitationPending('session-choice-1', true)
    const response = {
      requestId: 'choice-1',
      action: 'accept' as const,
      answers: [{ fieldId: 'question_0', value: 'Minimal' }],
      request: {
        requestId: 'choice-1',
        sessionId: 'session-choice-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [{ id: 'question_0', label: 'Approach', kind: 'text' as const }]
      }
    }
    const continued = {
      ...createSnapshot(['session-choice-1']),
      promptInFlight: true,
      promptInFlightSessionIds: ['session-choice-1'],
      agentPromptInFlightSessionIds: ['session-choice-1'],
      pendingElicitations: [
        {
          requestId: 'generic-form-1',
          sessionId: 'session-choice-1',
          toolCallId: 'generic-form-tool-1',
          message: 'Provide additional input',
          fields: [{ id: 'detail', label: 'Detail', kind: 'text' as const }]
        }
      ]
    }

    await respondToWorkspaceElicitation(
      {
        state: createSnapshot(['session-choice-1']),
        resumeSession: vi.fn(),
        respondToElicitation: vi.fn().mockResolvedValue(continued)
      },
      response
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
  })

  it('keeps waiting when another elicitation for the session remains pending', async () => {
    useSessionStore.getState().setElicitationPending('session-choice-1', true)
    const response = {
      requestId: 'choice-1',
      action: 'accept' as const,
      answers: [{ fieldId: 'question_0', value: 'Minimal' }],
      request: {
        requestId: 'choice-1',
        sessionId: 'session-choice-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [{ id: 'question_0', label: 'Approach', kind: 'text' as const }]
      }
    }
    const continued = {
      ...createSnapshot(['session-choice-1']),
      promptInFlight: true,
      promptInFlightSessionIds: ['session-choice-1'],
      agentPromptInFlightSessionIds: ['session-choice-1'],
      pendingElicitations: [
        {
          requestId: 'choice-2',
          sessionId: 'session-choice-1',
          toolCallId: 'tool-choice-2',
          message: 'Choose a format',
          fields: [{ id: 'question_0', label: 'Format', kind: 'text' as const }],
          durable: { kind: 'agent-user-choice' as const, requestId: 'choice-2' }
        }
      ]
    }

    await respondToWorkspaceElicitation(
      {
        state: createSnapshot(['session-choice-1']),
        resumeSession: vi.fn(),
        respondToElicitation: vi.fn().mockResolvedValue(continued)
      },
      response
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-for-user',
      agentPromptInFlight: true
    })
  })

  it('keeps a durable question waiting when its runtime is replaced', () => {
    const request = {
      requestId: 'choice-1',
      sessionId: 'session-choice-1',
      toolCallId: 'tool-choice-1',
      message: 'Choose an approach',
      fields: [{ id: 'question_0', label: 'Approach', kind: 'text' as const }],
      durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === request.sessionId
          ? {
              ...session,
              status: 'waiting-for-user',
              activities: [
                {
                  id: request.toolCallId,
                  kind: 'tool',
                  title: 'Waiting for an answer',
                  status: 'in_progress',
                  sortIndex: 1,
                  eventIds: [],
                  elicitation: {
                    message: request.message,
                    fields: request.fields,
                    state: 'pending',
                    durable: request.durable
                  },
                  createdAt: Date.now(),
                  updatedAt: Date.now()
                }
              ]
            }
          : session
      )
    }))

    syncWorkspaceElicitationState([request])
    syncWorkspaceElicitationState([])

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-for-user')
  })

  it('does not rearm an answered durable question when Permission becomes pending', () => {
    const request = {
      requestId: 'choice-1',
      sessionId: 'session-choice-1',
      toolCallId: 'tool-choice-1',
      message: 'Choose an approach',
      fields: [{ id: 'question_0', label: 'Approach', kind: 'text' as const }],
      durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === request.sessionId
          ? {
              ...session,
              status: 'waiting-for-user',
              activities: [
                {
                  id: request.toolCallId,
                  kind: 'tool',
                  title: 'Waiting for an answer',
                  status: 'in_progress',
                  sortIndex: 1,
                  eventIds: [],
                  elicitation: {
                    message: request.message,
                    fields: request.fields,
                    state: 'pending',
                    durable: request.durable
                  },
                  createdAt: Date.now(),
                  updatedAt: Date.now()
                }
              ]
            }
          : session
      )
    }))

    syncWorkspaceElicitationState([request])
    useSessionStore.getState().setElicitationPending(request.sessionId, false)
    useSessionStore.getState().setPermissionPending(request.sessionId)
    syncWorkspaceElicitationState([])
    useSessionStore.getState().clearPermissionPending(request.sessionId)

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      interactionState: { permission: false, elicitation: false }
    })
  })

  it.each<readonly [string, AgentFrameworkId, string, HistoryReplayTarget]>([
    ['Claude Code', 'claude-code', 'claude-code:anthropic', 'claude-code'],
    ['OpenCode', 'opencode', 'opencode:provider-1', 'opencode'],
    ['Codex Responses', 'codex', 'codex:responses-provider', 'codex-response'],
    ['Codex Bridge', 'codex', 'codex:bridge-provider', 'codex-bridge']
  ])(
    'reattaches a restored session before submitting its durable answer through %s',
    async (_path, frameworkId, backendId, historyReplayTarget) => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          agentFrameworkId: frameworkId,
          agentBackendId: backendId
        }))
      }))
      const resumeSession = vi.fn().mockResolvedValue({
        sessionId: 'session-choice-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId,
        backendId
      })
      const response = {
        requestId: 'choice-1',
        action: 'accept' as const,
        answers: [{ fieldId: 'question_0', value: 'Minimal' }],
        request: {
          requestId: 'choice-1',
          sessionId: 'session-choice-1',
          toolCallId: 'tool-choice-1',
          message: 'Choose an approach',
          fields: [
            {
              id: 'question_0',
              label: 'Approach',
              kind: 'single-select' as const,
              options: [
                { value: 'Minimal', label: 'Minimal' },
                { value: 'Expanded', label: 'Expanded' }
              ]
            }
          ],
          durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
        }
      }
      useSessionStore.getState().setElicitationPending(response.request.sessionId, true)
      const respondToElicitation = vi.fn(async () => {
        const persisted = useSessionStore
          .getState()
          .sessions.find((session) => session.id === response.request.sessionId)
        if (persisted?.status !== 'waiting-for-user') {
          throw new Error('Durable elicitation no longer matches the pending Session activity.')
        }
        return createSnapshot(['session-choice-1'])
      })

      await respondToWorkspaceElicitation(
        { state: createSnapshot(), resumeSession, respondToElicitation },
        response,
        {
          agentTarget: {
            frameworkId,
            providerId: backendId.slice(backendId.indexOf(':') + 1),
            model: 'session-model',
            reasoningEffort: 'high'
          },
          historyReplayDescriptor: { target: historyReplayTarget }
        }
      )

      expect(resumeSession).toHaveBeenCalledWith(
        'session-choice-1',
        '/workspace/project',
        'project-1',
        'ask',
        frameworkId,
        backendId,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          frameworkId,
          providerId: backendId.slice(backendId.indexOf(':') + 1),
          model: 'session-model',
          reasoningEffort: 'high'
        },
        true
      )
      expect(resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
        respondToElicitation.mock.invocationCallOrder[0]
      )
      expect(respondToElicitation).toHaveBeenCalledWith({
        ...response,
        historyReplay: {
          historyPreamble: expect.stringContaining('Build something'),
          historyAttachments: [],
          historyImages: []
        }
      })
    }
  )

  it('replays prior history when restoring the provider resets its context', async () => {
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'session-choice-1',
      cwd: '/workspace/project',
      contextReset: true,
      frameworkId: 'opencode',
      backendId: 'opencode:provider-1'
    })
    const respondToElicitation = vi.fn().mockResolvedValue(createSnapshot(['session-choice-1']))
    const response = {
      requestId: 'choice-1',
      action: 'accept' as const,
      answers: [{ fieldId: 'question_0', value: 'Minimal' }],
      request: {
        requestId: 'choice-1',
        sessionId: 'session-choice-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [
          {
            id: 'question_0',
            label: 'Approach',
            kind: 'single-select' as const,
            options: [
              { value: 'Minimal', label: 'Minimal' },
              { value: 'Expanded', label: 'Expanded' }
            ]
          }
        ],
        durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
      }
    }

    await respondToWorkspaceElicitation(
      { state: createSnapshot(), resumeSession, respondToElicitation },
      response,
      { supportsImageInput: true }
    )

    expect(respondToElicitation).toHaveBeenCalledWith({
      ...response,
      historyReplay: {
        historyPreamble: expect.stringContaining('Build something'),
        historyAttachments: [],
        historyImages: []
      }
    })
    expect(useSessionStore.getState().sessions[0].elicitationHistoryReplayRequestId).toBeUndefined()
  })

  it('keeps context-reset history for a retry after submitting the answer fails', async () => {
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'session-choice-1',
      cwd: '/workspace/project',
      contextReset: true,
      frameworkId: 'opencode',
      backendId: 'opencode:provider-1'
    })
    const respondToElicitation = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge failed'))
      .mockResolvedValueOnce(createSnapshot(['session-choice-1']))
    const response = {
      requestId: 'choice-retry',
      action: 'accept' as const,
      answers: [{ fieldId: 'question_0', value: 'Minimal' }],
      request: {
        requestId: 'choice-retry',
        sessionId: 'session-choice-1',
        toolCallId: 'tool-choice-retry',
        message: 'Choose an approach',
        fields: [
          {
            id: 'question_0',
            label: 'Approach',
            kind: 'single-select' as const,
            options: [
              { value: 'Minimal', label: 'Minimal' },
              { value: 'Expanded', label: 'Expanded' }
            ]
          }
        ],
        durable: { kind: 'agent-user-choice' as const, requestId: 'choice-retry' }
      }
    }

    await expect(
      respondToWorkspaceElicitation(
        { state: createSnapshot(), resumeSession, respondToElicitation },
        response,
        { supportsImageInput: true }
      )
    ).rejects.toThrow('bridge failed')
    expect(useSessionStore.getState().sessions[0].elicitationHistoryReplayRequestId).toBe(
      'choice-retry'
    )

    await respondToWorkspaceElicitation(
      {
        state: createSnapshot(['session-choice-1']),
        resumeSession,
        respondToElicitation
      },
      response,
      { supportsImageInput: true }
    )

    expect(resumeSession).toHaveBeenCalledTimes(1)
    expect(respondToElicitation).toHaveBeenLastCalledWith({
      ...response,
      historyReplay: {
        historyPreamble: expect.stringContaining('Build something'),
        historyAttachments: [],
        historyImages: []
      }
    })
    expect(useSessionStore.getState().sessions[0].elicitationHistoryReplayRequestId).toBeUndefined()
  })

  it('rewinds from an answered question and replays the retained history with the replacement answer', async () => {
    const session = useSessionStore.getState().sessions[0]
    const prompt = session.messages[0]
    const questionAt = prompt.createdAt + 10
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === session.id
          ? {
              ...candidate,
              agentFrameworkId: 'codex',
              agentBackendId: 'codex:provider-2',
              agentModel: 'old-model',
              agentConfiguration: {
                providerId: 'provider-2',
                model: 'old-model',
                reasoningEffort: 'default'
              },
              messages: [
                ...candidate.messages,
                {
                  id: 'question-preamble',
                  role: 'agent' as const,
                  content: 'Question preamble',
                  status: 'complete' as const,
                  eventIds: [],
                  sortIndex: 9,
                  createdAt: questionAt,
                  updatedAt: questionAt
                },
                {
                  id: 'downstream-answer',
                  role: 'agent' as const,
                  content: 'The old answer path',
                  status: 'complete' as const,
                  eventIds: [],
                  sortIndex: 11,
                  createdAt: questionAt,
                  updatedAt: questionAt
                }
              ],
              activities: [
                {
                  id: 'tool-choice-answered',
                  kind: 'tool' as const,
                  title: 'Choose an approach',
                  status: 'completed' as const,
                  eventIds: ['choice-event'],
                  sortIndex: 10,
                  promptMessageId: prompt.id,
                  createdAt: questionAt,
                  updatedAt: questionAt,
                  elicitation: {
                    message: 'Choose an approach',
                    fields: [
                      {
                        id: 'question_0',
                        label: 'Approach',
                        kind: 'single-select' as const,
                        options: [
                          { value: 'Minimal', label: 'Minimal' },
                          { value: 'Expanded', label: 'Expanded' }
                        ]
                      }
                    ],
                    state: 'answered' as const,
                    durable: {
                      kind: 'agent-user-choice' as const,
                      requestId: 'choice-revision',
                      promptMessageId: prompt.id
                    },
                    answers: [{ fieldId: 'question_0', value: 'Minimal' }]
                  }
                }
              ]
            }
          : candidate
      )
    }))
    const shutdown = vi.fn().mockResolvedValue({ status: 'shutdown' })
    vi.stubGlobal('window', { api: { notebook: { shutdown } } })
    const resetSessionContext = vi.fn().mockResolvedValue({
      sessionId: session.id,
      cwd: session.cwd,
      contextReset: true,
      frameworkId: 'codex',
      backendId: 'codex:provider-2'
    })
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: session.id,
      cwd: session.cwd,
      contextReset: false,
      frameworkId: 'codex',
      backendId: 'codex:provider-2'
    })
    const respondToElicitation = vi.fn().mockResolvedValue(createSnapshot([session.id]))
    const onSendPreparationStateChange = vi.fn()
    const persistedRevision = createDeferred<void>()
    const flushPersistence = vi.fn(() => persistedRevision.promise)
    const response = {
      requestId: 'choice-revision',
      action: 'accept' as const,
      replacePreviousAnswer: true,
      answers: [{ fieldId: 'question_0', value: 'Expanded' }],
      request: {
        requestId: 'choice-revision',
        sessionId: session.id,
        toolCallId: 'tool-choice-answered',
        message: 'Choose an approach',
        fields: [
          {
            id: 'question_0',
            label: 'Approach',
            kind: 'single-select' as const,
            options: [
              { value: 'Minimal', label: 'Minimal' },
              { value: 'Expanded', label: 'Expanded' }
            ]
          }
        ],
        durable: {
          kind: 'agent-user-choice' as const,
          requestId: 'choice-revision',
          promptMessageId: prompt.id
        }
      }
    }

    const revision = respondToWorkspaceElicitation(
      {
        state: createSnapshot([session.id]),
        resumeSession,
        resetSessionContext,
        respondToElicitation
      },
      response,
      {
        supportsImageInput: true,
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:provider-2',
        agentModel: 'new-model',
        agentTarget: {
          frameworkId: 'codex',
          providerId: 'provider-2',
          model: 'new-model',
          reasoningEffort: 'high'
        },
        onSendPreparationStateChange,
        flushPersistence
      }
    )
    const competingSendPrompt = vi.fn()
    const competing = await sendWorkspaceMessage(
      {
        state: createSnapshot([session.id]),
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        resetSessionContext: vi.fn(),
        sendPrompt: competingSendPrompt
      },
      {
        sessionId: session.id,
        text: 'race the revision',
        cwd: session.cwd,
        projectId: session.projectId,
        supportsImageInput: true
      }
    )
    expect(competing).toBeUndefined()
    expect(competingSendPrompt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(flushPersistence).toHaveBeenCalledOnce())
    expect(respondToElicitation).not.toHaveBeenCalled()
    persistedRevision.resolve(undefined)
    await revision

    expect(resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      shutdown.mock.invocationCallOrder[0]
    )
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      resetSessionContext.mock.invocationCallOrder[0]
    )
    expect(resetSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      flushPersistence.mock.invocationCallOrder[0]
    )
    expect(flushPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      respondToElicitation.mock.invocationCallOrder[0]
    )
    expect(resumeSession).toHaveBeenCalledWith(
      session.id,
      session.cwd,
      session.projectId,
      'ask',
      'codex',
      'codex:provider-2',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        frameworkId: 'codex',
        providerId: 'provider-2',
        model: 'new-model',
        reasoningEffort: 'high'
      },
      true
    )
    expect(onSendPreparationStateChange.mock.calls).toEqual([
      [session.id, true],
      [session.id, false]
    ])
    expect(respondToElicitation).toHaveBeenCalledWith({
      ...response,
      request: {
        ...response.request,
        toolCallId: expect.stringMatching(/^ask-user-question-revision-/)
      },
      historyReplay: {
        historyPreamble: expect.stringContaining('Build something'),
        historyAttachments: [],
        historyImages: []
      }
    })
    expect(respondToElicitation.mock.calls[0]?.[0].historyReplay?.historyPreamble).toContain(
      'Question preamble'
    )
    expect(respondToElicitation.mock.calls[0]?.[0].historyReplay?.historyPreamble).not.toContain(
      'The old answer path'
    )
    const revised = useSessionStore.getState().sessions[0]
    expect(revised.messages.map((message) => message.content)).toEqual([
      'Build something',
      'Question preamble'
    ])
    expect(revised.activities).toEqual([])
    expect(revised.conversationGraph?.branches).toHaveLength(2)
    expect(revised.agentFrameworkId).toBe('codex')
    expect(revised.agentBackendId).toBe('codex:provider-2')
    expect(revised.agentModel).toBe('new-model')
    expect(revised.conversationGraph?.runtimeSegments.at(-1)?.model).toBe('new-model')
  })

  it('restores the transcript and forces replay when a revised answer cannot be submitted', async () => {
    const session = useSessionStore.getState().sessions[0]
    const prompt = session.messages[0]
    const questionAt = prompt.createdAt + 10
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === session.id
          ? {
              ...candidate,
              messages: [
                ...candidate.messages,
                {
                  id: 'old-downstream',
                  role: 'agent' as const,
                  content: 'The old answer path',
                  status: 'complete' as const,
                  eventIds: [],
                  createdAt: questionAt + 10,
                  updatedAt: questionAt + 10
                }
              ],
              activities: [
                {
                  id: 'answered-choice',
                  kind: 'tool' as const,
                  title: 'Choose an approach',
                  status: 'completed' as const,
                  eventIds: [],
                  sortIndex: 1,
                  promptMessageId: prompt.id,
                  createdAt: questionAt,
                  updatedAt: questionAt,
                  elicitation: {
                    message: 'Choose an approach',
                    fields: [
                      {
                        id: 'question_0',
                        label: 'Approach',
                        kind: 'single-select' as const,
                        options: [
                          { value: 'Minimal', label: 'Minimal' },
                          { value: 'Expanded', label: 'Expanded' }
                        ]
                      }
                    ],
                    state: 'answered' as const,
                    durable: {
                      kind: 'agent-user-choice' as const,
                      requestId: 'failed-revision',
                      promptMessageId: prompt.id
                    },
                    answers: [{ fieldId: 'question_0', value: 'Minimal' }]
                  }
                }
              ]
            }
          : candidate
      )
    }))
    const shutdown = vi.fn().mockResolvedValue({ status: 'shutdown' })
    vi.stubGlobal('window', { api: { notebook: { shutdown } } })
    const resetSessionContext = vi.fn().mockResolvedValue({
      sessionId: session.id,
      cwd: session.cwd,
      contextReset: true,
      frameworkId: 'opencode',
      backendId: 'opencode:provider-1'
    })
    const response = {
      requestId: 'failed-revision',
      action: 'accept' as const,
      replacePreviousAnswer: true,
      answers: [{ fieldId: 'question_0', value: 'Expanded' }],
      request: {
        requestId: 'failed-revision',
        sessionId: session.id,
        toolCallId: 'answered-choice',
        message: 'Choose an approach',
        fields: [
          {
            id: 'question_0',
            label: 'Approach',
            kind: 'single-select' as const,
            options: [
              { value: 'Minimal', label: 'Minimal' },
              { value: 'Expanded', label: 'Expanded' }
            ]
          }
        ],
        durable: {
          kind: 'agent-user-choice' as const,
          requestId: 'failed-revision',
          promptMessageId: prompt.id
        }
      }
    }

    await expect(
      respondToWorkspaceElicitation(
        {
          state: createSnapshot([session.id]),
          resumeSession: vi.fn(),
          resetSessionContext,
          respondToElicitation: vi.fn().mockRejectedValue(new Error('bridge unavailable'))
        },
        response,
        { supportsImageInput: true }
      )
    ).rejects.toThrow('bridge unavailable')

    const restored = useSessionStore.getState().sessions[0]
    expect(restored.messages.map((message) => message.content)).toEqual([
      'Build something',
      'The old answer path'
    ])
    expect(restored.activities?.map((activity) => activity.id)).toEqual(['answered-choice'])
    expect(restored.branchContextResetRequired).toBe(true)

    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot([session.id]))
    const replayReset = vi.fn().mockResolvedValue({
      sessionId: session.id,
      cwd: session.cwd,
      contextReset: true,
      frameworkId: 'opencode',
      backendId: 'opencode:provider-1'
    })
    const sent = await sendWorkspaceMessage(
      {
        state: createSnapshot([session.id]),
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        resetSessionContext: replayReset,
        sendPrompt
      },
      {
        sessionId: session.id,
        text: 'continue safely',
        cwd: session.cwd,
        projectId: session.projectId,
        supportsImageInput: true,
        agentFrameworkId: 'opencode',
        agentBackendId: 'opencode:provider-1'
      }
    )

    expect(sent).toBeDefined()
    expect(replayReset).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    expect(sendPrompt.mock.calls[0]?.[5]).toContain('The old answer path')
  })
})

describe('workspace agent message sending', () => {
  it('clears only the pending PDF selection proven by the linked context', () => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    const sentSelection = {
      kind: 'staged-upload' as const,
      attachmentId: 'upload-1',
      previewItemId: 'upload:upload-1'
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext('project-1', sentSelection)
    const replacementSelection = {
      kind: 'version' as const,
      sourceKind: 'artifact-version' as const,
      sourceFileId: 'artifact-2',
      sourceVersionId: 'version-2',
      previewItemId: 'artifact:version-2'
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext('project-1', replacementSelection)

    clearLinkedPendingPdfContext('project-1', sentSelection, {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']).toEqual(
      replacementSelection
    )
  })

  it('clears the exact staged PDF selection after its linked binding is committed', () => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    const selection = {
      kind: 'staged-upload' as const,
      attachmentId: 'upload-1',
      previewItemId: 'upload:upload-1'
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext('project-1', selection)

    clearLinkedPendingPdfContext('project-1', selection, {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    })

    expect(
      usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']
    ).toBeUndefined()
  })

  it('keeps a pending PDF selection when the committed context does not contain it', () => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    const selection = {
      kind: 'version' as const,
      sourceKind: 'artifact-version' as const,
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      previewItemId: 'artifact:version-1'
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext('project-1', selection)

    clearLinkedPendingPdfContext('project-1', selection, {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-2',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'version-2',
          sourceSessionId: 'session-1',
          name: 'other-paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'b'.repeat(64),
          linkedAt: 1
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']).toEqual(
      selection
    )
  })

  it('reveals a PDF only after its Session context link completes', () => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    const pdfContext: SessionPdfContext = {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }

    revealLinkedPdfContext('project-1', pdfContext)

    const preview = usePreviewWorkbenchStore.getState()
    expect(preview.activeItemId).toBe('upload:upload-1')
    expect(preview.panelState).toBe('open')
    expect(preview.items).toEqual([
      expect.objectContaining({
        id: 'upload:upload-1',
        projectId: 'project-1',
        path: 'upload-version:project-1/session-1/version-1',
        format: 'pdf'
      })
    ])
  })

  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    vi.stubGlobal('window', {
      api: {
        sessions: createSessionPolicyApi()
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each<AgentFrameworkId>(['claude-code', 'opencode', 'codex', 'codebuddy'])(
    'persists a stable application-owned Message before dispatching through %s',
    async (agentFrameworkId) => {
      useSessionStore.setState({
        ...createInitialSessionState(),
        selectedSessionId: 'transport-session-1',
        sessions: [
          {
            id: 'transport-session-1',
            projectId: 'project-1',
            cwd: '/workspace/project',
            title: 'Compute analysis',
            status: 'idle',
            messages: [],
            createdAt: 1,
            updatedAt: 1
          } as ChatSession
        ]
      })
      const persisted = createDeferred<PersistedChatSession>()
      const saveSession = vi.fn((session: PersistedChatSession) => {
        void session
        return persisted.promise
      })
      vi.stubGlobal('window', { api: { sessions: { saveSession } } })
      const runtime = {
        state: createSnapshot(['transport-session-1']),
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        resetSessionContext: vi.fn(),
        sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
      }
      const input = {
        sessionId: 'transport-session-1',
        messageId: 'automatic-analysis-message-1',
        text: 'Analyze the completed compute job',
        cwd: '/workspace/project',
        projectId: 'project-1',
        agentFrameworkId
      }

      const sending = sendWorkspaceMessage(runtime, input)

      await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
      expect(saveSession.mock.calls[0]?.[0].messages).toEqual([
        expect.objectContaining({
          id: 'automatic-analysis-message-1',
          role: 'user',
          content: 'Analyze the completed compute job'
        })
      ])
      expect(runtime.sendPrompt).not.toHaveBeenCalled()

      persisted.resolve(saveSession.mock.calls[0]![0])
      await expect(sending).resolves.toEqual({
        sessionId: 'transport-session-1',
        messageId: 'automatic-analysis-message-1'
      })
      expect(runtime.sendPrompt).toHaveBeenCalledOnce()

      await expect(sendWorkspaceMessage(runtime, input)).resolves.toEqual({
        sessionId: 'transport-session-1',
        messageId: 'automatic-analysis-message-1'
      })
      expect(saveSession).toHaveBeenCalledOnce()
      expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    }
  )

  it('redispatches a persisted stable Message when no response or active run exists', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1',
      content: 'Analyze the completed compute job',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1'
          ? { ...session, status: 'idle', activeRun: undefined }
          : session
      )
    }))
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    vi.stubGlobal('window', { api: { sessions: { saveSession } } })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'transport-session-1',
        messageId: 'automatic-analysis-message-1',
        text: 'Analyze the completed compute job',
        cwd: '/workspace/project',
        projectId: 'project-1',
        agentFrameworkId: 'claude-code'
      })
    ).resolves.toEqual({
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1'
    })

    expect(saveSession).toHaveBeenCalledOnce()
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({
      status: 'running',
      activeRun: { promptMessageId: 'automatic-analysis-message-1' },
      messages: [
        {
          id: 'automatic-analysis-message-1',
          role: 'user',
          content: 'Analyze the completed compute job'
        }
      ]
    })
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('redispatches a stable Message preserved on an inactive conversation Branch', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1',
      content: 'Analyze the completed compute job',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore
      .getState()
      .truncateSessionFromMessage('transport-session-1', 'automatic-analysis-message-1')

    const truncated = useSessionStore.getState().sessions[0]
    expect(truncated.messages).toEqual([])
    expect(
      truncated.conversationGraph?.messages.filter(
        (message) => message.id === 'automatic-analysis-message-1'
      )
    ).toHaveLength(1)

    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    vi.stubGlobal('window', { api: { sessions: { saveSession } } })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'transport-session-1',
        messageId: 'automatic-analysis-message-1',
        text: 'Analyze the completed compute job',
        cwd: '/workspace/project',
        projectId: 'project-1',
        agentFrameworkId: 'claude-code'
      })
    ).resolves.toEqual({
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1'
    })

    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({ id: 'automatic-analysis-message-1' })
    ])
    expect(
      useSessionStore
        .getState()
        .sessions[0].conversationGraph?.messages.filter(
          (message) => message.id === 'automatic-analysis-message-1'
        )
    ).toHaveLength(1)
  })

  it('reports a stable application-owned Message as unsent when prompt ownership is lost', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      selectedSessionId: 'transport-session-1',
      sessions: [
        {
          id: 'transport-session-1',
          projectId: 'project-1',
          cwd: '/workspace/project',
          title: 'Compute analysis',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        } as ChatSession
      ]
    })
    const persisted = createDeferred<PersistedChatSession>()
    const saveSession = vi.fn((session: PersistedChatSession) => {
      void session
      return persisted.promise
    })
    vi.stubGlobal('window', { api: { sessions: { saveSession } } })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    const sending = sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1',
      text: 'Analyze the completed compute job',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })

    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1'
          ? { ...session, status: 'idle', activeRun: undefined }
          : session
      )
    }))
    persisted.resolve(saveSession.mock.calls[0]![0])

    await expect(sending).resolves.toBeUndefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not pin a catalog fallback model onto an unpinned send target', async () => {
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'continue on the account default',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.4',
      agentConfiguration: {
        providerId: 'builtin-codex-subscription',
        reasoningEffort: 'default'
      }
    })

    const target = useSessionStore.getState().sessions[0].messages[0]?.agentTarget
    expect(target).toEqual({
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription',
      providerId: 'builtin-codex-subscription',
      reasoningEffort: 'default'
    })
    expect(target).not.toHaveProperty('model')
  })

  it('stamps an explicit configuration model onto the send target', async () => {
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'pin a model',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.4',
      agentConfiguration: {
        providerId: 'builtin-codex-subscription',
        model: 'gpt-5.4',
        reasoningEffort: 'high'
      }
    })

    expect(useSessionStore.getState().sessions[0].messages[0]?.agentTarget).toEqual({
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription',
      providerId: 'builtin-codex-subscription',
      model: 'gpt-5.4',
      reasoningEffort: 'high'
    })
  })

  it('forwards and durably stores Plan first for an existing Session', async () => {
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'analyze this dataset',
      cwd: '/workspace/project',
      projectId: 'project-1',
      forcedSkillIds: ['skill-analysis'],
      turnIntent: 'plan-first'
    })

    expect(runtime.sendPrompt.mock.calls[0]?.[12]).toBe('plan-first')
    expect(useSessionStore.getState().sessions[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'analyze this dataset',
      turnIntent: 'plan-first'
    })
  })

  it('sends annotation-only context while preserving structured Message data', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const annotation = {
      id: 'annotation-1',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'The confidence intervals overlap.',
      note: 'Explain the consequence.',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'transport-session-1',
        messageId: 'agent-message-1'
      }
    }

    const sent = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: '',
      annotations: [annotation],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(sent).toBeDefined()
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    expect(sendPrompt.mock.calls[0]?.[1]).toContain('[Annotations]')
    expect(sendPrompt.mock.calls[0]?.[1]).toContain('The confidence intervals overlap.')
    expect(useSessionStore.getState().sessions[0].messages[0]).toMatchObject({
      role: 'user',
      content: '',
      annotations: [annotation]
    })
  })

  it('dispatches a PDF region Evidence screenshot as current visual context', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const annotation = {
      id: 'pdf-region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source: {
        kind: 'upload-version' as const,
        projectId: 'project-1',
        sessionId: 'transport-session-1',
        versionId: 'version-1',
        name: 'paper.pdf',
        path: 'upload-version:project-1/transport-session-1/version-1',
        checksum: 'a'.repeat(64)
      },
      selector: {
        kind: 'region' as const,
        pageNumber: 2,
        rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Explain this figure.',
      annotations: [annotation],
      cwd: '/workspace/project',
      projectId: 'project-1',
      supportsImageInput: true
    })

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    expect(sendPrompt.mock.calls[0]?.[1]).toContain('"type":"pdf-region"')
    expect(sendPrompt.mock.calls[0]?.[1]).not.toContain('AQID')
    expect(sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    expect(sendPrompt.mock.calls[0]?.[15]).toEqual([
      { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
    expect(useSessionStore.getState().sessions[0].messages[0]?.annotations).toEqual([annotation])
  })

  it('rejects PDF region Evidence before mutation when no visual model is available', async () => {
    const sendPrompt = vi.fn()
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const sessionsBefore = useSessionStore.getState().sessions

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'transport-session-1',
        text: 'Explain this figure.',
        annotations: [
          {
            id: 'pdf-region-1',
            kind: 'pdf',
            target: 'agent',
            source: {
              kind: 'upload-version',
              projectId: 'project-1',
              sessionId: 'transport-session-1',
              versionId: 'version-1',
              name: 'paper.pdf',
              path: 'upload-version:project-1/transport-session-1/version-1',
              checksum: 'a'.repeat(64)
            },
            selector: {
              kind: 'region',
              pageNumber: 2,
              rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
              pageRotation: 0,
              image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
            }
          }
        ],
        cwd: '/workspace/project',
        projectId: 'project-1',
        supportsImageInput: false
      })
    ).rejects.toThrow("The selected model doesn't support images")

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toBe(sessionsBefore)
  })

  it('dispatches mixed image annotations with fixed references, stable numbers, and natural pixels', async () => {
    const acquire = vi.fn().mockResolvedValue({
      id: 'fixed-image-resource',
      url: 'open-science-preview://fixed-image-resource',
      size: 1024,
      mimeType: 'image/png',
      version: 1
    })
    const release = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { previewResources: { acquire, release } } })
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const imageSource = {
      kind: 'artifact-version' as const,
      projectId: 'project-1',
      sessionId: 'transport-session-1',
      versionId: 'version-fixed',
      name: 'figure.png',
      path: 'artifact-version:project-1/transport-session-1/artifact-1/version-fixed',
      mimeType: 'image/png'
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Compare these details.',
      annotations: [
        {
          id: 'quote-1',
          kind: 'text',
          target: 'agent',
          quote: 'First detail',
          source: {
            kind: 'agent-message',
            sessionId: 'transport-session-1',
            messageId: 'agent-1'
          }
        },
        {
          id: 'point-1',
          kind: 'image-point',
          target: 'agent',
          note: 'Inspect this point',
          source: imageSource,
          point: { x: 0.5, y: 1 },
          naturalSize: { width: 1000, height: 500 }
        },
        {
          id: 'point-2',
          kind: 'image-point',
          target: 'agent',
          note: 'Compare this point',
          source: imageSource,
          point: { x: 0, y: 0 },
          naturalSize: { width: 1000, height: 500 }
        }
      ],
      referencedArtifacts: [
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: imageSource.path,
          source: 'artifact',
          versionId: imageSource.versionId
        }
      ],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    expect(sendPrompt.mock.calls[0]?.[1]).toContain(
      '"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-fixed","name":"figure.png"},"imageAttachment":1,"x":500,"y":499,"instruction":"Inspect this point"'
    )
    expect(sendPrompt.mock.calls[0]?.[1]).toContain(
      '"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-fixed","name":"figure.png"},"imageAttachment":1,"x":0,"y":0,"instruction":"Compare this point"'
    )
    expect(sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({ versionId: 'version-fixed', path: imageSource.path })
    ])
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith({ resourceId: 'fixed-image-resource' })
  })

  it('rejects an unavailable fixed image Version before mutating the Session or dispatching', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const acquire = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('window', {
      api: { previewResources: { acquire, release: vi.fn().mockResolvedValue(undefined) } }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const sessionsBefore = useSessionStore.getState().sessions

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'transport-session-1',
        text: 'Inspect the fixed source.',
        annotations: [
          {
            id: 'point-unavailable',
            kind: 'image-point',
            target: 'agent',
            note: 'This point matters.',
            source: {
              kind: 'artifact-version',
              projectId: 'project-1',
              sessionId: 'transport-session-1',
              versionId: 'deleted-version',
              name: 'figure.png',
              path: 'artifact-version:project-1/transport-session-1/artifact-1/deleted-version',
              mimeType: 'image/png'
            },
            point: { x: 0.5, y: 0.5 },
            naturalSize: { width: 800, height: 600 }
          }
        ],
        cwd: '/workspace/project',
        projectId: 'project-1'
      })
    ).rejects.toThrow('An annotated image is no longer available')

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        versionId: 'deleted-version'
      })
    )
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toBe(sessionsBefore)
  })

  it('rejects an oversized annotation at the runtime boundary', async () => {
    const sendPrompt = vi.fn()
    const sent = await sendWorkspaceMessage(
      {
        state: createSnapshot(['transport-session-1']),
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        resetSessionContext: vi.fn(),
        sendPrompt
      },
      {
        sessionId: 'transport-session-1',
        text: '',
        annotations: [
          {
            id: 'annotation-oversized',
            kind: 'text',
            target: 'agent',
            quote: 'x'.repeat(4_001),
            source: {
              kind: 'agent-message',
              sessionId: 'transport-session-1',
              messageId: 'agent-message-1'
            }
          }
        ],
        cwd: '/workspace/project',
        projectId: 'project-1'
      }
    )

    expect(sent).toBeUndefined()
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('snapshots one linked PDF into the durable user turn and shared file-reference budget', async () => {
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }
    const pdfContext = {
      version: 1 as const,
      bindings: [
        {
          version: 1 as const,
          bindingId: 'binding-1',
          sourceKind: 'artifact-version' as const,
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf' as const,
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }

    const readingPosition = { pageNumber: 7, pageCount: 14 }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Summarize the linked paper',
      cwd: '/workspace/project',
      projectId: 'project-1',
      pdfContext,
      pdfReadingPosition: readingPosition,
      referencedArtifacts: [
        {
          id: 'artifact-1',
          name: 'paper.pdf',
          source: 'artifact',
          path: 'artifact-version:project-1/source-session-1/artifact-1/version-1',
          versionId: 'version-1',
          mimeType: 'application/pdf'
        }
      ]
    })

    expect(runtime.sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        source: 'artifact',
        versionId: 'version-1',
        mimeType: 'application/pdf',
        pdfReadingPosition: readingPosition
      })
    ])
    expect(useSessionStore.getState().sessions[0].messages[0].pdfContext).toEqual({
      ...pdfContext,
      activeBindingId: 'binding-1',
      readingPosition
    })
  })

  it('does not assign the current PDF page to a newly linked document', async () => {
    const firstBinding: SessionPdfContext['bindings'][number] = {
      version: 1,
      bindingId: 'binding-1',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'source-session-1',
      name: 'first.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 1
    }
    const secondBinding: SessionPdfContext['bindings'][number] = {
      ...firstBinding,
      bindingId: 'binding-2',
      sourceFileId: 'artifact-2',
      sourceVersionId: 'version-2',
      name: 'second.pdf',
      checksum: 'b'.repeat(64),
      linkedAt: 2
    }
    const firstContext: SessionPdfContext = { version: 1, bindings: [firstBinding] }
    const linkedContext: SessionPdfContext = {
      version: 1,
      bindings: [firstBinding, secondBinding]
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Read the first paper',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        runtimeContext: { version: 1, revision: 1, pdfContext: firstContext }
      }))
    }))
    const linkPdfContext = vi.fn().mockResolvedValue({
      version: 1,
      revision: 2,
      pdfContext: linkedContext
    })
    vi.stubGlobal('window', {
      api: {
        sessions: {
          linkPdfContext,
          saveSession: vi.fn(async (session: PersistedChatSession) => session),
          filterPdfContextCandidates: vi.fn().mockResolvedValue({
            sources: [{ sourceKind: 'artifact-version', sourceVersionId: 'version-2' }],
            pendingAttachmentIds: []
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Now inspect the second paper',
      cwd: '/workspace/project',
      projectId: 'project-1',
      pdfContext: {
        ...firstContext,
        activeBindingId: firstBinding.bindingId,
        readingPosition: { pageNumber: 7, pageCount: 14 }
      },
      pdfReadingPosition: { pageNumber: 7, pageCount: 14 },
      pendingPdfContextVersions: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'version-2'
        }
      ]
    })

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    const message = useSessionStore.getState().sessions[0].messages.at(-1)
    expect(message?.pdfContext).toEqual({
      ...linkedContext,
      activeBindingId: secondBinding.bindingId
    })
    expect(message?.pdfContext).not.toHaveProperty('readingPosition')
  })

  it('links staged and immutable PDFs atomically without losing the current page', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Existing prompt',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    const stagedPdf = createAttachment({
      id: 'pdf-upload-1',
      name: 'staged-paper.pdf',
      originalName: 'staged-paper.pdf',
      path: '/uploads/.pending/staged-paper.pdf',
      mimeType: 'application/pdf'
    })
    const finalizedPdf = createAttachment({
      ...stagedPdf,
      sessionId: 'transport-session-1',
      path: 'upload-version:project-1/transport-session-1/pdf-version-1',
      versionId: 'pdf-version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64)
    })
    const stagedBinding: SessionPdfContext['bindings'][number] = {
      version: 1,
      bindingId: 'binding-upload',
      sourceKind: 'upload-version',
      sourceFileId: stagedPdf.id,
      sourceVersionId: finalizedPdf.versionId!,
      sourceSessionId: 'transport-session-1',
      name: stagedPdf.name,
      mimeType: 'application/pdf',
      sizeBytes: stagedPdf.size,
      checksum: 'a'.repeat(64),
      linkedAt: 1
    }
    const immutableBinding: SessionPdfContext['bindings'][number] = {
      ...stagedBinding,
      bindingId: 'binding-artifact',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-2',
      sourceVersionId: 'artifact-version-2',
      sourceSessionId: 'source-session-2',
      name: 'library-paper.pdf',
      checksum: 'b'.repeat(64),
      linkedAt: 2
    }
    const linkedContext: SessionPdfContext = {
      version: 1,
      bindings: [stagedBinding, immutableBinding]
    }
    const linkPdfContext = vi.fn().mockImplementation(async ({ sources }) => ({
      version: 1,
      revision: sources.length,
      pdfContext: sources.length === 1 ? { version: 1, bindings: [stagedBinding] } : linkedContext
    }))
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession: vi.fn().mockResolvedValue([finalizedPdf]) },
        sessions: {
          linkPdfContext,
          saveSession: vi.fn(async (session: PersistedChatSession) => session),
          filterPdfContextCandidates: vi.fn().mockResolvedValue({
            sources: [
              {
                sourceKind: 'artifact-version',
                sourceFileId: 'artifact-2',
                sourceVersionId: 'artifact-version-2'
              }
            ],
            pendingAttachmentIds: [stagedPdf.id]
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }
    const readingPosition = { pageNumber: 5, pageCount: 14 }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Compare these papers',
      attachments: [stagedPdf],
      pendingPdfContextAttachmentIds: [stagedPdf.id],
      pendingPdfContextVersions: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'artifact-version-2'
        }
      ],
      pdfReadingPosition: readingPosition,
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(linkPdfContext).toHaveBeenCalledOnce()
    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'transport-session-1',
      expectedRevision: 0,
      sources: [
        {
          sourceKind: 'upload-version',
          sourceFileId: 'pdf-upload-1',
          sourceVersionId: 'pdf-version-1'
        },
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'artifact-version-2'
        }
      ],
      excludeSinglePage: true
    })
    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.pdfContext).toEqual({
      ...linkedContext,
      activeBindingId: stagedBinding.bindingId,
      readingPosition
    })
    expect(runtime.sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({
        source: 'upload',
        sourceFileId: 'pdf-upload-1',
        versionId: 'pdf-version-1'
      }),
      expect.objectContaining({
        source: 'artifact',
        sourceFileId: 'artifact-2',
        versionId: 'artifact-version-2'
      })
    ])
  })

  it('does not append a prompt when attachment finalization fails', async () => {
    const attachment = createAttachment()
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Existing prompt',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    vi.stubGlobal('window', {
      api: {
        uploads: {
          finalizeSession: vi.fn().mockRejectedValue(new Error('attachment finalization failed'))
        }
      }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const result = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'inspect the attachment',
      attachments: [attachment],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(result).toBeUndefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'attachment finalization failed',
      messages: [expect.objectContaining({ content: 'Existing prompt' })]
    })
  })

  it('binds an explicit continuation prompt to the durable active Plan version', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'project-1',
      planContinuation: { artifactVersionId: 'plan-version-1', revision: 9 }
    })

    expect(sendPrompt.mock.calls[0]?.[11]).toEqual({
      projectId: 'project-1',
      artifactVersionId: 'plan-version-1',
      expectedRevision: 9
    })
  })

  it('rejects an ordinary runtime prompt while Plan approval owns the Session', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-plan-approval'
      }))
    }))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const sent = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'start another turn',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(sent).toBeUndefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('admits a main runtime prompt while only a delegated Permission is pending', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Delegate research',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        interactionState: { permission: true, elicitation: false, plan: false }
      }))
    }))
    const snapshot = createSnapshot(['transport-session-1'])
    snapshot.pendingPermissions = [
      {
        requestId: 'delegated-permission',
        sessionId: 'transport-session-1',
        toolCallId: 'delegated-tool',
        title: 'Run delegated command',
        options: [],
        delegated: {
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          childTitle: 'Researcher',
          riskScope: 'This call only'
        }
      }
    ]
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(snapshot)
    }

    const sent = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'continue the main work',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(sent).toMatchObject({ sessionId: 'transport-session-1' })
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('keeps the original Specialist replay clearing when the provider rejects the prompt', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original specialist turn',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.getState().markSpecialistSwitchResetRequired('transport-session-1')
    const snapshot = createSnapshot(['transport-session-1'])
    vi.stubGlobal('window', {
      api: { acp: { getState: vi.fn().mockResolvedValue(snapshot) } }
    })
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('provider unavailable'))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue with the new specialist',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()
  })

  it('clears Specialist replay before provider prompt completion settles', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original specialist turn',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.getState().markSpecialistSwitchResetRequired('transport-session-1')
    const accepted = createDeferred<AcpStateSnapshot>()
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn(() => accepted.promise)
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue with the new specialist',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()

    accepted.resolve(createSnapshot(['transport-session-1']))
    await flushRuntimeTasks()
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()
  })

  it('rebuilds Agent and Notebook context before continuing a switched Branch', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original branch turn',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    const shutdown = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      status: 'shutdown'
    })
    vi.stubGlobal('window', { api: { notebook: { shutdown } } })
    const resetSessionContext = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      contextReset: true
    })
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext,
      sendPrompt
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue selected branch',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(shutdown).toHaveBeenCalledWith({
      sessionId: 'transport-session-1',
      workspaceCwd: '/workspace/project',
      projectId: 'project-1'
    })
    expect(resetSessionContext).toHaveBeenCalledOnce()
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      resetSessionContext.mock.invocationCallOrder[0]
    )
    expect(resetSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      sendPrompt.mock.invocationCallOrder[0]
    )
    expect(sendPrompt).toHaveBeenCalledWith(
      'transport-session-1',
      'Continue selected branch',
      [],
      undefined,
      undefined,
      expect.stringContaining('Original branch turn'),
      [],
      [],
      undefined,
      expect.objectContaining({ promptMessageId: expect.any(String) }),
      true,
      undefined,
      undefined,
      true
    )
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBeUndefined()
  })

  it('resets a detached same-framework Branch after adoption before replay', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original branch turn',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    const shutdown = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      status: 'shutdown'
    })
    vi.stubGlobal('window', { api: { notebook: { shutdown } } })
    const resetSessionContext = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      contextReset: true,
      frameworkId: 'claude-code',
      backendId: 'claude-code:anthropic'
    })
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      contextReset: false,
      frameworkId: 'claude-code',
      backendId: 'claude-code:anthropic'
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession,
      resetSessionContext,
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue detached branch',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })

    expect(shutdown).toHaveBeenCalledOnce()
    expect(resetSessionContext).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      true
    )
    expect(resumeSession).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      resumeSession.mock.invocationCallOrder[0]
    )
    expect(resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      resetSessionContext.mock.invocationCallOrder[0]
    )
    expect(resetSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendPrompt.mock.invocationCallOrder[0]
    )
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('Original branch turn')
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBeUndefined()
  })

  it('adopts the selected framework when a Branch reset and framework switch share a turn', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original Claude branch turn',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    const shutdown = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      status: 'shutdown'
    })
    vi.stubGlobal('window', { api: { notebook: { shutdown } } })
    const resumeCanFinish = createDeferred<{
      sessionId: string
      cwd: string
      contextReset: boolean
      frameworkId: string
      backendId: string
    }>()
    const resumeSession = vi.fn().mockReturnValue(resumeCanFinish.promise)
    const resumeResult = {
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      contextReset: false,
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    }
    const resetSessionContext = vi.fn().mockResolvedValue({
      ...resumeResult,
      contextReset: true
    })
    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      // A draining runtime may still expose the logical session while the selected runtime takes over.
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession,
      resetSessionContext,
      sendPrompt
    }

    const sendRequest = sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue this branch with Codex',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription'
    })
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledOnce())

    // Keep the prior Runtime Segment active until adoption succeeds. A draining stop/error can then
    // settle the prior turn without accidentally finishing the optimistic Codex run.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      messages: [expect.objectContaining({ content: 'Original Claude branch turn' })]
    })

    resumeCanFinish.resolve(resumeResult)
    await sendRequest
    await flushRuntimeTasks()

    expect(resetSessionContext).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      true
    )
    expect(resumeSession).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      resumeSession.mock.invocationCallOrder[0]
    )
    expect(resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      resetSessionContext.mock.invocationCallOrder[0]
    )
    expect(resetSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      sendPrompt.mock.invocationCallOrder[0]
    )
    const switchedSession = useSessionStore.getState().sessions[0]
    const promptContext = sendPrompt.mock.calls[0]?.[9]
    const promptSegment = switchedSession.conversationGraph?.runtimeSegments.find(
      (segment) => segment.id === promptContext?.runtimeSegmentId
    )
    expect(promptSegment).toMatchObject({
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    })
    expect(switchedSession.branchContextResetRequired).toBeUndefined()
  })

  it('drains accepted runtime events before opening the adopted run', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original prompt',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    const sendPrompt = vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex',
        backendId: 'codex:builtin-codex-subscription'
      }),
      resetSessionContext: vi.fn(),
      sendPrompt
    }
    const drainRuntimeEvents = vi.fn(async () => {
      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'accepted-final-message',
          sessionId: 'transport-session-1',
          messageId: 'accepted-agent-message',
          role: 'assistant',
          text: 'Accepted final answer'
        })
      )
      await applyWorkspaceRuntimeEvent(
        createEvent({
          id: 'accepted-stop',
          sessionId: 'transport-session-1',
          kind: 'stop'
        })
      )
    })

    await sendWorkspaceMessage(
      runtime,
      {
        sessionId: 'transport-session-1',
        text: 'Continue with Codex',
        cwd: '/workspace/project',
        projectId: 'project-1',
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:builtin-codex-subscription'
      },
      { drainRuntimeEvents }
    )

    expect(drainRuntimeEvents).toHaveBeenCalledOnce()
    expect(drainRuntimeEvents).toHaveBeenCalledWith('transport-session-1')
    expect(sendPrompt.mock.calls[0]?.[5]).toContain('Accepted final answer')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun: { promptMessageId: expect.any(String) }
    })
  })

  it('does not recreate a session deleted while runtime adoption is in flight', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original prompt',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    const resumeGate = createDeferred<{
      sessionId: string
      cwd: string
      contextReset: boolean
      frameworkId: 'codex'
      backendId: string
    }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeGate.promise),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const sendRequest = sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Do not resurrect this conversation',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription'
    })
    await vi.waitFor(() => expect(runtime.resumeSession).toHaveBeenCalledOnce())

    useSessionStore.getState().deleteSession('transport-session-1')
    resumeGate.resolve({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      contextReset: true,
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    })

    await expect(sendRequest).resolves.toBeUndefined()
    expect(
      useSessionStore.getState().sessions.some((session) => session.id === 'transport-session-1')
    ).toBe(false)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('keeps Branch replay required when the reset prompt is rejected', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original branch turn',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    vi.stubGlobal('window', {
      api: {
        notebook: { shutdown: vi.fn().mockResolvedValue({ status: 'shutdown' }) },
        acp: { getState: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1'])) }
      }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockRejectedValue(new Error('prompt rejected'))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue selected branch',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBe(true)
  })

  it('adopts a model-only Session target before resetting a selected Branch', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Original branch turn',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'old-model',
        reasoningEffort: 'default'
      }
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    vi.stubGlobal('window', {
      api: { notebook: { shutdown: vi.fn().mockResolvedValue({ status: 'shutdown' }) } }
    })
    const agentConfiguration = {
      providerId: 'provider-1',
      model: 'new-model',
      reasoningEffort: 'high'
    } as const
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      frameworkId: 'codex',
      backendId: 'codex:provider-1',
      contextReset: true
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession,
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue selected branch',
      cwd: '/workspace/project',
      projectId: 'project-1',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'new-model',
      agentConfiguration
    })

    expect(resumeSession).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      'codex',
      'codex:provider-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { frameworkId: 'codex', ...agentConfiguration },
      true
    )
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('clears Branch replay after filtering images for a text-only model', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Inspect this upload',
      attachments: [
        {
          id: 'upload-1',
          sessionId: 'transport-session-1',
          name: 'figure.png',
          originalName: 'figure.png',
          path: 'upload-version:upload-version-1',
          mimeType: 'image/png',
          size: 12,
          versionId: 'upload-version-1',
          versionNumber: 1
        }
      ],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        branchContextResetRequired: true
      }))
    }))
    vi.stubGlobal('window', {
      api: { notebook: { shutdown: vi.fn().mockResolvedValue({ status: 'shutdown' }) } }
    })
    const runtime = {
      state: createSnapshot(['transport-session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-1',
      text: 'Continue selected branch',
      cwd: '/workspace/project',
      projectId: 'project-1',
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBeFalsy()
  })

  it('shows a new conversation prompt before ACP session creation resolves', async () => {
    let resolveCreatedSession!: (value: { sessionId: string; cwd?: string }) => void
    const createdSession = new Promise<{ sessionId: string; cwd?: string }>((resolve) => {
      resolveCreatedSession = resolve
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(() => createdSession),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    const sent = await sendWorkspaceMessage(runtime, {
      text: 'Help me inspect this notebook',
      cwd: '/workspace/project',
      agentModel: 'model-used-by-run'
    })

    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      undefined,
      'ask',
      undefined,
      undefined,
      true
    )
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: sent?.sessionId,
      isPending: true,
      agentModel: 'model-used-by-run',
      status: 'running',
      messages: [
        expect.objectContaining({
          id: sent?.messageId,
          role: 'user',
          content: 'Help me inspect this notebook'
        })
      ]
    })

    resolveCreatedSession({
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      isPending: false,
      agentModel: 'model-used-by-run',
      messages: [
        expect.objectContaining({
          id: sent?.messageId,
          content: 'Help me inspect this notebook'
        })
      ]
    })
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'transport-session-1',
      'Help me inspect this notebook',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ promptMessageId: expect.any(String) }),
      false,
      undefined,
      undefined,
      true
    )
  })

  it('links staged and immutable PDFs atomically before the first Session prompt', async () => {
    const stagedPdf = createAttachment({
      id: 'pdf-upload-1',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf'
    })
    const finalizedPdf = createAttachment({
      ...stagedPdf,
      sessionId: 'transport-session-1',
      path: 'upload-version:project-1/transport-session-1/pdf-version-1',
      versionId: 'pdf-version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64)
    })
    const pdfContext: SessionPdfContext = {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'upload-version',
          sourceFileId: stagedPdf.id,
          sourceVersionId: finalizedPdf.versionId!,
          sourceSessionId: 'transport-session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: stagedPdf.size,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        },
        {
          version: 1,
          bindingId: 'binding-2',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'artifact-version-2',
          sourceSessionId: 'source-session-2',
          name: 'library-paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 84,
          checksum: 'b'.repeat(64),
          linkedAt: 2
        }
      ]
    }
    const readingPosition = { pageNumber: 3, pageCount: 14 }
    const saveSession = vi.fn(async (session: PersistedChatSession) =>
      saveSession.mock.calls.length === 1
        ? { ...session, runtimeContext: { version: 1 as const, revision: 3 } }
        : session
    )
    const linkPdfContext = vi.fn().mockResolvedValue({
      version: 1,
      revision: 1,
      pdfContext
    })
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession: vi.fn().mockResolvedValue([finalizedPdf]) },
        sessions: {
          saveSession,
          linkPdfContext,
          filterPdfContextCandidates: vi.fn().mockResolvedValue({
            sources: [
              {
                sourceKind: 'artifact-version',
                sourceFileId: 'artifact-2',
                sourceVersionId: 'artifact-version-2'
              }
            ],
            pendingAttachmentIds: [stagedPdf.id]
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }
    const onPdfContextLinked = vi.fn()

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        text: 'Read this paper',
        attachments: [stagedPdf],
        pendingPdfContextAttachmentIds: [stagedPdf.id],
        pendingPdfContextVersions: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-2',
            sourceVersionId: 'artifact-version-2'
          }
        ],
        pdfReadingPosition: readingPosition,
        cwd: '/workspace/project',
        projectId: 'project-1'
      },
      { onPdfContextLinked }
    )
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())

    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined,
      undefined,
      true,
      true
    )
    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'transport-session-1',
      expectedRevision: 3,
      sources: [
        {
          sourceKind: 'upload-version',
          sourceFileId: 'pdf-upload-1',
          sourceVersionId: 'pdf-version-1'
        },
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'artifact-version-2'
        }
      ],
      excludeSinglePage: true
    })
    expect(runtime.sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({
        id: stagedPdf.id,
        source: 'upload',
        versionId: 'pdf-version-1'
      }),
      expect.objectContaining({
        id: 'artifact-2',
        source: 'artifact',
        versionId: 'artifact-version-2'
      })
    ])
    const session = useSessionStore.getState().sessions[0]
    expect(session.runtimeContext?.pdfContext).toEqual(pdfContext)
    expect(session.messages.find((message) => message.id === sent?.messageId)?.pdfContext).toEqual({
      ...pdfContext,
      activeBindingId: 'binding-1',
      readingPosition
    })
    expect(onPdfContextLinked).toHaveBeenCalledWith('transport-session-1', {
      ...pdfContext,
      activeBindingId: 'binding-1',
      readingPosition
    })
    expect(saveSession).toHaveBeenCalledTimes(2)
  })

  it('does not provision Literature when every staged PDF candidate is single-page', async () => {
    const stagedPdf = createAttachment({
      id: 'single-page-pdf',
      name: 'one-page.pdf',
      originalName: 'one-page.pdf',
      path: '/uploads/.pending/one-page.pdf',
      mimeType: 'application/pdf'
    })
    const finalizedPdf = createAttachment({
      ...stagedPdf,
      sessionId: 'transport-session-1',
      path: 'upload-version:project-1/transport-session-1/single-page-version',
      versionId: 'single-page-version'
    })
    const linkPdfContext = vi.fn()
    const filterPdfContextCandidates = vi.fn().mockResolvedValue({
      sources: [],
      pendingAttachmentIds: []
    })
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession: vi.fn().mockResolvedValue([finalizedPdf]) },
        sessions: { filterPdfContextCandidates, linkPdfContext }
      }
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Describe this file',
      attachments: [stagedPdf],
      pendingPdfContextAttachmentIds: [stagedPdf.id],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())

    expect(filterPdfContextCandidates).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: [],
      pendingAttachments: [
        {
          attachmentId: stagedPdf.id,
          path: stagedPdf.path,
          name: stagedPdf.name,
          mimeType: stagedPdf.mimeType
        }
      ]
    })
    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined,
      undefined,
      true
    )
    expect(linkPdfContext).not.toHaveBeenCalled()
  })

  it('notifies Session bind so first-turn overflow can keep the admitted target', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }
    const onSessionBound = vi.fn()

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        text: 'Help me inspect this notebook',
        cwd: '/workspace/project'
      },
      { onSessionBound }
    )
    await vi.waitFor(() => expect(onSessionBound).toHaveBeenCalledTimes(1))

    expect(sent?.sessionId).toBeDefined()
    expect(sent?.sessionId).not.toBe('transport-session-1')
    expect(onSessionBound).toHaveBeenCalledWith(sent?.sessionId, 'transport-session-1')
  })

  it('persists enabled Compute Hosts before dispatching a new Session prompt', async () => {
    const persisted = createDeferred<PersistedChatSession>()
    const saveSession = vi.fn((session: PersistedChatSession) => {
      void session
      return persisted.promise
    })
    vi.stubGlobal('window', { api: { sessions: { saveSession } } })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Inspect the cluster',
      cwd: '/workspace/project',
      projectId: 'project-1',
      enabledComputeHosts: ['ssh:cluster']
    })

    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({
      id: 'transport-session-1',
      enabledComputeHosts: ['ssh:cluster']
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    persisted.resolve(saveSession.mock.calls[0]![0])
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
  })

  it('materializes a denied new Session and confirms policy authority before dispatch', async () => {
    const materialized = createDeferred<PersistedChatSession>()
    const authorized = createDeferred<PersistedChatSession>()
    const saveSession = vi.fn((session: PersistedChatSession) => {
      void session
      return materialized.promise
    })
    const setDelegationPolicy = vi.fn(() => authorized.promise)
    vi.stubGlobal('window', {
      api: { sessions: { saveSession, setDelegationPolicy } }
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-denied',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-denied']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Work without creating Subagents',
      cwd: '/workspace/project',
      projectId: 'project-1',
      delegationPolicy: 'deny'
    })

    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({
      id: 'transport-session-denied',
      delegationPolicy: 'allow'
    })
    expect(setDelegationPolicy).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    materialized.resolve(saveSession.mock.calls[0]![0])
    await vi.waitFor(() => expect(setDelegationPolicy).toHaveBeenCalledOnce())
    expect(setDelegationPolicy).toHaveBeenCalledWith(
      'project-1',
      'transport-session-denied',
      'deny'
    )
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    authorized.resolve({
      ...saveSession.mock.calls[0]![0],
      revision: 2,
      delegationPolicy: 'deny'
    })
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-denied',
      revision: 2,
      delegationPolicy: 'deny'
    })
  })

  it('materializes an explicit allow projection before a new Session prompt', async () => {
    const persisted = createDeferred<PersistedChatSession>()
    const saveSession = vi.fn((session: PersistedChatSession) => {
      void session
      return persisted.promise
    })
    const setDelegationPolicy = vi.fn(async () => ({
      ...saveSession.mock.calls[0]![0],
      revision: 2,
      delegationPolicy: 'allow' as const
    }))
    vi.stubGlobal('window', { api: { sessions: { saveSession, setDelegationPolicy } } })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-allowed',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-allowed']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Work with optional delegation',
      cwd: '/workspace/project',
      projectId: 'project-1',
      delegationPolicy: 'allow'
    })

    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({ delegationPolicy: 'allow' })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    persisted.resolve(saveSession.mock.calls[0]![0])
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(setDelegationPolicy).toHaveBeenCalledWith(
      'project-1',
      'transport-session-allowed',
      'allow'
    )
  })

  it('confirms an inherited denied Message Branch before dispatch without a caller override', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('source-session')
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().applyDelegationPolicyAuthority({
      ...toPersistedSession(source),
      revision: 2,
      delegationPolicy: 'deny',
      updatedAt: source.updatedAt + 1
    })
    let materialized!: PersistedChatSession
    const saveSession = vi.fn(async (session: PersistedChatSession) => {
      materialized = session
      return session
    })
    const setDelegationPolicy = vi.fn(async () => ({
      ...materialized,
      revision: (materialized.revision ?? 0) + 1,
      delegationPolicy: 'deny' as const
    }))
    vi.stubGlobal('window', {
      api: { sessions: { saveSession, setDelegationPolicy } }
    })
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        branchSourceSessionId: 'source-session',
        text: 'Try a different interpretation'
      },
      { awaitPendingPreparation: true }
    )

    expect(sent).toBeDefined()
    expect(saveSession).toHaveBeenCalledOnce()
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({ delegationPolicy: 'allow' })
    expect(setDelegationPolicy).toHaveBeenCalledWith(
      'project-1',
      'branched-runtime-session',
      'deny'
    )
    expect(setDelegationPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendPrompt.mock.invocationCallOrder[0]
    )
  })

  it('persists an explicit denied Message Branch override from an allowed source', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1',
      delegationPolicy: 'allow'
    })
    useSessionStore.getState().finishRun('source-session')
    const policyApi = createSessionPolicyApi()
    vi.stubGlobal('window', { api: { sessions: policyApi } })
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        branchSourceSessionId: 'source-session',
        text: 'Try a different interpretation',
        delegationPolicy: 'deny'
      },
      { awaitPendingPreparation: true }
    )

    expect(sent).toBeDefined()
    expect(policyApi.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ delegationPolicy: 'allow' })
    )
    expect(policyApi.setDelegationPolicy).toHaveBeenCalledWith(
      'project-1',
      'branched-runtime-session',
      'deny'
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      delegationPolicy: 'deny',
      delegationPolicyAuthorityPending: undefined
    })
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('reports a denied new Session preparation failure without dispatching its prompt', async () => {
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    const setDelegationPolicy = vi.fn().mockRejectedValue(new Error('Policy authority unavailable'))
    vi.stubGlobal('window', {
      api: { sessions: { saveSession, setDelegationPolicy } }
    })
    const deleteSession = vi.fn().mockResolvedValue(createSnapshot())
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-denied',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      deleteSession,
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-denied']))
    }

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        text: 'Work without creating Subagents',
        cwd: '/workspace/project',
        projectId: 'project-1',
        delegationPolicy: 'deny'
      },
      { awaitPendingPreparation: true }
    )

    expect(sent).toBeUndefined()
    expect(deleteSession).toHaveBeenCalledWith('transport-session-denied')
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Policy authority unavailable',
      delegationPolicy: 'deny',
      delegationPolicyAuthorityPending: true
    })

    const failed = useSessionStore.getState().sessions[0]
    setDelegationPolicy.mockResolvedValueOnce({
      ...toPersistedSession(failed),
      revision: (failed.revision ?? 0) + 1,
      delegationPolicy: 'deny'
    })
    runtime.state = createSnapshot(['transport-session-denied'])

    const retried = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-denied',
      text: 'Retry without creating Subagents',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(retried).toBeDefined()
    expect(setDelegationPolicy).toHaveBeenLastCalledWith(
      'project-1',
      'transport-session-denied',
      'deny'
    )
    expect(setDelegationPolicy.mock.invocationCallOrder.at(-1)).toBeLessThan(
      runtime.sendPrompt.mock.invocationCallOrder[0]
    )
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('confirms denied authority before PDF linking and keeps retry fail-closed after link failure', async () => {
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    const setDelegationPolicy = vi.fn(async () => {
      const session = useSessionStore.getState().sessions[0]
      return {
        ...toPersistedSession(session),
        revision: (session.revision ?? 0) + 1,
        delegationPolicy: 'deny' as const
      }
    })
    const linkPdfContext = vi.fn().mockRejectedValue(new Error('PDF context unavailable'))
    vi.stubGlobal('window', {
      api: {
        sessions: {
          saveSession,
          setDelegationPolicy,
          linkPdfContext,
          filterPdfContextCandidates: vi.fn().mockResolvedValue({
            sources: [{ sourceKind: 'artifact-version', sourceVersionId: 'version-1' }],
            pendingAttachmentIds: []
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-pdf-denied',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-pdf-denied']))
    }

    const sent = await sendWorkspaceMessage(
      runtime,
      {
        text: 'Read without creating Subagents',
        cwd: '/workspace/project',
        projectId: 'project-1',
        delegationPolicy: 'deny',
        pendingPdfContextVersions: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      },
      { awaitPendingPreparation: true }
    )

    expect(sent).toBeUndefined()
    expect(setDelegationPolicy).toHaveBeenCalledWith(
      'project-1',
      'transport-session-pdf-denied',
      'deny'
    )
    expect(setDelegationPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      linkPdfContext.mock.invocationCallOrder[0]
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      delegationPolicy: 'deny',
      delegationPolicyAuthorityPending: undefined,
      status: 'error'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    runtime.state = createSnapshot(['transport-session-pdf-denied'])
    const retried = await sendWorkspaceMessage(runtime, {
      sessionId: 'transport-session-pdf-denied',
      text: 'Retry the reading',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })

    expect(retried).toBeDefined()
    expect(setDelegationPolicy).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('deletes a new runtime Session when enabled Compute Host persistence fails', async () => {
    vi.stubGlobal('window', {
      api: {
        sessions: {
          saveSession: vi.fn().mockRejectedValue(new Error('Session write failed'))
        }
      }
    })
    const deleteSession = vi.fn().mockResolvedValue(createSnapshot())
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      deleteSession,
      sendPrompt: vi.fn()
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Inspect the cluster',
      cwd: '/workspace/project',
      projectId: 'project-1',
      enabledComputeHosts: ['ssh:cluster']
    })

    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith('transport-session-1'))
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Session write failed'
    })
  })

  it('retains Plan first while a new Session waits for ACP creation', async () => {
    const created = createDeferred<{ sessionId: string; cwd?: string }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(() => created.promise),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Plan the analysis',
      cwd: '/workspace/project',
      turnIntent: 'plan-first'
    })
    created.resolve({ sessionId: 'transport-session-1', cwd: '/workspace/project' })
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[12]).toBe('plan-first')
  })

  it('creates and selects a branched Session before replaying its active history into a fresh ACP session', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'The original analysis is complete.'
    })
    useSessionStore.getState().finishRun('source-session')
    const sourceBeforeBranch = useSessionStore.getState().sessions[0]
    const created = createDeferred<{ sessionId: string; cwd?: string }>()
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn(() => created.promise),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try a different interpretation',
      cwd: '/ignored-by-source-snapshot',
      projectId: 'wrong-project',
      turnIntent: 'plan-first'
    })

    expect(branched).toBeDefined()
    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined,
      undefined,
      true
    )
    expect(useSessionStore.getState().selectedSessionId).toBe(branched?.sessionId)
    expect(useSessionStore.getState().sessions).toHaveLength(2)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === 'source-session')
    ).toEqual(sourceBeforeBranch)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === branched?.sessionId)
    ).toMatchObject({
      id: branched?.sessionId,
      isPending: true,
      title: 'Try a different interpretation',
      messages: [
        expect.objectContaining({ content: 'Inspect the original data' }),
        expect.objectContaining({ content: 'The original analysis is complete.' }),
        expect.objectContaining({ content: 'Try a different interpretation' })
      ]
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    created.resolve({ sessionId: 'branched-runtime-session', cwd: '/workspace/project' })
    await flushRuntimeTasks()

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(useSessionStore.getState().selectedSessionId).toBe('branched-runtime-session')
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'branched-runtime-session',
      'Try a different interpretation',
      [],
      undefined,
      undefined,
      expect.stringContaining('Inspect the original data'),
      [],
      [],
      undefined,
      expect.objectContaining({ promptMessageId: branched?.messageId }),
      true,
      undefined,
      'plan-first',
      true
    )
  })

  it('relinks the captured PDF context before dispatching a branched Session', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the paper',
      cwd: '/workspace/project',
      projectId: 'project-1',
      delegationPolicy: 'deny'
    })
    useSessionStore.getState().finishRun('source-session')
    const pdfContext: SessionPdfContext = {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'source-binding',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }
    const branchedPdfContext: SessionPdfContext = {
      ...pdfContext,
      bindings: [{ ...pdfContext.bindings[0], bindingId: 'branched-binding' }]
    }
    let materialized!: PersistedChatSession
    const saveSession = vi.fn(async (session: PersistedChatSession) => {
      materialized = {
        ...session,
        runtimeContext: { version: 1 as const, revision: 3 }
      }
      return materialized
    })
    const setDelegationPolicy = vi.fn(async (_projectId, _sessionId, policy: DelegationPolicy) => ({
      ...materialized,
      revision: (materialized.revision ?? 0) + 1,
      delegationPolicy: policy
    }))
    const linkPdfContext = vi.fn().mockResolvedValue({
      version: 1,
      revision: 4,
      pdfContext: branchedPdfContext
    })
    vi.stubGlobal('window', {
      api: {
        sessions: {
          saveSession,
          setDelegationPolicy,
          linkPdfContext,
          filterPdfContextCandidates: vi.fn().mockResolvedValue({
            sources: [{ sourceKind: 'artifact-version', sourceVersionId: 'version-1' }],
            pendingAttachmentIds: []
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try a different interpretation',
      pdfContext
    })
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())

    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'branched-runtime-session',
      expectedRevision: 3,
      sources: [{ sourceKind: 'artifact-version', sourceVersionId: 'version-1' }],
      excludeSinglePage: true
    })
    expect(saveSession.mock.calls.length).toBeGreaterThan(0)
    expect(saveSession.mock.calls[0]?.[0]).toMatchObject({ delegationPolicy: 'allow' })
    expect(runtime.sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        source: 'artifact',
        versionId: 'version-1',
        mimeType: 'application/pdf'
      })
    ])
  })

  it('creates and persists an idle branched Session without sending a prompt', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1',
      delegationPolicy: 'allow'
    })
    const firstAnswer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'The original analysis is complete.'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Continue in the source Session'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'later-stream',
      eventId: 'later-event',
      content: 'Later answer'
    })
    useSessionStore.getState().finishRun('source-session')
    const saveSession = vi.fn(async (session: PersistedChatSession) => ({
      ...session,
      revision: 4,
      delegationPolicy: 'allow' as const
    }))
    const setDelegationPolicy = vi.fn(async () => ({
      ...saveSession.mock.calls[0]![0],
      revision: 5,
      delegationPolicy: 'deny' as const
    }))
    vi.stubGlobal('window', { api: { sessions: { saveSession, setDelegationPolicy } } })
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      deleteSession: vi.fn(),
      sendPrompt: vi.fn()
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      branchSourceMessageId: firstAnswer?.messageId ?? '',
      text: '',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:shared',
      agentModel: 'gpt-5.4',
      delegationPolicy: 'deny',
      specialistId: 'specialist-b'
    })

    expect(branched).toEqual({
      sessionId: 'branched-session',
      messageId: firstAnswer?.messageId
    })
    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      'specialist-b',
      undefined,
      true
    )
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'branched-session',
        status: 'idle',
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:shared',
        agentModel: 'gpt-5.4',
        specialistId: 'specialist-b',
        delegationPolicy: 'allow',
        pendingHistoryReplay: { kind: 'all' },
        messages: [
          expect.objectContaining({ content: 'Inspect the original data' }),
          expect.objectContaining({ content: 'The original analysis is complete.' })
        ]
      })
    )
    expect(setDelegationPolicy).toHaveBeenCalledWith('project-1', 'branched-session', 'deny')
    expect(useSessionStore.getState().selectedSessionId).toBe('branched-session')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'branched-session',
      revision: 5,
      delegationPolicy: 'deny',
      delegationPolicyAuthorityPending: undefined
    })
  })

  it('rejects a prompt while an idle branched Session is still binding', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    const firstAnswer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'The original analysis is complete.'
    })
    useSessionStore.getState().finishRun('source-session')
    const created = createDeferred<{ sessionId: string; cwd?: string }>()
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    vi.stubGlobal('window', {
      api: {
        sessions: { saveSession, setDelegationPolicy: createSessionPolicyApi().setDelegationPolicy }
      }
    })
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn(() => created.promise),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      deleteSession: vi.fn(),
      sendPrompt: vi.fn()
    }

    const branchPromise = sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      branchSourceMessageId: firstAnswer?.messageId ?? '',
      text: ''
    })
    await vi.waitFor(() => expect(runtime.createSession).toHaveBeenCalledOnce())
    const pending = useSessionStore.getState().sessions.find((session) => session.isPending)
    expect(pending).toBeDefined()
    if (!pending) throw new Error('Expected a pending branched Session')

    const immediateSend = await sendWorkspaceMessage(runtime, {
      sessionId: pending.id,
      text: 'Follow up before binding completes'
    })

    expect(immediateSend).toBeUndefined()
    expect(pending.messages.map((message) => message.content)).toEqual([
      'Inspect the original data',
      'The original analysis is complete.'
    ])
    expect(runtime.createSession).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    created.resolve({ sessionId: 'branched-session', cwd: '/workspace/project' })
    await expect(branchPromise).resolves.toEqual({
      sessionId: 'branched-session',
      messageId: firstAnswer?.messageId
    })
  })

  it.each([
    ['omits', false],
    ['replays', true]
  ] as const)(
    '%s history images based on Vision relay support',
    async (_action, supportsImageRelay) => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'source-session',
        content: 'Inspect this chart',
        cwd: '/workspace/project',
        projectId: 'project-1'
      })
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'source-session',
        streamId: 'source-stream',
        eventId: 'source-image-event',
        image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
      })
      useSessionStore.getState().finishRun('source-session')
      const sourceBeforeBranch = useSessionStore.getState().sessions[0]
      const runtime = {
        state: createSnapshot(['source-session']),
        createSession: vi.fn().mockResolvedValue({
          sessionId: 'branched-runtime-session',
          cwd: '/workspace/project'
        }),
        resumeSession: vi.fn(),
        resetSessionContext: vi.fn(),
        sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
      }

      const branched = await sendWorkspaceMessage(runtime, {
        branchSourceSessionId: 'source-session',
        text: 'Try another chart explanation',
        supportsImageInput: false,
        supportsImageRelay
      })

      expect(branched).toBeDefined()
      await flushRuntimeTasks()

      expect(runtime.createSession).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
      expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('Inspect this chart')
      expect(runtime.sendPrompt.mock.calls[0]?.[6]).toEqual([])
      expect(runtime.sendPrompt.mock.calls[0]?.[7]).toEqual(
        supportsImageRelay
          ? [expect.objectContaining({ mimeType: 'image/png', data: 'aGVsbG8=' })]
          : []
      )
      expect(
        useSessionStore.getState().sessions.find((session) => session.id === 'source-session')
      ).toEqual(sourceBeforeBranch)
      expect(useSessionStore.getState().selectedSessionId).toBe('branched-runtime-session')
    }
  )

  it('publishes a path-only legacy history upload under the source Session before replay', async () => {
    const finalizedHistory = createAttachment({
      id: 'legacy-upload-1',
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/legacy-upload-1/legacy-version-1',
      mimeType: 'image/png',
      versionId: 'legacy-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedHistory])
    vi.stubGlobal('window', {
      api: { uploads: { finalizeSession }, sessions: createSessionPolicyApi() }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect this legacy chart',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session'
          ? {
              ...session,
              messages: session.messages.map((message) => ({
                ...message,
                uploads: [
                  {
                    id: 'legacy-upload-1',
                    sessionId: 'source-session',
                    name: 'legacy.png',
                    originalName: 'legacy.png',
                    path: '/legacy/uploads/source-session/legacy.png',
                    mimeType: 'image/png',
                    size: 12
                  }
                ]
              }))
            }
          : session
      )
    }))
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try another chart explanation'
    })
    await flushRuntimeTasks()

    expect(branched).toBeDefined()
    expect(finalizeSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'source-session',
      attachments: [
        expect.objectContaining({
          id: 'legacy-upload-1',
          sessionId: 'source-session',
          path: '/legacy/uploads/source-session/legacy.png'
        })
      ]
    })
    const source = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'source-session')
    const child = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'branched-runtime-session')
    expect(source?.messages[0].uploads).toEqual([
      expect.objectContaining({ versionId: 'legacy-version-1' })
    ])
    expect(child?.messages[0].uploads).toEqual(source?.messages[0].uploads)
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'branched-runtime-session',
      'Try another chart explanation',
      [],
      undefined,
      undefined,
      expect.stringContaining('Inspect this legacy chart'),
      [finalizedHistory],
      [],
      undefined,
      expect.objectContaining({ promptMessageId: branched?.messageId }),
      true,
      undefined,
      undefined,
      true
    )
  })

  it('does not create or prompt an ACP Session when a pending branch is cancelled during history reconciliation', async () => {
    const stagedHistory = createAttachment({ id: 'history-upload-1', mimeType: 'image/png' })
    const finalizedHistory = createAttachment({
      id: stagedHistory.id,
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/history-upload-1/history-version-1',
      mimeType: 'image/png',
      versionId: 'history-version-1',
      versionNumber: 1
    })
    const finalization = createDeferred<UploadedAttachment[]>()
    const finalizeSession = vi.fn(() => finalization.promise)
    vi.stubGlobal('window', {
      api: { uploads: { finalizeSession }, sessions: createSessionPolicyApi() }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the staged data',
      attachments: [stagedHistory],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('source-session')
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn(),
      cancel: vi.fn()
    }

    const branching = sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Continue with the staged data'
    })
    await flushRuntimeTasks()

    const pending = useSessionStore.getState().sessions[0]
    expect(pending).toMatchObject({ isPending: true, status: 'running' })
    await cancelWorkspaceRun(runtime, pending.id)
    expect(runtime.cancel).not.toHaveBeenCalled()

    finalization.resolve([finalizedHistory])
    await expect(branching).resolves.toEqual({
      sessionId: pending.id,
      messageId: pending.activeRun?.promptMessageId
    })
    await flushRuntimeTasks()

    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: pending.id,
      isPending: true,
      status: 'idle',
      activeRun: undefined
    })
  })

  it('publishes staged branch history under the source Session before replay', async () => {
    const stagedHistory = createAttachment({ id: 'history-upload-1', mimeType: 'image/png' })
    const finalizedHistory = createAttachment({
      id: stagedHistory.id,
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/history-upload-1/history-version-1',
      mimeType: 'image/png',
      versionId: 'history-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedHistory])
    vi.stubGlobal('window', {
      api: { uploads: { finalizeSession }, sessions: createSessionPolicyApi() }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the staged data',
      attachments: [stagedHistory],
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('source-session')
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Continue with the staged data'
    })
    await flushRuntimeTasks()

    expect(finalizeSession).toHaveBeenCalledOnce()
    expect(finalizeSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'source-session',
      attachments: [stagedHistory]
    })
    const source = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'source-session')
    const child = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'branched-runtime-session')
    expect(source?.messages[0].uploads).toEqual([
      expect.objectContaining({ sessionId: 'source-session', versionId: 'history-version-1' })
    ])
    expect(child?.messages[0].uploads).toEqual(source?.messages[0].uploads)
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledOnce())
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'branched-runtime-session',
      'Continue with the staged data',
      [],
      undefined,
      undefined,
      expect.stringContaining('Inspect the staged data'),
      [finalizedHistory],
      [],
      undefined,
      expect.objectContaining({ promptMessageId: branched?.messageId }),
      true,
      undefined,
      undefined,
      true
    )
  })

  it('retries a failed branched Session with the copied history and one current prompt', async () => {
    const attachment = createAttachment()
    const finalizedAttachment = createAttachment({
      sessionId: 'branched-runtime-session',
      path: 'upload-version:project-1/branched-runtime-session/upload-1/upload-version-1',
      versionId: 'upload-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedAttachment])
    vi.stubGlobal('window', {
      api: { uploads: { finalizeSession }, sessions: createSessionPolicyApi() }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'The original analysis is complete.'
    })
    useSessionStore.getState().finishRun('source-session')
    const runtime = {
      state: createSnapshot(['source-session']),
      createSession: vi
        .fn()
        .mockRejectedValueOnce(new Error('Provider unavailable'))
        .mockResolvedValueOnce({
          sessionId: 'branched-runtime-session',
          cwd: '/workspace/project'
        }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session']))
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try a different interpretation',
      attachments: [attachment]
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: branched?.sessionId,
      isPending: true,
      status: 'error',
      messages: [
        expect.objectContaining({ content: 'Inspect the original data' }),
        expect.objectContaining({ content: 'The original analysis is complete.' }),
        expect.objectContaining({
          content: 'Try a different interpretation',
          uploads: [expect.objectContaining({ id: attachment.id, path: attachment.path })]
        })
      ]
    })

    const retried = await sendWorkspaceMessage(runtime, {
      sessionId: branched?.sessionId,
      text: 'Try a different interpretation'
    })
    await flushRuntimeTasks()

    const child = useSessionStore.getState().sessions[0]
    expect(child.id).toBe('branched-runtime-session')
    expect(child.messages).toHaveLength(3)
    expect(child.messages.at(-1)).toMatchObject({
      id: retried?.messageId,
      content: 'Try a different interpretation'
    })
    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledTimes(1))
    const promptCall = runtime.sendPrompt.mock.calls[0]
    expect(promptCall[1]).toBe('Try a different interpretation')
    expect(promptCall[2]).toEqual([finalizedAttachment])
    expect(promptCall[5]).toContain('Inspect the original data')
    expect(promptCall[5]).toContain('The original analysis is complete.')
    expect(promptCall[5]).not.toContain('Try a different interpretation')
    expect(finalizeSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'branched-runtime-session',
      attachments: [attachment]
    })
    expect(child.messages.at(-1)?.uploads).toEqual([
      expect.objectContaining({ versionId: 'upload-version-1' })
    ])
  })

  it('replays copied history when the first branched prompt fails after session binding', async () => {
    const attachment = createAttachment()
    const finalizedAttachment = createAttachment({
      sessionId: 'branched-runtime-session',
      path: 'upload-version:project-1/branched-runtime-session/upload-1/upload-version-1',
      versionId: 'upload-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedAttachment])
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession },
        sessions: createSessionPolicyApi(),
        acp: { getState: vi.fn().mockResolvedValue(createSnapshot(['branched-runtime-session'])) }
      }
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Inspect the original data',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'The original analysis is complete.'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-image-event',
      image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    })
    useSessionStore.getState().finishRun('source-session')
    const runtime = {
      state: createSnapshot(['source-session', 'branched-runtime-session']),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'branched-runtime-session',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi
        .fn()
        .mockRejectedValueOnce(new Error('Provider unavailable'))
        .mockResolvedValueOnce(createSnapshot(['branched-runtime-session']))
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try a different interpretation',
      attachments: [attachment]
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[0]).toMatchObject({
        id: 'branched-runtime-session',
        isPending: false,
        status: 'error',
        pendingContextReplayMessageId: branched?.messageId
      })
    )

    const retried = await sendWorkspaceMessage(runtime, {
      sessionId: 'branched-runtime-session',
      text: 'Try a different interpretation',
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    const child = useSessionStore.getState().sessions[0]
    expect(child.messages).toHaveLength(3)
    expect(child.messages.at(-1)).toMatchObject({
      id: retried?.messageId,
      content: 'Try a different interpretation'
    })
    expect(child.pendingContextReplayMessageId).toBeUndefined()
    expect(runtime.createSession).toHaveBeenCalledTimes(1)
    expect(runtime.sendPrompt).toHaveBeenCalledTimes(2)
    const retryPromptCall = runtime.sendPrompt.mock.calls[1]
    expect(retryPromptCall[2]).toEqual([finalizedAttachment])
    expect(retryPromptCall[5]).toContain('Inspect the original data')
    expect(retryPromptCall[5]).toContain('The original analysis is complete.')
    expect(retryPromptCall[5]).not.toContain('Try a different interpretation')
    expect(retryPromptCall[7]).toBeUndefined()
    // The retry reuses the immutable Version returned by the first attempt instead of finalizing it
    // again under the already-bound Session.
    expect(finalizeSession).toHaveBeenCalledOnce()
    expect(child.messages.at(-1)?.uploads).toEqual([
      expect.objectContaining({ versionId: 'upload-version-1' })
    ])
  })

  it('leaves a new conversation cwd unset so main can allocate a managed workspace', async () => {
    const runtime = {
      state: { ...createSnapshot(), cwd: 'C:\\Users\\example' },
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: 'E:\\OpenScience\\workspaces\\workspace-1'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Clone a repository',
      projectId: 'project-1'
    })

    expect(runtime.createSession).toHaveBeenCalledWith(
      undefined,
      'project-1',
      'ask',
      undefined,
      undefined,
      true
    )
  })

  it('does not persist the runtime home when managed session creation omits cwd', async () => {
    const runtime = {
      state: { ...createSnapshot(), cwd: 'C:\\Users\\example' },
      createSession: vi.fn().mockResolvedValue({ sessionId: 'transport-session-1' }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const sent = await sendWorkspaceMessage(runtime, {
      text: 'Clone a repository',
      projectId: 'project-1'
    })
    await flushRuntimeTasks()

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: sent?.sessionId,
      isPending: true,
      cwd: '',
      status: 'error',
      error: 'Agent session did not return a workspace.'
    })
  })

  it('keeps the selected run subject when initial session creation rejects', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockRejectedValue(new Error('Authentication failed')),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const sent = await sendWorkspaceMessage(runtime, {
      text: 'Start a new analysis',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.6-sol'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: sent?.sessionId,
      isPending: true,
      status: 'error',
      error: 'Authentication failed',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.6-sol'
    })
  })

  it('uses a generic creation error when IPC supplies no downstream detail', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi
        .fn()
        .mockRejectedValue(new Error("Error invoking remote method 'acp:create-session': Error")),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Start a new analysis',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]?.error).toBe(
      'Agent session could not be created.'
    )
  })

  it('unwraps an IPC-wrapped config failure at session start and marks it non-reportable', async () => {
    // resolveActiveAgentBackend throws app-authored setup guidance at spawn time; it crosses IPC wrapped
    // as "Error invoking remote method '…': Error: <msg>". The createSession path must unwrap it so the
    // persisted text matches the classifier's prefix and the report button is hidden (wrong-config, not
    // a bug). Uses the framework-specific wording service.ts actually builds (not the resume rewording).
    const runtime = {
      state: createSnapshot(),
      createSession: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'acp:create-session': Error: The active model isn't compatible with Codex. Open Settings → Model to pick a compatible model or switch the agent framework."
          )
        ),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await sendWorkspaceMessage(runtime, {
      text: 'Start a new analysis',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex'
    })
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    // The IPC wrapper is stripped, leaving the app's own setup guidance verbatim.
    expect(session.error).toBe(
      "The active model isn't compatible with Codex. Open Settings → Model to pick a compatible model or switch the agent framework."
    )
    // A wrong-config start failure hides the report button.
    expect(session.errorReportable).toBe(false)
  })

  it('sends attachments when creating a new runtime session', async () => {
    const attachment = createAttachment()
    const finalizedAttachment = createAttachment({
      sessionId: 'transport-session-1',
      path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt'
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedAttachment])

    vi.stubGlobal('window', {
      api: {
        uploads: {
          finalizeSession
        }
      }
    })

    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    const sent = await sendWorkspaceMessage(runtime, {
      text: '',
      attachments: [attachment],
      cwd: '/workspace/project'
    })

    await flushRuntimeTasks()

    expect(finalizeSession).toHaveBeenCalledWith({
      sessionId: 'transport-session-1',
      attachments: [attachment]
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      messages: [
        expect.objectContaining({
          id: sent?.messageId,
          role: 'user',
          content: '',
          uploads: [
            expect.objectContaining({
              id: 'upload-1',
              sessionId: 'transport-session-1'
            })
          ]
        })
      ]
    })
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'transport-session-1',
      '',
      [finalizedAttachment],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ promptMessageId: expect.any(String) }),
      false,
      undefined,
      undefined,
      true
    )
    expect(useSessionStore.getState().sessions[0].messages[0].uploads?.[0]).not.toHaveProperty(
      'path'
    )
  })

  it('reconciles an open upload preview after finalizing a new session attachment', async () => {
    const attachment = createAttachment()
    const finalizedAttachment = createAttachment({
      sessionId: 'transport-session-1',
      path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt'
    })
    vi.stubGlobal('window', {
      api: {
        uploads: {
          finalizeSession: vi.fn().mockResolvedValue([finalizedAttachment])
        }
      }
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'upload:upload-1',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      title: 'notes.txt',
      path: attachment.path,
      format: 'text',
      name: 'notes.txt'
    })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      text: '',
      attachments: [attachment],
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()

    expect(usePreviewWorkbenchStore.getState().items).toMatchObject([
      {
        id: 'upload:upload-1',
        sessionId: 'transport-session-1',
        path: finalizedAttachment.path
      }
    ])
  })

  it('retries ACP session creation for an unbound pending conversation', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        sessionId: 'transport-session-1',
        cwd: '/workspace/project'
      }),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    const first = await sendWorkspaceMessage(runtime, {
      text: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })
    const pendingSessionId = first?.sessionId ?? ''

    await Promise.resolve()
    await Promise.resolve()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: pendingSessionId,
      isPending: true,
      status: 'error',
      error: 'Agent session could not be created.'
    })

    const retry = await sendWorkspaceMessage(runtime, {
      sessionId: pendingSessionId,
      text: 'Try again',
      cwd: '/workspace/project'
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.createSession).toHaveBeenCalledTimes(2)
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'transport-session-1',
      'Try again',
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ promptMessageId: expect.any(String) }),
      false,
      undefined,
      undefined,
      true
    )
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      isPending: false,
      messages: [
        expect.objectContaining({
          id: first?.messageId,
          content: 'Help me inspect this notebook'
        }),
        expect.objectContaining({
          id: retry?.messageId,
          content: 'Try again'
        })
      ]
    })
  })

  it('refreshes the run subject when a pending session retry also fails', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi
        .fn()
        .mockRejectedValueOnce(new Error('First provider failed'))
        .mockRejectedValueOnce(new Error('Second provider failed'))
        .mockRejectedValueOnce(new Error('No provider selected')),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const first = await sendWorkspaceMessage(runtime, {
      text: 'Start with Claude',
      cwd: '/workspace/project',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic',
      agentModel: 'claude-opus-4'
    })
    await flushRuntimeTasks()

    await sendWorkspaceMessage(runtime, {
      sessionId: first?.sessionId,
      text: 'Retry with Codex',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.6-sol'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: first?.sessionId,
      isPending: true,
      status: 'error',
      error: 'Second provider failed',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription',
      agentModel: 'gpt-5.6-sol'
    })

    await sendWorkspaceMessage(runtime, {
      sessionId: first?.sessionId,
      text: 'Retry without a provider',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex'
    })
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      id: first?.sessionId,
      isPending: true,
      status: 'error',
      error: 'No provider selected',
      agentFrameworkId: 'codex'
    })
    expect(session.agentBackendId).toBeUndefined()
    expect(session.agentModel).toBeUndefined()
  })

  it('does not fall back to the runtime home directory when retrying managed workspace creation', async () => {
    const runtime = {
      state: { ...createSnapshot(), cwd: 'C:\\Users\\example' },
      createSession: vi.fn().mockResolvedValue(undefined),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const first = await sendWorkspaceMessage(runtime, {
      text: 'Clone the repository',
      projectId: 'project-1'
    })
    await flushRuntimeTasks()

    await sendWorkspaceMessage(runtime, {
      sessionId: first?.sessionId,
      text: 'Try again',
      projectId: 'project-1'
    })

    expect(runtime.createSession).toHaveBeenNthCalledWith(
      1,
      undefined,
      'project-1',
      'ask',
      undefined,
      undefined,
      true
    )
    expect(runtime.createSession).toHaveBeenNthCalledWith(
      2,
      undefined,
      'project-1',
      'ask',
      undefined,
      undefined,
      true
    )
  })

  it('does not submit another prompt for a session that already owns a run', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First prompt',
      cwd: '/workspace/project'
    })

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'Second prompt',
        cwd: '/workspace/project'
      })
    ).resolves.toBeUndefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('shows the Resume banner when a prompt fails during a live connection drop', async () => {
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi
            .fn()
            .mockResolvedValue({ ...createSnapshot(['session-1']), status: 'closed' })
        }
      }
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Connection timeout'))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'earlier turn',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'hello',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    // The specific failure cause is preserved in the Resume banner instead of a generic message.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true,
      error: 'Connection timeout — Resume to reconnect and continue.'
    })
  })

  it('shows a plain error, not the Resume banner, when a prompt fails but the connection is up', async () => {
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
        }
      }
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Invalid API key'))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'earlier turn',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'hello',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.interrupted).toBeFalsy()
    expect(session.error).toBe('Invalid API key')
  })

  it('uses the session owner status when a prompt fails on an old runtime', async () => {
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi.fn().mockResolvedValue({
            ...createSnapshot(['session-1']),
            status: 'connected',
            sessionConnectionStatuses: { 'session-1': 'closed' }
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Old runtime exited'))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true,
      error: 'Old runtime exited — Resume to reconnect and continue.'
    })
  })

  it('does not treat a healthy old runtime failure as an active runtime disconnect', async () => {
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi.fn().mockResolvedValue({
            ...createSnapshot(['session-1']),
            status: 'closed',
            sessionConnectionStatuses: { 'session-1': 'connected' }
          })
        }
      }
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Invalid API key'))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Invalid API key'
    })
    expect(useSessionStore.getState().sessions[0].interrupted).toBeFalsy()
  })

  it('marks a model-provider prompt failure non-reportable from the run error event', async () => {
    // The runtime pushes a providerError-tagged error event before rejecting; the rejection path reads
    // it from the snapshot so the failure is recorded non-reportable (no "Report error" button) without
    // guessing from the message text.
    const providerErrorEvent: AcpRuntimeEvent = {
      id: 'error-provider-1',
      timestamp: Date.now(),
      kind: 'error',
      level: 'error',
      sessionId: 'session-1',
      providerError: true,
      title: 'Prompt failed',
      text: 'Invalid API key'
    }
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi
            .fn()
            .mockResolvedValue({ ...createSnapshot(['session-1']), events: [providerErrorEvent] })
        }
      }
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Invalid API key'))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'earlier turn',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'hello',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.errorReportable).toBe(false)
  })

  it('marks an untagged (ACP-layer) prompt failure reportable', async () => {
    // No providerError tag on the run's error event → an app-layer failure the user should be able to
    // report as a bug.
    const acpErrorEvent: AcpRuntimeEvent = {
      id: 'error-acp-1',
      timestamp: Date.now(),
      kind: 'error',
      level: 'error',
      sessionId: 'session-1',
      title: 'Prompt failed',
      text: 'Something unexpected broke'
    }
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi
            .fn()
            .mockResolvedValue({ ...createSnapshot(['session-1']), events: [acpErrorEvent] })
        }
      }
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('Something unexpected broke'))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'earlier turn',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'hello',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.errorReportable).toBe(true)
  })

  it('uses fallback message when error is empty or whitespace-only', async () => {
    vi.stubGlobal('window', {
      api: {
        acp: {
          getState: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
        }
      }
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockRejectedValue(new Error('  '))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'earlier turn',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'hello',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('error')
    expect(session.interrupted).toBeFalsy()
    expect(session.error).toBe('Agent run failed')
  })

  it('blocks duplicate submits while adoption finishes before opening the restored run', async () => {
    const resumeCanFinish = createDeferred<{ sessionId: string; cwd?: string }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeCanFinish.promise),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    const preparationChanged = vi.fn()
    const first = sendWorkspaceMessage(
      runtime,
      {
        sessionId: 'session-1',
        text: 'Continue restored conversation',
        cwd: '/workspace/project'
      },
      { onSendPreparationStateChange: preparationChanged }
    )
    const second = sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Duplicate submit',
      cwd: '/workspace/project'
    })

    await expect(second).resolves.toBeUndefined()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      messages: [expect.objectContaining({ content: 'Previous prompt' })]
    })
    expect(runtime.resumeSession).toHaveBeenCalledTimes(1)
    expect(preparationChanged).toHaveBeenCalledWith('session-1', true)

    resumeCanFinish.resolve({ sessionId: 'session-1', cwd: '/workspace/project' })
    const firstResult = await first
    expect(firstResult).toMatchObject({ sessionId: 'session-1' })
    expect(preparationChanged).toHaveBeenLastCalledWith('session-1', false)
    expect(runtime.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('admits only one local user Message when two sends race an attached idle Session', async () => {
    vi.stubGlobal('window', {
      api: { acp: { getState: vi.fn().mockResolvedValue(createSnapshot(['session-1'])) } }
    })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('session-1')

    const firstGate = createDeferred<AcpStateSnapshot>()
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi
        .fn()
        .mockImplementationOnce(() => firstGate.promise)
        .mockRejectedValueOnce(new Error('An ACP prompt is already running for this session'))
    }

    const [first, second] = await Promise.all([
      sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'first',
        cwd: '/workspace/project',
        projectId: 'project-1'
      }),
      sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'second',
        cwd: '/workspace/project',
        projectId: 'project-1'
      })
    ])
    await flushRuntimeTasks()
    await flushRuntimeTasks()

    expect([first, second].filter(Boolean)).toHaveLength(1)
    const session = useSessionStore.getState().sessions[0]
    expect(
      session.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
    ).toEqual(['Previous prompt', first ? 'first' : 'second'])
    expect(session.status).not.toBe('error')
    firstGate.resolve(createSnapshot(['session-1']))
  })

  it('does not append a prompt while the runtime owns the session for compaction', async () => {
    const runtime = {
      state: {
        ...createSnapshot(['session-1']),
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1']
      },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')
    const messagesBeforeSend = useSessionStore.getState().sessions[0]?.messages

    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'Do not race compaction',
        cwd: '/workspace/project'
      })
    ).resolves.toBeUndefined()

    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(messagesBeforeSend)
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('fails the run with an actionable message when the resumed workspace folder is gone', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockRejectedValue(
          new Error('Invalid params: cwd does not exist on the machine running the agent: /gone')
        ),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Session workspace is missing; start a new conversation.'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('keeps the underlying cause visible when resume fails for an unexpected reason', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'acp:resume-session': Error: agent process crashed"
          )
        ),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })

    // The IPC wrapper is stripped and the real cause is appended rather than swallowed.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Agent session resume failed: agent process crashed'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a distinct message when the agent build cannot resume sessions', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockRejectedValue(new Error('ACP agent does not support session resume.')),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })
    await flushRuntimeTasks()

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'This agent build cannot resume sessions; start a new conversation.'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('softens the model↔framework incompatibility message instead of an alarming resume failure', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "The active model isn't compatible with Claude Code. Open Settings → Model to pick a compatible model or switch the agent framework."
          )
        ),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })

    // No "Agent session resume failed" prefix — the fix lives in settings, which now flags this early.
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error:
        "The active model isn't compatible with this agent framework. Open Settings → Model to pick a compatible model or switch frameworks."
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a distinct message when the agent connection cannot be re-established', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockRejectedValue(new Error('ACP connection failed')),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Could not reconnect to the agent; check it is installed, then click Resume to retry.'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })
})

describe('resuming an interrupted session on demand', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  // Seeds a restored interrupted session (detached from the runtime) via the hydration path, which
  // is what sets the `interrupted` flag in production. An empty cwd models a missing workspace.
  const seedDetachedSession = (cwd: string = '/workspace/project'): void => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'default-project',
        title: 'Interrupted',
        cwd,
        status: 'error',
        error: 'Session was interrupted before the app closed.',
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:codex-isolated',
        permissionProfile: 'ask',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
  }

  it('re-attaches a session with no recoverable user turn and unlocks the composer', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }
    seedDetachedSession()

    const agentTarget = {
      frameworkId: 'codex',
      providerId: 'codex-isolated',
      model: 'gpt-5',
      reasoningEffort: 'high'
    } as const
    await resumeInterruptedWorkspaceSession(runtime, 'session-1', undefined, {
      historyReplayDescriptor: { target: 'codex-bridge' },
      agentTarget
    })

    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      expect.any(String),
      'codex',
      'codex:codex-isolated',
      undefined,
      undefined,
      undefined,
      undefined,
      agentTarget,
      true
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
  })

  it('keeps the error visible so a retry stays possible when resume fails', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockRejectedValue(new Error('unexpected agent state')),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    seedDetachedSession()

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Agent session resume failed: unexpected agent state'
    })
  })

  it('just clears the banner without re-resuming an already-attached session', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    seedDetachedSession()

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
  })

  it('confirms pending denied authority before resuming the provider Session', async () => {
    seedDetachedSession()
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        delegationPolicy: 'deny' as const,
        delegationPolicyAuthorityPending: true
      }))
    }))
    const saveSession = vi.fn(async (session: PersistedChatSession) => session)
    const setDelegationPolicy = vi.fn(async () => {
      const session = useSessionStore.getState().sessions[0]
      return {
        ...toPersistedSession(session),
        revision: (session.revision ?? 0) + 1,
        delegationPolicy: 'deny' as const
      }
    })
    vi.stubGlobal('window', { api: { sessions: { saveSession, setDelegationPolicy } } })
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(setDelegationPolicy).toHaveBeenCalledWith('default-project', 'session-1', 'deny')
    expect(setDelegationPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.resumeSession.mock.invocationCallOrder[0]
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      delegationPolicy: 'deny',
      delegationPolicyAuthorityPending: undefined
    })
  })

  it('surfaces an actionable message when the session has no workspace to resume into', async () => {
    const runtime = {
      state: { ...createSnapshot(), cwd: '' },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    seedDetachedSession('')

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Session workspace is missing; start a new conversation.'
    })
  })

  it('flags a running session as disconnected when the connection drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Keep working',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    expect(useSessionStore.getState().sessions[0].status).toBe('running')

    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    const session = useSessionStore.getState().sessions[0]

    expect(session.status).toBe('error')
    expect(session.interrupted).toBe(true)
    expect(session.error).toBe('Connection lost — Resume to reconnect and continue.')
  })

  it('flags a compacting session as interrupted when the connection drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Keep the compacted context',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().beginCompaction('session-1')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: true
    })

    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true,
      compacting: undefined,
      error: 'Connection lost — Resume to reconnect and continue.'
    })
  })

  it('uses the owning runtime status instead of another generation global status', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Keep working',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })

    markRunningSessionsDisconnectedOnDrop(
      'connected',
      'connected',
      { 'session-1': 'connected' },
      { 'session-1': 'closed' }
    )

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true
    })
  })

  it('does not disconnect a running old-generation session when only the active runtime drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Keep working',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })

    markRunningSessionsDisconnectedOnDrop(
      'connected',
      'closed',
      { 'session-1': 'connected' },
      { 'session-1': 'connected' }
    )

    expect(useSessionStore.getState().sessions[0].status).toBe('running')
  })

  it('does not flag an idle session on drop so provider/skills reconnects stay silent', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'All done',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('keeps a durable user-choice wait actionable when the connection drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Help me choose',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().setElicitationPending('session-1', true)

    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('waiting-for-user')
    expect(session.interrupted).toBeUndefined()
  })

  it('keeps a durable permission wait actionable when the connection drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().setPermissionPending('session-1')

    markRunningSessionsDisconnectedOnDrop('connected', 'closed', {}, {}, new Set(['session-1']))

    const session = useSessionStore.getState().sessions[0]
    expect(session.status).toBe('waiting-permission')
    expect(session.interrupted).toBeUndefined()
  })

  it('interrupts a non-durable permission wait when the connection drops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Approve an in-memory action',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().setPermissionPending('session-1')

    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true
    })
  })

  it('reconnects and continues the interrupted turn without duplicating its user message', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue the analysis',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    const originalUserMessageId = useSessionStore.getState().sessions[0].messages[0].id
    // A live drop leaves the last user turn unanswered and flags the session for Resume.
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }
    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'default-project',
      promptMessageId: originalUserMessageId
    })

    const session = useSessionStore.getState().sessions[0]
    const userMessages = session.messages.filter((message) => message.role === 'user')

    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].id).toBe(originalUserMessageId)
    expect(userMessages[0].content).toBe('Continue the analysis')
    expect(userMessages[0].interrupted).toBe(true)
    expect(session.activeRun?.promptMessageId).toBe(originalUserMessageId)
    expect(session.interrupted).toBeUndefined()
  })

  it('continues an interrupted turn that is still attached without reconnecting', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue the attached turn',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    const originalUserMessageId = useSessionStore.getState().sessions[0].messages[0].id
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'default-project',
      promptMessageId: originalUserMessageId
    })
    const session = useSessionStore.getState().sessions[0]
    expect(session.activeRun?.promptMessageId).toBe(originalUserMessageId)
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('keeps recovery locked until stale renderer events are drained', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue after reconnecting',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const drainGate = createDeferred<void>()
    const drainRuntimeEvents = vi.fn(() => drainGate.promise)
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resumeRequest = resumeInterruptedWorkspaceSession(
      runtime,
      'session-1',
      drainRuntimeEvents
    )
    await vi.waitFor(() => expect(drainRuntimeEvents).toHaveBeenCalledWith('session-1'))

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      interrupted: true,
      resumeRecovery: expect.objectContaining({ promptMessageId: expect.any(String) })
    })
    expect(runtime.continueInterruptedTurn).not.toHaveBeenCalled()

    drainGate.resolve()
    await resumeRequest

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun: { promptMessageId: expect.any(String), startedAt: expect.any(Number) }
    })
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].resumeRecovery).toBeUndefined()
  })

  it('keeps recovery active until Main observes the provider first update', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue after provider acceptance',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    const originalMessageId = useSessionStore.getState().sessions[0].messages[0].id
    useSessionStore.getState().markDisconnected('session-1')

    const providerFirstUpdate = createDeferred<AcpStateSnapshot>()
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn(() => providerFirstUpdate.promise),
      sendPrompt: vi.fn()
    }

    const resumeRequest = resumeInterruptedWorkspaceSession(runtime, 'session-1', undefined, {
      flushPersistence: vi.fn().mockResolvedValue(undefined)
    })
    await vi.waitFor(() => expect(runtime.continueInterruptedTurn).toHaveBeenCalledOnce())

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      interrupted: true,
      resumeRecovery: { promptMessageId: originalMessageId }
    })
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({ id: originalMessageId, role: 'user', interrupted: true })
    ])

    providerFirstUpdate.resolve(createSnapshot(['session-1']))
    await resumeRequest

    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].resumeRecovery).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(1)
  })

  it('keeps the original turn retryable when continuation fails before provider acceptance', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Retry this continuation',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    const originalMessageId = useSessionStore.getState().sessions[0].messages[0].id
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi
        .fn()
        .mockRejectedValue(new Error('provider rejected continuation')),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1', undefined, {
      flushPersistence: vi.fn().mockResolvedValue(undefined)
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      interrupted: true,
      resumeRecovery: { promptMessageId: originalMessageId },
      error: 'Agent session resume failed: provider rejected continuation'
    })
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({
        id: originalMessageId,
        role: 'user',
        content: 'Retry this continuation',
        interrupted: true
      })
    ])
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not recreate an interrupted session deleted while reconnecting', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Do not resurrect this interrupted prompt',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const resumeGate = createDeferred<{ sessionId: string; cwd: string }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeGate.promise),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resumeRequest = resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await vi.waitFor(() => expect(runtime.resumeSession).toHaveBeenCalledOnce())

    useSessionStore.getState().deleteSession('session-1')
    resumeGate.resolve({ sessionId: 'session-1', cwd: '/workspace/project' })

    await resumeRequest

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).not.toHaveBeenCalled()
  })

  it('keeps recovery retryable and preserves the prompt when provider resume fails', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Do not lose this interrupted prompt',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const originalMessageId = useSessionStore.getState().sessions[0].messages[0].id
    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider resume failed'))
        .mockResolvedValueOnce({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({
        id: originalMessageId,
        content: 'Do not lose this interrupted prompt',
        interrupted: true
      })
    ])
    expect(session.interrupted).toBe(true)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledTimes(2)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    expect(
      useSessionStore.getState().sessions[0].messages.filter((message) => message.role === 'user')
    ).toEqual([expect.objectContaining({ content: 'Do not lose this interrupted prompt' })])
  })

  it('replays history while continuing the interrupted turn after fresh adoption', async () => {
    // A completed prior turn that must be replayed once the agent's context is gone.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Plot the sales data',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done, saved chart.png'
    })
    useSessionStore.getState().finishRun('session-1')
    // The interrupted turn: a user message the drop left unanswered.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'now add a trend line',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValueOnce({
          sessionId: 'session-1',
          cwd: '/workspace/project',
          contextReset: true
        })
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1', undefined, {
      historyReplayDescriptor: { target: 'codex-bridge' }
    })
    await flushRuntimeTasks()

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'default-project',
        promptMessageId: expect.any(String),
        contextReset: expect.objectContaining({ historyReplayTarget: 'codex-bridge' })
      })
    )
    expect(
      useSessionStore.getState().sessions[0].messages.filter((message) => message.role === 'user')
    ).toHaveLength(2)
  })

  it('retains fresh-adoption replay authority until the continuation is accepted', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Summarize the source material',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'The source material is summarized.'
    })
    useSessionStore.getState().finishRun('session-1')
    const interrupted = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Now compare the findings',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider rejected continuation'))
        .mockResolvedValueOnce(createSnapshot(['session-1'])),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      interrupted: true,
      resumeRecovery: { promptMessageId: interrupted?.messageId },
      pendingHistoryReplay: { kind: 'before-message', messageId: interrupted?.messageId }
    })
    const firstRuntimeSegmentId =
      runtime.continueInterruptedTurn.mock.calls[0]?.[0].contextReset?.runtimeSegmentId

    runtime.state = createSnapshot(['session-1'])
    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledTimes(2)
    expect(runtime.continueInterruptedTurn.mock.calls[1]?.[0].contextReset).toMatchObject({
      runtimeSegmentId: firstRuntimeSegmentId
    })
    expect(useSessionStore.getState().sessions[0].pendingHistoryReplay).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].resumeRecovery).toBeUndefined()
  })

  it('does not continue a recovery prompt removed while stale events are draining', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect the baseline data',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'The baseline is ready.'
    })
    useSessionStore.getState().finishRun('session-1')
    const interrupted = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Apply the original transformation',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const drainGate = createDeferred<void>()
    const drainRuntimeEvents = vi.fn(() => drainGate.promise)
    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resumeRequest = resumeInterruptedWorkspaceSession(
      runtime,
      'session-1',
      drainRuntimeEvents
    )
    await vi.waitFor(() => expect(drainRuntimeEvents).toHaveBeenCalledWith('session-1'))

    useSessionStore.getState().truncateSessionFromMessage('session-1', interrupted?.messageId ?? '')
    drainGate.resolve()
    await resumeRequest

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      pendingHistoryReplay: { kind: 'all' }
    })
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
  })

  it('replays full history after fresh adoption recovers an interrupted compaction', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Summarize the dataset',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'The dataset contains 20 samples.'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().beginCompaction('session-1')
    markRunningSessionsDisconnectedOnDrop('connected', 'closed')

    expect(useSessionStore.getState().sessions[0].resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'connection-lost'
    })

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(useSessionStore.getState().sessions[0].pendingHistoryReplay).toEqual({ kind: 'all' })
    runtime.state = createSnapshot(['session-1'])
    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Compare the sample groups',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    await flushRuntimeTasks()

    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Summarize the dataset')
    expect(preamble).toContain('The dataset contains 20 samples.')
    expect(preamble).not.toContain('Compare the sample groups')
    expect(runtime.sendPrompt.mock.calls[0]?.[10]).toBe(true)
    expect(useSessionStore.getState().sessions[0].pendingHistoryReplay).toBeUndefined()
  })

  it('continues a sole interrupted turn after fresh adoption', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the first notebook cell',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValueOnce({
          sessionId: 'session-1',
          cwd: '/workspace/project',
          contextReset: true
        })
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextReset: expect.objectContaining({ runtimeSegmentId: expect.any(String) })
      })
    )
    expect(
      useSessionStore.getState().sessions[0].messages.filter((message) => message.role === 'user')
    ).toHaveLength(1)
  })

  it('continues without history replay when the interrupted resume kept agent context', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier prompt',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Earlier answer'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'keep going',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      // The agent resumed its own session both times, so there is nothing to replay.
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot(['session-1'])),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(runtime.continueInterruptedTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ contextReset: expect.anything() })
    )
    expect(
      useSessionStore.getState().sessions[0].messages.filter((message) => message.role === 'user')
    ).toHaveLength(2)
  })

  it('replays a history preamble when a resume resets agent context', async () => {
    // A completed prior turn that should be replayed to the freshly-adopted agent.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Plot the sales data',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done, saved chart.png'
    })
    useSessionStore.getState().finishRun('session-1')

    const runtime = {
      // Empty sessionIds forces the resume path for this existing session.
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'now add a trend line',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledTimes(1)
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Plot the sales data')
    expect(preamble).toContain('Done, saved chart.png')
    // The preamble carries prior turns only; the turn being sent is not folded into it.
    expect(preamble).not.toContain('now add a trend line')
  })

  it('moves the next turn to the selected framework after the prior framework turn ends', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Analyze the data with Claude',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:anthropic'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Claude finished the analysis'
    })
    useSessionStore.getState().finishRun('session-1')

    const runtime = {
      // The retiring Claude runtime may still report the session until its deferred teardown finishes.
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex',
        backendId: 'codex:builtin-codex-subscription'
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue with Codex',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription'
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Analyze the data with Claude')
    expect(preamble).toContain('Claude finished the analysis')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription'
    })
    const switchedSession = useSessionStore.getState().sessions[0]
    const promptContext = runtime.sendPrompt.mock.calls[0]?.[9]
    const promptNode = switchedSession.conversationGraph?.messages.find(
      (message) => message.id === promptContext?.promptMessageId
    )
    const promptSegment = switchedSession.conversationGraph?.runtimeSegments.find(
      (segment) => segment.id === promptContext?.runtimeSegmentId
    )

    expect(promptSegment).toMatchObject({
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    })
    expect(promptNode?.runtimeSegmentId).toBe(promptContext?.runtimeSegmentId)
  })

  it('does not replay a history preamble when the resume kept agent context', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier prompt',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Earlier answer'
    })
    useSessionStore.getState().finishRun('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      // No contextReset flag: the agent resumed its own session, so nothing needs replaying.
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'keep going',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toBeUndefined()
  })

  it('resumes, resets image history, and replays only text for a model without image input', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect this image',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-image-1',
      eventId: 'image-event-1',
      image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    })
    useSessionStore.getState().finishRun('session-1')
    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        frameworkId: 'codex'
      }),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex'
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'default-project',
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.resetSessionContext.mock.invocationCallOrder[0]
    )
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('Inspect this image')
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].agentFrameworkId).toBe('codex')
  })

  it('does not reset image history when the attached text-only target is unchanged', async () => {
    const agentConfiguration = {
      providerId: 'provider-1',
      model: 'text-model',
      reasoningEffort: 'default'
    } as const
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect this image',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'text-model',
      agentConfiguration
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-image-1',
      eventId: 'image-event-1',
      image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    })
    useSessionStore.getState().finishRun('session-1')
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        frameworkId: 'codex',
        backendId: 'codex:provider-1'
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'text-model',
      agentConfiguration,
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'sends a %s follow-up on an attached Session without resuming when the explicit target is unchanged',
    async (frameworkId) => {
      const agentConfiguration = {
        providerId: 'provider-1',
        model: `${frameworkId}-model`,
        reasoningEffort: 'default'
      } as const
      const backendId = `${frameworkId}:provider-1`
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'First turn',
        cwd: '/workspace/project',
        projectId: 'default-project',
        agentFrameworkId: frameworkId,
        agentBackendId: backendId,
        agentModel: agentConfiguration.model,
        agentConfiguration
      })
      useSessionStore.getState().finishRun('session-1')
      const runtime = {
        state: createSnapshot(['session-1']),
        createSession: vi.fn(),
        resumeSession: vi
          .fn()
          .mockRejectedValue(
            new Error("Error invoking remote method 'acp:resume-session': reply was never sent")
          ),
        resetSessionContext: vi.fn(),
        sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
      }

      await sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'Send now follow-up',
        cwd: '/workspace/project',
        projectId: 'default-project',
        agentFrameworkId: frameworkId,
        agentBackendId: backendId,
        agentModel: agentConfiguration.model,
        agentConfiguration
      })
      await flushRuntimeTasks()

      expect(runtime.resumeSession).not.toHaveBeenCalled()
      expect(runtime.sendPrompt).toHaveBeenCalledOnce()
      expect(useSessionStore.getState().sessions[0].error).toBeUndefined()
      expect(useSessionStore.getState().sessions[0].status).toBe('running')
    }
  )

  it('resumes an unchanged target when its visible Session belongs to a retiring runtime', async () => {
    const agentConfiguration = {
      providerId: 'provider-1',
      model: 'codex-model',
      reasoningEffort: 'default'
    } as const
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First turn',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: agentConfiguration.model,
      agentConfiguration
    })
    useSessionStore.getState().finishRun('session-1')
    const runtime = {
      state: {
        ...createSnapshot(['session-1']),
        sessionResumeRequiredIds: ['session-1']
      },
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        frameworkId: 'codex',
        backendId: 'codex:provider-1'
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue after the generation switch',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: agentConfiguration.model,
      agentConfiguration
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('adopts an attached Session when only reasoning effort changed', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First turn',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'codex-model',
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'codex-model',
        reasoningEffort: 'default'
      }
    })
    useSessionStore.getState().finishRun('session-1')
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      frameworkId: 'codex',
      backendId: 'codex:provider-1'
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession,
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'retry at higher effort',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'codex-model',
      agentConfiguration: {
        providerId: 'provider-1',
        model: 'codex-model',
        reasoningEffort: 'high'
      }
    })
    await flushRuntimeTasks()

    expect(resumeSession).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('resets image history when an explicit model changes to the provider default', async () => {
    const previousConfiguration = {
      providerId: 'provider-1',
      model: 'vision-model',
      reasoningEffort: 'default'
    } as const
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect this image',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'vision-model',
      agentConfiguration: previousConfiguration
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-image-1',
      eventId: 'image-event-1',
      image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    })
    useSessionStore.getState().finishRun('session-1')
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        frameworkId: 'codex',
        backendId: 'codex:provider-1'
      }),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex',
        backendId: 'codex:provider-1'
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'text-default',
      agentConfiguration: {
        providerId: 'provider-1',
        reasoningEffort: 'default'
      },
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
  })

  it('does not replace a newer Session preference with a send-time snapshot', async () => {
    const snapshot = {
      providerId: 'provider-1',
      model: 'queued-model',
      reasoningEffort: 'default'
    } as const
    const preferred = {
      providerId: 'provider-1',
      model: 'preferred-model',
      reasoningEffort: 'high'
    } as const
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'First turn',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'queued-model',
      agentConfiguration: snapshot
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().setAgentConfiguration('session-1', preferred)
    const resumeSession = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      frameworkId: 'codex',
      backendId: 'codex:provider-1'
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession,
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'queued follow-up',
      cwd: '/workspace/project',
      projectId: 'default-project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:provider-1',
      agentModel: 'queued-model',
      agentConfiguration: snapshot,
      supportsImageInput: true
    })
    await flushRuntimeTasks()

    expect(resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      'codex',
      'codex:provider-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { frameworkId: 'codex', ...snapshot },
      true
    )
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].agentConfiguration).toEqual(preferred)
  })

  it('resets text-only context when replay budgeting omits an older image turn', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: `Original task ${'a'.repeat(500)}`,
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Middle image turn that should be omitted from the replay packet',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'omitted-image',
      eventId: 'omitted-image-event',
      image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: `Latest turn ${'b'.repeat(500)}`,
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().finishRun('session-1')

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        frameworkId: 'codex'
      }),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex'
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'default-project',
      supportsImageInput: false,
      historyReplayDescriptor: { target: 'codex-response', budget: 600 }
    })
    await flushRuntimeTasks()

    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).not.toContain('Middle image turn')
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
  })

  it('reconnects without re-sending when the last turn was already answered', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier prompt',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    // A completed assistant reply means the turn was answered before the drop.
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Here is the answer'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledTimes(1)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
  })
})

describe('recovering from a request-size overflow', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const seedOverflowedConversation = (
    includeHistoryImage = false,
    pdfContext?: SessionPdfContext,
    annotations?: ChatMessage['annotations']
  ): void => {
    // A completed prior turn (replayed as text) followed by the unanswered turn that overflowed.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Analyze the first screenshot',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Here is what it shows'
    })
    if (includeHistoryImage) {
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'session-1',
        streamId: 'assistant-image-1',
        eventId: 'image-event-1',
        image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
      })
    }
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'now compare with this new screenshot',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask',
      pdfContext,
      annotations
    })
    useSessionStore.getState().failRun('session-1', 'Request too large (max 32MB)')
  }

  it('keeps overflow dedup and Plan authority inside the lifecycle owner', async () => {
    seedOverflowedConversation()
    useSessionStore.getState().setActivePlanProjection('session-1', {
      artifactVersionId: 'plan-version-1',
      revision: 12,
      approval: 'approved',
      lifecycle: 'in_progress'
    } as never)
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }
    const owner = createWorkspaceRuntimeSessionLifecycleOwner()
    const overflowEvent = createEvent({
      id: 'owner-overflow-1',
      kind: 'error',
      level: 'error',
      recoverable: 'context-overflow',
      sessionId: 'session-1'
    })

    expect(Object.keys(owner)).toEqual([
      'recordPromptPlanAuthority',
      'processRuntimeEvents',
      'compact',
      'ensureReady',
      'reconfigureMemory',
      'resume',
      'cancel'
    ])
    owner.recordPromptPlanAuthority({
      sessionId: 'session-1',
      planContinuation: { artifactVersionId: 'plan-version-1', revision: 9 }
    })
    owner.processRuntimeEvents(runtime, [overflowEvent], {
      getAgentTarget: () => undefined,
      getSupportsImageInput: () => undefined,
      getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
    })
    owner.processRuntimeEvents(runtime, [overflowEvent], {
      getAgentTarget: () => undefined,
      getSupportsImageInput: () => undefined,
      getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
    })

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledTimes(1))
    expect(runtime.compactSession).toHaveBeenCalledTimes(1)
    expect(runtime.sendPrompt.mock.calls[0]?.[11]).toEqual({
      projectId: 'default-project',
      artifactVersionId: 'plan-version-1',
      expectedRevision: 12
    })
  })

  it('recovers overflow with the admitted Session target after a later Composer change', async () => {
    seedOverflowedConversation()
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }
    const owner = createWorkspaceRuntimeSessionLifecycleOwner()
    const admittedTarget = {
      frameworkId: 'codex' as const,
      providerId: 'admitted-provider',
      model: 'admitted-model',
      reasoningEffort: 'high' as const
    }
    owner.recordPromptPlanAuthority({
      sessionId: 'session-1',
      agentTarget: admittedTarget
    })
    owner.processRuntimeEvents(
      runtime,
      [
        createEvent({
          id: 'owner-overflow-admitted-target',
          kind: 'error',
          level: 'error',
          recoverable: 'context-overflow',
          sessionId: 'session-1'
        })
      ],
      {
        getAgentTarget: () => ({
          frameworkId: 'codex',
          providerId: 'later-provider',
          model: 'later-model',
          reasoningEffort: 'low'
        }),
        getSupportsImageInput: () => undefined,
        getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
      }
    )

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledTimes(1))
    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      admittedTarget,
      true
    )
  })

  it('recovers first-turn overflow with the admitted target after pending Session bind', async () => {
    useSessionStore.getState().appendPendingUserMessage({
      content: 'Analyze this notebook',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    const pendingSessionId = useSessionStore.getState().sessions[0]?.id
    expect(pendingSessionId).toBeDefined()
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }
    const owner = createWorkspaceRuntimeSessionLifecycleOwner()
    const admittedTarget = {
      frameworkId: 'codex' as const,
      providerId: 'admitted-provider',
      model: 'admitted-model',
      reasoningEffort: 'high' as const
    }
    owner.recordPromptPlanAuthority({
      sessionId: pendingSessionId,
      agentTarget: admittedTarget
    })
    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pendingSessionId!,
      sessionId: 'session-1',
      cwd: '/workspace/project'
    })
    owner.recordPromptPlanAuthority({
      sessionId: 'session-1',
      agentTarget: admittedTarget
    })
    owner.processRuntimeEvents(
      runtime,
      [
        createEvent({
          id: 'owner-overflow-pending-bind',
          kind: 'error',
          level: 'error',
          recoverable: 'context-overflow',
          sessionId: 'session-1'
        })
      ],
      {
        getAgentTarget: () => ({
          frameworkId: 'codex',
          providerId: 'later-provider',
          model: 'later-model',
          reasoningEffort: 'low'
        }),
        getSupportsImageInput: () => undefined,
        getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
      }
    )

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledTimes(1))
    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      admittedTarget,
      true
    )
  })

  it('drops admitted Session targets when the Session is deleted', async () => {
    seedOverflowedConversation()
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }
    const owner = createWorkspaceRuntimeSessionLifecycleOwner()
    owner.recordPromptPlanAuthority({
      sessionId: 'session-1',
      agentTarget: {
        frameworkId: 'codex',
        providerId: 'admitted-provider',
        model: 'admitted-model',
        reasoningEffort: 'high'
      }
    })
    useSessionStore.setState({ sessions: [] })
    owner.processRuntimeEvents(runtime, [], {
      getAgentTarget: () => undefined,
      getSupportsImageInput: () => undefined,
      getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
    })
    seedOverflowedConversation()
    const laterTarget = {
      frameworkId: 'codex' as const,
      providerId: 'later-provider',
      model: 'later-model',
      reasoningEffort: 'low' as const
    }
    owner.processRuntimeEvents(
      runtime,
      [
        createEvent({
          id: 'owner-overflow-after-delete',
          kind: 'error',
          level: 'error',
          recoverable: 'context-overflow',
          sessionId: 'session-1'
        })
      ],
      {
        getAgentTarget: () => laterTarget,
        getSupportsImageInput: () => undefined,
        getHistoryReplayDescriptor: () => ({ target: 'codex-bridge' })
      }
    )

    await vi.waitFor(() => expect(runtime.sendPrompt).toHaveBeenCalledTimes(1))
    expect(runtime.resumeSession.mock.calls.at(-1)?.at(-2)).toEqual(laterTarget)
    expect(runtime.resumeSession.mock.calls.at(-1)?.at(-1)).toBe(true)
  })

  it('persists the reset provider identity and re-sends the failed turn with a text preamble', async () => {
    vi.stubGlobal('window', {
      api: { acp: { getState: vi.fn().mockResolvedValue(createSnapshot(['session-1'])) } }
    })
    seedOverflowedConversation(true)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'claude-code',
        agentBackendId: 'claude-code:old',
        providerSessionId: 'provider-session-old',
        providerContinuityToken: 'continuity-old'
      }))
    }))

    const runtime = {
      state: {
        ...createSnapshot(['session-1']),
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1']
      },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true,
        frameworkId: 'codex' as const,
        backendId: 'codex:new',
        providerSessionId: 'provider-session-new',
        providerContinuityToken: 'continuity-new'
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const agentTarget = {
      frameworkId: 'codex',
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'high'
    } as const
    const recovered = await recoverContextOverflowWorkspaceSession(
      runtime,
      'session-1',
      false,
      undefined,
      undefined,
      undefined,
      agentTarget
    )
    await flushRuntimeTasks()

    expect(recovered).toBe(true)
    expect(runtime.resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      true
    )
    // The unanswered turn is re-sent (not duplicated) with the prior turn replayed as a text preamble.
    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toBe('now compare with this new screenshot')
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Analyze the first screenshot')
    expect(preamble).toContain('Here is what it shows')
    expect(preamble).not.toContain('now compare with this new screenshot')
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      'codex',
      'codex:new',
      undefined,
      'provider-session-new',
      'continuity-new',
      undefined,
      agentTarget,
      true
    )
    expect(toPersistedSession(useSessionStore.getState().sessions[0])).toMatchObject({
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:new',
      providerSessionId: 'provider-session-new',
      providerContinuityToken: 'continuity-new'
    })
  })

  it('does not retry a hidden Save as skill control as an ordinary prompt', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Analyze the conversation',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Analysis complete'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Evaluate this conversation for a reusable skill.',
      turnIntent: 'save-as-skill'
    })
    useSessionStore.getState().failRun('session-1', 'Request too large (max 32MB)')

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    expect(await recoverContextOverflowWorkspaceSession(runtime, 'session-1')).toBe(false)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      turnIntent: 'save-as-skill'
    })
  })

  it('uses native framework compaction and retries without replaying app-owned history', async () => {
    seedOverflowedConversation()
    const staleNativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...staleNativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: staleNativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(recovered).toBe(true)
    expect(runtime.compactSession).toHaveBeenCalledWith('session-1', 'overflow-recovery')
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toBe('now compare with this new screenshot')
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toBeUndefined()
  })

  it('preserves linked PDF context when retrying after compaction', async () => {
    const pdfContext = {
      version: 1 as const,
      bindings: [
        {
          version: 1 as const,
          bindingId: 'binding-1',
          sourceKind: 'artifact-version' as const,
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf' as const,
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }
    seedOverflowedConversation(false, pdfContext)
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    expect(await recoverContextOverflowWorkspaceSession(runtime, 'session-1')).toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[4]).toEqual([
      expect.objectContaining({
        id: 'artifact-1',
        source: 'artifact',
        versionId: 'version-1',
        mimeType: 'application/pdf'
      })
    ])
    expect(useSessionStore.getState().sessions[0]?.messages.at(-1)?.pdfContext).toEqual(pdfContext)
  })

  it('preserves PDF region Evidence when retrying after compaction', async () => {
    const annotation = {
      id: 'pdf-region-1',
      kind: 'pdf' as const,
      target: 'agent' as const,
      source: {
        kind: 'upload-version' as const,
        projectId: 'default-project',
        sessionId: 'session-1',
        versionId: 'version-1',
        name: 'paper.pdf',
        path: 'upload-version:default-project/session-1/version-1',
        checksum: 'a'.repeat(64)
      },
      selector: {
        kind: 'region' as const,
        pageNumber: 2,
        rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
        pageRotation: 0,
        image: { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }
      }
    }
    seedOverflowedConversation(false, undefined, [annotation])
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    expect(await recoverContextOverflowWorkspaceSession(runtime, 'session-1', true)).toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toContain('"type":"pdf-region"')
    expect(runtime.sendPrompt.mock.calls[0]?.[15]).toEqual([
      { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
    expect(useSessionStore.getState().sessions[0]?.messages.at(-1)?.annotations).toEqual([
      annotation
    ])
  })

  it('does not synthesize Plan authority when an unrelated message overflows', async () => {
    seedOverflowedConversation()
    useSessionStore.getState().setActivePlanProjection('session-1', {
      artifactVersionId: 'plan-version-1',
      revision: 9,
      approval: 'approved',
      lifecycle: 'blocked'
    } as never)
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    expect(await recoverContextOverflowWorkspaceSession(runtime, 'session-1')).toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[11]).toBeUndefined()
  })

  it('refreshes explicit Plan authority after a step update advances the revision', async () => {
    seedOverflowedConversation()
    useSessionStore.getState().setActivePlanProjection('session-1', {
      artifactVersionId: 'plan-version-1',
      revision: 12,
      approval: 'approved',
      lifecycle: 'in_progress'
    } as never)
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(compactedSnapshot),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    expect(
      await recoverContextOverflowWorkspaceSession(
        runtime,
        'session-1',
        undefined,
        undefined,
        undefined,
        {
          artifactVersionId: 'plan-version-1',
          revision: 9
        }
      )
    ).toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[11]).toEqual({
      projectId: 'default-project',
      artifactVersionId: 'plan-version-1',
      expectedRevision: 12
    })
  })

  it('converts a restored approval action to current approved authority on overflow', async () => {
    seedOverflowedConversation()
    useSessionStore.getState().setActivePlanProjection('session-1', {
      artifactVersionId: 'plan-version-1',
      revision: 9,
      approval: 'pending',
      lifecycle: 'awaiting_approval'
    } as never)
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const compactedSnapshot = {
      ...nativeSnapshot,
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockImplementation(async () => {
        useSessionStore.getState().setActivePlanProjection('session-1', {
          artifactVersionId: 'plan-version-1',
          revision: 10,
          approval: 'approved',
          lifecycle: 'approved'
        } as never)
        return compactedSnapshot
      }),
      sendPrompt: vi.fn().mockResolvedValue(compactedSnapshot)
    }

    expect(
      await recoverContextOverflowWorkspaceSession(
        runtime,
        'session-1',
        undefined,
        undefined,
        undefined,
        {
          artifactVersionId: 'plan-version-1',
          revision: 9,
          pendingAction: 'approve'
        }
      )
    ).toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[11]).toEqual({
      projectId: 'default-project',
      artifactVersionId: 'plan-version-1',
      expectedRevision: 10
    })
  })

  it('preserves the failed turn when compaction still reports runtime ownership', async () => {
    seedOverflowedConversation()
    const prematureSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    }
    const runtime = {
      state: prematureSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(prematureSnapshot),
      sendPrompt: vi.fn()
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')

    expect(recovered).toBe(false)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.messages.at(-1)?.content).toBe(
      'now compare with this new screenshot'
    )
  })

  it('falls back to context reset and history replay when native compaction fails', async () => {
    seedOverflowedConversation()
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(undefined),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      sendPrompt: vi.fn().mockResolvedValue(nativeSnapshot)
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(recovered).toBe(true)
    expect(runtime.compactSession).toHaveBeenCalledWith('session-1', 'overflow-recovery')
    expect(runtime.resetSessionContext).toHaveBeenCalledTimes(1)
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('Analyze the first screenshot')
  })

  it('does not reset or retry after native overflow recovery is cancelled', async () => {
    seedOverflowedConversation()
    const cancelledSessionIds = new Set<string>()
    const nativeSnapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    const runtime = {
      state: nativeSnapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      compactSession: vi.fn().mockImplementation(async () => {
        cancelledSessionIds.add('session-1')
        // Main treats the cancelled native control turn as a benign terminal response and the
        // coordinator therefore still returns a snapshot. Cancellation intent, not falsiness,
        // must prevent reset-and-retry.
        return nativeSnapshot
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const recovered = await recoverContextOverflowWorkspaceSession(
      runtime,
      'session-1',
      undefined,
      cancelledSessionIds
    )

    expect(recovered).toBe(false)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: undefined
    })
    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.content).toBe(
      'now compare with this new screenshot'
    )
  })

  it('keeps the error visible when the context reset itself fails', async () => {
    seedOverflowedConversation()

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockRejectedValue(new Error('ACP connection failed')),
      sendPrompt: vi.fn()
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')

    expect(recovered).toBe(false)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.status).toBe('error')
  })

  it('restores the overflowed user turn when retry preparation fails', async () => {
    seedOverflowedConversation()

    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockRejectedValue(new Error('adoption failed')),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      sendPrompt: vi.fn()
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')

    expect(recovered).toBe(false)
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'now compare with this new screenshot'
        })
      ])
    )
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('triggers recovery once per overflow error event for an attached session', () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const recover = vi.fn().mockResolvedValue(true)
    const handled = new Set<string>()
    const cooldown = new Set<string>()
    const active = new Set<string>()
    const event = createEvent({
      id: 'overflow-1',
      kind: 'error',
      level: 'error',
      sessionId: 'session-1',
      title: 'Prompt failed',
      text: 'Internal error: Request too large (max 32MB).'
    })

    processContextOverflowRecovery(runtime, [event], handled, cooldown, active, recover)
    // A repeated snapshot delivering the same event must not recover twice.
    processContextOverflowRecovery(runtime, [event], handled, cooldown, active, recover)

    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(runtime, 'session-1')
  })

  it('tracks only the live recovery separately from the cooldown', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    let finishRecovery!: () => void
    const recovery = new Promise<boolean>((resolve) => {
      finishRecovery = () => resolve(true)
    })
    const recover = vi.fn().mockReturnValue(recovery)
    const cooldown = new Set<string>()
    const active = new Set<string>()

    processContextOverflowRecovery(
      runtime,
      [
        createEvent({
          id: 'overflow-live',
          kind: 'error',
          level: 'error',
          sessionId: 'session-1',
          recoverable: 'context-overflow'
        })
      ],
      new Set(),
      cooldown,
      active,
      recover
    )

    expect(active).toEqual(new Set(['session-1']))
    finishRecovery()
    await recovery
    await Promise.resolve()

    expect(active).toEqual(new Set())
    expect(cooldown).toEqual(new Set(['session-1']))
  })

  it('triggers recovery from the recoverable marker even when the message does not match', () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const recover = vi.fn().mockResolvedValue(true)
    const event = createEvent({
      id: 'overflow-marker',
      kind: 'error',
      level: 'error',
      recoverable: 'context-overflow',
      sessionId: 'session-1',
      // An opaque wrapped message the text classifier would miss; the marker still drives recovery.
      text: 'Internal error: -32603'
    })

    processContextOverflowRecovery(runtime, [event], new Set(), new Set(), new Set(), recover)

    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('ignores non-overflow errors, detached sessions, and sessions already recovering', () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const recover = vi.fn().mockResolvedValue(true)

    // An unrelated turn-level error is not a size overflow.
    processContextOverflowRecovery(
      runtime,
      [
        createEvent({
          id: 'e1',
          kind: 'error',
          level: 'error',
          sessionId: 'session-1',
          text: 'gateway 502'
        })
      ],
      new Set(),
      new Set(),
      new Set(),
      recover
    )
    // A detached session goes through the normal Resume path, not auto-recovery.
    processContextOverflowRecovery(
      runtime,
      [
        createEvent({
          id: 'e2',
          kind: 'error',
          level: 'error',
          sessionId: 'other-session',
          text: 'Request too large'
        })
      ],
      new Set(),
      new Set(),
      new Set(),
      recover
    )
    // A session already within its recovery cooldown is skipped.
    processContextOverflowRecovery(
      runtime,
      [
        createEvent({
          id: 'e3',
          kind: 'error',
          level: 'error',
          sessionId: 'session-1',
          text: 'Request too large'
        })
      ],
      new Set(),
      new Set(['session-1']),
      new Set(),
      recover
    )

    expect(recover).not.toHaveBeenCalled()
  })
})

describe('manual native context compaction', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Preserve this conversation',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')
  })

  it('invokes the attached framework capability without rewriting local messages', async () => {
    const snapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(snapshot),
      sendPrompt: vi.fn()
    }
    const before = useSessionStore.getState().sessions[0].messages

    await expect(compactWorkspaceSession(runtime, 'session-1')).resolves.toBe(true)

    expect(runtime.compactSession).toHaveBeenCalledWith('session-1')
    expect(useSessionStore.getState().sessions[0].messages).toEqual(before)
  })

  it('acquires a local compaction lock before the runtime snapshot returns', async () => {
    const snapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    let finishCompaction!: (value: AcpStateSnapshot) => void
    const pendingCompaction = new Promise<AcpStateSnapshot>((resolve) => {
      finishCompaction = resolve
    })
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockReturnValue(pendingCompaction),
      sendPrompt: vi.fn()
    }
    const messageCount = useSessionStore.getState().sessions[0].messages.length

    const compacting = compactWorkspaceSession(runtime, 'session-1')

    expect(useSessionStore.getState().sessions[0].compacting).toBe(true)
    await expect(
      sendWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        text: 'do not append while compacting',
        cwd: '/workspace/project'
      })
    ).resolves.toBeUndefined()
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(messageCount)

    finishCompaction(snapshot)
    await expect(compacting).resolves.toBe(true)
    expect(useSessionStore.getState().sessions[0].compacting).toBeUndefined()
  })

  it('surfaces a session failure when compaction returns no runtime snapshot', async () => {
    const snapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn().mockResolvedValue(undefined),
      sendPrompt: vi.fn()
    }

    await expect(compactWorkspaceSession(runtime, 'session-1')).resolves.toBe(false)

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Context compaction failed.',
      compacting: undefined
    })
  })

  it('refuses sessions whose framework does not expose native compaction', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn(),
      sendPrompt: vi.fn()
    }

    await expect(compactWorkspaceSession(runtime, 'session-1')).resolves.toBe(false)
    expect(runtime.compactSession).not.toHaveBeenCalled()
  })

  it('refuses manual compaction for an errored session without clearing its failure', async () => {
    useSessionStore.getState().failRun('session-1', 'Preserve this failure')
    const snapshot = {
      ...createSnapshot(['session-1']),
      nativeContextCompactionSessionIds: ['session-1']
    }
    const runtime = {
      state: snapshot,
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      compactSession: vi.fn(),
      sendPrompt: vi.fn()
    }

    await expect(compactWorkspaceSession(runtime, 'session-1')).resolves.toBe(false)

    expect(runtime.compactSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Preserve this failure',
      compacting: undefined
    })
  })

  it('keeps the local compaction lock until cancellation reaches a terminal response', async () => {
    useSessionStore.getState().beginCompaction('session-1')
    const cancelledSessionIds = new Set<string>()
    const runtime = { cancel: vi.fn().mockResolvedValue(createSnapshot(['session-1'])) }

    await cancelWorkspaceRun(runtime, 'session-1', cancelledSessionIds)

    expect(runtime.cancel).toHaveBeenCalledWith('session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      compacting: true
    })
    expect(cancelledSessionIds).toEqual(new Set(['session-1']))
  })

  it('rejects when runtime cancellation returns no terminal snapshot', async () => {
    const runtime = { cancel: vi.fn().mockResolvedValue(undefined) }

    await expect(cancelWorkspaceRun(runtime, 'session-1')).rejects.toThrow(
      'Agent cancellation failed'
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      error: 'Agent cancellation failed'
    })
  })
})

describe('resendEditedWorkspaceMessage', () => {
  const baseTime = 1710000000000

  const createMessage = (
    id: string,
    role: 'user' | 'agent',
    content: string,
    createdAt: number,
    overrides: Partial<ChatMessage> = {}
  ): ChatMessage => ({
    id,
    role,
    content,
    status: 'complete' as const,
    eventIds: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides
  })

  const seedConversation = (): void => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', 'first prompt', baseTime),
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200),
            createMessage('agent-2', 'agent', 'second answer', baseTime + 300),
            createMessage('user-3', 'user', 'third prompt', baseTime + 400)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 400
        }
      ],
      selectedSessionId: 'session-1'
    })
  }

  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adopts the selected runtime before resetting and opening the edited run', async () => {
    seedConversation()
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'claude-code',
        agentBackendId: 'claude-code:anthropic'
      }))
    }))

    const resumeGate = createDeferred<{
      sessionId: string
      cwd: string
      contextReset: boolean
      frameworkId: 'codex'
      backendId: string
    }>()
    const resetGate = createDeferred<{ sessionId: string; cwd: string; contextReset: boolean }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeGate.promise),
      resetSessionContext: vi.fn(() => resetGate.promise),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }
    const preparationChanged = vi.fn()
    const drainRuntimeEvents = vi.fn().mockResolvedValue(undefined)
    const originalMessages = useSessionStore.getState().sessions[0]?.messages

    const resentPromise = resendEditedWorkspaceMessage(
      runtime,
      {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'second prompt, edited'
      },
      {
        supportsImageInput: true,
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:builtin-codex-subscription',
        onSendPreparationStateChange: preparationChanged,
        drainRuntimeEvents
      }
    )

    await vi.waitFor(() => expect(runtime.resumeSession).toHaveBeenCalledOnce())
    expect(preparationChanged).toHaveBeenCalledWith('session-1', true)
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(originalMessages)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()

    resumeGate.resolve({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      contextReset: false,
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    })
    await vi.waitFor(() => expect(runtime.resetSessionContext).toHaveBeenCalledOnce())
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(originalMessages)
    expect(preparationChanged).not.toHaveBeenCalledWith('session-1', false)

    resetGate.resolve({ sessionId: 'session-1', cwd: '/workspace/project', contextReset: true })
    await expect(resentPromise).resolves.toBe(true)

    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
    expect(runtime.resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      true
    )
    expect(drainRuntimeEvents).toHaveBeenCalledOnce()
    expect(preparationChanged).toHaveBeenLastCalledWith('session-1', false)
    expect(
      useSessionStore.getState().sessions[0]?.messages.map((message) => message.content)
    ).toEqual(['first prompt', 'first answer', 'second prompt, edited'])
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('does not truncate or recreate an edited session deleted during adoption', async () => {
    seedConversation()
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentFrameworkId: 'claude-code',
        agentBackendId: 'claude-code:anthropic'
      }))
    }))

    const resumeGate = createDeferred<{
      sessionId: string
      cwd: string
      contextReset: boolean
      frameworkId: 'codex'
      backendId: string
    }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeGate.promise),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const truncate = vi.spyOn(useSessionStore.getState(), 'truncateSessionFromMessage')
    const append = vi.spyOn(useSessionStore.getState(), 'appendUserMessage')

    const resent = resendEditedWorkspaceMessage(
      runtime,
      {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'second prompt, edited'
      },
      {
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:builtin-codex-subscription'
      }
    )
    await vi.waitFor(() => expect(runtime.resumeSession).toHaveBeenCalledOnce())

    useSessionStore.getState().deleteSession('session-1')
    resumeGate.resolve({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      contextReset: true,
      frameworkId: 'codex',
      backendId: 'codex:builtin-codex-subscription'
    })

    await expect(resent).resolves.toBe(false)
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(truncate).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('opens the resent run after reset, then replays the kept history', async () => {
    seedConversation()

    const resetGate = createDeferred<{ sessionId: string; cwd: string; contextReset: boolean }>()
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(() => resetGate.promise),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resentPromise = resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: 'second prompt, edited',
      parts: [{ type: 'text', text: 'second prompt, edited' }],
      forcedSkillIds: ['skill-forecast'],
      referencedArtifacts: []
    })
    await flushRuntimeTasks()

    // Keep the existing Branch visible until reset succeeds so a terminal event from the prior
    // runtime cannot settle the edited run.
    const duringReset = useSessionStore.getState().sessions[0]
    expect(duringReset?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'agent-2',
      'user-3'
    ])
    expect(duringReset?.status).toBe('idle')
    expect(duringReset?.activeRun).toBeUndefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    resetGate.resolve({ sessionId: 'session-1', cwd: '/workspace/project', contextReset: true })
    const resent = await resentPromise
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(runtime.resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask',
      true
    )

    // The kept turns replay as a text preamble (the edited turn is not duplicated into it), and the
    // picked skill goes out as a forced skill on the resent prompt.
    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toBe('second prompt, edited')
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('first prompt')
    expect(preamble).toContain('first answer')
    expect(preamble).not.toContain('second prompt')
    expect(preamble).not.toContain('third prompt')
    expect(runtime.sendPrompt.mock.calls[0]?.[3]).toEqual(['skill-forecast'])
  })

  it('routes a cross-session source Upload Version as a current attachment after branching', async () => {
    const sourceUpload = {
      id: 'upload-source',
      versionId: 'upload-version-source',
      versionNumber: 1,
      sessionId: 'source-session',
      name: 'measurements.csv',
      originalName: 'measurements.csv',
      mimeType: 'text/csv',
      size: 24,
      sha256: 'source-checksum'
    }
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', 'first prompt', baseTime),
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200, {
              uploads: [sourceUpload]
            }),
            createMessage('agent-2', 'agent', 'second answer', baseTime + 300)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 300
        }
      ],
      selectedSessionId: 'session-1'
    })
    const finalizeSession = vi.fn(
      async ({ attachments }: FinalizeUploadSessionRequest) => attachments
    )
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: 'second prompt, edited'
    })
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(finalizeSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        id: 'upload-source',
        versionId: 'upload-version-source',
        path: 'upload-version:default-project/source-session/upload-source/upload-version-source'
      })
    ])
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()

    const editedSession = useSessionStore.getState().sessions[0]
    expect(editedSession.messages.at(-1)).toMatchObject({
      content: 'second prompt, edited',
      uploads: [expect.objectContaining({ versionId: 'upload-version-source' })]
    })
    expect(
      editedSession.conversationGraph?.messages.find((message) => message.id === 'user-2')?.uploads
    ).toEqual([expect.objectContaining({ versionId: 'upload-version-source' })])
    expect(editedSession.conversationGraph?.branches).toHaveLength(2)
  })

  it('keeps edited attachments newest within the Composer replay limit', async () => {
    const versionedUpload = (id: string): NonNullable<ChatMessage['uploads']>[number] => ({
      id,
      versionId: `${id}-version`,
      versionNumber: 1,
      sessionId: 'source-session',
      name: `${id}.txt`,
      originalName: `${id}.txt`,
      mimeType: 'text/plain',
      size: 24
    })
    const historyUploads = Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, (_, index) =>
      versionedUpload(`history-${index}`)
    )
    const editedUploads = [versionedUpload('edited-0'), versionedUpload('edited-1')]
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', 'first prompt', baseTime, {
              uploads: historyUploads
            }),
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200, {
              uploads: editedUploads
            }),
            createMessage('agent-2', 'agent', 'second answer', baseTime + 300)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 300
        }
      ],
      selectedSessionId: 'session-1'
    })
    vi.stubGlobal('window', { api: { uploads: { finalizeSession: vi.fn() } } })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await expect(
      resendEditedWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'second prompt, edited'
      })
    ).resolves.toBe(true)
    await flushRuntimeTasks()

    expect(
      runtime.sendPrompt.mock.calls[0]?.[2]?.map((attachment: UploadedAttachment) => attachment.id)
    ).toEqual(['edited-0', 'edited-1'])
    expect(
      runtime.sendPrompt.mock.calls[0]?.[6]?.map((attachment: UploadedAttachment) => attachment.id)
    ).toEqual([
      'history-2',
      'history-3',
      'history-4',
      'history-5',
      'history-6',
      'history-7',
      'history-8',
      'history-9'
    ])
    const editedSession = useSessionStore.getState().sessions[0]
    expect(editedSession.messages.at(-1)?.uploads).toHaveLength(editedUploads.length)
    const activeFrame = editedSession.conversationGraph?.frames.find(
      (frame) => frame.id === editedSession.conversationGraph?.activeFrameId
    )
    const activeBranch = editedSession.conversationGraph?.branches.find(
      (branch) => branch.id === activeFrame?.activeBranchId
    )
    const activeHead = editedSession.conversationGraph?.messages.find(
      (message) => message.id === activeBranch?.headMessageId
    )
    expect(activeHead).toMatchObject({
      content: 'second prompt, edited',
      uploads: editedUploads
    })
  })

  it('filters edited image uploads for a text-only runtime without a Vision relay', async () => {
    const versionedUpload = (
      id: string,
      name: string,
      mimeType: string
    ): NonNullable<ChatMessage['uploads']> => [
      {
        id,
        versionId: `${id}-version`,
        versionNumber: 1,
        sessionId: 'source-session',
        name,
        originalName: name,
        mimeType,
        size: 24
      }
    ]
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', 'first prompt', baseTime),
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200, {
              uploads: [
                ...versionedUpload('photo', 'photo.png', 'application/octet-stream'),
                ...versionedUpload('notes', 'notes.txt', 'text/plain')
              ]
            })
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })
    vi.stubGlobal('window', { api: { uploads: { finalizeSession: vi.fn() } } })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await expect(
      resendEditedWorkspaceMessage(
        runtime,
        { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
        { supportsImageInput: false }
      )
    ).resolves.toBe(true)
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ id: 'notes', name: 'notes.txt' })
    ])
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.uploads).toHaveLength(2)
  })

  it('upgrades a legacy source upload before cutting the edited Branch', async () => {
    const legacyUpload = {
      id: 'legacy-upload',
      sessionId: 'source-session',
      name: 'legacy.csv',
      originalName: 'legacy.csv',
      path: '/legacy/session-1/legacy.csv',
      mimeType: 'text/csv',
      size: 18,
      checksum: 'legacy-checksum'
    }
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', 'first prompt', baseTime),
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200, {
              uploads: [legacyUpload]
            }),
            createMessage('agent-2', 'agent', 'second answer', baseTime + 300)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 300
        }
      ],
      selectedSessionId: 'session-1'
    })
    const finalizeSession = vi.fn(async ({ attachments }: FinalizeUploadSessionRequest) => [
      {
        ...attachments[0],
        versionId: 'legacy-upload-version-1',
        versionNumber: 1,
        path: '/durable/legacy-upload-version-1/content',
        checksum: 'legacy-checksum'
      }
    ])
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await expect(
      resendEditedWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'second prompt, edited'
      })
    ).resolves.toBe(true)
    await flushRuntimeTasks()

    expect(finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'source-session' })
    )
    expect(runtime.sendPrompt.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ versionId: 'legacy-upload-version-1' })
    ])
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()

    const editedSession = useSessionStore.getState().sessions[0]
    const originalRevision = editedSession.conversationGraph?.messages.find(
      (message) => message.id === 'user-2'
    )
    expect(originalRevision?.uploads).toEqual([
      expect.objectContaining({ versionId: 'legacy-upload-version-1' })
    ])
    expect(originalRevision?.uploads?.[0]).not.toHaveProperty('path')
    expect(editedSession.messages.at(-1)?.uploads).toEqual([
      expect.objectContaining({ versionId: 'legacy-upload-version-1' })
    ])
  })

  it('keeps the original Branch intact when source attachment finalization is incomplete', async () => {
    seedConversation()
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === 'user-2'
            ? {
                ...message,
                uploads: [
                  {
                    id: 'upload-source',
                    sessionId: 'session-1',
                    name: 'measurements.csv',
                    originalName: 'measurements.csv',
                    path: '/legacy/session-1/measurements.csv',
                    mimeType: 'text/csv',
                    size: 24,
                    checksum: 'source-checksum'
                  }
                ]
              }
            : message
        )
      }))
    }))
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession: vi.fn().mockResolvedValue([]) }
      }
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn()
    }
    const originalMessageIds = useSessionStore.getState().sessions[0].messages.map(({ id }) => id)

    await expect(
      resendEditedWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'second prompt, edited'
      })
    ).resolves.toBe(false)

    expect(useSessionStore.getState().sessions[0].messages.map(({ id }) => id)).toEqual(
      originalMessageIds
    )
    expect(useSessionStore.getState().sessions[0].conversationGraph?.branches).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].error).toContain(
      'Upload finalization did not return the attachment: upload-source'
    )
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('keeps the transcript intact when the context reset fails', async () => {
    seedConversation()

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockRejectedValue(new Error('ACP connection failed')),
      sendPrompt: vi.fn()
    }

    const resent = await resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: 'second prompt, edited'
    })

    expect(resent).toBe(false)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'agent-2',
      'user-3'
    ])
    expect(useSessionStore.getState().sessions[0]?.status).toBe('error')
  })

  it('refuses an edited resend before truncating while runtime compaction is in flight', async () => {
    seedConversation()

    const runtime = {
      state: {
        ...createSnapshot(['session-1']),
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1']
      },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const messagesBeforeResend = useSessionStore.getState().sessions[0]?.messages

    const resent = await resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: 'second prompt, edited'
    })

    expect(resent).toBe(false)
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(messagesBeforeResend)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('omits agent images when resending an edit into a text-only model', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              images: [{ id: 'img-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: false }
    )
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('first prompt')
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.messages.slice(0, 2).map((message) => message.id)).toEqual([
      'user-1',
      'agent-1'
    ])
    expect(session?.messages.at(-1)?.content).toBe('second prompt, edited')
    expect(session?.error).toBeUndefined()
  })

  it('replays original session images when a text-only model has a Vision relay', async () => {
    const originalImage = {
      id: 'img-1',
      mimeType: 'image/png' as const,
      data: 'AQID',
      byteLength: 3
    }
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              images: [originalImage]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: true }
    )
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toEqual([
      { ...originalImage, sourceMessageId: 'user-1', sourceImageId: 'img-1' }
    ])
    expect(useSessionStore.getState().sessions[0].messages[0].images).toEqual([originalImage])
  })

  it('classifies generic image uploads by extension before a text-only edited resend', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              uploads: [
                createAttachment({
                  id: 'photo',
                  name: 'photo.png',
                  mimeType: 'application/octet-stream'
                }),
                createAttachment({ id: 'notes', name: 'notes.txt', mimeType: 'text/plain' })
              ]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: false }
    )
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toEqual([
      expect.objectContaining({ id: 'notes', name: 'notes.txt' })
    ])
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.error).toBeUndefined()
  })

  it('replays earlier uploaded images with their Project-scoped Version locator after an edit', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              uploads: [
                createAttachment({
                  id: 'upload-1',
                  sessionId: 'source-session',
                  versionId: 'upload-version-1',
                  versionNumber: 1,
                  name: 'photo.png',
                  originalName: 'photo.png',
                  mimeType: 'image/png'
                })
              ]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100),
            createMessage('user-2', 'user', 'second prompt', baseTime + 200)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: true }
    )
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toEqual([
      expect.objectContaining({
        id: 'upload-1',
        path: 'upload-version:project-1/source-session/upload-1/upload-version-1'
      })
    ])
  })
})

describe('edit resend reply streaming', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const seedEditableConversation = (): void => {
    const createdAt = 1710000000000
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              content: 'first prompt',
              status: 'complete',
              eventIds: [],
              createdAt,
              updatedAt: createdAt
            },
            {
              id: 'agent-1',
              role: 'agent',
              content: 'first answer',
              status: 'complete',
              eventIds: [],
              createdAt: createdAt + 100,
              updatedAt: createdAt + 100
            },
            {
              id: 'user-2',
              role: 'user',
              content: 'second prompt',
              status: 'complete',
              eventIds: [],
              createdAt: createdAt + 200,
              updatedAt: createdAt + 200
            }
          ],
          createdAt,
          updatedAt: createdAt + 200
        }
      ],
      selectedSessionId: 'session-1'
    })
  }

  it('grows an agent bubble from streamed reply events after the truncate-and-resend', async () => {
    const baseTime = 1710000000000
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              id: 'user-1',
              role: 'user' as const,
              content: 'first prompt',
              status: 'complete' as const,
              eventIds: [],
              createdAt: baseTime,
              updatedAt: baseTime
            },
            {
              id: 'agent-1',
              role: 'agent' as const,
              content: 'first answer',
              status: 'complete' as const,
              eventIds: [],
              createdAt: baseTime + 100,
              updatedAt: baseTime + 100
            },
            {
              id: 'user-2',
              role: 'user' as const,
              content: 'second prompt',
              status: 'complete' as const,
              eventIds: [],
              createdAt: baseTime + 200,
              updatedAt: baseTime + 200
            }
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 200
        }
      ],
      selectedSessionId: 'session-1'
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: 'second prompt, edited'
    })
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    const afterResend = useSessionStore.getState().sessions[0]
    // The adjusted prompt is appended as the latest user turn and the run is live.
    expect(afterResend?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'second prompt, edited'
    })
    expect(afterResend?.status).toBe('running')

    // The agent's streamed reply lands as a new bubble answering the resent prompt.
    await applyWorkspaceRuntimeEvent(
      createEvent({
        id: 'event-reply-1',
        sessionId: 'session-1',
        role: 'assistant',
        messageId: 'agent-reply-1',
        text: 'edited answer'
      })
    )

    const messages = useSessionStore.getState().sessions[0]?.messages ?? []
    expect(messages.at(-1)).toMatchObject({
      role: 'agent',
      content: 'edited answer',
      status: 'streaming',
      responseToMessageId: afterResend?.activeRun?.promptMessageId
    })
  })

  it('resends an annotation-only revision through the unified prompt pipeline', async () => {
    seedEditableConversation()
    const annotation = {
      id: 'quote-1',
      kind: 'text' as const,
      target: 'agent' as const,
      quote: 'Quoted evidence',
      note: 'Updated note',
      source: {
        kind: 'agent-message' as const,
        sessionId: 'session-1',
        messageId: 'agent-1'
      }
    }
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        contextReset: true
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const resent = await resendEditedWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      messageId: 'user-2',
      text: '',
      annotations: [annotation]
    })
    await flushRuntimeTasks()

    expect(resent).toBe(true)
    expect(useSessionStore.getState().sessions[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: '',
      annotations: [annotation]
    })
    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toContain(
      '"type":"quote","content":"Quoted evidence","instruction":"Updated note"'
    )
  })

  it('revalidates a fixed image source before truncating an edited message branch', async () => {
    seedEditableConversation()
    const acquire = vi.fn().mockRejectedValue(new Error('missing fixed version'))
    vi.stubGlobal('window', {
      api: { previewResources: { acquire, release: vi.fn().mockResolvedValue(undefined) } }
    })
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    const messagesBefore = useSessionStore.getState().sessions[0]?.messages
    const annotation = {
      id: 'point-1',
      kind: 'image-point' as const,
      target: 'agent' as const,
      note: 'Inspect the fixed point.',
      source: {
        kind: 'artifact-version' as const,
        projectId: 'default-project',
        sessionId: 'session-1',
        versionId: 'deleted-version',
        name: 'figure.png',
        path: 'artifact-version:default-project/session-1/artifact-1/deleted-version',
        mimeType: 'image/png'
      },
      point: { x: 0.25, y: 0.75 },
      naturalSize: { width: 1200, height: 800 }
    }

    await expect(
      resendEditedWorkspaceMessage(runtime, {
        sessionId: 'session-1',
        messageId: 'user-2',
        text: 'edited prompt',
        annotations: [annotation]
      })
    ).rejects.toThrow('An annotated image is no longer available')

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'artifact',
        projectId: 'default-project',
        fileId: 'artifact-1',
        versionId: 'deleted-version'
      })
    )
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.messages).toEqual(messagesBefore)
  })
})

describe('sendWorkspaceMessage replay image filtering', () => {
  const baseTime = 1710000000000

  const createMessage = (
    id: string,
    role: 'user' | 'agent',
    content: string,
    createdAt: number
  ): ChatMessage => ({
    id,
    role,
    content,
    status: 'complete',
    eventIds: [],
    createdAt,
    updatedAt: createdAt
  })

  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('omits uploaded images but keeps other files when replaying into a text-only model', async () => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              uploads: [
                createAttachment({ id: 'photo', name: 'photo.png', mimeType: 'image/png' }),
                createAttachment({ id: 'notes', name: 'notes.txt', mimeType: 'text/plain' })
              ]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 100
        }
      ],
      selectedSessionId: 'session-1'
    })

    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const sent = await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'follow up',
      cwd: '/workspace/project',
      forceHistoryReplay: true,
      supportsImageInput: false
    })
    await flushRuntimeTasks()

    expect(sent).toBeDefined()
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toContain('first prompt')
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toEqual([
      expect.objectContaining({ id: 'notes', name: 'notes.txt' })
    ])
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.error).toBeUndefined()
  })

  it('resets native image context but replays originals through the Vision relay', async () => {
    const originalImage = {
      id: 'img-1',
      mimeType: 'image/png' as const,
      data: 'AQID',
      byteLength: 3
    }
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'Conversation',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            {
              ...createMessage('user-1', 'user', 'first prompt', baseTime),
              images: [originalImage]
            },
            createMessage('agent-1', 'agent', 'first answer', baseTime + 100)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 100
        }
      ],
      selectedSessionId: 'session-1'
    })
    const runtime = {
      state: createSnapshot([]),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockResolvedValue({ contextReset: false }),
      resetSessionContext: vi.fn().mockResolvedValue({ contextReset: true }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const sent = await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'follow up',
      cwd: '/workspace/project',
      supportsImageInput: false,
      supportsImageRelay: true
    })
    await flushRuntimeTasks()

    expect(sent).toBeDefined()
    expect(runtime.resetSessionContext).toHaveBeenCalledOnce()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toEqual([
      { ...originalImage, sourceMessageId: 'user-1', sourceImageId: 'img-1' }
    ])
  })
})
