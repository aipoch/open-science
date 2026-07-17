import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PrismaClient } from '@prisma/client'

import type { NewCheck, ReviewCheck, TurnScope } from '../../shared/reviewer'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ReviewRepository } from './repository'

// Integration test against a real (temp) SQLite database, mirroring projects/prisma-client.test.ts:
// proves the runtime DDL is byte-compatible with the generated client and that round-trip + cascade
// cleanup behave as the reviewer feature relies on.
//
// v2 (issue 12): unified check model — all checks (pass/warn/fail) stored in Finding table.
// Review no longer has summary/checks JSON columns.

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const createRepository = async (): Promise<ReviewRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  const boundClient = client

  return new ReviewRepository(() => Promise.resolve(boundClient))
}

const scope = (turnMessageId: string): TurnScope => ({
  turnMessageId,
  blocks: [
    {
      id: `message:${turnMessageId}`,
      kind: 'message',
      sourceId: turnMessageId,
      blockIndex: 0,
      contentHash: 'hash-1'
    }
  ],
  artifactVersionIds: ['art-1']
})

// v2: checks array uses status (pass|warn|fail) instead of severity.
const checks = (): NewCheck[] => [
  {
    status: 'fail',
    claim: 'ran 33 rows',
    evidence: 'tool_result shows 0 rows',
    locator: { blockRef: { activityId: 'act-1', blockIndex: 1 }, contentHash: 'hash-9' },
    artifactVersionId: 'art-1',
    sortIndex: 0
  },
  {
    status: 'warn',
    claim: 'axis label mismatch',
    evidence: 'plot title says X, data is Y',
    locator: { blockRef: { messageId: 'a1', blockIndex: 2 }, contentHash: 'hash-7' },
    sortIndex: 1
  },
  {
    status: 'pass',
    claim: 'row count matches reported value',
    evidence: 'loaded artifact and counted 42 rows; agent reported 42',
    // pass check: no locator required
    sortIndex: 2
  }
]

