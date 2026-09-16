import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ReviewCheck } from '../../shared/reviewer'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  forkEditedConversationMessage,
  getActiveConversationContext
} from '../../shared/conversation-graph'
import type { ReviewerAcpRuntime } from './acp-runtime'
import type { ReviewRepository } from './repository'
import {
  ReviewerCorrectionContext,
  ReviewerCorrectionContextChangedError
} from './correction-context'
import { runReviewerFixLoop } from './reviewer-fix-loop-owner'
import { resolveTurnScope } from './scope'

const assessment = vi.hoisted(() => vi.fn())
vi.mock('./review-assessment-owner', () => ({ runReviewAssessment: assessment }))

const message = (
  id: string,
  role: 'user' | 'agent',
  timestamp: number
): PersistedChatSession['messages'][number] => ({
  id,
  role,
  content: id,
  status: 'complete' as const,
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp
})

const finding: ReviewCheck = {
  id: 'finding-1',
  reviewId: 'original-review',
  status: 'warn',
  resolution: 'open',
  claim: 'The original answer is unsupported.',
  evidence: 'No supporting evidence.',
  sortIndex: 0,
  reflagCount: 0
}

describe('historical review correction context', () => {
  it.each(['newer turn', 'different branch'] as const)(
    'does not inject historical findings into a %s',
    async (change) => {
      const session: PersistedChatSession = materializeSessionConversationGraph({
        id: 'session-1',
        projectId: 'project-1',
        title: 'Historical review',
        cwd: join(tmpdir(), 'reviewer-context'),
        status: 'idle',
        createdAt: 1,
        updatedAt: 4,
        messages: [
          message('original-user', 'user', 1),
          { ...message('original-agent', 'agent', 2), responseToMessageId: 'original-user' },
          message('newer-user', 'user', 3),
          { ...message('newer-agent', 'agent', 4), responseToMessageId: 'newer-user' }
        ]
      })
      const correctionScope = resolveTurnScope(session, 'original-agent')
      if (change === 'different branch') {
        session.conversationGraph = forkEditedConversationMessage(
          session.conversationGraph!,
          'newer-user',
          'other-branch',
          5
        )
      }
      const currentContext = getActiveConversationContext(
        session.conversationGraph!,
        change === 'newer turn' ? 'newer-user' : 'original-user'
      )
      const sendApplicationPrompt = vi.fn().mockRejectedValue(new Error('test transport boundary'))
      const repository = {
        commitFindingDispositions: vi.fn(),
        getReviewsForProjectSession: vi.fn().mockResolvedValue([])
      } as unknown as ReviewRepository

      await runReviewerFixLoop({
        sessionId: session.id,
        originalTurnMessageId: 'original-agent',
        correctionScope,
        reviewedSession: session,
        openChecks: [finding],
        projectId: session.projectId!,
        mainSessionId: session.id,
        getSession: async () => session,
        reviewRepository: repository,
        acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime,
        artifactStorageRoot: join(tmpdir(), 'reviewer-context-artifacts'),
        model: 'test-model',
        reviewerTimeoutMs: 100,
        reviewerMaxUpdates: 10,
        maxRounds: 1,
        sessionRefreshTimeoutMs: 0
      })

      // Real graph resolution and the production correction owner reach the runtime send boundary.
      // No model is called, and no branch is switched by the test.
      expect(session.conversationGraph!.activeFrameId).toBe(currentContext.agentFrameId)
      expect(
        sendApplicationPrompt.mock.calls.map(([request]) => request.provenanceContext)
      ).not.toEqual([
        expect.objectContaining({
          messageBranchId: currentContext.messageBranchId,
          runtimeSegmentId: currentContext.runtimeSegmentId,
          messageAncestry: expect.arrayContaining(['newer-user'])
        })
      ])
      expect(sendApplicationPrompt).not.toHaveBeenCalled()
      expect(repository.commitFindingDispositions).toHaveBeenCalledWith([
        expect.objectContaining({
          trigger: 'aborted',
          outcome: 'unaddressed',
          note: 'Automatic correction stopped because the active conversation changed.'
        })
      ])
    }
  )
})

