import type { Finding as PrismaFinding, PrismaClient, Review as PrismaReview } from '@prisma/client'

import type {
  CheckStatus,
  CreateReviewInput,
  FindingLocator,
  FindingResolution,
  NewCheck,
  Review,
  ReviewCheck,
  ReviewerLogEntry,
  ReviewLifecycle,
  ReviewOutcome,
  ReviewWithChecks,
  TurnScope,
  UpdateReviewPatch
} from '../../shared/reviewer'

// Legacy alias for callers still using FindingSeverity (now CheckStatus).
type FindingSeverity = CheckStatus

// Only the review/finding delegates are needed; typing to this subset keeps the repository unit-testable
// with a lightweight mock instead of a real (engine-backed) PrismaClient.
// $executeRaw is also included for the incrementReflagCount atomic update (issue 15).
type ReviewClient = Pick<PrismaClient, 'review' | 'finding' | '$executeRaw' | '$transaction'>

// Resolves the Prisma client on demand so a failed initialization is not held forever (see projects/repository.ts).
type ReviewClientProvider = () => Promise<ReviewClient>

// Bumps a Review's updatedAt within the caller's transaction. Prisma's @updatedAt tracks writes to the
// Review row, not to child Finding rows, so a finding-only mutation (resolution/reflag) would otherwise
// leave updatedAt stale — and a slow focus-load could then overwrite newer pushed finding state at an
// equal timestamp. Run inside the same transaction as the finding write so the two commit atomically.
const touchReview = async (tx: Pick<PrismaClient, 'review'>, reviewId: string): Promise<void> => {
  await tx.review.update({ where: { id: reviewId }, data: { updatedAt: new Date() } })
}

// JSON columns are parsed defensively: a corrupt value degrades to the given fallback rather than
// throwing, so one bad row cannot break loading a whole session's reviews.
const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const EMPTY_SCOPE = (turnMessageId: string): TurnScope => ({
  turnMessageId,
  blocks: [],
  artifactVersionIds: []
})

// Narrows the free-text lifecycle column back to the domain union, defaulting unknown values to 'error'
// so a corrupt row surfaces as a failed review rather than a phantom running one.
const asLifecycle = (value: string): ReviewLifecycle =>
  value === 'running' || value === 'complete' ? value : 'error'

const asOutcome = (value: string | null): ReviewOutcome | null =>
  value === 'pass' || value === 'flagged' ? value : null

