import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node
} from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../../shared/artifacts'
import { DEFAULT_PERMISSION_PROFILE } from '../../../shared/permission-profiles'
import {
  INTERRUPTED_SESSION_ERROR,
  SESSION_MANIFEST_VERSION,
  type PersistedChatSession,
  type SessionPdfContext
} from '../../../shared/session-persistence'
import type { UploadedAttachment } from '../../../shared/uploads'
import type { ActivePlanProjection } from '../../../shared/session-plan/contract'
import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import {
  createInitialSessionState,
  projectSessionActionability,
  toPersistedSession,
  useSessionStore,
  type ChatMessage,
  type ChatSession,
  type ToolActivity
} from './session-store'
import { mergePersistedRuntimeIdentityProjection } from './session-store-persistence-merge'

const createArtifactFile = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
  id: 'artifact-session-1:run-1:result.txt',
  projectId: 'default-project',
  sessionId: 'artifact-session-1',
  runId: 'run-1',
  name: 'result.txt',
  path: '/Users/example/.open-science/artifacts/default-project/artifact-session-1/.pending/run-1/result.txt',
  fileUrl:
    'file:///Users/example/.open-science/artifacts/default-project/artifact-session-1/.pending/run-1/result.txt',
  size: 2,
  mtimeMs: 1710000000000,
  ...overrides
})

const createUploadAttachment = (
  overrides: Partial<UploadedAttachment> = {}
): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: '.pending',
  name: 'first.png',
  originalName: 'first.png',
  path: '/Users/example/.open-science/uploads/default-project/.pending/first.png',
  mimeType: 'image/png',
  size: 1234,
  ...overrides
})

const createPdfContext = (): SessionPdfContext => ({
  version: 1,
  bindings: [
    {
      version: 1,
      bindingId: 'binding-1',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'source-session-1',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 1
    }
  ]
})

const createPlanProjection = (artifactVersionId: string): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: `Plan ${artifactVersionId}`,
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: `Step ${artifactVersionId}`, description: 'Do the work.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { Step: { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

