import { describe, expect, it, vi } from 'vitest'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionLoadDiagnostics
} from '../../shared/session-persistence'
import { createSessionDetailsOwner } from './owner'
import { selectSessionDetailsStartupCandidates } from './startup-catalog'

const session = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Historical title',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})
const complete = (): SessionLoadDiagnostics => ({
  isComplete: true,
  warnings: [],
  isProjectDeletionRecoveryComplete: true
})
const catalog = (diagnostics: SessionLoadDiagnostics | undefined): LoadAllSessionsResult => ({
  sessions: [session()],
  manifest: { version: 1 },
  diagnostics
})
const consumer = (
  failure?: Error
): {
  owner: ReturnType<typeof createSessionDetailsOwner>
  list: ReturnType<typeof vi.fn<() => Promise<PersistedChatSession[]>>>
} => {
  const list = vi.fn(async () => {
    if (failure) throw failure
    return [session()]
  })
  return {
    list,
    owner: createSessionDetailsOwner({
      sessions: { listSessions: list, mutateSession: vi.fn(async () => undefined) },
      targets: { resolve: vi.fn(async () => ({ mode: 'disabled' as const })) },
      inference: {
        generate: vi.fn(async () => {
          throw new Error('Unexpected inference')
        })
      },
      lifecycle: { publish: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() }
    })
  }
}

describe('startup Session details catalog admission', () => {
  it.each([
    ['missing diagnostics', undefined],
    ['incomplete scan', { ...complete(), isComplete: false }],
    ['unrecovered Project deletion', { ...complete(), isProjectDeletionRecoveryComplete: false }],
    [
      'missing Project deletion proof',
      { ...complete(), isProjectDeletionRecoveryComplete: undefined }
    ],
    [
      'corrupt authority despite a complete scan',
      {
        ...complete(),
        warnings: [
          { kind: 'corrupt', projectId: 'project-1', fileName: 'session.json', recovered: true }
        ]
      }
    ],
    [
      'reconciliation failure despite a complete scan',
      { ...complete(), failure: 'startup-reconciliation-failed' }
    ]
  ] satisfies Array<[string, SessionLoadDiagnostics | undefined]>)(
    'falls back to fresh authority for %s',
    async (_name, diagnostics) => {
      const candidates = selectSessionDetailsStartupCandidates(catalog(diagnostics))
      expect(candidates).toBeUndefined()
      const { owner, list } = consumer()
      try {
        await owner.start(candidates)
        expect(list).toHaveBeenCalledTimes(1)
      } finally {
        await owner.shutdown()
      }
    }
  )

  it('propagates failure of the fresh recovery read instead of treating it as empty history', async () => {
    const failure = new Error('Session authority unavailable')
    const { owner, list } = consumer(failure)
    try {
      await expect(
        owner.start(selectSessionDetailsStartupCandidates(catalog(undefined)))
      ).rejects.toBe(failure)
      expect(list).toHaveBeenCalledTimes(1)
    } finally {
      await owner.shutdown()
    }
  })

  it.each([{ sessions: [] }, { sessions: [session()] }])(
    'does not re-read a complete catalog with no recovery candidates: %j',
    async ({ sessions }) => {
      const candidates = selectSessionDetailsStartupCandidates({ ...catalog(complete()), sessions })
      expect(candidates).toEqual([])
      const { owner, list } = consumer(new Error('Unnecessary duplicate hydration'))
      try {
        await owner.start(candidates)
        expect(list).not.toHaveBeenCalled()
      } finally {
        await owner.shutdown()
      }
    }
  )

  it('retains every recovery category, including terminal generation validation, without changing source records', () => {
    const eligible = {
      ...session(),
      id: 'eligible',
      sessionDetailsGenerationEligible: true
    } satisfies PersistedChatSession
    const queued = {
      ...session(),
      id: 'queued',
      sessionDetailsGeneration: {
        status: 'queued' as const,
        sourceMessageId: 'message-1',
        requestId: 'request-1',
        queuedAt: 1
      }
    }
    const terminal = {
      ...queued,
      id: 'terminal',
      sessionDetailsGeneration: {
        ...queued.sessionDetailsGeneration,
        status: 'disabled' as const,
        completedAt: 2
      }
    }
    const branch = {
      ...session(),
      id: 'branch',
      branchSource: { sessionId: 'parent', headMessageId: 'message-1' }
    } satisfies PersistedChatSession
    const input = {
      ...catalog(complete()),
      sessions: [session(), eligible, queued, terminal, branch]
    }
    const before = structuredClone(input)
    expect(selectSessionDetailsStartupCandidates(input)?.map(({ id }) => id)).toEqual([
      'eligible',
      'queued',
      'terminal',
      'branch'
    ])
    expect(input).toEqual(before)
  })
})
