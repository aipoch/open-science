import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Review, ReviewWithChecks, TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from './repository'
import type { AcpRuntime } from '../acp/runtime'

// This is the REAL orchestrator side of the started-contract that ipc.ts depends on: runReview must
// call onStarted only AFTER the running Review row has been created and pushed (onReviewUpdate), and
// must NOT call it if the run fails before that (scope resolution or the createReview insert). The
// ipc.test.ts suite can only assert the IPC's translation of a MOCK runReview; this file pins the
// orchestrator behavior that translation relies on.

// Stub the heavy reviewer collaborators so runReview reaches the reviewer-session step without opening
// real HTTP/MCP servers. We force the session build to reject so the run errors out fast — onStarted
// has already fired by then, which is exactly the ordering under test.
vi.mock('./host-sdk', () => ({
  ReviewerHostServer: class {
    start = vi.fn().mockResolvedValue({ endpoint: 'http://127.0.0.1:0', token: 'tok' })
    stop = vi.fn().mockResolvedValue(undefined)
  },
  buildReviewerHostPythonBootstrap: () => ''
}))

vi.mock('./mcp-server', () => ({
  ReviewerMcpServer: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    toAcpMcpServerConfig = () => ({})
  }
}))

const resolveTurnScopeWithArtifactDigests = vi.fn()
vi.mock('./artifact-digest', () => ({
  resolveTurnScopeWithArtifactDigests: (...args: unknown[]) =>
    resolveTurnScopeWithArtifactDigests(...args)
}))

const { runReview } = await import('./orchestrator')

const scope: TurnScope = { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }

const runningReview = (): Review => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-1',
  scope,
  lifecycle: 'running',
  outcome: null,
  model: '',
  reviewerLog: [],
  createdAt: 1_000,
  updatedAt: 1_000
})

const session = { id: 'session-1', cwd: '', messages: [] } as unknown as PersistedChatSession

// The reviewer session build always rejects here: the run errors out right after onStarted, keeping
// the test focused on the start-contract without needing a full reviewer drive.
const acpRuntime = {
  buildReviewerSession: vi.fn().mockRejectedValue(new Error('build failed')),
  disposeReviewerSession: vi.fn()
} as unknown as AcpRuntime

const makeRepo = (createReview: ReviewRepository['createReview']): ReviewRepository =>
  ({
    createReview,
    updateReview: vi.fn().mockImplementation(async (id: string, patch: Partial<Review>) => ({
      ...runningReview(),
      id,
      ...patch
    })),
    addChecks: vi.fn().mockResolvedValue(undefined),
    getReviewsForSession: vi.fn().mockResolvedValue([])
  }) as unknown as ReviewRepository

const baseOptions = (
  reviewRepository: ReviewRepository,
  hooks: { onStarted: () => void; onReviewUpdate: (r: ReviewWithChecks) => void }
): Parameters<typeof runReview>[0] => ({
  sessionId: 'session-1',
  turnMessageId: 'turn-1',
  projectId: 'project-1',
  getSession: () => session,
  reviewRepository,
  acpRuntime,
  artifactStorageRoot: '/tmp/data-root',
  onStarted: hooks.onStarted,
  onReviewUpdate: hooks.onReviewUpdate
})

describe('runReview started-contract (real orchestrator)', () => {
  beforeEach(() => {
    resolveTurnScopeWithArtifactDigests.mockReset()
    resolveTurnScopeWithArtifactDigests.mockResolvedValue(scope)
  })

  it('calls onStarted exactly once, after the running row is created and pushed', async () => {
    const events: string[] = []
    const createReview = vi.fn().mockImplementation(async () => {
      events.push('createReview')
      return runningReview()
    })
    const onStarted = vi.fn().mockImplementation(() => events.push('onStarted'))
    const onReviewUpdate = vi
      .fn()
      .mockImplementation((r: ReviewWithChecks) => events.push(`update:${r.lifecycle}`))

    await runReview(baseOptions(makeRepo(createReview), { onStarted, onReviewUpdate }))

    expect(onStarted).toHaveBeenCalledTimes(1)
    // The running row must be created and pushed to the renderer before start is confirmed.
    expect(events.slice(0, 3)).toEqual(['createReview', 'update:running', 'onStarted'])
  })

  it('never calls onStarted when the createReview insert fails before the push', async () => {
    const onStarted = vi.fn()
    const onReviewUpdate = vi.fn()
    const createReview = vi.fn().mockRejectedValue(new Error('insert failed'))

    // The pre-push failure propagates out of runReview (createReview runs before the try/catch), which
    // is how ipc.ts's `.catch` reports started:false and leaves the turn retriable.
    await expect(
      runReview(baseOptions(makeRepo(createReview), { onStarted, onReviewUpdate }))
    ).rejects.toThrow('insert failed')

    expect(onStarted).not.toHaveBeenCalled()
    expect(onReviewUpdate).not.toHaveBeenCalled()
  })

  it('never calls onStarted when scope resolution fails before the push', async () => {
    resolveTurnScopeWithArtifactDigests.mockRejectedValueOnce(new Error('scope failed'))
    const onStarted = vi.fn()
    const onReviewUpdate = vi.fn()
    const createReview = vi.fn().mockResolvedValue(runningReview())

    await expect(
      runReview(baseOptions(makeRepo(createReview), { onStarted, onReviewUpdate }))
    ).rejects.toThrow('scope failed')

    expect(onStarted).not.toHaveBeenCalled()
    expect(createReview).not.toHaveBeenCalled()
  })
})
