import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import type { SessionConversationCommand } from '../../shared/session-conversation-command'
import { initDataRoot } from '../storage-root'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import { SessionPersistenceStateOwner } from './state-owner'
import { RuntimeSessionOwner } from './runtime-session-owner'
import { createLogger, flushLogs, initLogger } from '../logger'
import { projectDiagnosticLog } from '../session-diagnostics/projection'

const roots: string[] = []
const scope = { projectId: 'project-1', sessionId: 'session-1' }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = async (liveSession = false, activePrompt = false) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-resume-recovery-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root, {
    hasActiveRuntimePrompt: () => activePrompt,
    hasLiveRuntimeSession: () => liveSession
  })
  const initial = await repository.saveSession(
    materializeSessionConversationGraph({
      id: scope.sessionId,
      projectId: scope.projectId,
      title: 'Interrupted research',
      cwd: '/workspace',
      status: 'running',
      runtimeTranscriptOwner: 'main',
      agentFrameworkId: 'codex',
      activeRun: { promptMessageId: 'prompt-1', startedAt: 2 },
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Research this topic',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    })
  )
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const owner = new SessionPersistenceStateOwner({
    repository,
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log
  })
  return {
    repository,
    owner,
    initial,
    root,
    log,
    raw: () => loadSessionMutationAuthority(repository, scope.projectId, scope.sessionId),
    restored: () => repository.loadSessionWithDiagnostics(scope.projectId, scope.sessionId)
  }
}

afterEach(async () => {
  await flushLogs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('exports runtime mutation failure diagnostics without changing the missing Session rejection', async () => {
  const h = await harness(true, true)
  const logDir = join(h.root, 'logs')
  initLogger({ logDir, mirrorToConsole: false })
  h.log.warn.mockImplementation(createLogger('session-persistence').warn)
  const graph = h.initial.conversationGraph!
  const turn = {
    ...scope,
    promptMessageId: 'prompt-1',
    executionId: 'execution-1',
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.frames[0].activeBranchId,
    runtimeSegmentId: graph.runtimeSegments[0].id
  }
  const runtime = new RuntimeSessionOwner({
    loadSession: async () => {
      const loaded = await h.raw()
      return loaded.status === 'found' ? loaded.session : undefined
    },
    mutateSession: (identity, mutate) => h.owner.mutateRuntimeSession(identity, mutate),
    finalizeArtifacts: vi.fn(async () => []),
    scheduleFlush: () => () => undefined
  })
  await runtime.begin(turn)
  // Fault injection verifies observability only; it is not a reproduction of the user trigger.
  await h.repository.deleteSession(scope.projectId, scope.sessionId)
  runtime.accept({
    id: 'event-1',
    timestamp: Date.now(),
    kind: 'message',
    level: 'info',
    sessionId: scope.sessionId,
    promptMessageId: turn.promptMessageId,
    messageId: 'response-1',
    role: 'assistant',
    text: 'PRIVATE_RESPONSE'
  })
  await expect(runtime.flush(scope.sessionId, turn.promptMessageId)).rejects.toThrow(
    'Cannot update a missing runtime Session.'
  )
  expect(await h.raw()).toEqual({ status: 'missing' })
  expect(h.log.warn).toHaveBeenCalledWith(
    'Runtime Session authority unavailable',
    expect.objectContaining({
      ...scope,
      operation: 'runtime-session-mutation',
      phase: 'load-authority',
      authorityStatus: 'missing',
      cachedProjectId: scope.projectId,
      metadataComplete: false
    })
  )
  await flushLogs()
  const raw = await readFile(join(logDir, 'main.log'), 'utf8')
  const exported = raw
    .trim()
    .split('\n')
    .map((line) => projectDiagnosticLog(JSON.parse(line)))
  expect(exported).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'Runtime Session authority unavailable',
        diagnostics: expect.objectContaining({
          ...scope,
          authorityStatus: 'missing',
          cachedProjectId: scope.projectId,
          metadataComplete: false
        })
      }),
      expect.objectContaining({
        event: 'Runtime Session mutation failed',
        diagnostics: expect.objectContaining({
          ...turn,
          operation: 'runtime-session-mutation',
          phase: 'flush-events',
          errorCategory: 'error'
        })
      })
    ])
  )
  expect(raw).not.toContain('PRIVATE_RESPONSE')
  expect(raw).not.toContain(h.initial.title)
  expect(raw).not.toContain(h.initial.cwd)
  h.log.warn.mockImplementationOnce(() => {
    throw new Error('Diagnostic sink unavailable')
  })
  await expect(runtime.flush(scope.sessionId, turn.promptMessageId)).rejects.toThrow(
    'Cannot update a missing runtime Session.'
  )
  expect(await h.raw()).toEqual({ status: 'missing' })
})

