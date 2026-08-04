import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { IMAGE_REPLAY_UNSUPPORTED_MESSAGE } from '../../../../shared/run-error-classification'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore,
  type ChatMessage
} from '../../stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { applyWorkspaceRuntimeEvent } from './workspace-events'
import {
  cancelWorkspaceRun,
  createWorkspaceRuntimeEventProcessor,
  compactWorkspaceSession,
  deleteWorkspaceSession,
  getResumeFailureMessage,
  markRunningSessionsDisconnectedOnDrop,
  processContextOverflowRecovery,
  processVisibleWorkspaceRuntimeEvents,
  recoverContextOverflowWorkspaceSession,
  resendEditedWorkspaceMessage,
  resumeInterruptedWorkspaceSession,
  sendWorkspaceMessage,
  syncWorkspaceContextUsage
} from './useWorkspaceAgentRuntime'

const createEvent = (overrides: Partial<AcpRuntimeEvent>): AcpRuntimeEvent => ({
  id: 'event-1',
  timestamp: 1710000000000,
  kind: 'message',
  level: 'info',
  sessionId: 'transport-session-1',
  ...overrides
})

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

describe('workspace agent runtime event processing', () => {
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
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    let rejectFirstAttempt!: (reason: Error) => void
    const firstAttempt = new Promise<boolean>((_resolve, reject) => {
      rejectFirstAttempt = reject
    })
    const retryStarted = createDeferred<void>()
    const applyEvent = vi
      .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
      .mockImplementationOnce(() => firstAttempt)
      .mockImplementationOnce(async () => {
        retryStarted.resolve()
        return true
      })
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    void processor.process([])
    rejectFirstAttempt(new Error('move failed'))
    await firstDrain

    void processor.process([])
    const didRetry = await Promise.race([
      retryStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0))
    ])

    expect(didRetry).toBe(true)
    expect(applyEvent).toHaveBeenCalledTimes(2)
  })

  it('releases an evicted event after its deferred retry also fails', async () => {
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    let rejectFirstAttempt!: (reason: Error) => void
    let rejectRetry!: (reason: Error) => void
    const firstAttempt = new Promise<boolean>((_resolve, reject) => {
      rejectFirstAttempt = reject
    })
    const retry = new Promise<boolean>((_resolve, reject) => {
      rejectRetry = reject
    })
    const applyEvent = vi
      .fn<(runtimeEvent: AcpRuntimeEvent) => Promise<boolean>>()
      .mockImplementationOnce(() => firstAttempt)
      .mockImplementationOnce(() => retry)
      .mockResolvedValue(true)
    const processor = createWorkspaceRuntimeEventProcessor(applyEvent)

    const firstDrain = processor.process([artifactEvent])
    void processor.process([])
    rejectFirstAttempt(new Error('move failed'))
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    rejectRetry(new Error('move still failing'))
    await firstDrain

    await processor.process([])
    await processor.drain()

    expect(applyEvent).toHaveBeenCalledTimes(2)
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

describe('workspace session deletion', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Persist me',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
  })

  it('removes the session only after runtime and durable deletion succeed', async () => {
    const runtime = { deleteSession: vi.fn().mockResolvedValue(createSnapshot()) }
    const persistDelete = vi.fn().mockResolvedValue(undefined)

    await deleteWorkspaceSession(runtime, 'session-1', persistDelete)

    expect(persistDelete).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-1' })
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('keeps the session visible when durable deletion fails', async () => {
    const runtime = { deleteSession: vi.fn().mockResolvedValue(createSnapshot()) }
    const persistDelete = vi.fn().mockRejectedValue(new Error('disk locked'))

    await expect(deleteWorkspaceSession(runtime, 'session-1', persistDelete)).rejects.toThrow(
      'disk locked'
    )

    expect(useSessionStore.getState().sessions).toHaveLength(1)
  })
})

describe('workspace agent message sending', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
      projectName: 'project-1'
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
      expect.objectContaining({ promptMessageId: expect.any(String) })
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
      'ask'
    )
    expect(resumeSession).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined
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
      'ask'
    )
    expect(resumeSession).toHaveBeenCalledWith(
      'transport-session-1',
      '/workspace/project',
      'project-1',
      'ask',
      'claude-code',
      'claude-code:anthropic',
      undefined
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
      undefined,
      drainRuntimeEvents
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
      undefined
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
      expect.objectContaining({ promptMessageId: expect.any(String) })
    )
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
      projectName: 'wrong-project'
    })

    expect(branched).toBeDefined()
    expect(runtime.createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined
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
      expect.objectContaining({ promptMessageId: branched?.messageId })
    )
  })

  it('keeps the immediately created branched Session in an error state when history images cannot replay', async () => {
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
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const branched = await sendWorkspaceMessage(runtime, {
      branchSourceSessionId: 'source-session',
      text: 'Try another chart explanation',
      supportsImageInput: false
    })

    expect(branched).toBeDefined()
    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === 'source-session')
    ).toEqual(sourceBeforeBranch)
    expect(useSessionStore.getState().selectedSessionId).toBe(branched?.sessionId)
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === branched?.sessionId)
    ).toMatchObject({
      id: branched?.sessionId,
      status: 'error',
      error: IMAGE_REPLAY_UNSUPPORTED_MESSAGE,
      messages: expect.arrayContaining([
        expect.objectContaining({ content: 'Try another chart explanation' })
      ])
    })
  })

  it('publishes a path-only legacy history upload under the source Session before replay', async () => {
    const finalizedHistory = createAttachment({
      id: 'legacy-upload-1',
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/legacy-version-1',
      mimeType: 'image/png',
      versionId: 'legacy-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedHistory])
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
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
      expect.objectContaining({ promptMessageId: branched?.messageId })
    )
  })

  it('does not create or prompt an ACP Session when a pending branch is cancelled during history reconciliation', async () => {
    const stagedHistory = createAttachment({ id: 'history-upload-1', mimeType: 'image/png' })
    const finalizedHistory = createAttachment({
      id: stagedHistory.id,
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/history-version-1',
      mimeType: 'image/png',
      versionId: 'history-version-1',
      versionNumber: 1
    })
    const finalization = createDeferred<UploadedAttachment[]>()
    const finalizeSession = vi.fn(() => finalization.promise)
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
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
      path: 'upload-version:project-1/source-session/history-version-1',
      mimeType: 'image/png',
      versionId: 'history-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedHistory])
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
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
      expect.objectContaining({ promptMessageId: branched?.messageId })
    )
  })

  it('retries a failed branched Session with the copied history and one current prompt', async () => {
    const attachment = createAttachment()
    const finalizedAttachment = createAttachment({
      sessionId: 'branched-runtime-session',
      path: 'upload-version:project-1/branched-runtime-session/upload-version-1',
      versionId: 'upload-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedAttachment])
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })
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
    expect(runtime.sendPrompt).toHaveBeenCalledTimes(1)
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
      path: 'upload-version:project-1/branched-runtime-session/upload-version-1',
      versionId: 'upload-version-1',
      versionNumber: 1
    })
    const finalizeSession = vi.fn().mockResolvedValue([finalizedAttachment])
    vi.stubGlobal('window', {
      api: {
        uploads: { finalizeSession },
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

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'branched-runtime-session',
      isPending: false,
      status: 'error',
      pendingContextReplayMessageId: branched?.messageId
    })

    const retried = await sendWorkspaceMessage(runtime, {
      sessionId: 'branched-runtime-session',
      text: 'Try a different interpretation'
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
    expect(finalizeSession).toHaveBeenCalledTimes(2)
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
      projectId: 'project-1',
      projectName: 'project-1'
    })

    expect(runtime.createSession).toHaveBeenCalledWith(undefined, 'project-1', 'ask', undefined)
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
      projectId: 'project-1',
      projectName: 'project-1'
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
      expect.objectContaining({ promptMessageId: expect.any(String) })
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
      expect.objectContaining({ promptMessageId: expect.any(String) })
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
      projectId: 'project-1',
      projectName: 'project-1'
    })
    await flushRuntimeTasks()

    await sendWorkspaceMessage(runtime, {
      sessionId: first?.sessionId,
      text: 'Try again',
      projectId: 'project-1',
      projectName: 'project-1'
    })

    expect(runtime.createSession).toHaveBeenNthCalledWith(
      1,
      undefined,
      'project-1',
      'ask',
      undefined
    )
    expect(runtime.createSession).toHaveBeenNthCalledWith(
      2,
      undefined,
      'project-1',
      'ask',
      undefined
    )
  })

  it('does not submit another prompt for a session that already owns a run', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(),
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
      preparationChanged
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

  it('re-attaches the session and unlocks the composer on success', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }
    seedDetachedSession()

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      expect.any(String),
      'codex',
      'codex:codex-isolated',
      undefined
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

  it('reconnects and re-sends the interrupted user turn exactly once', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue the analysis',
      cwd: '/workspace/project',
      projectId: 'default-project',
      permissionProfile: 'ask'
    })
    // A live drop leaves the last user turn unanswered and flags the session for Resume.
    useSessionStore.getState().markDisconnected('session-1')

    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }
    const preparationChanged = vi.fn()
    const drainRuntimeEvents = vi.fn().mockResolvedValue(undefined)

    await resumeInterruptedWorkspaceSession(runtime, 'session-1', {
      onSendPreparationStateChange: preparationChanged,
      drainRuntimeEvents
    })
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalled()
    expect(preparationChanged.mock.calls).toEqual([
      ['session-1', true],
      ['session-1', false]
    ])
    expect(drainRuntimeEvents).toHaveBeenCalledOnce()
    expect(drainRuntimeEvents.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendPrompt.mock.invocationCallOrder[0]
    )
    expect(runtime.sendPrompt).toHaveBeenCalledTimes(1)
    expect(runtime.sendPrompt).toHaveBeenCalledWith(
      'session-1',
      'Continue the analysis',
      [],
      undefined,
      undefined,
      // A same-framework interrupted resume does not reset context, so no history preamble is replayed.
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ promptMessageId: expect.any(String) })
    )

    const session = useSessionStore.getState().sessions[0]
    const userMessages = session.messages.filter((message) => message.role === 'user')

    // The stale turn was removed and re-appended once, so there is no duplicate user bubble.
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].content).toBe('Continue the analysis')
    expect(session.interrupted).toBeUndefined()
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
  })

  it('restores the interrupted user turn when re-send preparation fails', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Do not lose this interrupted prompt',
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
        .mockResolvedValueOnce({ sessionId: 'session-1', cwd: '/workspace/project' })
        .mockRejectedValueOnce(new Error('adoption failed')),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({ content: 'Do not lose this interrupted prompt' })
    ])
    expect(session.interrupted).toBe(true)
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    runtime.state = createSnapshot(['session-1'])
    runtime.sendPrompt.mockResolvedValue(createSnapshot(['session-1']))
    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalledTimes(2)
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    expect(
      useSessionStore.getState().sessions[0].messages.filter((message) => message.role === 'user')
    ).toEqual([expect.objectContaining({ content: 'Do not lose this interrupted prompt' })])
  })

  it('replays a history preamble when an interrupted resume adopts a fresh agent session', async () => {
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
      // Step-1 resume adopts a fresh session (contextReset); the shared send path's own re-resume then
      // hits the already-attached session and reports no reset — mirroring runtime's "already attached"
      // branch. The interrupted path must still honor its own step-1 signal.
      resumeSession: vi
        .fn()
        .mockResolvedValueOnce({
          sessionId: 'session-1',
          cwd: '/workspace/project',
          contextReset: true
        })
        .mockResolvedValue({ sessionId: 'session-1', cwd: '/workspace/project' }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Plot the sales data')
    expect(preamble).toContain('Done, saved chart.png')
    // The re-sent interrupted turn is prior-context only: it is not folded into its own preamble.
    expect(preamble).not.toContain('now add a trend line')
  })

  it('does not replay a history preamble when the interrupted resume kept agent context', async () => {
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
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.sendPrompt.mock.calls[0]?.[5]).toBeUndefined()
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
      undefined
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

  const seedOverflowedConversation = (includeHistoryImage = false): void => {
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
      permissionProfile: 'ask'
    })
    useSessionStore.getState().failRun('session-1', 'Request too large (max 32MB)')
  }

  it('resets the agent context, drops the failed turn, and re-sends with a text preamble', async () => {
    vi.stubGlobal('window', {
      api: { acp: { getState: vi.fn().mockResolvedValue(createSnapshot(['session-1'])) } }
    })
    seedOverflowedConversation(true)

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
        contextReset: true
      }),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1', false)
    await flushRuntimeTasks()

    expect(recovered).toBe(true)
    expect(runtime.resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask'
    )
    // The unanswered turn is re-sent (not duplicated) with the prior turn replayed as a text preamble.
    expect(runtime.sendPrompt.mock.calls[0]?.[1]).toBe('now compare with this new screenshot')
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Analyze the first screenshot')
    expect(preamble).toContain('Here is what it shows')
    expect(preamble).not.toContain('now compare with this new screenshot')
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
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
})