describe('session store', () => {
  // Reset time and state so each store assertion starts from the same baseline.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
  })

  it('keeps a newer runtime revision authoritative when Reading context was removed', () => {
    const merged = mergePersistedRuntimeIdentityProjection(
      {
        runtimeContext: {
          version: 1,
          revision: 1,
          pdfContext: createPdfContext()
        }
      },
      {
        runtimeContext: {
          version: 1,
          revision: 2
        }
      },
      { incomingOwnsFrameConflicts: true }
    )

    expect(merged.runtimeContext).toEqual({ version: 1, revision: 2 })
  })

  it('starts empty so New can stay outside store state', () => {
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('projects one priority for simultaneous Session interactions', () => {
    const actionability = projectSessionActionability({
      id: 'session-actionability',
      projectId: 'project-1',
      title: 'Actionability',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      interactionState: { permission: true, elicitation: true, plan: true },
      messages: [],
      createdAt: 1,
      updatedAt: 1
    } as ChatSession)

    expect(actionability).toMatchObject({
      presentedStatus: 'waiting-permission',
      activity: 'waiting',
      attentionOwner: 'user',
      waitReason: 'waiting-permission',
      blockingInteraction: 'permission',
      actions: {
        startTurn: { allowed: false, disabledReason: 'permission-pending' },
        revise: { allowed: false, disabledReason: 'permission-pending' },
        branchFromMessage: { allowed: false, disabledReason: 'permission-pending' },
        startSideChat: { allowed: false, disabledReason: 'permission-pending' }
      }
    })
  })

  it('keeps delegated Permission actionable without giving it the main Composer lane', () => {
    const actionability = projectSessionActionability(
      {
        id: 'session-delegated-permission',
        projectId: 'project-1',
        title: 'Delegated permission',
        cwd: '/workspace',
        status: 'waiting-permission',
        interactionState: { permission: true, elicitation: false, plan: false },
        messages: [],
        createdAt: 1,
        updatedAt: 1
      } as ChatSession,
      { rootPermissionPending: false }
    )

    expect(actionability).toMatchObject({
      activity: 'waiting',
      attentionOwner: 'user',
      waitReason: 'waiting-permission',
      blockingInteraction: undefined,
      actions: {
        startTurn: { allowed: true },
        revise: { allowed: true },
        branchFromMessage: { allowed: false, disabledReason: 'permission-pending' },
        startSideChat: { allowed: false, disabledReason: 'permission-pending' }
      }
    })
  })

  it('projects runtime credential recovery as a non-persisted user interaction', () => {
    const actionability = projectSessionActionability(
      {
        id: 'session-credential',
        projectId: 'project-1',
        title: 'Credential recovery',
        cwd: '/workspace',
        status: 'running',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      } as ChatSession,
      {
        credentialPending: true,
        presentedWaitReason: 'waiting-for-user'
      }
    )

    expect(actionability).toMatchObject({
      presentedStatus: 'waiting-for-user',
      activity: 'waiting',
      attentionOwner: 'user',
      blockingInteraction: 'credential',
      actions: {
        startTurn: { allowed: false, disabledReason: 'credential-pending' },
        revise: { allowed: false, disabledReason: 'credential-pending' },
        startSideChat: { allowed: false, disabledReason: 'credential-pending' }
      }
    })
  })

  it('projects a pending Session as unavailable for a new Turn or Message branch', () => {
    const actionability = projectSessionActionability({
      id: 'session-pending',
      projectId: 'project-1',
      title: 'Pending Session',
      cwd: '/workspace',
      status: 'idle',
      isPending: true,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    } as ChatSession)

    expect(actionability.actions).toMatchObject({
      startTurn: { allowed: false, disabledReason: 'session-pending' },
      revise: { allowed: true },
      branchFromMessage: { allowed: false, disabledReason: 'session-pending' },
      startSideChat: { allowed: false, disabledReason: 'session-pending' },
      changeAgentControls: { allowed: false, disabledReason: 'session-pending' },
      changeAutoReview: { allowed: false, disabledReason: 'session-pending' },
      changeSpecialist: { allowed: false, disabledReason: 'session-pending' },
      changeMemory: { allowed: false, disabledReason: 'session-pending' }
    })
  })

  it('keeps replay-independent Session actions available while history replay is pending', () => {
    const actionability = projectSessionActionability({
      id: 'session-replay',
      projectId: 'project-1',
      title: 'Replay pending',
      cwd: '/workspace',
      status: 'idle',
      pendingHistoryReplay: { kind: 'all' },
      messages: [],
      createdAt: 1,
      updatedAt: 1
    } as ChatSession)

    expect(actionability.actions).toMatchObject({
      startTurn: { allowed: true },
      revise: { allowed: true },
      branchFromMessage: { allowed: true },
      startSideChat: { allowed: false, disabledReason: 'session-pending' },
      changeAgentControls: { allowed: false, disabledReason: 'session-pending' },
      changeAutoReview: { allowed: true },
      changeSpecialist: { allowed: true },
      changeMemory: { allowed: true }
    })
  })

  it('keeps restored durable root Permission authoritative over a delegated live hint', () => {
    const actionability = projectSessionActionability(
      {
        id: 'session-restored-root-permission',
        projectId: 'project-1',
        title: 'Restored root permission',
        cwd: '/workspace',
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-root',
              sessionId: 'session-restored-root-permission',
              toolCallId: 'tool-root',
              title: 'Run root command',
              options: []
            },
            originatingPromptMessageId: 'prompt-root',
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 1
      } as ChatSession,
      { rootPermissionPending: false }
    )

    expect(actionability).toMatchObject({
      blockingInteraction: 'permission',
      actions: { startTurn: { allowed: false, disabledReason: 'permission-pending' } }
    })
  })

  it('gives a projected user wait priority over concurrent delegated work', () => {
    const actionability = projectSessionActionability(
      {
        id: 'session-delegated-question',
        projectId: 'project-1',
        title: 'Delegated question',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      } as ChatSession,
      { presentedWaitReason: 'waiting-for-user', hasRunningWork: true }
    )

    expect(actionability).toMatchObject({
      presentedStatus: 'waiting-for-user',
      activity: 'waiting',
      attentionOwner: 'user'
    })
  })

  it('keeps a Side chat relay distinct from a local user message with matching text', () => {
    const localMessage = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Use a black line.'
    })
    if (!localMessage) throw new Error('Expected a local user Message.')

    const relayMessage = useSessionStore.getState().appendRoutedUserMessage({
      sessionId: 'transport-session-1',
      messageId: 'side-chat-relay-1',
      eventId: 'side-chat-relay-event-1',
      content: 'Use a black line.',
      createdAt: Date.now() + 1,
      responseToMessageId: localMessage.messageId,
      relayedFrom: { kind: 'side-chat', direction: 'to-main' }
    })

    expect(relayMessage).toEqual({
      sessionId: 'transport-session-1',
      messageId: 'side-chat-relay-1'
    })
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({ id: localMessage.messageId }),
      expect.objectContaining({
        id: 'side-chat-relay-1',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    ])
  })

  it('keeps the local send markers when a provider echo replaces the provisional user Message', () => {
    const agentTarget = {
      frameworkId: 'claude-code' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high' as const
    }
    useSessionStore.setState({
      sessions: [
        {
          id: 'transport-session-1',
          projectId: 'default-project',
          title: 'Session',
          cwd: '/workspace/project',
          status: 'running',
          messages: [
            {
              id: 'local-user-message-1',
              role: 'user',
              content: 'Run the analysis',
              status: 'complete',
              eventIds: [],
              sortIndex: 1,
              agentTarget,
              turnIntent: 'plan-first',
              createdAt: 1,
              updatedAt: 1
            }
          ],
          createdAt: 1,
          updatedAt: 1
        } as ChatSession
      ],
      selectedSessionId: 'transport-session-1'
    })

    const routed = useSessionStore.getState().appendRoutedUserMessage({
      sessionId: 'transport-session-1',
      messageId: 'provider-message-1',
      eventId: 'provider-event-1',
      content: 'Run the analysis',
      createdAt: 2
    })

    expect(routed).toEqual({ sessionId: 'transport-session-1', messageId: 'provider-message-1' })
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({
        id: 'provider-message-1',
        sortIndex: 1,
        agentTarget,
        turnIntent: 'plan-first'
      })
    ])
  })

  it('persists a routed user Message with uploads when the text is empty', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'seed'
    })
    const routed = useSessionStore.getState().appendRoutedUserMessage({
      sessionId: 'transport-session-1',
      messageId: 'routed-upload-1',
      eventId: 'routed-upload-event-1',
      content: '   ',
      createdAt: Date.now() + 1,
      uploads: [
        {
          id: 'upload-1',
          sessionId: 'transport-session-1',
          name: 'notes.md',
          originalName: 'notes.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    })
    expect(routed).toEqual({ sessionId: 'transport-session-1', messageId: 'routed-upload-1' })
    expect(useSessionStore.getState().sessions[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'routed-upload-1',
          content: '',
          uploads: [expect.objectContaining({ id: 'upload-1', name: 'notes.md' })]
        })
      ])
    )
  })

  it('tracks the first Agent output wait as transient session state', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.getState().setAwaitingFirstAgentOutput('transport-session-1', true)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)

    useSessionStore.getState().setAwaitingFirstAgentOutput('transport-session-1', false)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('clears the first Agent output wait atomically with a visible chunk', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        awaitingFirstAgentOutput: true
      }))
    }))

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'First visible token'
    })

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('projects a visible Agent text batch with one store commit', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Stream a response'
    })
    let commits = 0
    const unsubscribe = useSessionStore.subscribe(() => (commits += 1))

    useSessionStore.getState().appendAgentMessageChunks([
      {
        sessionId: 'transport-session-1',
        streamId: 'assistant-message-1',
        eventId: 'event-1',
        content: 'Hello'
      },
      {
        sessionId: 'transport-session-1',
        streamId: 'assistant-message-1',
        eventId: 'event-2',
        content: ' world'
      }
    ])
    unsubscribe()

    expect(commits).toBe(1)
    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      content: 'Hello world',
      eventIds: ['event-1', 'event-2']
    })
  })

  it('does not repeat history-sized scans for every delta in one Agent text batch', () => {
    const measureHistoricalReads = (chunkCount: number): number => {
      let historicalReads = 0
      const messages = Array.from(
        { length: 200 },
        (_, index) =>
          new Proxy<ChatMessage>(
            {
              id: `history-${index}`,
              role: index % 2 === 0 ? 'user' : 'agent',
              content: `Historical message ${index}`,
              status: 'complete',
              eventIds: [],
              createdAt: index,
              updatedAt: index
            },
            {
              get(target, property, receiver) {
                historicalReads += 1
                return Reflect.get(target, property, receiver)
              }
            }
          )
      )
      useSessionStore.setState({
        sessions: [
          {
            id: 'transport-session-1',
            projectId: 'project-1',
            title: 'Long conversation',
            cwd: '/workspace',
            status: 'running',
            messages,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        selectedSessionId: 'transport-session-1'
      })
      historicalReads = 0

      useSessionStore.getState().appendAgentMessageChunks(
        Array.from({ length: chunkCount }, (_, index) => ({
          sessionId: 'transport-session-1',
          streamId: 'assistant-message-1',
          eventId: `event-${index}`,
          content: 'x'
        }))
      )

      return historicalReads
    }

    const singleChunkReads = measureHistoricalReads(1)
    const batchedChunkReads = measureHistoricalReads(8)

    expect(batchedChunkReads).toBeLessThanOrEqual(singleChunkReads * 2)
    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      content: 'xxxxxxxx',
      eventIds: Array.from({ length: 8 }, (_, index) => `event-${index}`)
    })
  })

  it('keeps artifact finalization idempotent across independent renderer projections', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Stream a response'
    })
    const initialSession = toPersistedSession(useSessionStore.getState().sessions[0])
    const input = {
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Hello'
    }

    const firstProjection = useSessionStore.getState().appendAgentMessageChunk(input)
    useSessionStore.getState().hydrateSessions([initialSession])
    const secondProjection = useSessionStore.getState().appendAgentMessageChunk(input)
    let finalizedMessageId: string | undefined
    const finalize = (messageId: string | undefined): void => {
      if (finalizedMessageId && finalizedMessageId !== messageId) {
        throw new Error(`Artifact run claim already finalized for message: ${finalizedMessageId}`)
      }
      finalizedMessageId = messageId
    }

    finalize(firstProjection?.messageId)
    expect(() => finalize(secondProjection?.messageId)).not.toThrow()
  })

  it('keeps waiting through whitespace-only Agent chunks', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.getState().setAwaitingFirstAgentOutput('transport-session-1', true)

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-whitespace',
      content: '   '
    })
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-visible',
      content: 'First visible token'
    })
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('does not persist the first Agent output wait', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    const session = {
      ...useSessionStore.getState().sessions[0],
      awaitingFirstAgentOutput: true
    }

    expect(toPersistedSession(session)).not.toHaveProperty('awaitingFirstAgentOutput')
  })

  it('tracks runtime prompt ownership as transient state and clears it when the run settles', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.getState().setAgentPromptInFlight('transport-session-1', true)

    const running = useSessionStore.getState().sessions[0]
    expect(running.agentPromptInFlight).toBe(true)
    expect(toPersistedSession(running)).not.toHaveProperty('agentPromptInFlight')

    useSessionStore.getState().finishRun('transport-session-1')
    expect(useSessionStore.getState().sessions[0].agentPromptInFlight).toBeUndefined()

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Retry the foreground request'
    })
    useSessionStore.getState().setAgentPromptInFlight('transport-session-1', true)
    useSessionStore.getState().failRun('transport-session-1', 'Provider failed')
    expect(useSessionStore.getState().sessions[0].agentPromptInFlight).toBeUndefined()
  })

  it('clears the first Agent output wait when the request settles without output', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        awaitingFirstAgentOutput: true
      }))
    }))

    useSessionStore.getState().finishRun('transport-session-1')
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Retry the request'
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        awaitingFirstAgentOutput: true
      }))
    }))
    useSessionStore.getState().failRun('transport-session-1', 'Provider failed')

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('clears the first Agent output wait when disconnect or compaction takes ownership', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Continue the foreground request'
    })
    useSessionStore.getState().setAwaitingFirstAgentOutput('transport-session-1', true)

    useSessionStore.getState().markDisconnected('transport-session-1')
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Retry after reconnect'
    })
    useSessionStore.getState().setAwaitingFirstAgentOutput('transport-session-1', true)
    useSessionStore.getState().beginCompaction('transport-session-1', { supersedeActiveRun: true })

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
  })

  it('hydrates runtime context as a read projection but never authors it in a renderer save', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'session-with-runtime-context',
          projectId: 'default',
          title: 'Plan approval',
          cwd: '/workspace',
          status: 'waiting-plan-approval',
          runtimeContext: {
            version: 1,
            revision: 2,
            plan: {
              artifactId: 'plan-1',
              artifactVersionId: 'plan-version-1',
              artifactChecksum: 'a'.repeat(64),
              approval: 'pending',
              stepStatuses: {}
            }
          },
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      { version: SESSION_MANIFEST_VERSION }
    )

    const projection = useSessionStore.getState().sessions[0]
    expect(projection.runtimeContext).toMatchObject({ revision: 2 })
    expect(toPersistedSession(projection)).not.toHaveProperty('runtimeContext')
  })

  it('applies only newer Delegation policy authority without replacing live Session state', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-delegation',
        projectId: 'project-1',
        revision: 4,
        title: 'Live delegation',
        cwd: '/workspace',
        status: 'idle',
        delegationPolicy: 'allow',
        messages: [],
        createdAt: 1,
        updatedAt: 4
      }
    ])
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-delegation',
      content: 'Keep this live prompt'
    })
    const source = useSessionStore.getState().sessions[0]
    const liveMessages = source.messages
    const liveStatus = source.status

    useSessionStore.getState().applyDelegationPolicyAuthority({
      ...toPersistedSession(source),
      revision: 6,
      delegationPolicy: 'deny',
      messages: [],
      status: 'idle',
      updatedAt: source.updatedAt + 10
    })

    const denied = useSessionStore.getState().sessions[0]
    expect(denied).toMatchObject({
      revision: 6,
      delegationPolicy: 'deny',
      updatedAt: source.updatedAt + 10
    })
    expect(denied.messages).toBe(liveMessages)
    expect(denied.status).toBe(liveStatus)

    useSessionStore.getState().applyDelegationPolicyAuthority({
      ...toPersistedSession(denied),
      revision: 5,
      delegationPolicy: 'allow',
      updatedAt: denied.updatedAt + 10
    })

    expect(useSessionStore.getState().sessions[0]).toBe(denied)
  })

  it('converges a newer durable Plan authority when message content is unchanged', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const source = useSessionStore.getState().sessions[0]
    const updatedAt = source.updatedAt + 10

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        updatedAt
      }
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: { revision: 1, plan: { approval: 'pending' } },
      updatedAt
    })
  })

  it('reconciles a pending durable Plan while Permission is waiting', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    useSessionStore.getState().setPermissionPending('session-1')
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 10
      }
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      interactionState: { permission: true, plan: true }
    })

    useSessionStore.getState().clearPermissionPending('session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-plan-approval')
  })

  it('drops a settled durable Plan while Permission is waiting', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    useSessionStore.getState().setPermissionPending('session-1')
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'idle',
        runtimeContext: {
          version: 1,
          revision: 2,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'approved',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 10
      }
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      interactionState: { permission: true, plan: false }
    })

    useSessionStore.getState().clearPermissionPending('session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('clears a pending Plan projection when newer durable authority settles it', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const projection = createPlanProjection('version-1')
    useSessionStore.getState().setActivePlanProjection('session-1', projection)
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'idle',
        runtimeContext: {
          version: 1,
          revision: 2,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'approved',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 1
      }
    })

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBeUndefined()
  })

  it('clears a Plan projection when durable authority points to a different version', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const projection = createPlanProjection('version-1')
    useSessionStore.getState().setActivePlanProjection('session-1', projection)
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-2',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 1
      }
    })

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBeUndefined()
  })

  it('keeps the Plan projection object when durable authority is an exact echo', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const projection = createPlanProjection('version-1')
    useSessionStore.getState().setActivePlanProjection('session-1', projection)
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 1
      }
    })

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(projection)
  })

  it('rebases the active Plan projection when Permission advances the runtime revision', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'artifact-version-1',
            artifactVersionId: 'version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const projection = createPlanProjection('version-1')
    useSessionStore.getState().setActivePlanProjection('session-1', projection)
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-permission',
        runtimeContext: {
          ...source.runtimeContext!,
          revision: 2,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run tests',
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
            },
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'b'.repeat(64),
            createdAt: 3
          }
        },
        updatedAt: 3
      },
      mode: 'runtime-context-authority'
    })

    const updated = useSessionStore.getState().sessions[0]
    expect(updated.activePlanProjection).toEqual({ ...projection, revision: 2 })
    expect(updated.runtimeContext).toMatchObject({ revision: 2, permission: { state: 'pending' } })

    useSessionStore.getState().applyDurableSessionProjection({
      source: updated,
      session: {
        ...toPersistedSession(updated),
        runtimeContext: { ...updated.runtimeContext!, revision: 3 },
        updatedAt: 4
      },
      mode: 'permission-authority'
    })

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toEqual({
      ...projection,
      revision: 3
    })
  })

  it('keeps a newer local Plan projection when an older lifecycle echo arrives', () => {
    const stalePlan = {
      artifactId: 'artifact-version-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'a'.repeat(64),
      approval: 'pending' as const,
      stepStatuses: {}
    }
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: stalePlan
        },
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const newerProjection = {
      ...createPlanProjection('version-1'),
      revision: 2,
      approval: 'approved' as const,
      lifecycle: 'approved' as const,
      requiresExplicitContinuation: true
    }
    useSessionStore.getState().setActivePlanProjection('session-1', newerProjection)
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: stalePlan
        },
        updatedAt: 3
      },
      mode: 'runtime-context-authority'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      interactionState: { plan: false },
      activePlanProjection: newerProjection
    })

    useSessionStore.getState().finishRun('session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('does not replace newer local conversation state when a durable Plan authority arrives', () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: 'project-1',
      content: 'Create a plan'
    })
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'run-1',
      eventId: 'agent-output-1',
      promptMessageId: prompt?.messageId,
      content: 'The plan is ready.'
    })
    useSessionStore.getState().finishRun('session-1')

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 2,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        updatedAt: source.updatedAt + 10
      }
    })

    const projected = useSessionStore.getState().sessions[0]
    expect(projected.status).toBe('waiting-plan-approval')
    expect(projected.runtimeContext?.revision).toBe(2)
    expect(projected.messages.map((message) => message.content)).toEqual([
      'Create a plan',
      'The plan is ready.'
    ])
    expect(projected.conversationGraph?.messages.map((message) => message.content)).toEqual([
      'Create a plan',
      'The plan is ready.'
    ])
  })

  it('rejects an older durable Plan authority revision', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 3,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            stepStatuses: {}
          }
        },
        messages: [],
        createdAt: 1,
        updatedAt: 20
      }
    ])
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        status: 'idle',
        runtimeContext: { version: 1, revision: 2 },
        updatedAt: 30
      }
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: { revision: 3, plan: { approval: 'pending' } },
      updatedAt: 20
    })
  })

  it('keeps a current Plan projection when a durable Session update echoes back', () => {
    const persistedPlan = {
      artifactId: 'artifact-version-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'a'.repeat(64),
      approval: 'pending' as const,
      stepStatuses: {}
    }
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        runtimeContext: { version: 1, revision: 1, plan: persistedPlan },
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    const projection = createPlanProjection('version-1')
    useSessionStore.getState().setActivePlanProjection('session-1', projection)

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Plan approval',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 1, plan: persistedPlan },
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })

    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(projection)
  })

  it('preserves pending summary metadata edits when lazy hydration finishes', () => {
    useSessionStore.getState().hydrateSessionSummaries(
      [
        {
          number: 1,
          id: 'session-1',
          projectId: 'project-1',
          title: 'Original title',
          status: 'idle',
          presentedStatus: 'idle',
          pinned: false,
          revision: 1,
          activeMessageCount: 1,
          artifactCount: 0,
          filesRevision: 0,
          createdAt: 1,
          updatedAt: 2,
          needsStartupRecovery: false
        }
      ],
      undefined
    )
    useSessionStore.getState().renameSession('session-1', 'Pending title')
    useSessionStore.getState().togglePinned('session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1' ? { ...session, archivedAt: 3 } : session
      )
    }))

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Original title',
      cwd: '/workspace',
      status: 'idle',
      pinned: false,
      revision: 1,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Loaded content',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Pending title',
      unsavedTitle: true,
      pinned: true,
      archivedAt: 3,
      messages: [{ id: 'message-1' }]
    })
    expect(useSessionStore.getState().sessions[0]?.contentLoaded).not.toBe(false)
  })

  it('applies archive state from an older durable Session update without losing newer local state', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Newer local state',
        cwd: '/workspace',
        status: 'idle',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Keep this local message.',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2
          }
        ],
        createdAt: 1,
        updatedAt: 20
      }
    ])

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Older durable state',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      archivedAt: 10,
      createdAt: 1,
      updatedAt: 10
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Newer local state',
      archivedAt: 10,
      messages: [{ id: 'message-1' }]
    })
  })

  it('keeps an unsaved local title when a newer remote Session projection arrives', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [
          {
            id: 'local-message',
            role: 'user',
            content: 'Keep this local message.',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    useSessionStore.getState().renameSession('session-1', 'Local draft')

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Remote title',
      cwd: '/workspace',
      status: 'idle',
      revision: 2,
      pinned: true,
      permissionProfile: 'full',
      messages: [
        {
          id: 'local-message',
          role: 'user',
          content: 'Keep this local message.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'remote-message',
          role: 'agent',
          content: 'Saved in another window',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      title: 'Local draft',
      unsavedTitle: true,
      pinned: true,
      permissionProfile: 'full',
      revision: 2,
      messages: [{ id: 'local-message' }, { id: 'remote-message' }]
    })
    expect(toPersistedSession(session)).not.toHaveProperty('unsavedTitle')
  })

  it('applies a newer remote title when the local Session title was not renamed', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Remote title',
      cwd: '/workspace',
      status: 'idle',
      revision: 2,
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })

    expect(useSessionStore.getState().sessions[0].title).toBe('Remote title')
  })

  it('does not mark a no-op rename as an unsaved title', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const before = useSessionStore.getState().sessions[0]
    useSessionStore.getState().renameSession('session-1', '  Original  ')
    expect(useSessionStore.getState().sessions[0]).toBe(before)
    expect(useSessionStore.getState().sessions[0].unsavedTitle).toBeUndefined()

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Remote title',
      cwd: '/workspace',
      status: 'idle',
      revision: 2,
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })
    expect(useSessionStore.getState().sessions[0].title).toBe('Remote title')
  })

  it('clears an unsaved title when a newer remote projection already has the local title', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    useSessionStore.getState().renameSession('session-1', 'Local draft')

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Local draft',
      cwd: '/workspace',
      status: 'idle',
      revision: 2,
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })
    expect(useSessionStore.getState().sessions[0].title).toBe('Local draft')
    expect(useSessionStore.getState().sessions[0].unsavedTitle).toBeUndefined()

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Remote later',
      cwd: '/workspace',
      status: 'idle',
      revision: 3,
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 2
    })
    expect(useSessionStore.getState().sessions[0].title).toBe('Remote later')
  })

  it('clears an unsaved title after a durable save acknowledgement even if the live Session advanced', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    useSessionStore.getState().renameSession('session-1', 'Local draft')
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().togglePinned('session-1')
    const live = useSessionStore.getState().sessions[0]
    expect(live).not.toBe(source)
    expect(live.unsavedTitle).toBe(true)

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(live),
        title: 'Local draft',
        revision: 2,
        updatedAt: live.updatedAt + 1
      },
      mode: 'replace-persisted-if-current'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Local draft',
      pinned: true
    })
    expect(useSessionStore.getState().sessions[0].unsavedTitle).toBeUndefined()

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Remote later',
      cwd: '/workspace',
      status: 'idle',
      revision: 3,
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 2
    })
    expect(useSessionStore.getState().sessions[0].title).toBe('Remote later')
  })

  it('keeps a newer unsaved title when a durable save acknowledgement is for the previous title', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Original',
        cwd: '/workspace',
        status: 'idle',
        revision: 1,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    ])
    useSessionStore.getState().renameSession('session-1', 'Local draft')
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().renameSession('session-1', 'Even newer')
    expect(useSessionStore.getState().sessions[0]).not.toBe(source)

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        title: 'Local draft',
        revision: 2,
        updatedAt: source.updatedAt + 1
      },
      mode: 'replace-persisted-if-current'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Even newer',
      unsavedTitle: true
    })
  })

  it('merges a stale-timestamp child completion by durable identities without clearing root transient state', () => {
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'delegate',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const base: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Streaming root',
      cwd: '/workspace',
      status: 'running',
      messages: [rootMessage],
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 20,
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: { records: [] },
        pdfContext: createPdfContext()
      },
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [rootMessage],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      })
    }
    useSessionStore.getState().hydrateSessions([base])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        agentPromptInFlight: true,
        awaitingFirstAgentOutput: true,
        conversationGraph: session.conversationGraph
          ? {
              ...session.conversationGraph,
              branches: session.conversationGraph.branches.map((branch) => ({
                ...branch,
                headMessageId: 'root-streaming-answer',
                updatedAt: 21
              })),
              messages: [
                ...session.conversationGraph.messages,
                {
                  id: 'root-streaming-answer',
                  role: 'agent' as const,
                  content: 'still streaming',
                  status: 'streaming' as const,
                  eventIds: [],
                  agentFrameId: session.conversationGraph.rootFrameId,
                  introducedOnBranchId: session.conversationGraph.branches[0].id,
                  parentMessageId: 'root-message',
                  createdAt: 21,
                  updatedAt: 21
                }
              ],
              activities: [
                {
                  id: 'root-live-tool',
                  kind: 'tool' as const,
                  title: 'live',
                  status: 'in_progress' as const,
                  sortIndex: 1,
                  eventIds: [],
                  createdAt: 21,
                  updatedAt: 21,
                  agentFrameId: session.conversationGraph.rootFrameId,
                  messageBranchId: session.conversationGraph.branches[0].id,
                  promptMessageId: 'root-message',
                  runtimeSegmentId: session.conversationGraph.runtimeSegments[0].id
                }
              ]
            }
          : undefined
      }))
    }))
    const childGraph = structuredClone(base.conversationGraph!)
    childGraph.frames.push({
      id: 'child-frame',
      parentFrameId: childGraph.rootFrameId,
      originMessageId: 'root-message',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 2,
      completedAt: 8
    })
    childGraph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 2,
      updatedAt: 8
    })
    childGraph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'work',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: {
          rootMessageId: 'root-message',
          toolInvocationId: 'delegate-call'
        },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'child-answer',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        artifactIds: ['version-1'],
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-prompt',
        createdAt: 8,
        updatedAt: 8
      }
    )

    useSessionStore.getState().upsertPersistedSession({
      ...base,
      updatedAt: 10,
      runtimeContext: {
        version: 1,
        revision: 2,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  status: 'completed',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: [],
                  startedAt: 2,
                  endedAt: 8,
                  terminalMessageId: 'child-answer'
                }
              ]
            }
          ]
        }
      },
      conversationGraph: childGraph,
      artifacts: [
        {
          id: 'version-1',
          artifactId: 'artifact-1',
          versionId: 'version-1',
          kind: 'managed-file',
          path: 'result.md'
        }
      ],
      filesRevision: 2
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true,
      runtimeContext: { revision: 2, pdfContext: createPdfContext() },
      filesRevision: 2,
      artifacts: [{ id: 'version-1' }]
    })
    expect(useSessionStore.getState().sessions[0].conversationGraph?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'root-streaming-answer', status: 'streaming' }),
        expect.objectContaining({ id: 'child-answer', artifactIds: ['version-1'] })
      ])
    )
    expect(useSessionStore.getState().sessions[0].conversationGraph?.activities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'root-live-tool' })])
    )
  })

  it('preserves PDF context when delegated authority advances', () => {
    const pdfContext = createPdfContext()
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Delegated work',
        cwd: '/workspace',
        status: 'running',
        messages: [],
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: { records: [] },
          pdfContext
        },
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const source = useSessionStore.getState().sessions[0]

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        runtimeContext: {
          version: 1,
          revision: 2,
          delegatedWork: { records: [{ agentFrameId: 'child-frame', attempts: [] }] }
        },
        updatedAt: 3
      },
      mode: 'delegated-authority'
    })

    expect(useSessionStore.getState().sessions[0].runtimeContext).toMatchObject({
      revision: 2,
      delegatedWork: { records: [{ agentFrameId: 'child-frame' }] },
      pdfContext
    })
  })

  it('merges equal-timestamp higher runtime and files revisions without replacing another owner plan', () => {
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'keep local root',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const rootGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [rootMessage],
      createdAt: 1,
      updatedAt: 1
    })
    const persistedPlan = {
      artifactId: 'plan',
      artifactVersionId: 'plan-v1',
      artifactChecksum: 'a'.repeat(64),
      approval: 'pending' as const,
      stepStatuses: {}
    }
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'local',
        cwd: '/workspace',
        status: 'running',
        messages: [rootMessage],
        runtimeContext: { version: 1, revision: 1, plan: persistedPlan },
        conversationGraph: rootGraph,
        artifacts: [{ id: 'old-version', kind: 'managed-file', path: 'old.md' }],
        filesRevision: 1,
        createdAt: 1,
        updatedAt: 20
      }
    ])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) => ({ ...entry, agentPromptInFlight: true }))
    }))
    const childGraph = structuredClone(rootGraph)
    childGraph.frames.push({
      id: 'child-frame',
      parentFrameId: childGraph.rootFrameId,
      originMessageId: 'root-message',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 2,
      completedAt: 3
    })
    childGraph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 2,
      updatedAt: 3
    })
    childGraph.messages.push({
      id: 'child-answer',
      role: 'agent',
      content: 'child result',
      status: 'complete',
      eventIds: [],
      artifactIds: ['child-version'],
      agentFrameId: 'child-frame',
      introducedOnBranchId: 'child-branch',
      createdAt: 3,
      updatedAt: 3
    })

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'durable child',
      cwd: '/workspace',
      status: 'idle',
      messages: [rootMessage],
      runtimeContext: {
        version: 1,
        revision: 2,
        delegatedWork: {
          records: [{ agentFrameId: 'child-frame', attempts: [] }]
        }
      },
      conversationGraph: childGraph,
      artifacts: [{ id: 'child-version', kind: 'managed-file', path: 'child.md' }],
      filesRevision: 2,
      createdAt: 1,
      updatedAt: 20
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'local',
      status: 'running',
      agentPromptInFlight: true,
      runtimeContext: {
        revision: 2,
        plan: persistedPlan,
        delegatedWork: { records: [{}] }
      },
      filesRevision: 2,
      artifacts: [{ id: 'old-version' }, { id: 'child-version' }]
    })
    expect(
      useSessionStore.getState().sessions[0].conversationGraph?.messages.map(({ id }) => id)
    ).toEqual(expect.arrayContaining(['root-message', 'child-answer']))
  })

  it('merges new durable identities at equal timestamp and revisions while local identity conflicts win', () => {
    const localMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'newer local bytes',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 5
    }
    const localGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [localMessage],
      createdAt: 1,
      updatedAt: 5
    })
    const base: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'local',
      cwd: '/workspace',
      status: 'running',
      messages: [localMessage],
      runtimeContext: { version: 1, revision: 4, delegatedWork: { records: [] } },
      conversationGraph: localGraph,
      artifacts: [{ id: 'local-version', kind: 'managed-file', path: 'local.md' }],
      filesRevision: 4,
      createdAt: 1,
      updatedAt: 20
    }
    useSessionStore.getState().hydrateSessions([base])
    const durableGraph = structuredClone(localGraph)
    durableGraph.messages[0].content = 'stale durable bytes'
    durableGraph.frames.push({
      id: 'child-frame',
      parentFrameId: durableGraph.rootFrameId,
      originMessageId: 'root-message',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 6
    })
    durableGraph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: undefined,
      createdAt: 6,
      updatedAt: 6
    })

    useSessionStore.getState().upsertPersistedSession({
      ...base,
      messages: [{ ...localMessage, content: 'stale durable bytes' }],
      conversationGraph: durableGraph,
      runtimeContext: {
        version: 1,
        revision: 4,
        delegatedWork: {
          records: [{ agentFrameId: 'child-frame', attempts: [] }]
        }
      },
      artifacts: [{ id: 'child-version', kind: 'managed-file', path: 'child.md' }]
    })

    const merged = useSessionStore.getState().sessions[0]
    expect(merged.conversationGraph?.messages[0].content).toBe('newer local bytes')
    expect(merged.conversationGraph?.frames.map(({ id }) => id)).toContain('child-frame')
    expect(
      merged.runtimeContext?.delegatedWork?.records.map(({ agentFrameId }) => agentFrameId)
    ).toEqual(['child-frame'])
    expect(merged.artifacts?.map(({ id }) => id)).toEqual(['local-version', 'child-version'])
  })

  it('converges a newer child snapshot without dropping current-only root streaming state', () => {
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'root prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const durableBase: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'root',
      cwd: '/workspace',
      status: 'running',
      messages: [rootMessage],
      runtimeContext: { version: 1, revision: 1, delegatedWork: { records: [] } },
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [rootMessage],
        createdAt: 1,
        updatedAt: 1
      }),
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 10
    }
    useSessionStore.getState().hydrateSessions([durableBase])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((entry) => {
        const graph = structuredClone(entry.conversationGraph!)
        graph.messages.push({
          id: 'root-streaming',
          role: 'agent',
          content: 'local token',
          status: 'streaming',
          streamId: 'root-run',
          responseToMessageId: 'root-message',
          eventIds: [],
          agentFrameId: graph.rootFrameId,
          introducedOnBranchId: graph.branches[0].id,
          parentMessageId: 'root-message',
          createdAt: 11,
          updatedAt: 11
        })
        graph.branches[0].headMessageId = 'root-streaming'
        graph.branches[0].updatedAt = 11
        graph.activities.push({
          id: 'root-live-tool',
          kind: 'tool',
          title: 'streaming tool',
          status: 'in_progress',
          sortIndex: 1,
          eventIds: [],
          createdAt: 11,
          updatedAt: 11,
          agentFrameId: graph.rootFrameId,
          messageBranchId: graph.branches[0].id,
          promptMessageId: 'root-message',
          runtimeSegmentId: graph.runtimeSegments[0].id
        })
        return {
          ...entry,
          messages: [
            ...entry.messages,
            {
              id: 'root-streaming',
              role: 'agent',
              content: 'local token',
              status: 'streaming',
              streamId: 'root-run',
              responseToMessageId: 'root-message',
              eventIds: [],
              createdAt: 11,
              updatedAt: 11
            }
          ],
          conversationGraph: graph,
          agentPromptInFlight: true,
          awaitingFirstAgentOutput: true
        }
      })
    }))
    const childGraph = structuredClone(durableBase.conversationGraph!)
    childGraph.frames.push({
      id: 'child-frame',
      parentFrameId: childGraph.rootFrameId,
      originMessageId: 'root-message',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 2,
      completedAt: 12
    })
    childGraph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 2,
      updatedAt: 12
    })
    childGraph.messages.push({
      id: 'child-answer',
      role: 'agent',
      content: 'child complete',
      status: 'complete',
      eventIds: [],
      artifactIds: ['child-version'],
      agentFrameId: 'child-frame',
      introducedOnBranchId: 'child-branch',
      createdAt: 12,
      updatedAt: 12
    })

    useSessionStore.getState().upsertPersistedSession({
      ...durableBase,
      status: 'idle',
      updatedAt: 20,
      runtimeContext: {
        version: 1,
        revision: 2,
        delegatedWork: {
          records: [{ agentFrameId: 'child-frame', attempts: [] }]
        }
      },
      conversationGraph: childGraph,
      filesRevision: 2,
      artifacts: [{ id: 'child-version', kind: 'managed-file', path: 'child.md' }]
    })

    let converged = useSessionStore.getState().sessions[0]
    expect(converged).toMatchObject({
      status: 'idle',
      updatedAt: 20,
      runtimeContext: { revision: 2 },
      filesRevision: 2,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
    expect(converged.conversationGraph?.messages.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['root-streaming', 'child-answer'])
    )
    expect(converged.messages.map(({ id }) => id)).toContain('root-streaming')
    expect(converged.conversationGraph?.activities.map(({ id }) => id)).toContain('root-live-tool')
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'session-1',
      toolCallId: 'root-live-tool',
      eventId: 'root-live-tool-complete',
      promptMessageId: 'root-message',
      status: 'completed'
    })
    useSessionStore.getState().finishRun('session-1', undefined, 'root-message')
    converged = useSessionStore.getState().sessions[0]
    expect(converged.conversationGraphSyncBlocked).toBeUndefined()
    expect(
      converged.conversationGraph?.branches.find(
        ({ agentFrameId }) => agentFrameId === converged.conversationGraph?.rootFrameId
      )?.headMessageId
    ).toBe('root-streaming')
    expect(
      converged.conversationGraph?.messages.find(({ id }) => id === 'root-streaming')?.status
    ).toBe('complete')
    expect(
      converged.conversationGraph?.activities.find(({ id }) => id === 'root-live-tool')?.status
    ).toBe('completed')
    expect(toPersistedSession(converged).conversationGraph?.messages.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['root-streaming', 'child-answer'])
    )
  })

  it('hydrates durable reliable-message commands without dropping same-revision renderer owners', () => {
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'root prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const base: PersistedChatSession = {
      id: 'session-message-owner',
      projectId: 'project-message-owner',
      title: 'message owner',
      cwd: '/workspace',
      status: 'idle',
      messages: [rootMessage],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-message-owner',
        messages: [rootMessage],
        createdAt: 1,
        updatedAt: 1
      }),
      runtimeContext: { version: 1, revision: 3, delegatedWork: { records: [] } },
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 3
    }
    useSessionStore.getState().hydrateSessions([base])
    const graph = base.conversationGraph!
    const command = {
      messageId: 'durable-message-1',
      requestId: 'durable-request-1',
      sourcePrincipal: graph.rootFrameId,
      canonicalDigest: 'a'.repeat(64),
      sourceFrameId: graph.rootFrameId,
      targetFrameId: 'child-frame',
      targetAttemptId: 'child-attempt',
      rootOriginMessageId: rootMessage.id,
      callerRootMessageId: rootMessage.id,
      rootBranchId: graph.branches[0].id,
      rootBranchRevision: `${graph.branches[0].id}:${graph.branches[0].createdAt}`,
      direction: 'to_child' as const,
      disposition: 'message' as const,
      text: 'durable directive',
      kind: 'info' as const,
      laneSequence: 1,
      queuedAt: 2,
      receipt: { status: 'queued' as const }
    }

    useSessionStore.getState().upsertPersistedSession({
      ...base,
      runtimeContext: {
        version: 1,
        revision: 3,
        delegatedWork: { records: [], messageCommands: [command] }
      }
    })

    expect(
      useSessionStore.getState().sessions[0].runtimeContext?.delegatedWork?.messageCommands
    ).toEqual([command])
  })

  it('accepts a newer durable root Branch head before saving the next streamed chunk', () => {
    const prompt = {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'Delegate the analysis',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const base: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Root stream save echo',
      cwd: '/workspace',
      status: 'running',
      messages: [prompt],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [prompt],
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    useSessionStore.getState().hydrateSessions([base])
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: base.id,
      streamId: 'root-stream',
      eventId: 'first-chunk',
      promptMessageId: prompt.id,
      content: 'De'
    })

    const durable = toPersistedSession(useSessionStore.getState().sessions[0])
    durable.updatedAt += 10
    useSessionStore.getState().upsertPersistedSession(durable)
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: base.id,
      streamId: 'root-stream',
      eventId: 'second-chunk',
      promptMessageId: prompt.id,
      content: 'legation complete'
    })

    const current = useSessionStore.getState().sessions[0]
    expect(() => toPersistedSession(current)).not.toThrow()
    expect(
      current.conversationGraph?.branches.find(
        ({ id }) => id === current.conversationGraph?.frames[0].activeBranchId
      )?.headMessageId
    ).toBe(current.messages.at(-1)?.id)
  })

  it('restores branch-bound Plan history after saving and hydrating a Session', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Plan replacement',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      { version: SESSION_MANIFEST_VERSION }
    )
    const original = {
      ...createPlanProjection('version-1'),
      originatingPromptMessageId: 'prompt-a'
    }
    const replacement = {
      ...createPlanProjection('version-2'),
      originatingPromptMessageId: 'prompt-b'
    }

    useSessionStore.getState().setActivePlanProjection('session-1', original)
    useSessionStore.getState().setActivePlanProjection('session-1', replacement)

    const session = useSessionStore.getState().sessions[0]
    expect(session.activePlanProjection).toBe(replacement)
    expect(session.planHistoryProjections).toEqual([original])
    const persisted = toPersistedSession(session)
    expect(persisted.planHistoryProjections).toEqual([
      {
        ...original,
        stepStates: { 'Step version-1': { status: 'not_started' } }
      }
    ])

    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().hydrateSessions([persisted], {
      version: SESSION_MANIFEST_VERSION
    })

    expect(useSessionStore.getState().sessions[0].planHistoryProjections).toEqual(
      persisted.planHistoryProjections
    )
  })

  it('does not drop Plan history when a newer durable Session echo omits UI history', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan replacement',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const original = {
      ...createPlanProjection('version-1'),
      originatingPromptMessageId: 'prompt-a'
    }
    useSessionStore.getState().setActivePlanProjection('session-1', original)
    useSessionStore.getState().setActivePlanProjection('session-1', {
      ...createPlanProjection('version-2'),
      originatingPromptMessageId: 'prompt-b'
    })

    useSessionStore.getState().upsertPersistedSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Newer durable echo',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: Date.now() + 1
    })

    expect(useSessionStore.getState().sessions[0].planHistoryProjections).toEqual([original])
  })

  it('releases renderer Composer blocking when the active Plan is rejected', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Plan rejection',
          cwd: '/workspace',
          status: 'waiting-plan-approval',
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      { version: SESSION_MANIFEST_VERSION }
    )
    const rejected = {
      ...createPlanProjection('version-1'),
      approval: 'rejected' as const,
      lifecycle: 'rejected' as const
    }

    useSessionStore.getState().setActivePlanProjection('session-1', rejected)

    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('keeps an approved Plan idle when no execution turn is active', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plan approval',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])
    const approved = {
      ...createPlanProjection('version-1'),
      approval: 'approved' as const,
      lifecycle: 'approved' as const,
      requiresExplicitContinuation: true
    }

    useSessionStore.getState().setActivePlanProjection('session-1', approved)

    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      status: 'idle',
      activePlanProjection: { approval: 'approved', requiresExplicitContinuation: true }
    })
    expect(session.activeRun).toBeUndefined()
  })

  it('keeps a restored pending Plan awaiting review when no response interaction is active', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Orphaned Plan',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])

    useSessionStore
      .getState()
      .setActivePlanProjection('session-1', createPlanProjection('version-1'))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      activePlanProjection: { approval: 'pending' }
    })
  })

  it('keeps a pending Plan awaiting review after its Agent interaction ended without a decision', () => {
    useSessionStore.getState().hydrateSessions([
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Settled Plan interaction',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      }
    ])

    useSessionStore
      .getState()
      .setActivePlanProjection('session-1', createPlanProjection('version-1'))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      activePlanProjection: { approval: 'pending' },
      interactionState: { plan: true }
    })

    useSessionStore.getState().setPermissionPending('session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')

    useSessionStore.getState().clearPermissionPending('session-1')

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-plan-approval')
  })

  it('returns a settled blocked Plan session to idle', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'blocked-plan-session',
          projectId: 'default',
          status: 'running'
        } as ChatSession
      ]
    })

    useSessionStore.getState().setActivePlanProjection('blocked-plan-session', {
      lifecycle: 'blocked',
      approval: 'approved'
    } as NonNullable<ChatSession['activePlanProjection']>)

    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('uses the provided session id when the first user message creates a session', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project'
    })

    expect(result?.sessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: 'transport-session-1',
        cwd: '/workspace/project',
        title: 'Help me inspect this notebook',
        status: 'running',
        activeRun: {
          promptMessageId: result?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: result?.messageId,
            role: 'user',
            content: 'Help me inspect this notebook',
            status: 'complete'
          })
        ]
      })
    ])
  })

  it('deduplicates a caller-provided user message id', () => {
    const input = {
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1',
      content: 'Analyze the completed compute job',
      cwd: '/workspace/project'
    }

    const first = useSessionStore.getState().appendUserMessage(input)
    const duplicate = useSessionStore.getState().appendUserMessage(input)
    const conflict = useSessionStore.getState().appendUserMessage({
      ...input,
      content: 'Different prompt with the same identity'
    })

    expect(first).toEqual({
      sessionId: 'transport-session-1',
      messageId: 'automatic-analysis-message-1'
    })
    expect(duplicate).toEqual(first)
    expect(conflict).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(1)
  })

  it('creates a pending first message before a runtime session id exists', () => {
    const result = useSessionStore.getState().appendPendingUserMessage({
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project',
      delegationPolicy: 'deny',
      enabledComputeHosts: ['ssh:lab', 'ssh:available'],
      selectedComputeHosts: ['ssh:lab']
    })

    expect(result?.sessionId).toMatch(/^pending-session-/)
    expect(useSessionStore.getState().selectedSessionId).toBe(result?.sessionId)
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: result?.sessionId,
        isPending: true,
        cwd: '/workspace/project',
        delegationPolicy: 'deny',
        enabledComputeHosts: ['ssh:lab', 'ssh:available'],
        selectedComputeHosts: ['ssh:lab'],
        title: 'Help me inspect this notebook',
        status: 'running',
        activeRun: {
          promptMessageId: result?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: result?.messageId,
            role: 'user',
            content: 'Help me inspect this notebook',
            status: 'complete'
          })
        ]
      })
    ])
  })

  it('stores uploaded attachments on user messages in insertion order', () => {
    const firstUpload = createUploadAttachment({ id: 'upload-1', name: 'first.png' })
    const secondUpload = createUploadAttachment({
      id: 'upload-2',
      name: 'second.png',
      originalName: 'second.png',
      path: '/Users/example/.open-science/uploads/default-project/.pending/second.png'
    })

    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Describe these',
      cwd: '/workspace/project',
      attachments: [firstUpload, secondUpload]
    })

    expect(useSessionStore.getState().sessions[0].messages[0]).toMatchObject({
      id: result?.messageId,
      role: 'user',
      content: 'Describe these',
      uploads: [
        expect.objectContaining({ id: 'upload-1', name: 'first.png' }),
        expect.objectContaining({ id: 'upload-2', name: 'second.png' })
      ]
    })
  })

  it('allows an attachments-only user message and replaces uploads after session binding', () => {
    const pendingUpload = createUploadAttachment()
    const finalizedUpload = createUploadAttachment({
      sessionId: 'transport-session-1',
      path: '/Users/example/.open-science/uploads/default-project/transport-session-1/first.png'
    })
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: '',
      cwd: '/workspace/project',
      attachments: [pendingUpload]
    })

    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().replaceMessageUploads({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId ?? '',
      uploads: [finalizedUpload]
    })

    const finalizedSession = useSessionStore.getState().sessions[0]
    useSessionStore.getState().replaceMessageUploads({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId ?? '',
      uploads: [finalizedUpload]
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      title: 'Attached first.png',
      messages: [
        expect.objectContaining({
          id: pending?.messageId,
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
    expect(finalizedSession.filesRevision).toBe(1)
    expect(finalizedSession.messages[0].uploads?.[0]).not.toHaveProperty('path')
    expect(
      finalizedSession.conversationGraph?.messages.find(
        (message) => message.id === pending?.messageId
      )?.uploads?.[0]
    ).toMatchObject({ id: 'upload-1', sessionId: 'transport-session-1' })
    expect(useSessionStore.getState().sessions[0]).toBe(finalizedSession)
  })

  it('increments the file revision when removing a message with finalized uploads', () => {
    const pending = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Analyze',
      attachments: [createUploadAttachment()]
    })
    const finalizedUpload = createUploadAttachment({
      sessionId: 'transport-session-1',
      path: '/Users/example/.open-science/uploads/default-project/transport-session-1/first.png'
    })
    useSessionStore.getState().replaceMessageUploads({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId ?? '',
      uploads: [finalizedUpload]
    })

    useSessionStore.getState().removeMessage('transport-session-1', pending?.messageId ?? '')

    const session = useSessionStore.getState().sessions[0]
    expect(session.filesRevision).toBe(2)
    expect(session.messages.some((message) => message.id === pending?.messageId)).toBe(false)
    expect(
      toPersistedSession(session).messages.some((message) => message.id === pending?.messageId)
    ).toBe(false)
    expect(
      session.conversationGraph?.messages.some((message) => message.id === pending?.messageId)
    ).toBe(true)
    expect(session.conversationGraph?.branches).toHaveLength(2)
    const activeFrame = session.conversationGraph?.frames.find(
      (frame) => frame.id === session.conversationGraph?.activeFrameId
    )
    const activeBranch = session.conversationGraph?.branches.find(
      (branch) => branch.id === activeFrame?.activeBranchId
    )
    expect(activeBranch?.headMessageId).toBeUndefined()
  })

  it('binds a pending session to the runtime session id without rewriting the prompt', () => {
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Help me inspect this notebook',
      cwd: '/workspace/project',
      delegationPolicy: 'deny'
    })

    const bound = useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:codex-shared'
    })

    expect(bound).toEqual({
      sessionId: 'transport-session-1',
      messageId: pending?.messageId
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: 'transport-session-1',
        isPending: false,
        cwd: '/workspace/project',
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:codex-shared',
        delegationPolicy: 'deny',
        status: 'running',
        activeRun: {
          promptMessageId: pending?.messageId,
          startedAt: Date.now()
        },
        messages: [
          expect.objectContaining({
            id: pending?.messageId,
            content: 'Help me inspect this notebook'
          })
        ]
      })
    ])
  })

  it('appends follow-up user messages to the same session and restarts the run', () => {
    const first = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Start a pathway analysis'
    })

    const second = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Add enrichment notes'
    })

    const session = useSessionStore.getState().sessions[0]

    expect(first?.sessionId).toBe('transport-session-1')
    expect(second?.sessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(session.status).toBe('running')
    expect(session.activeRun).toEqual({
      promptMessageId: second?.messageId,
      startedAt: Date.now()
    })
    expect(session.messages.map((message) => message.content)).toEqual([
      'Start a pathway analysis',
      'Add enrichment notes'
    ])
  })

  it('persists the model selected when each run starts', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First run',
      agentModel: 'model-a'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Second run',
      agentModel: 'model-b'
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session.agentModel).toBe('model-b')
    expect(toPersistedSession(session).agentModel).toBe('model-b')
  })

  it('stamps the resolved agent target onto each sent user message', () => {
    const firstTarget = {
      frameworkId: 'claude-code' as const,
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'default' as const
    }
    const secondTarget = {
      frameworkId: 'codex' as const,
      backendId: 'codex-responses',
      providerId: 'provider-b',
      reasoningEffort: 'high' as const
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First run',
      agentTarget: firstTarget
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Second run',
      agentTarget: secondTarget
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.map((message) => message.agentTarget)).toEqual([
      firstTarget,
      secondTarget
    ])
    expect(toPersistedSession(session).messages.map((message) => message.agentTarget)).toEqual([
      firstTarget,
      secondTarget
    ])
  })

  it('leaves the agent target unset when no snapshot is supplied', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First run'
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages[0]).not.toHaveProperty('agentTarget')
  })

  it('keeps an existing Session agentConfiguration when a later send snapshot differs', () => {
    const snapshot = {
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'default' as const
    }
    const preferred = {
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'high' as const
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First run',
      agentConfiguration: snapshot
    })
    useSessionStore.getState().setAgentConfiguration('transport-session-1', preferred)
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Queued snapshot',
      agentModel: 'model-a',
      agentConfiguration: snapshot
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session.agentConfiguration).toEqual(preferred)
    expect(session.agentModel).toBe('model-a')
    expect(toPersistedSession(session).agentConfiguration).toEqual(preferred)
  })

  it('preserves Session activity time when reconciling a legacy agent configuration', () => {
    const updatedAt = Date.now() - 60_000
    const configuration = {
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'default' as const
    }
    useSessionStore.setState({
      sessions: [
        {
          id: 'legacy-session',
          projectId: 'default-project',
          title: 'Legacy Session',
          cwd: '/workspace/project',
          status: 'idle',
          messages: [],
          filesRevision: 0,
          createdAt: updatedAt - 60_000,
          updatedAt
        } as ChatSession
      ],
      selectedSessionId: 'legacy-session'
    })

    useSessionStore
      .getState()
      .setAgentConfiguration('legacy-session', configuration, { preserveUpdatedAt: true })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      agentConfiguration: configuration,
      updatedAt
    })
  })

  it('materializes a missing Session agentConfiguration on a later send', () => {
    const configuration = {
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'default' as const
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First run'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Follow-up',
      agentConfiguration: configuration
    })

    expect(useSessionStore.getState().sessions[0].agentConfiguration).toEqual(configuration)
  })

  it('merges streamed agent chunks by stream id and completes them when the run stops', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })

    const firstChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    const secondChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-2',
      content: ' complete'
    })

    useSessionStore.getState().finishRun(
      'transport-session-1',
      {
        inputTokens: 31,
        cacheTokens: 15,
        outputTokens: 14,
        turnCount: 3
      },
      undefined,
      undefined,
      [
        { id: 'call-1', index: 0, inputTokens: 10, cacheTokens: 5, outputTokens: 4 },
        { id: 'call-2', index: 1, inputTokens: 11, cacheTokens: 5, outputTokens: 5 },
        { id: 'call-3', index: 2, inputTokens: 10, cacheTokens: 5, outputTokens: 5 }
      ]
    )

    const session = useSessionStore.getState().sessions[0]
    const agentMessage = session.messages[1]

    expect(secondChunk?.messageId).toBe(firstChunk?.messageId)
    expect(agentMessage).toMatchObject({
      id: firstChunk?.messageId,
      role: 'agent',
      content: 'Summary complete',
      streamId: 'assistant-message-1',
      responseToMessageId: result?.messageId,
      eventIds: ['event-1', 'event-2'],
      status: 'complete',
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 3 },
      modelCallUsage: [
        { id: 'call-1', index: 0, inputTokens: 10, cacheTokens: 5, outputTokens: 4 },
        { id: 'call-2', index: 1, inputTokens: 11, cacheTokens: 5, outputTokens: 5 },
        { id: 'call-3', index: 2, inputTokens: 10, cacheTokens: 5, outputTokens: 5 }
      ]
    })
    expect(agentMessage.completedAt).toBe(session.updatedAt)
    expect(
      session.conversationGraph?.messages.find((message) => message.id === agentMessage.id)
    ).toMatchObject({
      completedAt: agentMessage.completedAt,
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 3 },
      modelCallUsage: agentMessage.modelCallUsage
    })
    expect(toPersistedSession(session).messages[1]).toMatchObject({
      completedAt: agentMessage.completedAt,
      turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 3 },
      modelCallUsage: agentMessage.modelCallUsage
    })
    expect(session.status).toBe('idle')
    expect(session.activeRun).toBeUndefined()
  })

  it('normalizes a Claude refusal prefix after streamed chunks are merged', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the web',
      agentFrameworkId: 'claude-code'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'API Error: Claude Code is unable to respond to this request, '
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-2',
      content:
        'which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing.'
    })

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages[1]?.content).toBe(
      'The selected model declined to complete this response under its safety policy. Try rephrasing.'
    )
    expect(toPersistedSession(session).messages[1]?.content).toBe(
      'The selected model declined to complete this response under its safety policy. Try rephrasing.'
    )
  })

  it('attaches whole-turn usage only to the final agent message for the active prompt', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Explain the analysis'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'I will inspect the data.'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-2',
      eventId: 'event-2',
      content: 'The analysis is complete.'
    })

    useSessionStore.getState().finishRun('transport-session-1', {
      inputTokens: 120,
      cacheTokens: 30,
      outputTokens: 45
    })

    const agentMessages = useSessionStore
      .getState()
      .sessions[0].messages.filter((message) => message.role === 'agent')
    expect(agentMessages[0].turnUsage).toBeUndefined()
    expect(agentMessages[1].turnUsage).toEqual({
      inputTokens: 120,
      cacheTokens: 30,
      outputTokens: 45
    })
  })

  it('moves cumulative ask-user continuation usage to the final agent message', () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Build the requested workflow'
    })
    expect(prompt).toBeDefined()

    const segments = [
      {
        streamId: 'assistant-before-first-question',
        eventId: 'event-before-first-question',
        content: 'I need the first detail.',
        usage: {
          inputTokens: 10,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 4,
          turnCount: 1
        }
      },
      {
        streamId: 'assistant-before-second-question',
        eventId: 'event-before-second-question',
        content: 'I need one more detail.',
        usage: {
          inputTokens: 30,
          cacheTokens: 8,
          cachedReadTokens: 6,
          cachedWriteTokens: 2,
          outputTokens: 10,
          turnCount: 3
        }
      },
      {
        streamId: 'assistant-after-answers',
        eventId: 'event-after-answers',
        content: 'The workflow is complete.',
        usage: {
          inputTokens: 60,
          cacheTokens: 15,
          cachedReadTokens: 11,
          cachedWriteTokens: 4,
          outputTokens: 18,
          turnCount: 6
        }
      }
    ]

    for (const segment of segments) {
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: segment.streamId,
        eventId: segment.eventId,
        promptMessageId: prompt!.messageId,
        content: segment.content
      })
      useSessionStore.getState().finishRun('transport-session-1', segment.usage, prompt!.messageId)
    }

    const session = useSessionStore.getState().sessions[0]
    const agentMessages = session.messages.filter((message) => message.role === 'agent')
    expect(agentMessages).toHaveLength(3)
    expect(agentMessages[0].turnUsage).toBeUndefined()
    expect(agentMessages[1].turnUsage).toBeUndefined()
    expect(agentMessages[2].turnUsage).toEqual({
      inputTokens: 60,
      cacheTokens: 15,
      cachedReadTokens: 11,
      cachedWriteTokens: 4,
      outputTokens: 18,
      turnCount: 6
    })
    expect(
      session.conversationGraph?.messages.find((message) => message.id === agentMessages[2].id)
        ?.turnUsage
    ).toEqual(agentMessages[2].turnUsage)
    expect(toPersistedSession(session).messages.at(-1)?.turnUsage).toEqual(
      agentMessages[2].turnUsage
    )
  })

  it('marks aggregate ask-user continuation usage unavailable when any segment is unavailable', () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Build the requested workflow'
    })
    expect(prompt).toBeDefined()

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-before-question',
      eventId: 'event-before-question',
      promptMessageId: prompt!.messageId,
      content: 'I need one detail.'
    })
    useSessionStore
      .getState()
      .finishRun(
        'transport-session-1',
        { inputTokens: 10, cacheTokens: 3, outputTokens: 4, turnCount: 1 },
        prompt!.messageId
      )

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-after-answer',
      eventId: 'event-after-answer',
      promptMessageId: prompt!.messageId,
      content: 'The workflow is complete.'
    })
    useSessionStore.getState().finishRun('transport-session-1', undefined, prompt!.messageId)

    const agentMessages = useSessionStore
      .getState()
      .sessions[0].messages.filter((message) => message.role === 'agent')
    expect(agentMessages[0].turnUsage).toBeUndefined()
    expect(agentMessages[0].turnUsageUnavailable).toBeUndefined()
    expect(agentMessages[1].turnUsage).toBeUndefined()
    expect(agentMessages[1].turnUsageUnavailable).toBe(true)
  })

  it('marks only the final agent message when whole-turn usage is unavailable', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Explain the analysis'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'I will inspect the data.'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-2',
      eventId: 'event-2',
      content: 'The analysis is complete.'
    })

    useSessionStore.getState().finishRun('transport-session-1')

    const session = useSessionStore.getState().sessions[0]
    const agentMessages = session.messages.filter((message) => message.role === 'agent')
    expect(agentMessages[0].turnUsageUnavailable).toBeUndefined()
    expect(agentMessages[1].turnUsageUnavailable).toBe(true)
    expect(
      session.conversationGraph?.messages.find((message) => message.id === agentMessages[1].id)
        ?.turnUsageUnavailable
    ).toBe(true)
    expect(toPersistedSession(session).messages.at(-1)?.turnUsageUnavailable).toBe(true)
  })

  it('merges image-only and text chunks into the same agent message', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Draw the result'
    })

    const imageChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-image',
      image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    })
    const textChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-text',
      content: 'Generated chart'
    })

    expect(textChunk?.messageId).toBe(imageChunk?.messageId)
    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      content: 'Generated chart',
      eventIds: ['event-image', 'event-text'],
      images: [{ id: 'event-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
    })
  })

  it('keeps live agent messages within the persisted image count boundary', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Draw variants'
    })

    for (let index = 0; index < 6; index += 1) {
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'assistant-message-1',
        eventId: `event-image-${index}`,
        image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
      })
    }

    expect(useSessionStore.getState().sessions[0].messages[1].images).toHaveLength(4)
    expect(useSessionStore.getState().sessions[0].messages[1].eventIds).toHaveLength(6)
  })

  it('ignores duplicate streamed event ids for the same agent message', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    expect(useSessionStore.getState().sessions[0].messages[1]).toMatchObject({
      content: 'Summary',
      responseToMessageId: result?.messageId,
      eventIds: ['event-1']
    })
  })

  it('keeps session state unchanged when a duplicate streamed event arrives after finish', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Summarize the dataset'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    const finishedSession = useSessionStore.getState().sessions[0]

    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Summary'
    })

    expect(useSessionStore.getState().sessions[0]).toEqual(finishedSession)
  })

  it('marks the active run and streaming agent message as failed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Read the files'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'I started'
    })

    useSessionStore.getState().failRun('transport-session-1', 'Permission denied')

    const session = useSessionStore.getState().sessions[0]
    const failedAt = session.messages[1].failedAt

    expect(session.status).toBe('error')
    expect(session.error).toBe('Permission denied')
    expect(session.activeRun).toBeUndefined()
    expect(failedAt).toEqual(expect.any(Number))
    expect(session.messages[1]).toMatchObject({
      content: 'I started',
      status: 'error',
      failedAt
    })
    expect(
      session.conversationGraph?.messages.find((message) => message.id === session.messages[1].id)
    ).toMatchObject({ status: 'error', failedAt })
    expect(toPersistedSession(session).messages[1]).toMatchObject({
      status: 'error',
      failedAt
    })
  })

  it('derives errorReportable from the message when no explicit flag is passed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Read the files'
    })

    // An opaque/internal failure with no crafted-message match stays reportable.
    useSessionStore.getState().failRun('transport-session-1', 'Agent session could not be created.')
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(true)

    // An app-crafted reminder is recognized by its exact text and is not reportable.
    useSessionStore
      .getState()
      .failRun('transport-session-1', 'Session workspace is missing; start a new conversation.')
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(false)

    // Claude Code's unreachable-API wrapper is recognized without an explicit flag (createSession /
    // persisted pre-flag sessions).
    useSessionStore
      .getState()
      .failRun(
        'transport-session-1',
        'Internal error: API Error: Unable to connect to API (ConnectionRefused)'
      )
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(false)
  })

  it('honors an explicit reportable flag (the runtime tags a model-provider failure)', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Read the files'
    })

    // A model-provider failure: opaque text that WOULD derive reportable=true, but the ACP layer
    // structurally tagged it non-reportable, and the explicit flag wins.
    useSessionStore.getState().failRun('transport-session-1', 'Invalid API key', {
      reportable: false
    })
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(false)
  })

  it('clears errorReportable when a new run starts, so a later error cannot inherit it', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'first turn'
    })
    // A model-provider failure hides the report button.
    useSessionStore.getState().failRun('transport-session-1', 'Invalid API key', {
      reportable: false
    })
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(false)

    // A new turn clears the prior error + flag.
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'second turn'
    })
    expect(useSessionStore.getState().sessions[0].errorReportable).toBeUndefined()

    // A later ACP-layer failure with no explicit flag derives reportable=true — it never inherits the
    // earlier provider error's false.
    useSessionStore.getState().failRun('transport-session-1', 'Agent cancellation failed')
    expect(useSessionStore.getState().sessions[0].errorReportable).toBe(true)
  })

  it('records an artifact finalization error as reportable (an app-layer failure)', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    // Simulate a prior provider error's flag lingering, then an artifact error overwriting it.
    useSessionStore.getState().failRun('transport-session-1', 'Invalid API key', {
      reportable: false
    })
    useSessionStore.getState().recordArtifactError('transport-session-1', 'disk full')

    const session = useSessionStore.getState().sessions[0]
    expect(session.error).toContain('disk full')
    expect(session.errorReportable).toBe(true)
  })

  it('keeps artifact finalization errors visible when the run later stops', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Created it'
    })

    useSessionStore.getState().recordArtifactError('transport-session-1', 'move failed')
    useSessionStore.getState().finishRun('transport-session-1')

    const session = useSessionStore.getState().sessions[0]

    expect(session.status).toBe('error')
    expect(session.error).toBe('Generated file finalization failed: move failed')
    expect(session.activeRun).toBeUndefined()
    expect(session.messages[1].status).toBe('complete')
  })

  it('tracks permission waiting without losing the active run', () => {
    const result = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Edit the file'
    })

    useSessionStore.getState().setPermissionPending('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      activeRun: {
        promptMessageId: result?.messageId,
        startedAt: Date.now()
      }
    })

    useSessionStore.getState().clearPermissionPending('transport-session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('running')
  })

  it('mirrors restored permission authority through continuing, rearm, and settlement', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run npm test'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-restored',
              sessionId: session.id,
              toolCallId: 'tool-1',
              title: 'Run npm test',
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
            },
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))

    useSessionStore.getState().clearPermissionPending('transport-session-1', {
      authority: 'continuing',
      requestId: 'permission-restored'
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      runtimeContext: { permission: { state: 'continuing' } }
    })

    useSessionStore.getState().setPermissionPending('transport-session-1', { rearmAuthority: true })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: { permission: { state: 'pending' } }
    })

    useSessionStore
      .getState()
      .clearPermissionPending('transport-session-1', { authority: 'settled' })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission).toBeUndefined()
  })

  it('tracks user-input waiting and resumes a runtime-owned continuation immediately', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Help me choose an approach'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    useSessionStore.getState().setAgentPromptInFlight('transport-session-1', true)
    expect(useSessionStore.getState().sessions[0].status).toBe('running')

    useSessionStore.getState().setElicitationPending('transport-session-1', true)
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-for-user')

    useSessionStore.getState().setElicitationPending('transport-session-1', false)
    expect(useSessionStore.getState().sessions[0].status).toBe('running')

    useSessionStore.getState().setAgentPromptInFlight('transport-session-1', false)
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
  })

  it('projects simultaneous blocking interactions in Permission, Ask, then Plan order', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run the workflow'
    })
    useSessionStore.getState().setElicitationPending('transport-session-1', true)
    useSessionStore.getState().setPermissionPending('transport-session-1')

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')

    useSessionStore
      .getState()
      .setActivePlanProjection('transport-session-1', createPlanProjection('version-1'))
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')

    useSessionStore.getState().clearPermissionPending('transport-session-1')
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-for-user')

    useSessionStore.getState().setElicitationPending('transport-session-1', false)
    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-plan-approval')
  })

  it('does not restore obsolete Ask and Plan waits after a new turn starts', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-restored-interactions',
          projectId: 'project-1',
          title: 'Restored interactions',
          cwd: '/workspace',
          status: 'waiting-for-user',
          interactionState: { permission: false, elicitation: true, plan: true },
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      selectedSessionId: 'session-restored-interactions'
    })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-restored-interactions',
      content: 'Continue with the selected choices'
    })
    useSessionStore.getState().setPermissionPending('session-restored-interactions')
    useSessionStore.getState().clearPermissionPending('session-restored-interactions')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      interactionState: { permission: false, elicitation: false, plan: false }
    })
  })

  it('does not restore obsolete Ask and Plan waits after a Session resumes', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-restored-interactions',
          projectId: 'project-1',
          title: 'Restored interactions',
          cwd: '/workspace',
          status: 'waiting-for-user',
          interactionState: { permission: false, elicitation: true, plan: true },
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      selectedSessionId: 'session-restored-interactions'
    })

    useSessionStore.getState().markResumed('session-restored-interactions')
    useSessionStore.getState().setPermissionPending('session-restored-interactions')
    useSessionStore.getState().clearPermissionPending('session-restored-interactions')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      interactionState: { permission: false, elicitation: false, plan: false }
    })
  })

  it('restores simultaneous durable Permission, Ask, and Plan state without persisting the transient index', () => {
    const restored: PersistedChatSession = {
      id: 'session-restored-interactions',
      projectId: 'project-1',
      title: 'Restored interactions',
      cwd: '/workspace',
      status: 'waiting-permission',
      runtimeContext: {
        version: 1,
        revision: 1,
        permission: {
          state: 'pending',
          request: {
            requestId: 'permission-restored',
            sessionId: 'session-restored-interactions',
            toolCallId: 'permission-tool',
            title: 'Run npm test',
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
          },
          originatingPromptMessageId: 'prompt-1',
          fingerprint: 'a'.repeat(64),
          createdAt: 1
        },
        plan: {
          artifactId: 'plan-artifact',
          artifactVersionId: 'plan-version',
          artifactChecksum: 'b'.repeat(64),
          approval: 'pending',
          stepStatuses: {}
        }
      },
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Run the workflow',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activities: [
        {
          id: 'ask-tool',
          kind: 'tool',
          title: 'Choose an approach',
          status: 'in_progress',
          eventIds: [],
          sortIndex: 1,
          elicitation: {
            message: 'Choose an approach',
            fields: [{ id: 'question_0', label: 'Approach', kind: 'text' }],
            state: 'pending',
            durable: { kind: 'agent-user-choice', requestId: 'choice-restored' }
          },
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }

    useSessionStore.getState().hydrateSessions([restored])

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      interactionState: { permission: true, elicitation: true, plan: true }
    })
    expect(toPersistedSession(useSessionStore.getState().sessions[0])).not.toHaveProperty(
      'interactionState'
    )

    useSessionStore.getState().clearPermissionPending('session-restored-interactions', {
      authority: 'settled'
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-for-user',
      interactionState: { permission: false, elicitation: true, plan: true }
    })

    useSessionStore.getState().setElicitationPending('session-restored-interactions', false)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      interactionState: { permission: false, elicitation: false, plan: true }
    })
  })

  it('keeps Plan approval waiting sticky across late generate_plan activity updates', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan'
    })
    useSessionStore
      .getState()
      .setActivePlanProjection('transport-session-1', createPlanProjection('version-1'))

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'generate-plan-call',
      eventId: 'generate-plan-completed',
      providerToolName: 'generate_plan',
      status: 'completed'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      activePlanProjection: { lifecycle: 'awaiting_approval' }
    })
  })

  it('blocks ordinary sends while an approved durable Plan continuation is queued', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan'
    })
    const queued = {
      ...createPlanProjection('version-1'),
      approval: 'approved' as const,
      lifecycle: 'approved' as const,
      continuationState: 'queued' as const,
      requiresExplicitContinuation: false
    }

    useSessionStore.getState().setActivePlanProjection('transport-session-1', queued)

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activePlanProjection: { continuationState: 'queued' }
    })
  })

  it('keeps Plan approval waiting when the Agent interaction times out', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan'
    })
    useSessionStore
      .getState()
      .setActivePlanProjection('transport-session-1', createPlanProjection('version-1'))

    useSessionStore.getState().finishRun('transport-session-1')

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-plan-approval',
      activeRun: undefined,
      activePlanProjection: { lifecycle: 'awaiting_approval', approval: 'pending' }
    })
  })

  it('keeps pending Plan approval available when the active run fails', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Waiting for Plan approval'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'generate-plan-call',
      eventId: 'generate-plan-started',
      providerToolName: 'generate_plan',
      status: 'pending'
    })
    const durablePlan = createPlanProjection('version-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        runtimeContext: {
          version: 1,
          revision: durablePlan.revision,
          plan: {
            artifactId: durablePlan.artifactId,
            artifactVersionId: durablePlan.artifactVersionId,
            artifactChecksum: durablePlan.artifactChecksum,
            originatingPromptMessageId: durablePlan.originatingPromptMessageId,
            approval: 'pending',
            stepStatuses: {}
          }
        }
      }))
    }))

    useSessionStore
      .getState()
      .failRun('transport-session-1', 'timed out awaiting tools/call after 300s')

    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      status: 'waiting-plan-approval',
      activeRun: undefined
    })
    expect(session.activePlanProjection).toBeUndefined()
    expect(session.error).toBeUndefined()
    expect(session.errorReportable).toBeUndefined()
    expect(session.messages[1]).toMatchObject({ status: 'error', failedAt: expect.any(Number) })
    expect(session.activities?.[0]).toMatchObject({ status: 'failed' })
  })

  it('keeps preceding CodeBuddy prose before a later tool call', () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'codebuddy-tool-order',
      content: 'Create and save a plot',
      agentFrameworkId: 'codebuddy'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'codebuddy-tool-order',
      streamId: 'provider-message-1',
      eventId: 'message-event-1',
      promptMessageId: prompt?.messageId,
      content: 'The plot is ready.'
    })
    vi.advanceTimersByTime(1)
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'codebuddy-tool-order',
      toolCallId: 'write-artifact-1',
      eventId: 'tool-event-1',
      timestamp: Date.now(),
      promptMessageId: prompt?.messageId,
      providerToolName: 'open-science-artifacts/write_artifact_file',
      status: 'in_progress'
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages.find((item) => item.role === 'agent')
    const activity = session.activities?.[0]
    expect(message).toBeDefined()
    expect(activity).toBeDefined()
    expect(message?.sortIndex).toBeLessThan(activity?.sortIndex ?? 0)

    const persisted = toPersistedSession(session)
    expect(persisted.messages.find((item) => item.role === 'agent')?.createdAt).toBeLessThan(
      persisted.activities?.[0]?.createdAt ?? 0
    )
  })

  it('keeps pending Plan approval available when the active run is interrupted', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a plan'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Waiting for Plan approval'
    })
    useSessionStore
      .getState()
      .setActivePlanProjection('transport-session-1', createPlanProjection('version-1'))

    useSessionStore
      .getState()
      .interruptRun('transport-session-1', 'connection-lost', 'Connection lost')

    const session = useSessionStore.getState().sessions[0]
    expect(session).toMatchObject({
      status: 'waiting-plan-approval',
      activeRun: undefined,
      activePlanProjection: { lifecycle: 'awaiting_approval', approval: 'pending' }
    })
    expect(session.error).toBeUndefined()
    expect(session.interrupted).toBeUndefined()
    expect(session.resumeRecovery).toBeUndefined()
    expect(session.messages[0]).toMatchObject({ role: 'user', interrupted: true })
    expect(session.messages[1]).toMatchObject({ status: 'error', failedAt: expect.any(Number) })
  })

  it('upserts transient tool activities without duplicating repeated events', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      title: '"open science repositories"',
      status: 'pending'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'completed'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'completed'
    })

    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'tool-web-1',
        kind: 'tool',
        toolKind: 'fetch',
        providerToolName: 'WebSearch',
        title: '"open science repositories"',
        status: 'completed',
        eventIds: ['event-1', 'event-2']
      })
    ])
  })

  it('preserves the terminal tool timestamp when later metadata arrives', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      status: 'completed'
    })
    const completedAt = useSessionStore.getState().sessions[0].activities?.[0].updatedAt
    vi.setSystemTime(new Date(Date.now() + 1_000))

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      status: 'completed',
      rawOutput: { result: 'ok' }
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      updatedAt: completedAt,
      rawOutput: { result: 'ok' }
    })
  })

  it('assigns real tool activities to the declared activity group and persists the group', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Inspect and update the app'
    })

    useSessionStore
      .getState()
      .beginActivityGroup(
        'transport-session-1',
        'group-call-1',
        'Inspect the current implementation'
      )
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-read-1',
      eventId: 'event-read-1',
      toolKind: 'read',
      status: 'completed'
    })
    useSessionStore
      .getState()
      .beginActivityGroup('transport-session-1', 'group-call-2', 'Apply the focused change')
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-edit-1',
      eventId: 'event-edit-1',
      toolKind: 'edit',
      status: 'completed'
    })
    useSessionStore.getState().completeActivityGroup('transport-session-1')

    const session = useSessionStore.getState().sessions[0]
    expect(session.activities).toEqual([
      expect.objectContaining({ id: 'tool-read-1', activityGroupId: 'group-call-1' }),
      expect.objectContaining({ id: 'tool-edit-1', activityGroupId: 'group-call-2' })
    ])
    expect(session.activityGroups).toEqual([
      expect.objectContaining({
        id: 'group-call-1',
        title: 'Inspect the current implementation',
        activityIds: ['tool-read-1'],
        completedAt: expect.any(Number)
      }),
      expect.objectContaining({
        id: 'group-call-2',
        title: 'Apply the focused change',
        activityIds: ['tool-edit-1'],
        completedAt: expect.any(Number)
      })
    ])
    expect(toPersistedSession(session).activityGroups).toEqual(session.activityGroups)
  })

  it('does not notify the store when no started activity group can be completed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Answer without tools'
    })
    const before = useSessionStore.getState()
    const listener = vi.fn()
    const unsubscribe = useSessionStore.subscribe(listener)

    useSessionStore.getState().completeActivityGroup('transport-session-1')

    expect(useSessionStore.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('preserves tool activity content and locations across updates', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      title: '"open science repositories"',
      status: 'pending',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Searching web'
          }
        }
      ],
      toolLocations: [
        {
          path: 'https://example.com'
        }
      ]
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      providerToolName: 'WebSearch',
      status: 'completed'
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      providerToolName: 'WebSearch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Searching web'
          }
        }
      ],
      toolLocations: [
        {
          path: 'https://example.com'
        }
      ],
      status: 'completed'
    })
  })

  it('merges raw input, raw output, and terminal metadata across tool updates', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run the tests'
    })

    // The initial tool_call carries arguments; later updates stream output and exit metadata.
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-1',
      toolKind: 'execute',
      providerToolName: 'Bash',
      title: 'npm test',
      status: 'pending',
      rawInput: { command: 'npm test' }
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-2',
      terminalOutput: 'All tests passed',
      terminalExitCode: 0
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-bash-1',
      eventId: 'event-3',
      status: 'completed',
      rawOutput: { stdout: 'All tests passed' }
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      rawInput: { command: 'npm test' },
      rawOutput: { stdout: 'All tests passed' },
      terminalOutput: 'All tests passed',
      terminalExitCode: 0,
      status: 'completed'
    })
  })

  it('keeps missing web activity titles empty so the UI can render only the web verb', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'search',
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0].activities?.[0]).toMatchObject({
      title: ''
    })
  })

  it('does not revive finished sessions or regress terminal tool activity statuses', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      timestamp: 10,
      toolKind: 'fetch',
      title: '"open science repositories"',
      status: 'in_progress'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-terminal',
      timestamp: 20,
      status: 'completed'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-2',
      timestamp: 30,
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activities: [
        expect.objectContaining({
          status: 'completed',
          eventIds: ['event-1', 'event-terminal', 'event-2'],
          createdAt: 10,
          updatedAt: 20
        })
      ]
    })
  })

  it('ignores stale new tool activities after a run has finished or failed', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Search the literature'
    })
    useSessionStore.getState().finishRun('transport-session-1')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'stale-tool-after-finish',
      eventId: 'event-1',
      toolKind: 'fetch',
      status: 'pending'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activities: undefined
    })

    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Try again'
    })
    useSessionStore.getState().failRun('transport-session-1', 'Network failed')

    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'stale-tool-after-error',
      eventId: 'event-2',
      toolKind: 'search',
      status: 'in_progress'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'error',
      activities: undefined
    })
  })

  it('persists a bounded projection of tool activities in session snapshots', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save this',
      cwd: '/workspace/project'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-web-1',
      eventId: 'event-1',
      toolKind: 'fetch',
      title: '"open science repositories"',
      status: 'pending'
    })

    const persistedSession = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(persistedSession.activities).toEqual([
      expect.objectContaining({
        id: 'tool-web-1',
        kind: 'tool',
        title: '"open science repositories"',
        status: 'pending',
        toolKind: 'fetch'
      })
    ])
  })

  it('drops oversized raw payloads from persisted activities but keeps the row', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save a big file'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'transport-session-1',
      toolCallId: 'tool-save-1',
      eventId: 'event-1',
      toolKind: 'other',
      providerToolName: 'write_artifact_file',
      title: 'Write artifact file',
      status: 'completed',
      // A base64 file payload far exceeds the raw-input cap and must not be persisted.
      toolContent: undefined
    })
    // Inject an oversized rawInput directly on the stored activity to exercise the cap.
    const bigActivity = useSessionStore
      .getState()
      .sessions[0].activities?.find((activity) => activity.id === 'tool-save-1')

    expect(bigActivity).toBeDefined()

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'transport-session-1'
          ? {
              ...session,
              activities: session.activities?.map((activity) =>
                activity.id === 'tool-save-1'
                  ? { ...activity, rawInput: { filename: 'big.png', content: 'A'.repeat(50_000) } }
                  : activity
              )
            }
          : session
      )
    }))

    const persistedActivity = toPersistedSession(useSessionStore.getState().sessions[0])
      .activities?.[0]

    expect(persistedActivity?.id).toBe('tool-save-1')
    expect(persistedActivity?.rawInput).toBeUndefined()
  })

  it('restores persisted tool activities when hydrating sessions', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'restored-session',
          projectId: 'default',
          title: 'Restored',
          cwd: '/workspace',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'run it',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ],
          activities: [
            {
              id: 'activity-1',
              kind: 'tool',
              title: 'ls -la',
              status: 'completed',
              sortIndex: 2,
              eventIds: ['event-1'],
              providerToolName: 'Bash',
              toolKind: 'execute',
              createdAt: 2,
              updatedAt: 2
            }
          ],
          createdAt: 1,
          updatedAt: 2
        }
      ],
      { version: SESSION_MANIFEST_VERSION, lastSessionId: 'restored-session' }
    )

    expect(useSessionStore.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'activity-1',
        kind: 'tool',
        title: 'ls -la',
        status: 'completed',
        providerToolName: 'Bash',
        toolKind: 'execute'
      })
    ])
  })

  // Note: normalizing interrupted (open) activities to "failed" now happens at the repository load
  // boundary (sanitizeSession), covered by the session-persistence repository round-trip test.

  it('ignores streamed agent chunks for missing sessions', () => {
    const result = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'missing-session',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'stale'
    })

    expect(result).toBeUndefined()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('renames and deletes sessions while keeping selection valid', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'First session'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-2',
      content: 'Second session'
    })

    useSessionStore.getState().renameSession('transport-session-1', 'Renamed session')
    useSessionStore.getState().deleteSession('transport-session-2')

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].title).toBe('Renamed session')
    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
  })

  it('toggles the pinned flag without disturbing updatedAt, and persists it', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'pin-session',
      content: 'Pin me'
    })
    const originalUpdatedAt = useSessionStore.getState().sessions[0].updatedAt

    useSessionStore.getState().togglePinned('pin-session')
    const pinned = useSessionStore.getState().sessions[0]
    expect(pinned.pinned).toBe(true)
    // Pinning is an organizational action, so it must not bump the "last active" timestamp.
    expect(pinned.updatedAt).toBe(originalUpdatedAt)
    expect(toPersistedSession(pinned).pinned).toBe(true)

    useSessionStore.getState().togglePinned('pin-session')
    expect(useSessionStore.getState().sessions[0].pinned).toBe(false)
    expect(toPersistedSession(useSessionStore.getState().sessions[0]).pinned).toBe(false)
  })

  it("keeps selection within the deleted session's project", () => {
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'a-1', content: 'A one', projectId: 'project-a' })
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'a-2', content: 'A two', projectId: 'project-a' })
    useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'b-1', content: 'B one', projectId: 'project-b' })

    // Select and delete a session in project A while project B holds the globally newest session.
    useSessionStore.getState().selectSession('a-2')
    useSessionStore.getState().deleteSession('a-2')

    // Selection falls back to the remaining project-a session, never to project-b's newer 'b-1'.
    expect(useSessionStore.getState().selectedSessionId).toBe('a-1')
  })

  it('removes all sessions for a deleted project and repairs selection', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'keep-1',
      content: 'Keep',
      projectId: 'project-keep'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'drop-1',
      content: 'Drop one',
      projectId: 'project-drop'
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'drop-2',
      content: 'Drop two',
      projectId: 'project-drop'
    })
    // Selection is currently on a session that belongs to the project being removed.
    expect(useSessionStore.getState().selectedSessionId).toBe('drop-2')

    useSessionStore.getState().removeSessionsForProject('project-drop')

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['keep-1'])
    expect(useSessionStore.getState().selectedSessionId).toBe('keep-1')
  })

  it('clears selection without deleting sessions', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Keep this session'
    })

    useSessionStore.getState().clearSelection()

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('attaches generated artifacts to the current agent message', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const agentChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done'
    })

    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    const session = useSessionStore.getState().sessions[0]
    const agentMessage = session.messages[1]

    expect(attached?.messageId).toBe(agentChunk?.messageId)
    expect(agentMessage.artifactIds).toEqual(['artifact-session-1:run-1:result.txt'])
    expect(agentMessage.content).toBe('Done')
    expect(session.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-session-1:run-1:result.txt',
        kind: 'managed-file',
        path: expect.stringContaining('/.pending/run-1/result.txt'),
        fileUrl: expect.stringContaining('file:///')
      })
    ])
  })

  it('creates a file-only agent message when a run emits artifacts without text', () => {
    const userMessage = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create an image'
    })
    // A replayed/post-stop Artifact must create its file-only owner directly in the durable graph.
    useSessionStore.getState().finishRun('transport-session-1')

    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      promptMessageId: userMessage?.messageId,
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile({ name: 'image.png', mimeType: 'image/png' })]
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(attached?.messageId).toBe(message.id)
    expect(message).toMatchObject({
      role: 'agent',
      content: '',
      status: 'complete',
      streamId: 'run-1',
      responseToMessageId: userMessage?.messageId,
      artifactIds: ['artifact-session-1:run-1:result.txt']
    })
    expect(
      session.conversationGraph?.messages.find((item) => item.id === message.id)
    ).toMatchObject({
      role: 'agent',
      status: 'complete',
      parentMessageId: userMessage?.messageId,
      artifactIds: ['artifact-session-1:run-1:result.txt']
    })
  })

  it('keeps file-only artifact ownership stable across independent renderer projections', () => {
    const userMessage = useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create an image'
    })
    useSessionStore.getState().finishRun('transport-session-1')
    const initialSession = toPersistedSession(useSessionStore.getState().sessions[0])
    const input = {
      sessionId: 'transport-session-1',
      runId: 'run-1',
      promptMessageId: userMessage?.messageId,
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile({ name: 'image.png', mimeType: 'image/png' })]
    }

    const firstProjection = useSessionStore.getState().attachRunArtifacts(input)
    useSessionStore.getState().hydrateSessions([initialSession])
    const secondProjection = useSessionStore.getState().attachRunArtifacts(input)

    expect(secondProjection?.messageId).toBe(firstProjection?.messageId)
  })

  it('replaces pending artifact metadata with finalized message files', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    const finalizedArtifacts = [
      createArtifactFile({
        id: 'transport-session-1:message-1:result.txt',
        sessionId: 'transport-session-1',
        messageId: 'message-1',
        runId: undefined,
        path: '/Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt',
        fileUrl:
          'file:///Users/example/.open-science/artifacts/default-project/transport-session-1/message-1/result.txt'
      })
    ]
    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'transport-session-1',
      messageId: attached?.messageId ?? '',
      artifacts: finalizedArtifacts
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(message.artifactIds).toEqual(['transport-session-1:message-1:result.txt'])
    expect(session.artifacts?.map((artifact) => artifact.id)).toEqual([
      'transport-session-1:message-1:result.txt'
    ])
    expect(
      session.conversationGraph?.messages.find((item) => item.id === attached?.messageId)
        ?.artifactIds
    ).toEqual(['transport-session-1:message-1:result.txt'])
    expect(session.filesRevision).toBe(1)

    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'transport-session-1',
      messageId: attached?.messageId ?? '',
      artifacts: finalizedArtifacts
    })
    expect(useSessionStore.getState().sessions[0]).toBe(session)
  })

  it('replaces pending artifact metadata with an empty finalized artifact list', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'transport-session-1',
      messageId: attached?.messageId ?? '',
      artifacts: []
    })

    const session = useSessionStore.getState().sessions[0]
    const message = session.messages[1]

    expect(message.artifactIds).toEqual([])
    expect(session.artifacts).toEqual([])
  })

  it('returns the existing message when an artifact event is replayed after finish', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Create a report'
    })
    const agentChunk = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'transport-session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Done'
    })
    const firstAttached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    expect(firstAttached).toEqual(agentChunk)
    useSessionStore.getState().finishRun('transport-session-1')
    const finishedSession = useSessionStore.getState().sessions[0]

    const replayed = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'transport-session-1',
      runId: 'run-1',
      eventId: 'artifact-event-1',
      artifacts: [createArtifactFile()]
    })

    expect(replayed).toEqual(firstAttached)
    expect(useSessionStore.getState().sessions[0]).toEqual(finishedSession)
    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(2)
  })

  it('hydrates persisted sessions and repairs missing selections', () => {
    useSessionStore.getState().hydrateSessions(
      [
        {
          id: 'transport-session-1',
          projectId: 'default',
          title: 'Persisted session',
          cwd: '/workspace/project',
          status: 'idle',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Persisted prompt',
              status: 'complete',
              eventIds: [],
              uploads: [
                {
                  id: 'upload-1',
                  sessionId: 'transport-session-1',
                  name: 'notes.txt',
                  originalName: 'notes.txt',
                  path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt',
                  mimeType: 'text/plain',
                  size: 10
                }
              ],
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ],
          artifacts: [
            {
              id: 'artifact-1',
              kind: 'workspace-file',
              path: '/workspace/project/report.md',
              name: 'report.md'
            }
          ],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      { version: SESSION_MANIFEST_VERSION, lastSessionId: 'missing-session' }
    )

    expect(useSessionStore.getState().selectedSessionId).toBe('transport-session-1')
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'transport-session-1',
      cwd: '/workspace/project',
      artifacts: [
        {
          id: 'artifact-1',
          path: '/workspace/project/report.md'
        }
      ],
      messages: [
        {
          content: 'Persisted prompt',
          uploads: [
            {
              id: 'upload-1',
              path: '/Users/example/.open-science/uploads/default-project/transport-session-1/notes.txt'
            }
          ]
        }
      ]
    })
  })

  it('serializes a session into the per-session persistence shape', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Save this',
      cwd: '/workspace/project',
      projectId: 'project-a'
    })

    const persisted = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(persisted).toMatchObject({
      id: 'transport-session-1',
      projectId: 'project-a',
      cwd: '/workspace/project',
      messages: [
        {
          content: 'Save this'
        }
      ]
    })
    expect(persisted).not.toHaveProperty('isPending')
  })

  it('stores and persists the conversation approval profile', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Run this',
      cwd: '/workspace/project',
      projectId: 'project-a',
      permissionProfile: 'auto'
    })

    expect(useSessionStore.getState().sessions[0].permissionProfile).toBe('auto')

    useSessionStore.getState().setPermissionProfile('transport-session-1', 'full')

    expect(toPersistedSession(useSessionStore.getState().sessions[0]).permissionProfile).toBe(
      'full'
    )
  })

  it('marks unbound pending sessions so persistence can skip them', () => {
    useSessionStore.getState().appendPendingUserMessage({
      content: 'Save after ACP creates the session',
      cwd: '/workspace/project'
    })

    // The persistence bridge relies on isPending to keep unbound sessions off disk.
    expect(useSessionStore.getState().sessions[0].isPending).toBe(true)
  })

  it('stamps a new session with the provided project id', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'transport-session-1',
      content: 'Scope me',
      cwd: '/workspace/project',
      projectId: 'project-abc'
    })

    expect(useSessionStore.getState().sessions[0].projectId).toBe('project-abc')
    expect(toPersistedSession(useSessionStore.getState().sessions[0]).projectId).toBe('project-abc')
  })

  it('persists a bound pending session with the runtime session id only', () => {
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Save after ACP creates the session',
      cwd: '/workspace/project',
      projectId: 'project-abc',
      delegationPolicy: 'allow'
    })

    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })

    const boundSession = useSessionStore.getState().sessions[0]

    expect(boundSession.isPending).toBe(false)
    expect(boundSession.delegationPolicyAuthorityPending).toBe(true)

    const persisted = toPersistedSession(boundSession)

    expect(persisted).toMatchObject({
      id: 'transport-session-1',
      projectId: 'project-abc',
      cwd: '/workspace/project',
      messages: [
        {
          id: pending?.messageId,
          content: 'Save after ACP creates the session'
        }
      ]
    })
    expect(persisted).not.toHaveProperty('isPending')
    expect(persisted).not.toHaveProperty('delegationPolicyAuthorityPending')
  })

  it('keeps a staged upload path until the main process publishes its immutable Version', () => {
    const attachment = createUploadAttachment({
      id: 'staged-upload-1',
      path: '/Users/example/OpenScience-DEV/uploads/default-project/.pending/staged.csv'
    })
    const pending = useSessionStore.getState().appendPendingUserMessage({
      content: 'Analyze the uploaded file',
      attachments: [attachment],
      cwd: '/workspace/project',
      projectId: 'project-abc'
    })

    useSessionStore.getState().bindPendingSession({
      pendingSessionId: pending?.sessionId ?? '',
      sessionId: 'transport-session-1',
      cwd: '/workspace/project'
    })

    const persisted = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(persisted.messages[0].uploads?.[0]).toMatchObject({
      id: 'staged-upload-1',
      path: attachment.path
    })
  })

  describe('fix loop active flag', () => {
    it('setFixLoopActive sets the flag per session', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-a',
        content: 'Start'
      })
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-b',
        content: 'Other session'
      })

      useSessionStore.getState().setFixLoopActive('session-a', true)

      const sessions = useSessionStore.getState().sessions
      const sessionA = sessions.find((s) => s.id === 'session-a')
      const sessionB = sessions.find((s) => s.id === 'session-b')

      expect(sessionA?.fixLoopActive).toBe(true)
      expect(sessionB?.fixLoopActive).toBeUndefined()
    })

    it('setFixLoopActive clears the flag when set to false', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-a',
        content: 'Start'
      })
      useSessionStore.getState().setFixLoopActive('session-a', true)
      useSessionStore.getState().setFixLoopActive('session-a', false)

      const session = useSessionStore.getState().sessions.find((s) => s.id === 'session-a')
      expect(session?.fixLoopActive).toBe(false)
    })

    it('canSendMessage is blocked while fixLoopActive is true', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-a',
        content: 'Start'
      })
      useSessionStore.getState().finishRun('session-a')
      useSessionStore.getState().setFixLoopActive('session-a', true)

      const session = useSessionStore.getState().sessions.find((s) => s.id === 'session-a')
      // fixLoopActive blocks send; canSendMessage is computed externally but depends on this flag
      expect(session?.fixLoopActive).toBe(true)
    })

    it('fixLoopActive is cleared after the loop ends (false)', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-a',
        content: 'Start'
      })
      useSessionStore.getState().setFixLoopActive('session-a', true)
      useSessionStore.getState().setFixLoopActive('session-a', false)

      const session = useSessionStore.getState().sessions.find((s) => s.id === 'session-a')
      expect(session?.fixLoopActive).toBe(false)
    })

    it('fixLoopActive flag does not affect other sessions', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-a',
        content: 'Session A'
      })
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-b',
        content: 'Session B'
      })
      useSessionStore.getState().finishRun('session-a')
      useSessionStore.getState().finishRun('session-b')

      useSessionStore.getState().setFixLoopActive('session-a', true)

      const sessionA = useSessionStore.getState().sessions.find((s) => s.id === 'session-a')
      const sessionB = useSessionStore.getState().sessions.find((s) => s.id === 'session-b')

      expect(sessionA?.fixLoopActive).toBe(true)
      expect(sessionB?.fixLoopActive).toBeUndefined()
    })
  })

  describe('interrupted session resume', () => {
    const hydrateInterrupted = (overrides: Partial<PersistedChatSession> = {}): void => {
      useSessionStore.getState().hydrateSessions(
        [
          {
            id: 'resumable-session',
            projectId: 'default',
            title: 'Interrupted',
            cwd: '/workspace',
            status: 'error',
            error: INTERRUPTED_SESSION_ERROR,
            messages: [],
            createdAt: 1,
            updatedAt: 2,
            ...overrides
          }
        ],
        { version: SESSION_MANIFEST_VERSION, lastSessionId: 'resumable-session' }
      )
    }

    it('flags a restored interrupted session so the UI can offer resume', () => {
      hydrateInterrupted()

      expect(useSessionStore.getState().sessions[0].interrupted).toBe(true)
    })

    it('leaves the flag unset when the error is not the interrupted marker', () => {
      hydrateInterrupted({ error: 'Something else failed' })

      expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
    })

    it('never persists the transient interrupted flag', () => {
      hydrateInterrupted()

      const persisted = toPersistedSession(useSessionStore.getState().sessions[0])

      expect(persisted).not.toHaveProperty('interrupted')
    })

    it('clears stale Session recovery when a successful Agent turn finishes', () => {
      hydrateInterrupted({
        status: 'running',
        activeRun: { promptMessageId: 'prompt-1', startedAt: 10 },
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        },
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Complete the task',
            status: 'complete',
            interrupted: true,
            eventIds: [],
            createdAt: 10,
            updatedAt: 10
          },
          {
            id: 'response-1',
            role: 'agent',
            content: 'Completed response',
            status: 'streaming',
            responseToMessageId: 'prompt-1',
            eventIds: [],
            createdAt: 11,
            updatedAt: 11
          }
        ]
      })

      useSessionStore.getState().finishRun('resumable-session', undefined, 'prompt-1')
      const session = useSessionStore.getState().sessions[0]

      expect(session.status).toBe('idle')
      expect(session.error).toBeUndefined()
      expect(session.resumeRecovery).toBeUndefined()
      expect(session.interrupted).toBeUndefined()
      expect(session.messages[0]).toMatchObject({ id: 'prompt-1', interrupted: true })
      expect(session.messages[1]).toMatchObject({ status: 'complete' })
    })

    it('markResumed clears the interrupted state so the composer is usable', () => {
      hydrateInterrupted({
        providerSessionId: 'provider-session-old',
        providerContinuityToken: 'bridge-generation-old',
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        },
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Continue the analysis',
            status: 'complete',
            eventIds: [],
            createdAt: 10,
            completedAt: 11,
            updatedAt: 11
          },
          {
            id: 'response-1',
            role: 'agent',
            content: 'The first turn completed.',
            status: 'complete',
            responseToMessageId: 'prompt-1',
            eventIds: [],
            turnUsage: {
              inputTokens: 31,
              cacheTokens: 15,
              outputTokens: 14,
              turnCount: 3
            },
            createdAt: 12,
            completedAt: 13,
            updatedAt: 13
          }
        ]
      })

      useSessionStore.getState().markResumed('resumable-session', {
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:codex-isolated',
        providerSessionId: 'provider-session-new',
        providerContinuityToken: 'bridge-generation-new',
        pendingHistoryReplay: { kind: 'before-message', messageId: 'prompt-1' }
      })
      const session = useSessionStore.getState().sessions[0]

      expect(session.interrupted).toBeUndefined()
      expect(session.error).toBeUndefined()
      expect(session.status).toBe('idle')
      expect(session.agentFrameworkId).toBe('codex')
      expect(session.agentBackendId).toBe('codex:codex-isolated')
      expect(session.providerSessionId).toBe('provider-session-new')
      expect(session.providerContinuityToken).toBe('bridge-generation-new')
      expect(session.resumeRecovery).toBeUndefined()
      expect(session.pendingHistoryReplay).toEqual({
        kind: 'before-message',
        messageId: 'prompt-1'
      })
      expect(session.messages[1]).toMatchObject({
        responseToMessageId: 'prompt-1',
        completedAt: 13,
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 3 }
      })
      expect(toPersistedSession(session).agentFrameworkId).toBe('codex')
      expect(toPersistedSession(session).agentBackendId).toBe('codex:codex-isolated')
      expect(toPersistedSession(session).messages[1]).toMatchObject({
        responseToMessageId: 'prompt-1',
        completedAt: 13,
        turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14, turnCount: 3 }
      })
    })

    it('keeps recovery durable until a resumed continuation is accepted', () => {
      hydrateInterrupted({
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:provider-a',
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        },
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Continue the analysis',
            status: 'complete',
            eventIds: [],
            interrupted: true,
            createdAt: 10,
            updatedAt: 11
          }
        ]
      })

      const prepared = useSessionStore.getState().prepareInterruptedTurnContinuation(
        'resumable-session',
        'prompt-1',
        {
          agentFrameworkId: 'codex',
          agentBackendId: 'codex:provider-a',
          providerSessionId: 'provider-session-new',
          providerContinuityToken: 'bridge-generation-new'
        },
        true
      )
      const running = useSessionStore.getState().sessions[0]

      expect(prepared?.runtimeSegmentId).toBeTruthy()
      expect(running).toMatchObject({
        status: 'running',
        interrupted: true,
        resumeRecovery: { promptMessageId: 'prompt-1' },
        pendingHistoryReplay: { kind: 'before-message', messageId: 'prompt-1' },
        activeRun: { promptMessageId: 'prompt-1' },
        activeRunRuntimeSegmentId: prepared?.runtimeSegmentId
      })
      expect(toPersistedSession(running).resumeRecovery).toMatchObject({
        promptMessageId: 'prompt-1'
      })
      expect(toPersistedSession(running).pendingHistoryReplay).toEqual({
        kind: 'before-message',
        messageId: 'prompt-1'
      })

      useSessionStore.getState().completeInterruptedTurnResume('resumable-session')
      const accepted = useSessionStore.getState().sessions[0]
      expect(accepted.status).toBe('running')
      expect(accepted.activeRun?.promptMessageId).toBe('prompt-1')
      expect(accepted.interrupted).toBeUndefined()
      expect(accepted.resumeRecovery).toBeUndefined()
      expect(accepted.pendingHistoryReplay).toBeUndefined()
      expect(accepted.messages[0]).toMatchObject({ interrupted: true })
    })

    it('abandons stale Resume authority when the user starts a newer turn', () => {
      hydrateInterrupted({
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        },
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Analyze the first cohort',
            status: 'complete',
            eventIds: [],
            interrupted: true,
            createdAt: 10,
            updatedAt: 11
          }
        ]
      })

      const appended = useSessionStore.getState().appendUserMessage({
        sessionId: 'resumable-session',
        content: 'Analyze the second cohort instead'
      })
      const session = useSessionStore.getState().sessions[0]

      expect(appended?.messageId).toBeTruthy()
      expect(session.interrupted).toBeUndefined()
      expect(session.resumeRecovery).toBeUndefined()
      expect(session.activeRun?.promptMessageId).toBe(appended?.messageId)
      expect(session.messages).toHaveLength(2)
      expect(session.messages[0]).toMatchObject({ id: 'prompt-1', interrupted: true })
      expect(toPersistedSession(session).resumeRecovery).toBeUndefined()
    })

    it('markDisconnected flags a live drop and settles the half-streamed reply, keeping the user turn', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'transport-session-1',
        content: 'Read the files',
        cwd: '/workspace/project'
      })
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'transport-session-1',
        streamId: 'assistant-message-1',
        eventId: 'event-1',
        content: 'I started'
      })

      useSessionStore.getState().markDisconnected('transport-session-1')

      const session = useSessionStore.getState().sessions[0]

      expect(session.status).toBe('error')
      expect(session.interrupted).toBe(true)
      expect(session.error).toBe('Connection lost — Resume to reconnect and continue.')
      expect(session.activeRun).toBeUndefined()
      expect(session.resumeRecovery).toMatchObject({
        kind: 'resume-required',
        cause: 'connection-lost',
        promptMessageId: session.messages[0].id
      })
      // The exact user node remains visible and is never re-sent by Resume; the partial reply fails off.
      expect(session.messages[0]).toMatchObject({
        role: 'user',
        content: 'Read the files',
        interrupted: true
      })
      expect(
        session.conversationGraph?.messages.find((message) => message.id === session.messages[0].id)
      ).toMatchObject({ interrupted: true })
      expect(session.messages[1]).toMatchObject({ content: 'I started', status: 'error' })
      const persisted = toPersistedSession(session)
      expect(persisted.resumeRecovery).toEqual(session.resumeRecovery)
      expect(
        persisted.conversationGraph?.messages.find(
          (message) => message.id === session.messages[0].id
        )
      ).toMatchObject({ interrupted: true })
    })

    it('interruptRun preserves a cancelled prompt for Resume', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'transport-session-1',
        content: 'Read the files',
        cwd: '/workspace/project'
      })
      const promptMessageId = useSessionStore.getState().sessions[0].activeRun?.promptMessageId

      useSessionStore
        .getState()
        .interruptRun(
          'transport-session-1',
          'cancelled',
          'This turn was interrupted. Resume to continue.'
        )

      const session = useSessionStore.getState().sessions[0]
      expect(session.resumeRecovery).toEqual({
        kind: 'resume-required',
        cause: 'cancelled',
        promptMessageId
      })
      expect(session.messages[0]).toMatchObject({ id: promptMessageId, interrupted: true })
      expect(toPersistedSession(session).resumeRecovery).toEqual(session.resumeRecovery)
    })

    it('markDisconnected preserves a specific reason in the Resume banner', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'transport-session-1',
        content: 'Read the files',
        cwd: '/workspace/project'
      })

      useSessionStore.getState().markDisconnected('transport-session-1', 'Connection timeout')

      const session = useSessionStore.getState().sessions[0]

      expect(session.status).toBe('error')
      expect(session.interrupted).toBe(true)
      // The specific cause is kept while retaining the Resume affordance.
      expect(session.error).toBe('Connection timeout — Resume to reconnect and continue.')
    })

    it('markDisconnected falls back to a generic message for a blank reason', () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'transport-session-1',
        content: 'Read the files',
        cwd: '/workspace/project'
      })

      useSessionStore.getState().markDisconnected('transport-session-1', '   ')

      const session = useSessionStore.getState().sessions[0]

      expect(session.error).toBe('Connection lost — Resume to reconnect and continue.')
    })
  })
})