const makeSession = (messages: PersistedChatSession['messages']): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Correction context',
    cwd: '/unused',
    status: 'idle',
    createdAt: 1,
    updatedAt: 10,
    messages
  } satisfies PersistedChatSession)
const originalMessages = (): PersistedChatSession['messages'] => [
  message('user', 'user', 1),
  { ...message('plan', 'agent', 2), responseToMessageId: 'user' },
  { ...message('feedback', 'user', 3), responseToMessageId: 'user' },
  { ...message('answer', 'agent', 4), responseToMessageId: 'user' }
]
const appendMessages = (
  session: PersistedChatSession,
  ...messages: PersistedChatSession['messages']
): PersistedChatSession => makeSession([...session.messages, ...messages])

// Stable, small fixtures capture the same ownership topology as run029 and run030. No private logs
// or model output are needed to keep these regressions executable in CI.
describe('reviewed correction requirements', () => {
  it.each(['ordinary', 'plan feedback', 'scope answer then feedback'])(
    'admits an unchanged %s turn through the real loop and admission callback',
    async (scenario) => {
      const messages =
        scenario === 'ordinary'
          ? [originalMessages()[0], originalMessages()[3]]
          : originalMessages()
      if (scenario === 'scope answer then feedback')
        messages.unshift(message('earlier-task', 'user', -1), message('scope-question', 'agent', 0))
      const session = makeSession(messages)
      const sendApplicationPrompt = vi.fn<ReviewerAcpRuntime['sendApplicationPrompt']>(
        async (request, _attribution, options) => {
          expect(options?.onPromptAdmitted).toBeTypeOf('function')
          const admitted = await options!.onPromptAdmitted!()
          expect(admitted).toMatchObject({
            promptMessageId: request.provenanceContext?.promptMessageId,
            messageBranchId: session.conversationGraph!.branches[0].id,
            messageAncestry: expect.arrayContaining(messages.map((m) => m.id))
          })
          throw new Error('test provider unavailable after admission')
        }
      )
      const repository = {
        commitFindingDispositions: vi.fn(),
        getReviewsForProjectSession: vi.fn().mockResolvedValue([])
      }
      await runReviewerFixLoop({
        sessionId: session.id,
        projectId: session.projectId!,
        mainSessionId: session.id,
        originalTurnMessageId: 'answer',
        reviewedSession: session,
        correctionScope: resolveTurnScope(session, 'answer'),
        openChecks: [finding],
        getSession: async () => session,
        reviewRepository: repository as unknown as ReviewRepository,
        acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime,
        artifactStorageRoot: '/unused',
        model: 'test',
        reviewerTimeoutMs: 100,
        reviewerMaxUpdates: 10,
        maxRounds: 1,
        sessionRefreshTimeoutMs: 0
      })
      expect(sendApplicationPrompt).toHaveBeenCalledOnce()
      expect(repository.commitFindingDispositions).toHaveBeenCalledWith([
        expect.objectContaining({ trigger: 'correction_failed' })
      ])
    }
  )

  it.each([
    'edit original',
    'edit feedback',
    'delete feedback',
    'new feedback',
    'new task',
    'branch',
    'attachment',
    'incomplete request'
  ])('rejects %s instead of refreshing the reviewed requirements', (change) => {
    const reviewed = makeSession(originalMessages())
    const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
    let current = makeSession(originalMessages())
    if (change === 'edit original')
      current = makeSession(
        current.messages.map((m) => (m.id === 'user' ? { ...m, content: 'different task' } : m))
      )
    if (change === 'edit feedback')
      current = makeSession(
        current.messages.map((m) =>
          m.id === 'feedback' ? { ...m, content: 'different requirements' } : m
        )
      )
    if (change === 'delete feedback')
      current = makeSession(current.messages.filter((m) => m.id !== 'feedback'))
    if (change === 'new feedback')
      current = appendMessages(current, {
        ...message('late-feedback', 'user', 5),
        responseToMessageId: 'user'
      })
    if (change === 'new task') current = appendMessages(current, message('new-task', 'user', 5))
    if (change === 'branch')
      current.conversationGraph = forkEditedConversationMessage(
        current.conversationGraph!,
        'feedback',
        'changed requirements',
        5
      )
    if (change === 'attachment')
      current = makeSession(
        current.messages.map((m) =>
          m.id === 'user'
            ? {
                ...m,
                images: [
                  { id: 'new-image', mimeType: 'image/png', data: 'synthetic', byteLength: 9 }
                ]
              }
            : m
        )
      )
    if (change === 'incomplete request')
      current = makeSession(
        current.messages.map((m) => (m.id === 'feedback' ? { ...m, status: 'streaming' } : m))
      )
    expect(() => context.resolve(current)).toThrow(
      'Automatic correction stopped because the active conversation changed.'
    )
  })

  it('allows revision, error, usage and timestamp updates', () => {
    const reviewed = makeSession(originalMessages())
    const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
    const current = structuredClone(reviewed)
    current.revision = 200
    current.error = 'Generated file finalization failed: historical failure'
    current.updatedAt = 300
    current.conversationGraph!.messages.forEach((m) => {
      m.updatedAt = 300
    })
    expect(context.resolve(current)).toMatchObject({ promptMessageId: 'user' })
  })

  it('advances only through reviewed correction turns and keeps original requirements pinned', () => {
    const reviewed = makeSession(originalMessages())
    const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
    const corrected = appendMessages(
      reviewed,
      message('correction-1', 'user', 5),
      { ...message('clarification', 'user', 6), responseToMessageId: 'correction-1' },
      { ...message('corrected-answer', 'agent', 7), responseToMessageId: 'correction-1' }
    )
    expect(() => context.resolve(corrected)).toThrow(ReviewerCorrectionContextChangedError)
    context.advance(corrected, resolveTurnScope(corrected, 'corrected-answer'), 'correction-1')
    expect(context.resolve(corrected)).toMatchObject({ promptMessageId: 'correction-1' })
    const edited = makeSession(
      corrected.messages.map((m) =>
        m.id === 'feedback' ? { ...m, content: 'changed original requirement' } : m
      )
    )
    expect(() => context.resolve(edited)).toThrow(ReviewerCorrectionContextChangedError)
    const late = appendMessages(corrected, {
      ...message('late', 'user', 8),
      responseToMessageId: 'correction-1'
    })
    expect(() => context.resolve(late)).toThrow(ReviewerCorrectionContextChangedError)
    const second = appendMessages(corrected, message('correction-2', 'user', 8), {
      ...message('second-answer', 'agent', 9),
      responseToMessageId: 'correction-2'
    })
    context.advance(second, resolveTurnScope(second, 'second-answer'), 'correction-2')
    expect(context.resolve(second)).toMatchObject({ promptMessageId: 'correction-2' })
  })

  it('refuses an unrelated turn inserted before the correction turn', () => {
    const reviewed = makeSession(originalMessages())
    const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
    const current = appendMessages(
      reviewed,
      message('other-task', 'user', 5),
      message('correction', 'user', 6),
      message('corrected', 'agent', 7)
    )
    expect(() =>
      context.advance(current, resolveTurnScope(current, 'corrected'), 'correction')
    ).toThrow(ReviewerCorrectionContextChangedError)
  })

  it('clears auto-review suppression when admission aborts without provider execution', async () => {
    const reviewed = makeSession(originalMessages())
    let current = reviewed
    const provider = vi.fn()
    const suppressionEvents: boolean[] = []
    const sendApplicationPrompt = vi.fn<ReviewerAcpRuntime['sendApplicationPrompt']>(
      async (_request, _attribution, options) => {
        current = appendMessages(reviewed, {
          ...message('racing-feedback', 'user', 5),
          responseToMessageId: 'user'
        })
        await options!.onPromptAdmitted!()
        provider()
        return { stopReason: 'end_turn' }
      }
    )
    const repository = {
      commitFindingDispositions: vi.fn(),
      getReviewsForProjectSession: vi.fn().mockResolvedValue([])
    }
    await runReviewerFixLoop({
      sessionId: reviewed.id,
      projectId: reviewed.projectId!,
      mainSessionId: reviewed.id,
      originalTurnMessageId: 'answer',
      reviewedSession: reviewed,
      correctionScope: resolveTurnScope(reviewed, 'answer'),
      openChecks: [finding],
      getSession: async () => current,
      onCorrectionPrompt: () => suppressionEvents.push(true),
      onCorrectionFailed: () => suppressionEvents.push(false),
      reviewRepository: repository as unknown as ReviewRepository,
      acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime,
      artifactStorageRoot: '/unused',
      model: 'test',
      reviewerTimeoutMs: 100,
      reviewerMaxUpdates: 10,
      maxRounds: 1,
      sessionRefreshTimeoutMs: 0
    })
    expect(provider).not.toHaveBeenCalled()
    expect(suppressionEvents).toEqual([true, false])
    expect(repository.commitFindingDispositions).toHaveBeenCalledWith([
      expect.objectContaining({
        trigger: 'aborted',
        note: 'Automatic correction stopped because the active conversation changed.'
      })
    ])
  })
})