describe('resendEditedWorkspaceMessage', () => {
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
    status: 'complete' as const,
    eventIds: [],
    createdAt,
    updatedAt: createdAt
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
      undefined
    )
    expect(runtime.resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace/project',
      'default-project',
      'ask'
    )
    expect(drainRuntimeEvents).toHaveBeenCalledOnce()
    expect(preparationChanged).toHaveBeenLastCalledWith('session-1', false)
    expect(
      useSessionStore.getState().sessions[0]?.messages.map((message) => message.content)
    ).toEqual(['first prompt', 'first answer', 'second prompt, edited'])
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
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
      'ask'
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

  it('refuses the edit before truncating when the kept history needs image replay the model cannot take', async () => {
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
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: false }
    )

    // The incompatible replay is rejected before the destructive cut: no reset, no prompt, and the
    // transcript is untouched apart from the visible error.
    expect(resent).toBe(false)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.messages.map((message) => message.id)).toEqual(['user-1', 'agent-1', 'user-2'])
    expect(session?.status).toBe('error')
    expect(session?.error).toContain('image replay')
  })

  it('refuses the edit before truncating when the kept history has user-uploaded images', async () => {
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
              uploads: [createAttachment({ name: 'photo.png', mimeType: 'image/png' })]
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
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    const resent = await resendEditedWorkspaceMessage(
      runtime,
      { sessionId: 'session-1', messageId: 'user-2', text: 'second prompt, edited' },
      { supportsImageInput: false }
    )

    // User uploads replay as image attachments, so they are gated exactly like agent-emitted images.
    expect(resent).toBe(false)
    expect(runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.messages.map((message) => message.id)).toEqual(['user-1', 'agent-1', 'user-2'])
    expect(session?.status).toBe('error')
    expect(session?.error).toContain('image replay')
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
        path: 'upload-version:project-1/source-session/upload-version-1'
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

  it('omits user-uploaded images when replaying into a text-only model', async () => {
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
              uploads: [createAttachment({ name: 'photo.png', mimeType: 'image/png' })]
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
    expect(runtime.sendPrompt.mock.calls[0]?.[6]).toBeUndefined()
    expect(runtime.sendPrompt.mock.calls[0]?.[7]).toBeUndefined()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.error).toBeUndefined()
  })
})