describe('durable restart recovery before runtime attachment', () => {
  it('keeps the first renderer active run before durable authority exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-first-run-'))
    roots.push(root)
    initDataRoot(root)
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
    const userMessage = {
      id: 'prompt-first',
      role: 'user' as const,
      content: 'First prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const candidate = materializeSessionConversationGraph({
      id: 'session-first',
      projectId: 'project-first',
      title: 'First run',
      cwd: '/workspace',
      status: 'running',
      activeRun: { promptMessageId: userMessage.id, startedAt: 2 },
      messages: [userMessage],
      createdAt: 1,
      updatedAt: 2
    })

    const saved = await owner.saveSession(candidate, {
      conversationCommands: [
        {
          id: 'start-first',
          kind: 'start-run',
          timestamp: 2,
          run: { promptMessageId: userMessage.id, startedAt: 2 }
        } satisfies SessionConversationCommand
      ]
    })

    expect(saved).toMatchObject({
      // Main owns Session status; the unadopted renderer run remains available for admission.
      status: 'idle',
      activeRun: { promptMessageId: userMessage.id, startedAt: 2 }
    })
  })

  it('preserves a prepared run when a stale renderer save lands before runtime adoption', async () => {
    const h = await harness(false)
    const unadopted = await h.repository.saveSession(
      materializeSessionConversationGraph({
        ...h.initial,
        runtimeTranscriptOwner: undefined,
        status: 'error',
        activeRun: undefined,
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        }
      })
    )
    const graph = unadopted.conversationGraph!
    const scopeWithTurn = {
      ...scope,
      promptMessageId: 'prompt-1',
      executionId: 'execution-1',
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.frames[0].activeBranchId,
      runtimeSegmentId: graph.runtimeSegments[0].id
    }

    await h.owner.saveSession(
      {
        ...unadopted,
        title: 'Renamed before adoption'
      },
      {
        conflictRebaseFields: ['title'],
        conversationCommands: [
          {
            id: 'resume-before-adoption',
            kind: 'resume-run',
            timestamp: 10,
            run: { promptMessageId: 'prompt-1', startedAt: 10 }
          } satisfies SessionConversationCommand
        ]
      }
    )

    const runtime = new RuntimeSessionOwner({
      loadSession: async () => {
        const loaded = await h.repository.loadSessionWithDiagnostics(
          scope.projectId,
          scope.sessionId,
          { preserveRuntimeState: true }
        )
        return loaded.status === 'found' ? loaded.session : undefined
      },
      mutateSession: (identity, mutate) => h.owner.mutateRuntimeSession(identity, mutate),
      finalizeArtifacts: vi.fn(async () => [])
    })

    await expect(runtime.begin(scopeWithTurn)).resolves.toMatchObject({
      activeRun: { promptMessageId: 'prompt-1', startedAt: 10 }
    })
    const prepared = await h.raw()
    expect(prepared).toMatchObject({
      status: 'found',
      session: { activeRun: { promptMessageId: 'prompt-1', startedAt: 10 } }
    })
    const persisted = await h.raw()
    expect(persisted.status).toBe('found')
    if (persisted.status !== 'found') throw new Error('Expected persisted Session')
    expect(persisted.session.activeRun).toEqual({ promptMessageId: 'prompt-1', startedAt: 10 })
  })
  it.each([
    { live: false, status: 'running' as const, activeRun: true },
    { live: false, status: 'running' as const, activeRun: false },
    { live: false, status: 'idle' as const },
    { live: false, status: 'error' as const },
    { live: true, status: 'running' as const, activeRun: true },
    { live: true, status: 'running' as const, activeRun: false },
    { live: true, status: 'idle' as const },
    { live: true, status: 'error' as const }
  ])(
    'persists a pending question before provider attachment (live=$live, status=$status, activeRun=$activeRun)',
    async ({ live, status, activeRun }) => {
      const h = await harness(live)
      const graph = h.initial.conversationGraph!
      const turn = {
        promptMessageId: 'prompt-1',
        agentFrameId: graph.activeFrameId,
        messageBranchId: graph.frames[0].activeBranchId,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }
      await h.repository.saveSession(
        applyRuntimeSessionEvents(h.initial, turn, [
          {
            id: 'question-event',
            timestamp: 3,
            kind: 'tool',
            level: 'info',
            sessionId: scope.sessionId,
            promptMessageId: turn.promptMessageId,
            toolCallId: 'question-1',
            title: 'Next step',
            status: 'in_progress',
            elicitation: {
              message: 'What should happen next?',
              state: 'pending',
              fields: [{ id: 'choice', label: 'Next step', kind: 'text' }],
              durable: {
                kind: 'agent-user-choice',
                requestId: 'request-1',
                promptMessageId: turn.promptMessageId
              }
            }
          }
        ])
      )
      if (status !== 'running' || !activeRun) {
        const saved = await h.raw()
        if (saved.status !== 'found') throw new Error('Missing historical question')
        await h.repository.saveSession({
          ...saved.session,
          status,
          activeRun: undefined,
          // The legacy interruption string also occurs without a resumeRecovery marker.
          error: status === 'error' ? 'Session was interrupted before the app closed.' : undefined
        })
      }
      const before = await h.raw()
      await h.owner.prepareRuntimeResume(scope)
      if (live) {
        expect(await h.raw()).toEqual(before)
        return
      }
      const committed = await h.raw()
      expect(committed).toMatchObject({
        status: 'found',
        session: {
          status: 'waiting-for-user',
          activities: [
            expect.objectContaining({ elicitation: expect.objectContaining({ state: 'pending' }) })
          ]
        }
      })
      if (committed.status !== 'found') throw new Error('Missing committed question')
      expect(committed.session.activeRun).toBeUndefined()
      expect(committed.session.resumeRecovery).toBeUndefined()
      expect(committed.session.error).toBeUndefined()
      if (activeRun) {
        expect(committed.session.runtimeTranscriptLastRun).toEqual(h.initial.activeRun)
      }
      // Once the provider is attached, reads preserve runtime state. The wait must already be on disk.
      const attached = new SessionRepository(h.root, { hasLiveRuntimeSession: () => true })
      expect(await attached.loadSession(scope.projectId, scope.sessionId)).toEqual(
        committed.session
      )
      await h.owner.prepareRuntimeResume(scope)
      expect(await h.raw()).toEqual(committed)
    }
  )

  it('commits the restore projection before reads begin preserving the attached runtime', async () => {
    const h = await harness()
    expect(await h.raw()).toMatchObject({
      status: 'found',
      session: {
        status: 'running',
        activeRun: h.initial.activeRun
      }
    })
    const restored = await h.restored()
    expect(restored).toMatchObject({
      status: 'found',
      session: {
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        }
      }
    })
    if (restored.status !== 'found') throw new Error('Missing fixture')
    expect(restored.session.activeRun).toBeUndefined()
    // Restore normalization alone has not changed mutation authority on disk.
    const before = await h.raw()
    expect(before.status === 'found' && before.session.resumeRecovery).toBeUndefined()

    await h.owner.prepareRuntimeResume(scope)

    const committed = await h.raw()
    expect(committed).toMatchObject({
      status: 'found',
      session: {
        runtimeTranscriptOwner: 'main',
        runtimeTranscriptLastRun: h.initial.activeRun,
        resumeRecovery: restored.session.resumeRecovery,
        messages: restored.session.messages
      }
    })
    if (committed.status !== 'found') throw new Error('Missing committed fixture')
    expect(committed.session.activeRun).toBeUndefined()
    expect(committed.session.revision).toBeGreaterThan(h.initial.revision!)
  })

  it.each([false, true])(
    'preserves recovery or a live run when saving a model preference (live=%s)',
    async (live) => {
      const h = await harness(live)
      const restored = await h.restored()
      if (restored.status !== 'found') throw new Error('Missing fixture')
      const saved = await h.owner.saveSession(
        {
          ...restored.session,
          agentConfiguration: {
            providerId: 'provider-1',
            model: 'alternate-model',
            reasoningEffort: 'default'
          }
        },
        { conflictRebaseFields: ['agentConfiguration'] }
      )
      expect(saved.status).toBe(restored.session.status)
      expect(saved.activeRun).toEqual(restored.session.activeRun)
      expect(saved.resumeRecovery).toEqual(restored.session.resumeRecovery)
      if (live) expect(saved.conversationGraph).toEqual(restored.session.conversationGraph)
      else
        expect(saved.messages[0].turnOutcome).toMatchObject({
          kind: 'interrupted',
          cause: 'app-restart',
          recovery: 'resume'
        })
      const persisted = await h.raw()
      if (persisted.status !== 'found') throw new Error('Missing saved fixture')
      expect(persisted.session.status).toBe(saved.status)
      expect(persisted.session.activeRun).toEqual(saved.activeRun)
      expect(persisted.session.resumeRecovery).toEqual(saved.resumeRecovery)
      expect(persisted.session.agentConfiguration).toEqual(saved.agentConfiguration)
      expect(saved.agentConfiguration?.model).toBe('alternate-model')
    }
  )

  it('leaves a live running Session untouched', async () => {
    const h = await harness(true)
    const before = await h.raw()
    const save = vi.spyOn(h.repository, 'saveSession')
    await h.owner.prepareRuntimeResume(scope)
    expect(save).not.toHaveBeenCalled()
    expect(await h.raw()).toEqual(before)
  })

  it.each([false, true])(
    'persists parked Plan recovery only without a live runtime; live=%s',
    async (live) => {
      const h = await harness(live)
      const pending = await h.repository.saveSession({
        ...h.initial,
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan-1',
            artifactVersionId: 'plan-version-1',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            originatingPromptMessageId: 'prompt-1',
            stepStatuses: {}
          }
        }
      })
      const before = await h.raw()
      if (live) {
        await h.owner.prepareRuntimeResume(scope)
        expect(await h.raw()).toEqual(before)
        return
      }
      const restored = await h.restored()
      expect(restored.status === 'found' && restored.session.activeRun).toBeUndefined()
      expect(restored.status === 'found' && restored.session.resumeRecovery).toBeUndefined()

      vi.spyOn(h.repository, 'saveSession').mockRejectedValueOnce(new Error('disk full'))
      await expect(h.owner.prepareRuntimeResume(scope)).rejects.toThrow('disk full')
      expect(await h.raw()).toEqual(before)
      await h.owner.prepareRuntimeResume(scope)

      const committed = await h.raw()
      expect(committed).toMatchObject({
        status: 'found',
        session: {
          status: 'waiting-plan-approval',
          runtimeContext: pending.runtimeContext,
          runtimeTranscriptLastRun: pending.activeRun
        }
      })
      expect(committed.status === 'found' && committed.session.activeRun).toBeUndefined()
      expect(committed.status === 'found' && committed.session.resumeRecovery).toBeUndefined()
      await h.owner.prepareRuntimeResume(scope)
      expect(await h.raw()).toEqual(committed)
    }
  )

  it('recovers a stale active prompt when the provider session is no longer live', async () => {
    const h = await harness(false, true)

    await h.owner.prepareRuntimeResume(scope)

    const recovered = await h.raw()
    expect(recovered).toMatchObject({
      status: 'found',
      session: {
        status: 'error',
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        }
      }
    })
    if (recovered.status !== 'found') throw new Error('Missing recovered fixture')
    expect(recovered.session.activeRun).toBeUndefined()

    const branch = recovered.session.conversationGraph!.branches[0]
    const nextMessage = {
      id: 'prompt-2',
      role: 'user' as const,
      content: 'Continue the research.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 4,
      updatedAt: 4
    }
    await expect(
      h.owner.saveSession(h.initial, {
        conversationCommands: [
          {
            id: 'append-after-restart',
            kind: 'append-user',
            timestamp: 4,
            branchId: branch.id,
            parentMessageId: branch.headMessageId,
            message: nextMessage
          }
        ]
      })
    ).resolves.toMatchObject({ messages: expect.arrayContaining([nextMessage]) })
  })

  it('preserves the original durable run when recovery persistence fails and permits retry', async () => {
    const h = await harness()
    const before = await h.raw()
    vi.spyOn(h.repository, 'saveSession').mockRejectedValueOnce(new Error('disk full'))
    await expect(h.owner.prepareRuntimeResume(scope)).rejects.toThrow('disk full')
    expect(await h.raw()).toEqual(before)
    await h.owner.prepareRuntimeResume(scope)
    expect(await h.raw()).toMatchObject({
      status: 'found',
      session: {
        runtimeTranscriptLastRun: h.initial.activeRun,
        resumeRecovery: { cause: 'app-restart', promptMessageId: 'prompt-1' }
      }
    })
  })

  it('rejects a stale restore projection when a newer revision commits before mutation', async () => {
    const h = await harness()
    const load = h.repository.loadSessionWithDiagnostics.bind(h.repository)
    vi.spyOn(h.repository, 'loadSessionWithDiagnostics').mockImplementationOnce(async (...args) => {
      const restored = await load(...args)
      await h.repository.saveSession({ ...h.initial, title: 'Newer authority' }, h.initial.revision)
      return restored
    })
    await expect(h.owner.prepareRuntimeResume(scope)).rejects.toThrow('Session changed')
    const latest = await h.raw()
    expect(latest).toMatchObject({
      status: 'found',
      session: {
        title: 'Newer authority',
        activeRun: h.initial.activeRun
      }
    })
    expect(latest.status === 'found' && latest.session.resumeRecovery).toBeUndefined()
  })
})
