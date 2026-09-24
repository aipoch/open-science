import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { initDataRoot } from '../storage-root'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import { SessionPersistenceStateOwner } from './state-owner'

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
  const owner = new SessionPersistenceStateOwner({
    repository,
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  return {
    repository,
    owner,
    initial,
    raw: () => loadSessionMutationAuthority(repository, scope.projectId, scope.sessionId),
    restored: () => repository.loadSessionWithDiagnostics(scope.projectId, scope.sessionId)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable restart recovery before runtime attachment', () => {
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