describe('session store public contract', () => {
  const projectRoot = resolve(__dirname, '../../../..')
  const rendererRoot = resolve(__dirname, '..')
  const storeModule = resolve(__dirname, 'session-store')
  const normalizePath = (path: string): string => path.replace(/\\/g, '/')
  const modulePath = (path: string): string => normalizePath(path.replace(/\.[cm]?[jt]sx?$/, ''))
  const importSpecifiersFrom = (path: string): string[] => {
    const specifiers: string[] = []
    const sourceFile = createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ScriptTarget.Latest,
      true,
      extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
    )
    const visit = (node: Node): void => {
      if (
        (isImportDeclaration(node) || isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text)
      } else if (isCallExpression(node)) {
        const [argument] = node.arguments
        const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
        const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
        if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
          specifiers.push(argument.text)
        }
      }
      forEachChild(node, visit)
    }
    visit(sourceFile)
    return specifiers
  }

  const productionSourcePaths = (): string[] => {
    const paths: string[] = []
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          visit(path)
        } else if (
          /\.[cm]?tsx?$/.test(entry.name) &&
          !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
        ) {
          paths.push(path)
        }
      }
    }
    visit(rendererRoot)
    return paths
  }

  const directConsumerPaths = (): string[] =>
    productionSourcePaths()
      .filter((path) => {
        return importSpecifiersFrom(path).some((specifier) => {
          const target = specifier.startsWith('@/')
            ? resolve(rendererRoot, specifier.slice(2))
            : specifier.startsWith('@renderer/')
              ? resolve(rendererRoot, specifier.slice('@renderer/'.length))
              : specifier.startsWith('.')
                ? resolve(dirname(path), specifier)
                : undefined
          return target !== undefined && modulePath(target) === modulePath(storeModule)
        })
      })
      .map((path) => normalizePath(relative(projectRoot, path)))
      .sort()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
  })

  it('keeps the initial data shape independent and empty', () => {
    const first = createInitialSessionState()
    const second = createInitialSessionState()

    expect(first).toEqual({ sessions: [], selectedSessionId: undefined })
    expect(Object.keys(first).sort()).toEqual(['selectedSessionId', 'sessions'])
    expect(first.sessions).not.toBe(second.sessions)
  })

  it('keeps the public action surface stable', () => {
    const actionNames = Object.entries(useSessionStore.getState())
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()

    expect(actionNames).toEqual(
      [
        'activateMessageBranch',
        'appendAgentMessageChunk',
        'appendAgentMessageChunks',
        'appendPendingUserMessage',
        'appendRoutedUserMessage',
        'appendUserMessage',
        'applyDelegationPolicyAuthority',
        'applyDurableSessionProjection',
        'attachRunArtifacts',
        'beginActivityGroup',
        'beginCompaction',
        'bindPendingSession',
        'branchInNewSession',
        'clearArtifactError',
        'clearBranchContextReset',
        'clearPendingContextReplay',
        'clearPendingHistoryReplay',
        'clearPermissionPending',
        'clearSelection',
        'clearSpecialistSwitchResetRequired',
        'completeActivityGroup',
        'completeInterruptedTurnResume',
        'deleteSession',
        'failCompaction',
        'failRun',
        'finishCompaction',
        'finishRun',
        'hydrateSessionSummaries',
        'hydrateSessions',
        'interruptRun',
        'markDisconnected',
        'markResumed',
        'markSpecialistSwitchResetRequired',
        'openContextResetRuntimeSegment',
        'prepareInterruptedTurnContinuation',
        'recordArtifactError',
        'removeMessage',
        'removeSessionsForProject',
        'renameSession',
        'replaceMessageArtifacts',
        'replaceMessagePdfContext',
        'replaceMessageUploads',
        'reviseSessionFromElicitation',
        'selectSession',
        'setActivePlanProjection',
        'setAgentConfiguration',
        'setAgentPromptInFlight',
        'setAgentStatus',
        'setAutoReviewEnabled',
        'setAwaitingFirstAgentOutput',
        'setBranchSwitchBlocked',
        'setContextUsage',
        'setElicitationDraftAnswers',
        'setElicitationHistoryReplayRequest',
        'setElicitationPending',
        'setFixLoopActive',
        'setMemoryEnabled',
        'setPermissionPending',
        'setPermissionProfile',
        'setSessionSpecialistId',
        'togglePinned',
        'truncateSessionFromMessage',
        'updateSessionArchive',
        'upsertPersistedSession',
        'upsertToolActivity'
      ].sort()
    )
  })

  it('keeps production consumers on the public store facade', () => {
    expect(directConsumerPaths()).toEqual([
      'src/renderer/src/components/NotificationBell.tsx',
      'src/renderer/src/components/NotificationLiveToast.tsx',
      'src/renderer/src/components/global-search/GlobalSearchDialog.tsx',
      'src/renderer/src/components/job-binding-utils.ts',
      'src/renderer/src/components/notification-inbox-presentation.ts',
      'src/renderer/src/hooks/useApplicationEventBindings.ts',
      'src/renderer/src/hooks/useLifecycleSync.ts',
      'src/renderer/src/hooks/useUnreadTaskViewSync.ts',
      'src/renderer/src/lib/acp/history-preamble.ts',
      'src/renderer/src/lib/acp/runtime-event-presentation.ts',
      'src/renderer/src/lib/acp/useWorkspaceAgentRuntime.ts',
      'src/renderer/src/lib/acp/useWorkspaceElicitation.ts',
      'src/renderer/src/lib/acp/workspace-elicitation-runtime.ts',
      'src/renderer/src/lib/acp/workspace-events.ts',
      'src/renderer/src/lib/acp/workspace-permission-response-attempt-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-command-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-event-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-prompt-preparation-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-save-as-skill-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-selection-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-session-branch-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-session-lifecycle-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-session-memory-owner.ts',
      'src/renderer/src/lib/acp/workspace-subagent-runtime-presentation.ts',
      'src/renderer/src/lib/active-session-display.ts',
      'src/renderer/src/lib/compute/useJobAnalysisEffect.ts',
      'src/renderer/src/lib/deep-link.ts',
      'src/renderer/src/lib/preview-persistence/preview-persistence.ts',
      'src/renderer/src/lib/session-persistence/session-persistence.ts',
      'src/renderer/src/pages/home/HomePage.tsx',
      'src/renderer/src/pages/settings/ArchivedPanel.tsx',
      'src/renderer/src/pages/settings/SettingsPage.tsx',
      'src/renderer/src/pages/workspace/ArtifactProvenancePanel.tsx',
      'src/renderer/src/pages/workspace/ContextWindowDialog.tsx',
      'src/renderer/src/pages/workspace/ConversationExportDialog.tsx',
      'src/renderer/src/pages/workspace/ConversationPanel.tsx',
      'src/renderer/src/pages/workspace/DeleteSessionDialog.tsx',
      'src/renderer/src/pages/workspace/DownloadSessionArtifactsDialog.tsx',
      'src/renderer/src/pages/workspace/EditSessionDialog.tsx',
      'src/renderer/src/pages/workspace/NotebookPreview.tsx',
      'src/renderer/src/pages/workspace/PreviewFileSurface.tsx',
      'src/renderer/src/pages/workspace/SessionNotebookDialog.tsx',
      'src/renderer/src/pages/workspace/SubagentReleaseSurfaces.tsx',
      'src/renderer/src/pages/workspace/WorkspaceActivityIcon.tsx',
      'src/renderer/src/pages/workspace/WorkspaceAgentLoadingRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceArtifactVisibility.tsx',
      'src/renderer/src/pages/workspace/WorkspaceContextCompactionActivityRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceManagePackagesActivityRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageItem.tsx',
      'src/renderer/src/pages/workspace/WorkspaceMessageScroller.tsx',
      'src/renderer/src/pages/workspace/WorkspacePage.tsx',
      'src/renderer/src/pages/workspace/WorkspacePlanActivityRecord.tsx',
      'src/renderer/src/pages/workspace/WorkspaceSidebar.tsx',
      'src/renderer/src/pages/workspace/WorkspaceSidebarContainer.tsx',
      'src/renderer/src/pages/workspace/WorkspaceSkillActivityRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceSkillLoadRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceToolActivityRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceToolActivityRowButton.tsx',
      'src/renderer/src/pages/workspace/WorkspaceToolDetailsRow.tsx',
      'src/renderer/src/pages/workspace/WorkspaceWebSearchActivityRow.tsx',
      'src/renderer/src/pages/workspace/agent-loading-message.ts',
      'src/renderer/src/pages/workspace/artifact-preview-utils.ts',
      'src/renderer/src/pages/workspace/artifact-preview.tsx',
      'src/renderer/src/pages/workspace/composer/SessionMentionPopup.tsx',
      'src/renderer/src/pages/workspace/composer/composer-history.ts',
      'src/renderer/src/pages/workspace/context-window-trend.ts',
      'src/renderer/src/pages/workspace/generate-plan-activity-projection.ts',
      'src/renderer/src/pages/workspace/preview-file-item.ts',
      'src/renderer/src/pages/workspace/previews/PreviewToolContent.tsx',
      'src/renderer/src/pages/workspace/previews/renderers/PdfPreview.tsx',
      'src/renderer/src/pages/workspace/previews/renderers/PlanJsonPreview.tsx',
      'src/renderer/src/pages/workspace/project-files-query-model.ts',
      'src/renderer/src/pages/workspace/session-action-menu.ts',
      'src/renderer/src/pages/workspace/session-message-artifact-reference.ts',
      'src/renderer/src/pages/workspace/session-notebook-projection.ts',
      'src/renderer/src/pages/workspace/session-plan/active-branch-plan.ts',
      'src/renderer/src/pages/workspace/session-plan/plan-file-projection.ts',
      'src/renderer/src/pages/workspace/session-plan/respond-to-session-plan.ts',
      'src/renderer/src/pages/workspace/session-wait-reason.ts',
      'src/renderer/src/pages/workspace/tool-execution-phase.ts',
      'src/renderer/src/pages/workspace/use-pdf-context-action.ts',
      'src/renderer/src/pages/workspace/use-side-chat-controller.ts',
      'src/renderer/src/pages/workspace/use-workspace-branch-switch-guard.ts',
      'src/renderer/src/pages/workspace/visible-project-sessions.ts',
      'src/renderer/src/pages/workspace/workspace-agent-control-availability.ts',
      'src/renderer/src/pages/workspace/workspace-compute-host-access-controller.ts',
      'src/renderer/src/pages/workspace/workspace-conversation-controller.ts',
      'src/renderer/src/pages/workspace/workspace-conversation-items.ts',
      'src/renderer/src/pages/workspace/workspace-conversation-timeline.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-admission.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-controller.ts',
      'src/renderer/src/pages/workspace/workspace-message-queue-owner.ts',
      'src/renderer/src/pages/workspace/workspace-run-marks.ts',
      'src/renderer/src/pages/workspace/workspace-session-agent-configuration-controller.ts',
      'src/renderer/src/pages/workspace/workspace-session-controller.ts',
      'src/renderer/src/pages/workspace/workspace-session-delegation-control-owner.ts',
      'src/renderer/src/pages/workspace/workspace-session-details-controller.ts',
      'src/renderer/src/pages/workspace/workspace-skill-load.ts',
      'src/renderer/src/pages/workspace/workspace-tool-activity-details.ts',
      'src/renderer/src/pages/workspace/workspace-tool-activity-groups.ts',
      'src/renderer/src/pages/workspace/workspace-tool-activity-style.ts',
      'src/renderer/src/pages/workspace/workspace-web-search-details.ts',
      'src/renderer/src/stores/archive-undo-store.ts',
      'src/renderer/src/stores/navigation-store.ts',
      'src/renderer/src/stores/preview-workbench-store.ts'
    ])
  })

  it('does not rebuild Project Files from Session-store consumers', () => {
    expect(directConsumerPaths()).not.toEqual(
      expect.arrayContaining([
        'src/renderer/src/pages/workspace/project-files-library.ts',
        'src/renderer/src/pages/workspace/use-project-artifact-files.ts'
      ])
    )
  })

  it('hydrates newest-first while preserving manifest and explicit selection semantics', () => {
    const older: PersistedChatSession = {
      id: 'older-session',
      projectId: 'project-a',
      title: 'Older',
      cwd: 'project-a',
      status: 'idle',
      messages: [],
      createdAt: 10,
      updatedAt: 20
    }
    const newer: PersistedChatSession = {
      ...older,
      id: 'newer-session',
      title: 'Newer',
      createdAt: 30,
      updatedAt: 40
    }

    useSessionStore.getState().hydrateSessions([older, newer], {
      version: SESSION_MANIFEST_VERSION,
      lastSessionId: 'older-session'
    })

    expect(useSessionStore.getState().sessions.map(({ id }) => id)).toEqual([
      'newer-session',
      'older-session'
    ])
    expect(useSessionStore.getState().selectedSessionId).toBe('older-session')
    expect(
      useSessionStore.getState().sessions.map(({ permissionProfile }) => permissionProfile)
    ).toEqual([DEFAULT_PERMISSION_PROFILE, DEFAULT_PERMISSION_PROFILE])

    useSessionStore.getState().hydrateSessions([older, newer], undefined, {
      sessionId: undefined
    })
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('projects durable state without renderer-only hydration and runtime fields', () => {
    const persistedInput: PersistedChatSession = {
      id: 'persisted-session',
      projectId: 'project-a',
      title: 'Persisted',
      cwd: 'project-a',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Persist this message',
          status: 'complete',
          eventIds: ['event-1'],
          createdAt: 11,
          updatedAt: 12
        }
      ],
      runtimeContext: { version: 1, revision: 7 },
      createdAt: 10,
      updatedAt: 20
    }
    useSessionStore.getState().hydrateSessions([persistedInput])
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        isPending: true,
        unsavedTitle: true,
        interrupted: true,
        fixLoopActive: true,
        compacting: true,
        agentStatus: 'Waiting',
        awaitingFirstAgentOutput: true,
        agentPromptInFlight: true,
        branchContextResetRequired: true,
        specialistSwitchResetRequired: true,
        elicitationHistoryReplayRequestId: 'choice-replay',
        branchSwitchBlocked: true,
        pendingContextReplayMessageId: 'message-1',
        activePlanProjection: createPlanProjection('active-version'),
        messages: session.messages.map((message) => ({ ...message, sortIndex: 99 }))
      }))
    }))

    const durable = toPersistedSession(useSessionStore.getState().sessions[0])

    expect(durable).toMatchObject({
      id: 'persisted-session',
      projectId: 'project-a',
      title: 'Persisted',
      cwd: 'project-a',
      status: 'idle',
      permissionProfile: DEFAULT_PERMISSION_PROFILE,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Persist this message',
          status: 'complete',
          eventIds: ['event-1'],
          createdAt: 11,
          updatedAt: 12
        }
      ],
      createdAt: 10,
      updatedAt: 20
    })
    expect(durable).not.toHaveProperty('activePlanProjection')
    expect(durable.messages[0]).not.toHaveProperty('sortIndex')
    for (const transientKey of [
      'isPending',
      'unsavedTitle',
      'interrupted',
      'fixLoopActive',
      'compacting',
      'agentStatus',
      'awaitingFirstAgentOutput',
      'agentPromptInFlight',
      'branchContextResetRequired',
      'specialistSwitchResetRequired',
      'elicitationHistoryReplayRequestId',
      'branchSwitchBlocked',
      'pendingContextReplayMessageId',
      'runtimeContext'
    ]) {
      expect(durable).not.toHaveProperty(transientKey)
    }
  })
})

