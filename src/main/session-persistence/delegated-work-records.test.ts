import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import {
  normalizeSessionFile,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { preS6ReaderSave } from '../../shared/pre-s6-session-reader.fixture'
import type { CreateChildRecordInput } from '../delegation/session-records'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from './coordinator'

const key = { projectId: 'project-1', sessionId: 'session-1' } as const

const rootPrompt: PersistedChatMessage = {
  id: 'root-prompt',
  role: 'user',
  content: 'Coordinate the research.',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const createRootSession = (): PersistedChatSession => ({
  id: key.sessionId,
  projectId: key.projectId,
  title: 'Delegated research',
  cwd: '/workspace',
  status: 'idle',
  messages: [rootPrompt],
  conversationGraph: createLinearConversationGraph({
    sessionId: key.sessionId,
    messages: [rootPrompt],
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  }),
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2
})

type Harness = Readonly<{
  coordinator: SessionPersistenceCoordinator
  repository: SessionMutationRepository
  durable(): PersistedChatSession
}>

const createHarness = (
  seed = createRootSession(),
  onDelegatedWorkSessionUpdated?: (session: PersistedChatSession) => void
): Harness => {
  let durable = structuredClone(seed)
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: vi.fn(async () => ({
      result: { sessions: [structuredClone(durable)], manifest: { version: 1 as const } },
      isComplete: true
    })),
    loadProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadSessionWithDiagnostics: vi.fn(async () => ({
      status: 'found' as const,
      session: structuredClone(durable)
    })),
    assertSessionIdentityOwnership: vi.fn(async () => undefined),
    saveSession: vi.fn(async (session) => {
      durable = structuredClone(session)
    }),
    saveCommittedProjectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    deleteProjectSessions: vi.fn(async () => undefined),
    getProjectSessionDeletionState: vi.fn(async () => 'absent' as const),
    markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
    completeProjectSessionDeletion: vi.fn(async () => undefined),
    listLegacyProjectSessionTombstones: vi.fn(async () => []),
    saveManifest: vi.fn(async () => undefined)
  }
  const fileIndex: SessionFileIndex = {
    syncSession: vi.fn(async () => []),
    softDeleteSession: vi.fn(async () => 'session-delete'),
    restoreSession: vi.fn(async () => undefined),
    softDeleteProject: vi.fn(async () => 'project-delete'),
    reconcileActiveSessions: vi.fn(async () => undefined),
    reconcileProjectSessions: vi.fn(async () => undefined),
    markReconciliationIncomplete: vi.fn()
  }
  return {
    coordinator: new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onDelegatedWorkSessionUpdated
    ),
    repository,
    durable: () => structuredClone(durable)
  }
}

const child = (
  index: number,
  overrides: Partial<{
    task: string
    name: string
  }> = {}
): CreateChildRecordInput => ({
  frameId: `child-frame-${index}`,
  branchId: `child-branch-${index}`,
  messageId: `child-prompt-${index}`,
  attemptId: `attempt-${index}`,
  task: overrides.task ?? `Research part ${index}`,
  name: overrides.name ?? `Child ${index}`,
  resolvedAgent: { kind: 'main' as const },
  startedAt: 10 + index,
  callerSource: { rootMessageId: 'root-prompt', toolInvocationId: `delegate-${index}` },
  initiatingTurnMessageId: 'root-prompt'
})