it('rejects an edited reviewed answer even when the request and message IDs are unchanged', () => {
  const reviewed = makeSession(originalMessages())
  const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
  const changed = makeSession(
    reviewed.messages.map((m) => (m.id === 'answer' ? { ...m, content: 'different result' } : m))
  )
  expect(() => context.resolve(changed)).toThrow(
    'Automatic correction stopped because the active conversation changed.'
  )
})

it('uses the graph after a frame switch even if the flat transcript still shows the reviewed turn', () => {
  const reviewed = makeSession(originalMessages())
  const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
  const current = structuredClone(reviewed)
  current.conversationGraph!.activeFrameId = 'other-frame'
  expect(() => context.resolve(current)).toThrow(
    'Automatic correction stopped because the active conversation changed.'
  )
})

it('pins Plan version and approval while allowing step-progress changes', () => {
  const reviewed = makeSession(originalMessages())
  reviewed.runtimeContext = {
    version: 1,
    revision: 1,
    plan: {
      artifactId: 'plan',
      artifactVersionId: 'plan-v1',
      artifactChecksum: 'checksum-v1',
      originatingPromptMessageId: 'user',
      approval: 'approved',
      stepStatuses: {}
    }
  }
  const context = new ReviewerCorrectionContext(reviewed, resolveTurnScope(reviewed, 'answer'))
  const progressed = structuredClone(reviewed)
  progressed.runtimeContext = {
    ...progressed.runtimeContext!,
    revision: 2,
    plan: {
      ...progressed.runtimeContext!.plan!,
      stepStatuses: { analyze: { status: 'completed', updatedAt: 2 } }
    }
  }
  expect(context.resolve(progressed)).toMatchObject({ promptMessageId: 'user' })
  const replaced = structuredClone(reviewed)
  replaced.runtimeContext = {
    ...replaced.runtimeContext!,
    plan: { ...replaced.runtimeContext!.plan!, artifactVersionId: 'plan-v2' }
  }
  expect(() => context.resolve(replaced)).toThrow(ReviewerCorrectionContextChangedError)
  const rejected = structuredClone(reviewed)
  rejected.runtimeContext = {
    ...rejected.runtimeContext!,
    plan: { ...rejected.runtimeContext!.plan!, approval: 'rejected' }
  }
  expect(() => context.resolve(rejected)).toThrow(ReviewerCorrectionContextChangedError)
})
