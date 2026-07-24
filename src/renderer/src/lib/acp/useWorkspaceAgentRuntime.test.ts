import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialSessionState,
  useSessionStore,
  type ChatMessage
} from '../../stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import { applyWorkspaceRuntimeEvent } from './workspace-events'
import {
  createWorkspaceRuntimeEventProcessor,
  deleteWorkspaceSession,
  getResumeFailureMessage,
  markRunningSessionsDisconnectedOnDrop,
  processContextOverflowRecovery,
  processVisibleWorkspaceRuntimeEvents,
  recoverContextOverflowWorkspaceSession,
  resendEditedWorkspaceMessage,
  resumeInterruptedWorkspaceSession,
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

describe('resume failure classification', () => {
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

    expect(runtime.createSession).toHaveBeenCalledWith('/workspace/project', undefined, 'ask')
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
      undefined
    )
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

    expect(runtime.createSession).toHaveBeenCalledWith(undefined, 'project-1', 'ask')
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

    expect(runtime.createSession).toHaveBeenNthCalledWith(1, undefined, 'project-1', 'ask')
    expect(runtime.createSession).toHaveBeenNthCalledWith(2, undefined, 'project-1', 'ask')
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

  it('marks restored sessions running before resume finishes to block duplicate submits', async () => {
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
      'codex:codex-isolated'
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

    await resumeInterruptedWorkspaceSession(runtime, 'session-1')
    await flushRuntimeTasks()

    expect(runtime.resumeSession).toHaveBeenCalled()
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
      undefined
    )

    const session = useSessionStore.getState().sessions[0]
    const userMessages = session.messages.filter((message) => message.role === 'user')

    // The stale turn was removed and re-appended once, so there is no duplicate user bubble.
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].content).toBe('Continue the analysis')
    expect(session.interrupted).toBeUndefined()
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
      'claude-code:anthropic'
    )
    const preamble = runtime.sendPrompt.mock.calls[0]?.[5]
    expect(preamble).toContain('Analyze the data with Claude')
    expect(preamble).toContain('Claude finished the analysis')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:builtin-codex-subscription'
    })
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

  it('blocks image replay after switching to a model without image input', async () => {
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
        contextReset: true,
        frameworkId: 'codex'
      }),
      resetSessionContext: vi.fn(),
      sendPrompt: vi.fn()
    }

    await sendWorkspaceMessage(runtime, {
      sessionId: 'session-1',
      text: 'continue',
      cwd: '/workspace/project',
      projectId: 'default-project',
      supportsImageInput: false
    })

    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].error).toContain('does not support image input')
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

  const seedOverflowedConversation = (): void => {
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
    seedOverflowedConversation()

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

    const recovered = await recoverContextOverflowWorkspaceSession(runtime, 'session-1')
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
    const recovering = new Set<string>()
    const event = createEvent({
      id: 'overflow-1',
      kind: 'error',
      level: 'error',
      sessionId: 'session-1',
      title: 'Prompt failed',
      text: 'Internal error: Request too large (max 32MB).'
    })

    processContextOverflowRecovery(runtime, [event], handled, recovering, recover)
    // A repeated snapshot delivering the same event must not recover twice.
    processContextOverflowRecovery(runtime, [event], handled, recovering, recover)

    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(runtime, 'session-1')
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

    processContextOverflowRecovery(runtime, [event], new Set(), new Set(), recover)

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
      recover
    )

    expect(recover).not.toHaveBeenCalled()
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

  it('shows the resent bubble as a live run immediately, then replays the kept history', async () => {
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

    // While the context reset is still in flight, the transcript already shows the adjusted prompt
    // as a live run — the same immediate feedback as a composer send.
    const duringReset = useSessionStore.getState().sessions[0]
    expect(duringReset?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      expect.any(String)
    ])
    expect(duringReset?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'second prompt, edited'
    })
    expect(duringReset?.status).toBe('running')
    expect(duringReset?.activeRun?.promptMessageId).toBe(duringReset?.messages.at(-1)?.id)
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
      false
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
      false
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

describe('sendWorkspaceMessage replay image gate', () => {
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

  it('blocks the replay before dispatch when the kept history has user-uploaded images', async () => {
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

    // The user turn is recorded, but the replayed upload would become an image block the model
    // cannot take, so nothing is dispatched and the session carries the gate's error.
    expect(sent).toBeDefined()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
    const session = useSessionStore.getState().sessions[0]
    expect(session?.status).toBe('error')
    expect(session?.error).toContain('image replay')
  })
})
