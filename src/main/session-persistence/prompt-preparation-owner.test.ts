import { configureTestElectronHost } from '../../../test/runtime-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
import { SessionRepository } from './repository'
import { SessionPersistenceStateOwner } from './state-owner'
import {
  materializeSessionConversationGraph,
  sanitizeSession,
  normalizeSessionFile,
  resolvePreparationNoticeBaseline,
  resolveTurnOutcome,
  latestOutcomePrompt,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  type SessionConversationCommand,
  applySessionConversationCommands,
  sanitizeSessionConversationCommands
} from '../../shared/session-conversation-command'
import { SessionPromptPreparationOwner } from './prompt-preparation-owner'
import { preserveMainTurnOutcomes } from './turn-outcome-authority'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'

const fixture = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'error',
    error: 'Earlier failure',
    errorReportable: false,
    resumeRecovery: { kind: 'resume-required', promptMessageId: 'old', cause: 'app-restart' },
    messages: [
      {
        id: 'old',
        role: 'user',
        content: 'Earlier question',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    agentFrameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  })
const prepare = (
  mode: 'new' | 'resume' = 'new'
): Extract<SessionConversationCommand, { kind: 'prepare-prompt' }> => ({
  id: 'preparation',
  kind: 'prepare-prompt',
  timestamp: 10,
  promptMessageId: mode === 'new' ? 'new' : 'old',
  mode
})
const rollback = (id = 'rollback'): SessionConversationCommand => ({
  id,
  kind: 'rollback-prompt',
  timestamp: 20,
  preparationId: 'preparation'
})
const branchId = (session: PersistedChatSession): string =>
  session.conversationGraph!.frames[0].activeBranchId
const append = (branch: string, parentMessageId?: string): SessionConversationCommand => ({
  id: 'append',
  kind: 'append-user',
  timestamp: 11,
  preparationId: 'preparation',
  branchId: branch,
  parentMessageId,
  message: {
    id: 'new',
    role: 'user',
    content: 'Unsent question',
    status: 'complete',
    eventIds: [],
    createdAt: 11,
    updatedAt: 11
  }
})
const start = (promptMessageId = 'new'): SessionConversationCommand => ({
  id: 'start',
  kind: promptMessageId === 'new' ? 'start-run' : 'resume-run',
  timestamp: 12,
  preparationId: 'preparation',
  run: { promptMessageId, startedAt: 12 }
})
const fork = (parentBranchId: string): SessionConversationCommand => ({
  id: 'fork',
  kind: 'fork-message',
  timestamp: 11,
  preparationId: 'preparation',
  branchId: 'edit',
  parentBranchId,
  messageId: 'old'
})

// Each candidate is treated as a successful write by this helper; individual failure tests retain
// the prior authority instead, as the production repository does on a rejected write.
const commit = (
  owner: SessionPromptPreparationOwner,
  session: PersistedChatSession,
  commands: SessionConversationCommand[]
): PersistedChatSession => {
  const next = owner.apply(session, commands)
  owner.observe(next)
  return next
}