describe('review repository (integration)', () => {
  it('round-trips a review with its unified checks by session', async () => {
    const repository = await createRepository()

    // v2: createReview no longer accepts summary/checks
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1'),
      model: 'claude-opus-4-8'
    })

    expect(review.id).toBeTruthy()
    expect(review.lifecycle).toBe('running')
    expect(review.outcome).toBeNull()
    expect(review.createdAt).toBeGreaterThan(0)

    await repository.addChecks(review.id, checks())

    const [stored] = await repository.getReviewsForSession('session-1')

    expect(stored.turnMessageId).toBe('a1')
    expect(stored.scope).toEqual(scope('a1'))
    expect(stored.model).toBe('claude-opus-4-8')

    // v2: checks (not findings) include pass+warn+fail
    expect(stored.checks).toHaveLength(3)
    expect(stored.checks.map((c) => c.claim)).toEqual([
      'ran 33 rows',
      'axis label mismatch',
      'row count matches reported value'
    ])
    // warn/fail check has a locator
    expect(stored.checks[0]!.locator).toEqual({
      blockRef: { activityId: 'act-1', blockIndex: 1 },
      contentHash: 'hash-9'
    })
    expect(stored.checks[0]!.status).toBe('fail')
    expect(stored.checks[0]!.resolution).toBe('open')
    expect(stored.checks[0]!.artifactVersionId).toBe('art-1')
    // pass check has no locator
    expect(stored.checks[2]!.status).toBe('pass')
    expect(stored.checks[2]!.locator).toBeUndefined()
  })

  it('updates a review lifecycle and outcome', async () => {
    const repository = await createRepository()
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    const updated = await repository.updateReview(review.id, {
      lifecycle: 'complete',
      outcome: 'flagged',
      reviewerLog: [{ kind: 'thought', text: 'Recomputed the reported statistic.' }]
    })

    expect(updated.lifecycle).toBe('complete')
    expect(updated.outcome).toBe('flagged')

    const [stored] = await repository.getReviewsForSession('session-1')
    expect(stored.lifecycle).toBe('complete')
    expect(stored.outcome).toBe('flagged')
    expect(stored.reviewerLog).toHaveLength(1)
    expect(stored.reviewerLog[0]?.kind).toBe('thought')
  })

  it("deletes a session's reviews and their checks, leaving other sessions untouched", async () => {
    const repository = await createRepository()

    const target = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(target.id, checks())

    const other = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-2',
      turnMessageId: 'b1',
      scope: scope('b1')
    })
    await repository.addChecks(other.id, checks())

    await repository.deleteReviewsForSession('session-1')

    expect(await repository.getReviewsForSession('session-1')).toEqual([])
    // Orphaned checks must not survive their deleted review.
    expect(await repository.countFindings()).toBe(3)

    const [survivor] = await repository.getReviewsForSession('session-2')
    expect(survivor.id).toBe(other.id)
    expect(survivor.checks).toHaveLength(3)
  })

  it("deletes all of a project's reviews and checks", async () => {
    const repository = await createRepository()

    const first = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(first.id, checks())
    const second = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-2',
      turnMessageId: 'b1',
      scope: scope('b1')
    })
    await repository.addChecks(second.id, checks())

    // A review in a different project is left alone.
    const untouched = await repository.createReview({
      projectId: 'project-2',
      sessionId: 'session-3',
      turnMessageId: 'c1',
      scope: scope('c1')
    })

    await repository.deleteReviewsForProject('project-1')

    expect(await repository.getReviewsForSession('session-1')).toEqual([])
    expect(await repository.getReviewsForSession('session-2')).toEqual([])
    expect(await repository.countFindings()).toBe(0)

    const [survivor] = await repository.getReviewsForSession('session-3')
    expect(survivor.id).toBe(untouched.id)
  })

  it('outcome is flagged iff at least one check is warn or fail', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-outcome',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    // Add a mix of pass and warn checks.
    await repository.addChecks(review.id, [
      { status: 'pass', claim: 'all good', evidence: 'verified', sortIndex: 0 },
      {
        status: 'warn',
        claim: 'minor issue',
        evidence: 'small inconsistency',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 1
      }
    ])

    await repository.updateReview(review.id, {
      lifecycle: 'complete',
      outcome: 'flagged' // set by orchestrator based on warn/fail presence
    })

    const [stored] = await repository.getReviewsForSession('session-outcome')
    expect(stored.outcome).toBe('flagged')
    expect(stored.checks.filter((c) => c.status === 'warn')).toHaveLength(1)
    expect(stored.checks.filter((c) => c.status === 'pass')).toHaveLength(1)
  })

  it('outcome is pass when all checks have status pass', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-allpass',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      { status: 'pass', claim: 'row count ok', evidence: 'verified 42 rows', sortIndex: 0 },
      { status: 'pass', claim: 'artifact headers ok', evidence: 'headers match', sortIndex: 1 }
    ])

    await repository.updateReview(review.id, {
      lifecycle: 'complete',
      outcome: 'pass'
    })

    const [stored] = await repository.getReviewsForSession('session-allpass')
    expect(stored.outcome).toBe('pass')
    expect(stored.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('updateFindingResolutions only touches warn/fail checks, leaving pass checks open', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-resolutions',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      { status: 'pass', claim: 'row count ok', evidence: 'verified 42 rows', sortIndex: 0 },
      {
        status: 'warn',
        claim: 'axis mismatch',
        evidence: 'plot title says X, data is Y',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 1
      },
      {
        status: 'fail',
        claim: 'claimed 33 rows',
        evidence: 'tool_result shows 0 rows',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h2' },
        sortIndex: 2
      }
    ])

    await repository.updateFindingResolutions(review.id, 'unaddressed')

    const [stored] = await repository.getReviewsForSession('session-resolutions')
    const byStatus = (s: string): ReviewCheck => stored.checks.find((c) => c.status === s)!

    // warn/fail checks are marked unaddressed after the correction turn
    expect(byStatus('warn').resolution).toBe('unaddressed')
    expect(byStatus('fail').resolution).toBe('unaddressed')
    // pass check keeps its default 'open' resolution — resolution is meaningless for pass
    expect(byStatus('pass').resolution).toBe('open')
  })

  it('pass check without locator round-trips correctly', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-pass-no-locator',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      {
        status: 'pass',
        claim: 'verified row count',
        evidence: 'counted 33 rows from artifact-csv',
        // intentionally no locator — pass check
        sortIndex: 0
      }
    ])

    const [stored] = await repository.getReviewsForSession('session-pass-no-locator')
    expect(stored.checks[0]!.status).toBe('pass')
    expect(stored.checks[0]!.locator).toBeUndefined()
    expect(stored.checks[0]!.claim).toBe('verified row count')
  })

  // Phase 3 storage: reflagCount defaults to 0 on every new check and round-trips.
  it('newly written checks have reflagCount = 0 by default', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-reflag-default',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      {
        status: 'fail',
        claim: 'ran 33 rows',
        evidence: 'tool_result shows 0 rows',
        locator: { blockRef: { activityId: 'act-1', blockIndex: 1 }, contentHash: 'hash-9' },
        sortIndex: 0
      },
      {
        status: 'pass',
        claim: 'artifact headers ok',
        evidence: 'headers match',
        sortIndex: 1
      }
    ])

    const [stored] = await repository.getReviewsForSession('session-reflag-default')
    expect(stored.checks[0]!.reflagCount).toBe(0)
    expect(stored.checks[1]!.reflagCount).toBe(0)
  })

  // Phase 3 storage: incrementReflagCount raises by 1 for the matching claim only.
  it('incrementReflagCount bumps reflagCount by 1 for the matching claim, leaves others untouched', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-reflag-increment',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      {
        status: 'fail',
        claim: 'ran 33 rows',
        evidence: 'tool_result shows 0 rows',
        locator: { blockRef: { activityId: 'act-1', blockIndex: 1 }, contentHash: 'hash-9' },
        sortIndex: 0
      },
      {
        status: 'warn',
        claim: 'axis label mismatch',
        evidence: 'plot title says X, data is Y',
        locator: { blockRef: { messageId: 'a1', blockIndex: 2 }, contentHash: 'hash-7' },
        sortIndex: 1
      }
    ])

    await repository.incrementReflagCount(review.id, 'ran 33 rows')

    const [stored] = await repository.getReviewsForSession('session-reflag-increment')
    const findClaim = (claim: string): ReviewCheck => stored.checks.find((c) => c.claim === claim)!

    // Only the targeted claim is incremented.
    expect(findClaim('ran 33 rows').reflagCount).toBe(1)
    expect(findClaim('axis label mismatch').reflagCount).toBe(0)
  })

  // Calling incrementReflagCount twice on the same claim accumulates correctly.
  it('incrementReflagCount is cumulative across multiple calls', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-reflag-cumulative',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, [
      {
        status: 'fail',
        claim: 'value mismatch',
        evidence: 'expected 42, got 0',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 0
      }
    ])

    await repository.incrementReflagCount(review.id, 'value mismatch')
    await repository.incrementReflagCount(review.id, 'value mismatch')

    const [stored] = await repository.getReviewsForSession('session-reflag-cumulative')
    expect(stored.checks[0]!.reflagCount).toBe(2)
  })

  // getReviewsForSession returns reflagCount on every check (including 0).
  it('getReviewsForSession returns reflagCount on every check', async () => {
    const repository = await createRepository()

    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-reflag-all',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await repository.addChecks(review.id, checks())
    await repository.incrementReflagCount(review.id, 'ran 33 rows')

    const [stored] = await repository.getReviewsForSession('session-reflag-all')

    // Every check must carry the reflagCount field.
    expect(stored.checks.every((c) => typeof c.reflagCount === 'number')).toBe(true)
    // The incremented check has 1; the rest have 0.
    const flagged = stored.checks.find((c) => c.claim === 'ran 33 rows')!
    expect(flagged.reflagCount).toBe(1)
    const others = stored.checks.filter((c) => c.claim !== 'ran 33 rows')
    expect(others.every((c) => c.reflagCount === 0)).toBe(true)
  })
})
