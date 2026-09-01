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