describe('delegated-work Session records', () => {
  it('rejects child admission when the authoritative Session policy is deny', async () => {
    const { coordinator, durable, repository } = createHarness({
      ...createRootSession(),
      delegationPolicy: 'deny'
    })

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: durable().conversationGraph!.rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1)]
      })
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: expect.stringMatching(/delegation is disabled/i)
    })
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
  })

  it('linearizes a policy denial submitted before child admission for the same Session', async () => {
    const { coordinator, durable } = createHarness()
    const parentFrameId = durable().conversationGraph!.rootFrameId
    const expectedDelegatedWorkRevision = durable().runtimeContext?.revision ?? 0

    const denial = coordinator.setSessionDelegationPolicy(key.projectId, key.sessionId, 'deny')
    const admission = coordinator.createChildren(key, {
      expectedRevision: expectedDelegatedWorkRevision,
      parentFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })

    await expect(denial).resolves.toMatchObject({ delegationPolicy: 'deny' })
    await expect(admission).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(durable().delegationPolicy).toBe('deny')
    expect(durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
  })

  it('keeps an admitted child when admission is submitted before a later policy denial', async () => {
    const { coordinator, durable } = createHarness()
    const parentFrameId = durable().conversationGraph!.rootFrameId
    const expectedDelegatedWorkRevision = durable().runtimeContext?.revision ?? 0

    const admission = coordinator.createChildren(key, {
      expectedRevision: expectedDelegatedWorkRevision,
      parentFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    const denial = coordinator.setSessionDelegationPolicy(key.projectId, key.sessionId, 'deny')

    await expect(admission).resolves.toEqual([
      expect.objectContaining({ frameId: 'child-frame-1' })
    ])
    await expect(denial).resolves.toMatchObject({ delegationPolicy: 'deny' })
    expect(durable().runtimeContext?.delegatedWork?.records[0]?.attempts.at(-1)?.status).toBe(
      'running'
    )
  })

  it('publishes durable child start and finish projections after each repository commit', async () => {
    const published: PersistedChatSession[] = []
    const { coordinator, durable } = createHarness(createRootSession(), (session) => {
      expect(session).toEqual(durable())
      published.push(structuredClone(session))
    })
    const rootFrameId = durable().conversationGraph!.rootFrameId

    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    await coordinator.transitionAttempt(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      status: 'cancelled',
      endedAt: 20,
      cancellationReason: 'main_agent_stop'
    })

    expect(
      published.map(
        (session) => session.runtimeContext?.delegatedWork?.records[0]?.attempts.at(-1)?.status
      )
    ).toEqual(['running', 'cancelled'])
  })

  it('does not reverse a delegated commit when its Session publication callback throws', async () => {
    const { coordinator, durable } = createHarness(createRootSession(), () => {
      throw new Error('renderer lifecycle unavailable')
    })

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: durable().conversationGraph!.rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1)]
      })
    ).resolves.toEqual([expect.objectContaining({ frameId: 'child-frame-1' })])
    expect(durable().runtimeContext?.delegatedWork?.records[0]?.attempts.at(-1)?.status).toBe(
      'running'
    )
  })

  it('atomically validates required non-emoji names and rejects durable sibling conflicts', async () => {
    const { coordinator, durable } = createHarness()
    const rootFrameId = durable().conversationGraph!.rootFrameId

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(0, { name: 'Emoji 🧪' })]
      })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [
          child(1, { task: 'Trace sources', name: 'Trace sources' }),
          child(2, { task: 'Trace sources', name: 'Independent trace' })
        ]
      })
    ).resolves.toEqual([
      expect.objectContaining({ frameId: 'child-frame-1', name: 'Trace sources' }),
      expect.objectContaining({ frameId: 'child-frame-2', name: 'Independent trace' })
    ])

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 1,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [
          child(3, {
            task: 'Must not persist',
            name: '  TRACE\u2003SOURCES  '
          }),
          child(4, { task: 'Nor this child', name: 'Nor this child' })
        ]
      })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(
      durable().conversationGraph!.frames.filter(({ kind }) => kind === 'delegate')
    ).toHaveLength(2)
  })

  it('keeps terminal names occupied on the active branch and releases names from an inactive branch', async () => {
    const initial = createHarness()
    const rootFrameId = initial.durable().conversationGraph!.rootFrameId
    await initial.coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1, { name: 'Evidence review' })]
    })
    const switched = initial.durable()
    const originalBranchId = switched.conversationGraph!.frames.find(
      ({ id }) => id === rootFrameId
    )!.activeBranchId
    switched.conversationGraph!.frames.find(({ id }) => id === 'child-frame-1')!.status =
      'completed'

    const activeBranchId = 'message-branch-alternate'
    const activePrompt: PersistedChatMessage = {
      ...rootPrompt,
      id: 'alternate-prompt',
      content: 'Coordinate the alternate branch.',
      createdAt: 20,
      updatedAt: 20
    }
    switched.conversationGraph!.frames.find(({ id }) => id === rootFrameId)!.activeBranchId =
      activeBranchId
    switched.conversationGraph!.branches.push({
      id: activeBranchId,
      agentFrameId: rootFrameId,
      headMessageId: activePrompt.id,
      createdAt: 20,
      updatedAt: 20
    })
    switched.conversationGraph!.messages.push({
      ...activePrompt,
      agentFrameId: rootFrameId,
      introducedOnBranchId: activeBranchId,
      revisionRootMessageId: activePrompt.id
    })
    switched.messages = [activePrompt]
    const alternate = createHarness(switched)

    await expect(
      alternate.coordinator.createChildren(key, {
        expectedRevision: 1,
        parentFrameId: rootFrameId,
        originMessageId: activePrompt.id,
        children: [
          {
            ...child(2, { name: '  EVIDENCE\u2003REVIEW  ' }),
            callerSource: { rootMessageId: activePrompt.id, toolInvocationId: 'delegate-2' },
            initiatingTurnMessageId: activePrompt.id
          }
        ]
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'EVIDENCE REVIEW' })])

    const switchedBack = alternate.durable()
    switchedBack.conversationGraph!.frames.find(({ id }) => id === rootFrameId)!.activeBranchId =
      originalBranchId
    switchedBack.messages = [rootPrompt]
    const original = createHarness(switchedBack)
    await expect(
      original.coordinator.createChildren(key, {
        expectedRevision: 2,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(3, { name: 'evidence review' })]
      })
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: expect.stringMatching(/occupied on the current branch.*retry/i)
    })
  })

  it('allows the same normalized name in a different Session', async () => {
    const first = createHarness()
    const firstRootFrameId = first.durable().conversationGraph!.rootFrameId
    await first.coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: firstRootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1, { name: 'Evidence review' })]
    })

    const secondKey = { projectId: 'project-1', sessionId: 'session-2' } as const
    const secondSeed = createRootSession()
    secondSeed.id = secondKey.sessionId
    secondSeed.conversationGraph = createLinearConversationGraph({
      sessionId: secondKey.sessionId,
      messages: [rootPrompt],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const second = createHarness(secondSeed)
    await expect(
      second.coordinator.createChildren(secondKey, {
        expectedRevision: 0,
        parentFrameId: second.durable().conversationGraph!.rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1, { name: '  EVIDENCE\u2003REVIEW  ' })]
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'EVIDENCE REVIEW' })])
  })

  it('reads legacy duplicate, missing, and overlong names unchanged while treating readable names as occupied', async () => {
    const initial = createHarness()
    const rootFrameId = initial.durable().conversationGraph!.rootFrameId
    await initial.coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1), child(2), child(3), child(4)]
    })
    const legacy = initial.durable()
    const legacyFrames = legacy.conversationGraph!.frames.filter(({ kind }) => kind === 'delegate')
    legacyFrames[0].delegateName = 'Duplicate legacy'
    legacyFrames[1].delegateName = 'duplicate legacy'
    delete legacyFrames[2].delegateName
    legacyFrames[2].agentName = 'Legacy\u0085name'
    legacyFrames[3].delegateName = '界'.repeat(100)
    const reopened = createHarness(legacy)

    await expect(reopened.coordinator.readChildren(key, rootFrameId)).resolves.toHaveLength(4)
    expect(reopened.durable()).toEqual(legacy)

    await expect(
      reopened.coordinator.createChildren(key, {
        expectedRevision: 1,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(5, { task: 'Legacy name', name: 'Legacy name' })]
      })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await reopened.coordinator.createChildren(key, {
      expectedRevision: 1,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(6, { task: 'Fresh task', name: 'Fresh name' })]
    })
    const savedLegacyFrames = reopened
      .durable()
      .conversationGraph!.frames.filter(({ kind }) => kind === 'delegate')
      .slice(0, 4)
    expect(savedLegacyFrames).toEqual(legacyFrames)
  })

  it('stores Attempt-owned structured evidence atomically on the prompt Message and CASes one value', async () => {
    const initial = createRootSession()
    const { coordinator, durable } = createHarness(initial)
    const structuredChild = {
      ...child(1),
      structuredOutputEvidence: {
        attemptId: 'attempt-1',
        dialect: '2020-12' as const,
        profile: 'ajv-8-draft-2020-12-v1' as const,
        schemaDigest: 'a'.repeat(64),
        schema: { type: 'object' as const }
      }
    }
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: initial.conversationGraph!.rootFrameId,
      originMessageId: rootPrompt.id,
      children: [structuredChild]
    })
    expect(
      durable().conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
    ).toMatchObject({
      structuredOutputEvidence: {
        attemptId: 'attempt-1',
        schemaDigest: 'a'.repeat(64),
        schema: { type: 'object' }
      }
    })
    await expect(
      coordinator.submitStructuredOutput(key, {
        expectedRevision: 1,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        schemaDigest: 'a'.repeat(64),
        value: { answer: 42 },
        acceptedAt: 20
      })
    ).resolves.toBe('accepted')
    expect(
      durable().conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
    ).toMatchObject({
      structuredOutputEvidence: { accepted: { value: { answer: 42 }, acceptedAt: 20 } }
    })
    await expect(
      coordinator.submitStructuredOutput(key, {
        expectedRevision: 2,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        schemaDigest: 'a'.repeat(64),
        value: { answer: 42 },
        acceptedAt: 21
      })
    ).resolves.toBe('idempotent')

    const backup = normalizeSessionFile(durable())!
    const reopenedAfterLegacySave = preS6ReaderSave(durable())
    expect(reopenedAfterLegacySave.runtimeContext?.delegatedWork).toEqual(
      backup.runtimeContext?.delegatedWork
    )
    expect(reopenedAfterLegacySave.conversationGraph).toMatchObject({
      schemaVersion: backup.conversationGraph?.schemaVersion,
      rootFrameId: backup.conversationGraph?.rootFrameId,
      activeFrameId: backup.conversationGraph?.activeFrameId,
      frames: backup.conversationGraph?.frames,
      branches: backup.conversationGraph?.branches,
      runtimeSegments: backup.conversationGraph?.runtimeSegments,
      activities: backup.conversationGraph?.activities,
      activityGroups: backup.conversationGraph?.activityGroups
    })
    expect(
      reopenedAfterLegacySave.conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
    ).toMatchObject({
      id: 'child-prompt-1',
      delegatedTask: 'Research part 1',
      agentFrameId: 'child-frame-1'
    })
    expect(
      reopenedAfterLegacySave.conversationGraph?.messages.some(
        (message) => message.structuredOutputEvidence !== undefined
      )
    ).toBe(false)
    expect(
      backup.conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
        ?.structuredOutputEvidence?.accepted
    ).toEqual({ value: { answer: 42 }, acceptedAt: 20 })

    const corrupted = structuredClone(backup)
    const corruptedPrompt = corrupted.conversationGraph!.messages.find(
      ({ id }) => id === 'child-prompt-1'
    )!
    corruptedPrompt.structuredOutputEvidence = {
      ...corruptedPrompt.structuredOutputEvidence!,
      schemaDigest: 'invalid'
    }
    expect(
      normalizeSessionFile(corrupted)?.conversationGraph?.messages.find(
        ({ id }) => id === 'child-prompt-1'
      )
    ).toMatchObject({ structuredOutputEvidenceInvalid: true })
  })

  it('atomically owns the complete delegate subtree across stale Renderer saves', async () => {
    const initial = createRootSession()
    const { coordinator, durable } = createHarness(initial)
    const rootFrameId = initial.conversationGraph!.rootFrameId

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1, { name: 'Evidence' }), child(2, { name: 'Risks' })]
      })
    ).resolves.toEqual([
      {
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        name: 'Evidence',
        status: 'running'
      },
      {
        frameId: 'child-frame-2',
        attemptId: 'attempt-2',
        name: 'Risks',
        status: 'running'
      }
    ])
    await coordinator.startAttemptRuntime(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      runtimeSegmentId: 'segment-1',
      frameworkId: 'codex',
      startedAt: 20
    })
    expect(
      durable().conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
    ).toMatchObject({ runtimeSegmentId: 'segment-1' })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 2,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'message',
        runtimeSegmentId: 'segment-1',
        message: {
          id: 'child-answer-1',
          role: 'agent',
          content: 'Evidence found.',
          status: 'complete',
          eventIds: ['event-1'],
          createdAt: 21,
          updatedAt: 21
        }
      }
    })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 3,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: [
        {
          kind: 'activity',
          runtimeSegmentId: 'segment-1',
          promptMessageId: 'child-prompt-1',
          activity: {
            id: 'activity-1',
            kind: 'tool',
            title: 'Search evidence',
            activityGroupId: 'activity-group-1',
            status: 'completed',
            sortIndex: 0,
            eventIds: ['event-1'],
            createdAt: 20,
            updatedAt: 21
          }
        },
        {
          kind: 'activity-group',
          promptMessageId: 'child-prompt-1',
          activityGroup: {
            id: 'activity-group-1',
            title: 'Research',
            sortIndex: 0,
            activityIds: ['activity-1'],
            createdAt: 20,
            updatedAt: 21,
            completedAt: 21
          }
        }
      ]
    })

    await coordinator.saveSession({ ...initial, title: 'Renderer rename', updatedAt: 3 })

    const stored = durable()
    expect(stored.title).toBe('Renderer rename')
    expect(stored.runtimeContext).toMatchObject({
      revision: 4,
      delegatedWork: {
        records: [
          { agentFrameId: 'child-frame-1', attempts: [{ id: 'attempt-1' }] },
          { agentFrameId: 'child-frame-2', attempts: [{ id: 'attempt-2' }] }
        ]
      }
    })
    expect(stored.conversationGraph).toMatchObject({
      frames: expect.arrayContaining([
        expect.objectContaining({ id: 'child-frame-1', status: 'running' }),
        expect.objectContaining({ id: 'child-frame-2', status: 'running' })
      ]),
      branches: expect.arrayContaining([expect.objectContaining({ id: 'child-branch-1' })]),
      messages: expect.arrayContaining([expect.objectContaining({ id: 'child-answer-1' })]),
      activities: [expect.objectContaining({ id: 'activity-1' })],
      activityGroups: [expect.objectContaining({ id: 'activity-group-1' })],
      runtimeSegments: expect.arrayContaining([expect.objectContaining({ id: 'segment-1' })])
    })
  })

  it('fences terminal Attempts and admits only one same-Frame continuation', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    await coordinator.startAttemptRuntime(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      runtimeSegmentId: 'segment-1',
      frameworkId: 'codex',
      startedAt: 20
    })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 2,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'message',
        runtimeSegmentId: 'segment-1',
        message: {
          id: 'terminal-1',
          role: 'agent',
          content: 'Done.',
          status: 'complete',
          eventIds: [],
          createdAt: 21,
          updatedAt: 21
        }
      }
    })
    await coordinator.transitionAttempt(key, {
      expectedRevision: 3,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      status: 'completed',
      endedAt: 22,
      terminalMessageId: 'terminal-1'
    })
    const continuationCommand = (
      suffix: string,
      attemptId: string
    ): Parameters<typeof coordinator.startContinuationAttempt>[1]['messageCommand'] => ({
      messageId: `message-${suffix}`,
      requestId: `continue-${suffix}`,
      sourcePrincipal: 'root-frame',
      canonicalDigest: `digest-${suffix}`,
      sourceFrameId: 'root-frame',
      targetFrameId: 'child-frame-1',
      continuationAttemptId: attemptId,
      rootOriginMessageId: 'root-prompt',
      callerRootMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      rootBranchRevision: 'root-branch:0',
      direction: 'to_child' as const,
      disposition: 'continued' as const,
      text: 'continue',
      kind: 'info' as const,
      laneSequence: 1,
      queuedAt: 23,
      receipt: { status: 'queued' as const }
    })

    const attempts = await Promise.allSettled([
      coordinator.startContinuationAttempt(key, {
        expectedRevision: 4,
        frameId: 'child-frame-1',
        previousAttemptId: 'attempt-1',
        attemptId: 'attempt-2',
        messageId: 'continuation-2',
        message: 'Check one more source.',
        resolvedAgent: { kind: 'main' },
        startedAt: 23,
        callerSource: { rootMessageId: 'root-prompt', toolInvocationId: 'continue-2' },
        initiatingTurnMessageId: 'root-prompt',
        messageCommand: continuationCommand('2', 'attempt-2')
      }),
      coordinator.startContinuationAttempt(key, {
        expectedRevision: 4,
        frameId: 'child-frame-1',
        previousAttemptId: 'attempt-1',
        attemptId: 'attempt-3',
        messageId: 'continuation-3',
        message: 'Competing continuation.',
        resolvedAgent: { kind: 'main' },
        startedAt: 23,
        callerSource: { rootMessageId: 'root-prompt', toolInvocationId: 'continue-3' },
        initiatingTurnMessageId: 'root-prompt',
        messageCommand: continuationCommand('3', 'attempt-3')
      })
    ])

    expect(attempts.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(
      coordinator.applyAgentEvent(key, {
        expectedRevision: 5,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        event: {
          kind: 'message',
          runtimeSegmentId: 'segment-1',
          message: {
            id: 'late-message',
            role: 'agent',
            content: 'Too late.',
            status: 'complete',
            eventIds: [],
            createdAt: 24,
            updatedAt: 24
          }
        }
      })
    ).rejects.toMatchObject({ code: 'attempt-conflict' })
    await expect(coordinator.readChildren(key, rootFrameId)).resolves.toMatchObject([
      {
        frameId: 'child-frame-1',
        status: 'running',
        record: { attempts: [{ id: 'attempt-1', status: 'completed' }, { status: 'running' }] }
      }
    ])
  })

  it('does not publish partial child state when the atomic Session save fails', async () => {
    const { coordinator, repository, durable } = createHarness()
    const rootFrameId = durable().conversationGraph!.rootFrameId
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('durability unavailable'))

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1)]
      })
    ).rejects.toThrow('durability unavailable')

    await expect(coordinator.readChildren(key, rootFrameId)).resolves.toEqual([])
    expect(durable().runtimeContext).toBeUndefined()
    expect(durable().conversationGraph!.frames).toHaveLength(1)
  })

  it('runs delegated-work interruption recovery at the startup hydration boundary', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].runtimeContext?.delegatedWork?.records[0]).toMatchObject({
      attempts: [{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }]
    })
    expect(loaded.sessions[0].conversationGraph?.frames).toContainEqual(
      expect.objectContaining({ id: 'child-frame-1', status: 'cancelled' })
    )
  })

  it('preserves reliable message receipts while recovering interrupted delegated work', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    await coordinator.admitMessageCommand(key, {
      expectedRevision: 1,
      command: {
        messageId: 'message-command-1',
        requestId: 'request-1',
        sourcePrincipal: rootFrameId,
        canonicalDigest: 'a'.repeat(64),
        sourceFrameId: rootFrameId,
        targetFrameId: 'child-frame-1',
        targetAttemptId: 'attempt-1',
        rootOriginMessageId: rootPrompt.id,
        callerRootMessageId: rootPrompt.id,
        rootBranchId: 'root-branch-session-1',
        rootBranchRevision: rootPrompt.id,
        direction: 'to_child',
        disposition: 'message',
        text: 'Preserve this receipt.',
        kind: 'info',
        laneSequence: 1,
        queuedAt: 20,
        receipt: {
          status: 'accepted',
          acceptedAt: 21,
          evidence: 'provider_prompt_accepted'
        }
      }
    })

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].runtimeContext?.delegatedWork).toMatchObject({
      records: [
        {
          attempts: [{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }]
        }
      ],
      messageCommands: [
        {
          messageId: 'message-command-1',
          receipt: { status: 'accepted', evidence: 'provider_prompt_accepted' }
        }
      ]
    })
  })

  it('preserves records and message quarantines through explicit interruption recovery', async () => {
    const prepared = createHarness()
    const rootFrameId = prepared.durable().conversationGraph!.rootFrameId
    await prepared.coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    const interrupted = prepared.durable()
    interrupted.runtimeContext = {
      ...interrupted.runtimeContext!,
      delegatedWork: {
        ...interrupted.runtimeContext!.delegatedWork!,
        recordsQuarantine: { raw: ['corrupt-records'] },
        messageCommandsQuarantine: { raw: ['corrupt-message-command'] }
      }
    }
    const reopened = createHarness(interrupted)

    await expect(reopened.coordinator.recoverInterruptedDelegatedWork()).resolves.toEqual([
      { frameId: 'child-frame-1', attemptId: 'attempt-1' }
    ])

    expect(reopened.durable().runtimeContext?.delegatedWork).toMatchObject({
      records: [
        {
          attempts: [{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }]
        }
      ],
      recordsQuarantine: { raw: ['corrupt-records'] },
      messageCommandsQuarantine: { raw: ['corrupt-message-command'] }
    })
  })

  it('returns degraded hydration and retries delegated recovery after a transient save guard', async () => {
    const { coordinator, repository } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    vi.mocked(repository.saveSession).mockRejectedValueOnce(
      new Error('Session contains S2 data but its required pre-S2 backup is missing.')
    )

    const degraded = await coordinator.loadAll()

    expect(degraded.sessions[0].runtimeContext?.delegatedWork?.records[0]).toMatchObject({
      attempts: [{ status: 'running' }]
    })
    expect(degraded.diagnostics).toMatchObject({
      isComplete: false,
      failure: 'startup-reconciliation-failed'
    })

    const retried = await coordinator.loadAll()

    expect(retried.sessions[0].runtimeContext?.delegatedWork?.records[0]).toMatchObject({
      attempts: [{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }]
    })
    expect(retried.diagnostics).toMatchObject({ isComplete: true })
  })
})