describe('Main prompt preparation rollback authority', () => {
  it.each([
    null,
    [[]],
    { status: 'unknown' },
    { status: 'idle', error: 42 },
    { status: 'idle', errorReportable: 'false' },
    { status: 'idle', resumeRecovery: null },
    {
      status: 'idle',
      resumeRecovery: { kind: 'resume-required', cause: 'app-restart', promptMessageId: '' }
    },
    {
      status: 'idle',
      resumeRecovery: { kind: 'resume-required', cause: 'app-restart', promptMessageId: 42 }
    },
    {
      status: 'idle',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'p'.repeat(257)
      }
    }
  ])('rejects malformed authority state but only drops malformed display state: %j', (invalid) => {
    const prepared = commit(
      new SessionPromptPreparationOwner(),
      { ...fixture(), runtimeTranscriptOwner: 'main' },
      [prepare()]
    )
    const marker = prepared.promptPreparation!
    for (const field of ['previousState', 'expectedState'] as const) {
      const decoded = sanitizeSession(
        { ...prepared, promptPreparation: { ...marker, [field]: invalid } },
        { preserveRuntimeState: true }
      )!
      expect(decoded.promptPreparation).toBeUndefined()
    }
    const decoded = sanitizeSession(
      {
        ...prepared,
        promptPreparation: {
          ...marker,
          noticeBaseline: { ...marker.noticeBaseline!, state: invalid }
        }
      },
      { preserveRuntimeState: true }
    )!
    expect(decoded.promptPreparation?.id).toBe(marker.id)
    expect(decoded.promptPreparation?.previousState).toEqual(marker.previousState)
    expect(decoded.promptPreparation?.expectedState).toEqual(marker.expectedState)
    expect(decoded.promptPreparation?.noticeBaseline).toBeUndefined()
  })

  it('preserves anchorless legacy display evidence without creating a historical outcome', () => {
    const original = materializeSessionConversationGraph({
      ...fixture(),
      conversationGraph: undefined,
      messages: [],
      runtimeTranscriptOwner: 'main',
      resumeRecovery: { kind: 'resume-required', cause: 'app-restart' }
    })
    const owner = new SessionPromptPreparationOwner()
    const prepared = commit(owner, original, [prepare(), append(branchId(original)), start()])
    expect(prepared.resumeRecovery).toBeUndefined()
    expect(resolvePreparationNoticeBaseline(prepared)).toMatchObject({
      messageBranchId: branchId(original),
      state: { status: 'error', resumeRecovery: { kind: 'resume-required', cause: 'app-restart' } }
    })
    expect(prepared.promptPreparation?.noticeBaseline?.promptMessageId).toBeUndefined()
    const decoded = sanitizeSession(prepared, { preserveRuntimeState: true })!
    expect(decoded.promptPreparation?.noticeBaseline).toEqual(
      prepared.promptPreparation?.noticeBaseline
    )
    expect(decoded.messages).toHaveLength(1)
    expect(decoded.messages[0].turnOutcome).toBeUndefined()
    const restored = commit(owner, prepared, [rollback()])
    expect(restored.messages).toEqual([])
    expect(restored.resumeRecovery).toEqual(original.resumeRecovery)
    expect(restored.promptPreparation).toBeUndefined()
  })
  it.each(['cancelled', 'interrupted', 'legacy-failed'] as const)(
    'retains exact original display evidence for %s through real new/edit commands without changing restart state',
    (kind) => {
      const latest = {
        ...fixture().messages[0],
        id: 'latest',
        createdAt: 2,
        updatedAt: 2,
        turnOutcome:
          kind === 'legacy-failed'
            ? undefined
            : kind === 'cancelled'
              ? { kind, settledAt: 3, recovery: 'resume' as const }
              : {
                  kind,
                  settledAt: 3,
                  recovery: 'resume' as const,
                  cause: 'connection-lost' as const
                }
      }
      const original = materializeSessionConversationGraph({
        ...fixture(),
        conversationGraph: undefined,
        runtimeTranscriptOwner: 'main',
        messages: [
          fixture().messages[0],
          latest,
          {
            ...fixture().messages[0],
            id: 'steering',
            responseToMessageId: latest.id,
            createdAt: 3,
            updatedAt: 3
          }
        ],
        resumeRecovery:
          kind === 'legacy-failed'
            ? undefined
            : {
                kind: 'resume-required',
                cause: kind === 'cancelled' ? 'cancelled' : 'connection-lost',
                promptMessageId: latest.id
              }
      })
      for (const editing of [false, true]) {
        const owner = new SessionPromptPreparationOwner()
        const prepared = commit(owner, original, [
          prepare(),
          ...(editing
            ? [fork(branchId(original)), append('edit')]
            : [append(branchId(original), 'steering')]),
          start()
        ])
        // start-run still snapshots the sanitized edited Branch, not the immutable display baseline.
        if (editing) {
          expect(prepared.promptPreparation?.previousState.error).toBeUndefined()
          expect(
            prepared.promptPreparation?.previousState.resumeRecovery?.promptMessageId
          ).toBeUndefined()
        }
        expect(resolvePreparationNoticeBaseline(prepared)).toMatchObject({
          messageBranchId: branchId(original),
          promptMessageId: latest.id,
          state: { status: original.status, error: original.error }
        })
        const decoded = sanitizeSession(prepared, { preserveRuntimeState: true })!
        expect(decoded.promptPreparation?.noticeBaseline).toEqual(
          prepared.promptPreparation?.noticeBaseline
        )
        const forged = preserveMainTurnOutcomes(
          {
            ...decoded,
            promptPreparation: {
              ...decoded.promptPreparation!,
              noticeBaseline: {
                messageBranchId: 'forged',
                promptMessageId: 'old',
                state: { status: 'error', error: 'Forged error' }
              }
            }
          },
          decoded
        )
        expect(forged.promptPreparation).toEqual(decoded.promptPreparation)
        const displaySession = {
          ...decoded,
          ...decoded.promptPreparation!.noticeBaseline!.state,
          activeRun: undefined,
          promptPreparation: undefined,
          conversationGraph: undefined,
          messages: resolveMessageBranchPath(decoded.conversationGraph!, branchId(original)).filter(
            ({ id }) => id !== 'new'
          )
        }
        expect(resolveTurnOutcome(displaySession, latest.id))?.toMatchObject({
          kind: kind === 'legacy-failed' ? 'failed' : kind
        })
        const markerWithoutDisplay = { ...prepared.promptPreparation, noticeBaseline: undefined }
        const restarted = normalizeSessionFile(prepared)!
        const oldCodecShape = normalizeSessionFile({
          ...prepared,
          promptPreparation: markerWithoutDisplay
        })!
        expect(restarted.status).toBe(oldCodecShape.status)
        expect(restarted.resumeRecovery).toEqual(oldCodecShape.resumeRecovery)
        expect(restarted.messages).toEqual(oldCodecShape.messages)
        const rolledBack = commit(owner, prepared, [rollback()])
        expect(rolledBack.promptPreparation).toBeUndefined()
        expect(latestOutcomePrompt(rolledBack)?.id).toBe(latest.id)

        for (const invalid of [
          { ...prepared.promptPreparation!.noticeBaseline!, messageBranchId: 'unrelated' },
          { ...prepared.promptPreparation!.noticeBaseline!, promptMessageId: 'old' },
          { ...prepared.promptPreparation!.noticeBaseline!, state: { status: 'unknown' } }
        ]) {
          const sanitized = sanitizeSession(
            {
              ...prepared,
              promptPreparation: {
                ...prepared.promptPreparation!,
                noticeBaseline: invalid
              }
            },
            { preserveRuntimeState: true }
          )!
          expect(sanitized.promptPreparation?.id).toBe('preparation')
          expect(sanitized.promptPreparation?.noticeBaseline).toBeUndefined()
        }
      }
    }
  )
  it('rejects overlapping windows without losing the durable preparation witness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prompt-preparation-overlap-'))
    try {
      const repository = new SessionRepository(root)
      const owner = new SessionPromptPreparationOwner()
      const original = await repository.saveSession({
        ...fixture(),
        runtimeTranscriptOwner: 'main',
        status: 'idle',
        error: undefined,
        resumeRecovery: undefined
      })
      let state = await repository.saveSession(commit(owner, original, [prepare()]))
      expect(() =>
        owner.apply(state, [{ ...prepare(), id: 'other-preparation', promptMessageId: 'other' }])
      ).toThrow('Branch changed')
      state = await repository.saveSession(
        commit(owner, state, [append(branchId(state), 'old'), start()])
      )
      expect(state.promptPreparation).toMatchObject({
        id: 'preparation',
        promptMessageId: 'new',
        runStartedAt: 12
      })
      const reopened = new SessionRepository(root)
      const main = new SessionPersistenceStateOwner({
        repository: reopened,
        fileIndex: { syncSession: vi.fn(async () => []) },
        assertMutable: vi.fn(),
        notifyFilesChanged: vi.fn(),
        notifyRuntimeContextSessionUpdated: vi.fn(),
        notifyRuntimeTranscriptSessionUpdated: vi.fn(),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })
      await main.prepareRuntimeResume({ projectId: 'p', sessionId: 's' })
      const recovered = (await reopened.loadSession('p', 's'))!
      expect(recovered.activeRun).toBeUndefined()
      expect(recovered.status).toBe('idle')
      expect(recovered.resumeRecovery).toBeUndefined()
      expect(recovered.messages.map(({ id }) => id)).toEqual(['old', 'new'])
      expect(recovered.messages[1].turnOutcome).toBeUndefined()
      expect(recovered.messages[1].interrupted).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects commands from a retained receipt whose preparation never committed', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    owner.apply(original, [prepare()])
    const state = commit(owner, original, [
      { ...prepare(), id: 'other-preparation', promptMessageId: 'other' }
    ])
    expect(() => owner.apply(state, [append(branchId(state), 'old'), start()])).toThrow(
      'Branch changed'
    )
    expect(() => owner.apply(state, [prepare()])).toThrow('Branch changed')
    expect(state.promptPreparation?.id).toBe('other-preparation')
    expect(state.messages).toEqual(original.messages)
  })

  it.each([false, true])('undoes only this unadmitted submission (edited branch: %s)', (edited) => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    let state = commit(owner, original, [prepare()])
    if (edited) state = commit(owner, state, [fork(branchId(state))])
    const appendCommand = append(branchId(state), edited ? undefined : 'old')
    state = commit(owner, state, [appendCommand, start()])
    expect(owner.hasUnadmittedRun(state)).toBe(true)
    const restored = commit(owner, { ...state, title: 'Concurrent rename' }, [rollback()])
    expect(restored).toMatchObject({
      title: 'Concurrent rename',
      status: original.status,
      error: original.error,
      resumeRecovery: original.resumeRecovery
    })
    expect(restored.activeRun).toBeUndefined()
    expect(restored.messages).toEqual(original.messages)
    expect(restored.conversationGraph?.messages).toEqual(original.conversationGraph?.messages)
    expect(
      restored.conversationGraph?.branches.map(({ id, headMessageId }) => ({ id, headMessageId }))
    ).toEqual(
      original.conversationGraph?.branches.map(({ id, headMessageId }) => ({ id, headMessageId }))
    )
    expect(branchId(restored)).toBe(branchId(original))
    // Already-acknowledged delayed intents are harmless; a new command using the closed receipt is rejected.
    expect(owner.apply(restored, [appendCommand]).messages).toEqual(original.messages)
    expect(() => owner.apply(restored, [{ ...appendCommand, id: 'late-new-command' }])).toThrow()
  })

  it('preserves independent Main failure after preparation and before tagged changes', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    let state = commit(owner, original, [prepare()])
    const concurrent = {
      ...state,
      error: 'Independent Main failure',
      errorReportable: true,
      resumeRecovery: {
        kind: 'resume-required' as const,
        promptMessageId: 'old',
        cause: 'connection-lost' as const
      }
    }
    state = commit(owner, concurrent, [append(branchId(state), 'old'), start()])
    const restored = commit(owner, state, [rollback()])
    expect(restored.error).toBe(concurrent.error)
    expect(restored.errorReportable).toBe(true)
    expect(restored.resumeRecovery).toEqual(concurrent.resumeRecovery)
  })

  it('releases state ownership when another writer changes it between tagged commands', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    let state = commit(owner, original, [prepare(), append(branchId(original), 'old')])
    state = { ...state, error: 'New independent failure', errorReportable: true }
    state = commit(owner, state, [start()])
    const restored = commit(owner, state, [rollback()])
    expect(restored.error).toBe('New independent failure')
    expect(restored.errorReportable).toBe(true)
  })

  it('returns to the selected branch immediately before this edit fork', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    let state = commit(owner, original, [prepare()])
    state = applySessionConversationCommands(state, [
      {
        kind: 'fork-message',
        id: 'independent-fork',
        timestamp: 10,
        branchId: 'independent',
        parentBranchId: branchId(original),
        messageId: 'old'
      }
    ])
    state = applySessionConversationCommands(state, [
      {
        ...append('independent'),
        id: 'independent-append',
        preparationId: undefined,
        message: { ...original.messages[0], id: 'independent-prompt' }
      } as SessionConversationCommand
    ])
    state = commit(owner, state, [
      { ...fork('independent'), messageId: 'independent-prompt' } as SessionConversationCommand
    ])
    const restored = commit(owner, state, [rollback()])
    expect(branchId(restored)).toBe('independent')
    expect(restored.conversationGraph?.branches.map(({ id }) => id)).toContain('independent')
  })

  it('restores the branch head immediately before append, preserving intervening history', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    let state = commit(owner, original, [prepare()])
    state = applySessionConversationCommands(state, [
      {
        ...append(branchId(state), 'old'),
        id: 'independent-command',
        preparationId: undefined,
        message: { ...original.messages[0], id: 'independent' }
      } as SessionConversationCommand
    ])
    const before = state
    state = commit(owner, state, [append(branchId(state), 'independent')])
    const restored = commit(owner, state, [rollback()])
    expect(restored.messages).toEqual(before.messages)
    expect(restored.conversationGraph?.branches[0].headMessageId).toBe('independent')
  })

  it('rejects unsupported tagged branch selection without changing authority', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = commit(owner, fixture(), [prepare()])
    expect(() =>
      owner.apply(original, [
        {
          kind: 'select-branch',
          id: 'select',
          timestamp: 11,
          preparationId: 'preparation',
          branchId: branchId(original)
        } as SessionConversationCommand
      ])
    ).toThrow('Branch changed')
  })

  it('can undo a persisted edit fork before any replacement prompt exists', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const forked = commit(owner, original, [prepare(), fork(branchId(original))])
    const restored = commit(owner, forked, [rollback()])
    expect(restored.conversationGraph?.messages).toEqual(original.conversationGraph?.messages)
    expect(restored.conversationGraph?.branches).toHaveLength(1)
    expect(branchId(restored)).toBe(branchId(original))
    expect(restored.error).toBe(original.error)
  })

  it('retries the same edit fork after a failed write without claiming a second branch', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = commit(owner, fixture(), [prepare()])
    const command = fork(branchId(original))
    owner.apply(original, [command]) // rejected physical write, authority remains unchanged
    const retried = commit(owner, original, [command])
    expect(retried.conversationGraph?.branches).toHaveLength(2)
    const restored = commit(owner, retried, [rollback()])
    expect(restored.conversationGraph?.branches).toHaveLength(1)
    expect(restored.messages).toEqual(original.messages)
  })

  it('retains rollback authority when its first persistence attempt fails', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const prepared = commit(owner, original, [
      prepare(),
      append(branchId(original), 'old'),
      start()
    ])
    owner.apply(prepared, [rollback()]) // candidate was not persisted
    const retried = commit(owner, prepared, [rollback('retry-rollback')])
    expect(retried.messages).toEqual(original.messages)
    expect(retried.activeRun).toBeUndefined()
  })

  it('restores a stable application prompt rearm without requiring Resume recovery', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = { ...fixture(), resumeRecovery: undefined }
    const prepared = commit(owner, original, [
      { ...prepare('resume'), mode: 'rearm' } as SessionConversationCommand,
      { ...start('old'), kind: 'start-run' } as SessionConversationCommand
    ])
    expect(prepared.activeRun?.promptMessageId).toBe('old')
    const restored = commit(owner, prepared, [rollback()])
    expect(restored.activeRun).toBeUndefined()
    expect(restored.messages).toEqual(original.messages)
    expect(restored.error).toBe(original.error)
    expect(restored.resumeRecovery).toBeUndefined()
  })

  it('restores Resume preparation without deleting or changing the historical prompt', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const prepared = commit(owner, original, [prepare('resume'), start('old')])
    expect(prepared.status).toBe('running')
    const restored = commit(owner, prepared, [rollback()])
    expect(restored.messages).toEqual(original.messages)
    expect(restored.status).toBe(original.status)
    expect(restored.error).toBe(original.error)
    expect(restored.resumeRecovery).toEqual(original.resumeRecovery)
  })

  it.each(['new', 'resume'] as const)('never rolls back an admitted %s attempt', (mode) => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const commands = [
      prepare(mode),
      ...(mode === 'new' ? [append(branchId(original), 'old')] : []),
      start(mode === 'new' ? 'new' : 'old')
    ]
    const prepared = commit(owner, original, commands)
    const graph = prepared.conversationGraph!
    const admitted = {
      ...prepared,
      runtimeSessionAdmissions: [
        {
          executionId: 'main-execution',
          promptMessageId: mode === 'new' ? 'new' : 'old',
          rootFrameId: graph.rootFrameId,
          agentFrameId: graph.rootFrameId,
          messageBranchId: branchId(prepared),
          runtimeSegmentId: graph.runtimeSegments[0].id,
          promptRuntimeSegmentId: graph.runtimeSegments[0].id
        }
      ]
    }
    const result = commit(owner, admitted, [rollback()])
    expect(result.messages).toEqual(admitted.messages)
    expect(result.activeRun).toEqual(admitted.activeRun)
    expect(result.status).toBe(admitted.status)
  })

  it('rejects rollback when a concurrent descendant depends on the new prompt', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const prepared = commit(owner, original, [prepare(), append(branchId(original), 'old')])
    const concurrent = applySessionConversationCommands(prepared, [
      {
        id: 'another-append',
        kind: 'append-user',
        timestamp: 13,
        branchId: branchId(prepared),
        parentMessageId: 'new',
        message: { ...original.messages[0], id: 'concurrent', createdAt: 13, updatedAt: 13 }
      }
    ])
    expect(() => owner.apply(concurrent, [rollback()])).toThrow('Branch changed')
    expect(concurrent.conversationGraph?.messages.map(({ id }) => id)).toEqual([
      'old',
      'new',
      'concurrent'
    ])
  })

  it('preserves a concurrent branch that references the unadmitted prompt', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    const prepared = commit(owner, original, [prepare(), append(branchId(original), 'old')])
    const concurrent = applySessionConversationCommands(prepared, [
      {
        kind: 'fork-message',
        id: 'concurrent-fork',
        timestamp: 13,
        branchId: 'concurrent',
        parentBranchId: branchId(prepared),
        messageId: 'new'
      }
    ])
    expect(() => owner.apply(concurrent, [rollback()])).toThrow('Branch changed')
    expect(concurrent.conversationGraph?.messages.some(({ id }) => id === 'new')).toBe(true)
  })

  it('rejects forged or cross-session preparation identities and cannot delete historical nodes', () => {
    const owner = new SessionPromptPreparationOwner()
    const original = fixture()
    expect(() =>
      owner.apply(original, [
        { ...prepare(), promptMessageId: 'old' } as SessionConversationCommand
      ])
    ).toThrow()
    expect(() => owner.apply(original, [rollback()])).toThrow()
    commit(owner, original, [prepare()])
    expect(() => owner.apply({ ...original, id: 'other' }, [rollback()])).toThrow()
    expect(() =>
      owner.apply(original, [
        {
          ...append(branchId(original), 'old'),
          message: original.messages[0]
        } as SessionConversationCommand
      ])
    ).toThrow()
    expect(original.messages).toHaveLength(1)
  })

  it.each([undefined, 'main'] as const)(
    'rolls back separate JSON saves without restart normalization (owner: %s)',
    async (runtimeTranscriptOwner) => {
      const root = await mkdtemp(join(tmpdir(), 'prompt-preparation-'))
      try {
        const repository = new SessionRepository(root)
        const owner = new SessionPersistenceStateOwner({
          repository,
          fileIndex: { syncSession: vi.fn(async () => []) },
          assertMutable: vi.fn(),
          notifyFilesChanged: vi.fn(),
          notifyRuntimeContextSessionUpdated: vi.fn(),
          notifyRuntimeTranscriptSessionUpdated: vi.fn(),
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        })
        const original = await repository.saveSession({
          ...fixture(),
          runtimeTranscriptOwner
        })
        let state = await owner.saveSession(original, { conversationCommands: [prepare()] })
        state = await owner.saveSession(state, { conversationCommands: [fork(branchId(original))] })
        state = await owner.saveSession(state, { conversationCommands: [append('edit'), start()] })
        expect(state.activeRun?.promptMessageId).toBe('new')
        state = await owner.saveSession(state, { conversationCommands: [rollback()] })
        expect(state.activeRun).toBeUndefined()
        expect(state.error).toBe(original.error)
        const reopened = (await new SessionRepository(root).loadSession('p', 's'))!
        expect(reopened.messages.map(({ id }) => id)).toEqual(['old'])
        expect(reopened.conversationGraph?.branches.map(({ id }) => id)).toEqual(
          original.conversationGraph?.branches.map(({ id }) => id)
        )
        expect(reopened.resumeRecovery).toEqual(original.resumeRecovery)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('sanitizes the wire markers but refuses to execute them in the renderer projection helper', () => {
    expect(sanitizeSessionConversationCommands([prepare(), rollback()])).toEqual([
      prepare(),
      rollback()
    ])
    expect(() =>
      sanitizeSessionConversationCommands([{ ...rollback(), preparationId: '' }])
    ).toThrow()
    expect(() => applySessionConversationCommands(fixture(), [prepare()])).toThrow(
      'Invalid Session conversation command'
    )
  })
})

await configureTestElectronHost(await import('electron'))
