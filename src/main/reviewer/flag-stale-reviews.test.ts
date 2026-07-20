import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { flagStaleReviews } from './stale-reviews'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const buildSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'go',
      status: 'complete',
      eventIds: [],
      createdAt: 1000,
      updatedAt: 1000
    },
    {
      id: 'a1',
      role: 'agent',
      content: 'done',
      status: 'complete',
      eventIds: [],
      artifactIds: ['session-1:a1:report.csv'],
      createdAt: 1002,
      updatedAt: 1002
    }
  ],
  createdAt: 1000,
  updatedAt: 1002
})

const buildReview = (
  scope: Awaited<ReturnType<typeof resolveTurnScopeWithArtifactDigests>>,
  overrides: Partial<ReviewWithChecks> = {}
): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'a1',
  scope,
  lifecycle: 'complete',
  outcome: 'pass',
  model: 'test',
  reviewerLog: [],
  checks: [],
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides
})

const writeArtifact = async (root: string, contents: string): Promise<void> => {
  const dir = join(root, 'artifacts', 'project-1', 'session-1', 'a1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'report.csv'), contents, 'utf8')
}

describe('flagStaleReviews', () => {
  it('flags a completed review when the artifact it audited was edited afterward', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scopeAtReviewTime = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scopeAtReviewTime)

    // The artifact is edited outside the app after the review completed.
    await writeArtifact(storageRoot, 'a,b\n9,9\n')

    const [flagged] = await flagStaleReviews([review], session, storageRoot)

    expect(flagged.stale).toBe(true)
  })

  it('does not flag a completed review when nothing about its turn has changed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)

    const [result] = await flagStaleReviews([review], session, storageRoot)

    // Computed-not-stale is an explicit false (distinct from "couldn't compute" = undefined).
    expect(result.stale).toBe(false)
  })

  it('never flags a running or errored review (no verdict to invalidate)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const running = buildReview(scope, { lifecycle: 'running', outcome: null })
    const errored = buildReview(scope, { lifecycle: 'error', outcome: null })

    await writeArtifact(storageRoot, 'a,b\n9,9\n')

    const [flaggedRunning, flaggedErrored] = await flagStaleReviews(
      [running, errored],
      session,
      storageRoot
    )

    expect(flaggedRunning.stale).toBeUndefined()
    expect(flaggedErrored.stale).toBeUndefined()
  })

  it('fails open (unflagged) when the session is missing, instead of hiding the verdict', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const review = buildReview(scope)

    const [result] = await flagStaleReviews([review], undefined, storageRoot)

    expect(result.stale).toBeUndefined()
  })

  it('recomputes against scope.turnMessageId, so a fix-loop review is not falsely stale', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'flag-stale-'))
    const session = buildSession()
    await writeArtifact(storageRoot, 'a,b\n1,2\n')

    // A fix-loop re-review: its SCOPE is the correction turn (a1), but the row is grouped under the
    // ORIGINAL turn id (u1). Recomputing with review.turnMessageId (u1) would resolve a different turn
    // and always mismatch; recomputing with scope.turnMessageId (a1) correctly matches when unchanged.
    const scope = await resolveTurnScopeWithArtifactDigests(session, 'a1', storageRoot)
    const fixLoopReview = buildReview(scope, { turnMessageId: 'u1' })

    const [result] = await flagStaleReviews([fixLoopReview], session, storageRoot)

    // Correctly resolves the correction turn (a1) and finds it unchanged → explicit not-stale.
    expect(result.stale).toBe(false)
  })
})
