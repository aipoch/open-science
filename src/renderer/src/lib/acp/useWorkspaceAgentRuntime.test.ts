import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import {
  createWorkspaceRuntimeEventProcessor,
  processVisibleWorkspaceRuntimeEvents,
  sendWorkspaceMessage
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

  it('serializes overlapping snapshots so stop waits for an in-flight artifact event', async () => {
    const artifactEvent = createEvent({ id: 'artifact-event-1', kind: 'artifact' })
    const stopEvent = createEvent({ id: 'stop-event-1', kind: 'stop' })
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
})

describe('workspace agent message sending', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['transport-session-1']))
    }

    const sent = await sendWorkspaceMessage(runtime, {
      text: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })

    expect(runtime.createSession).toHaveBeenCalledWith('/workspace/project', undefined, 'ask')
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: sent?.sessionId,
      isPending: true,
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
      undefined
    )
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
              sessionId: 'transport-session-1',
              path: finalizedAttachment.path
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
      undefined
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
      undefined
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

  it('does not submit another prompt for a session that already owns a run', async () => {
    const runtime = {
      state: createSnapshot(['session-1']),
      createSession: vi.fn(),
      resumeSession: vi.fn(),
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

  it('marks restored sessions running before resume finishes to block duplicate submits', async () => {
    const resumeCanFinish = createDeferred<{ sessionId: string; cwd?: string }>()
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn(() => resumeCanFinish.promise),
      sendPrompt: vi.fn().mockResolvedValue(createSnapshot(['session-1']))
    }

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Previous prompt',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().finishRun('session-1')

    const first = sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Continue restored conversation',
      cwd: '/workspace/project'
    })
    const second = sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'Duplicate submit',
      cwd: '/workspace/project'
    })

    await expect(second).resolves.toBeUndefined()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'running' })
    expect(runtime.resumeSession).toHaveBeenCalledTimes(1)

    resumeCanFinish.resolve({ sessionId: 'session-1', cwd: '/workspace/project' })
    await expect(first).resolves.toMatchObject({ sessionId: 'session-1' })
    expect(runtime.sendPrompt).toHaveBeenCalledTimes(1)
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

  it('fails the run with a generic message when resume fails for another reason', async () => {
    const runtime = {
      state: createSnapshot(),
      createSession: vi.fn(),
      resumeSession: vi.fn().mockRejectedValue(new Error('agent process crashed')),
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
      error: 'Agent session resume failed'
    })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })
})
