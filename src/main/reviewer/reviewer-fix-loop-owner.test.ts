import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntime } from '../acp/runtime'
import type { NewCheck, ReviewCheck, ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from './repository'

const mocks = vi.hoisted(() => ({
  injectAuditorMessage: vi.fn(),
  runReviewAssessment: vi.fn()
}))

vi.mock('./correction', () => ({ injectAuditorMessage: mocks.injectAuditorMessage }))
vi.mock('./review-assessment-owner', () => ({
  runReviewAssessment: mocks.runReviewAssessment
}))
vi.mock('../../shared/session-persistence', () => ({
  materializeSessionConversationGraph: () => ({ conversationGraph: {} })
}))
vi.mock('../../shared/conversation-graph', () => ({
  getActiveConversationContext: () => ({})
}))

const { runReviewerFixLoop } = await import('./reviewer-fix-loop-owner')

const session = (messages: PersistedChatSession['messages']): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Reviewer fix-loop owner test',
  cwd: join(tmpdir(), 'reviewer-fix-loop-workspace'),
  status: 'idle',
  messages,
  createdAt: 1,
  updatedAt: 1
})

const initialMessage: PersistedChatSession['messages'][number] = {
  id: 'initial-agent',
  role: 'agent',
  content: 'Initial answer',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const correctionMessage: PersistedChatSession['messages'][number] = {
  ...initialMessage,
  id: 'correction-agent',
  content: 'Corrected answer',
  createdAt: 2,
  updatedAt: 2
}

const openCheck: ReviewCheck = {
  id: 'finding-1',
  reviewId: 'source-review',
  status: 'warn',
  resolution: 'open',
  claim: 'Source claim',
  evidence: 'Source evidence',
  sortIndex: 0,
  reflagCount: 0,
  artifactBindingState: 'legacy_unverified'
}

const review = (id: string, checks: ReviewCheck[] = []): ReviewWithChecks => ({
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'original-turn',
  scope: { turnMessageId: 'original-turn', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: checks.length > 0 ? 'flagged' : 'pass',
  model: 'reviewer-model',
  reviewerLog: [],
  createdAt: 1,
  updatedAt: 1,
  checks
})

const makeOptions = (
  getSession: () => PersistedChatSession | Promise<PersistedChatSession>,
  reviewRepository: ReviewRepository,
  overrides: { abortSignal?: AbortSignal; onReviewUpdate?: (value: ReviewWithChecks) => void } = {}
): Parameters<typeof runReviewerFixLoop>[0] => ({
  sessionId: 'session-1',
  originalTurnMessageId: 'original-turn',
  openChecks: [openCheck],
  projectId: 'project-1',
  mainSessionId: 'main-session-1',
  getSession,
  reviewRepository,
  runSessionMutation: async (mutation) => mutation(),
  acpRuntime: {} as AcpRuntime,
  artifactStorageRoot: join(tmpdir(), 'reviewer-fix-loop-artifacts'),
  model: 'reviewer-model',
  reviewerTimeoutMs: 1000,
  reviewerMaxUpdates: 100,
  maxRounds: 1,
  sessionRefreshTimeoutMs: 200,
  ...overrides
})

describe('reviewer fix-loop owner', () => {
  beforeEach(() => {
    mocks.injectAuditorMessage.mockReset().mockResolvedValue(undefined)
    mocks.runReviewAssessment.mockReset()
  })

  it('reviews the exact durable snapshot that proves the correction completed', async () => {
    const before = session([initialMessage])
    const correctionSnapshot = session([initialMessage, correctionMessage])
    const getSession = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(correctionSnapshot)
    const submittedChecks: NewCheck[] = [
      {
        status: 'pass',
        claim: 'Fixed',
        evidence: 'Verified',
        sourceFindingId: openCheck.id
      }
    ]
    mocks.runReviewAssessment.mockResolvedValue({
      review: review('assessment-review'),
      submittedChecks
    })
    const repository = {
      commitFindingDispositions: vi.fn(),
      getReviewsForProjectSession: vi.fn()
    } as unknown as ReviewRepository

    await runReviewerFixLoop(makeOptions(getSession, repository))

    expect(mocks.runReviewAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'tracked',
        session: correctionSnapshot,
        scopeTurnMessageId: correctionMessage.id,
        turnMessageId: 'original-turn',
        trackedChecks: [openCheck]
      })
    )
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(repository.commitFindingDispositions).not.toHaveBeenCalled()
  })

  it('late-aborts while waiting, terminalizes inside mutation, then reloads and publishes outside', async () => {
    const events: string[] = []
    let inMutation = false
    const abortController = new AbortController()
    const before = session([initialMessage])
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockImplementationOnce(async () => {
        abortController.abort()
        return before
      })
    const sourceReview = review('source-review', [{ ...openCheck, resolution: 'unaddressed' }])
    const repository = {
      commitFindingDispositions: vi.fn(async (inputs: unknown[]) => {
        if (!inMutation) throw new Error('disposition write escaped mutation')
        events.push('write')
        expect(inputs).toEqual([
          expect.objectContaining({
            sourceFindingId: openCheck.id,
            trigger: 'aborted',
            outcome: 'unaddressed',
            note: 'The fix loop was aborted by the user.'
          })
        ])
      }),
      getReviewsForProjectSession: vi.fn(async () => {
        if (inMutation) throw new Error('reload ran inside mutation')
        events.push('reload')
        return [sourceReview]
      })
    } as unknown as ReviewRepository

    await runReviewerFixLoop({
      ...makeOptions(getSession, repository, {
        abortSignal: abortController.signal,
        onReviewUpdate: (value) => {
          if (inMutation) throw new Error('callback ran inside mutation')
          events.push(`publish:${value.id}`)
        }
      }),
      runSessionMutation: async (mutation) => {
        events.push('mutation:start')
        inMutation = true
        try {
          return await mutation()
        } finally {
          inMutation = false
          events.push('mutation:end')
        }
      }
    })

    expect(mocks.runReviewAssessment).not.toHaveBeenCalled()
    expect(events).toEqual([
      'mutation:start',
      'write',
      'mutation:end',
      'reload',
      'publish:source-review'
    ])
  })
})