describe('branchInNewSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    useSessionStore.setState(createInitialSessionState())
  })

  it('copies history through a completed Agent Message into a selected idle Session', () => {
    const firstPrompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'first question',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    const firstAnswer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'first-stream',
      eventId: 'first-event',
      content: 'first answer'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'second question'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'second-stream',
      eventId: 'second-event',
      content: 'second answer'
    })
    useSessionStore.getState().finishRun('source-session')

    const result = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      sourceMessageId: firstAnswer?.messageId ?? ''
    })

    expect(result).toEqual({ sessionId: expect.stringMatching(/^pending-session-/) })
    expect(useSessionStore.getState().selectedSessionId).toBe(result?.sessionId)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: result?.sessionId,
      isPending: true,
      title: 'first question',
      status: 'idle',
      pendingHistoryReplay: { kind: 'all' },
      branchSource: {
        sessionId: 'source-session',
        headMessageId: firstAnswer?.messageId
      }
    })
    expect(useSessionStore.getState().sessions[0].activeRun).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].messages.map((message) => message.id)).toEqual([
      firstPrompt?.messageId,
      firstAnswer?.messageId
    ])
  })

  it('copies only the active path into a fresh pending graph without mutating the source', () => {
    const first = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'first question',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'first-stream',
      eventId: 'first-event',
      content: 'first answer'
    })
    useSessionStore.getState().finishRun('source-session')

    const originalSecond = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'original second question'
    })
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'original-second-stream',
      eventId: 'original-second-event',
      content: 'original second answer'
    })
    useSessionStore.getState().finishRun('source-session')

    useSessionStore
      .getState()
      .truncateSessionFromMessage('source-session', originalSecond?.messageId ?? '')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'edited second question'
    })
    useSessionStore
      .getState()
      .beginActivityGroup('source-session', 'tool-group', 'Inspect files', edited?.messageId)
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'source-session',
      toolCallId: 'tool-call',
      eventId: 'tool-event',
      promptMessageId: edited?.messageId,
      title: 'Read package.json',
      status: 'completed',
      rawInput: { path: 'package.json' },
      rawOutput: { content: '{}' }
    })
    const editedAnswer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'edited-stream',
      eventId: 'edited-event',
      content: 'edited second answer'
    })
    useSessionStore.getState().finishRun('source-session')

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session'
          ? {
              ...session,
              status: 'error',
              error: 'old failure',
              errorReportable: false,
              interrupted: true,
              agentStatus: 'stale status',
              branchContextResetRequired: true,
              specialistSwitchResetRequired: true,
              contextUsage: { used: 500, size: 1_000 },
              pinned: true,
              delegationPolicy: 'deny' as const,
              autoReviewEnabled: true,
              memoryEnabled: false,
              enabledComputeHosts: ['ssh:build'],
              computeConcurrencyLimit: 2,
              filesRevision: 7,
              artifacts: [
                {
                  id: 'artifact-version-1',
                  kind: 'managed-file',
                  path: '/workspace/project/result.txt',
                  name: 'result.txt'
                }
              ],
              messages: session.messages.map((message) =>
                message.id === editedAnswer?.messageId
                  ? { ...message, artifactIds: ['artifact-version-1'] }
                  : message
              ),
              conversationGraph: session.conversationGraph
                ? {
                    ...session.conversationGraph,
                    messages: session.conversationGraph.messages.map((message) =>
                      message.id === editedAnswer?.messageId
                        ? { ...message, artifactIds: ['artifact-version-1'] }
                        : message
                    )
                  }
                : undefined
            }
          : session
      )
    }))

    const sourceBefore = structuredClone(useSessionStore.getState().sessions[0])
    const result = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: '  continue from the edited answer\nwith this request  ',
      permissionProfile: 'full',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:shared',
      agentModel: 'gpt-5.4'
    })

    expect(result?.sessionId).toMatch(/^pending-session-/)
    expect(useSessionStore.getState().selectedSessionId).toBe(result?.sessionId)
    expect(useSessionStore.getState().sessions[1]).toEqual(sourceBefore)

    const branched = useSessionStore.getState().sessions[0]
    const sourceFrame = sourceBefore.conversationGraph?.frames.find(
      (frame) => frame.id === sourceBefore.conversationGraph?.activeFrameId
    )
    const sourceBranch = sourceBefore.conversationGraph?.branches.find(
      (branch) => branch.id === sourceFrame?.activeBranchId
    )
    expect(branched).toMatchObject({
      id: result?.sessionId,
      isPending: true,
      title: 'continue from the edited answer with this request',
      projectId: 'default-project',
      cwd: '/workspace/project',
      status: 'running',
      permissionProfile: 'full',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:shared',
      agentModel: 'gpt-5.4',
      autoReviewEnabled: true,
      delegationPolicy: 'deny',
      memoryEnabled: false,
      enabledComputeHosts: ['ssh:build'],
      computeConcurrencyLimit: 2,
      branchSource: {
        sessionId: 'source-session',
        agentFrameId: sourceFrame?.id,
        messageBranchId: sourceBranch?.id,
        headMessageId: sourceBranch?.headMessageId
      },
      activeRun: { promptMessageId: result?.messageId, startedAt: Date.now() }
    })
    expect(branched.messages.map((message) => message.content)).toEqual([
      'first question',
      'first answer',
      'edited second question',
      'edited second answer',
      'continue from the edited answer\nwith this request'
    ])
    expect(branched.messages.map((message) => message.id)).toEqual([
      first?.messageId,
      sourceBefore.messages[1].id,
      edited?.messageId,
      editedAnswer?.messageId,
      result?.messageId
    ])
    expect(branched.messages.slice(0, -1).every((message) => message.eventIds.length === 0)).toBe(
      true
    )
    expect(branched.messages.slice(0, -1).every((message) => message.streamId === undefined)).toBe(
      true
    )
    expect(branched.messages.at(-2)?.artifactIds).toEqual(['artifact-version-1'])
    const copiedActivity = branched.activities?.[0]
    const copiedGroup = branched.activityGroups?.[0]
    expect(copiedActivity).toMatchObject({
      eventIds: [],
      rawInput: { path: 'package.json' }
    })
    expect(copiedActivity?.id).not.toBe('tool-call')
    expect(copiedGroup?.id).not.toBe('tool-group')
    expect(copiedActivity?.activityGroupId).toBe(copiedGroup?.id)
    expect(copiedGroup?.activityIds).toEqual([copiedActivity?.id])
    expect(branched.messages[2].sortIndex).toBeLessThan(copiedActivity?.sortIndex ?? 0)
    expect(copiedActivity?.sortIndex).toBeLessThan(branched.messages[3].sortIndex ?? 0)
    expect(branched.conversationGraph?.branches).toHaveLength(1)
    expect(branched.conversationGraph?.frames).toHaveLength(1)
    expect(branched.conversationGraph?.messages.map((message) => message.id)).toEqual(
      branched.messages.map((message) => message.id)
    )
    expect(branched).not.toHaveProperty('artifacts')
    expect(branched).not.toHaveProperty('filesRevision')
    expect(branched).not.toHaveProperty('contextUsage')
    expect(branched).not.toHaveProperty('pinned')
    expect(branched).not.toHaveProperty('interrupted')
    expect(branched).not.toHaveProperty('error')
    expect(branched).not.toHaveProperty('agentStatus')
    expect(branched).not.toHaveProperty('branchContextResetRequired')
    expect(branched).not.toHaveProperty('specialistSwitchResetRequired')
  })

  it('namespaces copied activity relationships away from fresh runtime ids', () => {
    const sourcePrompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'inspect the source',
      cwd: '/workspace/project'
    })
    useSessionStore
      .getState()
      .beginActivityGroup('source-session', 'tool-group', 'Source tools', sourcePrompt?.messageId)
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'source-session',
      toolCallId: 'tool-call',
      eventId: 'source-tool-event',
      promptMessageId: sourcePrompt?.messageId,
      title: 'Read source file',
      status: 'completed'
    })
    useSessionStore.getState().finishRun('source-session')

    const branched = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: 'continue in a new session'
    })
    const childBeforeRuntimeCall = useSessionStore.getState().sessions[0]
    const copiedActivity = childBeforeRuntimeCall.activities?.[0]
    const copiedGroup = childBeforeRuntimeCall.activityGroups?.[0]

    expect(copiedActivity?.id).not.toBe('tool-call')
    expect(copiedGroup?.id).not.toBe('tool-group')
    expect(copiedActivity?.activityGroupId).toBe(copiedGroup?.id)
    expect(copiedGroup?.activityIds).toEqual([copiedActivity?.id])

    useSessionStore
      .getState()
      .beginActivityGroup(branched?.sessionId ?? '', 'tool-group', 'New tools', branched?.messageId)
    useSessionStore.getState().upsertToolActivity({
      sessionId: branched?.sessionId ?? '',
      toolCallId: 'tool-call',
      eventId: 'new-tool-event',
      promptMessageId: branched?.messageId,
      title: 'Read new file',
      status: 'completed'
    })

    const childAfterRuntimeCall = useSessionStore.getState().sessions[0]
    expect(childAfterRuntimeCall.activities).toHaveLength(2)
    expect(childAfterRuntimeCall.activities?.map((activity) => activity.id)).toEqual([
      copiedActivity?.id,
      'tool-call'
    ])
    expect(childAfterRuntimeCall.activityGroups?.map((group) => group.id)).toEqual([
      copiedGroup?.id,
      'tool-group'
    ])
  })

  it('uses the attachment-only title fallback and leaves a running source untouched', () => {
    const source = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'existing source'
    })
    useSessionStore.getState().finishRun('source-session')

    const attachmentOnly = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: ' ',
      attachments: [createUploadAttachment()]
    })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: attachmentOnly?.sessionId,
      title: 'Attached first.png',
      messages: [
        expect.objectContaining({ id: source?.messageId }),
        expect.objectContaining({
          id: attachmentOnly?.messageId,
          uploads: [expect.objectContaining({ id: 'upload-1' })]
        })
      ]
    })

    const running = useSessionStore.getState().appendUserMessage({
      sessionId: 'running-source',
      content: 'still running'
    })
    const before = useSessionStore.getState()
    expect(
      useSessionStore.getState().branchInNewSession({
        sourceSessionId: 'running-source',
        content: 'do not branch'
      })
    ).toBeUndefined()
    expect(useSessionStore.getState()).toBe(before)
    expect(running).toBeDefined()
  })

  it('clears a pending replay marker when its prompt is removed or already missing', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'stable source'
    })
    useSessionStore.getState().finishRun('source-session')

    const removed = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: 'resume this branch'
    })
    useSessionStore.getState().failRun(removed?.sessionId ?? '', 'creation failed')
    useSessionStore.getState().removeMessage(removed?.sessionId ?? '', removed?.messageId ?? '')
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === removed?.sessionId)
        ?.pendingContextReplayMessageId
    ).toBeUndefined()

    const truncated = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: 'edit this branch'
    })
    useSessionStore.getState().failRun(truncated?.sessionId ?? '', 'creation failed')
    useSessionStore
      .getState()
      .truncateSessionFromMessage(truncated?.sessionId ?? '', truncated?.messageId ?? '')
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === truncated?.sessionId)
        ?.pendingContextReplayMessageId
    ).toBeUndefined()

    const stale = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: 'missing branch prompt'
    })
    if (!stale) throw new Error('Expected a pending branched Session.')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === stale.sessionId
          ? {
              ...session,
              messages: session.messages.filter((message) => message.id !== stale.messageId)
            }
          : session
      )
    }))
    useSessionStore.getState().appendUserMessage({
      sessionId: stale.sessionId,
      content: 'replacement branch prompt'
    })

    const retried = useSessionStore
      .getState()
      .sessions.find((session) => session.id === stale.sessionId)
    expect(retried?.pendingContextReplayMessageId).toBeUndefined()
    expect(
      retried?.messages.filter((message) => message.content === 'replacement branch prompt')
    ).toHaveLength(1)
  })

  it('preserves inactive conversation branches when retrying a pending replay prompt', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'stable source'
    })
    useSessionStore.getState().finishRun('source-session')

    const pending = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      content: 'retry this branch'
    })
    if (!pending) throw new Error('Expected a pending branched Session.')
    useSessionStore.getState().failRun(pending.sessionId, 'creation failed')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== pending.sessionId || !session.conversationGraph) return session
        const activeBranch = session.conversationGraph.branches.find(
          ({ id }) => id === session.conversationGraph?.frames[0].activeBranchId
        )
        if (!activeBranch) throw new Error('Expected an active conversation Branch.')
        return {
          ...session,
          conversationGraph: {
            ...session.conversationGraph,
            branches: [
              ...session.conversationGraph.branches,
              {
                ...activeBranch,
                id: 'preserved-inactive-branch',
                parentBranchId: activeBranch.id,
                headMessageId: session.messages[0]?.id,
                updatedAt: Date.now() - 1
              }
            ]
          }
        }
      })
    }))

    useSessionStore.getState().appendUserMessage({
      sessionId: pending.sessionId,
      content: 'retry this branch'
    })

    const retried = useSessionStore
      .getState()
      .sessions.find((session) => session.id === pending.sessionId)
    expect(retried?.conversationGraph?.branches).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'preserved-inactive-branch' })])
    )
  })

  it('refuses a source whose conversation graph has failed synchronization', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'stable source'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session'
          ? { ...session, conversationGraphSyncBlocked: true }
          : session
      )
    }))
    const sourceBefore = structuredClone(useSessionStore.getState().sessions[0])

    expect(
      useSessionStore.getState().branchInNewSession({
        sourceSessionId: 'source-session',
        content: 'must not snapshot an invalid graph'
      })
    ).toBeUndefined()
    expect(useSessionStore.getState().sessions).toEqual([sourceBefore])
  })

  it('refuses a source that is waiting for Plan approval', () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'prepare a Plan'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session' ? { ...session, status: 'waiting-plan-approval' } : session
      )
    }))
    const sourceBefore = structuredClone(useSessionStore.getState().sessions[0])

    expect(
      useSessionStore.getState().branchInNewSession({
        sourceSessionId: 'source-session',
        content: 'bypass the pending Plan'
      })
    ).toBeUndefined()
    expect(useSessionStore.getState().sessions).toEqual([sourceBefore])
  })

  it('branches from persisted history while the source Provider still needs replay', () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'stable source',
      cwd: '/workspace/project',
      projectId: 'default-project'
    })
    const answer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'source-stream',
      eventId: 'source-event',
      content: 'stable answer'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session'
          ? { ...session, pendingHistoryReplay: { kind: 'all' as const } }
          : session
      )
    }))
    const result = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source-session',
      sourceMessageId: answer?.messageId ?? ''
    })

    expect(result).toEqual({ sessionId: expect.stringMatching(/^pending-session-/) })
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: result?.sessionId,
      isPending: true,
      pendingHistoryReplay: { kind: 'all' },
      messages: [
        expect.objectContaining({ id: prompt?.messageId }),
        expect.objectContaining({ id: answer?.messageId })
      ]
    })
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === 'source-session')
        ?.pendingHistoryReplay
    ).toEqual({ kind: 'all' })
  })
})

