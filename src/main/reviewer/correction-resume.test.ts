import { describe, expect, it } from 'vitest'
import {
  materializeSessionConversationGraph,
  sanitizeMessageAttribution,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { ReviewWithChecks } from '../../shared/reviewer'
import { resolveTurnScope } from './scope'
import { resolveCorrectionResume, isCorrectionResumeScopeCurrent } from './correction-resume'
import { ReviewerCorrectionContext } from './correction-context'

const message = (
  id: string,
  role: 'user' | 'agent',
  responseToMessageId?: string
): PersistedChatSession['messages'][number] => ({
  id,
  role,
  responseToMessageId,
  content: id,
  status: 'complete' as const,
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})
const fixture = (): { session: PersistedChatSession; review: ReviewWithChecks } => {
  const initial: PersistedChatSession = materializeSessionConversationGraph({
    id: 'session',
    projectId: 'project',
    title: 'Task',
    cwd: '/tmp',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    autoReviewEnabled: true,
    messages: [message('user', 'user'), message('answer', 'agent', 'user')]
  })
  const review: ReviewWithChecks = {
    id: 'review',
    projectId: 'project',
    sessionId: 'session',
    turnMessageId: 'answer',
    scope: resolveTurnScope(initial, 'answer'),
    lifecycle: 'complete',
    outcome: 'flagged',
    model: '',
    createdAt: 1,
    updatedAt: 1,
    reviewerLog: [],
    checks: [
      {
        id: 'finding',
        reviewId: 'review',
        status: 'fail',
        resolution: 'unaddressed',
        claim: 'Issue',
        evidence: 'Evidence',
        sortIndex: 0,
        reflagCount: 0
      }
    ]
  }
  const session = materializeSessionConversationGraph({
    ...initial,
    conversationGraph: undefined,
    runtimeTranscriptLastRun: { promptMessageId: 'correction', startedAt: 20 },
    messages: [
      ...initial.messages,
      {
        ...message('correction', 'user'),
        attribution: {
          kind: 'application' as const,
          feature: 'reviewer' as const,
          purpose: 'correction' as const,
          causeReviewId: 'review',
          continuation: { round: 1, maxRounds: 3, findingIds: ['finding'] }
        }
      },
      { ...message('interrupted', 'agent', 'correction'), status: 'error' as const },
      message('recovered', 'agent', 'correction')
    ]
  })
  return { session, review }
}

describe('durable correction resume', () => {
  it('restores the original finding and consumed round, with a context that advances over the resumed turn', () => {
    const { session, review } = fixture()
    const resumed = resolveCorrectionResume(session, [review])!
    expect(resumed.resumeCorrection).toEqual({
      promptMessageId: 'correction',
      turnMessageId: 'recovered',
      round: 1
    })
    expect(resumed.openChecks[0].id).toBe('finding')
    expect(resumed.maxRounds).toBe(3)
    const context = new ReviewerCorrectionContext(resumed.reviewedSession, review.scope)
    expect(() =>
      context.advance(session, resolveTurnScope(session, 'recovered'), 'correction')
    ).not.toThrow()
  })
  it.each([
    'disabled',
    'running',
    'stopped again',
    'duplicate',
    'missing finding',
    'changed branch',
    'old completion'
  ])('rejects %s', (reason) => {
    const { session, review } = fixture()
    const reviews = [review]
    if (reason === 'disabled') session.autoReviewEnabled = false
    if (reason === 'running') session.activeRun = { promptMessageId: 'correction', startedAt: 30 }
    if (reason === 'stopped again')
      session.resumeRecovery = {
        kind: 'resume-required',
        cause: 'cancelled',
        promptMessageId: 'correction'
      }
    if (reason === 'duplicate')
      reviews.push({ ...review, id: 'assessed', scope: resolveTurnScope(session, 'recovered') })
    if (reason === 'missing finding') review.checks = []
    if (reason === 'changed branch') review.scope.messageBranchId = 'other'
    if (reason === 'old completion')
      session.runtimeTranscriptLastRun = { promptMessageId: 'user', startedAt: 1 }
    expect(resolveCorrectionResume(session, reviews)).toBeUndefined()
  })
  it('recovers pre-checkpoint correction prompts with the original production budget', () => {
    const { session, review } = fixture()
    for (const messages of [session.messages, session.conversationGraph!.messages]) {
      const prompt = messages.find((message) => message.id === 'correction')!
      if (prompt.attribution?.feature === 'reviewer')
        prompt.attribution = {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: prompt.attribution.causeReviewId
        }
    }
    expect(resolveCorrectionResume(session, [review])).toMatchObject({
      maxRounds: 3,
      resumeCorrection: { round: 0, promptMessageId: 'correction' }
    })
  })

  it('compares the frozen artifact digests, accepting unchanged content and rejecting changed bytes', async () => {
    const { session, review } = fixture()
    for (const messages of [session.messages, session.conversationGraph!.messages]) {
      messages.find((message) => message.id === 'answer')!.artifactIds = ['version-1']
    }
    session.artifacts = [
      {
        id: 'version-1',
        artifactId: 'file-1',
        versionId: 'version-1',
        kind: 'managed-file',
        path: 'report.csv'
      }
    ]
    const resumed = resolveCorrectionResume(session, [review])!
    review.scope = resolveTurnScope(
      resumed.reviewedSession,
      'answer',
      new Map([['version-1', 'sha256:original']])
    )
    let checksum = 'original'
    const resolveVersion = async (): Promise<
      Awaited<ReturnType<import('./host-sdk').ArtifactVersionContentResolver>>
    > => ({
      filename: 'report.csv',
      checksum,
      size: 0,
      readRange: async () => new Uint8Array(),
      verifyUnchanged: async () => undefined,
      close: async () => undefined
    })
    await expect(isCorrectionResumeScopeCurrent(resumed, '/unused', resolveVersion)).resolves.toBe(
      true
    )
    checksum = 'changed'
    await expect(isCorrectionResumeScopeCurrent(resumed, '/unused', resolveVersion)).resolves.toBe(
      false
    )
  })

  it('round-trips ownership metadata and refuses malformed budgets', () => {
    const { session } = fixture()
    const attribution = session.messages.find(
      (message) => message.id === 'correction'
    )!.attribution!
    expect(sanitizeMessageAttribution(attribution)).toEqual(attribution)
    for (const round of [-1, 1.5, 3]) {
      expect(
        sanitizeMessageAttribution({
          ...attribution,
          continuation: { round, maxRounds: 3, findingIds: ['finding'] }
        })
      ).toBeUndefined()
    }
  })
})