// Maps a Prisma review row (JSON strings + DateTime) into the epoch-ms domain shape shared with the renderer.
// v2: Review no longer has summary/checks columns; those are gone.
// v3: reasoning replaced by reviewerLog (captured action stream).
const toReview = (row: PrismaReview): Review => ({
  id: row.id,
  projectId: row.projectId,
  sessionId: row.sessionId,
  turnMessageId: row.turnMessageId,
  scope: parseJson<TurnScope>(row.scope, EMPTY_SCOPE(row.turnMessageId)),
  lifecycle: asLifecycle(row.lifecycle),
  outcome: asOutcome(row.outcome),
  errorMessage: row.errorMessage ?? undefined,
  model: row.model,
  reviewerLog: parseJson<ReviewerLogEntry[]>(row.reviewerLog, []),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

// Maps a Prisma Finding row to the unified ReviewCheck domain type.
// v2: `status` replaces `severity`; locator is optional (pass checks may have empty JSON = {}).
const asCheckStatus = (value: string): CheckStatus => {
  if (value === 'fail' || value === 'warn' || value === 'pass') return value
  // Legacy migration: old 'severity' values were only warn/fail, default to 'warn' if unknown.
  if (value === 'inconclusive') return 'warn'
  return 'warn'
}

const toCheck = (row: PrismaFinding): ReviewCheck => {
  const locatorRaw = parseJson<FindingLocator | Record<string, never>>(row.locator, {})
  // A locator is meaningful only when it has a blockRef (pass checks may store '{}').
  const hasLocator = 'blockRef' in locatorRaw && locatorRaw.blockRef !== undefined
  return {
    id: row.id,
    reviewId: row.reviewId,
    status: asCheckStatus(row.status),
    resolution:
      row.resolution === 'resolved' || row.resolution === 'unaddressed' ? row.resolution : 'open',
    claim: row.claim,
    evidence: row.evidence,
    locator: hasLocator ? (locatorRaw as FindingLocator) : undefined,
    artifactVersionId: row.artifactVersionId ?? undefined,
    sortIndex: row.sortIndex,
    // Default to 0 for rows written before the reflagCount column was added (issue 15 migration guard).
    reflagCount: row.reflagCount ?? 0
  }
}

// Owns Review/check reads/writes. The client is resolved lazily per call so schema-ensure failures can
// recover (see projects/repository.ts). Reviews live in SQLite while the transcript stays in session JSON;
// cross-store cleanup is done here by deleting review rows (and their checks) by session/project id.
class ReviewRepository {
  constructor(private readonly getClient: ReviewClientProvider) {}

  // Inserts a new review, defaulting a fresh audit to the 'running' lifecycle with no outcome yet.
  async createReview(input: CreateReviewInput): Promise<Review> {
    const client = await this.getClient()
    const row = await client.review.create({
      data: {
        projectId: input.projectId,
        sessionId: input.sessionId,
        turnMessageId: input.turnMessageId,
        scope: JSON.stringify(input.scope),
        lifecycle: input.lifecycle ?? 'running',
        outcome: input.outcome ?? null,
        errorMessage: input.errorMessage ?? null,
        model: input.model ?? '',
        reviewerLog: JSON.stringify(input.reviewerLog ?? [])
      }
    })

    return toReview(row)
  }

  // Patches only the provided fields so a caller can flip lifecycle/outcome without resupplying the rest.
  async updateReview(id: string, patch: UpdateReviewPatch): Promise<Review> {
    const data: Record<string, unknown> = {}

    if (patch.scope !== undefined) data.scope = JSON.stringify(patch.scope)
    if (patch.lifecycle !== undefined) data.lifecycle = patch.lifecycle
    if (patch.outcome !== undefined) data.outcome = patch.outcome
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage
    if (patch.model !== undefined) data.model = patch.model
    if (patch.reviewerLog !== undefined) data.reviewerLog = JSON.stringify(patch.reviewerLog)

    const client = await this.getClient()
    const row = await client.review.update({ where: { id }, data })

    return toReview(row)
  }

  // Appends checks under a review, defaulting resolution to 'open' and preserving caller sort order.
  async addChecks(reviewId: string, checks: NewCheck[]): Promise<void> {
    if (checks.length === 0) return

    const client = await this.getClient()

    await client.$transaction(async (tx) => {
      await tx.finding.createMany({
        data: checks.map((check, index) => ({
          reviewId,
          status: check.status,
          resolution: check.resolution ?? 'open',
          claim: check.claim,
          evidence: check.evidence,
          locator: JSON.stringify(check.locator ?? {}),
          artifactVersionId: check.artifactVersionId ?? null,
          sortIndex: check.sortIndex ?? index
        }))
      })
      await touchReview(tx, reviewId)
    })
  }

  /**
   * @deprecated Use addChecks
   */
  async addFindings(reviewId: string, findings: NewCheck[]): Promise<void> {
    return this.addChecks(reviewId, findings)
  }

  // Returns a session's reviews (newest first) each with its checks in display order.
  async getReviewsForSession(sessionId: string): Promise<ReviewWithChecks[]> {
    const client = await this.getClient()
    const rows = await client.review.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    })

    return Promise.all(
      rows.map(async (row) => {
        const checkRows = await client.finding.findMany({
          where: { reviewId: row.id },
          orderBy: { sortIndex: 'asc' }
        })

        const checks = checkRows.map(toCheck)
        return {
          ...toReview(row),
          checks,
          // Legacy: expose findings as alias for checks (same data).
          get findings() {
            return checks
          }
        } as ReviewWithChecks
      })
    )
  }

  // Removes a session's reviews and their checks. Checks are deleted explicitly (not relying on the
  // SQLite foreign-keys pragma) so cleanup is deterministic across environments.
  async deleteReviewsForSession(sessionId: string): Promise<void> {
    await this.deleteReviewsWhere({ sessionId })
  }

  // Removes every review (and its checks) belonging to a project.
  async deleteReviewsForProject(projectId: string): Promise<void> {
    await this.deleteReviewsWhere({ projectId })
  }

  // Updates warn/fail checks under a review to the given resolution, used after the correction turn.
  // Phase 1 sets all warn/fail checks to 'unaddressed'; pass checks are left at their default 'open'
  // since resolution is meaningless for them (see design.md §4.2).
  async updateFindingResolutions(reviewId: string, resolution: FindingResolution): Promise<void> {
    const client = await this.getClient()
    // One transaction so the finding change and the version bump commit together (or not at all): a
    // partial write leaving new findings under a stale updatedAt would let a focus-load keep old data.
    await client.$transaction(async (tx) => {
      await tx.finding.updateMany({
        where: { reviewId, status: { in: ['warn', 'fail'] } },
        data: { resolution }
      })
      await touchReview(tx, reviewId)
    })
  }

  // Updates one original finding by its stable database id. Review model prose is deliberately not part
  // of the identity: a re-review may paraphrase a claim without accidentally resolving a live issue.
  async updateFindingResolution(
    reviewId: string,
    findingId: string,
    resolution: FindingResolution
  ): Promise<void> {
    const client = await this.getClient()
    await client.$transaction(async (tx) => {
      const updated = await tx.finding.updateMany({
        where: { id: findingId, reviewId, status: { in: ['warn', 'fail'] } },
        data: { resolution }
      })
      if (updated.count !== 1) {
        throw new Error(`Finding ${findingId} does not belong to review ${reviewId}.`)
      }
      await touchReview(tx, reviewId)
    })
  }

  // Increments reflagCount for exactly one stable finding id. The review id is included so a malformed
  // re-review can never mutate a finding from another review.
  async incrementReflagCount(reviewId: string, findingId: string): Promise<void> {
    const client = await this.getClient()
    await client.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "Finding"
        SET "reflagCount" = "reflagCount" + 1
        WHERE "reviewId" = ${reviewId} AND "id" = ${findingId}
      `
      if (updated !== 1) {
        throw new Error(`Finding ${findingId} does not belong to review ${reviewId}.`)
      }
      await touchReview(tx, reviewId)
    })
  }

  // Test/diagnostic helper: total check rows, used to assert no orphans survive a cascade delete.
  async countFindings(): Promise<number> {
    const client = await this.getClient()

    return client.finding.count()
  }

  // Shared delete path: gather the matching review ids, drop their checks, then drop the reviews.
  private async deleteReviewsWhere(where: {
    sessionId?: string
    projectId?: string
  }): Promise<void> {
    const client = await this.getClient()
    const reviews = await client.review.findMany({ where, select: { id: true } })

    if (reviews.length === 0) return

    const reviewIds = reviews.map((review) => review.id)

    await client.finding.deleteMany({ where: { reviewId: { in: reviewIds } } })
    await client.review.deleteMany({ where: { id: { in: reviewIds } } })
  }
}

export { ReviewRepository, toCheck, toReview }
export type { ReviewClient, ReviewClientProvider, FindingSeverity }

// Legacy exports kept for callers that still reference toFinding.
export const toFinding = toCheck