describe('truncateSessionFromMessage', () => {
  const baseTime = 1710000000000

  const createMessage = (
    id: string,
    role: 'user' | 'agent',
    createdAt: number,
    overrides: Partial<ChatMessage> = {}
  ): ChatMessage => ({
    id,
    role,
    content: `${id} content`,
    status: 'complete' as const,
    eventIds: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides
  })

  const createActivity = (id: string, createdAt: number): ToolActivity => ({
    id,
    kind: 'tool' as const,
    title: `activity ${id}`,
    status: 'completed' as const,
    eventIds: [`${id}-event`],
    sortIndex: createdAt,
    createdAt,
    updatedAt: createdAt
  })

  const seedSession = (overrides: Partial<ChatSession> = {}): void => {
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'default-project',
          title: 'session-1',
          cwd: '/workspace/project',
          status: 'idle' as const,
          messages: [
            createMessage('user-1', 'user', baseTime),
            createMessage('agent-1', 'agent', baseTime + 100),
            createMessage('user-2', 'user', baseTime + 200),
            createMessage('agent-2', 'agent', baseTime + 300)
          ],
          createdAt: baseTime,
          updatedAt: baseTime + 300,
          ...overrides
        }
      ],
      selectedSessionId: 'session-1'
    })
  }

  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  it('switches the compatibility projection at the cut while retaining the original Branch', () => {
    seedSession({
      status: 'error',
      error: 'previous failure',
      activeRun: { promptMessageId: 'user-2', startedAt: baseTime + 200 },
      interrupted: true
    })

    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')

    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.map((message) => message.id)).toEqual(['user-1', 'agent-1'])
    expect(session.status).toBe('idle')
    expect(session.activeRun).toBeUndefined()
    expect(session.error).toBeUndefined()
    expect(session.interrupted).toBeUndefined()
    expect(session.conversationGraph?.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'agent-2'
    ])
    expect(session.conversationGraph?.branches).toHaveLength(2)
  })

  it('cuts later activities by creation time and keeps earlier ones', () => {
    seedSession({
      activities: [
        createActivity('act-1', baseTime + 150),
        createActivity('act-2', baseTime + 250),
        createActivity('act-3', baseTime + 350)
      ]
    })

    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')

    expect(
      useSessionStore.getState().sessions[0].activities?.map((activity) => activity.id)
    ).toEqual(['act-1'])
  })

  it('prunes activity group references when edited resend removes their activities', () => {
    seedSession({
      activities: [
        {
          ...createActivity('act-1', baseTime + 150),
          activityGroupId: 'group-1',
          promptMessageId: 'user-1'
        },
        {
          ...createActivity('act-2', baseTime + 250),
          activityGroupId: 'group-1',
          promptMessageId: 'user-1'
        },
        {
          ...createActivity('act-3', baseTime + 350),
          activityGroupId: 'group-2',
          promptMessageId: 'user-2'
        }
      ],
      activityGroups: [
        {
          id: 'group-1',
          title: 'First group',
          sortIndex: 1,
          activityIds: ['act-1', 'act-2'],
          promptMessageId: 'user-1',
          createdAt: baseTime + 140,
          updatedAt: baseTime + 250,
          completedAt: baseTime + 260
        },
        {
          id: 'group-2',
          title: 'Second group',
          sortIndex: 2,
          activityIds: ['act-3'],
          promptMessageId: 'user-2',
          createdAt: baseTime + 340,
          updatedAt: baseTime + 350,
          completedAt: baseTime + 360
        }
      ]
    })

    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')

    expect(useSessionStore.getState().sessions[0].activityGroups).toEqual([
      expect.objectContaining({ id: 'group-1', activityIds: ['act-1'] })
    ])
  })

  it('advances filesRevision only when removed messages carry file references', () => {
    seedSession({
      filesRevision: 3,
      messages: [
        createMessage('user-1', 'user', baseTime),
        createMessage('agent-1', 'agent', baseTime + 100),
        createMessage('user-2', 'user', baseTime + 200, {
          uploads: [createUploadAttachment()]
        })
      ]
    })

    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    expect(useSessionStore.getState().sessions[0].filesRevision).toBe(4)

    seedSession({ filesRevision: 3 })
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    expect(useSessionStore.getState().sessions[0].filesRevision).toBe(3)
  })

  it('persists completed steps for a pending multi-question elicitation', () => {
    seedSession({
      activities: [
        {
          ...createActivity('choice-1', baseTime + 200),
          elicitation: {
            message: 'Choose two settings',
            fields: [
              {
                id: 'question_0',
                label: 'Scope',
                kind: 'single-select',
                options: [{ value: 'general', label: 'General' }]
              },
              { id: 'question_0_custom', label: 'Other', kind: 'text' },
              {
                id: 'question_1',
                label: 'Language',
                kind: 'single-select',
                options: [{ value: 'chinese', label: 'Chinese' }]
              },
              { id: 'question_1_custom', label: 'Other', kind: 'text' }
            ],
            state: 'pending',
            durable: { kind: 'agent-user-choice', requestId: 'choice-request-1' }
          }
        }
      ]
    })

    useSessionStore
      .getState()
      .setElicitationDraftAnswers('session-1', 'choice-1', [
        { fieldId: 'question_0', value: 'general' }
      ])

    const session = useSessionStore.getState().sessions[0]
    expect(session.activities?.[0].elicitation?.draftAnswers).toEqual([
      { fieldId: 'question_0', value: 'general' }
    ])
    expect(toPersistedSession(session).activities?.[0].elicitation?.draftAnswers).toEqual([
      { fieldId: 'question_0', value: 'general' }
    ])

    useSessionStore.getState().setElicitationDraftAnswers('session-1', 'choice-1', [])
    expect(
      useSessionStore.getState().sessions[0].activities?.[0].elicitation?.draftAnswers
    ).toBeUndefined()
  })

  it('forks immediately before a durable elicitation and preserves the old downstream Branch', () => {
    const choiceAt = baseTime + 200
    const choiceSortIndex = 100
    seedSession({
      messages: [
        createMessage('user-1', 'user', baseTime, { sortIndex: 10 }),
        createMessage('agent-1', 'agent', baseTime + 100, { sortIndex: 20 }),
        createMessage('user-2', 'user', choiceAt, { sortIndex: 80 }),
        createMessage('question-preamble', 'agent', choiceAt, { sortIndex: 90 }),
        createMessage('agent-2', 'agent', choiceAt, { sortIndex: 110 })
      ],
      activities: [
        { ...createActivity('act-before', choiceAt), sortIndex: 95 },
        {
          ...createActivity('choice-1', choiceAt),
          sortIndex: choiceSortIndex,
          promptMessageId: 'user-2',
          elicitation: {
            message: 'Choose a direction',
            fields: [
              {
                id: 'question_0',
                label: 'Direction',
                kind: 'single-select',
                options: [
                  { value: 'A', label: 'A' },
                  { value: 'B', label: 'B' }
                ]
              }
            ],
            state: 'answered',
            durable: {
              kind: 'agent-user-choice',
              requestId: 'choice-request-1',
              promptMessageId: 'user-2'
            },
            answers: [{ fieldId: 'question_0', value: 'A' }]
          }
        },
        { ...createActivity('act-after', choiceAt), sortIndex: 105 }
      ]
    })

    const revised = useSessionStore.getState().reviseSessionFromElicitation('session-1', 'choice-1')

    expect(revised).toBe(true)
    const session = useSessionStore.getState().sessions[0]
    expect(session.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'question-preamble'
    ])
    expect(session.activities?.map((activity) => activity.id)).toEqual(['act-before'])
    expect(session.conversationGraph?.branches).toHaveLength(2)
    expect(toPersistedSession(session).messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'question-preamble'
    ])
    expect(toPersistedSession(session).messages.at(-1)).not.toHaveProperty('sortIndex')
    expect(toPersistedSession(session).activities?.map((activity) => activity.id)).toEqual([
      'act-before'
    ])

    const originalBranchId = session.conversationGraph?.branches[0].id
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    expect(useSessionStore.getState().sessions[0].messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'question-preamble',
      'agent-2'
    ])
    expect(
      useSessionStore.getState().sessions[0].activities?.map((activity) => activity.id)
    ).toEqual(['act-before', 'choice-1', 'act-after'])
  })

  it('rebuilds renderer ordering for repeated same-timestamp revisions', () => {
    const choiceAt = baseTime + 200
    seedSession({
      messages: [
        createMessage('user-1', 'user', baseTime),
        createMessage('agent-1', 'agent', baseTime + 100),
        createMessage('user-2', 'user', choiceAt),
        createMessage('agent-2', 'agent', choiceAt)
      ],
      activities: [
        {
          ...createActivity('choice-1', choiceAt),
          promptMessageId: 'user-2',
          elicitation: {
            message: 'Choose a direction',
            fields: [
              {
                id: 'question_0',
                label: 'Direction',
                kind: 'single-select',
                options: [
                  { value: 'A', label: 'A' },
                  { value: 'B', label: 'B' }
                ]
              }
            ],
            state: 'answered',
            durable: {
              kind: 'agent-user-choice',
              requestId: 'choice-request-1',
              promptMessageId: 'user-2'
            },
            answers: [{ fieldId: 'question_0', value: 'A' }]
          }
        }
      ]
    })

    expect(useSessionStore.getState().reviseSessionFromElicitation('session-1', 'choice-1')).toBe(
      true
    )
    const originalBranchId =
      useSessionStore.getState().sessions[0].conversationGraph?.branches[0].id
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')

    expect(
      useSessionStore.getState().sessions[0].messages.find((message) => message.id === 'agent-2')
        ?.sortIndex
    ).toBeDefined()
    expect(useSessionStore.getState().reviseSessionFromElicitation('session-1', 'choice-1')).toBe(
      true
    )
    expect(useSessionStore.getState().sessions[0].messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2'
    ])
  })

  it('ignores unknown session or message ids', () => {
    seedSession()
    const before = useSessionStore.getState().sessions[0]

    useSessionStore.getState().truncateSessionFromMessage('session-unknown', 'user-2')
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'message-unknown')

    expect(useSessionStore.getState().sessions[0]).toBe(before)
  })

  it('switches between original and edited downstream histories as one Branch projection', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    expect(edited).toBeDefined()
    useSessionStore.getState().finishRun('session-1')

    const editedSession = useSessionStore.getState().sessions[0]
    const graph = editedSession.conversationGraph
    expect(graph).toBeDefined()
    const originalBranchId = graph?.branches[0].id
    const editedBranchId = graph?.frames[0].activeBranchId
    expect(editedSession.messages.map((message) => message.content)).toEqual([
      'user-1 content',
      'agent-1 content',
      'edited user-2'
    ])

    useSessionStore.getState().setBranchSwitchBlocked('session-1', true)
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.id).toBe(edited?.messageId)

    useSessionStore.getState().setBranchSwitchBlocked('session-1', false)
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    expect(useSessionStore.getState().sessions[0].messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      'user-2',
      'agent-2'
    ])
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBe(true)

    useSessionStore.getState().clearBranchContextReset('session-1')
    useSessionStore.getState().activateMessageBranch('session-1', editedBranchId ?? '')
    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.id).toBe(edited?.messageId)
    expect(useSessionStore.getState().sessions[0].branchContextResetRequired).toBe(true)
  })

  it('does not activate another Message Branch while a Plan awaits approval', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    useSessionStore.getState().finishRun('session-1')

    const editedSession = useSessionStore.getState().sessions[0]
    const originalBranchId = editedSession.conversationGraph?.branches[0].id
    useSessionStore.getState().setActivePlanProjection('session-1', {
      ...createPlanProjection('version-1'),
      originatingPromptMessageId: edited?.messageId
    })
    const waitingSession = useSessionStore.getState().sessions[0]
    const activeFrame = waitingSession.conversationGraph?.frames.find(
      (frame) => frame.id === waitingSession.conversationGraph?.activeFrameId
    )
    expect(waitingSession.status).toBe('waiting-plan-approval')

    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')

    const unchanged = useSessionStore.getState().sessions[0]
    expect(unchanged).toBe(waitingSession)
    expect(
      unchanged.conversationGraph?.frames.find(
        (frame) => frame.id === unchanged.conversationGraph?.activeFrameId
      )?.activeBranchId
    ).toBe(activeFrame?.activeBranchId)
  })

  it('materializes only the selected Message Branch Plan activities', () => {
    // Transcript projection receives this already-selected compatibility view. Exercise the public
    // Branch switch here, where the Graph is resolved into Session messages and activities.
    seedSession({
      activities: [
        {
          ...createActivity('original-plan', baseTime + 250),
          title: 'generate_plan',
          providerToolName: 'generate_plan',
          rawInput: { decision: 'approved' }
        }
      ]
    })
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    useSessionStore.getState().upsertToolActivity({
      sessionId: 'session-1',
      toolCallId: 'edited-plan',
      eventId: 'edited-plan-event',
      promptMessageId: edited?.messageId,
      title: 'generate_plan',
      providerToolName: 'generate_plan',
      status: 'completed',
      rawInput: { decision: 'rejected' }
    })
    useSessionStore.getState().finishRun('session-1')

    const editedSession = useSessionStore.getState().sessions[0]
    const originalBranchId = editedSession.conversationGraph?.branches[0].id
    const editedBranchId = editedSession.conversationGraph?.frames[0].activeBranchId

    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    expect(
      useSessionStore.getState().sessions[0].activities?.map((activity) => activity.id)
    ).toEqual(['original-plan'])

    useSessionStore.getState().activateMessageBranch('session-1', editedBranchId ?? '')
    expect(
      useSessionStore.getState().sessions[0].activities?.map((activity) => activity.id)
    ).toEqual(['edited-plan'])
  })

  it('does not replay an original Branch event onto an edited Branch', () => {
    seedSession({
      messages: [
        createMessage('user-1', 'user', baseTime),
        createMessage('agent-1', 'agent', baseTime + 100),
        createMessage('user-2', 'user', baseTime + 200),
        createMessage('agent-2', 'agent', baseTime + 300, {
          streamId: 'assistant-2',
          responseToMessageId: 'user-2',
          eventIds: ['event-2']
        })
      ]
    })
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    const beforeReplayState = useSessionStore.getState()
    const beforeReplay = beforeReplayState.sessions[0]

    const replayed = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-2',
      eventId: 'event-2',
      promptMessageId: 'user-2',
      content: 'agent-2 content'
    })

    const afterReplay = useSessionStore.getState().sessions[0]
    expect(replayed?.messageId).toBe('agent-2')
    expect(useSessionStore.getState()).toBe(beforeReplayState)
    expect(afterReplay).toBe(beforeReplay)
    expect(afterReplay.messages.map((message) => message.id)).toEqual([
      'user-1',
      'agent-1',
      edited?.messageId
    ])

    const collidingEvent = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-edited',
      eventId: 'event-2',
      promptMessageId: edited?.messageId,
      content: 'edited agent response'
    })
    expect(collidingEvent?.messageId).not.toBe('agent-2')
    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      id: collidingEvent?.messageId,
      responseToMessageId: edited?.messageId,
      content: 'edited agent response'
    })
  })

  it('retains an edited Branch response when an unchanged finalized Artifact is switched away and back', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const edited = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    const response = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-edited',
      eventId: 'assistant-event-edited',
      content: 'edited agent response'
    })
    const artifact = createArtifactFile({
      id: 'artifact-version-2',
      projectId: 'default-project',
      sessionId: 'session-1',
      runId: 'artifact-run-2',
      name: 'sin.png',
      mimeType: 'image/png'
    })
    const attached = useSessionStore.getState().attachRunArtifacts({
      sessionId: 'session-1',
      runId: 'artifact-run-2',
      promptMessageId: edited?.messageId,
      eventId: 'artifact-event-2',
      artifacts: [artifact]
    })
    expect(attached?.messageId).toBe(response?.messageId)

    // Provenance finalization can return the same immutable Version descriptor that was attached by
    // the pending event. Even when file metadata is unchanged, the new response must enter the Graph.
    useSessionStore.getState().replaceMessageArtifacts({
      sessionId: 'session-1',
      messageId: response?.messageId ?? '',
      artifacts: [artifact]
    })
    useSessionStore.getState().finishRun('session-1')

    const editedSession = useSessionStore.getState().sessions[0]
    const originalBranchId = editedSession.conversationGraph?.branches[0].id
    const editedBranchId = editedSession.conversationGraph?.frames[0].activeBranchId
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    useSessionStore.getState().activateMessageBranch('session-1', editedBranchId ?? '')

    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      id: response?.messageId,
      content: 'edited agent response',
      artifactIds: ['artifact-version-2']
    })
  })

  it('settles a completed run as an explicit error when its graph projection is inconsistent', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const branched = useSessionStore.getState().sessions[0]
    const originalGraph = branched.conversationGraph
    expect(originalGraph).toBeDefined()

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? {
              ...session,
              status: 'running',
              awaitingFirstAgentOutput: true,
              activeRun: { promptMessageId: 'user-2', startedAt: baseTime + 400 },
              messages: [...session.messages, createMessage('user-2', 'user', baseTime + 200)]
            }
          : session
      )
    }))

    expect(() => useSessionStore.getState().finishRun('session-1')).not.toThrow()

    const settled = useSessionStore.getState().sessions[0]
    expect(settled).toMatchObject({
      status: 'error',
      activeRun: undefined,
      awaitingFirstAgentOutput: undefined,
      errorReportable: true,
      conversationGraphSyncBlocked: true
    })
    expect(settled.error).toContain('Conversation history could not be finalized')
    expect(settled.conversationGraph).toBe(originalGraph)
    expect(() => toPersistedSession(settled)).toThrow(
      'Session persistence is blocked after conversation graph synchronization failed.'
    )
  })

  it('preserves the run failure context when graph synchronization also fails', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    const branched = useSessionStore.getState().sessions[0]
    const originalGraph = branched.conversationGraph

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? {
              ...session,
              status: 'running',
              activeRun: { promptMessageId: 'user-2', startedAt: baseTime + 400 },
              messages: [...session.messages, createMessage('user-2', 'user', baseTime + 200)]
            }
          : session
      )
    }))

    expect(() => useSessionStore.getState().failRun('session-1', 'Provider failed')).not.toThrow()

    const settled = useSessionStore.getState().sessions[0]
    expect(settled).toMatchObject({
      status: 'error',
      activeRun: undefined,
      errorReportable: true,
      conversationGraphSyncBlocked: true
    })
    expect(settled.error).toContain('Provider failed')
    expect(settled.error).toContain('Conversation history could not be finalized')
    expect(settled.conversationGraph).toBe(originalGraph)
  })

  it('retains a failed edited Branch response when switched away and back', () => {
    seedSession()
    useSessionStore.getState().truncateSessionFromMessage('session-1', 'user-2')
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'edited user-2'
    })
    const response = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'session-1',
      streamId: 'assistant-edited-failed',
      eventId: 'assistant-event-edited-failed',
      content: 'partial edited response'
    })
    useSessionStore.getState().failRun('session-1', 'Provider failed')

    const failedSession = useSessionStore.getState().sessions[0]
    const originalBranchId = failedSession.conversationGraph?.branches[0].id
    const editedBranchId = failedSession.conversationGraph?.frames[0].activeBranchId
    useSessionStore.getState().activateMessageBranch('session-1', originalBranchId ?? '')
    useSessionStore.getState().activateMessageBranch('session-1', editedBranchId ?? '')

    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      id: response?.messageId,
      content: 'partial edited response',
      status: 'error'
    })
  })

  it('marks and clears the specialist switch reset flag', () => {
    seedSession()
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()

    useSessionStore.getState().markSpecialistSwitchResetRequired('session-1')
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBe(true)

    useSessionStore.getState().clearSpecialistSwitchResetRequired('session-1')
    expect(useSessionStore.getState().sessions[0].specialistSwitchResetRequired).toBeUndefined()
  })

  it('never persists the transient elicitation history replay request id', () => {
    seedSession()
    useSessionStore.getState().setElicitationHistoryReplayRequest('session-1', 'choice-retry')

    const session = useSessionStore.getState().sessions[0]
    expect(session.elicitationHistoryReplayRequestId).toBe('choice-retry')
    expect(toPersistedSession(session)).not.toHaveProperty('elicitationHistoryReplayRequestId')
  })

  it('keeps the elicitation replay requirement across a durable save acknowledgement', () => {
    seedSession()
    useSessionStore.getState().setElicitationHistoryReplayRequest('session-1', 'choice-retry')

    const source = useSessionStore.getState().sessions[0]
    const durable = {
      ...toPersistedSession(source),
      title: 'Acknowledged title',
      updatedAt: source.updatedAt + 1
    }
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: durable,
      mode: 'replace-persisted-if-current'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Acknowledged title',
      elicitationHistoryReplayRequestId: 'choice-retry'
    })
  })

  it('projects Compute Host access authority without replacing newer local state', () => {
    seedSession()
    const source = useSessionStore.getState().sessions[0]
    useSessionStore.getState().renameSession('session-1', 'Newer local title')

    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: {
        ...toPersistedSession(source),
        enabledComputeHosts: ['ssh:lab', 'ssh:available'],
        selectedComputeHosts: ['ssh:lab'],
        computeConcurrencyLimit: 2,
        updatedAt: source.updatedAt + 1
      },
      mode: 'compute-host-access-authority'
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      title: 'Newer local title',
      enabledComputeHosts: ['ssh:lab', 'ssh:available'],
      selectedComputeHosts: ['ssh:lab'],
      computeConcurrencyLimit: 2
    })
  })
})
