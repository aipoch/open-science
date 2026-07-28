import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  return new ReviewRepository(() => Promise.resolve(boundClient), {
    snapshotStorageRoot: storageRoot
  })
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
    expect(stored.checks[0]!.artifactBindingState).toBe('scope_validated')
    expect(stored.checks[1]!.artifactBindingState).toBe('legacy_unverified')
    // pass check has no locator
    expect(stored.checks[2]!.status).toBe('pass')
    expect(stored.checks[2]!.locator).toBeUndefined()
  })

  it('retains an error Review row when its frozen scope snapshot cannot be published', async () => {
    await createRepository()
    const invalidSnapshotRoot = join(storageRoot!, 'not-a-directory')
    await writeFile(invalidSnapshotRoot, 'occupied', 'utf8')
    const repository = new ReviewRepository(() => Promise.resolve(client!), {
      snapshotStorageRoot: invalidSnapshotRoot
    })

    await expect(
      repository.createReview({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnMessageId: 'a1',
        scope: scope('a1'),
        scopeSnapshot: []
      })
    ).rejects.toThrow()

    const [stored] = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(stored).toMatchObject({ lifecycle: 'error', outcome: null })
    expect(stored.errorMessage).toBeTruthy()
  })

  it('keeps equal Session ids isolated by Project for production reads', async () => {
    const repository = await createRepository()
    await repository.createReview({
      projectId: 'project-a',
      sessionId: 'shared-session',
      turnMessageId: 'turn-a',
      scope: scope('turn-a')
    })
    await repository.createReview({
      projectId: 'project-b',
      sessionId: 'shared-session',
      turnMessageId: 'turn-b',
      scope: scope('turn-b')
    })

    await expect(
      repository.getReviewsForProjectSession('project-a', 'shared-session')
    ).resolves.toMatchObject([{ projectId: 'project-a', turnMessageId: 'turn-a' }])
    await expect(
      repository.getReviewsForProjectSession('project-b', 'shared-session')
    ).resolves.toMatchObject([{ projectId: 'project-b', turnMessageId: 'turn-b' }])
  })

  it('writes the exact review scope projection to SQLite and an immutable sidecar', async () => {
    const repository = await createRepository()
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: {
        ...scope('a1'),
        agentFrameId: 'frame-1',
        messageBranchId: 'branch-2'
      },
      scopeSnapshot: [
        {
          blockIndex: 0,
          id: 'message:a1',
          kind: 'message',
          sourceId: 'a1',
          contentHash: 'hash-1',
          payload: { role: 'agent', content: 'Produced sin.png' }
        }
      ]
    })

    const snapshot = await client!.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: review.id }
    })
    expect(snapshot.state).toBe('ready')
    expect(snapshot.blockCount).toBe(1)
    expect(snapshot.schemaVersion).toBe(2)
    expect(JSON.parse(snapshot.snapshotJson)).toMatchObject({
      schemaVersion: 2,
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-2'
    })
    expect(await readFile(join(storageRoot!, ...snapshot.storageKey.split('/')), 'utf8')).toBe(
      snapshot.snapshotJson
    )
  })

  it('rejects an Artifact Version reference outside the immutable review scope', async () => {
    const repository = await createRepository()
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await expect(
      repository.addChecks(review.id, [
        {
          status: 'fail',
          claim: 'wrong artifact',
          evidence: 'out of scope',
          artifactVersionId: 'art-outside-scope'
        }
      ])
    ).rejects.toThrow('is not in Review')
    expect(await repository.countFindings()).toBe(0)
  })

  it('appends immutable fix-loop dispositions in sequence', async () => {
    const repository = await createRepository()
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(review.id, checks())
    const [stored] = await repository.getReviewsForSession('session-1')
    const finding = stored.checks[0]!

    await repository.appendFindingDisposition({
      eventId: 'disposition-1',
      sourceFindingId: finding.id,
      causeReviewId: review.id,
      trigger: 'review_submission',
      outcome: 'still_open',
      assessedArtifactVersionId: 'art-1'
    })
    await repository.appendFindingDisposition({
      eventId: 'disposition-2',
      sourceFindingId: finding.id,
      causeReviewId: review.id,
      trigger: 'review_submission',
      outcome: 'resolved'
    })
    await repository.appendFindingDisposition({
      eventId: 'disposition-1',
      sourceFindingId: finding.id,
      causeReviewId: review.id,
      trigger: 'review_submission',
      outcome: 'still_open',
      assessedArtifactVersionId: 'art-1'
    })

    const dispositions = await repository.getFindingDispositions(finding.id)
    expect(dispositions.map(({ sequence, outcome }) => ({ sequence, outcome }))).toEqual([
      { sequence: 1, outcome: 'still_open' },
      { sequence: 2, outcome: 'resolved' }
    ])
  })

  it('rolls back every finding disposition when one item in the submission is invalid', async () => {
    const repository = await createRepository()
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(review.id, checks())
    const [stored] = await repository.getReviewsForSession('session-1')
    const validFinding = stored.checks[0]!

    await expect(
      repository.commitFindingDispositions([
        {
          reviewId: review.id,
          sourceFindingId: validFinding.id,
          trigger: 'review_submission',
          outcome: 'resolved'
        },
        {
          reviewId: review.id,
          sourceFindingId: 'missing-finding',
          trigger: 'review_submission',
          outcome: 'resolved'
        }
      ])
    ).rejects.toThrow('missing-finding')

    const [afterFailure] = await repository.getReviewsForSession('session-1')
    expect(afterFailure.checks[0]).toMatchObject({ resolution: 'open', reflagCount: 0 })
    await expect(repository.getFindingDispositions(validFinding.id)).resolves.toEqual([])
  })

  it('commits tracked dispositions and newly discovered Findings as one scoped submission', async () => {
    const repository = await createRepository()
    const sourceReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(sourceReview.id, [checks()[0]!])
    const [storedSource] = await repository.getReviewsForProjectSession('project-1', 'session-1')
    const sourceFinding = storedSource.checks[0]!
    const assessmentReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    const committed = await repository.commitScopedSubmission({
      reviewId: assessmentReview.id,
      checks: [
        {
          status: 'pass',
          claim: 'original issue fixed',
          evidence: 'the corrected output matches',
          sourceFindingId: sourceFinding.id,
          artifactVersionId: 'art-1',
          sortIndex: 0
        },
        {
          status: 'warn',
          claim: 'new issue',
          evidence: 'new evidence',
          sortIndex: 1
        }
      ],
      expectedSourceFindingIds: [sourceFinding.id],
      outcome: 'flagged',
      reviewerLog: [{ kind: 'message', text: 'reviewed' }]
    })

    expect(committed).toMatchObject({ lifecycle: 'complete', outcome: 'flagged' })
    expect(committed.checks).toHaveLength(1)
    expect(committed.checks[0]).toMatchObject({ claim: 'new issue', status: 'warn' })
    const reviews = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(reviews.find((review) => review.id === sourceReview.id)?.checks[0]).toMatchObject({
      resolution: 'resolved',
      reflagCount: 0
    })
    await expect(repository.getFindingDispositions(sourceFinding.id)).resolves.toMatchObject([
      {
        sourceFindingId: sourceFinding.id,
        causeReviewId: assessmentReview.id,
        outcome: 'resolved'
      }
    ])

    const staleAssessment = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await expect(
      repository.commitScopedSubmission({
        reviewId: staleAssessment.id,
        checks: [
          {
            status: 'warn',
            claim: 'stale assessment',
            evidence: 'must not reopen a resolved Finding',
            sourceFindingId: sourceFinding.id
          }
        ],
        expectedSourceFindingIds: [sourceFinding.id],
        outcome: 'flagged'
      })
    ).rejects.toThrow(/Tracked Finding is unavailable/i)
  })

  it('rolls back a scoped submission when any tracked disposition is invalid', async () => {
    const repository = await createRepository()
    const assessmentReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a2',
      scope: scope('a2')
    })

    await expect(
      repository.commitScopedSubmission({
        reviewId: assessmentReview.id,
        checks: [
          {
            status: 'warn',
            claim: 'new issue',
            evidence: 'new evidence',
            sortIndex: 0
          },
          {
            status: 'pass',
            claim: 'fixed',
            evidence: 'fixed evidence',
            sourceFindingId: 'missing-finding',
            sortIndex: 1
          }
        ],
        expectedSourceFindingIds: ['missing-finding'],
        outcome: 'flagged'
      })
    ).rejects.toThrow(/missing-finding/)

    const [afterFailure] = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(afterFailure).toMatchObject({ lifecycle: 'running', outcome: null, checks: [] })
  })

  it('rejects incomplete tracked sets and Findings from another Review turn chain', async () => {
    const repository = await createRepository()
    const sourceReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(sourceReview.id, checks().slice(0, 2))
    const source = (await repository.getReviewsForProjectSession('project-1', 'session-1')).find(
      (review) => review.id === sourceReview.id
    )!
    const assessmentReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await expect(
      repository.commitScopedSubmission({
        reviewId: assessmentReview.id,
        checks: [
          {
            status: 'pass',
            claim: 'first issue fixed',
            evidence: 'verified',
            sourceFindingId: source.checks[0]!.id
          }
        ],
        expectedSourceFindingIds: source.checks.map((check) => check.id),
        outcome: 'pass'
      })
    ).rejects.toThrow(/exact expected tracked Finding set/i)

    const otherTurnReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a2',
      scope: scope('a2')
    })
    await repository.addChecks(otherTurnReview.id, [checks()[0]!])
    const otherTurn = (await repository.getReviewsForProjectSession('project-1', 'session-1')).find(
      (review) => review.id === otherTurnReview.id
    )!
    const crossTurnAssessment = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })

    await expect(
      repository.commitScopedSubmission({
        reviewId: crossTurnAssessment.id,
        checks: [
          {
            status: 'pass',
            claim: 'wrong turn issue',
            evidence: 'wrong chain',
            sourceFindingId: otherTurn.checks[0]!.id
          }
        ],
        expectedSourceFindingIds: [otherTurn.checks[0]!.id],
        outcome: 'pass'
      })
    ).rejects.toThrow(/another Review turn chain/i)

    await repository.updateFindingResolutions(otherTurnReview.id, 'unaddressed')
    const terminalAssessment = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a2',
      scope: scope('a2')
    })
    await expect(
      repository.commitScopedSubmission({
        reviewId: terminalAssessment.id,
        checks: [
          {
            status: 'pass',
            claim: 'terminal Finding',
            evidence: 'must not reassess unaddressed Finding',
            sourceFindingId: otherTurn.checks[0]!.id
          }
        ],
        expectedSourceFindingIds: [otherTurn.checks[0]!.id],
        outcome: 'pass'
      })
    ).rejects.toThrow(/Tracked Finding is unavailable/i)
  })

  it('reuses an exact disposition event and validates its assessed Version against Review scope', async () => {
    const repository = await createRepository()
    const sourceReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(sourceReview.id, checks())
    const [stored] = await repository.getReviewsForSession('session-1')
    const finding = stored.checks[0]!
    const causeReview = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a2',
      scope: scope('a2')
    })
    const input = {
      eventId: 'disposition-event-1',
      reviewId: sourceReview.id,
      sourceFindingId: finding.id,
      causeReviewId: causeReview.id,
      trigger: 'review_submission' as const,
      outcome: 'still_open' as const,
      assessedArtifactVersionId: 'art-1'
    }

    const [first] = await repository.commitFindingDispositions([input])
    const [retry] = await repository.commitFindingDispositions([input])

    expect(retry).toEqual(first)
    await expect(repository.getFindingDispositions(finding.id)).resolves.toHaveLength(1)
    const afterRetry = await repository.getReviewsForProjectSession('project-1', 'session-1')
    expect(afterRetry.find((review) => review.id === sourceReview.id)?.checks[0]).toMatchObject({
      resolution: 'open',
      reflagCount: 1
    })
    await expect(
      repository.commitFindingDispositions([{ ...input, outcome: 'resolved' }])
    ).rejects.toThrow(/reused with different data/u)

    const outsideScope = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'a3',
      scope: { ...scope('a3'), artifactVersionIds: [] }
    })
    await expect(
      repository.commitFindingDispositions([
        {
          ...input,
          eventId: 'disposition-event-2',
          causeReviewId: outsideScope.id
        }
      ])
    ).rejects.toThrow(/outside Review scope/u)
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

  // Phase 3 storage: incrementReflagCount raises by 1 for the stable finding ID only.
  it('incrementReflagCount bumps reflagCount by 1 for the targeted finding, leaves others untouched', async () => {
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

    const [before] = await repository.getReviewsForSession('session-reflag-increment')
    const targetId = before.checks.find((check) => check.claim === 'ran 33 rows')!.id
    await repository.incrementReflagCount(review.id, targetId)

    const [stored] = await repository.getReviewsForSession('session-reflag-increment')
    const findClaim = (claim: string): ReviewCheck => stored.checks.find((c) => c.claim === claim)!

    // Only the targeted claim is incremented.
    expect(findClaim('ran 33 rows').reflagCount).toBe(1)
    expect(findClaim('axis label mismatch').reflagCount).toBe(0)
  })

  // Calling incrementReflagCount twice on the same finding accumulates correctly.
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

    const [before] = await repository.getReviewsForSession('session-reflag-cumulative')
    const targetId = before.checks[0]!.id
    await repository.incrementReflagCount(review.id, targetId)
    await repository.incrementReflagCount(review.id, targetId)

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
    const [before] = await repository.getReviewsForSession('session-reflag-all')
    const targetId = before.checks.find((check) => check.claim === 'ran 33 rows')!.id
    await repository.incrementReflagCount(review.id, targetId)

    const [stored] = await repository.getReviewsForSession('session-reflag-all')

    // Every check must carry the reflagCount field.
    expect(stored.checks.every((c) => typeof c.reflagCount === 'number')).toBe(true)
    // The incremented check has 1; the rest have 0.
    const flagged = stored.checks.find((c) => c.claim === 'ran 33 rows')!
    expect(flagged.reflagCount).toBe(1)
    const others = stored.checks.filter((c) => c.claim !== 'ran 33 rows')
    expect(others.every((c) => c.reflagCount === 0)).toBe(true)
  })

  it('rolls back the finding write when the version bump (touchReview) fails', async () => {
    // Prove the atomicity guarantee: the finding mutation and the Review.updatedAt bump commit together
    // or not at all. Use the REAL transaction (so rollback is real) but force the review.update inside
    // it to throw, standing in for a version-bump failure after the finding write has been staged.
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-reviewer-'))
    const realClient = createProjectDbClient(storageRoot)
    await ensureProjectSchema(realClient)
    client = realClient

    // Client whose $transaction runs the real one but, once armed, hands the callback a tx whose
    // review.update rejects — everything else (finding writes, $executeRaw) uses the real tx. Arming is
    // deferred so the setup writes below (which also bump the version) succeed normally.
    let failTouch = false
    const failingClient = {
      review: realClient.review,
      finding: realClient.finding,
      $executeRaw: realClient.$executeRaw.bind(realClient),
      $transaction: ((callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
        realClient.$transaction((tx) => {
          const txRecord = tx as unknown as {
            review: { update: (...args: unknown[]) => Promise<unknown> }
          }
          return callback({
            ...(tx as unknown as Record<string, unknown>),
            review: {
              ...txRecord.review,
              update: (...args: unknown[]) =>
                failTouch
                  ? Promise.reject(new Error('touch failed'))
                  : txRecord.review.update(...args)
            }
          })
        })) as PrismaClient['$transaction']
    } as unknown as PrismaClient

    const repository = new ReviewRepository(() => Promise.resolve(failingClient))
    const review = await repository.createReview({
      projectId: 'project-1',
      sessionId: 'session-rollback',
      turnMessageId: 'a1',
      scope: scope('a1')
    })
    await repository.addChecks(review.id, [
      {
        status: 'fail',
        claim: 'ran 33 rows',
        evidence: 'tool_result shows 0 rows',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 0
      }
    ])

    // The reflag increment + touchReview run in one transaction; the forced touch failure rejects it.
    failTouch = true
    const [before] = await repository.getReviewsForSession('session-rollback')
    await expect(repository.incrementReflagCount(review.id, before.checks[0]!.id)).rejects.toThrow(
      /touch failed/
    )
    failTouch = false

    // Read back with the real client: the reflag increment was rolled back (still 0), not left partial.
    const [stored] = await repository.getReviewsForSession('session-rollback')
    expect(stored.checks[0]!.reflagCount).toBe(0)
  })
})
