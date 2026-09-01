import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { disconnectProjectDbClient, getProjectDbClient } from '../projects/prisma-client'
import { submitFindingsInputSchema } from './mcp-server'
import { REVIEW_INTERRUPTED_ON_STARTUP_MESSAGE, ReviewRepository } from './repository'
import {
  MAX_REVIEW_CLAIM_CHARACTERS,
  MAX_REVIEW_EVIDENCE_CHARACTERS,
  MAX_REVIEW_SUBMISSION_BYTES
} from './submission-limits'

let storageRoot: string | undefined

const check = {
  status: 'pass' as const,
  claim: 'claim',
  evidence: 'evidence'
}

afterEach(async () => {
  await disconnectProjectDbClient()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Reviewer resilience', () => {
  it('recovers a running Review as an error', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-restart-'))
    const repository = new ReviewRepository(() => getProjectDbClient(storageRoot!))
    await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }
    })

    expect(await repository.recoverInterruptedReviews()).toBe(1)
    const [restored] = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(restored).toMatchObject({
      lifecycle: 'error',
      outcome: null,
      errorMessage: REVIEW_INTERRUPTED_ON_STARTUP_MESSAGE
    })
  })

  it('recovers a persisted active Fix Loop without discarding its flagged result', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-fix-loop-restart-'))
    const database = await getProjectDbClient(storageRoot)
    const repository = new ReviewRepository(() => Promise.resolve(database))
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: {
        turnMessageId: 'turn-1',
        blocks: [
          {
            id: 'message:turn-1',
            kind: 'message',
            sourceId: 'turn-1',
            blockIndex: 0,
            contentHash: 'hash-1'
          }
        ],
        artifactVersionIds: []
      }
    })
    await repository.addChecks(review.id, [
      {
        status: 'fail',
        claim: 'The result is incorrect.',
        evidence: 'The persisted assessment found a contradiction.',
        locator: { blockRef: { messageId: 'turn-1', blockIndex: 0 }, contentHash: 'hash-1' }
      }
    ])

    expect(await repository.recoverInterruptedReviews()).toBe(1)
    const [restored] = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(restored).toMatchObject({
      lifecycle: 'complete',
      outcome: 'flagged',
      checks: [
        expect.objectContaining({
          resolution: 'unaddressed',
          unaddressedTrigger: 'aborted'
        })
      ]
    })
  })

  it('recovers only the causally linked Fix Loop chain when Reviews share a timestamp', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-fix-loop-history-'))
    const database = await getProjectDbClient(storageRoot)
    const repository = new ReviewRepository(() => Promise.resolve(database))
    const oldReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }
    })
    await repository.addChecks(oldReview.id, [
      { status: 'fail', claim: 'Old issue', evidence: 'Still part of review history.' }
    ])
    await repository.updateReview(oldReview.id, { lifecycle: 'complete', outcome: 'flagged' })
    const activeReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }
    })
    await repository.addChecks(activeReview.id, [
      { status: 'fail', claim: 'Current issue', evidence: 'Belongs to the interrupted Fix Loop.' }
    ])
    const activeFinding = (
      await repository.getReviewsForProjectSession('project-1', 'session-1')
    ).find((review) => review.id === activeReview.id)?.checks[0]
    expect(activeFinding).toBeDefined()

    const reReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'correction-1', blocks: [], artifactVersionIds: [] }
    })
    await repository.commitScopedSubmission({
      mode: 'tracked',
      reviewId: reReview.id,
      expectedSourceFindingIds: [activeFinding!.id],
      checks: [
        {
          sourceFindingId: activeFinding!.id,
          status: 'fail',
          claim: 'Current issue',
          evidence: 'The correction did not resolve it.'
        },
        {
          status: 'warn',
          claim: 'New issue',
          evidence: 'The correction introduced another issue.'
        }
      ]
    })

    await database.review.updateMany({
      where: { id: { in: [oldReview.id, activeReview.id, reReview.id] } },
      data: { createdAt: new Date('2020-01-01T00:00:00.000Z') }
    })

    expect(await repository.recoverInterruptedReviews()).toBe(1)
    const reviews = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(reviews.find((review) => review.id === oldReview.id)?.checks[0]).toMatchObject({
      resolution: 'open'
    })
    expect(reviews.find((review) => review.id === activeReview.id)?.checks[0]).toMatchObject({
      resolution: 'unaddressed',
      unaddressedTrigger: 'aborted'
    })
    expect(reviews.find((review) => review.id === reReview.id)?.checks[0]).toMatchObject({
      resolution: 'unaddressed',
      unaddressedTrigger: 'aborted'
    })
  })

  it('accepts no more than five checks in one Reviewer result', () => {
    expect(
      submitFindingsInputSchema.safeParse({ checks: [check, check, check, check, check] }).success
    ).toBe(true)
    expect(
      submitFindingsInputSchema.safeParse({ checks: [check, check, check, check, check, check] })
        .success
    ).toBe(false)
  })

  it('bounds claim and evidence fields', () => {
    expect(
      submitFindingsInputSchema.safeParse({
        checks: [{ ...check, claim: 'c'.repeat(MAX_REVIEW_CLAIM_CHARACTERS + 1) }]
      }).success
    ).toBe(false)
    expect(
      submitFindingsInputSchema.safeParse({
        checks: [{ ...check, evidence: 'e'.repeat(MAX_REVIEW_EVIDENCE_CHARACTERS + 1) }]
      }).success
    ).toBe(false)
  })

  it('bounds the total serialized UTF-8 result size', () => {
    expect(
      submitFindingsInputSchema.safeParse({
        checks: [
          {
            ...check,
            locator: {
              blockRef: { blockIndex: 0 },
              contentHash: 'h'.repeat(MAX_REVIEW_SUBMISSION_BYTES)
            }
          }
        ]
      }).success
    ).toBe(false)
  })

  it('rejects oversized submissions at the repository persistence boundary', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-limits-'))
    const repository = new ReviewRepository(() => getProjectDbClient(storageRoot!))
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] }
    })

    await expect(
      repository.addChecks(review.id, [check, check, check, check, check, check])
    ).rejects.toThrow('at most 5 checks')
  })
})
