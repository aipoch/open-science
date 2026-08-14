import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntime } from '../acp/runtime'
import type { NewCheck, ReviewCheck, ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from './repository'

const mocks = vi.hoisted(() => ({
  sendApplicationPrompt: vi.fn(),
  runReviewAssessment: vi.fn(),
  getActiveConversationContext: vi.fn((_graph: unknown, promptMessageId: string) => ({
    promptMessageId
  })),
  resolveActiveConversationMessages: vi.fn(() => [
    {
      id: 'originating-user',
      role: 'user',
      status: 'complete'
    }
  ])
}))

vi.mock('./review-assessment-owner', () => ({
  runReviewAssessment: mocks.runReviewAssessment
}))
vi.mock('../../shared/session-persistence', () => ({
  materializeSessionConversationGraph: () => ({ conversationGraph: {} })
}))
vi.mock('../../shared/conversation-graph', () => ({
  getActiveConversationContext: mocks.getActiveConversationContext,
  resolveActiveConversationMessages: mocks.resolveActiveConversationMessages
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
  overrides: {
    abortSignal?: AbortSignal
    onReviewUpdate?: (value: ReviewWithChecks) => void
    maxRounds?: number
  } = {}
): Parameters<typeof runReviewerFixLoop>[0] => ({
  sessionId: 'session-1',
  originalTurnMessageId: 'original-turn',
  openChecks: [openCheck],
  projectId: 'project-1',
  mainSessionId: 'main-session-1',
  getSession,
  reviewRepository,
  runSessionMutation: async (mutation) => mutation(),
  acpRuntime: { sendApplicationPrompt: mocks.sendApplicationPrompt } as unknown as AcpRuntime,
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
    mocks.sendApplicationPrompt.mockReset().mockResolvedValue({ stopReason: 'end_turn' })
    mocks.runReviewAssessment.mockReset()
    mocks.getActiveConversationContext
      .mockReset()
      .mockImplementation((_graph: unknown, promptMessageId: string) => ({ promptMessageId }))
    mocks.resolveActiveConversationMessages.mockReset().mockReturnValue([
      {
        id: 'originating-user',
        role: 'user',
        status: 'complete'
      }
    ])
  })

  it('reviews the exact durable snapshot that proves the correction completed', async () => {
    const before = session([initialMessage])
    let correctionSnapshot: PersistedChatSession | undefined
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockImplementation(async () => {
        const promptMessageId =
          mocks.sendApplicationPrompt.mock.calls[0]?.[0].provenanceContext?.promptMessageId
        if (!promptMessageId) throw new Error('expected correction prompt identity')
        correctionSnapshot = session([
          initialMessage,
          { ...correctionMessage, responseToMessageId: promptMessageId }
        ])
        return correctionSnapshot
      })
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
      getReviewsForProjectSession: vi.fn().mockResolvedValue([])
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
    expect(mocks.getActiveConversationContext).toHaveBeenCalledWith({}, 'originating-user')
    expect(repository.commitFindingDispositions).not.toHaveBeenCalled()
  })

  it('waits through stale and unrelated durable messages for the exact correction response', async () => {
    const before = session([initialMessage])
    const unrelatedMessage = {
      ...correctionMessage,
      id: 'unrelated-agent',
      responseToMessageId: 'originating-user'
    }
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(session([initialMessage, unrelatedMessage]))
      .mockImplementationOnce(async () => {
        const correctionPromptMessageId =
          mocks.sendApplicationPrompt.mock.calls[0]?.[0].provenanceContext?.promptMessageId
        if (!correctionPromptMessageId) throw new Error('expected correction prompt identity')
        const exactCorrectionMessage = {
          ...correctionMessage,
          responseToMessageId: correctionPromptMessageId
        }
        return session([initialMessage, unrelatedMessage, exactCorrectionMessage])
      })
    mocks.runReviewAssessment.mockResolvedValue({
      review: review('assessment-review'),
      submittedChecks: [
        {
          status: 'pass',
          claim: 'Fixed',
          evidence: 'Verified',
          sourceFindingId: openCheck.id
        }
      ]
    })
    const repository = {
      commitFindingDispositions: vi.fn(),
      getReviewsForProjectSession: vi.fn()
    } as unknown as ReviewRepository

    await runReviewerFixLoop(makeOptions(getSession, repository))

    expect(mocks.runReviewAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeTurnMessageId: correctionMessage.id,
        session: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: correctionMessage.id,
              responseToMessageId:
                mocks.sendApplicationPrompt.mock.calls[0]?.[0].provenanceContext?.promptMessageId
            })
          ])
        })
      })
    )
    expect(getSession).toHaveBeenCalledTimes(4)
  })

  it('attributes each correction to the Review Run that requested that round', async () => {
    const secondCorrectionMessage = {
      ...correctionMessage,
      id: 'correction-agent-2',
      createdAt: 3,
      updatedAt: 3
    }
    let firstSnapshot: PersistedChatSession | undefined
    const getSession = vi.fn().mockImplementation(async () => {
      const callIndex = getSession.mock.calls.length
      if (callIndex === 1) return session([initialMessage])
      const firstPromptMessageId =
        mocks.sendApplicationPrompt.mock.calls[0]?.[0].provenanceContext?.promptMessageId
      if (!firstPromptMessageId) throw new Error('expected first correction prompt identity')
      firstSnapshot ??= session([
        initialMessage,
        { ...correctionMessage, responseToMessageId: firstPromptMessageId }
      ])
      if (callIndex === 2 || callIndex === 3) return firstSnapshot
      const secondPromptMessageId =
        mocks.sendApplicationPrompt.mock.calls[1]?.[0].provenanceContext?.promptMessageId
      if (!secondPromptMessageId) throw new Error('expected second correction prompt identity')
      return session([
        ...firstSnapshot.messages,
        { ...secondCorrectionMessage, responseToMessageId: secondPromptMessageId }
      ])
    })
    mocks.runReviewAssessment
      .mockResolvedValueOnce({
        review: review('re-review-1'),
        submittedChecks: [
          {
            status: 'warn',
            claim: 'Still open',
            evidence: 'Still unsupported',
            sourceFindingId: openCheck.id
          }
        ]
      })
      .mockResolvedValueOnce({
        review: review('re-review-2'),
        submittedChecks: [
          {
            status: 'pass',
            claim: 'Fixed',
            evidence: 'Now supported',
            sourceFindingId: openCheck.id
          }
        ]
      })
    const repository = {
      commitFindingDispositions: vi.fn(),
      getReviewsForProjectSession: vi.fn().mockResolvedValue([])
    } as unknown as ReviewRepository

    await runReviewerFixLoop(makeOptions(getSession, repository, { maxRounds: 2 }))

    expect(
      mocks.sendApplicationPrompt.mock.calls.map(([, attribution]) => attribution.causeReviewId)
    ).toEqual(['source-review', 're-review-1'])
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

  it.each([
    { name: 'an abort before the first round', aborted: true, maxRounds: 1, trigger: 'aborted' },
    { name: 'a zero-round cap', aborted: false, maxRounds: 0, trigger: 'loop_terminated' }
  ])(
    'creates no ghost correction or re-review after $name',
    async ({ aborted, maxRounds, trigger }) => {
      const abortController = new AbortController()
      if (aborted) abortController.abort()
      const repository = {
        commitFindingDispositions: vi.fn(),
        getReviewsForProjectSession: vi.fn().mockResolvedValue([])
      } as unknown as ReviewRepository

      await runReviewerFixLoop(
        makeOptions(vi.fn().mockResolvedValue(session([initialMessage])), repository, {
          abortSignal: abortController.signal,
          maxRounds
        })
      )

      expect(mocks.sendApplicationPrompt).not.toHaveBeenCalled()
      expect(mocks.runReviewAssessment).not.toHaveBeenCalled()
      expect(repository.commitFindingDispositions).toHaveBeenCalledWith([
        expect.objectContaining({ trigger })
      ])
    }
  )
})
